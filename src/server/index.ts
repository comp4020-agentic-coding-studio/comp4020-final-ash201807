import { createServer } from "./server.ts";
import { Persistence } from "./persistence.ts";

const port = Number(process.env.PORT ?? 8080);
// fly.toml mounts the one persistent volume at /data; DB_PATH is only
// overridden for local development, where /data doesn't exist.
const dbPath = process.env.DB_PATH ?? "/data/game.db";
// How long a disconnected session keeps its player slot (Stage 8a) before
// it's freed. Overridden to a few seconds for spec/ runs that need to
// observe a real expiry without actually waiting 30s — see spec/game.test.ts.
const disconnectGraceMs = Number(process.env.DISCONNECT_GRACE_MS ?? 30_000);
// Stage 2 (Turn Timer): how long a player has to act before their turn
// auto-ends. Same override pattern as disconnectGraceMs, for the same
// reason — spec/ runs this in milliseconds rather than really waiting 45s.
const turnDurationMs = Number(process.env.TURN_DURATION_MS ?? 45_000);

const persistence = new Persistence(dbPath);
const server = createServer(persistence, { disconnectGraceMs, turnDurationMs });

server.listen(port, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${port}, db at ${dbPath}`);
});
