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

## Stage 3 — a real FIFO matchmaking queue, still one series at a time

A read-only design review (this conversation) preceded this stage, same
discipline as Stage 2. It surfaced two product questions answered directly
by the project owner rather than assumed: (1) "explicitly join the queue"
means a real lobby step — connecting no longer claims anything by itself,
a player must send a distinct action; (2) a queued-but-not-yet-matched
player's client must see a message distinguishable from the existing
`waiting` (seated, opponent not here yet) — so a new `queued` message was
added rather than reusing `waiting`.

`AppState` (`persistence.ts`) gained `queue: string[]` — session ids waiting
to be matched, FIFO (push to the back, dequeue from the front). `sessions.ts`
was restructured: the old `joinSession` (which both decided "is a seat
free" and created the `SessionEntry` in one step) is gone, replaced by five
small pure functions — `enqueue`/`removeFromQueue` (queue membership, each a
no-op when there's nothing to change), `dequeueOne` (pops the single
longest-waiting id), `nextOpenSeat` (which of A/B isn't currently held,
same logic the old `joinSession` had, just factored out), `seatOne` (creates
a `SessionEntry` with no series yet), and `bindActiveSeries` (stamps a fresh
`seriesId` onto every currently-seated entry once a pair completes) —
24 new/updated unit tests cover these directly, no server needed.

`protocol.ts` gained two new message types: `ClientMessage`'s `joinQueue`
(the explicit "I want to play" action — the one thing that now creates
anything) and `ServerMessage`'s `queued`. The old `full` message was
removed outright rather than left as dead protocol: nothing can produce it
anymore, since a third-or-later visitor now queues instead of being
rejected.

`server.ts`'s central new function is `pumpQueue()` — seats one queued
session at a time (not a pair plucked together) into whichever seat is
open, exactly matching the granularity the pre-Stage-3 `joinSession` always
had. This was a deliberate correctness fix mid-implementation: an earlier
draft dequeued two at once, which would have silently broken Stage 8a's
already-documented disconnect-recovery behaviour (a single freed seat,
while the OTHER player is still connected, must still be refillable by the
next queued session alone — not only when two happen to be queued
together). `pumpQueue` only treats a seating as "a pair completed" when
*this call's own dequeuing* brought the seated count to exactly two — not
merely because it was already two before the call started — so an
unrelated `joinQueue` from a third visitor, while a match is already in
progress, can never retrigger series creation. This preserves Stage 8a's
known limitation exactly as before: refilling one freed seat still starts
a brand new series, replacing the still-connected survivor's whole match
too — fixing that is the separately-tracked "continue vs. new game"
redesign, not this stage.

`pumpQueue()` and the existing disconnect-reaping are called from the same
two trigger points reaping already used — a new connection's resolution,
and a `joinQueue` message — consistent with Stage 8a's own established
reasoning that lazy, request-triggered checks are correct here (a scheduled
timer wouldn't survive Fly auto-stopping the machine between requests
anyway, and nothing about the queue's contents or an open-seat count can
change except through a request). The close handler now branches: a
session still only in the queue is removed outright, no grace period
(Stage 9's own rule — it never held a seat with state at stake); a seated
session keeps the existing Stage 8a grace-period mechanism unchanged.

Deliberately **not** done, per explicit instruction: Stage 4's concurrency
(multiple series at once), best-of-three scoring, and anything to
`engine.ts` — confirmed unchanged, same guiding principle as every stage
since 9.

Verified by running the result, not reading code back: `pnpm typecheck`,
`pnpm test:engine` (87 tests, up from Stage 2's 79), and `pnpm check`'s
black-box suite (13 tests, up from 12 — one new test added for "requires
joinQueue before a seat is assigned") all pass against a real locally
running server on a fresh database. Manually exercised over real
WebSocket connections, independent of the automated suite: two sessions
pairing and starting a match while two more simply queue behind them
without disturbing the active match; a session that disconnects while only
queued (never seated) is removed from the persisted `queue` array
immediately, confirmed by reading the SQLite row directly — not after any
grace period, exactly as required. `spec/game.test.ts`'s "rejects a third
visitor outright" test — flagged as needing rewriting all the way back in
Stage 9's own "Consequences" section — was rewritten to assert the new
queueing behaviour instead of deleted; its disconnect-reaping test was
extended (not just updated) to also assert the FIFO-fairness guarantee: a
session queued before the slot frees claims it, not a later arrival.
`README.md`'s "What good means here" point 4 and its "Checked in spec/"
paragraph were updated to describe this actual behaviour, since both
previously asserted the now-superseded "third visitor rejected outright"
claim.

**Known limitation carried forward unchanged, not introduced by this
stage:** as described above, refilling one freed seat still replaces the
whole series rather than preserving the still-connected survivor's match —
this is Stage 8a's own already-documented gap, not a new one; Stage 3
deliberately preserves it rather than fixing it, since the fix is a
separate, not-yet-authorized redesign.

**What Stage 3 alone does not yet deliver:** "the server pairs the two
longest-waiting eligible players" only in the sense of "whenever a seat is
actually open" — because exactly one series can exist at a time in this
stage's scope, a queue of 3+ simply waits, however long the active series
takes, until it ends. This is the correct and complete form of the rule
only once Stage 4 makes "a slot" mean "any of N concurrent series" rather
than "the one series slot" — not a gap in this stage, just not yet the full
picture by itself.

**Not touched, confirmed:** production database (no clear, no migration —
Stage 2's own already-identified compatibility gap is unchanged, now with
one more incompatible field, `queue`, added to the same not-yet-authorized
list); no `git push`, no deploy.

## Stage 4a — fix seat-scoping bug, isolate broadcast by series (behaviour unchanged)

A read-only review (this conversation), covering the full Stage 4 goal
("multiple independent two-player series concurrently"), recommended
splitting that goal into 4a/4b/4c/4d rather than one stage — the project
owner agreed, with three decisions closed first: no fixed cap on concurrent
series (FIFO keeps pairing as long as players are waiting; resource limits
are a capacity-testing question, not a product rule, if testing ever
surfaces one); `CLAUDE.md`'s stale "one shared game, third visitor
rejected" wording (confirmed stale against Stage 3's own already-shipped
behaviour) is deferred to 4d rather than fixed piecemeal now; existing
`spec/game.test.ts` tests are kept and only the ones whose premise is
actually contradicted get rewritten, rather than restructuring the whole
suite around concurrency up front.

This sub-stage changes nothing about behaviour — still exactly one active
series at a time, same as Stage 3 — and exists purely to fix a bug the
review found and lay groundwork so 4b isn't the first place either gets
tried:

- **`nextOpenSeat` (`sessions.ts`) took the whole `SessionMap`** and checked
  globally whether seat `"A"`/`"B"` was taken *anywhere* — harmless today
  (there's only ever one series' worth of sessions to look at), but
  confirmed wrong the moment a second concurrent series could exist, since
  seat identity is only meaningful *within* a series. Now takes an explicit
  `SessionEntry[]` instead, with zero opinion about `seriesId` at all —
  filtering which entries are "this series' own" is entirely the caller's
  job (today: every entry, since there's only one series; Stage 4b: a real
  filter). Fixing the function's own correctness here, before the filtering
  that depends on it exists, means Stage 4b only has to change the one call
  site's filter, not invent and test this scoping logic under time
  pressure once a leak would actually be observable.
- **`sockets` (`server.ts`) changed from `Map<WebSocket, PlayerId>` to
  `Map<WebSocket, sessionId>`** — a cached `PlayerId` has nothing to keep it
  in sync with if a session's `seriesId` ever changes after being seated
  (exactly what happens today already, via the known freed-seat-refill
  limitation); resolving both `player` and `seriesId` fresh from
  `appState.sessions[sessionId]` on every use removes that staleness risk
  entirely, for free.
- **`broadcastState()` now takes an explicit `seriesId` and filters**
  `sockets` down to sessions currently bound to it, instead of assuming
  every seated socket belongs to the one series that exists. Behaviourally
  a no-op today (every seated socket already qualifies, there's nothing
  else for it to be), but this is the exact function the Stage 4 review
  named as the real cross-series isolation boundary — getting the filter
  logic right now, while wrong would be unobservable, is deliberately safer
  than writing it for the first time once two series actually coexist.

Verified by running the result, not reading code back: `pnpm typecheck`,
`pnpm test:engine` (88 tests, up one for `nextOpenSeat`'s new signature),
and the full `pnpm check` black-box suite (13 tests, unchanged count) all
pass against a real locally running server on a fresh database — confirming
this sub-stage is exactly the no-behaviour-change refactor it was meant to
be.

**Not yet done (by design — this is 4a, not 4b):** `appState.series` is
still a single `SeriesState | null`, `pumpQueue()` still has the
`sessions.length < 2` ceiling that caps the app at one active series, and
the message handler/`currentGame` still resolve against that one global
reference rather than a per-session lookup into a keyed collection. None of
Stage 4's actual product goal (concurrent series) is enabled yet.

## Stage 4b — concurrent series, forfeit replaces Stage 3's seat-refill

A second read-only design review (this conversation), scoped specifically to
4b, surfaced a real conflict while implementing it — not a hypothetical risk,
a structural one found by actually tracing the algorithm: Stage 3's existing
model (a lone queued session silently refills ONE freed seat, replacing the
whole series underneath the still-connected survivor with no consent — a
known limitation already recorded under Stage 8a) cannot be generalized to N
concurrent series without either (a) a stranger's unrelated `joinQueue`
sometimes getting incorrectly paired into a half-finished series instead of
starting its own, or (b) keeping a global "pause all new pairings while any
grace period is pending anywhere" rule that would make one unrelated
match's disconnect stall matchmaking for everyone else. Both were traced
through concretely, not just asserted; neither is acceptable. The project
owner's decision: adopt the forfeit model instead — a seated session whose
grace period expires forfeits its *entire* series to the opponent, rather
than having its lone seat quietly refilled. This replaces Stage 3's
refill-one-seat behaviour outright (confirmed as a deliberate, final
decision, not a temporary stopgap): the existing "frees only the
disconnected player's slot, refilling it from the queue" `spec/game.test.ts`
test was rewritten rather than kept, since its entire premise (a stranger
takes over a vacant seat) no longer exists.

This also simplified the implementation: because every series now either
has both its players or is being settled (forfeited or abandoned), a series
is never "half-seated, waiting for one more." `pumpQueue()` went back to
pairing two sessions at a time (`dequeuePair`, not Stage 3/4a's one-at-a-time
`dequeueOne`), looping with no ceiling — as many pairs as the queue allows
in one call, confirmed by manual testing: 5 waiting sessions produce exactly
2 independent series plus 1 still queued, in one `joinQueue` call. The
one-at-a-time functions this replaced (`dequeueOne`, `seatOne`,
`nextOpenSeat`, `bindActiveSeries`) were all Stage 3/4a infrastructure for
the now-abandoned refill model and were removed rather than left unused —
replaced by `dequeuePair` (two at once, atomic) and `seatPair` (creates both
`SessionEntry`s with their shared `seriesId` set from the start, since under
this model there's no longer an intermediate "seated, no series yet" state
at all).

`AppState.series: SeriesState | null` (`persistence.ts`) became
`seriesList: Record<string, SeriesState>`, keyed by `seriesId` — any number
of independent series, each addressed by the id already present on every
`SessionEntry` since Stage 2. `broadcastState(seriesId)` (already taking an
explicit `seriesId` since Stage 4a) now looks it up in `seriesList` instead
of comparing against one global reference; the message handler resolves
`game`/`seriesId` via the acting session's own `SessionEntry.seriesId`
rather than one shared field, at every site that previously read
`appState.series` directly.

New server-level settlement function, `reapAndSettleSeries` (replacing
Stage 3/4a's `reapAndFreeSeries`): after reaping, groups the sessions that
were just reaped by which series they belonged to, and for each affected
series checks how many of its two sessions remain — two (an unrelated
session in that series merely reconnected or was never at risk, nothing to
do), one (forfeit: the survivor is sent a new `seriesEnded` message
— deliberately NOT written into `GameState` itself, since a forfeit is a
server-level settlement, not a game-rules outcome, per this repo's own
guiding principle that match/series lifecycle stays out of `engine.ts` —
and their own `SessionEntry` is released so they must explicitly re-queue,
same as after any ordinary ended match), or zero (both players' grace
periods expired, however close together — this whole pass runs as one
synchronous scan over a single `reapExpiredSessions()` call, so "close
together" can never actually race: abandoned, no winner, nobody left to
notify, per the project owner's own closed decision for this exact case in
Stage 9's entry above). Either way the series is deleted from `seriesList`
— settling it twice is structurally impossible, since the second time
there's nothing left in that series for `sessionsInSeries` to find.

New protocol: `ServerMessage` gained `{ type: "seriesEnded", reason:
"opponentDisconnected" }`; the debug client (`client/app.js`) now handles it
by clearing its board/hand display and re-showing the "Join queue" button
with an explanation, rather than being left rendering a stale board forever.

Verified by running the result, not reading code back: `pnpm typecheck`,
`pnpm test:engine`/`sessions.test.ts`/new `persistence.test.ts` (93 tests),
and the full `pnpm check` black-box suite (15 tests: the 13 carried over
from Stage 3 minus the two whose premise this stage replaced, plus 4 new
ones — two independent concurrent series forming from one queue; actions in
one never leaking into another's messages; a reconnect resuming its own
series specifically, not a concurrent unrelated one; and the forfeit/
abandonment cases, each confirmed not to disturb an unrelated concurrent
series running at the same time) all pass against a real locally running
server on a fresh database. The first attempt at the two-concurrent-series
test itself had a bug (forming both pairings via `Promise.all` interleaved
their joins and paired session 1 with session 3 instead of with session
2) — a test bug, not a server bug, caught by actually running it once
rather than assumed correct from reading the code; fixed by forming them
sequentially, since the FIFO queue has no notion of "these two belong
together" beyond arrival order. Manually verified over real WebSocket
connections, independent of the automated suite: 5 simultaneously queued
sessions produce exactly 2 concurrent series (sessions 1-2 and 3-4) with
the 5th still queued, confirmed by inspecting server responses directly —
matching the Stage 4b design review's own traced algorithm exactly.

`README.md`'s "What good means here" point 4 and "Checked in spec/"
paragraph were updated to describe concurrent matches and the forfeit rule,
replacing the now-inaccurate "exactly one match active"/"refill a freed
seat" claims.

**Known limitation, unchanged from the prior review's own finding:**
`CLAUDE.md` is still stale (confirmed again against this stage's own
shipped behaviour) — deferred to Stage 4c/4d, not fixed here, per the
already-agreed split.

**Not touched, confirmed:** `src/game/engine.ts`, `src/game/types.ts`
(zero rule changes — reconfirmed); production database (no clear, no
migration — a third incompatible schema change now stacked on the same
not-yet-authorized list: `game`→`series`, `+queue`, `series`→`seriesList`);
no `git push`, no deploy.

**What Stage 4b does not cover:** the never-before-tested scenario of a
server restart with 2+ concurrent in-progress series live — still Stage
4c's job specifically, not attempted here; `CLAUDE.md`'s stale wording
(still Stage 4d).

## Stage 4c — verified: real kill-and-restart with 2+ concurrent series live

Verification-only, per the agreed Stage 4 split — no application code
changed. A read-only design review (this conversation) preceded it, same
discipline as every stage so far; it traced Stage 8a's own original
restart-verification precedent back to its actual commit (`f49612a`) and
confirmed that check was always a one-off manual kill-and-restart, never a
committed automated test — this stage follows the same precedent rather
than building new sub-process-managing test infrastructure (the review's
own reasoning: `spec/`'s whole harness tests against an already-running
external process via `APP_URL`, which is structurally incompatible with a
test that kills and restarts the very process it's testing; CI runs the
app inside a Docker container, where killing the app process would kill the
container running the test too).

**Environment:** a throwaway local server (`node src/server/index.ts`),
`DB_PATH` pointed at a scratch SQLite file inside this repo's own
gitignored `data/` directory (confirmed ignored via `git check-ignore`
before use, never committed, deleted afterward), `DISCONNECT_GRACE_MS=5000`
for a fast but still-real wall-clock wait. The verification script itself
lived only in that same scratch directory for the duration of the check and
was deleted immediately after — nothing from it is part of this commit.

**Scenario, orchestrated by a single script (not ad hoc manual steps, so
every timestamp is captured precisely rather than estimated by eye):**
three concurrent series (A, B, C) were formed against generation 1 of the
server. Series B's both players stayed fully connected throughout, as the
"must remain completely undisturbed" control group. Series A had its
player B close its socket; after confirming (via a direct SQLite read) that
the real `disconnectedAt` timestamp was persisted, the server process was
killed with `628ms` of a `5000ms` grace period elapsed — comfortably mid-
grace-period, confirmed by the script's own assertion, and timed to land
after the close handler's `persistence.save()` had already returned (per
the design review's own recommendation: testing whether the *application's
logic* survives a restart, not probing SQLite's own crash-safety boundary
mid-write). Series C had BOTH players close their sockets before the kill,
so its grace period would fully elapse while the process was down.
Generation 2 was then started against the exact same `DB_PATH`.

**Results — all 22 assertions in the script passed, none soft-failed:**
- Series B's both players reconnected cleanly after the restart, and its
  resumed `GameState` was confirmed byte-for-byte identical to its state
  captured immediately before the kill — multi-series persistence and
  restoration (the core new claim Stage 4b's concurrency introduced)
  holds.
- Series A's survivor reconnected cleanly; triggering a reap immediately
  after the restart (elapsed: 1702ms of the 5000ms budget) correctly did
  **not** yet forfeit series A — the grace period is computed against the
  real persisted `disconnectedAt` timestamp from before the kill, not reset
  by the restart. The script then waited only the *additional* real time
  needed to cross the original 5000ms threshold (confirmed: 5513ms total
  elapsed since the actual disconnect) before triggering reap again —
  deliberately not "wait some more and hope," but computed against the
  ground-truth timestamp.
- Once genuinely elapsed, series A correctly forfeited: its survivor
  received `seriesEnded`/`opponentDisconnected`, could immediately re-queue
  (confirming their own session was released, not held for a replacement),
  and series C — both players gone — was silently abandoned with no
  message sent to anyone, exactly per the two settlement branches Stage 4b
  implemented.
- Cross-series isolation held across the restart specifically, not just
  within one process's lifetime: series B received zero extra messages as
  a side effect of series A/C's settlement, both immediately after
  restart and again after the forfeit actually fired.
- Direct SQLite inspection after everything settled: exactly one series
  (B's) remained in `seriesList`, its persisted `GameState` still
  byte-for-byte identical to its pre-kill snapshot; exactly 2 sessions
  remained bound, both to that surviving series' own `seriesId`, with no
  stale `disconnectedAt` timestamps left behind. A and C were both cleanly
  removed from `seriesList` with no trace, and removing them did not
  touch B's own entry — confirmed structurally, not just behaviorally.

**No bugs found.** Every claim Stage 4b made that a restart could plausibly
break — multi-series persistence, per-session `seriesId` resolution,
wall-clock-correct grace-period tracking across a process restart,
abandonment when both players expire during downtime, and cross-series
isolation holding across the restart — held exactly as designed. Per the
agreed process, finding a bug here would have paused this stage and gone
back for separate authorization before touching any application code; that
didn't happen.

**Not touched, confirmed:** no application or test source file was
modified, created, or deleted by this stage — only this `PROCESS.md` entry.
Production database: untouched. No `git push`, no deploy, no commit beyond
this documentation update.

## Stage 4d — fix CLAUDE.md's stale single-game wording

Documentation only, deliberately deferred until Stage 4b/4c actually
shipped and were verified (per the agreed Stage 4 split), rather than
updating it piecemeal after every sub-stage.

`CLAUDE.md`'s "Don't grow the audience this app is for" section still read
"One shared game, two players, a third visitor rejected outright" — flagged
as stale by the Stage 4 read-only review (this conversation) and confirmed
again at every sub-stage since, since Stage 3 already made it false (a
third visitor queues) and Stage 4b made it false in a second way (any
number of matches run concurrently). Left uncorrected, a future agent
reading `CLAUDE.md` fresh — which is exactly what it's for — would be told
matchmaking and concurrent matches are out of scope, when they're the
app's actual, shipped, tested shape.

Rewritten to state the current rule accurately: no accounts, login, skill
rating, choice of opponent, leaderboard, chat, or spectator role; any
number of independent concurrent two-player matches, fed by one explicit
FIFO queue, is the deliberate current shape — and explicitly warns against
reading that concurrency as license to add the rest (a lobby browser,
skill-based pairing, accounts) just because "more than one match at a
time" is no longer the boundary.

Cross-checked the rest of `PROCESS.md`'s own text and `README.md` against
actual current behaviour while here (this stage's own "cross-checking"
scope, per its original name in the "Not yet built" list): README's "What
good means here" point 4 and "Checked in spec/" paragraph were already
updated in Stage 4b itself (not deferred — only `CLAUDE.md` was). Every
other `PROCESS.md` mention of "one shared game"/"third visitor rejected"
is inside a historical stage's own record of what was true *at that time*
(Stage 2's original decision log, Stage 9's "what changed and why"
framing) — accurate as history, not a live claim about today's behaviour,
and consistent with this file's own convention of recording what changed
and why rather than only the current state. No other stale claims found.

**Not touched, confirmed:** `src/`, `spec/`, `client/` — no application or
test code; `fly.toml`, `Dockerfile`, CI config; production database; no
`git push`, no deploy.

## Stage 5 — best-of-three series lifecycle

A read-only design review (this conversation) preceded it, same discipline
as every stage since 9. It confirmed `engine.ts` needed zero changes — every
series-level concept (running score, series-level winner, series status)
lives entirely in `persistence.ts`'s `SeriesState`, never in `GameState`,
continuing the exact boundary Stage 4b already established: `GameState`
owns single-game rules, `SeriesState` owns the lifecycle wrapped around it.
It also surfaced one genuine question the original Stage 9 rules and the
Stage 4 work hadn't settled, closed by the project owner before
implementation: a "locked" (drawn) game counts toward neither player's
score, and — since draws could otherwise let a series run indefinitely
without either player ever reaching 2 wins — there is deliberately **no
cap** on how many games a series can run through; "best of three" describes
the normal (no-draws) case, not a hard ceiling enforced anywhere.

`SeriesState` gained three fields: `gamesWon: Record<PlayerId, number>`,
`seriesWinner: PlayerId | null`, `seriesStatus: "active" | "finished" |
"abandoned"`. `games: GameState[]` can now hold more than one entry, each a
genuinely fresh `GameState` from `createInitialState()` same as before —
nothing about how a single game plays changes. New `src/server/series.ts`
holds the one pure function this adds, `settleGameOutcome(series)`: reads
the LAST game's `status`/`winner` and folds it into the series' own score,
exactly once per concluded game (guaranteed by every game action's own
existing "cannot act on an already-concluded game" guard — there's no path
that could call this twice against the same conclusion). Three outcomes,
each closed with the project owner before implementation:
- `"finished"` (a real win): increments the winner's `gamesWon`; reaching 2
  sets `seriesWinner` and flips `seriesStatus` to `"finished"`.
- `"locked"` (a draw): no-op. Confirmed: counts toward nobody's score, the
  series simply continues — including through several draws in a row, with
  no upper bound on `games.length` anywhere in this logic.
- `"abandoned"` (mutual `requestQuit`/`rejectQuit` mid-series, Stage 8b's
  existing mechanism, unchanged): ends the WHOLE series winner-less,
  immediately, regardless of the score coming in — confirmed with the
  project owner: there's no rule yet for fairly continuing a series after
  one of its games was called off, so a leader abandoning a game gets no
  credit for it, and a series that was 1-0 when abandoned ends at 1-0,
  nobody's win. `gamesWon` is left exactly as it was — neither incremented
  nor reset — only `seriesStatus`/`seriesWinner` change. Deliberately
  distinct from Stage 4b's disconnect-forfeit path (which always awards the
  WHOLE series to whoever's still there): a mutual abandon has genuinely no
  winner, a forfeit always does.

The message handler's `confirmNewGame` branch is the other half of this
stage: `confirmNewGame` itself is reused completely unchanged (still just
flips `restartConfirmed`, still only returns a new `GameState` once both
have agreed) — what changed is what the server does with that return
value. Once both confirm, the new `GameState` is `series.games.push()`-ed
(a new game within the SAME series, running score carried over) rather than
replacing `games[0]` the way Stage 2-4b's single-game model always did.
`settleGameOutcome` runs immediately after any action that just concluded a
game, before anything is broadcast; if that settlement left the series
itself non-`"active"`, both players (still connected — unlike the
disconnect-forfeit path, where only the survivor can receive anything) are
sent a new `{type: "seriesEnded", reason: "seriesConcluded", series:
<final score>}`, both their `SessionEntry`s are released, and the series is
deleted from `seriesList` — all synchronously, in the same handler call
that settled it, so there is no intermediate state where a stale
`confirmNewGame` from either former player could reach anything: by the
time one could arrive, `appState.sessions` no longer has an entry for
either session id, and the existing `if (!entry || ...)` guard at the top
of the handler already discards it, same as any message from an unseated
session. (An earlier draft added a redundant `seriesStatus !== "active"`
check inside the `confirmNewGame` branch specifically — removed once manual
verification proved it unreachable: validating against a scenario this
branch can never actually observe, not a real one, per this repo's own
"don't write checks for the impossible" discipline.)

`protocol.ts` gained a `SeriesScore` type (`gamesWon`/`seriesStatus`/
`seriesWinner`) carried on every `state` message and the new
`seriesConcluded` variant of `seriesEnded` — the debug client renders the
running score alongside the board and shows the final score/winner on
conclusion.

Verified two ways, not just one: `pnpm check` (103 unit tests — up from 93,
including a new `series.test.ts` covering 1:0/1:1/2:0/2:1 progressions
plus the locked-draw and abandoned-mid-series cases directly against
engineered `GameState` fixtures, since reaching a real `finished`/`locked`
game through actual live random play isn't practical to script
deterministically — the same already-established limitation
`engine.test.ts` itself notes; 16 black-box `spec/` tests, including a
rewrite of the old "ends the game... allows a fresh game afterward" test
into one asserting the WHOLE series ends on mutual abandon, and a new
cross-series-isolation test confirming an unrelated concurrent series
receives nothing as a side effect); and a genuinely real end-to-end
scenario, run manually outside the committed test suite (same precedent as
Stage 6/8b's own "forced a finished state directly" verification, and
Stage 4c's own real-kill-and-restart discipline): paired two real sessions,
directly edited the persisted board/HP via SQLite to put the next real
`play` message one move from lethal, actually killed and restarted the
server process between edits (editing the DB file while a live process
keeps running would just be silently overwritten by its next save — the
same reasoning Stage 4c's restart verification already established), then
let the REAL `playCard` call over the real transport perform the actual
status transition — not faking the end state outright. Confirmed directly
against the persisted SQLite row, not just the live broadcast: 1-0 survives
into game 2 untouched by the board/hand reset; the persisted `games` array
grows to 2 entries (appended, never replacing `games[0]`); reaching 2-0
sends `seriesEnded` to both players with `seriesWinner: "A"` (the one who
actually reached 2 wins, not whoever won the most recent game); the series
is removed from `seriesList` and both sessions released; and a
`confirmNewGame` sent immediately afterward produces no response at all,
confirmed silently ignored rather than erroring.

**Not touched, confirmed:** `src/game/engine.ts`, `src/game/types.ts` —
zero rule changes, reconfirmed by the design review before implementation
and true in the actual diff. Production database: a fourth incompatible
schema change now stacked on the same not-yet-authorized list (`game`→
`series`, `+queue`, `series`→`seriesList`, now `SeriesState`+3 fields) — no
clear, no migration, no deploy, no push.

## Not yet built

The real client UI — the current one is a bare, unstyled debug page — and
the Expansion/Board-Locked/New-Game/voluntary-termination surfaced in it;
`quitRequested` specifically has no UI at all yet. The lobby/join-queue
step added in Stage 3 is likewise bare — a single unstyled button.

Stage 9's own decision (FIFO matchmaking, concurrent independent matches)
is now fully implemented, verified, and documented — Stages 2, 3, 4a, 4b,
4c, and 4d above complete that entire line of work. Stage 5 (best-of-three
series lifecycle) is also now implemented and verified. Still not
implemented:
- The single-sided voluntary-quit action Stage 9 agreed to (immediately
  awarding the series to the opponent, as distinct from the existing mutual
  `requestQuit`/`rejectQuit`) — Stage 4b's forfeit-on-expiry settles the
  *disconnection* case specifically; an explicit "I quit, you win" action
  while both players are still connected is a different, not-yet-built
  primitive.
- The "continue this game vs. start a new game" redesign named back in
  Stage 8a — moot now that Stage 4b replaced the seat-refill model it was
  designed to gate: there is no freed seat to offer a choice about anymore,
  a vacated seat means the whole series already forfeited. Recorded here as
  superseded, not implemented.
- Clearing the live deployment's old-shape persisted game (`game`/no
  `queue` field, pre-Stage-2/3; `series`/no keying, pre-Stage-4b;
  `SeriesState` missing `gamesWon`/`seriesWinner`/`seriesStatus`,
  pre-Stage-5) — not yet authorized or done.

Each further step gets its own explicit go-ahead before code changes, per
this repo's own `CLAUDE.md` — Stages 2, 3, 4a, 4b, 4c, 4d, and 5 above were
each reviewed read-only first, then implemented/verified only once
separately authorized, and the same applies to deploying any of them.

This file is rewritten, not appended to, each time.
