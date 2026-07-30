# WordJab — Engineering Handoff

> Living handoff for an AI agent (Claude Code) continuing work on WordJab.
> Last updated at the point where the **social layer + server-owned streaks**
> are live and the **next goal is Correspondence play** (which is also the real
> fix for the ongoing disconnection pain — see §7).

---

## 1. What WordJab is

A free, no-login, multiplayer word-battle game. Players hide a secret word;
opponents throw letters to crack each other's boards. Modes: online (4-letter
code), same-device pass-and-play, **Daily Jab** (solo daily puzzle — the
retention hook), and Practice vs. a bot (JabBot). There's a **Lounge** (live
matchmaking), **friends**, and global **leaderboards** (daily streaks, weekly
top solvers, top scores, longest games).

Live at **https://wordjab.io**.

---

## 2. Repo, deploy, and how work ships

- **Repo:** `tooniebuckerooni/wordstrike` (GitHub Pages → wordjab.io; `CNAME` present).
- **Working branch:** `claude/wordjab-launch-review-gmtcvx` (develop here; never push elsewhere without permission).
- **Ship flow:** PR from the branch → `main` → GitHub Pages auto-deploys in ~1–2 min. Use the GitHub MCP tools (`create_pull_request`, `merge_pull_request`). Do **not** create a PR unless shipping.
- **Everything is one file:** `index.html` holds all HTML, CSS, and JS inline. There is no build step. Other repo files:
  - `sw.js` — service worker. **Bump `const CACHE = 'wordjab-vN'`** whenever you ship, to force stale clients to update (a real past cause of "it's broken for one player").
  - `worker/wordjab-api.js` — **source of truth for the Cloudflare Worker** (see §4). Keep it in sync with what's deployed.
  - `robots.txt`, `sitemap.xml`, `site.webmanifest`, `BingSiteAuth.xml`, `og-image.png`, `fatcity-sponsor.png`, icons (`icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, `favicon-32.png`).
- **SEO:** verified in Google Search Console (DNS) and Bing. Sitemap submitted. Google site-verification `<meta>` is in `<head>`.

---

## 3. Environment constraints (read before you try to "just test it")

- **Outbound egress is blocked** from this sandbox to: `wordjab.io`, `*.workers.dev`, `api.jsonbin.io`, `developers.cloudflare.com`, `rest.ably.io`. You **cannot** curl or WebFetch the live site, the Worker, or Ably. Don't retry policy 403s.
- **You cannot deploy the Worker.** The Cloudflare MCP connector is read-mostly: it can create KV/D1/R2 and read Worker code/list, but has **no deploy/update-script/bindings tool**. → When the Worker changes, you hand the **full new code** to the user in a `<details>` block and they paste it into the Cloudflare dashboard editor. Warn them: that editor auto-inserts stray `}` on fast paste — tell them to verify zero parse errors before Deploy.
- **How you actually test:** headless Chromium via `playwright-core` driving `file:///home/user/wordstrike/index.html`, with `window.fetch` mocked to emulate the Worker. Chromium is at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. `playwright-core` gets installed into a scratchpad `node_modules` (the scratchpad is ephemeral — reinstall each session with `npm i playwright-core`).
- **Syntax check** the inline script by extracting `<script>` blocks (skip the gtag one) and `node --check`. Always do this before shipping.
- **User's preview** = commit-pinned githack URL (branch URLs are CDN-cached and go stale): `https://raw.githack.com/tooniebuckerooni/wordstrike/<commit-sha>/index.html`. Always give the short SHA after pushing.

---

## 4. Backend: Cloudflare Worker + KV

- **Worker:** `wordjab-api` → `https://wordjab-api.dustinramsbottom.workers.dev` (owner account: dustinramsbottom).
- **Storage:** KV namespace **`wordjab-data`** (id `859f305dd20940c6b4730047e036dd54`), bound to the Worker as **`env.LEADERBOARD`**.
- **Source of truth:** `worker/wordjab-api.js` in the repo. CORS is `*` (fine — no secrets in the browser; can be locked to wordjab.io later).
- **Endpoints:**
  - `GET  /leaderboard` → the whole record `{ topScores, longestGames, recentGames, dailyStreaks, weekly }`.
  - `POST /register` `{name, secret}` → claim/verify a name. 409 if the name is held by a different secret.
  - `POST /daily` `{name, secret, won, day, streak, best}` → record a Daily Jab result for an owned name (see §6 for the trust model).
  - `POST /result` `{winner, winnerColor, score, mode, rounds, players[], totalGuesses}` → merge a multiplayer game into the boards.
