export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const send = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    const clean = (s, n) => String(s == null ? '' : s).slice(0, n);
    const num = (v) => { const x = parseInt(v); return isNaN(x) ? 0 : x; };

    // ── storage ──────────────────────────────────────────────────────────────
    const LB_KEY = 'leaderboard';
    const blankLB = { topScores: [], longestGames: [], recentGames: [], dailyStreaks: [], weekly: { weekIndex: 0, entries: [] } };
    const loadLB = async () => { const r = await env.LEADERBOARD.get(LB_KEY); return r ? JSON.parse(r) : { ...blankLB }; };
    const saveLB = (d) => env.LEADERBOARD.put(LB_KEY, JSON.stringify(d));
    const idKey = (nl) => 'id:' + nl;
    const loadId = async (nl) => { const r = await env.LEADERBOARD.get(idKey(nl)); return r ? JSON.parse(r) : null; };
    const saveId = (nl, o) => env.LEADERBOARD.put(idKey(nl), JSON.stringify(o));

    // ── name rules (mirror the client) ────────────────────────────────────────
    const BAD = ['fuck','shit','cunt','nigg','fagg','bitch','cock','dick','puss','whore','slut','rape','nazi','hitler'];
    const nameError = (name) => {
      if (!/^[a-zA-Z0-9 _-]{2,16}$/.test(name)) return 'Name must be 2-16 letters, numbers, or spaces.';
      const flat = name.toLowerCase().replace(/[^a-z]/g, '');
      if (BAD.some(w => flat.includes(w))) return 'Pick a friendlier name.';
      return null;
    };

    // server clock: whole UTC days since 2024-01-01 (the streak is server-owned)
    const EPOCH = Date.UTC(2024, 0, 1);
    const serverDay = () => Math.floor((Date.now() - EPOCH) / 86400000);

    // reflect a name's best streak onto the public board (one row per name)
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

      // Claim a name (or verify you already own it). The secret proves ownership.
      if (url.pathname === '/register' && request.method === 'POST') {
        const b = await request.json();
        const name = clean(b.name, 16).trim();
        const secret = clean(b.secret, 64);
        const err = nameError(name);
        if (err) return send({ ok: false, error: err }, 400);
        if (secret.length < 8) return send({ ok: false, error: 'bad secret' }, 400);
        const nl = name.toLowerCase();
        const existing = await loadId(nl);
        if (existing) {
          if (existing.secret === secret) return send({ ok: true, existing: true, name: existing.name, streak: existing.streak || 0, best: existing.best || 0 });
          return send({ ok: false, error: 'That name is taken.' }, 409);
        }
        await saveId(nl, { name, secret, streak: 0, best: 0, lastDay: 0, createdTs: Date.now() });
        return send({ ok: true, existing: false, name, streak: 0, best: 0 });
      }

      // Record today's Daily Jab result. The server owns the streak: one count
      // per UTC day, so posting again the same day does nothing.
      if (url.pathname === '/daily' && request.method === 'POST') {
        const b = await request.json();
        const name = clean(b.name, 16).trim();
        const secret = clean(b.secret, 64);
        const won = b.won === true;
        const nl = name.toLowerCase();
        const rec = await loadId(nl);
        if (!rec || rec.secret !== secret) return send({ ok: false, error: 'not your name' }, 403);
        // Local day (the daily word is local-date based), guarded to within 1
        // day of the server's UTC day.
        const utcDay = serverDay();
        let today = num(b.day);
        if (!today || Math.abs(today - utcDay) > 1) today = utcDay;
        const alreadyToday = rec.lastDay === today;
        // The name is reserved to this browser's secret, so trust its streak/best
        // for this entry (sanity-capped). Keeps the board matching the player's
        // own device; name ownership still blocks touching anyone else's entry.
        rec.streak = Math.max(0, Math.min(3650, num(b.streak)));
        rec.best = Math.max(rec.best || 0, Math.max(0, Math.min(3650, num(b.best))));
        // Weekly wins: at most one per local day
        const week = Math.floor(today / 7);
        if (rec.weekIndex !== week) { rec.weekIndex = week; rec.weekWins = 0; }
        if (won && !alreadyToday) rec.weekWins = (rec.weekWins || 0) + 1;
        rec.lastDay = today;
        await saveId(nl, rec);
        // update the public board: all-time streak + this week's solves
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

      // Save a multiplayer game result (merged server-side).
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
