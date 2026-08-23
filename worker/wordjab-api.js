// ============================================================================
// WordJab — wordjab-api Cloudflare Worker (full source, as deployed)
// ============================================================================
//
// This is the complete script behind https://wordjab-api.dustinramsbottom.workers.dev,
// serving GET /leaderboard and POST /register, /daily, /result, /corr/*.
// It's the merge of the original leaderboard/streak Worker with the additive
// Correspondence module (worker/correspondence.js in this repo) — that file
// stays in the repo separately as the documented, standalone version of the
// /corr/* module (with its own install notes), but this file is the one
// source of truth for what's actually running in production.
//
// Storage: a single KV namespace bound as env.LEADERBOARD.
//   leaderboard          -> { topScores, longestGames, recentGames, dailyStreaks, weekly }
//   id:<namelower>        -> { name, secret, streak, best, lastDay, weekIndex, weekWins, createdTs }
//                            One record per claimed name. `secret` is the
//                            per-browser token that proves ownership — /register,
//                            /daily, and every /corr/* endpoint all read/write
//                            this same shape, so a name claimed anywhere is
//                            reserved everywhere.
//   corr:<gameId>         -> full server-side Correspondence game record
//   corrcode:<CODE>       -> gameId, so a 4-letter code can be joined
//   corridx:<namelower>   -> JSON array of gameIds this player is in (bounded)
//
// Deploying changes: this is edited via the Cloudflare dashboard's Worker
// editor (see the git history of worker/correspondence.js for the original
// manual-paste install notes) — there is no wrangler.toml/CI pipeline for it
// yet. To change what's live, paste the updated script into the dashboard
// editor and hit Deploy, or wire up `wrangler deploy` with a Cloudflare API
// token if you want pushes here to deploy automatically.
// ============================================================================

const CORR_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corrJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORR_CORS },
  });
}

const CORR_MAX_WORD = 30;       // hard ceiling on board size
const CORR_MIN_WORD = 4;
const CORR_MIN_PLAYERS = 2;
const CORR_MAX_PLAYERS = 6;
const CORR_IDX_CAP = 25;        // most-recent games kept in a player's index

function corrCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no ambiguous O/0 I/1, matches client
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function corrId() {
  return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Claim/verify a name via the shared id:<lower> record. Returns { ok:true } if
// the caller owns the name (or it was free and is now theirs), or { taken:true }
// if a different secret already holds it. Fresh claims are written in the SAME
// shape /register + /daily use, so nothing downstream breaks.
async function corrOwnName(env, name, secret) {
  const lower = String(name || '').toLowerCase();
  if (!lower || !secret) return { taken: false, bad: true };
  const key = 'id:' + lower;
  let rec = null;
  try { rec = await env.LEADERBOARD.get(key, 'json'); } catch (e) {}
  if (rec && rec.secret && rec.secret !== secret) return { taken: true };
  if (!rec) {
    rec = {
      name, secret, streak: 0, best: 0, lastDay: 0,
      weekIndex: 0, weekWins: 0, createdTs: Date.now(),
    };
    try { await env.LEADERBOARD.put(key, JSON.stringify(rec)); } catch (e) {}
  }
  return { ok: true, rec };
}

function corrCleanWord(raw, charCount) {
  // Normalize a secret word to exactly `charCount` tiles: trim, collapse runs of
  // spaces, cut to length, then pad the tail with spaces.
  let w = String(raw || '').replace(/\s+/g, ' ').trim();
  if (w.length > charCount) w = w.slice(0, charCount);
  return w.padEnd(charCount, ' ');
}
function corrMakeTiles(word) {
  return word.split('').map(ch => ({ char: ch, revealed: false }));
}
function corrMakePlayer(name, word, charCount) {
  return {
    name, nameLower: String(name).toLowerCase(),
    tiles: corrMakeTiles(corrCleanWord(word, charCount)),
    wrong: [],           // letters thrown at THIS board that missed (per-board)
    eliminated: false,
  };
}

async function corrIdxAdd(env, name, gameId) {
  const key = 'corridx:' + String(name).toLowerCase();
  let list = [];
  try { list = (await env.LEADERBOARD.get(key, 'json')) || []; } catch (e) {}
  list = list.filter(id => id !== gameId);
  list.unshift(gameId);
  if (list.length > CORR_IDX_CAP) list = list.slice(0, CORR_IDX_CAP);
  try { await env.LEADERBOARD.put(key, JSON.stringify(list)); } catch (e) {}
}

async function corrLoad(env, gameId) {
  try { return await env.LEADERBOARD.get('corr:' + gameId, 'json'); } catch (e) { return null; }
}
async function corrSave(env, game) {
  game.updatedTs = Date.now();
  try { await env.LEADERBOARD.put('corr:' + game.id, JSON.stringify(game)); } catch (e) {}
}

function corrPlayerIndex(game, name) {
  const lower = String(name || '').toLowerCase();
  return game.players.findIndex(p => p && p.nameLower === lower);
}
function corrAliveCount(game) {
  return game.players.filter(p => p && !p.eliminated).length;
}
// Next still-standing player after `from` (wraps). Returns `from` if nobody else.
function corrNextTurn(game, from) {
  const n = game.players.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n;
    if (game.players[i] && !game.players[i].eliminated) return i;
  }
  return from;
}
// Begin play: coin-flip a random still-standing player to jab first.
function corrStartGame(game) {
  game.phase = 'active';
  game.turn = Math.floor(Math.random() * game.players.length);
}

