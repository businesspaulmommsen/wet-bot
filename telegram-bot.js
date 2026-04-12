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
  telegramToken:  '8686433824:AAFiiaXYy2_HLcTobd-gLSRMw3gsQdQ52Q0',
  chatId:         null,

  oddifyApiUrl:  'https://fouddhhpuyrxugfhuqmq.supabase.co/functions/v1/get-predictions',
  oddifyAuthUrl: 'https://fouddhhpuyrxugfhuqmq.supabase.co/auth/v1/token?grant_type=password',
  oddifyApiKey:  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZvdWRkaGhwdXlyeHVnZmh1cW1xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY5MjA3ODcsImV4cCI6MjA3MjQ5Njc4N30.WVnGOt-nuubcVQLDskLqZSrcezK4OkbUFOUOLXWbqv4',
  oddifyEmail:   'paul2004mm@gmail.com',
  oddifyPassword: 'bujzyn-makVur-pysqy1',
  oddifyToken:   null,
  oddifyTokenExp: 0,

  bankroll:       50,
  maxSportPct:    0.60,
  minProbability: 0.55,
  kellyFraction:  0.5,
  pollMinutes:    5,
  daysAhead:      3,   // Spiele bis zu 3 Tage in die Zukunft

  sports: ['nba', 'soccer', 'tennis_atp', 'tennis_wta', 'ufc'],
};


// ── ESPN Turnier-Cache (Datum fuer Tennis) ────
const espnTournaments = {};   // { 'tennis_atp': {name, dateStr, endStr}, ... }

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
      // Erstes Turnier das gerade laeuft oder als naechstes startet
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
  // Gibt YYYY-MM-DD in Europe/Berlin zurueck
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('de-DE', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      timeZone: 'Europe/Berlin'
    }).split('.').reverse().join('-'); // DD.MM.YYYY -> YYYY-MM-DD
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

// ── Spiel parsen — erkennt NBA- und Soccer-Format ────
function parseGame(g, sport) {
  const today    = new Date(); today.setHours(0,0,0,0);
  const maxDate  = new Date(today); maxDate.setDate(maxDate.getDate() + CONFIG.daysAhead + 1);
  const todayStr = new Date().toISOString().split('T')[0];

  // ── NBA-Format: game_date + team_a/team_b ──
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
    return {
      sport, pick, opponent, prob, oppProb, odds,
      hasRealOdds: !!(realOdds && realOdds > 1),
      game:      g.event_name || `${g.team_a_name} vs ${g.team_b_name}`,
      gameDate:  g.game_date,
      dateLabel: g.game_date + ' (NBA ~21-04 Uhr MEZ)',
      sortKey:   g.game_date,
      isToday:   g.game_date === todayStr,
      league:    sport.toUpperCase(),
    };
  }

  // ── Soccer/UFC-Format: commence_time + home_team ──
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

  // ── Tennis-Format: p1_name/p2_name ──
  if (g.p1_name && g.p2_name) {
    const p1Prob = g.p1_win_prob || 0;
    const p2Prob = g.p2_win_prob || 0;
    const p1Wins = p1Prob >= p2Prob;
    const pick   = g.predicted_winner || (p1Wins ? g.p1_name : g.p2_name);
    const oppon  = p1Wins ? g.p2_name : g.p1_name;
    const prob   = Math.max(p1Prob, p2Prob);
    const oppP   = Math.min(p1Prob, p2Prob);
    if (prob < CONFIG.minProbability) return null;

    // Datum aus ESPN-Turniercache holen (wird beim Scan befüllt)
    const tournInfo = espnTournaments[sport] || {};
    // Turniername aus Oddify match_key extrahieren falls vorhanden
    const gameDate  = tournInfo.dateStr || todayStr;
    const endDate   = tournInfo.endStr  || todayStr;
    const tournament = g.tournament || tournInfo.name || sport.toUpperCase();
    const round     = g.round ? ` | ${g.round}` : '';
    const surface   = g.surface ? ` | ${g.surface}` : '';

    return {
      sport, pick, opponent: oppon, prob, oppProb: oppP,
      odds: estimateOdds(prob), hasRealOdds: false,
      game:      `${g.p1_name} vs ${g.p2_name}`,
      gameDate,
      dateLabel: `${tournament}${round}${surface} (bis ${endDate})`,
      sortKey:   gameDate + g.p1_name,
      isToday:   gameDate === todayStr,
      league:    tournament,
    };
  }

  return null;
}


