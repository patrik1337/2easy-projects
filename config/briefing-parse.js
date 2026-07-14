// Shared HTML-entity decoding + Liquipedia transfer/rumour table parsing.
// Used by both scripts/fetch-briefing.js (the daily cron) and api/refresh.js
// (an on-demand endpoint) so the two never silently drift out of sync again —
// that drift is exactly how the entity-decoding bug went unnoticed in one of
// them while looking "fixed" in the other.

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// RSS feeds (especially WordPress-based ones) commonly encode curly quotes,
// dashes, and ampersands as numeric entities (&#8220; &#8221; &#8217; &#8211;
// &#038; etc.). Decoding only a hardcoded handful of named entities (the old
// behavior) left those literally showing as "&#8220;" in the UI — the
// frontend's own esc() then re-escapes the leading "&" into "&amp;", and
// browsers only decode entities once during HTML parsing, so "&#8220;" never
// resolves to a real curly quote. Decoding every named + numeric entity here,
// before the value ever reaches the page, fixes it at the source.
function decodeEntities(str = '') {
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m));
}

function stripHtml(str = '') {
  const text = decodeEntities(String(str).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  // Liquipedia uses "None" as a placeholder when a player has no team
  return text === 'None' ? '' : text;
}

// Isolates one divCell's raw (un-stripped) inner HTML from a row chunk, by
// class name — e.g. extractCellRaw(chunk, 'OldTeam') for
// <div class="divCell Team OldTeam">...</div>. Kept separate from stripHtml
// so callers needing the cell's links (team/player/reference) can inspect the
// raw markup before it's torn down to plain text.
function extractCellRaw(chunk, cellClass) {
  const re = new RegExp(
    `<div[^>]*class="[^"]*divCell[^"]*\\b${cellClass}\\b[^"]*"[^>]*>([\\s\\S]*?)</div>`,
    'i'
  );
  const m = chunk.match(re);
  return m ? m[1] : '';
}

// MediaWiki renders a link to a page that doesn't exist yet (a "redlink") with
// title="X (page does not exist)" and an href pointing at its own edit form,
// not a real profile page — link to that and it just opens an editor, and the
// raw title text reads oddly if shown as-is. Treat it as "no link available"
// and drop the parenthetical instead.
const REDLINK_SUFFIX = /\s*\(page does not exist\)\s*$/i;
function cleanLinkedName(rawTitle, href) {
  const isRedlink = REDLINK_SUFFIX.test(rawTitle) || /[?&]redlink=1(&|$)/i.test(href);
  const name = stripHtml(rawTitle).replace(REDLINK_SUFFIX, '').trim();
  return { name, url: isRedlink ? null : decodeEntities(`https://liquipedia.net${href}`) };
}

// A team cell is usually rendered as a logo icon with NO visible text at all —
// the real team name only exists in the link's title attribute (e.g.
// <a href="/valorant/All_Gamers" title="AG.AL International"><img .../></a>).
// Plain tag-stripping alone loses the name entirely and leaves only whatever
// visible text remains (a role annotation like "(Analyst)" for staff moves),
// which is exactly why transfers previously showed "(Analyst)" as the team.
function extractTeamCell(rawHtml) {
  const linkMatch = rawHtml.match(/<a[^>]*\shref="([^"]+)"[^>]*\stitle="([^"]*)"/i);
  const trailingText = stripHtml(rawHtml);
  if (linkMatch && linkMatch[2]) {
    const { name, url } = cleanLinkedName(linkMatch[2], linkMatch[1]);
    return { name: trailingText && trailingText !== name ? `${name} ${trailingText}` : name, url };
  }
  return { name: trailingText, url: null };
}

// The player's name cell always links to their own Liquipedia page.
function extractPlayerCell(rawHtml) {
  const linkMatch = rawHtml.match(/<a[^>]*\shref="([^"]+)"[^>]*\stitle="([^"]*)"/i);
  if (linkMatch && linkMatch[2]) {
    return cleanLinkedName(linkMatch[2], linkMatch[1]);
  }
  return { name: stripHtml(rawHtml), url: null };
}

// The "Ref" cell (when present) is a single external link icon pointing at
// the tweet/article/announcement the transfer or rumour was sourced from.
function extractRefUrl(rawHtml) {
  const m = rawHtml.match(/<a[^>]*\shref="([^"]+)"/i);
  return m ? decodeEntities(m[1]) : null;
}

// Parses a Liquipedia transfers or rumours table. rowClass is 'divRow' for
// Portal:Transfers pages, 'RumourRow' for Portal:Rumours pages — both use the
// same divCell layout underneath, rumours just add Status/Confidence cells.
function parseTransferTable(html, game, rowClass = 'divRow') {
  const rowRe = new RegExp(`<div[^>]*class="[^"]*\\b${rowClass}\\b[^"]*"[^>]*>`, 'i');
  const parts = html.split(new RegExp(rowRe.source, 'i'));
  const rows = [];
  for (let i = 1; i < parts.length && rows.length < 15; i++) {
    const chunk = parts[i];
    const date = stripHtml(extractCellRaw(chunk, 'Date'));
    const player = extractPlayerCell(extractCellRaw(chunk, 'Name'));
    const from = extractTeamCell(extractCellRaw(chunk, 'OldTeam'));
    const to = extractTeamCell(extractCellRaw(chunk, 'NewTeam'));
    const refUrl = extractRefUrl(extractCellRaw(chunk, 'Ref'));
    if (!player.name) continue;
    const row = {
      date, player: player.name, playerUrl: player.url,
      from: from.name || 'None', to: to.name || 'None',
      game, refUrl,
    };
    if (rowClass === 'RumourRow') {
      row.confidence = stripHtml(extractCellRaw(chunk, 'Confidence'));
    }
    rows.push(row);
  }
  return rows;
}

