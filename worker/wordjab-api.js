// ============================================================================
// WordJab — wordjab-api Cloudflare Worker (full source, as deployed)
// ============================================================================
//
// This is the complete script behind https://wordjab-api.dustinramsbottom.workers.dev,
// serving GET /leaderboard and POST /register, /login, /me, /daily, /result,
// /recovery-set, /corr/*, plus a cron that rebuilds the streak board.
// It's the merge of the original leaderboard/streak Worker with the additive
// Correspondence module (worker/correspondence.js in this repo) — that file
// stays in the repo separately as the documented, standalone version of the
// /corr/* module (with its own install notes), but this file is the one
// source of truth for what's actually running in production.
//
// Storage: a single KV namespace bound as env.LEADERBOARD.
//   leaderboard          -> { topScores, longestGames, recentGames, dailyStreaks, weekly }
//                            dailyStreaks/weekly are a derived index of the
//                            id: records (see rebuildBoard), never the truth.
//   id:<namelower>        -> { name, secret, secrets[], streak, best, lastDay,
//                              lastResult, lastRoundsLeft, weekIndex, weekWins,
//                              recoverySalt, recoveryHash, createdTs }
//                            One record per claimed name — the source of truth
//                            for that player's streak. `secret` / `secrets`
//                            are the per-device tokens that prove ownership
//                            (a device joins `secrets` by signing in with the
//                            name's password, stored as recoveryHash). Saved
//                            with KV metadata (idMeta) so the board rebuild
//                            can list every player without a get() each.
//                            /register, /daily, and every /corr/* endpoint all
//                            read/write this same shape, so a name claimed
//                            anywhere is reserved everywhere.
//   corr:<gameId>         -> full server-side Correspondence game record
//   corrcode:<CODE>       -> gameId, so a 4-letter code can be joined
//   corridx:<namelower>   -> JSON array of gameIds this player is in (bounded)
//
// Deploying changes: .github/workflows/deploy-worker.yml runs `wrangler
// deploy` (config in worker/wrangler.jsonc) on every push to main that
// touches worker/**. The Cloudflare dashboard editor remains the emergency
// rollback surface.
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

// A name's record can be held by several devices at once: `secret` is the
// one that first claimed it, `secrets` holds every other device that has
// since signed in with the name's password. Any of them proves ownership.
function idOwns(rec, secret) {
  if (!rec || !secret) return false;
  return rec.secret === secret || (Array.isArray(rec.secrets) && rec.secrets.includes(secret));
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
  if (rec && rec.secret && !idOwns(rec, secret)) return { taken: true };
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

// Take a match off your "your matches" list. A match you're still in is
// resigned first (a waiting request you created is cancelled, and its join
// code stops working); a finished one is just hidden. Removing only ever
// touches your own list — other players keep theirs.
async function corrDismiss(env, body) {
  const { name, secret, gameId } = body;
  const own = await corrOwnName(env, name, secret);
  if (own.bad) return corrJson({ ok: false, error: 'bad-name' }, 400);
  if (own.taken) return corrJson({ ok: false, taken: true }, 409);
  const game = await corrLoad(env, gameId);
  if (game) {
    const meIdx = corrPlayerIndex(game, name);
    if (meIdx >= 0 && game.phase !== 'finished' && !game.players[meIdx].eliminated) {
      await corrResign(env, body);
    }
    const after = await corrLoad(env, gameId);
    if (after && after.phase !== 'waiting') {
      try { await env.LEADERBOARD.delete('corrcode:' + after.code); } catch (e) {}
    }
  }
  const key = 'corridx:' + String(name).toLowerCase();
  let list = [];
  try { list = (await env.LEADERBOARD.get(key, 'json')) || []; } catch (e) {}
  try { await env.LEADERBOARD.put(key, JSON.stringify(list.filter(id => id !== gameId))); } catch (e) {}
  return corrJson({ ok: true });
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
    case '/corr/dismiss': return corrDismiss(env, body);
    case '/corr/list': return corrList(env, body);
    default: return corrJson({ ok: false, error: 'unknown' }, 404);
  }
}

