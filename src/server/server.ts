import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { confirmNewGame, createInitialState, drawCard, endTurn, playCard, rejectQuit, requestQuit } from "../game/engine.ts";
import type { GameState, PlayerId } from "../game/types.ts";
import { parseSessionId, sessionCookieHeader } from "./cookies.ts";
import { normalizeSeriesList, type Persistence } from "./persistence.ts";
import type { ClientMessage, ServerMessage } from "./protocol.ts";
import {
  dequeuePair,
  enqueue,
  markDisconnected,
  normalizeQueue,
  normalizeSessions,
  reapExpiredSessions,
  releaseSession,
  removeFromQueue,
  seatPair,
  sessionsInSeries,
} from "./sessions.ts";

function newSessionId(): string {
  return randomBytes(16).toString("hex");
}

// Same id scheme as newSessionId — a seriesId has no format relationship to
// a sessionId, they just both want a short unguessable random token.
function newSeriesId(): string {
  return randomBytes(16).toString("hex");
}

export interface ServerOptions {
  // How long a disconnected SEATED session keeps its player slot before its
  // whole series forfeits — long enough that an ordinary page reload (close
  // then immediately reopen with the same cookie) never costs the match.
  // Injectable so spec/ can run this in milliseconds instead of really
  // waiting; defaults to the real 30s grace period otherwise. Only applies
  // to a seated session — a merely QUEUED session that disconnects is
  // dropped outright, no grace period at all (Stage 9's own rule: it never
  // held a seat with state at stake).
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
  // field at all. Pre-Stage-4b blobs have a single `series`, not a keyed
  // `seriesList` — normalizeSeriesList reads that (or anything else
  // unrecognized) as "no series active" rather than misreading it.
  appState.sessions = normalizeSessions(appState.sessions);
  appState.queue = normalizeQueue(appState.queue);
  appState.seriesList = normalizeSeriesList(appState.seriesList);

  // Seated sockets only — keyed to the session id, not a cached
  // PlayerId/seriesId: resolving both fresh from appState.sessions on every
  // use (rather than caching them here at connection time) means there's
  // nothing to keep in sync if a session's seriesId ever changed after
  // seating. A session moves into this map the instant a pairing seats it
  // (or immediately on a reconnect to an already-seated session), and is
  // removed on close.
  const sockets = new Map<WebSocket, string>();
  // Sockets for sessions currently in appState.queue, keyed by sessionId —
  // needed so a pairing triggered by some OTHER, unrelated connection can
  // still reach these sessions' own open sockets to tell them they've been
  // seated. A session with no entry here and no entry in `sockets` is just
  // sitting in the lobby, having connected but not yet sent joinQueue.
  const queuedSockets = new Map<string, WebSocket>();

  function send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  function currentGame(seriesId: string): GameState | null {
    return appState.seriesList[seriesId]?.games[0] ?? null;
  }

