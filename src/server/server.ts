import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { confirmNewGame, createInitialState, drawCard, endTurn, playCard, rejectQuit, requestQuit } from "../game/engine.ts";
import type { GameState, PlayerId } from "../game/types.ts";
import { parseSessionId, sessionCookieHeader } from "./cookies.ts";
import type { Persistence, SeriesState } from "./persistence.ts";
import type { ClientMessage, ServerMessage } from "./protocol.ts";
import {
  bindActiveSeries,
  dequeueOne,
  enqueue,
  markDisconnected,
  nextOpenSeat,
  normalizeQueue,
  normalizeSessions,
  reapExpiredSessions,
  removeFromQueue,
  seatOne,
} from "./sessions.ts";

function newSessionId(): string {
  return randomBytes(16).toString("hex");
}

// Same id scheme as newSessionId — a seriesId has no format relationship to
// a sessionId, they just both want a short unguessable random token.
function newSeriesId(): string {
  return randomBytes(16).toString("hex");
}

// Stage 2/3 keep exactly one series alive at a time, so "the current game"
// is always games[0] — this accessor is the one place that assumption
// lives, instead of every call site spelling out series.games[0] directly.
function currentGame(series: SeriesState | null): GameState | null {
  return series?.games[0] ?? null;
}

export interface ServerOptions {
  // How long a disconnected SEATED session keeps its player slot before
  // it's freed — long enough that an ordinary page reload (close then
  // immediately reopen with the same cookie) never loses the seat. Injectable
  // so spec/ can run this in milliseconds instead of really waiting; defaults
  // to the real 30s grace period otherwise. Only applies to a seated
  // session — a merely QUEUED session that disconnects is dropped outright,
  // no grace period at all (Stage 9/3's own rule: it never held a seat with
  // state at stake).
  disconnectGraceMs?: number;
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

export function createServer(persistence: Persistence, options: ServerOptions = {}): Server {
  const disconnectGraceMs = options.disconnectGraceMs ?? 30_000;
  const appState = persistence.load();
  // Pre-Stage-8a rows store a bare PlayerId per session, and pre-Stage-2
  // rows have no seriesId; upgrade both once, here, before anything else
  // reads appState.sessions (see normalizeSessions' own comment for why
  // guessing wrong here is dangerous). Pre-Stage-3 blobs have no `queue`
  // field at all — normalizeQueue reads that as nobody queued.
  appState.sessions = normalizeSessions(appState.sessions);
  appState.queue = normalizeQueue(appState.queue);

  // Seated sockets only — the set broadcastState() pushes state to. A
  // session moves into this map the instant pumpQueue() seats it
  // (or immediately on a reconnect to an already-seated session), and is
  // removed on close.
  const sockets = new Map<WebSocket, PlayerId>();
  // Sockets for sessions currently in appState.queue, keyed by sessionId —
  // needed so a pairing triggered by some OTHER, unrelated connection (e.g.
  // reaping freed the one active series slot) can still reach these two
  // sessions' own open sockets to tell them they've been seated. A session
  // with no entry here and no entry in `sockets` is just sitting in the
  // lobby, having connected but not yet sent joinQueue.
  const queuedSockets = new Map<string, WebSocket>();

  function send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  function broadcastState(): void {
    const game = currentGame(appState.series);
    if (!game) return;
    for (const ws of sockets.keys()) send(ws, { type: "state", state: game });
  }

  // Makes sure this browser has a session cookie, without claiming a seat or
  // a queue slot. Used for the plain HTTP page load — spec/'s own
  // health-check fetches (and a tutor's browser just reading /readme/) hit
  // "/" with no cookie and must never consume anything; only an explicit
  // joinQueue message (sent after the real client's WebSocket is open and
  // the player has clicked to play) expresses "I'm here to play".
  function ensureSessionCookie(req: IncomingMessage, res: ServerResponse): void {
    if (!parseSessionId(req.headers.cookie)) {
      res.setHeader("Set-Cookie", sessionCookieHeader(newSessionId()));
    }
  }

  // If the active series' sessions have all been reaped (both seated players
  // disconnected past their grace period), the series itself is cleared —
  // nobody is left to have it with. Pure wall-clock comparison against a
  // persisted timestamp, not a running timer, so this gives the right answer
  // even if the server process was stopped (Fly auto-stops the machine while
  // nobody's connected) for the entire grace period and only just woke back
  // up for this request — same reasoning as Stage 8a, now scoped to
  // whichever series is currently active rather than "the one global game".
  function reapAndFreeSeries(): void {
    appState.sessions = reapExpiredSessions(appState.sessions, Date.now(), disconnectGraceMs);
    if (Object.keys(appState.sessions).length === 0) {
      appState.series = null;
    }
    persistence.save(appState);
  }

  // Stage 3's one and only pairing path, one session at a time — the same
  // granularity the pre-Stage-3 joinSession used (a single connecting
  // session either takes a free seat or doesn't), just now sourced from the
  // persisted queue instead of directly from whichever request happens to
  // be connecting. This deliberately preserves Stage 8a's existing
  // behaviour: if a seat frees while the OTHER player is still seated and
  // connected, the next queued session takes over that ONE seat — not a
  // pair plucked together — and bindActiveSeries (below) then binds BOTH
  // the new arrival and the untouched survivor to a fresh series, exactly
  // as before (a known, already-documented limitation: the survivor's whole
  // match is replaced too, not resumed; fixing that is a later stage, not
  // this one).
  //
  // Only ever seats while fewer than two sessions are seated, and only ever
  // starts a fresh series the moment that count reaches exactly two — this
  // stage still runs exactly one series at a time, so a third-or-later
  // queued session simply keeps waiting, however long the active series
  // takes, until a seat actually frees.
  //
  // Called after every reap (a slot may have just freed, independent of who
  // triggered the connection) and after every joinQueue (the queue may have
  // just grown, or a seat may already be free) — both are the only two ways
  // the queue's contents or the open-seat count can change, so there's no
  // scenario needing a scheduled/background trigger (same reasoning Stage
  // 8a already established for reaping).
  function pumpQueue(): void {
    const seatedThisCall: Array<{ sessionId: string; ws: WebSocket | undefined }> = [];

    while (Object.keys(appState.sessions).length < 2) {
      const next = dequeueOne(appState.queue);
      if (!next) break;

      appState.queue = next.rest;
      const seat = nextOpenSeat(appState.sessions);
      appState.sessions = seatOne(appState.sessions, next.sessionId, seat);

      const ws = queuedSockets.get(next.sessionId);
      queuedSockets.delete(next.sessionId);
      if (ws) {
        sockets.set(ws, seat);
        send(ws, { type: "assigned", player: seat });
      }
      seatedThisCall.push({ sessionId: next.sessionId, ws });
    }

    // Only treat this as "a pair just completed" if THIS call's dequeuing is
    // what brought the seated count up to two — not merely because it
    // already happened to be two before this call started (e.g. a third
    // visitor's unrelated joinQueue, with an unrelated match already in
    // progress, must never retrigger this branch and wipe that match).
    // Unconditional once that's true — deliberately NOT gated on whether
    // appState.series already holds a stale reference: Stage 8a's own
    // already-documented limitation is that refilling a single freed seat
    // (the OTHER player's session never having been reaped) still replaces
    // the whole series, survivor's progress included. Stage 3 preserves
    // that exact behaviour rather than fixing it — the fix is a separate,
    // not-yet-authorized later stage (PROCESS.md's "continue vs. new game"
    // redesign).
    if (seatedThisCall.length > 0 && Object.keys(appState.sessions).length === 2) {
      const seriesId = newSeriesId();
      appState.sessions = bindActiveSeries(appState.sessions, seriesId);
      appState.series = { seriesId, games: [createInitialState()] };
      persistence.save(appState);
      broadcastState();
      return;
    }

    persistence.save(appState);
    // No pair completed this call: anyone freshly seated this round (there
    // can be at most one — seating a second would have completed a pair
    // above) is seated alone, waiting for an opponent, same as a lone
    // connecting session always has been since before Stage 3.
    for (const { ws } of seatedThisCall) {
      if (ws) send(ws, { type: "waiting" });
    }
  }

  // Resolves what this connecting session already is, without creating
  // anything new — a seated session resumes automatically (no explicit
  // action needed to keep playing a match already in progress); a queued
  // session re-associates its new socket with its existing queue position
  // (no explicit re-queueing, and critically no re-enqueuing — it keeps its
  // original FIFO place); anyone else is new and sits in the lobby until
  // they send joinQueue.
  function resolveSession(req: IncomingMessage): {
    sessionId: string;
    status: "seated" | "queued" | "new";
    player?: PlayerId;
  } {
    reapAndFreeSeries();
    pumpQueue();

    const sessionId = parseSessionId(req.headers.cookie) ?? newSessionId();

    const existing = appState.sessions[sessionId];
    if (existing) {
      if (existing.disconnectedAt !== null) {
        appState.sessions = { ...appState.sessions, [sessionId]: { ...existing, disconnectedAt: null } };
        persistence.save(appState);
      }
      return { sessionId, status: "seated", player: existing.player };
    }

    if (appState.queue.includes(sessionId)) {
      return { sessionId, status: "queued" };
    }

    return { sessionId, status: "new" };
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
      const { sessionId, status, player } = resolveSession(req);

      if (status === "seated") {
        sockets.set(ws, player!);
        send(ws, { type: "assigned", player: player! });
        const game = currentGame(appState.series);
        // "waiting" is still reachable: pumpQueue seats one session at a
        // time, so the first of a pair to be seated has no series yet until
        // a second one arrives — same state Stage 2 already had.
        if (game) send(ws, { type: "state", state: game });
        else send(ws, { type: "waiting" });
      } else if (status === "queued") {
        queuedSockets.set(sessionId, ws);
        send(ws, { type: "queued" });
      }
      // status === "new": nothing to send yet — the client shows its lobby
      // UI and waits for the player to click "join queue", which sends the
      // joinQueue message handled below.

      ws.on("message", (raw) => {
        let message: ClientMessage;
        try {
          message = JSON.parse(raw.toString()) as ClientMessage;
        } catch {
          send(ws, { type: "error", message: "malformed message" });
          return;
        }

        if (message.type === "joinQueue") {
          if (appState.sessions[sessionId]) {
            send(ws, { type: "error", message: "already in an active match" });
            return;
          }
          // Idempotent: a session already queued (e.g. a brief reconnect)
          // just gets re-told it's queued, at its original FIFO position —
          // enqueue() itself is a no-op for an id already present.
          appState.queue = enqueue(appState.queue, sessionId);
          queuedSockets.set(sessionId, ws);
          persistence.save(appState);
          send(ws, { type: "queued" });
          pumpQueue();
          return;
        }

        const entry = appState.sessions[sessionId];
        const game = currentGame(appState.series);
        if (!entry || !game) return; // not seated in an active series; ignore game actions

        const seatedPlayer = entry.player;
        try {
          if (message.type === "play") {
            playCard(game, seatedPlayer, message.handIndex, message.row, message.col);
          } else if (message.type === "draw") {
            drawCard(game, seatedPlayer);
          } else if (message.type === "endTurn") {
            endTurn(game, seatedPlayer);
          } else if (message.type === "confirmNewGame") {
            // Unlike the other actions, confirmNewGame can return a BRAND
            // NEW GameState (once both players have confirmed) rather than
            // mutate the existing one in place — the reassignment here is
            // load bearing, not cosmetic. Session identities
            // (appState.sessions) are untouched either way.
            appState.series!.games[0] = confirmNewGame(game, seatedPlayer);
          } else if (message.type === "requestQuit") {
            requestQuit(game, seatedPlayer);
          } else if (message.type === "rejectQuit") {
            rejectQuit(game, seatedPlayer);
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
        queuedSockets.delete(sessionId);

        // Queued (no seat yet): removed outright, no grace period — it
        // never held a seat with state at stake (Stage 9/3's own rule).
        if (appState.queue.includes(sessionId)) {
          appState.queue = removeFromQueue(appState.queue, sessionId);
          persistence.save(appState);
          return;
        }

        if (appState.sessions[sessionId]) {
          // Starts this session's grace period rather than freeing its slot
          // outright — an ordinary page reload is also a close, and must not
          // lose a match actually in progress. Persisted immediately: the
          // process may be stopped (Fly auto-stops on no connections) for
          // the entire grace period, so this timestamp, not a live timer, is
          // what the next request checks.
          // NOTE: if the same session has more than one socket open at once
          // (e.g. two tabs), closing either one marks the whole session
          // disconnected even though the other tab is still live — a known
          // gap, multi-tab usage was never in scope for this app.
          appState.sessions = markDisconnected(appState.sessions, sessionId, Date.now());
          persistence.save(appState);
        }
      });
    });
  });

  return httpServer;
}
