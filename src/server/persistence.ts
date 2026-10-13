import { DatabaseSync } from "node:sqlite";
import type { GameState } from "../game/types.ts";
import type { SessionMap } from "./sessions.ts";

// Stage 2: wraps the one game that exists today behind a stable id, without
// changing anything about how many games can exist at once — `games` always
// holds exactly one entry for now. engine.ts stays unaware this wrapper
// exists at all (per PROCESS.md's Stage 9 guiding principle): it's addressed
// and created by server.ts exactly as createInitialState() was before.
export interface SeriesState {
  seriesId: string;
  games: GameState[];
}

export interface AppState {
  sessions: SessionMap;
  series: SeriesState | null;
  // Stage 3: session ids waiting to be matched, FIFO (push to the back,
  // dequeue from the front) — a session here holds no seat yet and no
  // SessionEntry exists for it. See sessions.ts's enqueue/dequeuePair.
  queue: string[];
}

function emptyAppState(): AppState {
  return { sessions: {}, series: null, queue: [] };
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
