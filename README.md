# WordJab

Free multiplayer word battle game at **https://wordjab.io**.

## What's where

| Piece | Where | How it deploys |
|---|---|---|
| The whole game (markup, styles, script) | `index.html` | GitHub Pages serves `main` as-is. No build step: what's in the file is what's live. |
| Offline shell | `sw.js` | Same. Pages are network-first, so updates land without bumping `CACHE`; bump it only for breaking asset changes. |
| Accounts, streaks, leaderboard, play-by-mail | `worker/wordjab-api.js` (Cloudflare Worker `wordjab-api`, one KV namespace) | `.github/workflows/deploy-worker.yml` deploys on any push to `main` touching `worker/**`; PRs get a dry run. |
| Live games | Ably realtime, straight from the browser | — |

`worker/correspondence.js` is the standalone, documented copy of the play-by-mail
module. The running code is the merged copy inside `wordjab-api.js`.

## Daily Jab word schedule

Everything lives next to `getDailyWord()` in `index.html`. The rules that matter:

- **The schedule is positional.** A word's day is its index in a fixed, seeded
  order. Deleting or inserting a word mid-list reshuffles every later day.
  So: **append** new words to the `*_EXTRA` pools, and **filter** (with a
  cutover date) rather than delete. Days already played must keep their word.
- **Monday–Saturday** come from `WORD_ORDER_EASED`: five letters or more, no
  J/Q/X/Z, and `jabToughness(word) < DAILY_EASE_MAX`. To make weekdays easier
  or harder, change `DAILY_EASE_MAX` behind a *new* cutover date.
- **Sunday** is Hard Word Sunday, its own weekly cycle. J/Q/X/Z words belong here.
- **`DAILY_WORD_PINS`** forces a word on a date (used for holidays and for
  preserving a day's word after a list fix).
- Days are the **player's local** calendar day, everywhere.

`jabToughness()` is only a model. The real signal is the Worker's per-day
tally: `GET https://wordjab-api.dustinramsbottom.workers.dev/daystats` returns
won/lost counts per day (signed-in players only).

## Holiday nods

`HOLIDAYS` in `index.html` is a small date table: a line under the logo, a tint
on the logo rule (`html[data-holiday="…"]` in the CSS), an emoji on the share
text, and optionally an alternate glove (`#g-glove-santa` in the SVG sprite).
Each entry switches itself on and off by date. Pair it with a `DAILY_WORD_PINS`
entry for an on-theme word.

## Icons

Line icons and the glove are inline SVG symbols in the sprite at the top of
`<body>` — use `<svg class="ico"><use href="#i-bolt"/></svg>` or
`<svg class="glove"><use href="#g-glove"/></svg>`.