// Client-facing view of a game. The requester sees their OWN word in full, but
// every other player's unrevealed tiles are redacted to null — a secret never
// leaves the server until a letter actually cracks it open. Once the game is
// finished, all words are revealed.
function corrRedact(game, meName) {
  const meIdx = corrPlayerIndex(game, meName);
  const over = game.phase === 'finished';
  const meLower = String(meName || '').toLowerCase();
  const players = game.players.map((p, i) => {
    if (!p) return null;
    const mine = i === meIdx;
    return {
      name: p.name,
      eliminated: !!p.eliminated,
      resigned: !!p.resigned,
      wrong: p.wrong || [],
      tiles: (p.tiles || []).map(t => ({
        char: (mine || t.revealed || over) ? t.char : null,
        revealed: !!t.revealed,
      })),
    };
  });
  const yourTurn = game.phase === 'active' && meIdx >= 0 && game.turn === meIdx;
  return {
    id: game.id, code: game.code, charCount: game.charCount,
    target: game.target, phase: game.phase, turn: game.turn,
    winner: game.winner || null,
    yourIndex: meIdx, yourTurn,
    isHost: game.hostLower === meLower,
    joined: game.players.length,
    players, lastMove: game.lastMove || null,
    createdTs: game.createdTs, updatedTs: game.updatedTs,
  };
}

// Apply one letter guess by the player whose turn it is, at players[targetIdx].
// Mirrors the client's processGuess: a hit reveals all matching tiles (blanks
// one-at-a-time) and the turn stays; a miss passes to the next player. Cracking
// the last remaining opponent wins.
function corrApplyGuess(game, letter, targetIdx) {
  const gi = game.turn;
  const guesser = game.players[gi];
  const target = game.players[targetIdx];
  if (!target) return { error: 'bad-target' };
  if (targetIdx === gi) return { error: 'bad-target' };
  if (target.eliminated) return { error: 'target-out' };

  const lc = String(letter || '').toLowerCase();
  if (!/^[a-z ]$/.test(lc)) return { error: 'bad-letter' };
  if (!target.wrong) target.wrong = [];
  const alreadyRevealed = target.tiles.some(t => t.revealed && t.char && t.char.toLowerCase() === lc);
  // A real letter can only be thrown at a given board once. Spaces are exempt:
  // blanks reveal one-at-a-time, so you must be able to keep jabbing spaces to
  // clear padding (the same as the live game, which never locks repeated spaces).
  if (lc !== ' ' && (alreadyRevealed || target.wrong.includes(lc))) return { error: 'dup' };

  let hitIdxs = [];
  target.tiles.forEach((t, i) => {
    if (!t.revealed && t.char && t.char.toLowerCase() === lc) hitIdxs.push(i);
  });
  if (lc === ' ' && hitIdxs.length > 1) {
    hitIdxs = [hitIdxs[Math.floor(Math.random() * hitIdxs.length)]];
  }

  if (hitIdxs.length > 0) {
    hitIdxs.forEach(i => { target.tiles[i].revealed = true; });
    const cracked = target.tiles.every(t => t.revealed);
    if (cracked) {
      target.eliminated = true;
      game.lastMove = { by: guesser.name, letter: lc, result: 'crack', targetIdx, targetName: target.name, revealedIdxs: hitIdxs };
      if (corrAliveCount(game) <= 1) {
        game.phase = 'finished';
        const last = game.players.find(p => p && !p.eliminated);
        game.winner = last ? last.name : guesser.name;
      }
      // otherwise the guesser keeps jabbing (a hit always continues the turn)
    } else {
      game.lastMove = { by: guesser.name, letter: lc, result: 'hit', targetIdx, targetName: target.name, revealedIdxs: hitIdxs };
    }
  } else {
    if (lc !== ' ') target.wrong.push(lc);
    game.turn = corrNextTurn(game, gi);
    game.lastMove = { by: guesser.name, letter: lc, result: 'miss', targetIdx, targetName: target.name, revealedIdxs: [] };
  }
  return { ok: true };
}

