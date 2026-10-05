import { DatabaseSync } from "node:sqlite";
import type { GameState } from "../game/types.ts";
import type { SessionMap } from "./sessions.ts";

export interface AppState {
  sessions: SessionMap;
  game: GameState | null;
}

function emptyAppState(): AppState {
  return { sessions: {}, game: null };
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