  // Stage 4b: takes an explicit seriesId and filters `sockets` down to just
  // the sessions currently bound to IT — this is the real cross-series
  // isolation boundary (Stage 4's read-only review's own finding): with N
  // independent series now possible, "every seated socket" is no longer a
  // safe recipient list for any one series' state.
  function broadcastState(seriesId: string): void {
    const game = currentGame(seriesId);
    if (!game) return;
    for (const [ws, sessionId] of sockets) {
      if (appState.sessions[sessionId]?.seriesId === seriesId) {
        send(ws, { type: "state", state: game });
      }
    }
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

  // Reaps every session whose grace period has fully elapsed (a plain
  // wall-clock comparison against a persisted timestamp — never a running
  // timer, so this gives the right answer even if the server process was
  // stopped, which Fly does whenever nobody's connected, for the entire
  // grace period and only just woke back up for this request), then
  // settles any series that reaping left short a player.
  //
  // Per the project owner's confirmed decision: a seated session whose
  // grace period expires forfeits its WHOLE series, it does not have its
  // lone seat quietly refilled by a stranger (that was Stage 3's model;
  // Stage 4b replaces it, since "refill one seat, replace the whole
  // series underneath the still-connected survivor with no consent" was
  // already a known limitation, not something to generalize to N
  // concurrent series). Concretely, for each series that had ANY of its
  // sessions reaped: if it still has both sessions, nothing happened to
  // it (the reaped session belonged to a different series); if it has
  // exactly one left, that player wins the series by forfeit — a terminal
  // message is sent to them (their own series.games[0] is left completely
  // untouched per that same decision: the engine/GameState never learns
  // anything about a forfeit, it's purely a server-level settlement) and
  // their own SessionEntry is released so they return to the lobby and
  // must explicitly re-queue, exactly like any other ended series; if
  // zero are left (both players' grace periods expired, however close
  // together — this whole function runs as one synchronous pass over a
  // single reap(), so "close together" can never actually race here),
  // the series is abandoned with no winner, per the project owner's own
  // closed decision in PROCESS.md's Stage 9 entry. Either way the series
  // itself is removed from seriesList — settling it twice is impossible
  // by construction, since the second time there's nothing left in
  // sessionsInSeries to find.
  function reapAndSettleSeries(): void {
    const before = appState.sessions;
    appState.sessions = reapExpiredSessions(before, Date.now(), disconnectGraceMs);

    const affectedSeriesIds = new Set<string>();
    for (const [id, entry] of Object.entries(before)) {
      if (entry?.seriesId && !(id in appState.sessions)) affectedSeriesIds.add(entry.seriesId);
    }

    for (const seriesId of affectedSeriesIds) {
      const remaining = sessionsInSeries(appState.sessions, seriesId);
      if (remaining.length === 2) continue; // only an unrelated session in this series expired

      if (remaining.length === 1) {
        const survivorSessionId = remaining[0];
        for (const [ws, sid] of sockets) {
          if (sid === survivorSessionId) {
            send(ws, { type: "seriesEnded", reason: "opponentDisconnected" });
            sockets.delete(ws);
            break;
          }
        }
        appState.sessions = releaseSession(appState.sessions, survivorSessionId);
      }
      // remaining.length === 0: both players gone, abandoned, nobody to notify.

      delete appState.seriesList[seriesId];
    }

    persistence.save(appState);
  }

  // Drains the FIFO queue, pairing the two longest-waiting sessions into a
  // brand new series, repeating as long as at least two remain — no
  // ceiling on how many series can be formed in one call (Stage 4b's whole
  // point: 4 waiting sessions means 2 independent series from a single
  // joinQueue). Each pairing is atomic: seatPair creates both SessionEntrys
  // and their shared seriesId together (see sessions.ts's own comment on
  // why there's no longer an intermediate "one seat filled, waiting for a
  // partner" state under this stage's forfeit-not-refill model).
  function pumpQueue(): void {
    for (;;) {
      const pair = dequeuePair(appState.queue);
      if (!pair) break;

      const { first, second, rest } = pair;
      appState.queue = rest;
      const seriesId = newSeriesId();
      appState.sessions = seatPair(appState.sessions, seriesId, first, second);
      appState.seriesList[seriesId] = { seriesId, games: [createInitialState()] };

      for (const [sessionId, seat] of [[first, "A"], [second, "B"]] as const) {
        const ws = queuedSockets.get(sessionId);
        queuedSockets.delete(sessionId);
        if (ws) {
          sockets.set(ws, sessionId);
          send(ws, { type: "assigned", player: seat });
        }
      }

      persistence.save(appState);
      broadcastState(seriesId);
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
    reapAndSettleSeries();
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
        sockets.set(ws, sessionId);
        send(ws, { type: "assigned", player: player! });
        const entry = appState.sessions[sessionId];
        const game = entry?.seriesId ? currentGame(entry.seriesId) : null;
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
        const seriesId = entry?.seriesId;
        const game = seriesId ? currentGame(seriesId) : null;
        if (!entry || !seriesId || !game) return; // not seated in an active series; ignore game actions

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
            appState.seriesList[seriesId].games[0] = confirmNewGame(game, seatedPlayer);
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
        broadcastState(seriesId);
      });

      ws.on("close", () => {
        sockets.delete(ws);
        queuedSockets.delete(sessionId);

        // Queued (no seat yet): removed outright, no grace period — it
        // never held a seat with state at stake (Stage 9's own rule).
        if (appState.queue.includes(sessionId)) {
          appState.queue = removeFromQueue(appState.queue, sessionId);
          persistence.save(appState);
          return;
        }

        if (appState.sessions[sessionId]) {
          // Starts this session's grace period rather than settling its
          // series outright — an ordinary page reload is also a close, and
          // must not forfeit a match actually in progress. Persisted
          // immediately: the process may be stopped (Fly auto-stops on no
          // connections) for the entire grace period, so this timestamp,
          // not a live timer, is what the next request checks.
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
