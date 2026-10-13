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

## Stage 9 — decision: FIFO matchmaking, concurrent matches, best-of-three

Directed by the project owner, not a bug or a playtesting finding (same
category as Stages 8b/8c) — and itself a revision of an earlier version of
this same stage. An initial Stage 9 draft proposed spectator mode plus a
single-sided seat-swap, bolted onto the existing one-shared-game model
(see git history, commit `39b8b52`, for that superseded text). A read-only
analysis against the real code showed that design still capped the app at
one game at a time and didn't actually address matchmaking or series play —
so the project owner replaced it with the actual goal: the app's shape
changes from "exactly two players, a third visitor rejected outright" (the
v1.0 README's own point 4) to a friends-first lobby supporting explicit FIFO
matchmaking, multiple independent concurrent matches, and best-of-three
series. This is recorded here as a decision before any of it is
implemented — `README.md` and `CLAUDE.md` still describe today's actual
single-shared-game behaviour and stay that way until the code underneath
actually changes; this repo doesn't claim behaviour it hasn't built and
tested.

**Guiding principle, confirmed with the project owner:** keep match/series
lifecycle (matchmaking, series score, forfeits) a server-level concern,
never invented into `src/game/engine.ts`. The engine stays exactly what it
is — pure single-game rules, fixed by the Game Specification — and every
new concept below is deliberately a wrapper around it, not a change to it.

### Agreed product rules

**Lobby and matchmaking.** Players explicitly join a FIFO queue. The server
pairs the two longest-waiting eligible players. Multiple matches run
concurrently. A player belongs to at most one active queue slot or active
series at a time. Once matched, both players are removed from the queue and
bound to the same series. A disconnected *waiting* (queued, not yet
matched) player is removed from the queue outright — no grace period, since
no game state is at stake yet; reconnecting means queueing again. After a
series finishes, both players return to the lobby and must explicitly queue
again — no auto-requeue.

**Single-game engine, unchanged.** Existing card-game rules and
`engine.ts`'s tests are preserved as-is. Each individual game keeps its own
independent `GameState` — HP, AP, hand, board, and single-game outcome never
carry over between games in a series. Best-of-three logic does not belong
in the pure engine; confirmed not unavoidable (see below), so it doesn't go
there.

**Best-of-three series.** At most three games; first to win two games wins
the series. Each game's outcome and the running series score are recorded
server-side, distinct from any individual `GameState`. After a
non-terminal game, the same two players continue to the next game in the
same series via the existing mutual-confirmation shape. After a series
ends, both players return to the lobby and must explicitly queue again.

**Disconnect, reconnect, forfeit.** A disconnect during an active series
gets a grace period (Stage 8a's existing mechanism, generalized to be
scoped per-series rather than global). Reconnecting within it restores the
same player identity, match, and series. Letting the grace period expire
forfeits the *entire series*, not just the in-progress game. An explicit
quit/forfeit immediately awards the series to the opponent. Queue
disconnection just removes the player from the queue (see above). The app
recovers consistent queue, session, match, and series state after a server
restart.

### Five decisions closed, beyond the agreed rules above

A read-only architecture review (this conversation) surfaced five product
questions the rules above left open. Closed as follows, confirmed with the
project owner, before any implementation:

1. **Both players' grace periods expire together.** The series is marked
   `"abandoned"`, no winner, both player bindings released — mirrors
   `GameState`'s own existing `"abandoned"` status (Stage 8b) at the series
   level, so a series that nobody finished is never silently credited to
   either side.
2. **What an explicit single-sided forfeit does to the in-progress
   `GameState`.** The server awards the series to the opponent directly,
   treating series status as the sole authority — `engine.ts` and the
   forfeited game's own `GameState` are **not** touched. The server rejects
   any further `play`/`draw`/`endTurn` against that series once forfeited,
   and the client is told the series has ended explicitly. If the existing
   debug client turns out to need `GameState.status` itself to say "over"
   for its display logic, that gets solved in the protocol/client layer
   when it's actually built, not by adding a forfeit concept to the engine.
3. **Whether finished series keep any history.** No permanent match history
   or history browsing page in this first version. A finished series keeps
   a minimal result record (series winner, final score) rather than being
   discarded outright, so a "you won/lost 2-1" result can still be shown —
   but retention is bounded, not indefinite, to avoid unbounded growth in
   the single SQLite blob. The exact retention count and when old records
   are swept are decided at implementation time, informed by how the client
   actually needs to read this state, not fixed in advance here.
4. **A forfeited player's session reconnecting afterward.** They're shown
   that the series has ended and its result, then returned to the lobby. A
   finished series cannot be resumed and no longer accepts actions against
   it; starting again means queueing afresh like anyone else.
5. **Server restart and the waiting queue.** In-progress series are
   persisted and restored (this is the capability actually worth protecting
   — e.g. a series already 1-0 mid-second-game). The waiting queue is
   **not** restored; every previously-queued, not-yet-matched player must
   explicitly re-queue after reconnecting. Stale WebSocket connections are
   cleared on startup. This deliberately doesn't try to preserve FIFO queue
   position across a restart — only match/series continuity is treated as
   something that must survive.

Three principles tie these five together, recorded as reasoning for future
stages to check new decisions against, not just these five:
- **A series has exactly one authoritative outcome.** Timeout, explicit
  forfeit, an ordinary win, and both-sides-disappearing must never produce
  conflicting end states for the same series.
- **Engine and server lifecycle stay separate.** `GameState` owns single-game
  rules; the server owns player identity, match/series ownership, series
  score, and final settlement. Nothing above moves rule logic into the
  engine or lifecycle logic into it either.
- **Restart recovery prioritizes in-progress matches over the queue.** The
  queue can always be rebuilt by asking players to queue again; a series
  partway through cannot be reconstructed from nothing, so it's the one
  thing restart recovery must not lose.

One cross-cutting requirement flagged explicitly, not yet designed in
detail: **series settlement must be idempotent.** If both players disconnect
at nearly the same moment, the server may observe both timeouts separately;
a series that's already been settled (abandoned, forfeited, or won) must
never be settled a second time, double-release its player bindings, or
flip its recorded outcome. This needs to hold regardless of which of the
decisions above (1, 2, or an ordinary finish) triggers settlement first.

### Recommended ADR (recorded, not yet implemented)

**Context:** the app's founding design (README's "What good means here,"
point 4) assumed exactly one shared game, built for two named people rather
than a matchmaking pool. The project owner has confirmed a different product
shape is now wanted: FIFO matchmaking, concurrent independent matches, and
best-of-three series.

