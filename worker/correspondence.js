// ============================================================================
// WordJab — Correspondence (async, turn-by-turn) play
// ============================================================================
//
// This is an ADDITIVE module for the existing `wordjab-api` Cloudflare Worker.
// It does NOT touch the existing /leaderboard, /register, /daily, or /result
// endpoints — paste it into the deployed Worker and add ONE line to the router
// (see "HOW TO INSTALL" at the bottom of this file). The correspondence system
// is server-authoritative: game state (including every player's secret word)
// lives in KV, not in a host's browser, so a correspondence game survives
// everyone leaving — which is also why it sidesteps the live-game disconnect
// problem entirely.
//
// Storage (same KV namespace bound as env.LEADERBOARD):
//   corr:<gameId>       -> full server-side game record (holds every word)
//   corrcode:<CODE>     -> gameId, so a 4-letter code can be joined (removed
//                          once the match starts)
//   corridx:<namelower> -> JSON array of gameIds this player is in (bounded)
//   id:<namelower>      -> per-identity record, SHARED with /register + /daily
//                          (same shape) so a name reserved here is the same
//                          reserved name everywhere.
//
// Model: 2–6 players, Last-Standing. The creator picks how many players the
// match is for; everyone else joins by code and hides a secret word. The match
// starts when it fills up (or the creator starts it early with >=2 in). On your
// turn you pick a still-standing opponent and throw a letter at their board: a
// hit reveals every matching tile and you jab again (turn stays); a miss passes
// to the next player. Crack a board and that player is out; last one standing
// wins. Blanks reveal one-at-a-time (position leaks nothing) — the same rules
// as the live game's processGuess().
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
  // A real letter can only be thrown at a given board once. Blanks are special:
  // they reveal one-at-a-time, so repeated space guesses are allowed until one
  // MISSES (which records ' ' in `wrong`) — proving the padding is exhausted.
  // This matches the live game, which keeps the blank button live until a miss.
  if (lc === ' ') {
    if (target.wrong.includes(' ')) return { error: 'dup' };
  } else if (alreadyRevealed || target.wrong.includes(lc)) {
    return { error: 'dup' };
  }

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
    // Record every miss — including a missed blank, which marks the padding dry
    // so the blank can't be thrown at this board again.
    target.wrong.push(lc);
    game.turn = corrNextTurn(game, gi);
    game.lastMove = { by: guesser.name, letter: lc, result: 'miss', targetIdx, targetName: target.name, revealedIdxs: [] };
  }
  return { ok: true };
}

// ── Endpoint handlers ───────────────────────────────────────────────────────

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
    case '/corr/create':  return corrCreate(env, body);
    case '/corr/join':    return corrJoin(env, body);
    case '/corr/start':   return corrStart(env, body);
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