// Esports_World_Cup/2026/Clubs: a 209-club x 25-title qualification matrix.
// Each title cell carries a data-sort-value the page itself uses for its own
// column sorting — 1=qualified, 2=can still qualify, 3=failed to qualify,
// 4=not eligible (late signing/joint venture), 9=no team in that title at
// all — confirmed against every value actually present on the live page
// (2026-07-14, one-off fetch, saved to a local fixture; not re-fetched since).
// That data-sort-value is a far more reliable qualified/not signal than
// matching the fa-check-circle/fa-times icon classes directly, since some
// cells hold multiple sub-team links (regional academies etc.) with mixed
// statuses — the cell's own data-sort-value is Liquipedia's own rollup.
function parseClubsQualification(html) {
  const tableStart = html.indexOf('wikitable sortable');
  if (tableStart === -1) return { titleCols: [], clubs: [] };
  const tableEnd = html.indexOf('</table>', tableStart);
  const tableHtml = html.slice(tableStart, tableEnd);

  const headerEnd = tableHtml.indexOf('</tr>') + 5;
  const headerHtml = tableHtml.slice(0, headerEnd);
  const seen = new Set();
  const titleCols = [];
  for (const m of headerHtml.matchAll(/<a href="\/esports\/([^"]+)" title="([^"]+)"/g)) {
    const slug = decodeURIComponent(m[1]);
    if (slug === 'Esports_World_Cup' || seen.has(slug)) continue;
    seen.add(slug);
    titleCols.push({ slug, short: decodeEntities(m[2]) });
  }

  const bodyHtml = tableHtml.slice(headerEnd);
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  const clubs = [];
  let rowMatch;
  while ((rowMatch = rowRe.exec(bodyHtml))) {
    const row = rowMatch[1];
    const nameMatch = row.match(/team-template-text"><a[^>]*title="([^"]+)"/);
    if (!nameMatch) continue;
    const club = decodeEntities(nameMatch[1]).replace(REDLINK_SUFFIX, '').trim();

    const qMatch = row.match(/<td>(\d+)\/(\d+)<\/td>/);
    const qualifiedCount = qMatch ? Number(qMatch[1]) : null;
    const totalTournaments = qMatch ? Number(qMatch[2]) : titleCols.length;

    const sortValues = [...row.matchAll(/<td class="[^"]*" data-sort-value="(\d+)">/g)].map((m) => m[1]);
    if (sortValues.length !== titleCols.length) continue; // malformed row — skip rather than misalign columns

    const titles = titleCols.filter((_, i) => sortValues[i] === '1').map((t) => t.slug);
    clubs.push({ club, qualifiedCount, totalTournaments, titles });
  }
  return { titleCols, clubs };
}

// Esports_World_Cup/2026/Club_Championship_Standings: the page pre-renders
// the same standings table 7 times behind "Week 1..7" toggle buttons — all 7
// showed identical totals when checked live, so which one is read doesn't
// affect correctness. Reads the last (highest id = latest) occurrence as
// "today's" snapshot. Only rank/club/total points are parsed — per-title
// point columns exist on the page but aren't part of the current design
// (titles-qualified comes from the Clubs page instead).
function parseClubChampionshipStandings(html) {
  const marker = 'data-toggle-area-content="25"';
  let idx = html.indexOf(marker);
  if (idx === -1) return [];
  const rows = [];
  while (idx !== -1) {
    const rowEnd = html.indexOf('</tr>', idx);
    const row = html.slice(idx, rowEnd);
    const rankMatch = row.match(/^data-toggle-area-content="25"><td[^>]*>([\d.]+)<\/td>/);
    const nameMatch = row.match(/team-template-text"><a[^>]*title="([^"]+)"/);
    const pointsMatch = row.match(/font-weight:bold">(\d+)<\/td>/);
    if (nameMatch && pointsMatch) {
      rows.push({
        rank: rankMatch ? Number(rankMatch[1].replace('.', '')) : null,
        club: decodeEntities(nameMatch[1]).replace(REDLINK_SUFFIX, '').trim(),
        points: Number(pointsMatch[1]),
      });
    }
    idx = html.indexOf(marker, rowEnd);
  }
  return rows;
}

module.exports = {
  decodeEntities, stripHtml, extractCellRaw, extractTeamCell, extractPlayerCell, extractRefUrl, parseTransferTable,
  cleanLinkedName, REDLINK_SUFFIX, parseClubsQualification, parseClubChampionshipStandings,
};
