# Process overview

## What this is

A two-player real-time card/board game. Place cards from a hand of four
types onto a shared 3x3 board (expanding to 5x5); three in a row/column/
diagonal sharing an owner or a card type forms a Combo, with Lightning/
Water/Nature/Fire effects on a same-type Combo. A match is best of three
games. The rules are fixed by a Game Specification agreed with the project
owner, revised four times after real two-player playtesting surfaced
problems the spec didn't anticipate — nothing in `src/game/engine.ts` is
invented; `README.md` records what "good" means for this app and why.
Two of those revisions came directly from watching two real people play
the deployed app, not from reading the rules on paper: Stage 6 found
Combos needing both a shared owner AND a shared type too rare across four
types for a 3x3 board to ever fill one, so the rule split into an
owner-only Combo (15 damage) and a weaker type-only one (5 damage); Stage
7 found that even with that split, which *type* a player held still
rarely mattered, so a same-type Combo across different owners was added
back in as its own, separate 5-damage case. Each revision's own read-only
review checked which existing tests' fixtures silently depended on the
old invariant before rewriting them, rather than assuming the new rule
was a drop-in change.

## Stack and workflow

Node.js, no framework, `node:sqlite`, `ws`, a plain DOM client — `fly.toml`
fixes one 256MB machine and one `/data` volume with no separate database,
so a bundler or ORM would cost more than it saves at this scale. Every
stage is built, then **verified by actually running the result**, not read
back: real two-client WebSocket scripts, a real `flyctl machine restart`
mid-grace-period, direct SQLite inspection after a live pairing. Two
server bugs this surfaced that reading the code never would have:
`GET /` was claiming a player slot on every uncookied request
([`657b19b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-aSH201807/commit/657b19b)),
and a stale `game`-shape row crashed `confirmNewGame` on a live Fly
redeploy, resolved only by clearing it (Stage 6). Every new rule or server
behaviour gets a test before it's considered done
(`src/**/*.test.ts` for pure engine logic, `spec/**/*.test.ts` black-box
against a *running* app) — 124 engine tests, 25 black-box tests passing.

Product direction came in distinct decisions from the project owner, each
preceded by a read-only design review before any code changed: Stage 9
moved the app from "exactly two named players" to FIFO matchmaking with
concurrent independent series and best-of-three scoring, confirmed as a
deliberate scope change rather than assumed
([`1e29ba8`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-aSH201807/commit/1e29ba8)
is the live Fly deploy this built toward). An earlier draft of that same
decision (spectator mode + seat-swap,
[`39b8b52`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-aSH201807/commit/39b8b52))
was superseded once a read-only trace showed it still capped the app at
one game at a time. Stage 4b's own review found a real structural conflict
mid-implementation — a freed seat can't be safely refilled once several
series run concurrently — resolved by switching to a forfeit-the-whole-
series model instead of Stage 3's seat-refill. Crit 10 added
authorization documentation, anonymous display IDs, structured server
logging, and the first real client UI, closing the gap between what the
server already enforced and what a stranger could actually see and use.

## Agent-authored bugs, and how the harness grew to catch them

A 2026-11-07 read-only review found two real client bugs in already-shipped
work: a damage-pop animation appended into a 6px-tall clipping container
instead of its intended `position: relative` ancestor, and a queued combo
animation never cleared on series end, leaking stale cell flashes into the
next match. Both were fixed, but the review also generalised the second
bug's *shape* — three independently torn-down ephemeral UI timers, each a
candidate to be forgotten — into a `registerEphemeralUi`/`resetEphemeralUi`
pair, so a future fourth timer is covered automatically rather than relying
on remembering to add it to a teardown list by hand.

A more serious instance came from a UX follow-up: round 3 asked why a
disconnected opponent's forfeit sometimes never notified the survivor.
Investigation found `reapAndSettleSeries` was only ever checked lazily, on
the next unrelated connection — a still-open, idle survivor tab could sit
past a fully-elapsed grace period forever. Fixed with the same live-timer
shape the turn clock already used
(`disconnectReapTimers`/`scheduleDisconnectReap`, mirroring
`turnTimers`/`scheduleTimer`). Shipping that fix cost two further rounds
of CI-only failures that two clean local runs each failed to catch:
shortening `TURN_DURATION_MS` for a faster CI run silently starved the
whole shared test process (every concurrent pairing's turn timer firing
on the same short cycle), and a later fix set `DISCONNECT_GRACE_MS` only
inside the Docker container, not the GitHub Actions shell running the
tests themselves, so the test and the server it was testing used different
values. Both were root-caused by deliberately reproducing the exact gap
locally, not guessed, and both fixes were confirmed only once a real CI
run was watched to completion — the discipline the repo's own `CLAUDE.md`
already asks for, applied here to CI as the thing under test, not just the
app.

## Where it stands, what's deliberately not built

FIFO matchmaking, best-of-three, unilateral forfeit, authorization,
structured logging, and a real client UI are all implemented, tested, and
live. Several rounds of UI follow-up (effect-clarity wording, owner-colour
contrast re-tuned to the board's own palette, a result dialog for every
way a match can end, a self-firing disconnect timer) are each documented
with their own verification. Deliberately not built: a "continue vs. new
game" seat-takeover redesign, superseded once the forfeit model removed
the freed-seat case it was meant to gate; and migrating the live
deployment's old-shape persisted rows, which would touch `/data/game.db`
directly and so needs explicit authorization the project owner hasn't yet
given, per this repo's own `CLAUDE.md`.
