# Process overview

## Stage 1 — stack decision + domain engine

### What the app is

A two-player real-time card/board game. Two players compete for space on a
shared board, placing cards from their hand to form three-in-a-row combos of
one of four card types (Fire, Lightning, Water, Nature), each with its own
effect, racing to take the opponent's HP to 0. The exact rules are fixed by a
Game Specification (v1.0) agreed with the project owner before any code was
written; the engine below is a direct implementation of it, not a reinvention.

### Stack decision (ADR-style)

**Decision**: Node.js (no frontend/backend framework) + the built-in
`node:sqlite` module + `ws` for WebSocket, serving a plain TypeScript/DOM
client — no React/Vue, no bundler.

**Context**: the final-project repo arrives with no default stack and a hard
constraint from `fly.toml`: one `shared-cpu-1x` machine, 256MB RAM, one
`/data` volume, no separate database server. The brief requires multi-user
(two distinguishable sessions sharing state), real-time (~1s propagation) and
persistence across reload/restart/redeploy.

**Alternatives considered**:
- A native-binding SQLite driver (`better-sqlite3`) — rejected: needs
  compilation in the Docker build, more moving parts in a 256MB image, no
  benefit over the built-in module for this scale of state.
- A frontend framework (React/Vue/Svelte) — rejected for this stage: the
  client only needs to render one board, one hand and two HP bars from a
  single pushed state object. A build step and framework runtime cost more
  than they save at this scale, and a plain DOM render keeps the Docker image
  and the "how does this actually run" story simple going into a 2-day
  window. Revisit if the UI grows past straightforward re-rendering.
- A backend framework (Express/Fastify) — rejected for the same reason:
  `node:http` plus `ws`'s upgrade handling covers the two routes and one
  WebSocket endpoint this app needs.

**Trade-off accepted**: writing a bit more server wiring by hand than a
framework would give for free, in exchange for a smaller, more legible
surface area that's easier to account for at the crit.

### Why engine tests run separately from `spec/`

`spec/global-setup.ts` waits for a live app at `APP_URL` before any test in
that config runs — correct for `spec/`'s job (black-box checks against the
deployed artifact), wrong for the domain engine's pure-function tests, which
have no server to wait for and should run in milliseconds. `src/game/` has
its own `vitest.engine.config.ts` with no `globalSetup`, and `pnpm check` now
runs `pnpm typecheck && pnpm test:engine && pnpm test` — engine tests first
since they're fast and don't need anything running, then the existing `spec/`
contract against the deployed app. `tsconfig.json`'s `include` now covers
`src` as well as `spec`/`scripts`.

### The engine itself

`src/game/engine.ts` implements the turn/AP state machine and the full
combo-resolution pipeline (detect, calculate damage, apply damage, check win,
apply effects, clear, update board) as pure functions over a `GameState`
object — no I/O, no transport, no storage. `detectCombos` scans the board
generically by size, so the 5x5 Expansion (built in Stage 2, below) was a
board-size change, not a rewrite of combo detection.

Decisions confirmed with the project owner before implementing (the spec left
these open, §20/§21):
- the game is a single shared instance: it starts automatically once a
  second player joins, and a finished game simply stays finished this stage
  (no "New Game" button yet)
- a third visitor cannot join or affect the game; it sees "Game is full" (not
  yet built — this is a session-layer concern for the next stage)
- stacked same-type effects from one Play fully stack: two Lightning combos
  put the opponent's next turn at 0 AP, which is skipped entirely (the turn
  after that is normal again); two Nature combos add +2 AP to the current
  turn, usable immediately
- a 4-in-a-row is two overlapping 3-in-a-row combos, both resolved in full,
  by the same rule that defines any 3 consecutive same-owner/same-type cells
  as a combo

Stage 1's 20 tests cover the turn/AP rules, all four combo directions, the
mixed-owner-is-not-a-combo case, the shared-card cross shape, 4-in-a-row,
single- and double-combo Lightning/Nature stacking, Water's draw, and the
immediate-game-end-skips-later-phases rule — including, after an internal
review, a dedicated case proving a *lethal* Lightning combo never applies its
AP effect (only the clearing-skip had a test at first; a lethal combo with an
effect to skip did not).

## Stage 2 — Board + 3x3 → 5x5 Expansion (§12)

Still engine-only: no server, no UI. `detectCombos` needed no changes — once
the board is a 5x5 grid it is, per §12, "一个连续棋盘" (one continuous
board), so a combo spanning the Main Board and the Expansion ring is just an
ordinary line on a bigger grid.

What's new in `src/game/engine.ts`:
- `isMainBoardFull` checks the centered 3x3 region of whichever grid is
  currently active (offset 0 at 3x3, offset 1 at 5x5).
- `expandBoard` / `shrinkBoard` resize the board, copying the Main Board's
  contents to/from the new grid's center.
- `updateBoard` (§11 Phase 7) expands when the Main Board becomes full and
  shrinks when it stops being full, but reacts only to the Main Board's own
  fullness — an Expansion-only combo leaves a full Main Board alone, matching
  §12's "如果 Combo 只清除了 Expansion 的牌，而 Main Board 仍然满: Expansion
  保持存在".

One structural fix this required: §11 frames phases 1-7 as running after
*every* Play, not only ones that form a combo — the Main Board can become
full (or, after a clear, stop being full) on a Play that completes no combo
at all. Stage 1's `applyCombos` returned early whenever `combos.length === 0`,
which was harmless then (phases 2-6 are no-ops with zero combos) but would
have silently skipped Phase 7 forever. Phases 2-6 are now the only part
gated on `combos.length > 0`; Phase 7 (`updateBoard`) always runs when the
game is still active, and a lethal Play still skips 5-7 entirely as before.
All 20 Stage 1 tests were re-run after this change and still pass unchanged.

**Explicit instruction followed**: when the Main Board stops being full, the
Expansion ring's remaining contents are discarded, not retained as hidden
state for a possible future re-expansion. `shrinkBoard` only copies the
center 3x3 into the new grid; nothing outside it survives anywhere. A test
confirms this directly (`"shrinks back to 3x3 ... discarding the rest of the
Expansion ring"`): an unrelated card planted in the far corner of the ring is
simply gone once the board shrinks — it cannot appear in a 3x3 array.

6 new tests cover: staying 3x3 below a full Main Board, expanding the moment
it fills (even with no combo on that Play) and preserving the prior contents
at the new center, a combo detected entirely inside the ring, a combo
spanning the Main Board and the ring, the Expansion persisting through an
Expansion-only clear, and the shrink-and-discard case above. All 26 tests
(20 + 6) pass; `pnpm typecheck` is clean.

### Not yet built

Server, persistence, session/player identity, the client UI, and deployment
of an actual game (the Dockerfile still serves the starter placeholder).
These are later stages of this same process account — this file is
rewritten, not appended to, as each stage lands.
