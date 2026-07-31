// ============================================================================
// WordJab — Correspondence (async, turn-by-turn) play
// ============================================================================
//
// This is an ADDITIVE module for the existing `wordjab-api` Cloudflare Worker.
// It does NOT touch the existing /leaderboard, /register, /daily, or /result
// endpoints — paste it into the deployed Worker and add ONE line to the router
// (see "HOW TO INSTALL" at the bottom of this file). The correspondence system
// is server-authoritative: game state (including both players' secret words)
// lives in KV, not in a host's browser, so a correspondence game survives
// everyone leaving — which is also why it sidesteps the live-game disconnect
// problem entirely.
//
// Storage (same KV namespace bound as env.LEADERBOARD):
//   corr:<gameId>       -> full server-side game record (holds both words)
//   corrcode:<CODE>     -> gameId, so a 4-letter code can be joined (removed
//                          once the second player joins)
//   corridx:<namelower> -> JSON array of gameIds this player is in (bounded)
//   id:<namelower>      -> per-identity record, SHARED with /register + /daily
//                          (same shape) so a name reserved here is the same
//                          reserved name everywhere.
//
// Model: 2-player, Last-Standing. Each player hides a secret word; players take
// turns throwing letters at the opponent's board. A hit reveals every matching
// tile and you jab again (turn stays); a miss passes the turn. First to fully
// crack the opponent's word wins. Blanks reveal one-at-a-time (position leaks
// nothing) — the same rule as the live game's processGuess().
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
const CORR_IDX_CAP = 25;        // most-recent games kept in a player's index
const CORR_STREAK_CAP = 3650;   // matches /daily sanity cap (for fresh claims)

function corrCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no ambiguous O/0 I/1, matches client
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function corrId() {
  return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function corrWeekIndex(day) {
  // Weekly buckets keyed off the client's local day number, same basis the rest
  // of the leaderboard uses. `day` is optional; only used when claiming fresh.
  return Math.floor((day || 0) / 7);
}

// Claim/verify a name via the shared id:<lower> record. Returns
// { ok:true } if the caller owns the name (or it was free and is now theirs),
// or { taken:true } if a different secret already holds it. Fresh claims are
// written in the SAME shape /register + /daily use, so nothing downstream breaks.
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

// Client-facing view of a game. The requester sees their OWN word in full, but
// the opponent's unrevealed tiles are redacted to null — the secret never leaves
// the server until a letter actually cracks it open.
function corrRedact(game, meName) {
  const meIdx = corrPlayerIndex(game, meName);
  const over = game.phase === 'finished'; // reveal both words once the game is done
  const players = game.players.map((p, i) => {
    if (!p) return null;
    const mine = i === meIdx;
    return {
      name: p.name,
      eliminated: !!p.eliminated,
      resigned: !!p.resigned,
      guessed: p.guessed || [],
      tiles: (p.tiles || []).map(t => ({
        char: (mine || t.revealed || over) ? t.char : null,
        revealed: !!t.revealed,
      })),
    };
  });
  const yourTurn = game.phase === 'active' && meIdx >= 0 && game.turn === meIdx;
  return {
    id: game.id, code: game.code, charCount: game.charCount,
    phase: game.phase, turn: game.turn, winner: game.winner || null,
    yourIndex: meIdx, yourTurn,
    players, lastMove: game.lastMove || null,
    createdTs: game.createdTs, updatedTs: game.updatedTs,
  };
}

// Apply one letter guess by the player whose turn it is. Mirrors the client's
// processGuess: hit reveals all matching tiles (blanks one-at-a-time) and the
// turn stays; miss passes the turn. Cracking the opponent's board wins.
function corrApplyGuess(game, letter) {
  const gi = game.turn;
  const ti = gi === 0 ? 1 : 0;
  const guesser = game.players[gi];
  const target = game.players[ti];
  const lc = String(letter || '').toLowerCase();
  if (!lc || lc.length !== 1) return { error: 'bad-letter' };
  if (!/^[a-z ]$/.test(lc)) return { error: 'bad-letter' };
  if (!guesser.guessed) guesser.guessed = [];
  // A real letter can only be tried once. Spaces are exempt: blanks reveal
  // one-at-a-time, so you must be able to keep jabbing spaces to clear padding
  // (the same as the live game, which never locks out repeated space guesses).
  if (lc !== ' ' && guesser.guessed.includes(lc)) return { error: 'dup' };

  let hitIdxs = [];
  target.tiles.forEach((t, i) => {
    if (!t.revealed && t.char && t.char.toLowerCase() === lc) hitIdxs.push(i);
  });
  // Blanks: reveal just one (random) so a single space guess can't strip all padding.
  if (lc === ' ' && hitIdxs.length > 1) {
    hitIdxs = [hitIdxs[Math.floor(Math.random() * hitIdxs.length)]];
  }

  if (lc !== ' ') guesser.guessed.push(lc);

  if (hitIdxs.length > 0) {
    hitIdxs.forEach(i => { target.tiles[i].revealed = true; });
    const cracked = target.tiles.every(t => t.revealed);
    if (cracked) {
      target.eliminated = true;
      game.phase = 'finished';
      game.winner = guesser.name;
      game.lastMove = { by: guesser.name, letter: lc, result: 'crack', targetIdx: ti, revealedIdxs: hitIdxs };
    } else {
      // Hit — same player keeps the turn (jab again).
      game.lastMove = { by: guesser.name, letter: lc, result: 'hit', targetIdx: ti, revealedIdxs: hitIdxs };
    }
  } else {
    // Miss — turn passes to the opponent.
    game.turn = ti;
    game.lastMove = { by: guesser.name, letter: lc, result: 'miss', targetIdx: ti, revealedIdxs: [] };
  }
  return { ok: true };
}

// ── Endpoint handlers ───────────────────────────────────────────────────────

async function corrCreate(env, body) {
  const { name, secret, word, charCount, day } = body;
  const own = await corrOwnName(env, name, secret);
  if (own.bad) return corrJson({ ok: false, error: 'bad-name' }, 400);
  if (own.taken) return corrJson({ ok: false, taken: true }, 409);

  let size = parseInt(charCount, 10);
  if (isNaN(size)) size = 10;
  size = Math.max(CORR_MIN_WORD, Math.min(CORR_MAX_WORD, size));
  const clean = corrCleanWord(word, size);
  if (clean.trim().length < 1) return corrJson({ ok: false, error: 'empty-word' }, 400);

  // Reserve a game id + a non-colliding join code.
  const id = corrId();
  let code = corrCode();
  for (let i = 0; i < 5; i++) {
    let existing = null;
    try { existing = await env.LEADERBOARD.get('corrcode:' + code); } catch (e) {}
    if (!existing) break;
    code = corrCode();
  }

  const game = {
    id, code, charCount: size, mode: 'last', phase: 'waiting',
    turn: 0, winner: null, createdTs: Date.now(), updatedTs: Date.now(),
    lastMove: null,
    players: [
      { name, nameLower: String(name).toLowerCase(), tiles: corrMakeTiles(clean), guessed: [], eliminated: false },
      null,
    ],
  };
  await corrSave(env, game);
  try { await env.LEADERBOARD.put('corrcode:' + code, id, { expirationTtl: 60 * 60 * 24 * 7 }); } catch (e) {}
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
  if (game.phase !== 'waiting' || game.players[1]) return corrJson({ ok: false, error: 'full' }, 409);
  if (game.players[0] && game.players[0].nameLower === String(name).toLowerCase()) {
    return corrJson({ ok: false, error: 'self' }, 409);
  }

  const clean = corrCleanWord(word, game.charCount);
  if (clean.trim().length < 1) return corrJson({ ok: false, error: 'empty-word' }, 400);

  game.players[1] = { name, nameLower: String(name).toLowerCase(), tiles: corrMakeTiles(clean), guessed: [], eliminated: false };
  game.phase = 'active';
  game.turn = Math.random() < 0.5 ? 0 : 1; // coin flip for first jab
  await corrSave(env, game);
  try { await env.LEADERBOARD.delete('corrcode:' + up); } catch (e) {}
  await corrIdxAdd(env, name, gameId);
  return corrJson({ ok: true, gameId, game: corrRedact(game, name) });
}

async function corrMove(env, body) {
  const { name, secret, gameId, letter } = body;
  const own = await corrOwnName(env, name, secret);
  if (own.bad) return corrJson({ ok: false, error: 'bad-name' }, 400);
  if (own.taken) return corrJson({ ok: false, taken: true }, 409);

  const game = await corrLoad(env, gameId);
  if (!game) return corrJson({ ok: false, error: 'not-found' }, 404);
  const meIdx = corrPlayerIndex(game, name);
  if (meIdx < 0) return corrJson({ ok: false, error: 'not-a-player' }, 403);
  if (game.phase !== 'active') return corrJson({ ok: false, error: 'not-active', game: corrRedact(game, name) }, 409);
  if (game.turn !== meIdx) return corrJson({ ok: false, error: 'not-your-turn', game: corrRedact(game, name) }, 409);

  const res = corrApplyGuess(game, letter);
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
  const other = game.players[meIdx === 0 ? 1 : 0];
  game.players[meIdx].resigned = true;
  game.players[meIdx].eliminated = true;
  game.phase = 'finished';
  game.winner = other ? other.name : null;
  game.lastMove = { by: name, result: 'resign' };
  await corrSave(env, game);
  return corrJson({ ok: true, game: corrRedact(game, name) });
}

async function corrList(env, body) {
  const { name } = body;
  const lower = String(name || '').toLowerCase();
  if (!lower) return corrJson({ ok: true, games: [] });
  let ids = [];
  try { ids = (await env.LEADERBOARD.get('corridx:' + lower, 'json')) || []; } catch (e) {}
  const games = [];
  for (const id of ids) {
    const g = await corrLoad(env, id);
    if (!g) continue;
    const meIdx = corrPlayerIndex(g, name);
    if (meIdx < 0) continue;
    const opp = g.players[meIdx === 0 ? 1 : 0];
    games.push({
      id: g.id, code: g.code, phase: g.phase,
      opponent: opp ? opp.name : null,
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
    case '/corr/create':  return corrCreate(env, body);
    case '/corr/join':    return corrJoin(env, body);
    case '/corr/move':    return corrMove(env, body);
    case '/corr/state':   return corrStateEndpoint(env, body);
    case '/corr/resign':  return corrResign(env, body);
    case '/corr/list':    return corrList(env, body);
    default:              return corrJson({ ok: false, error: 'unknown' }, 404);
  }
}

// Export for module-syntax Workers. Harmless in the classic dashboard editor.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { handleCorrespondence };
}

// ============================================================================
// HOW TO INSTALL (manual paste — the sandbox can't deploy the Worker):
//
// 1) Paste everything ABOVE this comment block into the deployed `wordjab-api`
//    Worker, near the top (after any existing top-level consts is fine).
//
// 2) In the Worker's `fetch(request, env)` handler, right after you compute
//    the URL/path and BEFORE your existing `if (path === '/leaderboard')` etc.,
//    add these two lines:
//
//        const corr = await handleCorrespondence(request, env, path);
//        if (corr) return corr;
//
//    (`path` = new URL(request.url).pathname. `env.LEADERBOARD` is the existing
//     KV binding.) That's the only change to existing code — every non-/corr/
//    request falls straight through to your current endpoints untouched.
//
// 3) Deploy. Watch the dashboard editor's habit of inserting a stray `}` on a
//    fast paste — confirm zero parse errors before you hit Deploy.
// ============================================================================
