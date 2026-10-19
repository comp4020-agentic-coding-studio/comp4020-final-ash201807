import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { confirmNewGame, createInitialState, drawCard, endTurn, playCard, rejectQuit, requestQuit } from "../game/engine.ts";
import type { GameState, PlayerId } from "../game/types.ts";
import { parseSessionId, sessionCookieHeader } from "./cookies.ts";
import { displayIdFor } from "./identity.ts";
import { logEvent } from "./log.ts";
import { normalizeSeriesList, type Persistence, type SeriesState } from "./persistence.ts";
import type { ClientMessage, ServerMessage, SeriesScore } from "./protocol.ts";
import { forfeitSeriesTo, settleGameOutcome } from "./series.ts";
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

  // Stage 5: a series can now hold more than one game — the "current" one
  // being played/shown is always the LAST entry (earlier ones are already
  // concluded history the series' own gamesWon score already accounts for).
  function currentGame(seriesId: string): GameState | null {
    const series = appState.seriesList[seriesId];
    if (!series) return null;
    return series.games[series.games.length - 1];
  }

  function seriesScore(series: SeriesState): SeriesScore {
    return { gamesWon: series.gamesWon, seriesStatus: series.seriesStatus, seriesWinner: series.seriesWinner };
  }

  // Stage 4b: takes an explicit seriesId and filters `sockets` down to just
  // the sessions currently bound to IT — this is the real cross-series
  // isolation boundary (Stage 4's read-only review's own finding): with N
  // independent series now possible, "every seated socket" is no longer a
  // safe recipient list for any one series' state.
  function broadcastState(seriesId: string): void {
    const series = appState.seriesList[seriesId];
    if (!series) return;
    const game = currentGame(seriesId);
    if (!game) return;
    for (const [ws, sessionId] of sockets) {
      if (appState.sessions[sessionId]?.seriesId === seriesId) {
        send(ws, { type: "state", state: game, series: seriesScore(series) });
      }
    }
  }

  // Stage 6: the one "a series has ended, tell whoever's owed a message,
  // release every member's SessionEntry, remove the series itself" sequence,
  // shared by all three ways a series can end (disconnect-forfeit below,
  // ordinary-play conclusion, and the new explicit forfeitSeries) — pulled
  // out once it became clear all three needed the exact same steps, not
  // speculatively up front. `notifications` may be empty (both-disconnected
  // abandonment: nobody left to tell) or name only a subset of the series'
  // members (disconnect-forfeit: only the survivor is still connected to
  // receive anything) — callers decide who gets told what, this just
  // executes it. Collects nothing eagerly from `sockets`/`sessions` itself:
  // each entry's own sessionId is resolved to its live socket (if any) at
  // the moment it's processed, same order-independence reapAndSettleSeries's
  // own prior comment already established ("deleting one must never change
  // what the other's own lookup finds") — releasing one member's
  // SessionEntry can't affect finding another's, since each is looked up by
  // its own id, not by re-deriving the list mid-loop.
  function concludeSeries(seriesId: string, notifications: Array<{ sessionId: string; message: ServerMessage }>): void {
    for (const { sessionId: memberSessionId, message } of notifications) {
      for (const [memberWs, sid] of sockets) {
        if (sid === memberSessionId) {
          send(memberWs, message);
          sockets.delete(memberWs);
          break;
        }
      }
      appState.sessions = releaseSession(appState.sessions, memberSessionId);
    }
    delete appState.seriesList[seriesId];
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

      // remaining.length === 1: the survivor wins by forfeit, notified.
      // remaining.length === 0: both players gone, abandoned, nobody to
      // notify — concludeSeries is called with an empty notification list,
      // same "delete from seriesList, nothing else to do" effect.
      if (remaining.length === 1) {
        logEvent({ event: "series_forfeited_disconnect", seriesId, displayId: displayIdFor(remaining[0]) });
      } else {
        logEvent({ event: "series_abandoned_both_disconnected", seriesId });
      }
      const notifications =
        remaining.length === 1
          ? [{ sessionId: remaining[0], message: { type: "seriesEnded" as const, reason: "opponentDisconnected" as const } }]
          : [];
      concludeSeries(seriesId, notifications);
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
      appState.seriesList[seriesId] = {
        seriesId,
        games: [createInitialState()],
        gamesWon: { A: 0, B: 0 },
        seriesWinner: null,
        seriesStatus: "active",
      };

      for (const [sessionId, seat] of [[first, "A"], [second, "B"]] as const) {
        const ws = queuedSockets.get(sessionId);
        queuedSockets.delete(sessionId);
        if (ws) {
          sockets.set(ws, sessionId);
          send(ws, { type: "assigned", player: seat });
        }
      }

      logEvent({
        event: "series_paired",
        seriesId,
        displayIdA: displayIdFor(first),
        displayIdB: displayIdFor(second),
      });

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
        logEvent({ event: "session_reconnected", displayId: displayIdFor(sessionId), seriesId: existing.seriesId ?? undefined });
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
      const displayId = displayIdFor(sessionId);
      send(ws, { type: "identity", displayId });

      if (status === "seated") {
        sockets.set(ws, sessionId);
        send(ws, { type: "assigned", player: player! });
        const entry = appState.sessions[sessionId];
        const series = entry?.seriesId ? appState.seriesList[entry.seriesId] : undefined;
        const game = entry?.seriesId ? currentGame(entry.seriesId) : null;
        if (game && series) send(ws, { type: "state", state: game, series: seriesScore(series) });
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
          logEvent({ event: "joined_queue", displayId });
          send(ws, { type: "queued" });
          pumpQueue();
          return;
        }

        const entry = appState.sessions[sessionId];
        const seriesId = entry?.seriesId;
        const series = seriesId ? appState.seriesList[seriesId] : undefined;
        const game = seriesId ? currentGame(seriesId) : null;
        if (!entry || !seriesId || !series || !game) return; // not seated in an active series; ignore game actions

        const seatedPlayer = entry.player;

        if (message.type === "forfeitSeries") {
          // Stage 6: unilateral — no mutual agreement, unlike requestQuit/
          // rejectQuit. Only valid while the current game is active, same
          // restriction requestQuit already has — once a game has already
          // concluded and both players are only waiting to confirm the
          // next one, there's no "forfeit the in-progress game" to make,
          // only "forfeit the series outright" which this message already
          // does regardless. Rejected with the same error style every
          // other action uses for an invalid-state action.
          if (game.status !== "active") {
            logEvent({
              event: "action_rejected",
              displayId,
              seriesId,
              action: "forfeitSeries",
              reason: "cannot forfeit outside an active game",
            });
            send(ws, { type: "error", message: "cannot forfeit outside an active game" });
            return;
          }
          const opponent = seatedPlayer === "A" ? "B" : "A";
          // The in-progress GameState is deliberately left completely
          // untouched — forfeiting judges the series directly (see
          // series.ts's own comment), it never runs through
          // settleGameOutcome, never touches gamesWon, never marks the
          // current game itself concluded in any way.
          forfeitSeriesTo(series, opponent);
          logEvent({ event: "series_forfeited_explicit", seriesId, displayId });
          const finalScore = seriesScore(series);
          concludeSeries(seriesId, [
            { sessionId, message: { type: "seriesEnded", reason: "forfeited", series: finalScore } },
            ...sessionsInSeries(appState.sessions, seriesId)
              .filter((id) => id !== sessionId)
              .map((id) => ({
                sessionId: id,
                message: { type: "seriesEnded" as const, reason: "opponentForfeited" as const, series: finalScore },
              })),
          ]);
          persistence.save(appState);
          return;
        }

        const statusBefore = game.status;
        try {
          if (message.type === "play") {
            playCard(game, seatedPlayer, message.handIndex, message.row, message.col);
          } else if (message.type === "draw") {
            drawCard(game, seatedPlayer);
          } else if (message.type === "endTurn") {
            endTurn(game, seatedPlayer);
          } else if (message.type === "confirmNewGame") {
            // Stage 5: confirmNewGame's own mutual-confirmation shape is
            // reused completely unchanged (it still just flips
            // restartConfirmed and, once both agree, returns a brand NEW
            // GameState) — what changed is what the server does with that
            // return value. No separate "series already ended" guard is
            // needed here: the moment a series concludes (below), both its
            // sessions are released and the series itself is deleted from
            // seriesList in the SAME synchronous handler call that settled
            // it — so a later confirmNewGame from either former player
            // already fails the `!entry` check above before reaching this
            // branch at all. Adding a redundant check here for a state this
            // branch can never actually observe would be validating against
            // an impossible scenario, not a real one.
            const nextGame = confirmNewGame(game, seatedPlayer);
            if (nextGame !== game) {
              // Both players just confirmed — nextGame is a genuinely NEW
              // GameState, appended as the series' next game (never
              // replacing games[0], and never touching gamesWon/
              // seriesWinner/seriesStatus in this same write: those are
              // separate fields on the same object, updated only by
              // settleGameOutcome, never by this push).
              series.games.push(nextGame);
            }
            // Either way (one confirmation, or both just reused above), the
            // mutation already happened on `game`/`series.games` in place
            // via confirmNewGame's own restartConfirmed flip — nothing
            // further needed here.
          } else if (message.type === "requestQuit") {
            requestQuit(game, seatedPlayer);
          } else if (message.type === "rejectQuit") {
            rejectQuit(game, seatedPlayer);
          } else {
            throw new Error("unknown message type");
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : "invalid action";
          logEvent({ event: "action_rejected", displayId, seriesId, action: message.type, reason });
          send(ws, { type: "error", message: reason });
          return;
        }
        logEvent({ event: "action_accepted", displayId, seriesId, action: message.type });

        // The game this action acted on just concluded (it wasn't already
        // concluded before this action — confirmNewGame's own "cannot start
        // a new game while this one is still active" check, and every other
        // action's identical guard, already ensures this fires at most once
        // per concluded game): fold its outcome into the series' own score
        // before anyone is told anything.
        if (statusBefore === "active" && currentGame(seriesId)!.status !== "active") {
          settleGameOutcome(series);
        }

        if (series.seriesStatus !== "active") {
          // The series itself just concluded (2 wins reached, or this
          // game's "abandoned" ended the whole series per the project
          // owner's decision) — both players are still connected here
          // (unlike the forfeit-on-disconnect path), so both get told
          // directly via the same concludeSeries sequence every other
          // ended-series path already uses.
          const finishedScore = seriesScore(series);
          logEvent({
            event: "series_concluded",
            seriesId,
            seriesStatus: finishedScore.seriesStatus,
            seriesWinner: finishedScore.seriesWinner,
          });
          const notifications = sessionsInSeries(appState.sessions, seriesId).map((memberSessionId) => ({
            sessionId: memberSessionId,
            message: { type: "seriesEnded" as const, reason: "seriesConcluded" as const, series: finishedScore },
          }));
          concludeSeries(seriesId, notifications);
          persistence.save(appState);
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
          logEvent({ event: "queue_left_on_disconnect", displayId });
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
          logEvent({
            event: "session_disconnected",
            displayId,
            seriesId: appState.sessions[sessionId]?.seriesId ?? undefined,
          });
        }
      });
    });
  });

  return httpServer;
}