**Decision:** model this as (a) a FIFO queue of waiting sessions, (b) any
number of independent series objects, each wrapping one to three
engine-owned `GameState`s left completely untouched, (c) per-session
player-binding records (queued / bound to a series seat / disconnected
pending grace) replacing today's flat global `SessionEntry`. `engine.ts`
requires zero rule changes; all new complexity is server/session/
persistence-layer.

**Alternatives considered:** the original Stage 9 draft (spectator mode +
single-sided seat-swap on the existing one-game model, `39b8b52`) —
superseded, since it doesn't deliver matchmaking or series play, which
turned out to be the actual goal.

**Consequences:** a one-time, unmigrated schema break on the live
`/data/game.db` (same precedent as Stage 6 — cleared, not migrated); several
of `spec/game.test.ts`'s existing black-box tests need rewriting, most
severely the "rejects a third visitor outright" test, whose premise inverts
entirely once a third visitor queues instead of being turned away; Stage
8a's disconnect-grace mechanism needs generalizing from global to
per-series scope, including rethinking when stale state gets reaped now
that there's more than one game that could need it; a new single-sided
forfeit action is needed alongside (not replacing) the existing mutual
`requestQuit`/`rejectQuit`.

**Validation:** same discipline as every prior stage here — verify by
actually running the result (Stage 8a's own precedent: kill and restart the
server process mid-grace-period against the same database file), not just
reading code back; idempotent settlement specifically needs a test that
forces both players' grace periods to expire close together, not just one
at a time.

## Stage 2 — stable match/series identifiers, still one series at a time

The smallest safe step in Stage 9's planned order: make "the one game" that
exists today addressable by a stable id, without enabling the queue,
concurrency, or best-of-three scoring yet. A read-only review (this
conversation) inventoried every read/write site of the old `appState.game`
(9 sites, all in `server.ts`) before any code changed, confirming `engine.ts`
needed zero changes — it only ever touches `GameState`/`PlayerId`, never a
series concept.