// ── Correspondence endpoint handlers ────────────────────────────────────────

async function corrCreate(env, body) {
  const { name, secret, word, charCount, players } = body;
  const own = await corrOwnName(env, name, secret);
  if (own.bad) return corrJson({ ok: false, error: 'bad-name' }, 400);
  if (own.taken) return corrJson({ ok: false, taken: true }, 409);

  let size = parseInt(charCount, 10);
  if (isNaN(size)) size = 10;
  size = Math.max(CORR_MIN_WORD, Math.min(CORR_MAX_WORD, size));
  let target = parseInt(players, 10);
  if (isNaN(target)) target = 2;
  target = Math.max(CORR_MIN_PLAYERS, Math.min(CORR_MAX_PLAYERS, target));

  const clean = corrCleanWord(word, size);
  if (clean.trim().length < 1) return corrJson({ ok: false, error: 'empty-word' }, 400);

  const id = corrId();
  let code = corrCode();
  for (let i = 0; i < 5; i++) {
    let existing = null;
    try { existing = await env.LEADERBOARD.get('corrcode:' + code); } catch (e) {}
    if (!existing) break;
    code = corrCode();
  }

  const game = {
    id, code, charCount: size, mode: 'last', target,
    phase: 'waiting', turn: 0, winner: null,
    hostLower: String(name).toLowerCase(),
    createdTs: Date.now(), updatedTs: Date.now(), lastMove: null,
    players: [corrMakePlayer(name, word, size)],
  };
  await corrSave(env, game);
  try { await env.LEADERBOARD.put('corrcode:' + code, id, { expirationTtl: 60 * 60 * 24 * 14 }); } catch (e) {}
  await corrIdxAdd(env, name, id);
  return corrJson({ ok: true, gameId: id, code, game: corrRedact(game, name) });
}

async function corrJoin(env, body) {
  const { name, secret, code, word } = body;
  const own = await corrOwnName(env, name, secret);
  if (own.bad) return corrJson({ ok: false, error: 'bad-name' }, 400);
  if (own.taken) return corrJson({ ok: false, taken: true }, 409);

  const up = String(code || '').toUpperCase().trim();
  let gameId = null;
  try { gameId = await env.LEADERBOARD.get('corrcode:' + up); } catch (e) {}
  if (!gameId) return corrJson({ ok: false, error: 'not-found' }, 404);
  const game = await corrLoad(env, gameId);
  if (!game) return corrJson({ ok: false, error: 'not-found' }, 404);
  if (game.phase !== 'waiting') return corrJson({ ok: false, error: 'started' }, 409);
  if (corrPlayerIndex(game, name) >= 0) return corrJson({ ok: false, error: 'already-in', game: corrRedact(game, name) }, 200);
  if (game.players.length >= game.target) return corrJson({ ok: false, error: 'full' }, 409);

  const clean = corrCleanWord(word, game.charCount);
  if (clean.trim().length < 1) return corrJson({ ok: false, error: 'empty-word' }, 400);

  game.players.push(corrMakePlayer(name, word, game.charCount));
  if (game.players.length >= game.target) {
    corrStartGame(game);
    try { await env.LEADERBOARD.delete('corrcode:' + up); } catch (e) {}
  }
  await corrSave(env, game);
  await corrIdxAdd(env, name, gameId);
  return corrJson({ ok: true, gameId, game: corrRedact(game, name) });
}

