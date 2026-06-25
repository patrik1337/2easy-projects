const { XMLParser } = require('fast-xml-parser');
const FEEDS = require('../config/feeds');

const xmlParser = new XMLParser({ ignoreAttributes: false, isArray: (name) => name === 'item' });
const UA = 'esports-briefing/1.0 (2easy.gg daily briefing; contact patrik@2easy.gg)';
const LIQUIPEDIA_DELAY_MS = 2200; // Liquipedia ToS: >= 2 s between requests

// ── RSS ──────────────────────────────────────────────────────────────────────

function parsePubDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function stripHtml(str = '') {
  return str.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function itemMatchesCategory(item, keyword) {
  if (!keyword) return true;
  const cats = [].concat(item.category ?? []);
  return cats.some(c => String(c).toLowerCase().includes(keyword.toLowerCase()));
}

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

function extractDivCell(chunk, cellClass) {
  // Split on divRow boundaries means divCell divs are at the top level of chunk.
  // Non-greedy match to first </div> gives us the cell contents even if nested divs exist
  // inside — stripHtml handles the remaining tags.
  const re = new RegExp(
    `<div[^>]*class="[^"]*divCell[^"]*\\b${cellClass}\\b[^"]*"[^>]*>([\\s\\S]*?)</div>`,
    'i'
  );
  const m = chunk.match(re);
  return m ? stripHtml(m[1]) : '';
}

function parseTransferTable(html, game) {
  // Split on divRow opening tags — avoids nested-div regex issues entirely.
  // parts[0] is preamble; parts[1..n] each start just after a divRow opening tag.
  const parts = html.split(/<div[^>]*class="[^"]*\bdivRow\b[^"]*"[^>]*>/i);
  const transfers = [];
  for (let i = 1; i < parts.length && transfers.length < 15; i++) {
    const chunk = parts[i];
    const date = extractDivCell(chunk, 'Date');
    const player = extractDivCell(chunk, 'Name');
    const from = extractDivCell(chunk, 'OldTeam');
    const to = extractDivCell(chunk, 'NewTeam');
    if (player) {
      transfers.push({ date, player, from: from || 'None', to: to || 'None', game });
    }
  }
  return transfers;
}

async function fetchLiquipediaTransfers(wiki, game, page) {
  try {
    const url =
      `https://liquipedia.net/${wiki}/api.php` +
      `?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Encoding': 'gzip',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const html = json?.parse?.text?.['*'] ?? '';
    return parseTransferTable(html, game);
  } catch (err) {
    console.error(`[Liquipedia] ${game} failed:`, err.message);
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // Liquipedia — sequential, min 2.2 s apart per their rate-limit policy
  const transfers = [];
  for (let i = 0; i < FEEDS.liquipedia.length; i++) {
    const { wiki, game, page } = FEEDS.liquipedia[i];
    const items = await fetchLiquipediaTransfers(wiki, game, page);
    transfers.push(...items);
    if (i < FEEDS.liquipedia.length - 1) await sleep(LIQUIPEDIA_DELAY_MS);
  }

  res.status(200).json({
    generatedAt: new Date().toISOString(),
    transfers,
    news: allNews,
  });
};
