#!/usr/bin/env node
// Runs once daily via GitHub Actions. Fetches RSS + Liquipedia, writes
// public/briefing.json. Vercel auto-deploys the updated static file.
// Users never trigger external API calls.

const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');
const path = require('path');
const FEEDS = require('../config/feeds');
const { stripHtml, parseTransferTable } = require('../config/briefing-parse');

// maxTotalExpansions raised well past the library's 1000 default: Reddit posts
// pack a lot of doubly-escaped HTML into one <content> field (a whole comment
// thread's worth of &lt;p&gt;/&amp;/etc.), which trips the default anti-DoS
// entity-expansion limit and throws before parsing even finishes — these are
// trusted, known feed URLs, not arbitrary user-supplied XML, so raising it is safe.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => name === 'item',
  processEntities: { maxTotalExpansions: 20000 },
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
// Reddit's unauthenticated RSS is far stricter than Liquipedia's — confirmed
// live (2026-07-08) at ~1 request per IP per 28-50s reset window. This only
// runs once a day, so there's no reason to hug that boundary: comfortable
// margin over speed.
const REDDIT_MIN_GAP_MS = 90000;

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

async function respectGap(t0, minGapMs = LIQUIPEDIA_MIN_GAP_MS) {
  const gap = minGapMs - (Date.now() - t0);
  if (gap > 0) await sleep(gap);
}

async function fetchAllLiquipedia() {
  console.log('Fetching Liquipedia transfers + rumours…');
  const transfers = [];
  const rumours = [];
  let consecutiveFails = 0;

  // Wraps a single page fetch with graceful-degradation (never throws out of
  // the loop) plus a shared failure counter — a run of failures is treated as
  // "we tripped a throttle", not independent bad luck per wiki, so it earns a
  // long cooldown instead of barreling through the remaining wikis at the
  // same pace that caused the trouble.
  async function guarded(label, fn) {
    try {
      const items = await fn();
      consecutiveFails = 0;
      return items;
    } catch (err) {
      console.warn(`[Liquipedia] ${label} failed: ${err.message}`);
      consecutiveFails++;
      if (consecutiveFails >= LIQUIPEDIA_MAX_CONSECUTIVE_FAILS) {
        console.warn(`[Liquipedia] ${consecutiveFails} failures in a row — cooling down ${LIQUIPEDIA_COOLDOWN_MS / 1000}s`);
        await sleep(LIQUIPEDIA_COOLDOWN_MS);
        consecutiveFails = 0;
      }
      return [];
    }
  }

  for (let i = 0; i < FEEDS.liquipedia.length; i++) {
    const { wiki, game, page, rumoursPage } = FEEDS.liquipedia[i];
    const isLast = i === FEEDS.liquipedia.length - 1;

    let t0 = Date.now();
    const tItems = await guarded(`${game} transfers`, () => fetchLiquipediaTransfers(wiki, game, page));
    transfers.push(...tItems);
    console.log(`  ${game}: ${tItems.length} transfers`);
    await respectGap(t0);

    if (rumoursPage) {
      t0 = Date.now();
      const rItems = await guarded(`${game} rumours`, () => fetchLiquipediaRumours(wiki, game, rumoursPage));
      rumours.push(...rItems);
      console.log(`  ${game}: ${rItems.length} rumours`);
      if (!isLast) await respectGap(t0);
    }
  }
  console.log(`  ${transfers.length} transfers, ${rumours.length} rumours total`);
  return { transfers, rumours };
}

// ── Reddit ────────────────────────────────────────────────────────────────────

async function fetchRedditPage(subreddit) {
  const url = `https://www.reddit.com/r/${subreddit}/top/.rss?t=day&limit=5`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Today's top 5 posts, Reddit's own ranking — no score/comment-count is
// exposed by the RSS feed itself, only title/link/date. A failure here is
// almost always the rate limit not having reset yet, so — unlike Liquipedia's
// quick 1.5s retry — the retry waits out a FULL gap before trying again; this
// only runs once a day, so trading a couple extra minutes for reliability is
// a good deal.
async function fetchRedditTop(subreddit, game) {
  let xml;
  try {
    xml = await fetchRedditPage(subreddit);
  } catch (err) {
    console.warn(`[Reddit] r/${subreddit} failed once (${err.message}), retrying after a full gap…`);
    await sleep(REDDIT_MIN_GAP_MS);
    try {
      xml = await fetchRedditPage(subreddit);
    } catch (err2) {
      console.warn(`[Reddit] r/${subreddit} failed again: ${err2.message}`);
      return [];
    }
  }
  try {
    const data = xmlParser.parse(xml);
    const rawEntries = data?.feed?.entry ?? [];
    const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
    return entries
      .slice(0, 5)
      .map(e => ({
        title: stripHtml(String(e.title ?? '')),
        // Reddit's Atom <link> is an attribute (href), not text content like
        // RSS's <link>text</link> — this is why it needs its own parser
        // instead of reusing fetchFeed().
        link: e.link?.['@_href'] ?? '',
        date: parsePubDate(e.published ?? e.updated),
        subreddit,
        game,
      }))
      .filter(i => i.title && i.link);
  } catch (err) {
    console.warn(`[Reddit] r/${subreddit} parse failed: ${err.message}`);
    return [];
  }
}

async function fetchAllReddit() {
  console.log('Fetching Reddit community discussions…');
  const community = [];
  for (let i = 0; i < FEEDS.reddit.length; i++) {
    const { subreddit, game } = FEEDS.reddit[i];
    const isLast = i === FEEDS.reddit.length - 1;
    const t0 = Date.now();
    const items = await fetchRedditTop(subreddit, game);
    community.push(...items);
    console.log(`  r/${subreddit}: ${items.length} posts`);
    if (!isLast) await respectGap(t0, REDDIT_MIN_GAP_MS);
  }
  console.log(`  ${community.length} community posts total`);
  return community;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching RSS feeds…');
  const feedResultsPromise = Promise.all(FEEDS.rss.map(fetchFeed));

  // Liquipedia and Reddit are separate hosts with separate, independent rate
  // limits — run their (each internally sequential) loops concurrently rather
  // than one after the other, so total runtime is max(~80s, ~14min) instead
  // of the sum of both.
  const [feedResults, { transfers, rumours }, community] = await Promise.all([
    feedResultsPromise,
    fetchAllLiquipedia(),
    fetchAllReddit(),
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
    community,
    news: allNews,
  };

  const outPath = path.join(__dirname, '..', 'briefing.json');
  fs.writeFileSync(outPath, JSON.stringify(briefing, null, 2));
  console.log(`Written to ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
