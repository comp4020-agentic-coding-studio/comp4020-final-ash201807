# Process overview

## What this is, and the source of truth

A two-player real-time card/board game: place cards to form three-in-a-row
combos, trigger effects, take the opponent's HP to 0. The rules are fixed by
a Game Specification (v1.0) agreed with the project owner before any code
was written — nothing in `src/game/engine.ts` is an invented rule; where the
spec left something open (§20/§21), the decision and its reasoning are
recorded below, not just encoded silently in code.

## Stack decision

Node.js, no framework, `node:sqlite`, `ws`, a plain DOM client — no
React/Vue, no bundler. `fly.toml` fixes one 256MB machine and one `/data`
volume with no separate database, so a native-binding SQLite driver
(`better-sqlite3`) would add a compile step for no benefit over the built-in
module, and a frontend/backend framework would cost more in build-step
complexity than it saves for one board, one hand, two HP bars, and two HTTP
routes plus a WebSocket endpoint. The trade-off: more server wiring by hand,
in exchange for a surface area small enough to account for in full here.

## How this was actually built

Four stages, each implemented, then **verified by actually running the
result** — not just read back — before moving to the next: domain engine,
board/Expansion, server/persistence/realtime, deploy. Engine-level stages
were also reviewed line-by-line against the spec before committing, and that
review itself caught a real gap (a lethal Lightning combo had no test
proving its effect, not just its clearing, was skipped — fixed before Stage
1 was committed:
[`2bbb453`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-aSH201807/commit/2bbb453)).

Decisions the spec left open, confirmed with the project owner rather than
assumed: the game is one shared instance that starts automatically once a
second session joins (no "New Game" button yet); a third visitor is rejected
outright, no spectator seat; stacked same-type effects fully stack (two
Lightning combos zero the opponent's next turn and skip it entirely; two
Nature combos add +2 AP immediately); a 4-in-a-row is two overlapping
3-in-a-row combos; and when the 5x5 Expansion disappears, its outer ring is
discarded rather than kept as hidden state for a future re-expansion.

## Two real bugs, found by running the server, not by reading the code

**Session assignment consumed slots it shouldn't have.** `GET /` originally
claimed a player slot on every uncookied request. `spec/`'s own health-check
fetches (`global-setup.ts`'s readiness poll, the "answers at /" test) carry
no cookie, so simply running `pnpm check` silently used up both of the
game's two seats — a real browser arriving afterward saw "Game is full"
before any real player had shown up. Fixed by splitting session handling in
two: ensuring a cookie exists (HTTP page load) no longer claims a seat; only
an actual WebSocket connection does
([`657b19b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-aSH201807/commit/657b19b)).

**The waiting player was never told the game had started.** When the second
session completes the pair, the game is created inside *that* connection's
own handler — the first player's already-open socket, sitting on `waiting`,
was never notified. Fixed by broadcasting the fresh state to every open
socket when a connection completes the pair, not just sending to the new one
(same commit).

Both were caught by an actual two-client WebSocket script
(`scripts/manual-ws-check.mjs`, a manual aid, not part of `pnpm check`) run
against a live local server, then re-run against the live deployment itself.

## Tests

`pnpm check` = `typecheck && test:engine && test`. `src/game/engine.test.ts`
and `src/server/sessions.test.ts` (26 + 6 tests, `vitest.engine.config.ts`,
no server needed) cover rules a live HTTP surface can't practically pin down
— combo damage and effect stacking depend on specific card draws, which are
random over the real API but fully controllable as pure functions.
`spec/game.test.ts` (new this stage) is black-box against a *running* app:
pairing, third-visitor rejection, out-of-turn rejection leaving state
unchanged, and reconnecting with the same session resuming rather than
losing the game. Because this is one shared game with no rooms, that file's
tests share a single pairing in declaration order and consume both seats —
documented in the file itself, since re-running `pnpm check` against the
same long-lived local server will see the game already full on a second
pass (CI is unaffected: it always starts fresh).

## Deployed and verified live

[`1e29ba8`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-aSH201807/commit/1e29ba8):
`flyctl deploy --remote-only --ha=false -a comp4020-final-ash201807`, live at
https://comp4020-final-ash201807.fly.dev/. Verified against the real
deployment, not just locally: `spec/`'s checks pass over https, the
two-client script passes against the real URL, and persistence across an
actual `flyctl machine restart` was confirmed by reading `/data/game.db` via
`flyctl ssh console` before and after — the session map and a drawn card's
presence in a hand were identical.

**A suspected risk, checked and ruled out**: `flyctl status -a
comp4020-final-aSH201807` (this repo's locally-configured git remote casing)
fails to find the app, while the all-lowercase `comp4020-final-ash201807`
succeeds — Fly app names are lowercase-only. This looked like it would break
the CI deploy job's `-a ${{ github.event.repository.name }}`, but
`gh api repos/.../comp4020-final-aSH201807 --jq .name` shows GitHub's own
canonical repository name is already `comp4020-final-ash201807` — lowercase,
matching the Fly app exactly. The mismatch only ever affected a human typing
the repo name from the git remote URL by hand (as happened here, manually,
before this check); CI's own context variable was never at risk.

**Known cleanup before real use**: verifying against the live app occupied
both of its player seats with test sessions. Left in place deliberately
(more stages to land first) but must be cleared — delete the one row in
`/data/game.db` via `flyctl ssh console` — before a real visitor arrives.

## Not yet built

The real client UI — the current one is a bare, unstyled debug page built
only to exercise the server — and the Expansion board surfaced in it. Those,
and weeks 10-11's real-time/logging work, are later stages of this same
process account; this file is rewritten, not appended to, each time.
