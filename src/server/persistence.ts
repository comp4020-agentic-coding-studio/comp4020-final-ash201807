import { DatabaseSync } from "node:sqlite";
import type { GameState } from "../game/types.ts";
import type { SessionMap } from "./sessions.ts";

// Stage 2: wraps a game behind a stable id, without engine.ts ever needing
// to know this wrapper exists (per PROCESS.md's Stage 9 guiding principle)
// — it's addressed and created by server.ts exactly as createInitialState()
// always was. `games` always holds exactly one entry today; best-of-three
// (not yet built) is confirmed orthogonal to this shape — it would just
// mean `games` sometimes holds more than one.
export interface SeriesState {
  seriesId: string;
  games: GameState[];
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
export function normalizeSeriesList(value: unknown): Record<string, SeriesState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  if ("seriesId" in value && "games" in value) return {};
  return value as Record<string, SeriesState>;
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