// The creator can start the match early once >=2 players are in.
async function corrStart(env, body) {
  const { name, secret, gameId } = body;
  const own = await corrOwnName(env, name, secret);
  if (own.taken) return corrJson({ ok: false, taken: true }, 409);
  const game = await corrLoad(env, gameId);
  if (!game) return corrJson({ ok: false, error: 'not-found' }, 404);
  if (game.hostLower !== String(name).toLowerCase()) return corrJson({ ok: false, error: 'not-host' }, 403);
  if (game.phase !== 'waiting') return corrJson({ ok: true, game: corrRedact(game, name) });
  if (game.players.length < CORR_MIN_PLAYERS) return corrJson({ ok: false, error: 'need-two', game: corrRedact(game, name) }, 409);
  corrStartGame(game);
  try { await env.LEADERBOARD.delete('corrcode:' + game.code); } catch (e) {}
  await corrSave(env, game);
  return corrJson({ ok: true, game: corrRedact(game, name) });
}

async function corrMove(env, body) {
  const { name, secret, gameId, letter, targetIdx } = body;
  const own = await corrOwnName(env, name, secret);
  if (own.bad) return corrJson({ ok: false, error: 'bad-name' }, 400);
  if (own.taken) return corrJson({ ok: false, taken: true }, 409);

  const game = await corrLoad(env, gameId);
  if (!game) return corrJson({ ok: false, error: 'not-found' }, 404);
  const meIdx = corrPlayerIndex(game, name);
  if (meIdx < 0) return corrJson({ ok: false, error: 'not-a-player' }, 403);
  if (game.phase !== 'active') return corrJson({ ok: false, error: 'not-active', game: corrRedact(game, name) }, 409);
  if (game.turn !== meIdx) return corrJson({ ok: false, error: 'not-your-turn', game: corrRedact(game, name) }, 409);

  const ti = parseInt(targetIdx, 10);
  if (isNaN(ti) || ti < 0 || ti >= game.players.length) return corrJson({ ok: false, error: 'bad-target' }, 400);

  const res = corrApplyGuess(game, letter, ti);
  if (res.error) return corrJson({ ok: false, error: res.error, game: corrRedact(game, name) }, 400);
  await corrSave(env, game);
  return corrJson({ ok: true, game: corrRedact(game, name) });
}

async function corrStateEndpoint(env, body) {
  const { name, gameId } = body;
  const game = await corrLoad(env, gameId);
  if (!game) return corrJson({ ok: false, error: 'not-found' }, 404);
  if (corrPlayerIndex(game, name) < 0) return corrJson({ ok: false, error: 'not-a-player' }, 403);
  return corrJson({ ok: true, game: corrRedact(game, name) });
}

async function corrResign(env, body) {
  const { name, secret, gameId } = body;
  const own = await corrOwnName(env, name, secret);
  if (own.taken) return corrJson({ ok: false, taken: true }, 409);
  const game = await corrLoad(env, gameId);
  if (!game) return corrJson({ ok: false, error: 'not-found' }, 404);
  const meIdx = corrPlayerIndex(game, name);
  if (meIdx < 0) return corrJson({ ok: false, error: 'not-a-player' }, 403);
  if (game.phase === 'finished') return corrJson({ ok: true, game: corrRedact(game, name) });

  const me = game.players[meIdx];
  if (game.phase === 'waiting') {
    // Nothing's started — just mark them out; if the host bails and nobody's
    // left, the game is abandoned/finished with no winner.
    me.resigned = true; me.eliminated = true;
    if (corrAliveCount(game) <= 1) {
      game.phase = 'finished';
      const last = game.players.find(p => p && !p.eliminated);
      game.winner = last ? last.name : null;
    }
    game.lastMove = { by: name, result: 'resign' };
    await corrSave(env, game);
    return corrJson({ ok: true, game: corrRedact(game, name) });
  }

  const wasMyTurn = game.turn === meIdx;
  me.resigned = true; me.eliminated = true;
  game.lastMove = { by: name, result: 'resign' };
  if (corrAliveCount(game) <= 1) {
    game.phase = 'finished';
    const last = game.players.find(p => p && !p.eliminated);
    game.winner = last ? last.name : null;
  } else if (wasMyTurn) {
    game.turn = corrNextTurn(game, meIdx);
  }
  await corrSave(env, game);
  return corrJson({ ok: true, game: corrRedact(game, name) });
}

