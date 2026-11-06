import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { confirmNewGame, createInitialState, drawCard, endTurn, playCard, rejectQuit, requestQuit } from "../game/engine.ts";
import type { CombatEvent, GameState, PlayerId } from "../game/types.ts";
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
  // Stage 2 (Turn Timer): how long a player has to act before their turn
  // auto-ends. Per the project owner's confirmed decision: enforced "Live"
  // (a real setTimeout runs while the process is awake, not just checked
  // opportunistically on the next request) AND continues to run while the
  // current player is disconnected (the confirmed "Continue" decision — see
  // enforceTurnDeadline's own comment for why disconnect never pauses or
  // resets it). Injectable so spec/ can run this in milliseconds, same
  // pattern as disconnectGraceMs; defaults to the real 45s otherwise.
  turnDurationMs?: number;
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
  const turnDurationMs = options.turnDurationMs ?? 45_000;
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

  // Stage 2 (Turn Timer): live setTimeout handles, keyed by seriesId — the
  // "Live" confirmed decision means a real in-process timer enforces the
  // deadline the moment it elapses while this process is awake, not just a
  // value checked opportunistically on the next request (that's still the
  // fallback for when the process WASN'T awake — see recoverTurnTimers).
  // Never read directly by game logic; only armTurnTimer/stopTurnTimer below
  // ever touch this map, so there's exactly one place a stale or duplicate
  // timer could leak from.
  const turnTimers = new Map<string, NodeJS.Timeout>();

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
    return {
      gamesWon: series.gamesWon,
      seriesStatus: series.seriesStatus,
      seriesWinner: series.seriesWinner,
      turnDeadline: series.turnDeadline,
    };
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

  // Combat Events: same recipient filtering as broadcastState (every socket
  // currently bound to this seriesId, never a stray socket from an unrelated
  // concurrent series) — sent once per Play that formed at least one Combo,
  // always immediately before that same Play's "state" broadcast so a client
  // has the cause before the effect. Never persisted (see protocol.ts's own
  // comment) — a reconnect only ever gets a fresh "state", never a replayed
  // combatEvent.
  function broadcastCombatEvent(seriesId: string, event: CombatEvent): void {
    for (const [ws, sessionId] of sockets) {
      if (appState.sessions[sessionId]?.seriesId === seriesId) {
        send(ws, { type: "combatEvent", event });
      }
    }
  }

  // Stage 2 (Turn Timer). Three invariants every call site below relies on:
  // (1) stopTurnTimer always runs before a new timer is scheduled for the
  // same seriesId, so turnTimers never holds two live handles for one
  // series; (2) armTurnTimer is the only place that sets a FRESH deadline
  // (now + turnDurationMs) — nothing else computes that arithmetic, so
  // there's one formula to get right; (3) a series with no active turn to
  // time (game concluded, waiting for confirmNewGame; or the whole series
  // concluded) always has both turnDeadline: null AND no entry in
  // turnTimers — the two are kept in sync at every transition below, never
  // independently.
  function stopTurnTimer(seriesId: string): void {
    const handle = turnTimers.get(seriesId);
    if (handle) {
      clearTimeout(handle);
      turnTimers.delete(seriesId);
    }
  }

  function scheduleTimer(seriesId: string, delayMs: number): void {
    stopTurnTimer(seriesId);
    const handle = setTimeout(() => handleTurnTimeout(seriesId), delayMs);
    turnTimers.set(seriesId, handle);
  }

  // Starts (or restarts) the CURRENT turn's deadline at a fresh
  // turnDurationMs from right now — called whenever a new turn has just
  // begun (a brand new series' first turn, an ordinary endTurn, AP
  // exhaustion auto-advancing via engine.ts's settleZeroApTurns, or a fresh
  // game starting via confirmNewGame), never on an action that merely
  // continues the SAME turn (a Play/Draw that didn't end it) — the
  // confirmed rule is 45 seconds per TURN, not per action, so those call
  // sites deliberately leave an in-flight deadline untouched instead of
  // calling this.
  function armTurnTimer(seriesId: string): void {
    const series = appState.seriesList[seriesId];
    if (!series) return;
    series.turnDeadline = Date.now() + turnDurationMs;
    scheduleTimer(seriesId, turnDurationMs);
  }

  // Fires when a turn's live setTimeout actually elapses while this process
  // is awake (the confirmed "Live" decision) — auto-ends the timed-out
  // player's turn via the SAME engine.endTurn() an explicit endTurn message
  // already uses, so "the server ran out the clock" and "the player clicked
  // End Turn" go through one code path, not two. Per the confirmed
  // "Continue" decision, this never checks or cares whether the timed-out
  // player is currently connected — a disconnected player's turn still
  // times out on schedule, exactly like a connected one's. engine.ts's
  // endTurn can never itself conclude a game (only playCard's lethal/locked
  // paths, or a mutual requestQuit/rejectQuit, do that) — unlike the main
  // message handler below, there is no settleGameOutcome/concludeSeries
  // fold-in needed here, the game is guaranteed to still be "active"
  // afterward.
  function handleTurnTimeout(seriesId: string): void {
    turnTimers.delete(seriesId); // this timer already fired; nothing left to clear
    const series = appState.seriesList[seriesId];
    if (!series) return; // series concluded before this fired
    const game = series.games[series.games.length - 1];
    if (!game || game.status !== "active") return; // no active turn left to time out

    const timedOutPlayer = game.currentPlayer;
    endTurn(game, timedOutPlayer);
    logEvent({ event: "turn_timed_out", seriesId, player: timedOutPlayer });

    armTurnTimer(seriesId); // the next player's turn just began; time it too

    persistence.save(appState);
    broadcastState(seriesId);
  }

  // Runs once, when this process starts — never per-request — to recover
  // from however long the process was actually asleep (Fly's own
  // auto-stop/resume, or any other restart) between persisting a deadline
  // and this moment. A deadline already in the past is resolved by applying
  // EXACTLY ONE timeout transition, the same wall-clock-comparison
  // reasoning reapExpiredSessions already established for the disconnect
  // grace period — never "how many turns would have elapsed," since that
  // would let one long sleep silently fast-forward a game by several turns
  // with nobody watching. A deadline still in the future gets a live timer
  // scheduled for its own remaining time, not a fresh full turnDurationMs.
  function recoverTurnTimers(): void {
    for (const [seriesId, series] of Object.entries(appState.seriesList)) {
      const game = series.games[series.games.length - 1];
      if (!game || game.status !== "active") continue;
      if (series.turnDeadline === null) {
        armTurnTimer(seriesId);
        continue;
      }
      const remaining = series.turnDeadline - Date.now();
      if (remaining <= 0) {
        handleTurnTimeout(seriesId);
      } else {
        scheduleTimer(seriesId, remaining);
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
    // Stage 2 (Turn Timer): a concluded series has no turn left to time —
    // stopped here, in the one function every ended-series path already
    // funnels through, rather than at each of its call sites individually.
    stopTurnTimer(seriesId);
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
        turnDeadline: null, // armTurnTimer (below) sets the real value
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

      // Stage 2 (Turn Timer): the very first turn of a brand new series
      // starts its own deadline the same way every later turn does — no
      // special-casing "the first turn" beyond calling this where the game
      // itself just became active.
      armTurnTimer(seriesId);

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

        // Stage 2 (Turn Timer): reject a turn action that arrives after its
        // own deadline already passed — a defensive check against the one
        // window the "Live" setTimeout alone can't close (a message event
        // and this series' own timeout callback both already queued for the
        // same event-loop tick; Node processes whichever was queued first,
        // so a message that slips in just ahead of its own timer callback
        // would otherwise still be honoured). Per the project owner's
        // confirmed decision, the deadline the SERVER already holds at the
        // moment it validates this action is authoritative — never a
        // client-reported time. Turn-order/AP/legality are still engine.ts's
        // own job below; this only catches "too late," which engine.ts has
        // no concept of. requestQuit/rejectQuit/confirmNewGame/forfeitSeries
        // are deliberately exempt — none of them are turn-bound actions (see
        // their own existing "no turn-order check" comments).
        if (
          (message.type === "play" || message.type === "draw" || message.type === "endTurn") &&
          series.turnDeadline !== null &&
          Date.now() >= series.turnDeadline
        ) {
          logEvent({ event: "action_rejected", displayId, seriesId, action: message.type, reason: "turn already timed out" });
          send(ws, { type: "error", message: "your turn already timed out" });
          return;
        }

        const statusBefore = game.status;
        const turnNumberBefore = game.turnNumber;
        // Set only by the "play" branch below, and only when that Play
        // formed at least one Combo — every other action leaves this null,
        // so no combatEvent is ever broadcast for a non-Play action.
        let combatEvent: CombatEvent | null = null;
        try {
          if (message.type === "play") {
            ({ combatEvent } = playCard(game, seatedPlayer, message.handIndex, message.row, message.col));
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

        // Combat Events: broadcast before any series-conclusion handling
        // below, so both players see the cause (which combos, which
        // effects) even on the same Play that ends the series outright —
        // the event describes what this Play's Combos did, independent of
        // whatever happens to the series as a result.
        if (combatEvent) broadcastCombatEvent(seriesId, combatEvent);

        // Stage 2 (Turn Timer): keep the timer in sync with whatever this
        // action actually did — exactly one of these three cases applies to
        // any single action, never more than one.
        if (message.type === "confirmNewGame") {
          // currentGame(seriesId) !== game only when BOTH players just
          // confirmed (confirmNewGame's own "both must agree" shape) — a
          // genuinely new game, whose own first turn needs its own fresh
          // deadline. One confirmation alone is a no-op for the timer:
          // there's still no active turn to time until the second
          // confirmation arrives.
          if (currentGame(seriesId) !== game) armTurnTimer(seriesId);
        } else {
          const gameAfter = currentGame(seriesId)!;
          if (gameAfter.status !== "active") {
            // The game just ended (a lethal/locked Play, or a mutual
            // requestQuit abandon) — no active turn left to time until
            // confirmNewGame starts the next one.
            stopTurnTimer(seriesId);
            series.turnDeadline = null;
          } else if (gameAfter.turnNumber !== turnNumberBefore) {
            // A new turn actually began: an ordinary endTurn, AP exhaustion
            // auto-advancing via engine.ts's settleZeroApTurns, or two
            // stacked Lightning hits skipping a whole turn and landing back
            // on the same currentPlayer (turnNumber catches this; a plain
            // currentPlayer comparison would miss it — see types.ts's own
            // comment on turnNumber).
            armTurnTimer(seriesId);
          }
          // else: the same turn continues (a Play/Draw that didn't end it,
          // or a requestQuit/rejectQuit that left the game active) —
          // deadline deliberately left untouched.
        }

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

  // Stage 2 (Turn Timer): runs once, at server startup, after every
  // function it calls is already defined above — recovers whatever
  // in-process timers this fresh process needs for any series that was
  // already active in persisted state before this process started (a Fly
  // auto-stop/resume, or any other restart). See recoverTurnTimers' own
  // comment for exactly-once-timeout semantics on an already-elapsed
  // deadline.
  recoverTurnTimers();

  return httpServer;
}
