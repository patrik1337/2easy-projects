#!/usr/bin/env node
// Runs once daily via GitHub Actions. Fetches RSS + Liquipedia, writes
// public/briefing.json. Vercel auto-deploys the updated static file.
// Users never trigger external API calls.

const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');
const path = require('path');
const FEEDS = require('../config/feeds');
const { stripHtml, parseTransferTable } = require('../config/briefing-parse');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => name === 'item',
});
const UA = 'esports-briefing/1.0 (2easy.gg daily briefing; contact patrik@2easy.gg)';
// Was 2100ms (Liquipedia's documented minimum). In practice a burst of ~12-13
// requests at that pace reliably trips a stricter, undocumented Varnish-level
// throttle partway through the 19-wiki run (confirmed 2026-07-10: two separate
// days' briefing.json both cut off at exactly the same 6th wiki; a lone
// isolated request to a "failed" wiki succeeds fine outside the burst). This
// only runs once a day with hours of headroom, so trade speed for a much
// wider margin — both to recover full coverage and to cut ban risk.
const LIQUIPEDIA_MIN_GAP_MS = 6000;
// Extra cooldown inserted after repeated consecutive failures, on the theory
// that a run of failures means we tripped a burst limiter and need to let it
// reset — rather than continuing to hammer a wall for the rest of the run.
const LIQUIPEDIA_COOLDOWN_MS = 60000;
const LIQUIPEDIA_MAX_CONSECUTIVE_FAILS = 2;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── RSS ───────────────────────────────────────────────────────────────────────

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
    console.warn(`[RSS] ${feed.name} failed: ${err.message}`);
    return [];
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
      // Widened from 1500ms alongside the main gap — a fast retry right after
      // a failure is more likely to land inside the same throttle window.
      await sleep(5000);
    }
  }
}

async function fetchLiquipediaTransfers(wiki, game, page) {
  const html = await fetchLiquipediaPage(wiki, page);
  return parseTransferTable(html, game, 'divRow');
}

async function fetchLiquipediaRumours(wiki, game, page) {
  const html = await fetchLiquipediaPage(wiki, page);
  return parseTransferTable(html, game, 'RumourRow');
}

async function respectGap(t0) {
  const gap = LIQUIPEDIA_MIN_GAP_MS - (Date.now() - t0);
  if (gap > 0) await sleep(gap);
}

async function fetchAllLiquipedia() {
  console.log('Fetching Liquipedia transfers + rumours…');
  const transfers = [];
  const rumours = [];
  let consecutiveFails = 0;
  let hasCooledDown = false; // one cooldown-and-retry chance per failure episode
  let abort = false;

  // Wraps a single page fetch with graceful-degradation (never throws out of
  // the loop) plus a shared failure counter. First sign of trouble (2 fails
  // in a row) earns exactly one long cooldown, on the theory it might be a
  // transient blip. If it's still failing after that, it isn't transient —
  // it's a sustained block — so we stop sending requests entirely for the
  // rest of the run instead of continuing to hammer a wall. Confirmed live
  // (2026-07-13): without this, a sustained block made every one of the
  // remaining ~12 wikis retry-cooldown-retry in turn, stretching a run from
  // ~2 minutes to ~20 minutes while recovering nothing — worse for ban risk,
  // not better.
  async function guarded(label, fn) {
    if (abort) return [];
    try {
      const items = await fn();
      consecutiveFails = 0;
      hasCooledDown = false;
      return items;
    } catch (err) {
      console.warn(`[Liquipedia] ${label} failed: ${err.message}`);
      consecutiveFails++;
      if (consecutiveFails >= LIQUIPEDIA_MAX_CONSECUTIVE_FAILS) {
        consecutiveFails = 0;
        if (hasCooledDown) {
          console.warn('[Liquipedia] still failing after a cooldown — aborting the rest of this run to limit request volume');
          abort = true;
        } else {
          console.warn(`[Liquipedia] failures in a row — cooling down ${LIQUIPEDIA_COOLDOWN_MS / 1000}s`);
          await sleep(LIQUIPEDIA_COOLDOWN_MS);
          hasCooledDown = true;
        }
      }
      return [];
    }
  }

  for (let i = 0; i < FEEDS.liquipedia.length; i++) {
    if (abort) break;
    const { wiki, game, page, rumoursPage } = FEEDS.liquipedia[i];
    const isLast = i === FEEDS.liquipedia.length - 1;

    let t0 = Date.now();
    const tItems = await guarded(`${game} transfers`, () => fetchLiquipediaTransfers(wiki, game, page));
    transfers.push(...tItems);
    console.log(`  ${game}: ${tItems.length} transfers`);
    if (abort) break;
    await respectGap(t0);

    if (rumoursPage) {
      t0 = Date.now();
      const rItems = await guarded(`${game} rumours`, () => fetchLiquipediaRumours(wiki, game, rumoursPage));
      rumours.push(...rItems);
      console.log(`  ${game}: ${rItems.length} rumours`);
      if (!isLast && !abort) await respectGap(t0);
    }
  }
  if (abort) console.warn(`[Liquipedia] stopped early — ${transfers.length ? 'kept' : 'lost'} whatever was fetched before the block`);
  console.log(`  ${transfers.length} transfers, ${rumours.length} rumours total`);
  return { transfers, rumours };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching RSS feeds…');
  const feedResultsPromise = Promise.all(FEEDS.rss.map(fetchFeed));

  const [feedResults, { transfers, rumours }] = await Promise.all([
    feedResultsPromise,
    fetchAllLiquipedia(),
  ]);

  const allNews = feedResults
    .flat()
    .filter(i => i.pubDate)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .slice(0, 60);
  console.log(`  ${allNews.length} news items from ${FEEDS.rss.length} feeds`);

  const briefing = {
    generatedAt: new Date().toISOString(),
    transfers,
    rumours,
    news: allNews,
  };

  const outPath = path.join(__dirname, '..', 'briefing.json');
  fs.writeFileSync(outPath, JSON.stringify(briefing, null, 2));
  console.log(`Written to ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
