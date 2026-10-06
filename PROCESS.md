# Process overview

## What this is, and the source of truth

A two-player real-time card/board game: place cards to form Combos, trigger
effects, take the opponent's HP to 0. The rules are fixed by a Game
Specification agreed with the project owner — nothing in `src/game/engine.ts`
is invented. The spec has been revised four times since, after real
two-player playtesting surfaced a problem it didn't anticipate (Stages 6 and
7) and after the project owner directed two further additions (Stages 8b and
8c); every open decision and its reasoning is recorded here, not just encoded
silently.

## Stack and workflow

Node.js, no framework, `node:sqlite`, `ws`, a plain DOM client — `fly.toml`
fixes one 256MB machine and one `/data` volume with no separate database, so
a native SQLite driver or a frontend/backend framework would cost more in
build complexity than they'd save at this scale.

Built in stages — domain engine, board/Expansion, server/persistence/
realtime, deploy, docs, then two playtesting-driven rule revisions — each
**verified by actually running the result**, not just read back, before the
next. Decisions the spec left open, confirmed with the project owner rather
than assumed: one shared game instance, starting automatically once a second
session joins; a third visitor rejected outright, no spectator seat; a
4-in-a-row is two overlapping Combos; a disappearing Expansion discards its
ring rather than hiding it for later.