`AppState.game: GameState | null` (`src/server/persistence.ts`) became
`AppState.series: SeriesState | null`, where `SeriesState = { seriesId,
games: GameState[] }` — `games` holds exactly one entry for now; nothing
about how many games or series can exist changes in this stage.
`SessionEntry` (`src/server/sessions.ts`) gained a `seriesId: string | null`
field alongside its existing `player`/`disconnectedAt`, so a session
resolves to "which series" rather than that being an unstated singleton
assumption. `seriesId` is generated the same way `newSessionId()` already
was (`randomBytes(16).toString("hex")`), at the exact moment a pair used to
call `createInitialState()` directly — that moment is unchanged, it's just
followed by wrapping the result and stamping both sessions via the new
`bindActiveSeries`. `server.ts` gained one `currentGame(series)` accessor
(`series?.games[0] ?? null`) so the "exactly one game" assumption for this
stage lives in exactly one place, not at every call site. `normalizeSessions`
was extended, same reasoning as its existing pre-Stage-8a upgrade path: a
persisted row with no `seriesId` field reads as `seriesId: null` — the safe
default, never auto-abandons a session that's actually fine.

Deliberately **not** touched: `protocol.ts` — with only one series ever
alive, the client has nothing to disambiguate yet, so `seriesId` stays
server-internal until real concurrency (a later stage) gives the wire
protocol an actual reason to carry it.

Verified exactly like every prior stage — by running the result, not
reading code back: `pnpm typecheck` and `pnpm test:engine` (79 tests) pass
unchanged; `spec/game.test.ts`'s 8 tests and `spec/invariants.test.ts`'s 2
needed **zero edits** and all pass against a locally running server on a
fresh database — confirming this stage introduced no behavioural change,
exactly as planned. `sessions.test.ts`'s object literals needed the new
field added (mechanical, not a logic change), plus new cases for
`bindActiveSeries` and the pre-Stage-2-row upgrade path. Inspected the
persisted SQLite row directly after a live pairing: `series.seriesId` and
both sessions' `seriesId` match, confirming the field is actually populated,
not just type-checked.

**Known compatibility gap, not resolved here:** the live deployed
`/data/game.db` still holds the old `{sessions, game}` shape. `load()`
(`persistence.ts`) does a blind `JSON.parse(...) as AppState` with no shape
validation — loading an old-shape row under this new type would read
`series` as `undefined` while the real, possibly in-progress `GameState`
sits inert under the now-unused `game` key: silently inaccessible, not a
crash. Per the read-only review's own recommendation and Stage 6's already-
accepted precedent for a schema break at this scale, the plan is to clear
the one live game on next deploy rather than write a one-off migration
function — but clearing it is exactly the kind of touch to `/data/game.db`
this repo's `CLAUDE.md` requires an explicit go-ahead for, so it hasn't been
done and isn't implied by this stage landing in git.

## Not yet built

The real client UI — the current one is a bare, unstyled debug page — and
the Expansion/Board-Locked/New-Game/voluntary-termination surfaced in it;
`quitRequested` specifically has no UI at all yet.

Stage 9's decision is mostly still design-only; Stage 2 above is the first
implemented slice. Still not implemented:
- The FIFO queue itself and match allocation off it (today's pairing is
  still "first two sessions ever," not a queue).
- True concurrency — multiple series existing and being broadcast to at
  once (`sockets`/`broadcastState` still assume exactly one active series,
  via the new `currentGame` accessor).
- Best-of-three score tracking and the next-game-in-series handoff.
- The per-series generalization of Stage 8a's disconnect-grace mechanism,
  plus the new series-forfeit and single-sided-quit actions.
- Clearing the live deployment's old-shape persisted game (see Stage 2's
  own "known compatibility gap" above) — not yet authorized or done.

Each further step gets its own explicit go-ahead before code changes, per
this repo's own `CLAUDE.md` — Stage 2 above was reviewed read-only first,
then implemented only once authorized, and the same applies to deploying
it.

This file is rewritten, not appended to, each time.