- **KV shape:** `leaderboard` key holds the public record; `id:<namelower>` keys hold per-identity records `{name, secret, streak, best, lastDay, weekIndex, weekWins, createdTs}`.
- History: the leaderboard used to be on **JSONBin** (public master key, rate-limited → outages). Fully removed. If you ever see JSONBin references, they're stale.

---

## 5. Real-time layer: Ably

- **Ably** powers live multiplayer + the Lounge. The key is `const ABLY_KEY` in `index.html` (public in the client — a known limitation; the durable fix is minting per-user Ably tokens from the Worker).
- **Channels:** game = `wj-<CODE>` (4-letter code); lounge = `wj-lounge` (presence-based).
- **Model: host-authoritative.** The player who creates a game is the "host"; their browser holds the game state and relays via Ably. Guests send intents; host computes and broadcasts state. **This is the root of the disconnection pain** (§7): the host's browser is a single point of failure, and mobile browsers suspend background WebSockets.
- **Free tier:** 200 concurrent connections, 200 peak, 6M msgs/mo. A player in a game *and* the lounge holds 2 connections. Worth watching as usage grows.

---

## 6. Identity, names, and the streak trust model (recently reworked — understand this)

**No login, by product decision (login is a hard "no" from the owner).** Identity is device-local:
- `localStorage.wj_identity = {uid, handle, secret}` (+ `wj_secret` fallback). `secret` is a random token minted per browser; it **proves name ownership** to the Worker.
- A name is **claimed once** (via `/register`) and then reserved to that secret. Name inputs (daily post + lounge) become **prefilled + read-only** with a deliberate "change name" link — this is the no-login "consistency" fix so people stop retyping/typo-ing their own name.

**Daily streak counting — the tricky part, with hard-won history:**
- The Daily Jab word is chosen from the **player's LOCAL date** (`todayStr()`), and local streak lives in `localStorage.wj_daily_v1 = {streak, best, lastPlayedDate, lastResult, lastRoundsLeft}`.
- **Bug we hit #1 (timezone):** the Worker originally counted streaks by **UTC day**, but play is local-date based → players west of UTC (e.g. Mountain Time evenings) got "already saved today" and streaks stuck. **Fix:** client sends `day: localDayNumber()` (local days since 2024-01-01); Worker uses it, guarded to within ±1 of its own UTC day so streaks can't be fast-forwarded.
- **Bug we hit #2 (server vs device streak):** the Worker used to compute the streak itself from *posted* days, so a player with a real device streak of 2 (best 5) saw it save as **1**. **Fix (current model):** because the name is secret-owned, the Worker now **trusts the device's `streak`/`best`** for that owned entry (sanity-capped at 3650). One save per local day; `won && !alreadyToday` increments weekly wins.
- **The tradeoff (deliberate, owner-approved):** with no login you can only pick 2 of {unfakeable, matches-device, no-login}. We chose **matches-device + no-login**. So a determined person editing their own browser could inflate **their own** streak — but **name ownership + one-save-per-day still fully block** impersonation, name-swapping, and "rubbing out the top 5." That griefing was the owner's actual concern and it stays closed.
- **Future option (not built):** "**verified** streaks" — the Worker also tracks days it actually witnessed consecutively and marks those with a ✓, so real streaks are visually distinguished from claimed ones. This restores integrity signal without login. Build if self-inflation ever becomes a visible problem.

**Leaderboards** (all in the KV record, rendered in `renderLeaderboardHtml`):
- `🗓 this week's top solvers` (weekly wins, **resets weekly** — the fresh-competition hook), `🔥 longest daily streaks` (with your rank/percentile + "Share my rank"), `🏆 top scores`, `⏱ longest games`. Rows highlight the viewer; reads are cached in `localStorage.wj_lb_cache` and fall back to cache on network failure.

**Friends / Lounge:** friends = reserved names saved in `localStorage.wj_friends`; online status comes from lounge Ably presence (live when you're in the lounge, or an Ably REST peek when you're not). Challenge handshake in the lounge auto-hosts a game and auto-joins the code. Block list in `localStorage.wj_blocked`.

---

## 7. ⚠️ OPEN ISSUE #1 — Disconnections (top priority; drives Correspondence)

**Symptom:** players "get disconnected often" during online games. **The recent streak patches do NOT address this.**

**Why it happens (root causes):**
1. **Host-authoritative architecture (§5).** Game state lives in the host's browser. If the host backgrounds the tab, locks their phone, or drops, the game stalls for everyone until they return.
2. **Mobile WebSocket suspension.** Mobile browsers suspend background tabs; Ably goes `disconnected`→`suspended` (after ~2 min) and can miss messages. We added reconnect resilience but it's a patch, not a cure.

