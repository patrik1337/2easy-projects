// Central config for all data sources.
// Add or remove RSS feeds here without touching api/refresh.js.
module.exports = {
  rss: [
    {
      name: 'Esports Insider',
      url: 'https://esportsinsider.com/feed',
      section: 'industry',
    },
    {
      name: 'Esports News UK',
      url: 'https://esports-news.co.uk/feed',
      section: 'headlines',
    },
    {
      name: 'Dexerto',
      url: 'https://www.dexerto.com/feed/',
      section: 'headlines',
      // Dexerto covers all gaming; only keep items tagged esports
      categoryKeyword: 'esports',
    },
    {
      name: 'Dot Esports',
      url: 'https://dotesports.com/feed',
      section: 'headlines',
    },
    // Sheep Esports: feed returns 404 on all known variants (checked 2026-06-25)
    // Re-enable if they publish a feed: { name: 'Sheep Esports', url: 'https://sheepesports.com/feed', section: 'headlines' }
  ],

  // All Esports World Cup 2026 titles that have Liquipedia transfer pages.
  // Page names verified live on 2026-06-25; a few oddballs noted inline.
  // Fighting game titles (Fatal Fury, Street Fighter 6, Tekken 8) are omitted —
  // the Liquipedia fightinggames wiki has no transfers portal.
  // Chess is omitted — not applicable for roster transfers.
  //
  // rumoursPage: confirmed live on the Valorant wiki (2026-07-08); defaulted to
  // the same "Portal:Rumours" pattern for the rest since most wikis mirror
  // "Portal:Transfers" — unverified per-wiki, but a wrong/missing page just
  // yields 0 rumours for that game (same graceful degradation as transfers),
  // never breaks anything. Refine individual entries if a game's Rumours tab
  // stays consistently empty.
  liquipedia: [
    { wiki: 'valorant',          game: 'Valorant',            page: 'Portal:Transfers', rumoursPage: 'Portal:Rumours' },
    { wiki: 'leagueoflegends',   game: 'League of Legends',   page: 'Player_Transfers', rumoursPage: 'Portal:Rumours' }, // LoL uses Player_Transfers, not Portal:Transfers
    { wiki: 'counterstrike',     game: 'Counter-Strike',      page: 'Portal:Transfers', rumoursPage: 'Portal:Rumours' },
    { wiki: 'dota2',             game: 'Dota 2',              page: 'Portal:Transfers', rumoursPage: 'Portal:Rumours' },
    { wiki: 'rocketleague',      game: 'Rocket League',       page: 'Transfers',        rumoursPage: 'Portal:Rumours' }, // RL uses /Transfers, not Portal:Transfers
    { wiki: 'overwatch',         game: 'Overwatch',           page: 'Player_Transfers', rumoursPage: 'Portal:Rumours' },
    { wiki: 'rainbowsix',        game: 'Rainbow Six Siege',   page: 'Portal:Transfers', rumoursPage: 'Portal:Rumours' },
    { wiki: 'apexlegends',       game: 'Apex Legends',        page: 'Portal:Transfers', rumoursPage: 'Portal:Rumours' },
    { wiki: 'callofduty',        game: 'Call of Duty',        page: 'Portal:Transfers', rumoursPage: 'Portal:Rumours' },
    { wiki: 'fortnite',          game: 'Fortnite',            page: 'Portal:Transfers', rumoursPage: 'Portal:Rumours' },
    { wiki: 'pubg',              game: 'PUBG Battlegrounds',  page: 'Portal:Transfers', rumoursPage: 'Portal:Rumours' },
    { wiki: 'pubgmobile',        game: 'PUBG Mobile',         page: 'Portal:Transfers', rumoursPage: 'Portal:Rumours' },
    { wiki: 'mobilelegends',     game: 'Mobile Legends',      page: 'Portal:Transfers', rumoursPage: 'Portal:Rumours' },
    { wiki: 'honorofkings',      game: 'Honor of Kings',      page: 'Portal:Transfers', rumoursPage: 'Portal:Rumours' },
    { wiki: 'teamfighttactics',  game: 'Teamfight Tactics',   page: 'Portal:Transfers', rumoursPage: 'Portal:Rumours' },
    { wiki: 'easportsfc',        game: 'EA Sports FC',        page: 'Portal:Transfers', rumoursPage: 'Portal:Rumours' },
    { wiki: 'crossfire',         game: 'CrossFire',           page: 'Portal:Transfers', rumoursPage: 'Portal:Rumours' },
    { wiki: 'freefire',          game: 'Free Fire',           page: 'Portal:Transfers', rumoursPage: 'Portal:Rumours' },
    { wiki: 'trackmania',        game: 'TrackMania',          page: 'Portal:Transfers', rumoursPage: 'Portal:Rumours' },
  ],
};
