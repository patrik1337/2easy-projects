const { XMLParser } = require('fast-xml-parser');
const FEEDS = require('../config/feeds');
const { stripHtml, parseTransferTable } = require('../config/briefing-parse');

const xmlParser = new XMLParser({ ignoreAttributes: false, isArray: (name) => name === 'item' });
const UA = 'esports-briefing/1.0 (2easy.gg daily briefing; contact patrik@2easy.gg)';
const LIQUIPEDIA_MIN_GAP_MS = 2100; // Liquipedia ToS: >= 2 s between request starts

// ── RSS ──────────────────────────────────────────────────────────────────────

function parsePubDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function itemMatchesCategory(item, keyword) {
  if (!keyword) return true;
  const cats = [].concat(item.category ?? []);
  return cats.some(c => String(c).toLowerCase().includes(keyword.toLowerCase()));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const data = xmlParser.parse(xml);
    const rawItems = data?.rss?.channel?.item ?? data?.feed?.entry ?? [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];

    return items
      .filter(item => itemMatchesCategory(item, feed.categoryKeyword))
      .map(item => ({
        title: stripHtml(String(item.title ?? '')),
        link: String(item.link ?? item.guid ?? '').trim().replace(/^<|>$/g, ''),
        pubDate: parsePubDate(item.pubDate ?? item.published ?? item.updated),
        source: feed.name,
        section: feed.section,
      }))
      .filter(i => i.title && i.link);
  } catch (err) {
    console.error(`[RSS] ${feed.name} failed:`, err.message);
    return []; // graceful degradation — never let one broken feed blank the page
  }
}

// ── Liquipedia ────────────────────────────────────────────────────────────────

// A single retry (with a short backoff) covers the kind of transient blip that
// zeroed out an entire day's transfers on 2026-07-07 despite every other run
// that week succeeding — one bad request no longer has to mean one bad day.
async function fetchLiquipediaPage(wiki, page) {
  const url =
    `https://liquipedia.net/${wiki}/api.php` +
    `?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip' },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`${json.error.code}: ${json.error.info}`);
      return json?.parse?.text?.['*'] ?? '';
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(1500);
    }
  }
}

async function fetchLiquipediaTransfers(wiki, game, page) {
  try {
    const html = await fetchLiquipediaPage(wiki, page);
    return parseTransferTable(html, game, 'divRow');
  } catch (err) {
    console.error(`[Liquipedia] ${game} failed:`, err.message);
    return [];
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // Cache on Vercel CDN for 24 h; cron job at noon refreshes it daily
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // RSS feeds — parallel, failures are isolated
  const feedResults = await Promise.all(FEEDS.rss.map(fetchFeed));

  const allNews = feedResults
    .flat()
    .filter(i => i.pubDate) // drop items with unparseable dates
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .slice(0, 60);

  // Liquipedia — sequential, min 2.1 s between request *starts* per their rate-limit policy.
  // We subtract actual fetch time so we only sleep the remainder, keeping total runtime low.
  const transfers = [];
  for (let i = 0; i < FEEDS.liquipedia.length; i++) {
    const t0 = Date.now();
    const { wiki, game, page } = FEEDS.liquipedia[i];
    const items = await fetchLiquipediaTransfers(wiki, game, page);
    transfers.push(...items);
    if (i < FEEDS.liquipedia.length - 1) {
      const gap = LIQUIPEDIA_MIN_GAP_MS - (Date.now() - t0);
      if (gap > 0) await sleep(gap);
    }
  }

  res.status(200).json({
    generatedAt: new Date().toISOString(),
    transfers,
    news: allNews,
  });
};
