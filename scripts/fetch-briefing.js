#!/usr/bin/env node
// Runs once daily via GitHub Actions. Fetches RSS + Liquipedia, writes
// public/briefing.json. Vercel auto-deploys the updated static file.
// Users never trigger external API calls.

const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');
const path = require('path');
const FEEDS = require('../config/feeds');

const xmlParser = new XMLParser({ ignoreAttributes: false, isArray: (name) => name === 'item' });
const UA = 'esports-briefing/1.0 (2easy.gg daily briefing; contact patrik@2easy.gg)';
const LIQUIPEDIA_MIN_GAP_MS = 2100;

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripHtml(str = '') {
  const text = str
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#160;/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
  // Liquipedia uses "None" as a placeholder when a player has no team
  return text === 'None' ? '' : text;
}

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

function extractDivCell(chunk, cellClass) {
  const re = new RegExp(
    `<div[^>]*class="[^"]*divCell[^"]*\\b${cellClass}\\b[^"]*"[^>]*>([\\s\\S]*?)</div>`,
    'i'
  );
  const m = chunk.match(re);
  return m ? stripHtml(m[1]) : '';
}

function parseTransferTable(html, game) {
  const parts = html.split(/<div[^>]*class="[^"]*\bdivRow\b[^"]*"[^>]*>/i);
  const transfers = [];
  for (let i = 1; i < parts.length && transfers.length < 15; i++) {
    const chunk = parts[i];
    const date   = extractDivCell(chunk, 'Date');
    const player = extractDivCell(chunk, 'Name');
    const from   = extractDivCell(chunk, 'OldTeam');
    const to     = extractDivCell(chunk, 'NewTeam');
    if (player) transfers.push({ date, player, from: from || 'None', to: to || 'None', game });
  }
  return transfers;
}

async function fetchLiquipediaTransfers(wiki, game, page) {
  try {
    const url =
      `https://liquipedia.net/${wiki}/api.php` +
      `?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const html = json?.parse?.text?.['*'] ?? '';
    return parseTransferTable(html, game);
  } catch (err) {
    console.warn(`[Liquipedia] ${game} failed: ${err.message}`);
    return [];
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching RSS feeds…');
  const feedResults = await Promise.all(FEEDS.rss.map(fetchFeed));
  const allNews = feedResults
    .flat()
    .filter(i => i.pubDate)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .slice(0, 60);
  console.log(`  ${allNews.length} news items from ${FEEDS.rss.length} feeds`);

  console.log('Fetching Liquipedia transfers…');
  const transfers = [];
  for (let i = 0; i < FEEDS.liquipedia.length; i++) {
    const { wiki, game, page } = FEEDS.liquipedia[i];
    const t0 = Date.now();
    const items = await fetchLiquipediaTransfers(wiki, game, page);
    transfers.push(...items);
    console.log(`  ${game}: ${items.length} transfers`);
    if (i < FEEDS.liquipedia.length - 1) {
      const gap = LIQUIPEDIA_MIN_GAP_MS - (Date.now() - t0);
      if (gap > 0) await sleep(gap);
    }
  }
  console.log(`  ${transfers.length} transfers total`);

  const briefing = {
    generatedAt: new Date().toISOString(),
    transfers,
    news: allNews,
  };

  const outPath = path.join(__dirname, '..', 'public', 'briefing.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(briefing, null, 2));
  console.log(`Written to ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