// ── Accounts, streaks and the leaderboard ──────────────────────────────────
//
// The per-name record (id:<lower>) is the ONLY source of truth for a
// player's streak. The `leaderboard` blob is a derived, read-optimised index
// of those records: /daily and /me write through to it right away, and the
// scheduled rebuild (see `scheduled` at the bottom) regenerates its streak
// and weekly sections straight from the id: records every few minutes. So an
// entry lost to a concurrent write (KV is last-write-wins, and reads can be
// up to ~60s stale at the edge) always heals, rather than silently vanishing.

const LB_KEY = 'leaderboard';
const EPOCH = Date.UTC(2024, 0, 1);
const serverDay = () => Math.floor((Date.now() - EPOCH) / 86400000);
const MAX_DEVICE_SECRETS = 20;       // devices that can be signed in to one name at once
const BOARD_BEST_KEEP = 50;          // all-time best streaks kept on the board
const BOARD_ACTIVE_KEEP = 500;       // live streaks kept on the board
const BOARD_WEEKLY_KEEP = 100;
const RECOVERY_MAX_FAILS = 8;
const RECOVERY_COOLDOWN_MS = 60 * 60 * 1000;

const clean = (s, n) => String(s == null ? '' : s).slice(0, n);
const num = (v) => { const x = parseInt(v); return isNaN(x) ? 0 : x; };

const BAD = ['fuck', 'shit', 'cunt', 'nigg', 'fagg', 'bitch', 'cock', 'dick', 'puss', 'whore', 'slut', 'rape', 'nazi', 'hitler'];
function nameError(name) {
  if (!/^[a-zA-Z0-9 _-]{2,16}$/.test(name)) return 'Name must be 2-16 letters, numbers, or spaces.';
  const flat = name.toLowerCase().replace(/[^a-z]/g, '');
  if (BAD.some(w => flat.includes(w))) return 'Pick a friendlier name.';
  return null;
}

async function loadLB(env) {
  const r = await env.LEADERBOARD.get(LB_KEY);
  const d = r ? JSON.parse(r) : {};
  return {
    topScores: d.topScores || [], longestGames: d.longestGames || [], recentGames: d.recentGames || [],
    dailyStreaks: d.dailyStreaks || [], weekly: d.weekly || { weekIndex: 0, entries: [] },
  };
}
const saveLB = (env, d) => env.LEADERBOARD.put(LB_KEY, JSON.stringify(d));

// Compact copy of the fields the leaderboard needs, stored as KV metadata on
// every id: record so the scheduled rebuild can read the whole player base
// from `list()` alone, without a get() per player.
function idMeta(rec) {
  return {
    v: 1, n: rec.name, s: rec.streak || 0, b: rec.best || 0, d: rec.lastDay || 0,
    wi: rec.weekIndex || 0, ww: rec.weekWins || 0,
  };
}
const loadId = (env, nl) => env.LEADERBOARD.get('id:' + nl, 'json');
const saveId = (env, nl, rec) => env.LEADERBOARD.put('id:' + nl, JSON.stringify(rec), { metadata: idMeta(rec) });

// Registers a device secret against a name. Additive: signing in on a new
// device (or in the iPhone home-screen app, which has its own storage,
// separate from Safari's) never signs any other device out.
function addSecret(rec, secret) {
  if (idOwns(rec, secret)) return;
  const others = (rec.secrets || []).filter(s => s !== secret && s !== rec.secret);
  rec.secrets = [secret, ...others].slice(0, MAX_DEVICE_SECRETS);
}

// The client's local day (days since 2024-01-01 in the player's own time
// zone). Honest clients are always within a day of UTC; a result from the
// day before (queued offline, flushed after midnight) is allowed too.
// Returns null for anything outside that window rather than silently
// re-dating it to today.
function clientDay(b) {
  const utc = serverDay();
  if (b.day == null) return utc; // very old clients never sent one
  const d = num(b.day);
  if (d < utc - 2 || d > utc + 1) return null;
  return d;
}

