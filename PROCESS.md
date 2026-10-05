# Process overview

## What this is, and the source of truth

A two-player real-time card/board game: place cards to form combos, trigger
effects, take the opponent's HP to 0. The rules are fixed by a Game
Specification agreed with the project owner — nothing in `src/game/engine.ts`
is an invented rule. The spec has been revised once since, after real
two-player playtesting surfaced a problem with it (see Stage 6); every open
decision and its reasoning is recorded here, not just encoded silently.

## Stack and workflow

Node.js, no framework, `node:sqlite`, `ws`, a plain DOM client — `fly.toml`
fixes one 256MB machine and one `/data` volume with no separate database, so
a native SQLite driver or a frontend/backend framework would cost more in
build complexity than they'd save at this scale. The trade-off: more server
wiring by hand for a surface area small enough to account for in full.

Built in stages — domain engine, board/Expansion, server/persistence/
realtime, deploy, docs, then the Stage 6 rule revision below — each
**verified by actually running the result**, not just read back, before the
next. Decisions the spec left open, confirmed with the project owner rather
than assumed: one shared game instance, starting automatically once a second
session joins; a third visitor rejected outright, no spectator seat; stacked
same-type effects fully stack; a 4-in-a-row is two overlapping combos; a
disappearing Expansion discards its ring rather than hiding it for later.

Two bugs were found this way, not by reading the code: `GET /` was claiming
a player slot on every uncookied request, so `spec/`'s own health-check
fetches silently used up both seats before a real player arrived; and the
player already waiting was never told when the second session completed the
pair, since the broadcast only went to the new connection
([`657b19b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-aSH201807/commit/657b19b)).
Both were caught with a live two-client WebSocket script
(`scripts/manual-ws-check.mjs`), not a unit test.

## Tests

`pnpm check` = `typecheck && test:engine && test`. Engine/session tests
(`vitest.engine.config.ts`, no server) cover rules a live HTTP surface can't
pin down — combo damage depends on random card draws, controllable as pure
functions but not live. `spec/game.test.ts` is black-box against a *running*
app: pairing, third-visitor rejection, out-of-turn and mid-game-restart
rejection leaving state unchanged, reconnect resuming rather than losing the
game. Since this is one shared game, that file's tests share a single
pairing and consume both seats — a second local run needs a fresh `DB_PATH`
(CI is unaffected: always fresh).

## Deployed and verified live

[`1e29ba8`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-aSH201807/commit/1e29ba8):
live at https://comp4020-final-ash201807.fly.dev/, verified against the real
deployment — `spec/` over https, the two-client script against the real URL,
persistence across an actual `flyctl machine restart` (read `/data/game.db`
via `flyctl ssh console` before/after). A suspected Fly-app-casing risk to
the CI deploy job was checked and ruled out: GitHub's own canonical repo name
is already lowercase, matching the app. The live app was redeployed once
more after README.md's real content was written (the first deploy still had
the template placeholder baked in), and the two verification runs' test
sessions were cleared from `/data/game.db` before treating it as ready for a
real visitor.

## Stage 6 — playtesting feedback: Combo rule revision, Board Locked, New Game

Two real two-player sessions exposed a design problem no test had: requiring
all 3 cards in a line to share **both** owner and card type made a same-type
Combo rare with only 4 card types and 25% draw odds each, and testers hit
5x5 boards that filled up with neither player ever forming one. The rule was
revised: a Combo now forms from 3 consecutive cells sharing an **owner**
alone and always deals 15 damage; a **same-type bonus** (Lightning/Water/
Nature's effect) only fires when the 3 cards also share a type. `Combo`
gained a `sameType: CardType | null` field replacing the old unconditional
`type`.

This broke 4 of Stage 2's Expansion tests, which relied on one owner filling
the board with varied *types* to avoid a Combo — now impossible, since one
owner alone is enough. Rewritten around a verified owner-alternating
"no 3-in-a-row" layout (a filled tic-tac-toe draw); a 5x5 version was
verified by a small script rather than by hand, after an earlier
hand-verification mistake in this same file.

A full board was now reachable with nobody dead, so **Board Locked** was
added: a new terminal `GameStatus` with no winner recorded (confirmed, not a
draw tiebreak), checked after Phase 7 so it reacts whether or not the
filling Play formed a Combo — a lethal Play on the same turn still takes
priority, since Phase 4's early return skips the check entirely. A full 3x3
still always expands rather than locking, so Board Locked only ever applies
to an already-full 5x5.

With two terminal states and no way back, **New Game** needed a
multiplayer-safe restart: `confirmNewGame` lives in the engine
(`GameState.restartConfirmed`), not the server, so it resets automatically
with each fresh game and stays unit-testable alone. One confirmation alone
mutates and returns the same object; both confirmations return a genuinely
*new* object from `createInitialState()` — callers must use the return
value, since in that branch nothing was mutated in place. Session identity
is untouched either way; only `appState.game` is replaced.

Reaching Game Over or Board Locked through real, randomly-dealt play isn't
practical for a black-box `spec/` test, so beyond the one case it can check
live (confirming mid-game is rejected), the full restart flow — one
confirmation broadcasting to *both* sockets, the second broadcasting a fresh
game to both, original A/B identities surviving a restart, SQLite holding
the new state — was verified by forcing a "finished" status directly into
the local SQLite file, restarting the server, and reconnecting with the
original session cookies (`scripts/restart-check-step{1,2}-*.mjs`).

Not yet redeployed: production is still running the pre-revision rules as of
this write-up; that follows once Stage 6 is committed in full.

## Not yet built

The real client UI — the current one is a bare, unstyled debug page — and
the Expansion/Board-Locked/New-Game surfaced in it. Later stages of this
same account; this file is rewritten, not appended to, each time.
