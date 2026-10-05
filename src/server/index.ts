import { createServer } from "./server.ts";
import { Persistence } from "./persistence.ts";

const port = Number(process.env.PORT ?? 8080);
// fly.toml mounts the one persistent volume at /data; DB_PATH is only
// overridden for local development, where /data doesn't exist.
const dbPath = process.env.DB_PATH ?? "/data/game.db";

const persistence = new Persistence(dbPath);
const server = createServer(persistence);

server.listen(port, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${port}, db at ${dbPath}`);
});