// A streak is only still alive if the last result was yesterday or today.
const liveStreak = (streak, lastDay, today) => (lastDay >= today - 1 ? (streak || 0) : 0);

function profile(rec, today) {
  const week = Math.floor(today / 7);
  const lastDay = rec.lastDay || 0;
  return {
    name: rec.name,
    streak: liveStreak(rec.streak, lastDay, today),
    best: rec.best || 0,
    lastDay,
    lastResult: rec.lastResult || (lastDay ? ((rec.streak || 0) > 0 ? 'win' : 'lose') : null),
    lastRoundsLeft: rec.lastRoundsLeft == null ? null : rec.lastRoundsLeft,
    weekWins: rec.weekIndex === week ? (rec.weekWins || 0) : 0,
    hasPassword: !!rec.recoveryHash,
    today,
  };
}

// Board entry pruning: the all-time top bests, plus every streak that's
// still alive (so a 1-day streak started today shows up too, not just the
// veterans).
function pruneStreaks(list, today) {
  const byName = new Map();
  for (let e of list) {
    if (!e || !e.name) continue;
    // Pre-2026-09 entries stored only the best streak, under `streak`.
    if (e.best == null) e = { name: e.name, streak: 0, best: e.streak || 0, lastDay: 0, ts: e.ts || 0 };
    const k = e.name.toLowerCase();
    const prev = byName.get(k);
    if (!prev || (e.ts || 0) >= (prev.ts || 0)) byName.set(k, e);
  }
  const all = [...byName.values()];
  const keep = new Set();
  all.slice().sort((a, b) => (b.best || 0) - (a.best || 0)).slice(0, BOARD_BEST_KEEP)
    .forEach(e => { if ((e.best || 0) > 0) keep.add(e); });
  all.filter(e => (e.lastDay || 0) >= today - 2 && (e.streak || 0) > 0)
    .sort((a, b) => (b.streak || 0) - (a.streak || 0)).slice(0, BOARD_ACTIVE_KEEP)
    .forEach(e => keep.add(e));
  return [...keep].sort((a, b) => (b.best || 0) - (a.best || 0));
}

function boardEntry(rec) {
  return { name: rec.name, streak: rec.streak || 0, best: rec.best || 0, lastDay: rec.lastDay || 0, ts: Date.now() };
}

// Writes one player's record into the board blob. Returns true if anything changed.
function upsertPlayer(data, rec, today) {
  let changed = false;
  const nl = rec.name.toLowerCase();
  const list = data.dailyStreaks;
  const i = list.findIndex(e => (e.name || '').toLowerCase() === nl);
  const cur = i >= 0 ? list[i] : null;
  const want = boardEntry(rec);
  if ((want.best > 0 || want.streak > 0) &&
      (!cur || cur.name !== want.name || cur.streak !== want.streak || cur.best !== want.best || cur.lastDay !== want.lastDay)) {
    if (i >= 0) list[i] = want; else list.push(want);
    data.dailyStreaks = pruneStreaks(list, today);
    changed = true;
  }
  const week = Math.floor(today / 7);
  if (rec.weekIndex === week && (rec.weekWins || 0) > 0) {
    if (!data.weekly || data.weekly.weekIndex !== week) { data.weekly = { weekIndex: week, entries: [] }; changed = true; }
    const we = data.weekly.entries.find(e => (e.name || '').toLowerCase() === nl);
    if (!we || we.wins !== rec.weekWins || we.name !== rec.name) {
      if (we) { we.wins = rec.weekWins; we.name = rec.name; }
      else data.weekly.entries.push({ name: rec.name, wins: rec.weekWins });
      data.weekly.entries.sort((a, b) => (b.wins || 0) - (a.wins || 0));
      data.weekly.entries = data.weekly.entries.slice(0, BOARD_WEEKLY_KEEP);
      changed = true;
    }
  }
  return changed;
}

