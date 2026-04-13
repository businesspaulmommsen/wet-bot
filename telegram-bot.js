/**
 * Oddify x Tipico - Telegram Bot
 * npm install node-telegram-bot-api axios node-schedule
 * node telegram-bot.js
 */

const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const schedule    = require('node-schedule');

const CONFIG = {
  telegramToken:  '8686433824:AAFiiaXYy2_HLcTobd-gLSRMw3gsQdQ52Q0',
  chatId:         null,
  oddifyApiUrl:   'https://fouddhhpuyrxugfhuqmq.supabase.co/functions/v1/get-predictions',
  oddifyAuthUrl:  'https://fouddhhpuyrxugfhuqmq.supabase.co/auth/v1/token?grant_type=password',
  oddifyApiKey:   'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZvdWRkaGhwdXlyeHVnZmh1cW1xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY5MjA3ODcsImV4cCI6MjA3MjQ5Njc4N30.WVnGOt-nuubcVQLDskLqZSrcezK4OkbUFOUOLXWbqv4',
  oddifyEmail:    'paul2004mm@gmail.com',
  oddifyPassword: process.env.ODDIFY_PASSWORD || '',
  oddifyToken:    null,
  oddifyTokenExp: 0,
  bankroll:       50,
  maxSportPct:    0.60,
  minProbability: 0.55,
  kellyFraction:  0.5,
  pollMinutes:    5,
  daysAhead:      3,
  sports: ['nba', 'soccer', 'tennis_atp', 'tennis_wta', 'ufc'],
};

// ESPN Turnier-Cache
const espnTournaments = {};

// UFC beste Quoten Cache
const ufcBestOdds = {};

async function fetchEspnTournaments() {
  const map = { tennis_atp: 'atp', tennis_wta: 'wta' };
  for (const [sport, league] of Object.entries(map)) {
    try {
      const r = await axios.get(
        'https://site.api.espn.com/apis/site/v2/sports/tennis/' + league + '/scoreboard',
        { timeout: 6000 }
      );
      const events = r.data && r.data.events ? r.data.events : [];
      const today  = new Date().toISOString().split('T')[0];
      const current = events.find(function(e) {
        const start = e.date ? e.date.slice(0,10) : '';
        const end   = e.endDate ? e.endDate.slice(0,10) : '';
        return start <= today && end >= today;
      }) || events[0];
      if (current) {
        espnTournaments[sport] = {
          name:    current.name || current.shortName || sport,
          dateStr: (current.date || today).slice(0,10),
          endStr:  (current.endDate || today).slice(0,10),
        };
        console.log('  ESPN ' + sport + ': ' + espnTournaments[sport].name);
      }
    } catch(e) {
      console.log('  ESPN ' + sport + ': nicht erreichbar');
    }
  }
}

async function fetchUfcBestOdds() {
  if (!await ensureOddifyToken()) return;
  try {
    const r = await axios.get(
      'https://fouddhhpuyrxugfhuqmq.supabase.co/rest/v1/odds_history?limit=1000&order=changed_at.desc',
      { headers: { apikey: CONFIG.oddifyApiKey, Authorization: 'Bearer ' + CONFIG.oddifyToken }, timeout: 8000 }
    );
    const data = r.data || [];
    data.forEach(function(o) {
      const key = o.fight_key;
      const sel = o.selection;
      if (!ufcBestOdds[key]) ufcBestOdds[key] = {};
      if (!ufcBestOdds[key][sel] || o.price_decimal > ufcBestOdds[key][sel].price) {
        ufcBestOdds[key][sel] = { price: o.price_decimal, bookmaker: o.bookmaker };
      }
    });
    console.log('  UFC odds_history: ' + Object.keys(ufcBestOdds).length + ' Kaempfe geladen');
  } catch(e) {
    console.log('  UFC odds_history Fehler:', e.message);
  }
}

const bot = new TelegramBot(CONFIG.telegramToken, { polling: true });

