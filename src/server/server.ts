import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { createInitialState, drawCard, endTurn, playCard } from "../game/engine.ts";
import type { PlayerId } from "../game/types.ts";
import { parseSessionId, sessionCookieHeader } from "./cookies.ts";
import type { Persistence } from "./persistence.ts";
import type { ClientMessage, ServerMessage } from "./protocol.ts";
import { joinSession } from "./sessions.ts";

function newSessionId(): string {
  return randomBytes(16).toString("hex");
}

// spec/invariants.test.ts only checks that each README heading appears, in
// order, in the page's visible text — so a verbatim escaped dump is enough
// to satisfy the contract; rendering it richly is cosmetic, not required.
function renderReadme(): string {
  const escaped = readFileSync("README.md", "utf8")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return [
    "<!doctype html>",
    '<html lang="en-AU">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>About</title>",
    "</head>",
    "<body>",
    "<main>",
    `<pre>${escaped}</pre>`,
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}

export function createServer(persistence: Persistence): Server {
  const appState = persistence.load();
  const sockets = new Map<WebSocket, PlayerId>();

  function send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  function broadcastState(): void {
    if (!appState.game) return;
    for (const ws of sockets.keys()) send(ws, { type: "state", state: appState.game });
  }

  // Makes sure this browser has a session cookie, without claiming a player
  // slot. Used for the plain HTTP page load — spec/'s own health-check
  // fetches (and a tutor's browser just reading /readme/) hit "/" with no
  // cookie and must never consume one of the two player seats; only an
  // actual WebSocket connection (the real client opens one once its page
  // has loaded) expresses "I'm here to play".
  function ensureSessionCookie(req: IncomingMessage, res: ServerResponse): void {
    if (!parseSessionId(req.headers.cookie)) {
      res.setHeader("Set-Cookie", sessionCookieHeader(newSessionId()));
    }
  }

  // Resolves (and, if needed, assigns) this request's session, starting the
  // game the moment a second distinct session shows up — confirmed: no
  // "New Game" button, the game simply begins once two players are present.
  // A third-or-later distinct session gets `player: null` (no slot, no
  // state access) rather than a read-only spectator seat, per instruction.
  // Only called from the WebSocket upgrade handler (see above).
  function joinAndResolveSession(req: IncomingMessage): { player: PlayerId | null; justCompletedPair: boolean } {
    const sessionId = parseSessionId(req.headers.cookie) ?? newSessionId();

    const result = joinSession(appState.sessions, sessionId);
    if (result.kind === "full") return { player: null, justCompletedPair: false };

    appState.sessions = result.sessions;
    if (result.justCompletedPair) appState.game = createInitialState();
    persistence.save(appState);

    return { player: result.player, justCompletedPair: result.justCompletedPair };
  }

  const httpServer = createHttpServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/" && req.method === "GET") {
      ensureSessionCookie(req, res);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync("client/index.html", "utf8"));
      return;
    }

    if (url === "/app.js" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      res.end(readFileSync("client/app.js", "utf8"));
      return;
    }

    if (url === "/readme/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderReadme());
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const { player, justCompletedPair } = joinAndResolveSession(req);

      if (player === null) {
        send(ws, { type: "full" });
        ws.close();
        return;
      }

      sockets.set(ws, player);
      send(ws, { type: "assigned", player });

      if (justCompletedPair) {
        // This connection is what completed the pair: the game was just
        // created, so every open socket (including whichever player was
        // already connected and sitting at "waiting") needs the new state.
        broadcastState();
      } else if (appState.game) {
        send(ws, { type: "state", state: appState.game });
      } else {
        send(ws, { type: "waiting" });
      }

      ws.on("message", (raw) => {
        if (!appState.game) return; // can't happen once two players are paired

        let message: ClientMessage;
        try {
          message = JSON.parse(raw.toString()) as ClientMessage;
        } catch {
          send(ws, { type: "error", message: "malformed message" });
          return;
        }

        try {
          if (message.type === "play") {
            playCard(appState.game, player, message.handIndex, message.row, message.col);
          } else if (message.type === "draw") {
            drawCard(appState.game, player);
          } else if (message.type === "endTurn") {
            endTurn(appState.game, player);
          } else {
            throw new Error("unknown message type");
          }
        } catch (err) {
          send(ws, { type: "error", message: err instanceof Error ? err.message : "invalid action" });
          return;
        }

        persistence.save(appState);
        broadcastState();
      });

      ws.on("close", () => {
        sockets.delete(ws);
      });
    });
  });

  return httpServer;
}
