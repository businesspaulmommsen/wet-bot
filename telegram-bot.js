/**
 * Oddify x Tipico - Telegram Bot
 * Unterstuetzt NBA-Format und Soccer/Tennis/UFC-Format
 * npm install node-telegram-bot-api axios node-schedule
 * node telegram-bot.js
 */

const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const schedule    = require('node-schedule');

const CONFIG = {
  telegramToken:  process.env.TELEGRAM_TOKEN || '',
  chatId:         null,

  oddifyApiUrl:  'https://fouddhhpuyrxugfhuqmq.supabase.co/functions/v1/get-predictions',
  oddifyAuthUrl: 'https://fouddhhpuyrxugfhuqmq.supabase.co/auth/v1/token?grant_type=password',
  oddifyApiKey:  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZvdWRkaGhwdXlyeHVnZmh1cW1xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY5MjA3ODcsImV4cCI6MjA3MjQ5Njc4N30.WVnGOt-nuubcVQLDskLqZSrcezK4OkbUFOUOLXWbqv4',
  oddifyEmail:   'paul2004mm@gmail.com',
  oddifyPassword: process.env.ODDIFY_PASSWORD || '',
  oddifyToken:   null,
  oddifyTokenExp: 0,

  bankroll:       50,
  maxSportPct:    0.60,
  minProbability: 0.55,
  kellyFraction:  0.5,
  pollMinutes:    5,
  daysAhead:      3,

  sports: ['nba', 'soccer', 'tennis_atp', 'tennis_wta', 'ufc'],
};

// ── ESPN Turnier-Cache ────────────────────────
const espnTournaments = {};

// ── UFC ESPN Fight Cache ───────────────────────
// { 'fighter a vs fighter b': { date, dateStr, dateLabel } }
const ufcEspnFights = {};

async function fetchUfcEspnFights() {
  try {
    const r = await axios.get(
      'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard',
      { timeout: 6000 }
    );
    const events = r.data?.events || [];
    // Clear old fights
    for (const k of Object.keys(ufcEspnFights)) delete ufcEspnFights[k];
    for (const ev of events) {
      for (const comp of (ev.competitions || [])) {
        const fighters = (comp.competitors || [])
          .map(f => f.athlete?.displayName || f.team?.displayName || '')
          .filter(Boolean);
        if (fighters.length < 2) continue;
        const dateStr   = toLocalDate(comp.date || ev.date);
        const dateLabel = formatDate(comp.date || ev.date);
        // Store under both name orderings for matching
        const key1 = fighters[0].toLowerCase() + ' vs ' + fighters[1].toLowerCase();
        const key2 = fighters[1].toLowerCase() + ' vs ' + fighters[0].toLowerCase();
        const last1 = fighters[0].split(' ').pop().toLowerCase();
        const last2 = fighters[1].split(' ').pop().toLowerCase();
        const info  = { dateStr, dateLabel, eventName: ev.name, fighters, last1, last2 };
        ufcEspnFights[key1] = info;
        ufcEspnFights[key2] = info;
        ufcEspnFights[last1 + ' vs ' + last2] = info;
        ufcEspnFights[last2 + ' vs ' + last1] = info;
      }
    }
    const total = Object.keys(ufcEspnFights).length / 4; // divided by 4 orderings
    console.log(`  UFC ESPN: ${Math.round(total)} Kaempfe geladen (${events[0]?.name || ''})`);
  } catch(e) {
    console.log('  UFC ESPN Fehler:', e.message);
  }
}

async function fetchEspnTournaments() {
  const map = { tennis_atp: 'atp', tennis_wta: 'wta' };
  for (const [sport, league] of Object.entries(map)) {
    try {
      const r = await axios.get(
        `https://site.api.espn.com/apis/site/v2/sports/tennis/${league}/scoreboard`,
        { timeout: 6000 }
      );
      const events = r.data?.events || [];
      const today  = new Date().toISOString().split('T')[0];
      const current = events.find(e => {
        const start = e.date?.slice(0,10) || '';
        const end   = e.endDate?.slice(0,10) || '';
        return start <= today && end >= today;
      }) || events[0];
      if (current) {
        espnTournaments[sport] = {
          name:    current.name || current.shortName || sport,
          dateStr: (current.date || today).slice(0,10),
          endStr:  (current.endDate || today).slice(0,10),
        };
        console.log(`  ESPN ${sport}: ${espnTournaments[sport].name} (${espnTournaments[sport].dateStr} - ${espnTournaments[sport].endStr})`);
      }
    } catch(e) {
      console.log(`  ESPN ${sport}: nicht erreichbar`);
    }
  }
}

// ── UFC beste Quoten Cache ────────────────────
const ufcBestOdds = {};

// In Deutschland legale Buchmacher
const EU_BOOKMAKERS = new Set([
  'unibet', 'unibet_nl', 'unibet_se', 'unibet_uk', 'unibet_fr',
  'bet365', 'betway', 'williamhill', 'betsson', 'nordicbet',
  'leovegas', 'marathonbet', 'pinnacle', 'sport888',
  'betfair_ex_eu', 'matchbook', 'coolbet',
]);

// Anzeigename fuer Buchmacher
const BOOKMAKER_NAMES = {
  'unibet': 'Unibet', 'unibet_nl': 'Unibet', 'unibet_se': 'Unibet',
  'unibet_uk': 'Unibet', 'unibet_fr': 'Unibet',
  'bet365': 'Bet365', 'betway': 'Betway', 'williamhill': 'William Hill',
  'betsson': 'Betsson', 'nordicbet': 'NordicBet', 'leovegas': 'LeoVegas',
  'marathonbet': 'Marathonbet', 'pinnacle': 'Pinnacle', 'sport888': '888sport',
  'betfair_ex_eu': 'Betfair', 'matchbook': 'Matchbook', 'coolbet': 'Coolbet',
};

async function fetchUfcBestOdds() {
  if (!await ensureOddifyToken()) return;
  try {
    const r = await axios.get(
      'https://fouddhhpuyrxugfhuqmq.supabase.co/rest/v1/odds_history?limit=1000&order=changed_at.desc',
      { headers: { apikey: CONFIG.oddifyApiKey, Authorization: `Bearer ${CONFIG.oddifyToken}` }, timeout: 8000 }
    );
    const data = r.data || [];
    data.forEach(o => {
      // Nur EU-verfuegbare Buchmacher
      if (!EU_BOOKMAKERS.has(o.bookmaker)) return;
      const key = o.fight_key;
      const sel = o.selection;
      if (!ufcBestOdds[key]) ufcBestOdds[key] = {};
      if (!ufcBestOdds[key][sel] || o.price_decimal > ufcBestOdds[key][sel].price) {
        ufcBestOdds[key][sel] = { price: o.price_decimal, bookmaker: BOOKMAKER_NAMES[o.bookmaker] || o.bookmaker };
      }
    });
    console.log(`  UFC odds_history: ${Object.keys(ufcBestOdds).length} Kaempfe geladen`);
  } catch(e) {
    console.log('  UFC odds_history Fehler:', e.message);
  }
}

