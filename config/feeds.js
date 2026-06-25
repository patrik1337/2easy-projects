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
  liquipedia: [
    { wiki: 'valorant',          game: 'Valorant',            page: 'Portal:Transfers' },
    { wiki: 'leagueoflegends',   game: 'League of Legends',   page: 'Player_Transfers' }, // LoL uses Player_Transfers, not Portal:Transfers
    { wiki: 'counterstrike',     game: 'Counter-Strike',      page: 'Portal:Transfers' },
    { wiki: 'dota2',             game: 'Dota 2',              page: 'Portal:Transfers' },
    { wiki: 'rocketleague',      game: 'Rocket League',       page: 'Transfers' },         // RL uses /Transfers, not Portal:Transfers
    { wiki: 'overwatch',         game: 'Overwatch',           page: 'Player_Transfers' },
    { wiki: 'rainbowsix',        game: 'Rainbow Six Siege',   page: 'Portal:Transfers' },
    { wiki: 'apexlegends',       game: 'Apex Legends',        page: 'Portal:Transfers' },
    { wiki: 'callofduty',        game: 'Call of Duty',        page: 'Portal:Transfers' },
    { wiki: 'fortnite',          game: 'Fortnite',            page: 'Portal:Transfers' },
    { wiki: 'pubg',              game: 'PUBG Battlegrounds',  page: 'Portal:Transfers' },
    { wiki: 'pubgmobile',        game: 'PUBG Mobile',         page: 'Portal:Transfers' },
    { wiki: 'mobilelegends',     game: 'Mobile Legends',      page: 'Portal:Transfers' },
    { wiki: 'honorofkings',      game: 'Honor of Kings',      page: 'Portal:Transfers' },
    { wiki: 'teamfighttactics',  game: 'Teamfight Tactics',   page: 'Portal:Transfers' },
    { wiki: 'easportsfc',        game: 'EA Sports FC',        page: 'Portal:Transfers' },
    { wiki: 'crossfire',         game: 'CrossFire',           page: 'Portal:Transfers' },
    { wiki: 'freefire',          game: 'Free Fire',           page: 'Portal:Transfers' },
    { wiki: 'trackmania',        game: 'TrackMania',          page: 'Portal:Transfers' },
  ],
};