function send(text, chatId) {
  const id = chatId || CONFIG.chatId;
  if (!id) return Promise.resolve();
  const chunks = [];
  for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900));
  return chunks.reduce(function(p, chunk) {
    return p.then(function() {
      return bot.sendMessage(id, chunk, { parse_mode: 'Markdown' })
        .catch(function() { return bot.sendMessage(id, chunk.replace(/[*_`]/g, ''), {}).catch(function() {}); });
    });
  }, Promise.resolve());
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
  } catch(e) { return dateStr; }
}

function toLocalDate(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('de-DE', {
      year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Europe/Berlin'
    }).split('.').reverse().join('-');
  } catch(e) { return new Date().toISOString().split('T')[0]; }
}

function estimateOdds(prob) {
  return +Math.max(1.05, 1 / (Math.max(prob, 0.01) * 0.95)).toFixed(2);
}

async function ensureOddifyToken() {
  const now = Math.floor(Date.now() / 1000);
  if (CONFIG.oddifyToken && CONFIG.oddifyTokenExp > now + 60) return true;
  try {
    const res = await axios.post(CONFIG.oddifyAuthUrl,
      { email: CONFIG.oddifyEmail, password: CONFIG.oddifyPassword },
      { headers: { apikey: CONFIG.oddifyApiKey, 'Content-Type': 'application/json' } }
    );
    CONFIG.oddifyToken    = res.data.access_token;
    CONFIG.oddifyTokenExp = now + (res.data.expires_in || 3600);
    console.log('Oddify Login OK');
    return true;
  } catch(e) {
    console.error('Oddify Login Fehler:', e.response && e.response.status, e.response && e.response.data && e.response.data.message || e.message);
    return false;
  }
}

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
      sport: sport, pick: pick, opponent: opponent,
      prob: finalProb, rawProb: prob, oppProb: oppProb, odds: odds,
      confidence: confidence, pickInjuries: pickInjuries, oppInjuries: oppInjuries,
      hasRealOdds: !!(realOdds && realOdds > 1),
      game:      g.event_name || (g.team_a_name + ' vs ' + g.team_b_name),
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
    const fightKey  = g.fight_key || '';
    const ufcOdds   = ufcBestOdds[fightKey] || {};
    const selection = aWins ? 'blue' : 'red';
    const bestOdds  = ufcOdds[selection];
    const odds      = bestOdds ? bestOdds.price : estimateOdds(finalProb);
    return {
      sport: sport, pick: pick, opponent: oppon,
      prob: finalProb, rawProb: prob, oppProb: oppP, odds: odds,
      confidence: confidence, hasRealOdds: !!bestOdds,
      bestBookmaker: bestOdds ? bestOdds.bookmaker : null,
      fightKey: fightKey,
      game:      g.fighter_a_name + ' vs ' + g.fighter_b_name,
      gameDate:  todayStr,
      dateLabel: 'UFC | ' + todayStr,
      sortKey:   g.updated_at || todayStr,
      isToday:   true,
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
      sport: sport, pick: pick, opponent: opponent, prob: prob, oppProb: oppProb,
      odds: estimateOdds(prob), hasRealOdds: false,
      game:      g.home_team + ' vs ' + g.away_team,
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
    const gameDate   = tournInfo.dateStr || todayStr;
    const endDate    = tournInfo.endStr  || todayStr;
    const tournament = g.tournament || tournInfo.name || sport.toUpperCase();
    const round      = g.round ? ' | ' + g.round : '';
    const surface    = g.surface ? ' | ' + g.surface : '';
    return {
      sport: sport, pick: pick, opponent: oppon, prob: prob, oppProb: oppP,
      odds: estimateOdds(prob), hasRealOdds: false,
      game:      g.p1_name + ' vs ' + g.p2_name,
      gameDate:  gameDate,
      dateLabel: tournament + round + surface + ' (bis ' + endDate + ')',
      sortKey:   gameDate + g.p1_name,
      isToday:   gameDate === todayStr,
      league:    tournament,
    };
  }

  return null;
}

async function fetchPredictions(sport) {
  if (!await ensureOddifyToken()) return [];
  try {
    const res = await axios.post(
      CONFIG.oddifyApiUrl, { sport: sport },
      {
        headers: {
          apikey: CONFIG.oddifyApiKey,
          Authorization: 'Bearer ' + CONFIG.oddifyToken,
          'Content-Type': 'application/json',
          Origin: 'https://oddify.ai',
        },
        timeout: 12000,
      }
    );
    const items = Array.isArray(res.data) ? res.data : [];
    const result = items.map(function(g) { return parseGame(g, sport); }).filter(Boolean);
    result.sort(function(a, b) { return a.sortKey.localeCompare(b.sortKey); });
    return result;
  } catch(e) {
    if (e.response && e.response.status === 401) CONFIG.oddifyToken = null;
    console.error('Oddify ' + sport + ' Fehler:', e.response && e.response.status || e.message);
    return [];
  }
}

function halfKelly(p, odds) {
  const b = odds - 1, q = 1 - p;
  return Math.max(0, (p * b - q) / b * CONFIG.kellyFraction);
}
function calcEV(p, odds)   { return (p * odds - 1) * 100; }
function calcEdge(p, odds) { return p - 1 / odds; }

function allocateBets(predictions) {
  const bySport = {};
  predictions.forEach(function(p) {
    if (!bySport[p.sport]) bySport[p.sport] = [];
    bySport[p.sport].push(p);
  });
  const n           = Object.keys(bySport).length;
  const sportBudget = Math.min(CONFIG.bankroll / Math.max(n, 1), CONFIG.bankroll * CONFIG.maxSportPct);
  const result      = [];
  for (const sport in bySport) {
    const games   = bySport[sport];
    const enriched = games.map(function(g) {
      return Object.assign({}, g, {
        edge: calcEdge(g.prob, g.odds),
        ev:   calcEV(g.prob, g.odds),
        hk:   halfKelly(g.prob, g.odds),
      });
    });
    const posEdges  = enriched.map(function(g) { return Math.max(0, g.edge); });
    const totalEdge = posEdges.reduce(function(a, b) { return a + b; }, 0);
    const cnt       = enriched.length;
    enriched.forEach(function(g, i) {
      const equalPart = sportBudget * 0.40 / cnt;
      const edgePart  = totalEdge > 0 ? sportBudget * 0.60 * posEdges[i] / totalEdge : 0;
      const kellyCap  = g.hk * sportBudget;
      const raw       = equalPart + edgePart;
      const bet       = +(Math.min(raw, kellyCap > 0 ? kellyCap : raw)).toFixed(2);
      result.push(Object.assign({}, g, {
        sport: sport,
        bet: bet,
        sportBudget: +sportBudget.toFixed(2),
        hk: +g.hk.toFixed(4),
      }));
    });
  }
  result.sort(function(a, b) { return a.sortKey.localeCompare(b.sortKey); });
  return result;
}

let lastBets      = [];
let lastScanTime  = null;
let seenGames     = new Set();
let liveAlerted   = new Set();
let valueAlerted  = new Set();
let activeBets    = [];
let betHistory    = [];
let trackBankroll = CONFIG.bankroll;

const VALUE_MIN_ODDS     = 1.6;
const VALUE_MIN_EDGE     = 0.03;
const VALUE_MIN_BOOK_FAV = 0.55;

async function fetchESPNResults(sport) {
  try {
    var url;
    if (sport === 'nba') {
      url = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
    } else if (sport === 'soccer') {
      url = 'https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard';
    } else {
      url = 'https://site.api.espn.com/apis/site/v2/sports/tennis/' + sport + '/scoreboard';
    }
    const r = await axios.get(url, { timeout: 8000 });
    const events = r.data && r.data.events ? r.data.events : [];
    const results = [];
    events.forEach(function(ev) {
      const comps = ev.competitions || [];
      comps.forEach(function(comp) {
        if (!comp.competitors) return;
        if (!comp.status || !comp.status.type || !comp.status.type.completed) return;
        const winner = comp.competitors.find(function(c) { return c.winner; });
        const loser  = comp.competitors.find(function(c) { return !c.winner; });
        if (winner) {
          results.push({
            game:   ev.name || ev.shortName,
            winner: (winner.team && (winner.team.displayName || winner.team.name)) || '',
            loser:  (loser && loser.team && (loser.team.displayName || loser.team.name)) || '',
          });
        }
      });
    });
    return results;
  } catch(e) { return []; }
}

async function checkBetResults() {
  if (!activeBets.length) return;
  const sports = [];
  activeBets.forEach(function(b) { if (sports.indexOf(b.sport) === -1) sports.push(b.sport); });
  let settled = 0, totalProfit = 0;
  const msgs = [];
  for (let si = 0; si < sports.length; si++) {
    const sport   = sports[si];
    const results = await fetchESPNResults(sport);
    if (!results.length) continue;
    activeBets.filter(function(b) { return b.sport === sport && b.result === null; }).forEach(function(bet) {
      const res = results.find(function(r) {
        return r.winner.toLowerCase().indexOf(bet.pick.toLowerCase()) >= 0 ||
               r.loser.toLowerCase().indexOf(bet.pick.toLowerCase()) >= 0;
      });
      if (!res) return;
      const won   = res.winner.toLowerCase().indexOf(bet.pick.toLowerCase()) >= 0;
      bet.result  = won ? 'win' : 'loss';
      bet.profit  = won ? +(bet.bet * (bet.odds - 1)).toFixed(2) : -bet.bet;
      trackBankroll = +(trackBankroll + bet.profit).toFixed(2);
      totalProfit  += bet.profit;
      settled++;
      const icon = won ? '\u2705' : '\u274c';
      msgs.push(icon + ' *' + bet.pick + '* vs ' + bet.opponent + ' [' + sport.toUpperCase() + ']\n' +
        (won ? 'Gewonnen' : 'Verloren') + ' | Quote ' + bet.odds + ' | ' +
        (won ? '+' : '') + '\u20ac' + bet.profit.toFixed(2));
    });
  }
  const done = activeBets.filter(function(b) { return b.result !== null; });
  betHistory = betHistory.concat(done);
  activeBets = activeBets.filter(function(b) { return b.result === null; });
  if (settled > 0 && CONFIG.chatId) {
    const sign = totalProfit >= 0 ? '+' : '';
    let msg = '*Wett-Ergebnisse*\n_' + nowStr() + '_\n\n';
    msg += msgs.join('\n\n') + '\n\n';
    msg += 'Netto: *' + sign + '\u20ac' + totalProfit.toFixed(2) + '*\n';
    msg += 'Bankroll: *\u20ac' + trackBankroll.toFixed(2) + '*';
    await send(msg);
  }
}

async function runScan(notify) {
  console.log('=== Scan ' + nowStr() + ' ===');
  const allPreds = [];
  await fetchEspnTournaments();
  await fetchUfcBestOdds();
  for (let i = 0; i < CONFIG.sports.length; i++) {
    const sport = CONFIG.sports[i];
    const preds = await fetchPredictions(sport);
    console.log('  ' + sport + ': ' + preds.length + ' Spiele');
    preds.forEach(function(p) { allPreds.push(p); });
  }
  if (!allPreds.length) { console.log('Keine Prognosen.'); return; }
  lastBets     = allocateBets(allPreds);
  lastScanTime = nowStr();
  const newBets = lastBets.filter(function(b) {
    const key = b.sport + ':' + b.game + ':' + b.pick;
    if (seenGames.has(key)) return false;
    seenGames.add(key);
    return true;
  });
  if (newBets.length && notify) await sendAlert(newBets);

  if (notify) {
    const sportMap = {};
    lastBets.forEach(function(b) {
      if (!sportMap[b.sport]) sportMap[b.sport] = { total: 0, real: 0 };
      sportMap[b.sport].total++;
      if (b.hasRealOdds) sportMap[b.sport].real++;
    });
    const today0 = new Date().toISOString().split('T')[0];
    for (const sport in sportMap) {
      const info = sportMap[sport];
      const lk   = sport + ':' + today0;
      if (info.real > 0 && !liveAlerted.has(lk)) {
        liveAlerted.add(lk);
        const pct = Math.round(info.real / info.total * 100);
        await send('\u{1F7E2} *' + sport.toUpperCase() + ' ist jetzt live!*\n' +
          'Oddify + Quoten online (' + info.real + '/' + info.total + ' Spiele, ' + pct + '% echt)\n\n' +
          '_Schreib /' + sport + ' oder /' + sport + ' 50 fuer Empfehlungen_');
      }
    }
    const todayV = new Date().toISOString().split('T')[0];
    lastBets.forEach(async function(b) {
      if (b.hasRealOdds && b.odds >= VALUE_MIN_ODDS && b.edge >= VALUE_MIN_EDGE &&
          (1 / b.odds) >= VALUE_MIN_BOOK_FAV && b.gameDate === todayV) {
        const vk = 'value:' + b.game + ':' + b.pick;
        if (!valueAlerted.has(vk)) {
          valueAlerted.add(vk);
          const eSign = b.edge >= 0 ? '+' : '';
          await send('\u26a1 *VALUE ALERT ' + b.sport.toUpperCase() + '*\n\n' +
            '*' + b.pick + '* vs ' + b.opponent + '\n_' + b.dateLabel + '_\n\n' +
            'Buch: ' + (1/b.odds*100).toFixed(0) + '% | AI: ' + (b.prob*100).toFixed(0) + '%\n' +
            'Edge: ' + eSign + (b.edge*100).toFixed(1) + '%\n' +
            '*Quote: ' + b.odds.toFixed(2) + '* \u2b50\n\n' +
            '_/' + b.sport + ' 50 fuer volle Aufteilung_');
        }
      }
    });
  }
  console.log('=== Fertig | ' + lastBets.length + ' gesamt | ' + newBets.length + ' neu ===');
}

async function sendAlert(bets) {
  bets = bets.filter(function(b) { return b.edge > 0; });
  if (!bets.length) return;
  const total = bets.reduce(function(s, b) { return s + b.bet; }, 0);
  let msg = '*ODDIFY x TIPICO*\n_' + nowStr() + '_\n' + bets.length + ' neue Spiele | *\u20ac' + total.toFixed(2) + '*\n\n';
  let lastDate = '';
  bets.forEach(function(b) {
    if (b.gameDate !== lastDate) { msg += '`--- ' + b.gameDate + ' ---`\n'; lastDate = b.gameDate; }
    const eSign = b.edge >= 0 ? '+' : '';
    const star  = b.edge > 0.05 ? '\u2605' : '\u25cb';
    const real  = b.hasRealOdds ? '' : '~';
    const book  = b.bestBookmaker ? ' [' + b.bestBookmaker + ']' : '';
    msg += star + ' *' + b.pick + '* vs ' + b.opponent + '\n';
    msg += '_' + b.dateLabel + '_ | ' + b.league + '\n';
    msg += b.prob && (b.prob*100).toFixed(0) + '% | ' + real + b.odds.toFixed(2) + book + ' | Edge ' + eSign + (b.edge*100).toFixed(1) + '% | *\u20ac' + b.bet.toFixed(2) + '*\n\n';
  });
  await send(msg.trim());
}

function formatBets(bets, title) {
  if (!bets.length) return 'Keine Spiele gefunden.';
  const total = bets.reduce(function(s, b) { return s + b.bet; }, 0);
  let out = '*' + (title || 'Spiele') + '*\n_' + nowStr() + '_\n' + bets.length + ' Spiele | *\u20ac' + total.toFixed(2) + '*\n\n';
  let lastDate = '';
  bets.forEach(function(b) {
    if (b.gameDate !== lastDate) { out += '`--- ' + b.gameDate + ' ---`\n'; lastDate = b.gameDate; }
    const e    = b.edge >= 0 ? ('+' + (b.edge*100).toFixed(1) + '%') : ((b.edge*100).toFixed(1) + '%');
    const star = b.edge > 0.05 ? '\u2605 ' : b.edge > 0 ? '\u25cb ' : '';
    const real = b.hasRealOdds ? '' : '~';
    const book = b.bestBookmaker ? ' [' + b.bestBookmaker + ']' : '';
    out += star + '*' + b.pick + '* vs ' + b.opponent + '\n';
    out += '_' + b.dateLabel + '_ | ' + b.league + ' | ' + real + b.odds.toFixed(2) + book + ' | ' + e + ' | *\u20ac' + b.bet.toFixed(2) + '*\n\n';
  });
  return out.trim();
}

function analyzeAll(bets) {
  const n     = bets.length;
  const total = bets.reduce(function(s, b) { return s + b.bet; }, 0);
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
  return { probProfit: probProfit, expProfit: expProfit, byWrong: byWrong };
}

function buildBudgetAlloc(pool, budget) {
  const posEdges    = pool.map(function(b) { return Math.max(0, b.edge); });
  const cnt         = pool.length;
  const edgeSq      = posEdges.map(function(e) { return e * e; });
  const totalEdgeSq = edgeSq.reduce(function(a, b) { return a + b; }, 0);
  let allocated = pool.map(function(b, i) {
    const equalPart = budget * 0.20 / cnt;
    const edgePart  = totalEdgeSq > 0 ? budget * 0.80 * edgeSq[i] / totalEdgeSq : budget * 0.80 / cnt;
    const kellyCap  = b.hk * budget;
    const raw       = equalPart + edgePart;
    return Object.assign({}, b, { bet: Math.max(0.01, Math.min(raw, kellyCap > 0 ? kellyCap : raw)) });
  });
  let scaleT = allocated.reduce(function(s, b) { return s + b.bet; }, 0);
  if (scaleT > budget) {
    const sc = budget / scaleT;
    allocated = allocated.map(function(b) { return Object.assign({}, b, { bet: b.bet * sc }); });
  }
  let bestA = analyzeAll(allocated), bestScore = bestA ? bestA.probProfit : 0;
  for (let iter = 0; iter < 400; iter++) {
    const byEdge = allocated.slice().sort(function(a, b2) { return (b2.edge*b2.edge) - (a.edge*a.edge); });
    const best   = byEdge[0];
    const worst  = byEdge[byEdge.length - 1];
    if (best.game === worst.game && best.pick === worst.pick) break;
    const shift = Math.max(0.01, Math.min(worst.bet * 0.04, 0.30));
    if (shift < 0.005) break;
    const candidate = allocated.map(function(b) {
      if (b.game === worst.game && b.pick === worst.pick) return Object.assign({}, b, { bet: Math.max(0.01, b.bet - shift) });
      if (b.game === best.game  && b.pick === best.pick)  return Object.assign({}, b, { bet: b.bet + shift });
      return b;
    });
    const candA = analyzeAll(candidate);
    if (!candA) break;
    if (candA.probProfit > bestScore || (Math.abs(candA.probProfit - bestScore) < 0.001 && candA.expProfit > bestA.expProfit)) {
      allocated = candidate; bestScore = candA.probProfit; bestA = candA;
    }
  }
  return allocated.map(function(b) {
    return Object.assign({}, b, { bet: +Math.max(0.01, b.bet).toFixed(2), gain: +(b.bet*(b.odds-1)).toFixed(2) });
  }).sort(function(a, b2) { return (b2.edge*b2.edge) - (a.edge*a.edge); });
}

function formatBudgetMsg(sportArg, budget, allocated, suffix) {
  const total     = +(allocated.reduce(function(s,b){return s+b.bet;},0)).toFixed(2);
  const totalGain = +(allocated.reduce(function(s,b){return s+b.gain;},0)).toFixed(2);
  const finalA    = analyzeAll(allocated);
  const expProfit = finalA ? +finalA.expProfit.toFixed(2) : 0;
  const probWin   = finalA ? (finalA.probProfit * 100).toFixed(1) : '?';
  const bw        = finalA ? finalA.byWrong : {};
  const sgain     = allocated.slice().sort(function(a,b2){return b2.gain-a.gain;});
  let beCount = 0, runBE = -total;
  sgain.forEach(function(b){ if(runBE<0){runBE+=b.gain+b.bet;beCount++;} });

  let msg = '*' + sportArg.toUpperCase() + ' heute' + (suffix||'') + ' | Budget: \u20ac' + budget.toFixed(2) + '*\n';
  msg += '_' + nowStr() + ' | ' + allocated.length + ' Spiele | Einsatz: \u20ac' + total + '_\n\n';
  msg += '*Gewinn-Szenarien:*\n';
  msg += 'Wahrsch. im Plus: *' + probWin + '%*\n';
  msg += 'Erw. Gewinn: *' + (expProfit>=0?'+':'') + '\u20ac' + expProfit + '*\n';
  msg += 'Alle richtig: +\u20ac' + totalGain + '\n';
  const maxW = Math.min(5, allocated.length);
  for (let k = 0; k <= maxW; k++) {
    const s = bw[k] || { total:0, profitable:0, sumProfit:0 };
    if (!s.total) continue;
    const pct  = (s.profitable/s.total*100).toFixed(0);
    const avg  = (s.sumProfit/s.total).toFixed(2);
    const sign = parseFloat(avg)>=0?'+':'';
    const icon = k===0?'\u2705':k<=2?'\u26ab':'\u26aa';
    msg += icon + ' ' + k + ' falsch: ' + s.profitable + '/' + s.total + ' (' + pct + '%) | avg ' + sign + '\u20ac' + avg + '\n';
  }
  msg += 'Break-even: ' + beCount + ' von ' + allocated.length + '\n\n';
  allocated.forEach(function(b) {
    const eSign = b.edge>=0?'+':'';
    const sq    = b.edge*b.edge;
    const star  = sq>0.01?'\u2605 ':sq>0.001?'\u25cb ':'\u00b7 ';
    const real  = b.hasRealOdds?'':'~';
    const book  = b.bestBookmaker ? ' [' + b.bestBookmaker + ']' : '';
    const profit = +(b.bet*(b.odds-1)).toFixed(2);
    const confStr = b.confidence ? ' | Conf: ' + (b.confidence*100).toFixed(0) + '%' : '';
    const injStr  = (b.pickInjuries > 0 || b.oppInjuries > 0) ? ' | \u{1FA79} ' + (b.pickInjuries||0) + '/' + (b.oppInjuries||0) : '';
    msg += star + '*' + b.pick + '* vs ' + b.opponent + '\n';
    msg += '_' + b.dateLabel + '_\n';
    msg += 'AI: ' + (b.prob*100).toFixed(0) + '% | Buch: ' + (1/b.odds*100).toFixed(0) + '% | Edge ' + eSign + (b.edge*100).toFixed(1) + '%' + confStr + injStr + '\n';
    msg += 'Quote: ' + real + b.odds.toFixed(2) + book + ' | *\u20ac' + b.bet.toFixed(2) + '* | +\u20ac' + profit + '\n\n';
  });
  return msg.trim();
}

bot.on('message', async function(msg) {
  const chatId = msg.chat.id;
  if (!CONFIG.chatId) { CONFIG.chatId = chatId; console.log('Chat-ID:', chatId); }
  const text = (msg.text || '').trim().toLowerCase();

  if (text === '/start' || text === 'start') {
    return send('*Oddify x Tipico Bot* \u2713\n_' + nowStr() + '_\nBankroll: \u20ac' + CONFIG.bankroll + ' | Scan alle ' + CONFIG.pollMinutes + ' Min\n\n/hilfe', chatId);
  }

  if (['/hilfe', 'hilfe', '?', '/help'].indexOf(text) >= 0) {
    return send('*Befehle:*\n\n*Anzeige:*\n/wetten /heute /morgen\n/top3 /edge\n/nba /soccer /ufc /tennis\\_atp\n\n*Budget:*\n/nba 50 - alle NBA Spiele\n/nba 50+ - nur pos. EV\n/heute 30 - alle Sportarten\n\n*Tracking:*\n/gesetzt nba 50\n/stats\n\n*Steuerung:*\n/scan /reset /status\n/bankroll 80 /tage 5\n\nTeamname tippen: z.B. _lakers_', chatId);
  }

  if (['/status', 'status'].indexOf(text) >= 0) {
    const total  = lastBets.reduce(function(s,b){return s+b.bet;},0);
    const sports = lastBets.map(function(b){return b.sport;}).filter(function(v,i,a){return a.indexOf(v)===i;}).join(', ') || '-';
    return send('*Status*\n_' + nowStr() + '_\nLetzter Scan: ' + (lastScanTime||'-') + '\nSportarten: ' + sports + '\nSpiele: ' + lastBets.length + '\nEinsatz: \u20ac' + total.toFixed(2) + '\nBankroll: \u20ac' + CONFIG.bankroll, chatId);
  }

  if (['/wetten', 'wetten', 'alle'].indexOf(text) >= 0) return send(formatBets(lastBets), chatId);

  if (['/heute', 'heute'].indexOf(text) >= 0) {
    const today = new Date().toISOString().split('T')[0];
    return send(formatBets(lastBets.filter(function(b){return b.gameDate===today;}), 'Heute'), chatId);
  }

  if (['/morgen', 'morgen'].indexOf(text) >= 0) {
    const tom = new Date(); tom.setDate(tom.getDate() + 1);
    const tomStr = tom.toISOString().split('T')[0];
    return send(formatBets(lastBets.filter(function(b){return b.gameDate===tomStr;}), 'Morgen'), chatId);
  }

  if (['/scan', 'scan'].indexOf(text) >= 0) {
    send('_Starte Scan... ' + nowStr() + '_', chatId);
    seenGames.clear();
    return runScan(true);
  }

  if (text.indexOf('/top') === 0 || text.indexOf('top') === 0) {
    const n = parseInt(text.replace(/\D/g, '')) || 3;
    const top = lastBets.slice().sort(function(a,b){return b.edge-a.edge;}).slice(0,n);
    return send(formatBets(top, 'Top ' + n + ' nach Edge'), chatId);
  }

  if (['/edge', 'edge'].indexOf(text) >= 0) {
    return send(formatBets(lastBets.slice().sort(function(a,b){return b.edge-a.edge;}), 'Nach Edge'), chatId);
  }

  if (['/reset', 'reset'].indexOf(text) >= 0) {
    seenGames.clear(); liveAlerted.clear(); valueAlerted.clear();
    send('_Alle Alerts zurueckgesetzt._', chatId);
    return runScan(true);
  }

  // Budget+ Modus: /nba 50+
  const budgetPlusMatch = text.match(/^\/?(nba|soccer|tennis_atp|tennis_wta|ufc|heute|live)\s+(\d+([.,]\d+)?)\+$/);
  if (budgetPlusMatch) {
    const sportArg  = budgetPlusMatch[1];
    const budget    = parseFloat(budgetPlusMatch[2].replace(',', '.'));
    const todayStr3 = new Date().toISOString().split('T')[0];
    let pool = (sportArg === 'heute' || sportArg === 'live')
      ? lastBets.filter(function(b){return b.gameDate===todayStr3;})
      : lastBets.filter(function(b){return b.sport===sportArg && b.gameDate===todayStr3;});
    if (!pool.length) return send('_Keine heutigen Spiele fuer ' + sportArg.toUpperCase() + '._', chatId);
    pool = pool.slice().sort(function(a,b){return b.edge-a.edge;});
    while (pool.length > 1) {
      const testAlloc = buildBudgetAlloc(pool, budget);
      const testA     = analyzeAll(testAlloc);
      if (testA && testA.expProfit >= 0) break;
      pool.pop();
    }
    if (!pool.length || pool.every(function(b){return b.edge<0;})) {
      return send('\u26a0\ufe0f *Kein Spiel mit positivem Erwartungswert heute.*\n_Besser nicht wetten._', chatId);
    }
    const origLen = ((sportArg==='heute'||sportArg==='live')
      ? lastBets.filter(function(b){return b.gameDate===todayStr3;})
      : lastBets.filter(function(b){return b.sport===sportArg&&b.gameDate===todayStr3;})).length;
    const removed = origLen - pool.length;
    const allocated = buildBudgetAlloc(pool, budget);
    return send(formatBudgetMsg(sportArg, budget, allocated, '+ (' + removed + ' gefiltert)'), chatId);
  }

  // Budget Modus: /nba 50
  const budgetMatch = text.match(/^\/?(nba|soccer|tennis_atp|tennis_wta|ufc|heute|live)\s+(\d+([.,]\d+)?)$/);
  if (budgetMatch) {
    const sportArg  = budgetMatch[1];
    const budget    = parseFloat(budgetMatch[2].replace(',', '.'));
    const todayStr2 = new Date().toISOString().split('T')[0];
    const pool = (sportArg === 'heute' || sportArg === 'live')
      ? lastBets.filter(function(b){return b.gameDate===todayStr2;})
      : lastBets.filter(function(b){return b.sport===sportArg && b.gameDate===todayStr2;});
    if (!pool.length) return send('_Keine heutigen Spiele fuer ' + sportArg.toUpperCase() + '._', chatId);
    const allocated = buildBudgetAlloc(pool, budget);
    return send(formatBudgetMsg(sportArg, budget, allocated, ''), chatId);
  }

  // Gesetzt Tracking: /gesetzt nba 50
  const gesetzMatch = text.match(/^\/?(gesetzt|placed)\s+(nba|soccer|tennis_atp|tennis_wta|ufc|heute)\s+(\d+([.,]\d+)?)$/);
  if (gesetzMatch) {
    const sportArg = gesetzMatch[2];
    const budget   = parseFloat(gesetzMatch[3].replace(',', '.'));
    const todayStr = new Date().toISOString().split('T')[0];
    const pool = sportArg === 'heute'
      ? lastBets.filter(function(b){return b.gameDate===todayStr;})
      : lastBets.filter(function(b){return b.sport===sportArg && b.gameDate===todayStr;});
    if (!pool.length) return send('_Keine Spiele gefunden. Erst /scan._', chatId);
    const allocated = buildBudgetAlloc(pool, budget);
    const bets = allocated.map(function(b) {
      return { sport: b.sport, game: b.game, pick: b.pick, opponent: b.opponent,
               odds: b.odds, bet: b.bet, result: null, profit: null, date: todayStr };
    });
    bets.forEach(function(b){activeBets.push(b);});
    let msg = '*Wetten gespeichert!*\n_' + nowStr() + '_\n\nErgebnisse werden automatisch gecheckt.\n\n';
    bets.forEach(function(b){ msg += '\u2022 *' + b.pick + '* vs ' + b.opponent + ' | \u20ac' + b.bet.toFixed(2) + '\n'; });
    msg += '\nBankroll: *\u20ac' + trackBankroll.toFixed(2) + '*';
    return send(msg, chatId);
  }

  // Stats
  if (['/stats', 'stats'].indexOf(text) >= 0) {
    if (!betHistory.length && !activeBets.length) return send('_Noch keine Wetten getrackt._', chatId);
    const done   = betHistory.filter(function(b){return b.result!==null;});
    const wins   = done.filter(function(b){return b.result==='win';}).length;
    const losses = done.filter(function(b){return b.result==='loss';}).length;
    const totPro = done.reduce(function(s,b){return s+(b.profit||0);},0);
    const totBet = done.reduce(function(s,b){return s+b.bet;},0);
    const roi    = totBet > 0 ? totPro/totBet*100 : 0;
    let msg = '*Statistik*\n_' + nowStr() + '_\n\n';
    msg += 'Wetten: ' + done.length + ' | \u2705 ' + wins + ' | \u274c ' + losses + '\n';
    msg += 'Trefferquote: *' + (done.length>0?(wins/done.length*100).toFixed(1):0) + '%*\n';
    msg += 'Profit: *' + (totPro>=0?'+':'') + '\u20ac' + totPro.toFixed(2) + '*\n';
    msg += 'ROI: *' + (roi>=0?'+':'') + roi.toFixed(1) + '%*\n';
    msg += 'Bankroll: *\u20ac' + trackBankroll.toFixed(2) + '*';
    if (activeBets.length) msg += '\nOffen: ' + activeBets.length;
    return send(msg, chatId);
  }

  // Sportart
  const sportKey = CONFIG.sports.find(function(s){return text==='/' + s || text===s;});
  if (sportKey) return send(formatBets(lastBets.filter(function(b){return b.sport===sportKey;}), sportKey.toUpperCase()), chatId);

  // Bankroll
  if (text.indexOf('bankroll') >= 0) {
    const num = parseFloat(text.replace(/[^\d.]/g, ''));
    if (num > 0) { CONFIG.bankroll = num; trackBankroll = num; return send('Bankroll: *\u20ac' + num.toFixed(2) + '*', chatId); }
    return send('Beispiel: /bankroll 80', chatId);
  }

  // Tage voraus
  if (text.indexOf('/tage') === 0 || text.indexOf('tage') === 0) {
    const num = parseInt(text.replace(/\D/g, ''));
    if (num > 0 && num <= 14) { CONFIG.daysAhead = num; return send(num + ' Tage voraus.', chatId); }
    return send('Beispiel: /tage 5', chatId);
  }

  // Team-Suche
  const match = lastBets.find(function(b) {
    return b.game.toLowerCase().indexOf(text) >= 0 ||
           b.pick.toLowerCase().indexOf(text) >= 0 ||
           b.opponent.toLowerCase().indexOf(text) >= 0;
  });
  if (match) {
    const eSign  = match.edge >= 0 ? '+' : '';
    const label  = match.edge > 0.05 ? '\u2605 Oddify schlaegt Buch' : match.edge > 0 ? '\u25cb Leichter Edge' : '\u00b7 Kein Edge';
    const oLabel = match.hasRealOdds ? 'Quote' : 'Gesch. Quote';
    const book   = match.bestBookmaker ? ' [' + match.bestBookmaker + ']' : '';
    return send('*' + match.game + '*\n_' + match.dateLabel + '_\n' + match.league + '\n\n' +
      'Pick: *' + match.pick + '*\n' +
      'AI: ' + (match.prob*100).toFixed(0) + '% | Gegner: ' + (match.oppProb*100).toFixed(0) + '%\n' +
      oLabel + ': ' + match.odds.toFixed(2) + book + '\n' + label + '\n' +
      'Edge: ' + eSign + (match.edge*100).toFixed(1) + '% | EV: ' + (match.ev>=0?'+':'') + match.ev.toFixed(1) + '%\n\n' +
      '*Empfehlung: \u20ac' + match.bet.toFixed(2) + '*', chatId);
  }

  send('Nicht verstanden. /hilfe', chatId);
});

const rule = new schedule.RecurrenceRule();
rule.minute = new schedule.Range(0, 59, CONFIG.pollMinutes);
schedule.scheduleJob(rule, function() { runScan(true); });

const ruleResults = new schedule.RecurrenceRule();
ruleResults.minute = new schedule.Range(0, 59, 30);
schedule.scheduleJob(ruleResults, function() { checkBetResults(); });

console.log('Telegram Bot startet... ' + nowStr());
console.log('Bot: t.me/bet_2_bet_bot');
setTimeout(function() { runScan(true); }, 2000);