// ── Quoten schätzen ───────────────────────────
function estimateOdds(prob) {
  return +Math.max(1.05, 1 / (Math.max(prob, 0.01) * 0.95)).toFixed(2);
}

// ── Oddify Prognosen abrufen ──────────────────
async function fetchPredictions(sport) {
  if (!await ensureOddifyToken()) return [];
  try {
    const res = await axios.post(
      CONFIG.oddifyApiUrl,
      { sport },
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

async function runScan(notify = true) {
  console.log(`=== Scan ${nowStr()} ===`);
  const allPreds = [];

  // ESPN Turnierdaten fuer Tennis holen
  await fetchEspnTournaments();

  for (const sport of CONFIG.sports) {
    const preds = await fetchPredictions(sport);
    console.log(`  ${sport}: ${preds.length} Spiele`);
    allPreds.push(...preds);
  }

  if (!allPreds.length) {
    console.log('Keine Prognosen gefunden.');
    return;
  }

  lastBets     = allocateBets(allPreds);
  lastScanTime = nowStr();

  const newBets = lastBets.filter(b => {
    const key = `${b.sport}:${b.game}:${b.pick}`;
    if (seenGames.has(key)) return false;
    seenGames.add(key);
    return true;
  });

  if (newBets.length && notify) await sendAlert(newBets);
  console.log(`=== Fertig | ${lastBets.length} gesamt | ${newBets.length} neu ===`);
}

async function sendAlert(bets) {
  const total = bets.reduce((s, b) => s + b.bet, 0);
  let msg = `*ODDIFY x TIPICO*\n_${nowStr()}_\n${bets.length} neue Spiele | *\u20ac${total.toFixed(2)}*\n\n`;

  let lastDate = '';
  for (const b of bets) {
    if (b.gameDate !== lastDate) {
      msg += `\`--- ${b.gameDate} ---\`\n`;
      lastDate = b.gameDate;
    }
    const eSign = b.edge >= 0 ? '+' : '';
    const star  = b.edge > 0.05 ? '\u2605' : b.edge > 0 ? '\u25cb' : '\u00b7';
    const real  = b.hasRealOdds ? '' : '~';
    msg += `${star} *${b.pick}* vs ${b.opponent}\n`;
    msg += `_${b.dateLabel}_ | ${b.league}\n`;
    msg += `${(b.prob*100).toFixed(0)}% | ${real}${b.odds.toFixed(2)} | Edge ${eSign}${(b.edge*100).toFixed(1)}% | *\u20ac${b.bet.toFixed(2)}*\n\n`;
  }
  await send(msg.trim());
}

function formatBets(bets, title) {
  if (!bets.length) return 'Keine Spiele gefunden.';
  const total = bets.reduce((s, b) => s + b.bet, 0);
  let out = `*${title || 'Spiele'}*\n_${nowStr()}_\n${bets.length} Spiele | *\u20ac${total.toFixed(2)}*\n\n`;

  let lastDate = '';
  for (const b of bets) {
    if (b.gameDate !== lastDate) {
      out += `\`--- ${b.gameDate} ---\`\n`;
      lastDate = b.gameDate;
    }
    const e    = b.edge >= 0 ? `+${(b.edge*100).toFixed(1)}%` : `${(b.edge*100).toFixed(1)}%`;
    const star = b.edge > 0.05 ? '\u2605 ' : b.edge > 0 ? '\u25cb ' : '';
    const real = b.hasRealOdds ? '' : '~';
    out += `${star}*${b.pick}* vs ${b.opponent}\n`;
    out += `_${b.dateLabel}_ | ${b.league} | ${real}${b.odds.toFixed(2)} | ${e} | *\u20ac${b.bet.toFixed(2)}*\n\n`;
  }
  return out.trim();
}

// ── Nachrichten ───────────────────────────────
bot.on('message', async msg => {
  const chatId = msg.chat.id;
  if (!CONFIG.chatId) { CONFIG.chatId = chatId; console.log('Chat-ID:', chatId); }

  const text = (msg.text || '').trim().toLowerCase();

  if (text === '/start' || text === 'start') {
    return send(`*Oddify x Tipico Bot* \u2713\n_${nowStr()}_\nBankroll: \u20ac${CONFIG.bankroll} | Scan alle ${CONFIG.pollMinutes} Min | ${CONFIG.daysAhead} Tage voraus\n\n/hilfe`, chatId);
  }

  if (['/hilfe', 'hilfe', '?', '/help'].includes(text)) {
    return send(
      '*Befehle:*\n\n/wetten - alle Spiele\n/heute - nur heute\n/morgen - nur morgen\n/top3 - Top 3 nach Edge\n/edge - alle nach Edge\n/nba /soccer /ufc /tennis\\_atp /tennis\\_wta\n/scan - sofort scannen\n/status - Bot-Status\n/bankroll 80 - Bankroll aendern\n/tage 5 - Tage voraus aendern\n\nTeamname tippen, z.B. _Bayern_',
      chatId
    );
  }

  if (['/status', 'status'].includes(text)) {
    const total  = lastBets.reduce((s, b) => s + b.bet, 0);
    const sports = [...new Set(lastBets.map(b => b.sport))].join(', ') || '-';
    return send(`*Status*\n_${nowStr()}_\nLetzter Scan: ${lastScanTime || '-'}\nSportarten: ${sports}\nSpiele: ${lastBets.length}\nEinsatz: \u20ac${total.toFixed(2)}\nBankroll: \u20ac${CONFIG.bankroll}\nTage voraus: ${CONFIG.daysAhead}`, chatId);
  }

  if (['/wetten', 'wetten', 'alle'].includes(text)) {
    return send(formatBets(lastBets), chatId);
  }

  if (['/heute', 'heute'].includes(text)) {
    const today = new Date().toISOString().split('T')[0];
    return send(formatBets(lastBets.filter(b => b.gameDate === today), 'Heute'), chatId);
  }

  if (['/morgen', 'morgen'].includes(text)) {
    const tom = new Date(); tom.setDate(tom.getDate() + 1);
    const tomStr = tom.toISOString().split('T')[0];
    return send(formatBets(lastBets.filter(b => b.gameDate === tomStr), 'Morgen'), chatId);
  }

  if (['/scan', 'scan'].includes(text)) {
    send(`_Starte Scan... ${nowStr()}_`, chatId);
    seenGames.clear();
    return runScan(true);
  }

  if (text.startsWith('/top') || text.startsWith('top')) {
    const n = parseInt(text.replace(/\D/g, '')) || 3;
    const top = [...lastBets].sort((a, b) => b.edge - a.edge).slice(0, n);
    return send(formatBets(top, `Top ${n} nach Edge`), chatId);
  }

  if (['/edge', 'edge'].includes(text)) {
    return send(formatBets([...lastBets].sort((a, b) => b.edge - a.edge), 'Nach Edge'), chatId);
  }

  // ── Budget-Befehl: /nba 80 oder /soccer 50 ──
  const budgetMatch = text.match(/^\/?(nba|soccer|tennis_atp|tennis_wta|ufc|heute|live)\s+(\d+([.,]\d+)?)$/);
  if (budgetMatch) {
    const sportArg  = budgetMatch[1];
    const budget    = parseFloat(budgetMatch[2].replace(',', '.'));
    const todayStr2 = new Date().toISOString().split('T')[0];

    // Spiele filtern
    let pool = sportArg === 'heute' || sportArg === 'live'
      ? lastBets.filter(b => b.gameDate === todayStr2)
      : lastBets.filter(b => (b.sport === sportArg) && b.gameDate === todayStr2);

    if (!pool.length) {
      return send(`_Keine heutigen Spiele fuer ${sportArg.toUpperCase()} gefunden._`, chatId);
    }

    // Budget neu aufteilen mit Half-Kelly + Edge-Gewichtung
    const posEdges  = pool.map(b => Math.max(0, b.edge));
    const totalEdge = posEdges.reduce((a, b) => a + b, 0);
    const cnt       = pool.length;
    const equalPool = budget * 0.40;
    const edgePool  = budget * 0.60;

    // ══════════════════════════════════════════════════════
    // ══════════════════════════════════════════════════════
    // VOLLSTAENDIGE PORTFOLIO-OPTIMIERUNG
    // Analysiert ALLE 2^N Szenarien gewichtet nach Wahrscheinlichkeit
    // Optimiert P(Gewinn > 0) - maximiert profitable Szenarien
    // Edge^2-Gewicht: starke Differenzierung AI vs Buch
    // ══════════════════════════════════════════════════════

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

    // Startallokation: 20% gleichmaessig + 80% nach edge^2
    const edgeSq      = posEdges.map(e => e * e);
    const totalEdgeSq = edgeSq.reduce((a, b) => a + b, 0);

    let allocated = pool.map((b, i) => {
      const equalPart = budget * 0.20 / cnt;
      const edgePart  = totalEdgeSq > 0 ? budget * 0.80 * edgeSq[i] / totalEdgeSq : budget * 0.80 / cnt;
      const kellyCap  = b.hk * budget;
      const raw       = equalPart + edgePart;
      return { ...b, bet: Math.max(0.01, Math.min(raw, kellyCap > 0 ? kellyCap : raw)) };
    });

    // Skalieren auf Budget
    let scaleT = allocated.reduce((s, b) => s + b.bet, 0);
    if (scaleT > budget) {
      const sc = budget / scaleT;
      allocated = allocated.map(b => ({ ...b, bet: b.bet * sc }));
    }

    // Iterative Optimierung: maximiere P(Gewinn > 0)
    let bestA = analyzeAll(allocated);
    let bestScore = bestA ? bestA.probProfit : 0;

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
      if (candA.probProfit > bestScore ||
         (Math.abs(candA.probProfit - bestScore) < 0.001 && candA.expProfit > bestA.expProfit)) {
        allocated  = candidate;
        bestScore  = candA.probProfit;
        bestA      = candA;
      }
    }

    allocated = allocated.map(b => ({
      ...b,
      bet:  +Math.max(0.01, b.bet).toFixed(2),
      gain: +(b.bet * (b.odds - 1)).toFixed(2),
    })).sort((a, b2) => (b2.edge*b2.edge) - (a.edge*a.edge));

    const total     = +(allocated.reduce((s, b) => s + b.bet, 0)).toFixed(2);
    const totalGain = +(allocated.reduce((s, b) => s + b.gain, 0)).toFixed(2);
    const finalA    = analyzeAll(allocated);
    const expProfit = finalA ? +finalA.expProfit.toFixed(2) : 0;
    const probWin   = finalA ? (finalA.probProfit * 100).toFixed(1) : '?';
    const bw        = finalA?.byWrong || {};

    const sortedByGain = [...allocated].sort((a, b2) => b2.gain - a.gain);
    let breakEvenCount = 0, runningBE = -total;
    for (const b of sortedByGain) {
      runningBE += b.gain + b.bet;
      breakEvenCount++;
      if (runningBE >= 0) break;
    }


    let msg = `*${sportArg.toUpperCase()} heute | Budget: \u20ac${budget.toFixed(2)}*
`;
    msg    += `_${nowStr()} | ${allocated.length} Spiele | Einsatz: \u20ac${total}_

`;

    msg += `*Gewinn-Szenarien:*
`;
    msg += `Wahrsch. im Plus: *${probWin}%*
`;
    msg += `Erw. Gewinn: *${expProfit >= 0 ? '+' : ''}\u20ac${expProfit}*
`;
    msg += `Alle richtig: +\u20ac${totalGain}
`;
    const maxWrong = Math.min(5, allocated.length);
    for (let k = 0; k <= maxWrong; k++) {
      const s = bw[k] || { total: 0, profitable: 0, sumProfit: 0 };
      if (!s.total) continue;
      const pct = (s.profitable / s.total * 100).toFixed(0);
      const avg = (s.sumProfit / s.total).toFixed(2);
      const sign = parseFloat(avg) >= 0 ? '+' : '';
      const icon = k === 0 ? '\u2705' : k <= 2 ? '\u26ab' : '\u26aa';
      msg += `${icon} ${k} falsch: ${s.profitable}/${s.total} (${pct}%) | avg ${sign}\u20ac${avg}
`;
    }
    msg += `Break-even: ${breakEvenCount} von ${allocated.length}

`;

    for (const b of allocated) {
      const eSign  = b.edge >= 0 ? '+' : '';
      const edgeSqVal = b.edge * b.edge;
      const star   = edgeSqVal > 0.01 ? '\u2605 ' : edgeSqVal > 0.001 ? '\u25cb ' : '\u00b7 ';
      const real   = b.hasRealOdds ? '' : '~';
      const profit = +(b.bet * (b.odds - 1)).toFixed(2);
      msg += `${star}*${b.pick}* vs ${b.opponent}
`;
      msg += `_${b.dateLabel}_
`;
      msg += `AI: ${(b.prob*100).toFixed(0)}% | Buch: ${(1/b.odds*100).toFixed(0)}% | Edge ${eSign}${(b.edge*100).toFixed(1)}%
`;
      msg += `Quote: ${real}${b.odds.toFixed(2)} | *\u20ac${b.bet.toFixed(2)}* | +\u20ac${profit}

`;
    }
    return send(msg.trim(), chatId);
  }

  // Sportart
  const sportKey = CONFIG.sports.find(s => text === `/${s}` || text === s);
  if (sportKey) {
    return send(formatBets(lastBets.filter(b => b.sport === sportKey), sportKey.toUpperCase()), chatId);
  }

  // Bankroll
  if (text.includes('bankroll')) {
    const num = parseFloat(text.replace(/[^\d.]/g, ''));
    if (num > 0) { CONFIG.bankroll = num; return send(`Bankroll: *\u20ac${num.toFixed(2)}*`, chatId); }
    return send('Beispiel: /bankroll 80', chatId);
  }

  // Tage voraus
  if (text.startsWith('/tage') || text.startsWith('tage')) {
    const num = parseInt(text.replace(/\D/g, ''));
    if (num > 0 && num <= 14) { CONFIG.daysAhead = num; return send(`Zeige Spiele ${num} Tage im Voraus.`, chatId); }
    return send('Beispiel: /tage 5', chatId);
  }

  // Team-Suche
  const match = lastBets.find(b =>
    b.game.toLowerCase().includes(text) ||
    b.pick.toLowerCase().includes(text) ||
    b.opponent.toLowerCase().includes(text)
  );
  if (match) {
    const eSign  = match.edge >= 0 ? '+' : '';
    const label  = match.edge > 0.05 ? '\u2605 Oddify schlaegt Tipico' : match.edge > 0 ? '\u25cb Leichter Edge' : '\u00b7 Kein Edge';
    const oLabel = match.hasRealOdds ? 'Tipico-Quote' : 'Gesch. Quote';
    return send(
      `*${match.game}*\n_${match.dateLabel}_\n${match.league}\n\n` +
      `Pick: *${match.pick}*\n` +
      `Oddify: ${(match.prob*100).toFixed(0)}% | Gegner: ${(match.oppProb*100).toFixed(0)}%\n` +
      `${oLabel}: ${match.odds.toFixed(2)}\n${label}\n` +
      `Edge: ${eSign}${(match.edge*100).toFixed(1)}% | EV: ${match.ev>=0?'+':''}${match.ev.toFixed(1)}%\n\n` +
      `*Empfehlung: \u20ac${match.bet.toFixed(2)}*\n_(von \u20ac${match.sportBudget.toFixed(0)} ${match.sport.toUpperCase()}-Budget)_`,
      chatId
    );
  }

  send('Nicht verstanden. /hilfe', chatId);
});

// ── Scheduler & Start ────────────────────────
const rule  = new schedule.RecurrenceRule();
rule.minute = new schedule.Range(0, 59, CONFIG.pollMinutes);
schedule.scheduleJob(rule, () => runScan(true));

console.log(`Telegram Bot startet... ${nowStr()}`);
console.log('Bot: t.me/bet_2_bet_bot');
setTimeout(() => runScan(true), 2000);