**What's already been done (so don't redo it):**
- Reconnect resync: `onGameReconnect()` — host re-broadcasts authoritative state, guests silently re-request via `{type:'rejoin', silent:true}`.
- Tuned Ably client (`disconnectedRetryTimeout` etc., `closeOnUnload:false`).
- Session persistence + resume: `wj_session` + `wj_host_state` in localStorage; a "Game in progress — Rejoin" card on home; guests re-announce with retries.
- Turn timer (opt-in) that auto-skips a vanished player. Boot-player control for the host. A floating "Reconnecting…/Reconnected" badge.

**The real fix = move game state server-side** (which is exactly what Correspondence needs too). Recommended direction: **Cloudflare Durable Objects** — one DO per game code holding authoritative state, coordinating turns, and (via hibernatable WebSockets) replacing the host-relay model entirely. That removes the host single-point-of-failure and makes reconnject a simple "reload and resume." Confirm current Durable Objects free-tier availability/limits before committing. (Alternative: keep Ably for transport but make the Worker+KV the state authority — simpler, but KV is eventually-consistent and not ideal for fast concurrent turns; DO is the better fit.)

---

## 8. 🎯 NEXT GOAL — Correspondence play (Wave 3)

**Concept:** async, turn-by-turn games that survive everyone leaving. You make your move, close the app, come back later when it's your turn. This is a distinct system from the current real-time flow — design it properly rather than bolting on.

**Why it's the right next build:** (a) the owner asked for it; (b) it **structurally solves the disconnection problem** (§7) because game state stops living in a fragile host browser.

**What it needs (design space, for the next agent to spec):**
- **Server-authoritative game state** keyed by game id — Durable Objects (recommended) or Worker+KV/D1.
- Turn model: whose turn, move validation server-side (reuse the existing guess logic — see `processGuess`), game lifecycle (waiting / active / finished).
- Resume/list: "your games" view; a player returns and sees games awaiting their move. Ties into the identity/`secret` system (§6) — players are their reserved names.
- Notifications: at minimum in-app "N games await your move"; push is a stretch (PWA already installable; a service-worker push pipeline would be a separate effort).
- UI: a new "Correspondence" entry alongside Host/Join/Same-Device/Bot on the home screen; a per-game turn screen reusing the existing board/guess components.
- Anti-abuse: same identity/name-ownership guarantees; server validates each move belongs to the player whose turn it is.

**Suggested phasing:** (1) stand up a Durable Object game room + move API and prove reconnect-resilient real-time on it (fixes §7); (2) layer async/turn-based "your games" on the same state; (3) notifications. Get owner sign-off on the storage choice (DO vs KV/D1) before building, and remember every Worker/DO change is a **manual paste** for them.

---

## 9. Other open items / decisions on record

- **Ranked / ELO — shelved.** Owner decided a competitive ladder doesn't fit the game's casual feel, and it needs multiplayer to run through verified identity first. Don't build unless asked.
- **Lounge name enforcement is soft.** `/register` reserves the name in the UI, but a raw Ably client could still spoof a handle. True enforcement needs Worker-minted Ably tokens (would also lock down the public Ably key).
- **Public Ably key** in `index.html` — acceptable for now; tokenize via the Worker when you touch the transport layer.
- **CORS `*`** on the Worker — fine for a public leaderboard; tighten to wordjab.io if desired.

---

## 10. Working conventions / gotchas checklist

- [ ] Develop on `claude/wordjab-launch-review-gmtcvx`; PR → `main` to deploy.
- [ ] Single file: edit `index.html`. Match surrounding style; no build step.
- [ ] Bump `sw.js` `CACHE` version on every user-facing ship.
- [ ] Syntax-check the inline script (`node --check` on the extracted `<script>`), and run Playwright + `window.fetch` mocks against `file://` before shipping.
- [ ] Escape all network/storage-sourced strings before `innerHTML` (`esc()` / `safeColor()` helpers exist — an XSS hole was fixed early; keep it closed).
- [ ] Worker changes: update `worker/wordjab-api.js` in the repo **and** hand the user the full code to paste; remind them of the editor's stray-bracket quirk and to verify parse errors.
- [ ] After pushing, give the user the commit-pinned githack preview URL + tell them to hard-refresh.
- [ ] You can't reach live endpoints or deploy the Worker — plan around it (mocks + user-in-the-loop for anything touching the live Worker/Ably).