Two bugs were found by running the server, not by reading the code: `GET /`
was claiming a player slot on every uncookied request, so `spec/`'s own
health-check fetches silently used up both seats before a real player
arrived; and the player already waiting was never told when the second
session completed the pair
([`657b19b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-aSH201807/commit/657b19b)),
caught with a live two-client WebSocket script, not a unit test.

## Tests

`pnpm check` = `typecheck && test:engine && test`. Engine/session tests
(`vitest.engine.config.ts`, no server) cover rules a live surface can't pin
down — Combo damage depends on which cards are drawn, random live but fully
controllable as pure functions. `spec/game.test.ts` is black-box against a
*running* app: pairing, third-visitor rejection, out-of-turn and
mid-game-restart rejection leaving state unchanged, reconnect resuming rather
than losing the game. One shared game means that file's tests consume both
seats — a second local run needs a fresh `DB_PATH` (CI is unaffected).

## Deployed and verified live

[`1e29ba8`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-aSH201807/commit/1e29ba8):
https://comp4020-final-ash201807.fly.dev/, verified against the real
deployment each time, not just locally — `spec/` over https, persistence
across an actual `flyctl machine restart`. A suspected Fly-app-casing risk to
CI's deploy job was checked and ruled out: GitHub's canonical repo name is
already lowercase, matching the app. Redeploying after Stage 6 surfaced one
more real gap: a game already in progress on the live volume had been
persisted *before* `restartConfirmed` existed, so `confirmNewGame` would have
crashed reading an undefined field on it — the app has no migration path for
its own schema changes mid-game, which is fine at this scale but worth
naming as a limitation. Resolved the only way available: cleared that game.

## Stage 6 — Combo required both owner and type; too rare, too tic-tac-toe

Playtesting found Combos needing **both** a shared owner and a shared card
type too rare across 4 types — boards filled with neither player ever
forming one. Revised: a Combo forms from owner alone and deals 15 damage; a
same-type bonus (Lightning/Water/Nature's effect) needs all 3 cards to also
share a type. This broke 4 Expansion tests built around one owner filling the
board with varied types to avoid a Combo — impossible once owner alone
qualifies. Rewritten around an owner-alternating layout verified by script.
A full board with nobody dead was now reachable, so **Board Locked**
(terminal, no winner) and a server-enforced two-player **New Game**
confirmation (`GameState.restartConfirmed`) were added — the latter verified
by forcing a "finished" state into SQLite directly, since reaching one
through real random play isn't practical to script.

## Stage 7 — real playtesting again: card type still didn't matter enough

Shipping Stage 6 didn't end the playtesting. With two real people actually
playing the deployed app, the game still felt like ordinary tic-tac-toe:
owner alone was enough to combo, so which *type* you held rarely changed a
decision. The fix proposed was structural, not cosmetic: let a shared **type**
form its own, weaker Combo even across **different** owners (5 damage,
credited to whoever placed the completing card), while a shared owner still
deals 15 regardless of type, and a line satisfying both still counts once.

Before writing any code, the owner asked for a read-only impact analysis.
That analysis surfaced the real risk early: Stage 6's "safe" fixtures proved
a board could fill with zero Combos by varying *owner* alone, because type
didn't matter yet — once type alone could also form a Combo, every one of
those fixtures (uniform card type throughout) would register a Combo on
nearly every line. A second invariant the fixtures depended on had quietly
appeared and gone unverified. That finding set the staged order:

- **7a** — the rule itself: `Combo` gained `ownerMatch: boolean` (replacing
  an `owner` field nothing had ever actually read, confirmed by search before
  removing it) alongside the existing `sameType`; damage became a per-Combo
  `ownerMatch ? 15 : 5` sum instead of a flat multiply. Reviewed, including
  whether a mixed-owner Combo's trigger player needed storing explicitly —
  it doesn't: the clearing invariant already guarantees a newly-detected
  Combo always includes the card just placed, so it's always the acting
  player, with no new state needed.
- **7b** — rebuilding all 6 affected fixtures (4 Expansion, 2 Board Locked)
  now needed *both* owner and card type to vary with no 3-in-a-row on either
  axis — verified by script after a hand-picked layout produced an
  unintended diagonal Combo the first time.
- **7c** — checked, not assumed: does the server read `Combo.owner`? Does
  anything serialize a `Combo`? Does the client judge Combos itself? All
  three: no — confirmed by search, not inference. No server/client changes.
- **7d** — `spec/` re-checked for assumptions about the old rule; found none,
  same conclusion as Stage 6.
- **7e** — this rewrite, plus removing every trace of "same owner and same
  type" from `README.md`'s rule description.

## Stage 8a — a real lockout, with no recovery path

A live "game is full" lockout (one browser's cookie lost, the other
session's slot never released) had no fix short of SSH-ing into the Fly
machine and editing the persisted SQLite row by hand — `sockets` only
tracked the live connection; `sessions` never released a slot once
assigned, with no way to tell a reload apart from a permanent departure.

Sessions now carry a `disconnectedAt` timestamp (`SessionEntry`,
`src/server/sessions.ts`), set on `ws.on("close")` and cleared on
reconnect. Expiry is a pure wall-clock comparison (`reapExpiredSessions`)
against `DISCONNECT_GRACE_MS` (configurable; 30s in production, 1s in CI) —
never a scheduled timer, since Fly stops the machine whenever nobody's
connected, which is exactly when a grace-period timer would be running.
Verified by actually killing the server process mid-grace-period and
restarting it against the same database file, not just by waiting inside
one long-lived process. Pre-Stage-8a persisted rows (a bare `PlayerId` per
session) are normalized on load rather than misread as already-expired.

Known limitation, flagged not missed: freeing a slot and refilling it still
counts as `justCompletedPair` going from 1 to 2 sessions — indistinguishable,
in this implementation, from the very first pairing ever — so it replaces
the whole game via the same path, including the still-connected opponent's
hand/HP/board, with no consent asked. A full redesign (offer the new
arrival a "continue this game" vs. "start a new game" choice, the
destructive option gated on the other player's agreement via Stage 8b's
`requestQuit`) has been fully analyzed — the data flow, the protocol
messages, a `takeOverSession` primitive, every edge case around a returning
original player or two simultaneous claimants — but not yet implemented.

## Stage 8b — voluntary termination

v1.0 had no way to end a game except playing it to a finish or filling the
board. Added `requestQuit`/`rejectQuit` (`src/game/engine.ts`), mirroring
`restartConfirmed`'s "both players independently agree" shape but for an
active game rather than an already-ended one — a new `GameStatus` of
`"abandoned"` (winner-less, same as `"locked"`, kept distinct so a client
can tell the two apart) is reached only once both players have requested
it; either player rejecting clears both flags, not just the rejecter's own.
Once abandoned, the existing `confirmNewGame` flow starts a fresh game
unchanged — no new restart machinery needed.

First time the restart-after-ending flow was verified end-to-end against a
real running server (`spec/game.test.ts`): reaching "finished" or "locked"
through actual lethal play or a full board isn't practical to script live
(confirmed already, Stage 5/7), but reaching "abandoned" through two
`requestQuit` messages is.

## Stage 8c — Fire redesign: the one type with no effect

v1.0 gave Fire no effect at all — Lightning/Water/Nature each had one, Fire
didn't, and `"fire"` was used throughout `engine.test.ts` specifically
because it was the one type guaranteed not to trigger anything. Confirmed
revision: Fire now deals 10 extra damage to the opponent on top of whatever
base damage its Combo already dealt (a Type Combo totals 15, an Owner Combo
that's also same-type totals 25) — same Phase 5 effect loop as the other
three (`src/game/engine.ts`).

Two things surfaced by actually building and testing this, not predicted by
the read-only analysis that preceded it:

- Fire is the first Phase 5 effect capable of dealing damage, so it needed
  its own lethal check — the existing Phase 4 check (run right after base
  damage, before any Phase 5 effect) would otherwise let a Play's true
  finishing blow land inside Phase 5 without ending the game, leaving a
  negative-HP player still marked `"active"`. Fixed by checking again
  immediately after Fire's damage is applied, skipping whatever's left of
  that Play exactly like an ordinary Phase 4 finish.
- `"fire"` being the test suite's de facto "safe filler type" was a hidden
  invariant touching a large fraction of `engine.test.ts` — the same shape
  of surprise as Stage 7's fixture-invariant discovery. Every test that used
  fire purely to deal predictable damage (not to test fire itself) was moved
  to lightning, preserving its original numbers and intent; a new "Fire
  effect (Stage 8c)" suite covers Fire specifically, including the two
  lethal-check cases above.

## Not yet built

The real client UI — the current one is a bare, unstyled debug page — and
the Expansion/Board-Locked/New-Game/voluntary-termination surfaced in it;
`quitRequested` specifically has no UI at all yet. The "continue vs. new
game" seat-choice redesign named in Stage 8a is fully designed but not
implemented — it'll naturally need the `quitRequested` UI at the same time,
since the "new game" branch of that choice routes through it. This file is
rewritten, not appended to, each time.
