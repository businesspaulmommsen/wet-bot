const axios = require('axios');

const headers = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'de-DE,de;q=0.9',
  'Referer': 'https://www.tipico.de/',
};

async function tryUrl(label, url) {
  try {
    const r = await axios.get(url, { headers, timeout: 8000 });
    const data = r.data;
    const str = JSON.stringify(data).slice(0, 300);
    console.log(`\n✓ ${label}`);
    console.log('  Status:', r.status);
    console.log('  Preview:', str);
  } catch(e) {
    console.log(`✗ ${label} -> ${e.response?.status || e.message}`);
  }
}

(async () => {
  await tryUrl('Tennis API v1', 'https://www.tipico.de/api/sports/tennis/events');
  await tryUrl('Tennis API v2', 'https://www.tipico.de/api/v2/categories/tennis/events');
  await tryUrl('Sports API', 'https://www.tipico.de/api/sports/categories');
  await tryUrl('Cds API Tennis', 'https://cds-api.tipico.com/api/v1/sports/tennis/events?lang=de');
  await tryUrl('Cds API List', 'https://cds-api.tipico.com/api/v1/categories?lang=de');
  await tryUrl('Tipico Sports', 'https://sports.tipico.de/api/sports');
  await tryUrl('Tipico Events', 'https://sports.tipico.de/api/events?sport=tennis');
})();