// Adds each streak's live value (`current`) for display. Uses a day of slack
// because the server doesn't know each player's time zone.
function withLiveStreaks(data) {
  const utc = serverDay();
  data.dailyStreaks = (data.dailyStreaks || []).map(e => {
    // Pre-2026-09 entries stored only the best streak, under `streak`.
    const best = e.best != null ? e.best : (e.streak || 0);
    const current = e.lastDay != null ? ((e.lastDay >= utc - 2) ? (e.streak || 0) : 0) : null;
    return { ...e, best, current };
  });
  return data;
}

// Regenerates the streak + weekly sections of the board from every id:
// record. Scheduled; also safe to run by hand.
async function rebuildBoard(env) {
  const today = serverDay();
  const week = Math.floor(today / 7);
  const metas = [];
  let cursor, backfills = 0;
  do {
    const page = await env.LEADERBOARD.list({ prefix: 'id:', cursor });
    for (const k of page.keys) {
      let m = k.metadata;
      if (!m || m.v !== 1) {
        // Records written before metadata existed: read once, then re-save
        // with metadata so later rebuilds never need to read them again.
        if (backfills >= 100) continue;
        backfills++;
        const rec = await env.LEADERBOARD.get(k.name, 'json');
        if (!rec || !rec.name) continue;
        await saveId(env, k.name.slice(3), rec);
        m = idMeta(rec);
      }
      metas.push(m);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  const data = await loadLB(env);
  // Keep any board entry whose record wasn't read this run (backfill cap), so
  // a partial rebuild never drops anyone.
  const seen = new Set(metas.map(m => m.n.toLowerCase()));
  const carried = data.dailyStreaks.filter(e => e && e.name && !seen.has(e.name.toLowerCase()));
  const fresh = metas.filter(m => m.b > 0 || m.s > 0)
    .map(m => ({ name: m.n, streak: m.s, best: m.b, lastDay: m.d, ts: Date.now() }));
  data.dailyStreaks = pruneStreaks([...carried, ...fresh], today);

  const carriedWeek = (data.weekly && data.weekly.weekIndex === week ? data.weekly.entries : [])
    .filter(e => e && e.name && !seen.has(e.name.toLowerCase()));
  data.weekly = {
    weekIndex: week,
    entries: [...carriedWeek, ...metas.filter(m => m.wi === week && m.ww > 0).map(m => ({ name: m.n, wins: m.ww }))]
      .sort((a, b) => (b.wins || 0) - (a.wins || 0)).slice(0, BOARD_WEEKLY_KEEP),
  };
  await saveLB(env, data);
  return { players: metas.length, backfills };
}

// Password (stored as the salted `recoveryHash` — the field predates it being
// called a password, and existing recovery phrases keep working as one).
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
async function setPassword(rec, password) {
  rec.recoverySalt = randSaltHex();
  rec.recoveryHash = await hashRecovery(rec.recoverySalt, password);
}

// Checks a password against a record, throttled per name against guessing.
// Returns null on success, else { status, error }. Mutates rec's fail counters
// (caller saves).
async function checkPassword(rec, password) {
  if (!rec.recoveryHash) return { status: 409, error: 'That name is taken.' };
  const now = Date.now();
  if ((rec.recoveryFails || 0) >= RECOVERY_MAX_FAILS && now - (rec.recoveryFailAt || 0) < RECOVERY_COOLDOWN_MS) {
    return { status: 429, error: 'Too many attempts — try again in an hour.' };
  }
  if ((await hashRecovery(rec.recoverySalt, password)) !== rec.recoveryHash) {
    const withinWindow = now - (rec.recoveryFailAt || 0) < RECOVERY_COOLDOWN_MS;
    rec.recoveryFails = withinWindow ? (rec.recoveryFails || 0) + 1 : 1;
    rec.recoveryFailAt = now;
    return { status: 403, error: 'Wrong password for that name.' };
  }
  rec.recoveryFails = 0;
  return null;
}

// ── Main router: /leaderboard, /register, /login, /me, /daily, /result, /corr/* ──

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
    // no-store: iOS Safari (and the home-screen app especially) must never
    // answer a leaderboard or profile request from its HTTP cache.
    const send = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

    try {
      if (url.pathname === '/leaderboard' && request.method === 'GET') {
        return send(withLiveStreaks(await loadLB(env)));
      }

      // Create a name, or sign in to one. Same endpoint for both so the
      // client has a single "name + password" form:
      //   - name free             -> claimed for this device (optionally with
      //                              a password and a carried-over streak)
      //   - this device owns it   -> ok
      //   - owned elsewhere + right password -> this device is added (sign in)
      //   - owned elsewhere otherwise        -> 409 / 403 / 429
      if (url.pathname === '/register' && request.method === 'POST') {
        const b = await request.json();
        const name = clean(b.name, 16).trim();
        const secret = clean(b.secret, 64);
        const password = clean(b.password != null ? b.password : b.recovery, 32).trim();
        const err = nameError(name);
        if (err) return send({ ok: false, error: err }, 400);
        if (secret.length < 8) return send({ ok: false, error: 'bad secret' }, 400);
        const today = clientDay(b) ?? serverDay();
        const nl = name.toLowerCase();
        const existing = await loadId(env, nl);
        if (existing) {
          if (idOwns(existing, secret)) {
            return send({ ok: true, existing: true, name: existing.name, streak: existing.streak || 0, best: existing.best || 0, hasRecovery: !!existing.recoveryHash, profile: profile(existing, today) });
          }
          if (!password) return send({ ok: false, error: 'That name is taken.', hasPassword: !!existing.recoveryHash }, 409);
          const bad = await checkPassword(existing, password);
          if (bad) {
            if (bad.status === 403) await saveId(env, nl, existing);
            return send({ ok: false, error: bad.error, hasPassword: !!existing.recoveryHash }, bad.status);
          }
          addSecret(existing, secret);
          await saveId(env, nl, existing);
          return send({ ok: true, existing: true, signedIn: true, name: existing.name, streak: existing.streak || 0, best: existing.best || 0, hasRecovery: true, profile: profile(existing, today) });
        }
        const rec = { name, secret, streak: 0, best: 0, lastDay: 0, createdTs: Date.now() };
        if (password.length >= 4) await setPassword(rec, password);
        // One-time carry-over of a streak built on this device before the
        // player had a name, so claiming one never resets them to zero.
        // Capped, and only if it's still alive.
        const c = b.carry;
        if (c && typeof c === 'object') {
          const cd = num(c.lastDay);
          if (cd >= today - 1 && cd <= today) {
            rec.streak = Math.max(0, Math.min(30, num(c.streak)));
            rec.best = Math.max(rec.streak, Math.max(0, Math.min(30, num(c.best))));
            rec.lastDay = cd;
            rec.lastResult = c.won === true ? 'win' : 'lose';
            rec.lastRoundsLeft = Math.max(0, Math.min(6, num(c.roundsLeft)));
            if (c.won === true) { rec.weekIndex = Math.floor(cd / 7); rec.weekWins = 1; }
          }
        }
        await saveId(env, nl, rec);
        if (rec.best > 0) {
          const data = await loadLB(env);
          if (upsertPlayer(data, rec, today)) await saveLB(env, data);
        }
        return send({ ok: true, existing: false, name, streak: rec.streak, best: rec.best, hasRecovery: !!rec.recoveryHash, profile: profile(rec, today) });
      }

      // Sign in to an existing name from a new device. Never signs anyone out.
      if ((url.pathname === '/login' || url.pathname === '/recover') && request.method === 'POST') {
        const b = await request.json();
        const name = clean(b.name, 16).trim();
        const password = clean(b.password != null ? b.password : b.recovery, 32).trim();
        const secret = clean(b.secret || b.newSecret, 64);
        if (secret.length < 8) return send({ ok: false, error: 'bad secret' }, 400);
        const nl = name.toLowerCase();
        const rec = await loadId(env, nl);
        if (!rec) return send({ ok: false, error: 'No player with that name.' }, 404);
        if (!rec.recoveryHash) return send({ ok: false, error: 'No password set for this name.' }, 404);
        const bad = await checkPassword(rec, password);
        if (bad) {
          if (bad.status === 403) await saveId(env, nl, rec);
          return send({ ok: false, error: bad.error }, bad.status);
        }
        addSecret(rec, secret);
        await saveId(env, nl, rec);
        const today = clientDay(b) ?? serverDay();
        return send({ ok: true, name: rec.name, streak: rec.streak || 0, best: rec.best || 0, profile: profile(rec, today) });
      }

      // Set or change the password, proven by a signed-in device.
      if (url.pathname === '/recovery-set' && request.method === 'POST') {
        const b = await request.json();
        const name = clean(b.name, 16).trim();
        const secret = clean(b.secret, 64);
        const password = clean(b.password != null ? b.password : b.recovery, 32).trim();
        const nl = name.toLowerCase();
        const rec = await loadId(env, nl);
        if (!idOwns(rec, secret)) return send({ ok: false, error: 'not your name' }, 403);
        if (password.length < 4) return send({ ok: false, error: 'Password must be at least 4 characters.' }, 400);
        await setPassword(rec, password);
        await saveId(env, nl, rec);
        return send({ ok: true });
      }

      // The signed-in player's saved state. Called on every app open/resume,
      // so it also repairs this player's board entry if it ever went missing.
      if (url.pathname === '/me' && request.method === 'POST') {
        const b = await request.json();
        const name = clean(b.name, 16).trim();
        const secret = clean(b.secret, 64);
        const nl = name.toLowerCase();
        const rec = await loadId(env, nl);
        if (!rec) return send({ ok: false, error: 'unknown name' }, 404);
        if (!idOwns(rec, secret)) return send({ ok: false, error: 'not your name' }, 403);
        const today = clientDay(b) ?? serverDay();
        if ((rec.best || 0) > 0 || (rec.weekWins || 0) > 0) {
          const data = await loadLB(env);
          if (upsertPlayer(data, rec, today)) await saveLB(env, data);
        }
        return send({ ok: true, profile: profile(rec, today) });
      }

      if (url.pathname === '/daily' && request.method === 'POST') {
        const b = await request.json();
        const name = clean(b.name, 16).trim();
        const secret = clean(b.secret, 64);
        const won = b.won === true;
        const nl = name.toLowerCase();
        const rec = await loadId(env, nl);
        if (!idOwns(rec, secret)) return send({ ok: false, error: 'not your name' }, 403);
        const today = clientDay(b);
        if (today == null) return send({ ok: false, error: 'stale-day' }, 400);
        // Results arrive in day order from each device, but two devices (or
        // a late offline flush) can deliver an older day after a newer one —
        // that must never rewind the streak.
        if (today < (rec.lastDay || 0)) {
          return send({ ok: true, already: true, stale: true, streak: rec.streak, best: rec.best, weekWins: rec.weekWins, profile: profile(rec, today) });
        }
        const alreadyToday = rec.lastDay === today;
        // The streak is computed here from the record's own day history —
        // never trusted from the client.
        const week = Math.floor(today / 7);
        if (!alreadyToday) {
          rec.streak = won ? (rec.lastDay === today - 1 ? (rec.streak || 0) + 1 : 1) : 0;
          rec.best = Math.max(rec.best || 0, rec.streak);
          if (rec.weekIndex !== week) { rec.weekIndex = week; rec.weekWins = 0; }
          if (won) rec.weekWins = (rec.weekWins || 0) + 1;
          rec.lastDay = today;
          rec.lastResult = won ? 'win' : 'lose';
          rec.lastRoundsLeft = Math.max(0, Math.min(6, num(b.roundsLeft)));
          await saveId(env, nl, rec);
        }
        const data = await loadLB(env);
        if (upsertPlayer(data, rec, today)) await saveLB(env, data);
        return send({ ok: true, streak: rec.streak, best: rec.best, weekWins: rec.weekWins, already: alreadyToday, profile: profile(rec, today) });
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
        const data = await loadLB(env);
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
        await saveLB(env, data);
        return send({ ok: true });
      }

      return send({ error: 'not found' }, 404);
    } catch (err) {
      return send({ error: 'server error' }, 500);
    }
  },

  // Cron (see wrangler.jsonc): re-derive the streak board from the id: records.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(rebuildBoard(env));
  },
};

