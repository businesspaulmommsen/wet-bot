const axios = require('axios');

const URLS = [
  ['ATP Scoreboard',  'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard'],
  ['WTA Scoreboard',  'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard'],
  ['ATP Schedule',    'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/schedule'],
  ['WTA Schedule',    'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/schedule'],
  ['Tennis Events',   'https://site.api.espn.com/apis/site/v2/sports/tennis/events'],
];

(async () => {
  for (const [label, url] of URLS) {
    try {
      const r = await axios.get(url, { timeout: 6000 });
      const d = r.data;
      console.log(`\n✓ ${label}`);
      // Zeige erste Felder
      const keys = Object.keys(d);
      console.log('  Keys:', keys.join(', '));
      // Suche nach Events/Matches
      const events = d.events || d.competitions || d.matches || d.schedule || [];
      if (Array.isArray(events) && events.length > 0) {
        const first = events[0];
        console.log('  Erstes Event:', JSON.stringify(first).slice(0, 200));
      }
    } catch(e) {
      console.log(`✗ ${label} -> ${e.response?.status || e.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
})();