async function corrList(env, body) {
  const { name } = body;
  const lower = String(name || '').toLowerCase();
  if (!lower) return corrJson({ ok: true, games: [], awaiting: 0 });
  let ids = [];
  try { ids = (await env.LEADERBOARD.get('corridx:' + lower, 'json')) || []; } catch (e) {}
  const games = [];
  for (const id of ids) {
    const g = await corrLoad(env, id);
    if (!g) continue;
    const meIdx = corrPlayerIndex(g, name);
    if (meIdx < 0) continue;
    const opponents = g.players.filter((_, i) => i !== meIdx).map(p => p.name);
    games.push({
      id: g.id, code: g.code, phase: g.phase,
      opponents, playerCount: g.players.length, target: g.target,
      yourTurn: g.phase === 'active' && g.turn === meIdx,
      youWon: g.phase === 'finished' && g.winner && g.winner.toLowerCase() === lower,
      winner: g.winner || null,
      updatedTs: g.updatedTs, createdTs: g.createdTs,
    });
  }
  games.sort((a, b) => (b.updatedTs || 0) - (a.updatedTs || 0));
  const awaiting = games.filter(g => g.yourTurn).length;
  return corrJson({ ok: true, games, awaiting });
}

// Router entry point. Returns a Response for any /corr/* path, or null so the
// caller falls through to the existing endpoints.
async function handleCorrespondence(request, env, path) {
  if (!path.startsWith('/corr/')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORR_CORS });
  if (request.method !== 'POST') return corrJson({ ok: false, error: 'method' }, 405);

  let body = {};
  try { body = await request.json(); } catch (e) { return corrJson({ ok: false, error: 'bad-json' }, 400); }

  switch (path) {
    case '/corr/create': return corrCreate(env, body);
    case '/corr/join': return corrJoin(env, body);
    case '/corr/start': return corrStart(env, body);
    case '/corr/move': return corrMove(env, body);
    case '/corr/state': return corrStateEndpoint(env, body);
    case '/corr/resign': return corrResign(env, body);
    case '/corr/list': return corrList(env, body);
    default: return corrJson({ ok: false, error: 'unknown' }, 404);
  }
}