// ── Telegram ──────────────────────────────────
const bot = new TelegramBot(CONFIG.telegramToken, { polling: true });

function send(text, chatId) {
  const id = chatId || CONFIG.chatId;
  if (!id) return Promise.resolve();
  const chunks = [];
  for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900));
  return chunks.reduce((p, chunk) =>
    p.then(() => bot.sendMessage(id, chunk, { parse_mode: 'Markdown' })
      .catch(() => bot.sendMessage(id, chunk.replace(/[*_`]/g, ''), {}).catch(() => {}))),
    Promise.resolve()
  );
}

function nowStr() {
  return new Date().toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin'
  });
}

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toLocaleString('de-DE', {
      weekday: 'short', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin'
    });
  } catch { return dateStr; }
}

function toLocalDate(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('de-DE', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      timeZone: 'Europe/Berlin'
    }).split('.').reverse().join('-');
  } catch { return new Date().toISOString().split('T')[0]; }
}

// ── Oddify Auto-Login ─────────────────────────
async function ensureOddifyToken() {
  const now = Math.floor(Date.now() / 1000);
  if (CONFIG.oddifyToken && CONFIG.oddifyTokenExp > now + 60) return true;
  try {
    const res = await axios.post(CONFIG.oddifyAuthUrl,
      { email: CONFIG.oddifyEmail, password: CONFIG.oddifyPassword },
      { headers: { 'apikey': CONFIG.oddifyApiKey, 'Content-Type': 'application/json' } }
    );
    CONFIG.oddifyToken    = res.data.access_token;
    CONFIG.oddifyTokenExp = now + (res.data.expires_in || 3600);
    console.log('Oddify Login OK');
    return true;
  } catch (e) {
    console.error('Oddify Login Fehler:', e.response?.status, e.response?.data?.message || e.message);
    return false;
  }
}

// ── Spiel parsen ──────────────────────────────
function parseGame(g, sport) {
  const today    = new Date(); today.setHours(0,0,0,0);
  const maxDate  = new Date(today); maxDate.setDate(maxDate.getDate() + CONFIG.daysAhead + 1);
  const todayStr = new Date().toISOString().split('T')[0];

  // NBA
  if (g.game_date && g.team_a_name) {
    const gameDate = new Date(g.game_date + 'T12:00:00');
    if (gameDate < today || gameDate >= maxDate) return null;
    const homeWins = (g.team_a_win_prob || 0) >= (g.team_b_win_prob || 0);
    const pick     = homeWins ? g.team_a_name : g.team_b_name;
    const opponent = homeWins ? g.team_b_name : g.team_a_name;
    const prob     = homeWins ? (g.team_a_win_prob || 0) : (g.team_b_win_prob || 0);
    const oppProb  = homeWins ? (g.team_b_win_prob || 0) : (g.team_a_win_prob || 0);
    const realOdds = homeWins ? g.home_odds_decimal : g.away_odds_decimal;
    const odds     = (realOdds && realOdds > 1) ? realOdds : estimateOdds(prob);
    if (prob < CONFIG.minProbability) return null;
    const confidence   = g.model_confidence || 0.7;
    const adjProb      = prob * confidence + 0.5 * (1 - confidence);
    const pickInjuries = homeWins ? (g.home_injuries_out || 0) : (g.away_injuries_out || 0);
    const oppInjuries  = homeWins ? (g.away_injuries_out || 0) : (g.home_injuries_out || 0);
    const injuryFactor = Math.max(0.85, 1 - pickInjuries * 0.025 + oppInjuries * 0.015);
    const finalProb    = Math.min(0.97, adjProb * injuryFactor);
    if (finalProb < CONFIG.minProbability) return null;
    return {
      sport, pick, opponent,
      prob: finalProb, rawProb: prob, oppProb, odds,
      confidence, pickInjuries, oppInjuries,
      hasRealOdds: !!(realOdds && realOdds > 1),
      game:      g.event_name || `${g.team_a_name} vs ${g.team_b_name}`,
      gameDate:  g.game_date,
      dateLabel: g.game_date + ' (NBA ~21-04 Uhr MEZ)',
      sortKey:   g.game_date,
      isToday:   g.game_date === todayStr,
      league:    'NBA',
    };
  }

  // UFC
  if (g.fighter_a_name && g.fighter_b_name) {
    const aProb = g.fighter_a_win_prob || 0;
    const bProb = g.fighter_b_win_prob || 0;
    // fighter_a = blue corner, fighter_b = red corner in odds_history
    // Pick = der Favorit laut AI
    const aWins = aProb >= bProb;
    const pick  = aWins ? g.fighter_a_name : g.fighter_b_name;
    const oppon = aWins ? g.fighter_b_name : g.fighter_a_name;
    const prob  = Math.max(aProb, bProb);
    const oppP  = Math.min(aProb, bProb);
    if (prob < CONFIG.minProbability) return null;
    const confidence = g.model_confidence || 0.7;
    const adjProb    = prob * confidence + 0.5 * (1 - confidence);
    const finalProb  = Math.min(0.97, adjProb);
    if (finalProb < CONFIG.minProbability) return null;

    // Beste Quote aus EU-Buchis via Nachnamen-Matching
    let bestOdds = null;
    for (const [key, oddsObj] of Object.entries(ufcBestOdds)) {
      const kn = key.toLowerCase();
      if (kn.includes(lastA) && kn.includes(lastB)) {
        // blue = fighter_a, red = fighter_b
        const sel = aWins ? 'blue' : 'red';
        if (oddsObj[sel]) { bestOdds = oddsObj[sel]; break; }
      }
    }
    const odds = bestOdds ? bestOdds.price : estimateOdds(finalProb);

    // Match against ESPN to get real date/time and filter old fights
    // Match gegen ESPN fuer echtes Datum
    const lastA = (g.fighter_a_name||'').split(' ').pop().toLowerCase();
    const lastB = (g.fighter_b_name||'').split(' ').pop().toLowerCase();
    let espnInfo = null;

    // Versuche Matching mit Nachnamen
    for (const [key, info] of Object.entries(ufcEspnFights)) {
      const kn = key.toLowerCase();
      if (kn.includes(lastA) || kn.includes(lastB)) {
        // Mindestens ein Name muss matchen, dann pruefen ob beide da
        const kparts = kn.replace(' vs ', ' ').split(' ');
        const matchA = kparts.some(p => p.includes(lastA.slice(0,4)));
        const matchB = kparts.some(p => p.includes(lastB.slice(0,4)));
        if (matchA && matchB) { espnInfo = info; break; }
      }
    }

    // Kein ESPN Match: nutze naechstes bekanntes UFC Event-Datum als Fallback
    if (!espnInfo) {
      const ufcDates = Object.values(ufcEspnFights).map(i => i.dateStr).filter(Boolean);
      if (ufcDates.length > 0) {
        const nextDate = ufcDates.sort()[0];
        espnInfo = { dateStr: nextDate, dateLabel: formatDate(nextDate + 'T21:00:00'), eventName: 'UFC' };
      } else {
        return null; // Kein UFC Event bekannt
      }
    }

    // Check date is within daysAhead
    const fightDate = new Date(espnInfo.dateStr + 'T12:00:00');
    if (fightDate < today || fightDate >= maxDate) return null;

    return {
      sport, pick, opponent: oppon,
      prob: finalProb, rawProb: prob, oppProb: oppP, odds,
      confidence, hasRealOdds: !!bestOdds,
      bestBookmaker: bestOdds ? bestOdds.bookmaker : null,
      game:      `${g.fighter_a_name} vs ${g.fighter_b_name}`,
      gameDate:  espnInfo.dateStr,
      dateLabel: `${espnInfo.dateLabel} | ${espnInfo.eventName}`,
      sortKey:   espnInfo.dateStr + (g.fighter_a_name||''),
      isToday:   espnInfo.dateStr === todayStr,
      league:    'UFC',
    };
  }

  // Soccer
  if (g.commence_time && g.home_team) {
    const gameDate = new Date(g.commence_time);
    if (gameDate < today || gameDate >= maxDate) return null;
    const homeProb = g.home_prob || 0;
    const awayProb = g.away_prob || 0;
    const homeWins = homeProb >= awayProb;
    const pick     = homeWins ? g.home_team : g.away_team;
    const opponent = homeWins ? g.away_team : g.home_team;
    const prob     = Math.max(homeProb, awayProb);
    const oppProb  = Math.min(homeProb, awayProb);
    if (prob < CONFIG.minProbability) return null;
    const dateStr = toLocalDate(g.commence_time);
    return {
      sport, pick, opponent, prob, oppProb,
      odds: estimateOdds(prob), hasRealOdds: false,
      game:      `${g.home_team} vs ${g.away_team}`,
      gameDate:  dateStr,
      dateLabel: formatDate(g.commence_time),
      sortKey:   g.commence_time,
      isToday:   dateStr === todayStr,
      league:    g.league || sport.toUpperCase(),
    };
  }

  // Tennis
  if (g.p1_name && g.p2_name) {
    const p1Prob = g.p1_win_prob || 0;
    const p2Prob = g.p2_win_prob || 0;
    const p1Wins = p1Prob >= p2Prob;
    const pick   = g.predicted_winner || (p1Wins ? g.p1_name : g.p2_name);
    const oppon  = p1Wins ? g.p2_name : g.p1_name;
    const prob   = Math.max(p1Prob, p2Prob);
    const oppP   = Math.min(p1Prob, p2Prob);
    if (prob < CONFIG.minProbability) return null;
    const tournInfo  = espnTournaments[sport] || {};
    const endDate    = tournInfo.endStr || todayStr;
    const tournament = g.tournament || tournInfo.name || sport.toUpperCase();
    const round      = g.round ? ` ${g.round}` : '';
    const surface    = g.surface ? ` | ${g.surface}` : '';

    // Turnier muss heute noch laufen
    if (endDate < todayStr) return null;

    // Zeige immer das heutige Datum (wir wissen nicht genau wann das Match ist)
    const gameDate = todayStr;
    const label    = `${tournament}${round}${surface} | bis ${endDate.slice(5).replace('-','.')}`;

    return {
      sport, pick, opponent: oppon, prob, oppProb: oppP,
      odds: estimateOdds(prob), hasRealOdds: false,
      game:      `${g.p1_name} vs ${g.p2_name}`,
      gameDate,
      dateLabel: label,
      sortKey:   gameDate + g.p1_name,
      isToday:   true,
      league:    tournament,
    };
  }

  return null;
}

function estimateOdds(prob) {
  return +Math.max(1.05, 1 / (Math.max(prob, 0.01) * 0.95)).toFixed(2);
}

async function fetchPredictions(sport) {
  if (!await ensureOddifyToken()) return [];
  try {
    const res = await axios.post(
      CONFIG.oddifyApiUrl, { sport },
      {
        headers: {
          'apikey':        CONFIG.oddifyApiKey,
          'Authorization': `Bearer ${CONFIG.oddifyToken}`,
          'Content-Type':  'application/json',
          'Origin':        'https://oddify.ai',
        },
        timeout: 12000,
      }
    );
    const items = Array.isArray(res.data) ? res.data : [];
    const result = items.map(g => parseGame(g, sport)).filter(Boolean);
    result.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    return result;
  } catch (e) {
    if (e.response?.status === 401) CONFIG.oddifyToken = null;
    console.error(`Oddify ${sport} Fehler:`, e.response?.status || e.message);
    return [];
  }
}

// ── Kelly-Logik ───────────────────────────────
function halfKelly(p, odds) {
  const b = odds - 1, q = 1 - p;
  return Math.max(0, (p * b - q) / b * CONFIG.kellyFraction);
}
function calcEV(p, odds)   { return (p * odds - 1) * 100; }
function calcEdge(p, odds) { return p - 1 / odds; }

function allocateBets(predictions) {
  const bySport = {};
  predictions.forEach(p => {
    if (!bySport[p.sport]) bySport[p.sport] = [];
    bySport[p.sport].push(p);
  });
  const n           = Object.keys(bySport).length;
  const sportBudget = Math.min(CONFIG.bankroll / Math.max(n, 1), CONFIG.bankroll * CONFIG.maxSportPct);
  const result      = [];
  for (const [sport, games] of Object.entries(bySport)) {
    const enriched = games.map(g => ({
      ...g,
      edge: calcEdge(g.prob, g.odds),
      ev:   calcEV(g.prob, g.odds),
      hk:   halfKelly(g.prob, g.odds),
    }));
    const posEdges  = enriched.map(g => Math.max(0, g.edge));
    const totalEdge = posEdges.reduce((a, b) => a + b, 0);
    const cnt       = enriched.length;
    enriched.forEach((g, i) => {
      const equalPart = sportBudget * 0.40 / cnt;
      const edgePart  = totalEdge > 0 ? sportBudget * 0.60 * posEdges[i] / totalEdge : 0;
      const kellyCap  = g.hk * sportBudget;
      const raw       = equalPart + edgePart;
      result.push({
        ...g, sport,
        bet:         +(Math.min(raw, kellyCap > 0 ? kellyCap : raw)).toFixed(2),
        sportBudget: +sportBudget.toFixed(2),
        hk:          +g.hk.toFixed(4),
      });
    });
  }
  result.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return result;
}

// ── Scan ─────────────────────────────────────
let lastBets     = [];
let lastScanTime = null;
let seenGames    = new Set();
let liveAlerted  = new Set();
let valueAlerted = new Set();
let activeBets   = [];
let betHistory   = [];
let trackBankroll = CONFIG.bankroll;

const VALUE_MIN_ODDS     = 1.6;
const VALUE_MIN_EDGE     = 0.03;
const VALUE_MIN_BOOK_FAV = 0.55;

async function fetchESPNResults(sport) {
  try {
    const url = sport === 'nba'
      ? 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'
      : sport === 'soccer'
      ? 'https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard'
      : `https://site.api.espn.com/apis/site/v2/sports/tennis/${sport}/scoreboard`;
    const r = await axios.get(url, { timeout: 8000 });
    const events = r.data?.events || [];
    const results = [];
    for (const ev of events) {
      for (const comp of (ev.competitions || [])) {
        if (!comp.competitors || !comp.status?.type?.completed) continue;
        const winner = comp.competitors.find(c => c.winner);
        const loser  = comp.competitors.find(c => !c.winner);
        if (winner) results.push({
          winner: winner.team?.displayName || winner.team?.name || '',
          loser:  loser?.team?.displayName || loser?.team?.name || '',
        });
      }
    }
    return results;
  } catch(e) { return []; }
}

async function checkBetResults() {
  if (!activeBets.length) return;
  const sports  = [...new Set(activeBets.map(b => b.sport))];
  let settled = 0, totalProfit = 0;
  const msgs = [];
  for (const sport of sports) {
    const results = await fetchESPNResults(sport);
    if (!results.length) continue;
    for (const bet of activeBets.filter(b => b.sport === sport && b.result === null)) {
      const res = results.find(r =>
        r.winner.toLowerCase().includes(bet.pick.toLowerCase()) ||
        r.loser.toLowerCase().includes(bet.pick.toLowerCase())
      );
      if (!res) continue;
      const won   = res.winner.toLowerCase().includes(bet.pick.toLowerCase());
      bet.result  = won ? 'win' : 'loss';
      bet.profit  = won ? +(bet.bet * (bet.odds - 1)).toFixed(2) : -bet.bet;
      trackBankroll = +(trackBankroll + bet.profit).toFixed(2);
      totalProfit  += bet.profit;
      settled++;
      const icon = won ? '\u2705' : '\u274c';
      msgs.push(`${icon} *${bet.pick}* vs ${bet.opponent} [${sport.toUpperCase()}]\n${won?'Gewonnen':'Verloren'} | Quote ${bet.odds} | ${won?'+':''}\u20ac${bet.profit.toFixed(2)}`);
    }
  }
  const done = activeBets.filter(b => b.result !== null);
  betHistory.push(...done);
  activeBets = activeBets.filter(b => b.result === null);
  if (settled > 0 && CONFIG.chatId) {
    const sign = totalProfit >= 0 ? '+' : '';
    let msg = `*Wett-Ergebnisse*\n_${nowStr()}_\n\n${msgs.join('\n\n')}\n\nNetto: *${sign}\u20ac${totalProfit.toFixed(2)}*\nBankroll: *\u20ac${trackBankroll.toFixed(2)}*`;
    await send(msg);
  }
}

async function runScan(notify = true) {
  console.log(`=== Scan ${nowStr()} ===`);
  const allPreds = [];
  await fetchEspnTournaments();
  await fetchUfcEspnFights();
  await fetchUfcBestOdds();
  for (const sport of CONFIG.sports) {
    const preds = await fetchPredictions(sport);
    console.log(`  ${sport}: ${preds.length} Spiele`);
    allPreds.push(...preds);
  }
  if (!allPreds.length) { console.log('Keine Prognosen gefunden.'); return; }
  lastBets     = allocateBets(allPreds);
  lastScanTime = nowStr();
  const newBets = lastBets.filter(b => {
    const key = `${b.sport}:${b.game}:${b.pick}`;
    if (seenGames.has(key)) return false;
    seenGames.add(key);
    return true;
  });
  if (newBets.length && notify) await sendAlert(newBets);

  // Live-Alert
  if (notify) {
    const sportMap = {};
    for (const b of lastBets) {
      if (!sportMap[b.sport]) sportMap[b.sport] = { total: 0, real: 0 };
      sportMap[b.sport].total++;
      if (b.hasRealOdds) sportMap[b.sport].real++;
    }
    const today0 = new Date().toISOString().split('T')[0];
    for (const [sport, info] of Object.entries(sportMap)) {
      const lk = `${sport}:${today0}`;
      if (info.real > 0 && !liveAlerted.has(lk)) {
        liveAlerted.add(lk);
        const pct = Math.round(info.real / info.total * 100);
        await send(`\u{1F7E2} *${sport.toUpperCase()} ist jetzt live!*\nOddify + Quoten online (${info.real}/${info.total} Spiele, ${pct}% echt)\n\n_Schreib /${sport} oder /${sport} 50 fuer Empfehlungen_`);
      }
    }
  }

  // Value-Alert
  if (notify) {
    const todayV = new Date().toISOString().split('T')[0];
    for (const b of lastBets) {
      if (b.hasRealOdds && b.odds >= VALUE_MIN_ODDS && b.edge >= VALUE_MIN_EDGE &&
          (1/b.odds) >= VALUE_MIN_BOOK_FAV && b.gameDate === todayV) {
        const vk = `value:${b.game}:${b.pick}`;
        if (!valueAlerted.has(vk)) {
          valueAlerted.add(vk);
          const eSign = b.edge >= 0 ? '+' : '';
          const book  = b.bestBookmaker ? ` [${b.bestBookmaker}]` : '';
          await send(`\u26a1 *VALUE ALERT ${b.sport.toUpperCase()}*\n\n*${b.pick}* vs ${b.opponent}\n_${b.dateLabel}_\n\nBuch: ${(1/b.odds*100).toFixed(0)}% | AI: ${(b.prob*100).toFixed(0)}%\nEdge: ${eSign}${(b.edge*100).toFixed(1)}%\n*Quote: ${b.odds.toFixed(2)}${book}* \u2b50\n\n_/${b.sport} 50 fuer volle Aufteilung_`);
        }
      }
    }
  }

  console.log(`=== Fertig | ${lastBets.length} gesamt | ${newBets.length} neu ===`);
}

async function sendAlert(bets) {
  bets = bets.filter(b => b.edge > 0);
  if (!bets.length) return;
  const total = bets.reduce((s, b) => s + b.bet, 0);
  let msg = `*ODDIFY x TIPICO*\n_${nowStr()}_\n${bets.length} neue Spiele | *\u20ac${total.toFixed(2)}*\n\n`;
  let lastDate = '';
  for (const b of bets) {
    if (b.gameDate !== lastDate) { msg += `\`--- ${b.gameDate} ---\`\n`; lastDate = b.gameDate; }
    const eSign = b.edge >= 0 ? '+' : '';
    const star  = b.edge > 0.05 ? '\u2605' : '\u25cb';
    const real  = b.hasRealOdds ? '' : '~';
    const book  = b.bestBookmaker ? ` [${b.bestBookmaker}]` : '';
    msg += `${star} *${b.pick}* vs ${b.opponent}\n_${b.dateLabel}_ | ${b.league}\n${(b.prob*100).toFixed(0)}% | ${real}${b.odds.toFixed(2)}${book} | Edge ${eSign}${(b.edge*100).toFixed(1)}% | *\u20ac${b.bet.toFixed(2)}*\n\n`;
  }
  await send(msg.trim());
}

function formatBets(bets, title) {
  if (!bets.length) return 'Keine Spiele gefunden.';
  const total    = bets.reduce((s, b) => s + b.bet, 0);
  const posCount = bets.filter(b => b.edge > 0).length;
  const negCount = bets.length - posCount;
  let out = `*${title || 'Spiele'}*\n_${nowStr()}_\n${bets.length} Spiele`;
  if (negCount > 0) out += ` (${posCount} mit Edge, ${negCount} \u26a0\ufe0f)`;
  out += ` | *\u20ac${total.toFixed(2)}*\n\n`;
  const today    = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const byDate = {};
  const dateOrder = [];
  for (const b of bets) {
    if (!byDate[b.gameDate]) { byDate[b.gameDate] = []; dateOrder.push(b.gameDate); }
    byDate[b.gameDate].push(b);
  }
  for (const date of dateOrder) {
    const group    = byDate[date];
    const dayLabel = date === today ? 'Heute' : date === tomorrow ? 'Morgen' : date;
    const dd       = date.slice(8,10) + '.' + date.slice(5,7) + '.';
    out += `\`--- ${dayLabel} ${dd} ---\`\n`;
    for (const b of group) {
      const e    = b.edge >= 0 ? `+${(b.edge*100).toFixed(1)}%` : `${(b.edge*100).toFixed(1)}%`;
      const warn = b.edge < 0 ? '\u26a0\ufe0f ' : b.edge > 0.05 ? '\u2605 ' : '\u25cb ';
      const real = b.hasRealOdds ? '' : '~';
      const book = b.bestBookmaker ? ` [${b.bestBookmaker}]` : '';
      out += `${warn}*${b.pick}* vs ${b.opponent}\n_${b.dateLabel}_ | ${b.league} | ${real}${b.odds.toFixed(2)}${book} | ${e} | *\u20ac${b.bet.toFixed(2)}*\n\n`;
    }
  }
  return out.trim();
}

// ── Portfolio Analyse ─────────────────────────
function analyzeAll(bets) {
  const n     = bets.length;
  const total = bets.reduce((s, b) => s + b.bet, 0);
  if (n > 20) return null;
  let probProfit = 0, expProfit = 0;
  const byWrong = {};
  for (let mask = 0; mask < (1 << n); mask++) {
    let prob = 1, profit = -total, wrong = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        prob   *= bets[i].prob;
        profit += bets[i].bet * bets[i].odds;
      } else {
        prob   *= (1 - bets[i].prob);
        wrong++;
      }
    }
    if (!byWrong[wrong]) byWrong[wrong] = { total: 0, profitable: 0, sumProfit: 0 };
    byWrong[wrong].total++;
    byWrong[wrong].sumProfit += profit;
    if (profit > 0) { byWrong[wrong].profitable++; probProfit += prob; }
    expProfit += prob * profit;
  }
  return { probProfit, expProfit, byWrong };
}

function buildBudgetAlloc(pool, budget) {
  const posEdges    = pool.map(b => Math.max(0, b.edge));
  const cnt         = pool.length;
  const edgeSq      = posEdges.map(e => e * e);
  const totalEdgeSq = edgeSq.reduce((a, b) => a + b, 0);
  let allocated = pool.map((b, i) => {
    const equalPart = budget * 0.20 / cnt;
    const edgePart  = totalEdgeSq > 0 ? budget * 0.80 * edgeSq[i] / totalEdgeSq : budget * 0.80 / cnt;
    const kellyCap  = b.hk * budget;
    const raw       = equalPart + edgePart;
    return { ...b, bet: Math.max(0.01, Math.min(raw, kellyCap > 0 ? kellyCap : raw)) };
  });
  let scaleT = allocated.reduce((s, b) => s + b.bet, 0);
  if (scaleT > budget) {
    const sc = budget / scaleT;
    allocated = allocated.map(b => ({ ...b, bet: b.bet * sc }));
  }
  let bestA = analyzeAll(allocated), bestScore = bestA ? bestA.probProfit : 0;
  for (let iter = 0; iter < 400; iter++) {
    const byEdge = [...allocated].sort((a, b2) => (b2.edge*b2.edge) - (a.edge*a.edge));
    const best   = byEdge[0];
    const worst  = byEdge[byEdge.length - 1];
    if (best.game === worst.game && best.pick === worst.pick) break;
    const shift = Math.max(0.01, Math.min(worst.bet * 0.04, 0.30));
    if (shift < 0.005) break;
    const candidate = allocated.map(b => {
      if (b.game === worst.game && b.pick === worst.pick) return { ...b, bet: Math.max(0.01, b.bet - shift) };
      if (b.game === best.game  && b.pick === best.pick)  return { ...b, bet: b.bet + shift };
      return b;
    });
    const candA = analyzeAll(candidate);
    if (!candA) break;
    if (candA.probProfit > bestScore || (Math.abs(candA.probProfit - bestScore) < 0.001 && candA.expProfit > bestA.expProfit)) {
      allocated = candidate; bestScore = candA.probProfit; bestA = candA;
    }
  }
  return allocated.map(b => ({ ...b, bet: +Math.max(0.01, b.bet).toFixed(2), gain: +(b.bet*(b.odds-1)).toFixed(2) }))
    .sort((a, b2) => (b2.edge*b2.edge) - (a.edge*a.edge));
}

function formatBudgetMsg(sportArg, budget, allocated, label) {
  const total     = +(allocated.reduce((s,b)=>s+b.bet,0)).toFixed(2);
  const totalGain = +(allocated.reduce((s,b)=>s+b.gain,0)).toFixed(2);
  const finalA    = analyzeAll(allocated);
  const expProfit = finalA ? +finalA.expProfit.toFixed(2) : 0;
  const probWin   = finalA ? (finalA.probProfit*100).toFixed(1) : '?';
  const bw        = finalA?.byWrong || {};
  const sgain     = [...allocated].sort((a,b2)=>b2.gain-a.gain);
  let beCount = 0, runBE = -total;
  for (const b of sgain) { runBE += b.gain + b.bet; beCount++; if (runBE >= 0) break; }

  let msg = `*${sportArg.toUpperCase()} heute${label} | Budget: \u20ac${budget.toFixed(2)}*\n`;
  msg += `_${nowStr()} | ${allocated.length} Spiele | Einsatz: \u20ac${total}_\n\n`;
  msg += `*Gewinn-Szenarien:*\n`;
  msg += `Wahrsch. im Plus: *${probWin}%*\n`;
  msg += `Erw. Gewinn: *${expProfit>=0?'+':''}\u20ac${expProfit}*\n`;
  msg += `Alle richtig: +\u20ac${totalGain}\n`;
  for (let k = 0; k <= Math.min(5, allocated.length); k++) {
    const s = bw[k] || { total:0, profitable:0, sumProfit:0 };
    if (!s.total) continue;
    const pct  = (s.profitable/s.total*100).toFixed(0);
    const avg  = (s.sumProfit/s.total).toFixed(2);
    const sign = parseFloat(avg)>=0?'+':'';
    const icon = k===0?'\u2705':k<=2?'\u26ab':'\u26aa';
    msg += `${icon} ${k} falsch: ${s.profitable}/${s.total} (${pct}%) | avg ${sign}\u20ac${avg}\n`;
  }
  msg += `Break-even: ${beCount} von ${allocated.length}\n\n`;
  for (const b of allocated) {
    const eSign   = b.edge>=0?'+':'';
    const sq      = b.edge*b.edge;
    const star    = sq>0.01?'\u2605 ':sq>0.001?'\u25cb ':'\u00b7 ';
    const real    = b.hasRealOdds?'':'~';
    const book    = b.bestBookmaker ? ` [${b.bestBookmaker}]` : '';
    const profit  = +(b.bet*(b.odds-1)).toFixed(2);
    const confStr = b.confidence ? ` | Conf: ${(b.confidence*100).toFixed(0)}%` : '';
    const injStr  = (b.pickInjuries > 0 || b.oppInjuries > 0) ? ` | \u{1FA79} ${b.pickInjuries||0}/${b.oppInjuries||0}` : '';
    const rawStr  = b.rawProb && Math.abs(b.rawProb-b.prob) > 0.01 ? ` (roh: ${(b.rawProb*100).toFixed(0)}%)` : '';
    msg += `${star}*${b.pick}* vs ${b.opponent}\n`;
    msg += `_${b.dateLabel}_\n`;
    msg += `AI: ${(b.prob*100).toFixed(0)}%${rawStr} | Buch: ${(1/b.odds*100).toFixed(0)}% | Edge ${eSign}${(b.edge*100).toFixed(1)}%${confStr}${injStr}\n`;
    msg += `Quote: ${real}${b.odds.toFixed(2)}${book} | *\u20ac${b.bet.toFixed(2)}* | +\u20ac${profit}\n\n`;
  }
  return msg.trim();
}

// ── Nachrichten ───────────────────────────────
bot.on('message', async msg => {
  const chatId = msg.chat.id;
  if (!CONFIG.chatId) { CONFIG.chatId = chatId; console.log('Chat-ID:', chatId); }
  const text = (msg.text || '').trim().toLowerCase();

  if (text === '/start' || text === 'start') {
    return send(`*Oddify x Tipico Bot* \u2713\n_${nowStr()}_\nBankroll: \u20ac${CONFIG.bankroll} | Scan alle ${CONFIG.pollMinutes} Min\n\n/hilfe`, chatId);
  }

  if (['/hilfe', 'hilfe', '?', '/help'].includes(text)) {
    return send(
      '*Alle Befehle:*\n\n' +
      '*Uebersicht:*\n' +
      '/wetten — alle Spiele (alle Sportarten)\n' +
      '/heute — nur heutige Spiele\n' +
      '/morgen — nur morgige Spiele\n' +
      '/top3 — Top 3 nach Edge\n' +
      '/top5 — Top 5 nach Edge\n' +
      '/edge — alle Spiele nach Edge sortiert\n\n' +
      '*Sportarten:*\n' +
      '/nba — alle NBA Spiele\n' +
      '/soccer — alle Soccer Spiele\n' +
      '/ufc — alle UFC Kaempfe\n' +
      '/tennis\\_atp — ATP Tennis\n' +
      '/tennis\\_wta — WTA Tennis\n\n' +
      '*Budget-Modus:*\n' +
      '/nba 50 — NBA heute mit \u20ac50 aufteilen\n' +
      '/soccer 30 — Soccer heute mit \u20ac30\n' +
      '/ufc 20 — UFC heute mit \u20ac20\n' +
      '/heute 50 — alle Sportarten mit \u20ac50\n' +
      '/nba 50+ — nur Spiele mit positivem EV\n' +
      '/heute 50+ — alle Sportarten, nur pos. EV\n\n' +
      '*Wetten tracken:*\n' +
      '/gesetzt nba 50 — NBA Wetten mit \u20ac50 speichern\n' +
      '/gesetzt heute 30 — alle heutigen Wetten speichern\n' +
      '/stats — Statistik: Trefferquote, ROI, Gewinn\n\n' +
      '*Einstellungen:*\n' +
      '/bankroll 80 — Bankroll auf \u20ac80 setzen\n' +
      '/tage 5 — Spiele bis zu 5 Tage im Voraus\n' +
      '/scan — sofort neu scannen\n' +
      '/reset — alle Alerts zuruecksetzen\n' +
      '/status — Bot-Status anzeigen\n\n' +
      '*Suche:*\n' +
      'Teamname tippen: z.B. _lakers_ oder _burns_\n\n' +
      '*Automatisch (kein Befehl):*\n' +
      '\u{1F7E2} Live-Alert wenn Tipico online geht\n' +
      '\u26a1 Value-Alert bei Quote \u22651.6 + positivem Edge',
      chatId
    );
  }

  if (['/status', 'status'].includes(text)) {
    const total  = lastBets.reduce((s,b)=>s+b.bet,0);
    const sports = [...new Set(lastBets.map(b=>b.sport))].join(', ') || '-';
    return send(`*Status*\n_${nowStr()}_\nLetzter Scan: ${lastScanTime||'-'}\nSportarten: ${sports}\nSpiele: ${lastBets.length}\nEinsatz: \u20ac${total.toFixed(2)}\nBankroll: \u20ac${CONFIG.bankroll}\nTage voraus: ${CONFIG.daysAhead}`, chatId);
  }

  if (['/wetten', 'wetten', 'alle'].includes(text)) return send(formatBets(lastBets), chatId);

  if (['/heute', 'heute'].includes(text)) {
    const today = new Date().toISOString().split('T')[0];
    return send(formatBets(lastBets.filter(b=>b.gameDate===today), 'Heute'), chatId);
  }

  if (['/morgen', 'morgen'].includes(text)) {
    const tom = new Date(); tom.setDate(tom.getDate()+1);
    return send(formatBets(lastBets.filter(b=>b.gameDate===tom.toISOString().split('T')[0]), 'Morgen'), chatId);
  }

  if (['/scan', 'scan'].includes(text)) {
    send(`_Starte Scan... ${nowStr()}_`, chatId);
    seenGames.clear();
    return runScan(true);
  }

  if (text.startsWith('/top') || text.startsWith('top')) {
    const n = parseInt(text.replace(/\D/g,'')) || 3;
    return send(formatBets([...lastBets].sort((a,b)=>b.edge-a.edge).slice(0,n), `Top ${n} nach Edge`), chatId);
  }

  if (['/edge', 'edge'].includes(text)) {
    return send(formatBets([...lastBets].sort((a,b)=>b.edge-a.edge), 'Nach Edge'), chatId);
  }

  if (['/reset', 'reset'].includes(text)) {
    seenGames.clear(); liveAlerted.clear(); valueAlerted.clear();
    send('_Alle Alerts zurueckgesetzt._', chatId);
    return runScan(true);
  }

  // Budget+ Modus: /nba 50+
  const budgetPlusMatch = text.match(/^\/?(nba|soccer|tennis_atp|tennis_wta|ufc|heute|live)\s+(\d+(?:[.,]\d+)?)\+$/);
  if (budgetPlusMatch) {
    const sportArg  = budgetPlusMatch[1];
    const budget    = parseFloat(budgetPlusMatch[2].replace(',','.'));
    const todayStr3 = new Date().toISOString().split('T')[0];
    let pool = (sportArg==='heute'||sportArg==='live')
      ? lastBets.filter(b=>b.gameDate===todayStr3)
      : lastBets.filter(b=>b.sport===sportArg && b.gameDate===todayStr3);
    if (!pool.length) return send(`_Keine heutigen Spiele fuer ${sportArg.toUpperCase()}._`, chatId);
    pool = [...pool].sort((a,b)=>b.edge-a.edge);
    // Entferne schlechteste Spiele bis EV positiv
    while (pool.length > 1) {
      const testAlloc = buildBudgetAlloc(pool, budget);
      const testA     = analyzeAll(testAlloc);
      if (testA && testA.expProfit >= 0) break;
      pool.pop();
    }
    if (!pool.length || pool.every(b=>b.edge<0)) {
      return send('\u26a0\ufe0f *Kein Spiel mit positivem Erwartungswert heute.*\n_Besser nicht wetten._', chatId);
    }
    const origLen = ((sportArg==='heute'||sportArg==='live')
      ? lastBets.filter(b=>b.gameDate===todayStr3)
      : lastBets.filter(b=>b.sport===sportArg&&b.gameDate===todayStr3)).length;
    const removed   = origLen - pool.length;
    const allocated = buildBudgetAlloc(pool, budget);
    return send(formatBudgetMsg(sportArg, budget, allocated, `+ (${removed} gefiltert)`), chatId);
  }

  // Budget Modus: /nba 50
  const budgetMatch = text.match(/^\/?(nba|soccer|tennis_atp|tennis_wta|ufc|heute|live)\s+(\d+(?:[.,]\d+)?)$/);
  if (budgetMatch) {
    const sportArg  = budgetMatch[1];
    const budget    = parseFloat(budgetMatch[2].replace(',','.'));
    const todayStr2 = new Date().toISOString().split('T')[0];
    const pool = (sportArg==='heute'||sportArg==='live')
      ? lastBets.filter(b=>b.gameDate===todayStr2)
      : lastBets.filter(b=>b.sport===sportArg && b.gameDate===todayStr2);
    if (!pool.length) return send(`_Keine heutigen Spiele fuer ${sportArg.toUpperCase()} gefunden._`, chatId);

    // Warnungen
    const allNegEdge    = pool.every(b=>b.edge<0);
    const highInjGames  = pool.filter(b=>(b.pickInjuries||0) > 5);
    if (allNegEdge || highInjGames.length > 0) {
      let warn = '\u26a0\ufe0f *Achtung: Schlechte Wettbedingungen!*\n\n';
      if (allNegEdge) {
        const bestEdge  = Math.max(...pool.map(b=>b.edge));
        const worstEdge = Math.min(...pool.map(b=>b.edge));
        warn += `\u274c *Kein Spiel hat positiven Edge*\nBester: ${(bestEdge*100).toFixed(1)}% | Schlechtester: ${(worstEdge*100).toFixed(1)}%\n\n`;
      }
      if (highInjGames.length > 0) {
        warn += '\u{1FA79} *Hohe Verletzungsausfaelle:*\n';
        highInjGames.forEach(b => { warn += `\u2022 ${b.pick} vs ${b.opponent}: ${b.pickInjuries} Ausfaelle\n`; });
        warn += '\n';
      }
      warn += `_Empfehlung: Nutze */${sportArg} ${budget}+* fuer positiven EV._`;
      return send(warn, chatId);
    }

    const allocated = buildBudgetAlloc(pool, budget);
    return send(formatBudgetMsg(sportArg, budget, allocated, ''), chatId);
  }

  // /gesetzt nba 50
  const gesetzMatch = text.match(/^\/?(gesetzt|placed)\s+(nba|soccer|tennis_atp|tennis_wta|ufc|heute)\s+(\d+(?:[.,]\d+)?)$/);
  if (gesetzMatch) {
    const sportArg = gesetzMatch[2];
    const budget   = parseFloat(gesetzMatch[3].replace(',','.'));
    const todayStr = new Date().toISOString().split('T')[0];
    const pool = sportArg==='heute'
      ? lastBets.filter(b=>b.gameDate===todayStr)
      : lastBets.filter(b=>b.sport===sportArg && b.gameDate===todayStr);
    if (!pool.length) return send('_Keine Spiele gefunden. Erst /scan._', chatId);
    const allocated = buildBudgetAlloc(pool, budget);
    const bets = allocated.map(b => ({
      sport: b.sport, game: b.game, pick: b.pick, opponent: b.opponent,
      odds: b.odds, bet: b.bet, result: null, profit: null, date: todayStr,
    }));
    activeBets.push(...bets);
    let msg = `*Wetten gespeichert!* \u{1F4BE}\n_${nowStr()}_\n\nErgebnisse werden automatisch gecheckt.\n\n`;
    bets.forEach(b => { msg += `\u2022 *${b.pick}* vs ${b.opponent} | \u20ac${b.bet.toFixed(2)}\n`; });
    msg += `\nBankroll: *\u20ac${trackBankroll.toFixed(2)}*`;
    return send(msg, chatId);
  }

  // /stats
  if (['/stats', 'stats'].includes(text)) {
    if (!betHistory.length && !activeBets.length) return send('_Noch keine Wetten getrackt. Nutze /gesetzt nba 50._', chatId);
    const done   = betHistory.filter(b=>b.result!==null);
    const wins   = done.filter(b=>b.result==='win').length;
    const losses = done.filter(b=>b.result==='loss').length;
    const totPro = done.reduce((s,b)=>s+(b.profit||0),0);
    const totBet = done.reduce((s,b)=>s+b.bet,0);
    const roi    = totBet>0 ? totPro/totBet*100 : 0;
    let msg = `*Statistik*\n_${nowStr()}_\n\nWetten: ${done.length} | \u2705 ${wins} | \u274c ${losses}\n`;
    msg += `Trefferquote: *${done.length>0?(wins/done.length*100).toFixed(1):0}%*\n`;
    msg += `Profit: *${totPro>=0?'+':''}\u20ac${totPro.toFixed(2)}*\n`;
    msg += `ROI: *${roi>=0?'+':''}${roi.toFixed(1)}%*\n`;
    msg += `Bankroll: *\u20ac${trackBankroll.toFixed(2)}*`;
    if (activeBets.length) msg += `\nOffen: ${activeBets.length} Wetten`;
    return send(msg, chatId);
  }

  // Sportart
  const sportKey = CONFIG.sports.find(s => text===`/${s}` || text===s);
  if (sportKey) return send(formatBets(lastBets.filter(b=>b.sport===sportKey), sportKey.toUpperCase()), chatId);

  // Bankroll
  if (text.includes('bankroll')) {
    const num = parseFloat(text.replace(/[^\d.]/g,''));
    if (num>0) { CONFIG.bankroll=num; trackBankroll=num; return send(`Bankroll: *\u20ac${num.toFixed(2)}*`, chatId); }
    return send('Beispiel: /bankroll 80', chatId);
  }

  // Tage voraus
  if (text.startsWith('/tage') || text.startsWith('tage')) {
    const num = parseInt(text.replace(/\D/g,''));
    if (num>0 && num<=14) { CONFIG.daysAhead=num; return send(`${num} Tage voraus.`, chatId); }
    return send('Beispiel: /tage 5', chatId);
  }

  // Team-Suche
  const match = lastBets.find(b =>
    b.game.toLowerCase().includes(text) ||
    b.pick.toLowerCase().includes(text) ||
    b.opponent.toLowerCase().includes(text)
  );
  if (match) {
    const eSign  = match.edge>=0?'+':'';
    const label  = match.edge>0.05?'\u2605 Oddify schlaegt Buch':match.edge>0?'\u25cb Leichter Edge':'\u00b7 Kein Edge';
    const oLabel = match.hasRealOdds?'Quote':'Gesch. Quote';
    const book   = match.bestBookmaker ? ` [${match.bestBookmaker}]` : '';
    return send(
      `*${match.game}*\n_${match.dateLabel}_\n${match.league}\n\nPick: *${match.pick}*\n` +
      `AI: ${(match.prob*100).toFixed(0)}% | Gegner: ${(match.oppProb*100).toFixed(0)}%\n` +
      `${oLabel}: ${match.odds.toFixed(2)}${book}\n${label}\n` +
      `Edge: ${eSign}${(match.edge*100).toFixed(1)}% | EV: ${match.ev>=0?'+':''}${match.ev.toFixed(1)}%\n\n` +
      `*Empfehlung: \u20ac${match.bet.toFixed(2)}*\n_(von \u20ac${match.sportBudget?.toFixed(0)||'?'} ${match.sport.toUpperCase()}-Budget)_`,
      chatId
    );
  }

  send('Nicht verstanden. /hilfe', chatId);
});

// ── Scheduler & Start ────────────────────────
const rule = new schedule.RecurrenceRule();
rule.minute = new schedule.Range(0, 59, CONFIG.pollMinutes);
schedule.scheduleJob(rule, () => runScan(true));

const ruleResults = new schedule.RecurrenceRule();
ruleResults.minute = new schedule.Range(0, 59, 30);
schedule.scheduleJob(ruleResults, () => checkBetResults());

console.log(`Telegram Bot startet... ${nowStr()}`);
console.log('Bot: t.me/bet_2_bet_bot');
setTimeout(() => runScan(true), 2000);