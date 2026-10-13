import { DatabaseSync } from "node:sqlite";
import type { GameState, PlayerId } from "../game/types.ts";
import type { SessionMap } from "./sessions.ts";

// Stage 2: wraps a game behind a stable id, without engine.ts ever needing
// to know this wrapper exists (per PROCESS.md's Stage 9 guiding principle)
// — it's addressed and created by server.ts exactly as createInitialState()
// always was.
//
// Stage 5 (best-of-three): `games` now holds 1-3 entries — the engine still
// knows nothing about "series", it only ever produces ordinary single-game
// GameStates; server.ts decides when to push another one. `gamesWon`/
// `seriesWinner`/`seriesStatus` are the series-level concepts GameState
// itself never gains a field for, per the same guiding principle —
// confirmed orthogonal in the Stage 5 design review: a series's own running
// score is a server-level bookkeeping concern read OFF of each completed
// GameState's `winner`, never a rule the engine enforces.
export interface SeriesState {
  seriesId: string;
  games: GameState[];
  // Games won by each player so far in this series, 0-2. Updated once per
  // completed game (see server.ts's settleGameOutcome) — never recomputed
  // from scratch by re-scanning `games`, so a later "reset the board for
  // the next game" write can never accidentally wipe it: the two are always
  // separate writes to separate fields, never one object-wide replacement.
  gamesWon: Record<PlayerId, number>;
  // Set the moment gamesWon reaches 2 for either player — null until then.
  // Never set for an abandoned series (both-disconnected, or a single game
  // ending "abandoned" by mutual requestQuit mid-series per the project
  // owner's own confirmed decision): an abandoned series has no winner by
  // definition, distinct from nobody having reached 2 wins YET.
  seriesWinner: PlayerId | null;
  // "active": still playable, win condition not yet met. "finished": a
  // player reached 2 game-wins; games is complete, no further
  // confirmNewGame is possible. "abandoned": the series itself ended with
  // no winner — either a mid-series "abandoned" single game (mutual
  // requestQuit, per the project owner's confirmed decision: the WHOLE
  // series ends, not just that one game, since there's no rule yet for
  // fairly continuing after one game was called off) or the forfeit/
  // both-disconnected paths reapAndSettleSeries already handles. Distinct
  // from any individual GameState's own status — a series can be "active"
  // while its current game is "finished"/"locked", in the gap between one
  // game ending and both players confirming the next.
  seriesStatus: "active" | "finished" | "abandoned";
}

export interface AppState {
  sessions: SessionMap;
  // Stage 4b: keyed by seriesId rather than a single SeriesState | null, so
  // any number of independent series can be active at once — the server
  // resolves "which series" per-session (via that session's own
  // SessionEntry.seriesId) rather than there being one global answer to
  // "the" series. Empty object, not null, when nothing's active — mirrors
  // SessionMap's own Partial<Record<...>> pattern already in use.
  seriesList: Record<string, SeriesState>;
  // Stage 3: session ids waiting to be matched, FIFO (push to the back,
  // dequeue from the front) — a session here holds no seat yet and no
  // SessionEntry exists for it. See sessions.ts's enqueue/dequeuePair.
  queue: string[];
}

function emptyAppState(): AppState {
  return { sessions: {}, seriesList: {}, queue: [] };
}

// Pre-Stage-4b rows store a single `series: SeriesState | null` rather than
// a keyed `seriesList` — reading that old shape directly as the new type
// would be actively wrong, not just empty: the old shape's own top-level
// keys ARE `seriesId`/`games`, so `seriesList["games"]` would resolve to a
// GameState array where a SeriesState was expected, a crash waiting to
// happen the moment anything iterates it expecting SeriesState values.
// Detected explicitly by shape (a top-level `seriesId` string field is only
// ever present on the OLD single-series shape, never on a seriesId-keyed
// map) rather than assumed compatible. Same "safe default, never guess"
// family as sessions.ts's own normalize functions: anything unrecognized
// (missing, null, an array, or the old shape) reads as "no series active"
// rather than crashing or silently misreading old data as new.
//
// Pre-Stage-5 entries (SeriesState without gamesWon/seriesWinner/
// seriesStatus) are upgraded per-entry rather than discarded: a safe
// default of {A:0, B:0} / null / "active" never invents a score that
// wasn't there, and never retroactively ends a series that was actually
// still being played — consistent with every other normalize* function's
// "never guess, never auto-abandon" reasoning in this codebase.
export function normalizeSeriesList(value: unknown): Record<string, SeriesState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  if ("seriesId" in value && "games" in value) return {};
  const next: Record<string, SeriesState> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || !("seriesId" in entry) || !("games" in entry)) continue;
    const e = entry as Partial<SeriesState> & Pick<SeriesState, "seriesId" | "games">;
    next[id] = {
      seriesId: e.seriesId,
      games: e.games,
      gamesWon: e.gamesWon ?? { A: 0, B: 0 },
      seriesWinner: e.seriesWinner ?? null,
      seriesStatus: e.seriesStatus ?? "active",
    };
  }
  return next;
}

// The whole app's state — the session->player map and the game itself — is
// one JSON blob in one row. There is exactly one game at a time (confirmed:
// it starts automatically once a second session joins, no rooms), so a
// relational schema would buy nothing here; the brief itself says to start
// from the smallest schema that can carry the core interaction.
export class Persistence {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      )
    `);
  }

  load(): AppState {
    const row = this.db.prepare("SELECT data FROM app_state WHERE id = 1").get() as
      | { data: string }
      | undefined;
    if (!row) return emptyAppState();
    return JSON.parse(row.data) as AppState;
  }

  save(state: AppState): void {
    this.db
      .prepare(
        "INSERT INTO app_state (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      )
      .run(JSON.stringify(state));
  }

  close(): void {
    this.db.close();
  }
}