// ── Main router: /leaderboard, /register, /daily, /result, plus /corr/* ────

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const corr = await handleCorrespondence(request, env, url.pathname);
    if (corr) return corr;
    const send = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    const clean = (s, n) => String(s == null ? '' : s).slice(0, n);
    const num = (v) => { const x = parseInt(v); return isNaN(x) ? 0 : x; };

    const LB_KEY = 'leaderboard';
    const blankLB = { topScores: [], longestGames: [], recentGames: [], dailyStreaks: [], weekly: { weekIndex: 0, entries: [] } };
    const loadLB = async () => { const r = await env.LEADERBOARD.get(LB_KEY); return r ? JSON.parse(r) : { ...blankLB }; };
    const saveLB = (d) => env.LEADERBOARD.put(LB_KEY, JSON.stringify(d));
    const idKey = (nl) => 'id:' + nl;
    const loadId = async (nl) => { const r = await env.LEADERBOARD.get(idKey(nl)); return r ? JSON.parse(r) : null; };
    const saveId = (nl, o) => env.LEADERBOARD.put(idKey(nl), JSON.stringify(o));

    const BAD = ['fuck', 'shit', 'cunt', 'nigg', 'fagg', 'bitch', 'cock', 'dick', 'puss', 'whore', 'slut', 'rape', 'nazi', 'hitler'];
    const nameError = (name) => {
      if (!/^[a-zA-Z0-9 _-]{2,16}$/.test(name)) return 'Name must be 2-16 letters, numbers, or spaces.';
      const flat = name.toLowerCase().replace(/[^a-z]/g, '');
      if (BAD.some(w => flat.includes(w))) return 'Pick a friendlier name.';
      return null;
    };

    const EPOCH = Date.UTC(2024, 0, 1);
    const serverDay = () => Math.floor((Date.now() - EPOCH) / 86400000);

    // A claimed name is bound to whatever secret first registered it, with no
    // other way to prove ownership — fine on one device, but it permanently
    // locks out a second device (or a browser that lost its storage) with no
    // recovery path. This adds an optional recovery phrase, set once at claim
    // time (or later via /recovery-set), that a NEW device can use to
    // reassign the name to its own secret via /recover — without needing the
    // original device at all. Only a salted hash is ever stored.
    const sha256Hex = async (s) => {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
    };
    const randSaltHex = () => {
      const a = new Uint8Array(8);
      crypto.getRandomValues(a);
      return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
    };
    const hashRecovery = (salt, phrase) => sha256Hex(salt + ':' + phrase.toLowerCase());
    const RECOVERY_MAX_FAILS = 8;
    const RECOVERY_COOLDOWN_MS = 60 * 60 * 1000;

    const upsertStreak = (data, name, best) => {
      data.dailyStreaks = data.dailyStreaks || [];
      const ex = data.dailyStreaks.find(d => (d.name || '').toLowerCase() === name.toLowerCase());
      if (ex) { ex.streak = best; ex.name = name; ex.ts = Date.now(); }
      else data.dailyStreaks.push({ name, streak: best, ts: Date.now() });
      data.dailyStreaks.sort((a, b) => (b.streak || 0) - (a.streak || 0));
      data.dailyStreaks = data.dailyStreaks.slice(0, 50);
    };

    try {
      if (url.pathname === '/leaderboard' && request.method === 'GET') {
        return send(await loadLB());
      }

      if (url.pathname === '/register' && request.method === 'POST') {
        const b = await request.json();
        const name = clean(b.name, 16).trim();
        const secret = clean(b.secret, 64);
        const recovery = clean(b.recovery, 32).trim();
        const err = nameError(name);
        if (err) return send({ ok: false, error: err }, 400);
        if (secret.length < 8) return send({ ok: false, error: 'bad secret' }, 400);
        const nl = name.toLowerCase();
        const existing = await loadId(nl);
        if (existing) {
          if (existing.secret === secret) return send({ ok: true, existing: true, name: existing.name, streak: existing.streak || 0, best: existing.best || 0, hasRecovery: !!existing.recoveryHash });
          return send({ ok: false, error: 'That name is taken.' }, 409);
        }
        const rec = { name, secret, streak: 0, best: 0, lastDay: 0, createdTs: Date.now() };
        // Only meaningful on a brand-new claim — an existing name keeps
        // whatever recovery phrase it already has (set via /recovery-set).
        if (recovery.length >= 4) {
          const salt = randSaltHex();
          rec.recoverySalt = salt;
          rec.recoveryHash = await hashRecovery(salt, recovery);
        }
        await saveId(nl, rec);
        return send({ ok: true, existing: false, name, streak: 0, best: 0, hasRecovery: !!rec.recoveryHash });
      }

      if (url.pathname === '/recovery-set' && request.method === 'POST') {
        const b = await request.json();
        const name = clean(b.name, 16).trim();
        const secret = clean(b.secret, 64);
        const recovery = clean(b.recovery, 32).trim();
        const nl = name.toLowerCase();
        const rec = await loadId(nl);
        if (!rec || rec.secret !== secret) return send({ ok: false, error: 'not your name' }, 403);
        if (recovery.length < 4) return send({ ok: false, error: 'Recovery phrase must be at least 4 characters.' }, 400);
        const salt = randSaltHex();
        rec.recoverySalt = salt;
        rec.recoveryHash = await hashRecovery(salt, recovery);
        await saveId(nl, rec);
        return send({ ok: true });
      }

      // Reassign an already-claimed name to a NEW device's secret, proven by
      // the recovery phrase instead of the original device's secret. This is
      // the only account-recovery path that exists (no login/email), so it's
      // throttled per-name against brute-forcing a low-entropy phrase.
      if (url.pathname === '/recover' && request.method === 'POST') {
        const b = await request.json();
        const name = clean(b.name, 16).trim();
        const recovery = clean(b.recovery, 32).trim();
        const newSecret = clean(b.newSecret, 64);
        if (newSecret.length < 8) return send({ ok: false, error: 'bad secret' }, 400);
        const nl = name.toLowerCase();
        const rec = await loadId(nl);
        if (!rec || !rec.recoveryHash) return send({ ok: false, error: 'No recovery phrase set for this name.' }, 404);

        const now = Date.now();
        const cooling = (rec.recoveryFails || 0) >= RECOVERY_MAX_FAILS && now - (rec.recoveryFailAt || 0) < RECOVERY_COOLDOWN_MS;
        if (cooling) return send({ ok: false, error: 'Too many attempts — try again later.' }, 429);

        const candidate = await hashRecovery(rec.recoverySalt, recovery);
        if (candidate !== rec.recoveryHash) {
          const withinWindow = now - (rec.recoveryFailAt || 0) < RECOVERY_COOLDOWN_MS;
          rec.recoveryFails = withinWindow ? (rec.recoveryFails || 0) + 1 : 1;
          rec.recoveryFailAt = now;
          await saveId(nl, rec);
          return send({ ok: false, error: 'Wrong recovery phrase.' }, 403);
        }

        rec.secret = newSecret;
        rec.recoveryFails = 0;
        await saveId(nl, rec);
        return send({ ok: true, name: rec.name, streak: rec.streak || 0, best: rec.best || 0 });
      }

      if (url.pathname === '/daily' && request.method === 'POST') {
        const b = await request.json();
        const name = clean(b.name, 16).trim();
        const secret = clean(b.secret, 64);
        const won = b.won === true;
        const nl = name.toLowerCase();
        const rec = await loadId(nl);
        if (!rec || rec.secret !== secret) return send({ ok: false, error: 'not your name' }, 403);
        const utcDay = serverDay();
        let today = num(b.day);
        if (!today || Math.abs(today - utcDay) > 1) today = utcDay;
        const alreadyToday = rec.lastDay === today;
        // The streak is computed here from the record's own day history —
        // NOT trusted from the client — so a browser can no longer just POST
        // an arbitrary streak/best to fake the leaderboard. `lastDay` has
        // always been server-maintained (the client only ever supplied a
        // hint used to sanity-check clock skew above), so switching to
        // deriving streak/best from it picks up exactly where every existing
        // record already was — no reset, no discontinuity for current users.
        const week = Math.floor(today / 7);
        if (!alreadyToday) {
          rec.streak = won ? (rec.lastDay === today - 1 ? (rec.streak || 0) + 1 : 1) : 0;
          rec.best = Math.max(rec.best || 0, rec.streak);
          if (rec.weekIndex !== week) { rec.weekIndex = week; rec.weekWins = 0; }
          if (won) rec.weekWins = (rec.weekWins || 0) + 1;
          rec.lastDay = today;
        }
        await saveId(nl, rec);
        const data = await loadLB();
        if (rec.best > 0) upsertStreak(data, rec.name, rec.best);
        if (!data.weekly || data.weekly.weekIndex !== week) data.weekly = { weekIndex: week, entries: [] };
        if (won && !alreadyToday) {
          const we = data.weekly.entries.find(e => (e.name || '').toLowerCase() === rec.name.toLowerCase());
          if (we) we.wins = rec.weekWins;
          else data.weekly.entries.push({ name: rec.name, wins: rec.weekWins });
          data.weekly.entries.sort((a, b) => (b.wins || 0) - (a.wins || 0));
          data.weekly.entries = data.weekly.entries.slice(0, 50);
        }
        await saveLB(data);
        return send({ ok: true, streak: rec.streak, best: rec.best, weekWins: rec.weekWins, already: alreadyToday });
      }

      if (url.pathname === '/result' && request.method === 'POST') {
        const e = await request.json();
        const entry = {
          winner: clean(e.winner, 24),
          winnerColor: clean(e.winnerColor, 12),
          score: Math.max(0, Math.min(999999, num(e.score))),
          mode: e.mode === 'points' ? 'points' : 'last',
          rounds: e.rounds ? Math.max(1, Math.min(50, num(e.rounds))) : null,
          players: Array.isArray(e.players) ? e.players.slice(0, 12).map(p => clean(p, 24)) : [],
          totalGuesses: Math.max(0, Math.min(99999, num(e.totalGuesses))),
          ts: Date.now(),
        };
        if (!entry.winner) return send({ error: 'bad input' }, 400);
        const data = await loadLB();
        data.recentGames = [entry, ...(data.recentGames || [])].slice(0, 20);
        if (entry.mode === 'points') {
          data.topScores = data.topScores || [];
          data.topScores.push({ name: entry.winner, score: entry.score, players: entry.players, ts: entry.ts });
          data.topScores.sort((a, b) => (b.score || 0) - (a.score || 0));
          data.topScores = data.topScores.slice(0, 10);
        }
        data.longestGames = data.longestGames || [];
        data.longestGames.push({ winner: entry.winner, winnerColor: entry.winnerColor, totalGuesses: entry.totalGuesses, players: entry.players, ts: entry.ts });
        data.longestGames.sort((a, b) => (b.totalGuesses || 0) - (a.totalGuesses || 0));
        data.longestGames = data.longestGames.slice(0, 10);
        await saveLB(data);
        return send({ ok: true });
      }

      return send({ error: 'not found' }, 404);
    } catch (err) {
      return send({ error: 'server error' }, 500);
    }
  }
};
