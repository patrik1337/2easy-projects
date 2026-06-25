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

  liquipedia: [
    { wiki: 'valorant', game: 'Valorant', page: 'Portal:Transfers' },
    { wiki: 'leagueoflegends', game: 'League of Legends', page: 'Player_Transfers' },
    { wiki: 'counterstrike', game: 'Counter-Strike', page: 'Portal:Transfers' },
  ],
};
