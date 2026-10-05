# Your harness

Rules for working on this repo, derived from what `README.md` claims is
"good" for this app. The game rules themselves are fixed by a Game
Specification (v1.0) agreed with the project owner outside this repo; this
file is about how an agent should work here, not a restatement of those
rules.

## Game rules are not yours to invent or adjust

HP, AP costs, card effects, combo conditions, combo damage, Expansion
trigger/removal, win conditions, and any stacking behaviour between combos
are fixed. If something in `src/game/engine.ts` looks ambiguous, inconsistent,
or incomplete against the spec, stop and ask — do not pick a reading and
implement it silently. Every non-obvious rule decision already made is
recorded in `PROCESS.md`, with the reasoning; read that before assuming a gap
is unresolved.

## The server is the only authority

README point 1. Never add game-rule logic to `client/` (or any future real
UI) that the server doesn't also enforce — the client renders state, it does
not decide it. A change that makes the client compute or guess at AP, combo
validity, or turn order instead of waiting for the server's pushed state is a
regression against this app's definition of good, not a convenience.

## Don't grow the audience this app is for

README point 4. No accounts, login, matchmaking, multiple concurrent games,
chat, or spectator mode. One shared game, two players, a third visitor
rejected outright. If a task seems to need one of these, it's a sign the task
is out of scope for this app, not a sign to add it.

## Tests

- `pnpm check` = `typecheck && test:engine && test`. `src/**/*.test.ts` (via
  `vitest.engine.config.ts`) covers pure logic with no server needed;
  `spec/**/*.test.ts` is black-box against a *running* app at `APP_URL` and
  must keep passing against real server behaviour, never mocked.
- The two fixed checks in `spec/invariants.test.ts` (`/` is 200, `/readme/`
  serves `README.md`'s headings) are the course's contract — don't delete or
  weaken them.
- A new engine rule or server behaviour gets a test before it's considered
  done, in whichever of the two suites actually exercises it.

## Irreversible or external actions need an explicit go-ahead

Deploying (`flyctl deploy`), restarting or modifying the live machine,
touching `/data/game.db` on the deployed app, flipping the repo public, and
running `/ship` all affect the one live, shared instance of this app (or make
it visible to others). Confirm before any of them — this applies even inside
an agentic workflow, not just to a human typing commands by hand.
