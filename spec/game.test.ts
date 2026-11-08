import { beforeAll, expect, inject, it } from "vitest";
import WebSocket from "ws";

// Black-box checks against the RUNNING app's real HTTP + WebSocket surface
// (see global-setup.ts) — no mocking, no reaching into the engine directly.
// These exercise the claims README.md makes under "Checked in spec/": a
// joinQueue is required before a seat is assigned, FIFO pairing forms
// independent concurrent series (Stage 4b), an out-of-turn action changes
// nothing, reconnecting with the same session resumes rather than loses the
// match, a seated opponent who never reconnects within the grace period
// forfeits the WHOLE series to the survivor (Stage 4b: replaces Stage 3's
// "a stranger refills the empty seat" model), a mid-series game that's
// mutually abandoned ends the WHOLE series, winner-less, not just that one
// game (Stage 5 — the project owner's own confirmed decision: there's no
// rule yet for fairly continuing a series after one of its games was called
// off), and one player can unilaterally forfeit the WHOLE series — no
// agreement needed from the opponent, unlike requestQuit/rejectQuit's
// mutual shape — immediately awarding it to whoever's still there (Stage 6).
//
// Stage 4b removed the Stage 3/4a limitation that only one series could be
// active at a time — any number of independent two-player series can now
// run concurrently, each fed by the same FIFO queue. The first group of
// tests below still shares ONE pairing (established once in beforeAll) for
// the ordinary single-match checks that don't care about concurrency; a
// later group deliberately runs TWO pairings side by side to check they
// never interfere with each other.
//
// Stage 5 (best-of-three) note on what's NOT tested here: reaching a real
// "finished" (lethal Combo) or "locked" (full board) game through actual
// live play isn't practical to script deterministically over real random
// card draws — the same already-established limitation engine.test.ts's own
// comments note for single-game testing. The 1:0/1:1/2:0/2:1/locked score
// progressions that best-of-three introduces are instead covered
// exhaustively, and more precisely, by src/server/series.test.ts's pure
// unit tests against engineered GameState fixtures — this file only covers
// what's actually reachable over the real transport: the mutual-abandon
// path (reachable via requestQuit/rejectQuit from both sides) and its
// cross-series isolation.
//
// IMPORTANT for local runs: re-running `pnpm check` against the SAME
// long-lived local dev server reuses whatever state is already there from
// the previous run — restart the dev server (or point DB_PATH at a fresh
// file) between runs for a clean slate. CI is unaffected: it always starts
// a fresh container with a throwaway /data.
//
// The disconnect-expiry tests actually wait out the server's configured
// DISCONNECT_GRACE_MS (src/server/index.ts) — this file reads the same env
// var so it knows how long to wait, defaulting to the real 30s if unset.
// Running locally against the real default makes this file take
// significantly longer; see the TURN_DURATION_MS comment immediately below
// before shortening it for a fast local run — the two can't be shortened
// independently of each other.
const disconnectGraceMs = Number(process.env.DISCONNECT_GRACE_MS ?? 30_000);
// Stage 2 (Turn Timer): same override pattern as disconnectGraceMs above,
// for the same reason — the turn-timeout tests actually wait out the
// server's own configured TURN_DURATION_MS (src/server/index.ts) rather
// than mocking time.
//
// UX fix (2026-11-08): DISCONNECT_GRACE_MS must stay LONGER than
// TURN_DURATION_MS whenever both are shortened for a fast run — the
// OPPOSITE ratio from the real production defaults (30s grace < 45s turn).
// Before this fix, the disconnect grace period was only ever checked
// lazily on an unrelated later request, so a shorter grace period never
// actually fired on its own before a turn-timeout test's own wait
// finished; now it's a live, self-firing timer like this one always was,
// so whichever deadline is numerically SHORTER really does win the race.
// "keeps the timer running... while disconnected" below specifically needs
// the TURN deadline to be the one that fires (that's the whole test), which
// means grace must be the LONGER of the two here, even though that's
// backwards from the live app's own ratio. Get this backwards locally and
// that test settles the whole series by disconnect-forfeit before the turn
// timer ever gets a chance to prove anything (CI's own checks.yml sets
// 5000/2000; keep local overrides in the same ratio).
const turnDurationMs = Number(process.env.TURN_DURATION_MS ?? 45_000);
const baseUrl = inject("baseUrl");
const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";

interface SeriesScore {
  gamesWon: Record<"A" | "B", number>;
  seriesStatus: "active" | "finished" | "abandoned";
  seriesWinner: "A" | "B" | null;
  turnDeadline: number | null;
}

interface ServerMessage {
  type: "identity" | "assigned" | "waiting" | "queued" | "state" | "combatEvent" | "seriesEnded" | "error";
  displayId?: string;
  player?: "A" | "B";
  reason?: string;
  state?: {
    status: "active" | "finished" | "locked" | "abandoned";
    ap: number;
    currentPlayer: "A" | "B";
    players: Record<"A" | "B", { hand: unknown[] }>;
    quitRequested: Record<"A" | "B", boolean>;
  };
  series?: SeriesScore;
  message?: string;
}

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
}

// Visiting "/" is how a real browser obtains its session cookie before ever
// opening the WebSocket — the same step a page reload repeats, which is
// exactly what the reconnect check below relies on.
async function newSessionCookie(): Promise<string> {
  const res = await fetch(new URL("/", baseUrl));
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected GET / to set a session cookie");
  return setCookie.split(";")[0];
}

function connect(cookie: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
    const messages: ServerMessage[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });
}

function send(ws: WebSocket, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastState(messages: ServerMessage[]) {
  return messages.filter((m) => m.type === "state").at(-1)?.state;
}

function lastSeries(messages: ServerMessage[]): SeriesScore | undefined {
  return messages.filter((m) => m.type === "state").at(-1)?.series;
}

// Stage 1 (authorization/logging hardening): the server now sends an
// "identity" message immediately on every connection, before anything else —
// it's cosmetic/log-correlation only (see src/server/identity.ts), never a
// seat assignment, but it does mean "the first message a socket receives" is
// no longer necessarily meaningful the way "assigned"/"queued" used to be.
// Tests that assert on "the first substantive message" filter it out here
// rather than hardcoding messages[0], so they keep checking the same thing
// (what's the first message that actually says something about this
// session's seat) without being tied to exactly where "identity" lands.
function withoutIdentity(messages: ServerMessage[]): ServerMessage[] {
  return messages.filter((m) => m.type !== "identity");
}

// Connects, sends the explicit joinQueue action, and waits for it to take
// effect — the one new step every test needs now that connecting alone no
// longer claims anything (Stage 3: "explicitly join a queue").
async function connectAndJoinQueue(cookie: string): Promise<Client> {
  const client = await connect(cookie);
  send(client.ws, { type: "joinQueue" });
  await wait(100);
  return client;
}

// Queues two fresh sessions back to back and waits for them to pair into
// their own series — the building block the concurrency tests below use to
// stand up a second, independent match alongside the first. Cookies are
// returned too, so a test can reconnect either player later and verify they
// resume THIS series specifically, not some other concurrent one.
async function formAPairing(): Promise<{ a: Client; b: Client; cookieA: string; cookieB: string }> {
  const cA = await newSessionCookie();
  const a = await connectAndJoinQueue(cA);
  await wait(100);
  const cB = await newSessionCookie();
  const b = await connectAndJoinQueue(cB);
  await wait(200);
  return { a, b, cookieA: cA, cookieB: cB };
}

let cookieA: string;
let a: Client;
let b: Client;

beforeAll(async () => {
  cookieA = await newSessionCookie();
  a = await connectAndJoinQueue(cookieA);
  await wait(100);
  b = await connectAndJoinQueue(await newSessionCookie());
  await wait(200);
});

it("requires an explicit joinQueue before a seat is assigned", () => {
  // a's very first message, before it ever sent joinQueue, must not already
  // be an assignment — connecting alone claims nothing.
  expect(a.messages[0]).not.toEqual(expect.objectContaining({ type: "assigned" }));
});

it("pairs the first two queued sessions as A and B, and starts the game for both", () => {
  expect(a.messages).toContainEqual({ type: "assigned", player: "A" });
  expect(b.messages).toContainEqual({ type: "assigned", player: "B" });
  // A was already queued and waiting; completing the pair must have
  // pushed it a state too, not just the newly-queueing B.
  expect(lastState(a.messages)).toBeDefined();
  expect(lastState(b.messages)).toBeDefined();
  // Stage 2 (Turn Timer): the very first turn's deadline is set the moment
  // the pairing forms, roughly turnDurationMs from now (a generous ±5s
  // window tolerates test/network slack, never the full duration off), and
  // both players see the exact same deadline — there's one timer per
  // series, not one per player.
  const deadline = lastSeries(a.messages)?.turnDeadline;
  expect(deadline).not.toBeNull();
  expect(deadline!).toBeGreaterThan(Date.now() + turnDurationMs - 5000);
  expect(deadline!).toBeLessThanOrEqual(Date.now() + turnDurationMs);
  expect(lastSeries(b.messages)?.turnDeadline).toBe(deadline);
});

it("enforces turn order and leaves state unchanged on a rejected action", async () => {
  const state = lastState(b.messages);
  if (!state) throw new Error("expected a state after pairing");
  const outOfTurn = state.currentPlayer === "A" ? b : a;
  const messageCountBefore = outOfTurn.messages.length;

  send(outOfTurn.ws, { type: "draw" });
  await wait(200);

  const newMessages = outOfTurn.messages.slice(messageCountBefore);
  expect(newMessages).toHaveLength(1);
  expect(newMessages[0].type).toBe("error");
  expect(newMessages[0].message).toMatch(/turn/);
});

it("never sends a combatEvent for a legal action that forms no Combo", async () => {
  // Reaching a real Combo deterministically over this transport isn't
  // practical (real random hands, same already-established limitation this
  // file's own top comment notes for finished/locked games) — but an
  // ordinary Draw, which can never itself form a Combo, is fully
  // deterministic and exercises the "no event when nothing happened" side
  // of the contract.
  const state = lastState(a.messages);
  if (!state) throw new Error("expected a state after pairing");
  const actor = state.currentPlayer === "A" ? a : b;
  const other = actor === a ? b : a;
  const actorCountBefore = actor.messages.length;
  const otherCountBefore = other.messages.length;

  send(actor.ws, { type: "draw" });
  await wait(200);

  const actorNew = actor.messages.slice(actorCountBefore);
  const otherNew = other.messages.slice(otherCountBefore);
  expect(actorNew.some((m) => m.type === "combatEvent")).toBe(false);
  expect(otherNew.some((m) => m.type === "combatEvent")).toBe(false);
  expect(actorNew.some((m) => m.type === "state")).toBe(true);
});

it("rejects confirmNewGame while the game is still active", async () => {
  const messageCountBefore = a.messages.length;
  send(a.ws, { type: "confirmNewGame" });
  await wait(200);

  const newMessages = a.messages.slice(messageCountBefore);
  expect(newMessages).toHaveLength(1);
  expect(newMessages[0].type).toBe("error");
  expect(newMessages[0].message).toMatch(/active/);
  // Rejected, so nothing was pushed to the other client either.
  expect(lastState(b.messages)?.status).toBe("active");
});

it("resumes the same game for a reconnecting session instead of losing it", async () => {
  const beforeReconnect = lastState(a.messages);
  if (!beforeReconnect) throw new Error("expected a state for A before reconnect");

  // Simulate A reloading the page: close the socket, reopen with the SAME
  // session cookie (a real browser attaches it automatically on reload;
  // this never calls newSessionCookie() again). A reconnecting SEATED
  // session resumes automatically — no joinQueue needed, since it already
  // holds a seat in an active series.
  a.ws.close();
  await wait(100);
  const aAgain = await connect(cookieA);
  await wait(200);

  expect(withoutIdentity(aAgain.messages)[0]).toEqual({ type: "assigned", player: "A" });
  const resumedState = lastState(aAgain.messages);
  expect(resumedState).toBeDefined();
  expect(resumedState?.currentPlayer).toBe(beforeReconnect.currentPlayer);
  expect(resumedState?.players.A.hand.length).toBe(beforeReconnect.players.A.hand.length);

  a = aAgain;
});

it("lets one player propose ending the game early without ending it", async () => {
  const messageCountBeforeA = a.messages.length;
  const messageCountBeforeB = b.messages.length;

  send(a.ws, { type: "requestQuit" });
  await wait(200);

  // A's own request is just one player's flag — not enough to end anything.
  const newMessagesForA = a.messages.slice(messageCountBeforeA);
  expect(newMessagesForA.some((m) => m.type === "state")).toBe(true);
  expect(lastState(a.messages)?.status).toBe("active");
  expect(lastState(a.messages)?.quitRequested).toEqual({ A: true, B: false });

  // B, who did nothing, still gets pushed the updated quitRequested flag —
  // same broadcastState() path every other action already uses.
  const newMessagesForB = b.messages.slice(messageCountBeforeB);
  expect(newMessagesForB.some((m) => m.type === "state")).toBe(true);
  expect(lastState(b.messages)?.quitRequested).toEqual({ A: true, B: false });
});

it("clears a pending request for both players when the other one rejects it", async () => {
  // A's request from the previous test is still pending.
  const messageCountBeforeA = a.messages.length;

  send(b.ws, { type: "rejectQuit" });
  await wait(200);

  expect(lastState(b.messages)?.quitRequested).toEqual({ A: false, B: false });
  // A gets pushed the cleared flag too, not just B who called rejectQuit.
  const newMessagesForA = a.messages.slice(messageCountBeforeA);
  expect(newMessagesForA.some((m) => m.type === "state")).toBe(true);
  expect(lastState(a.messages)?.quitRequested).toEqual({ A: false, B: false });
  expect(lastState(a.messages)?.status).toBe("active");
});

it("ends the WHOLE series, winner-less, once both players mutually abandon the current game — not just that one game", async () => {
  // Stage 5's own confirmed decision: unlike a disconnect forfeit (which
  // always awards the series to whoever's still there), a MUTUAL abandon
  // mid-series has no winner at all — there's no rule yet for fairly
  // continuing after one game was called off, so the entire series ends
  // here regardless of the score coming in (both players are still
  // connected, so both are told directly via seriesEnded, unlike the
  // forfeit path where only the survivor can receive anything).
  const messageCountBeforeA = a.messages.length;
  const messageCountBeforeB = b.messages.length;

  send(a.ws, { type: "requestQuit" });
  await wait(100);
  send(b.ws, { type: "requestQuit" });
  await wait(200);

  const newMessagesForA = a.messages.slice(messageCountBeforeA);
  const newMessagesForB = b.messages.slice(messageCountBeforeB);
  const endedForA = newMessagesForA.find((m) => m.type === "seriesEnded");
  const endedForB = newMessagesForB.find((m) => m.type === "seriesEnded");

  expect(endedForA?.reason).toBe("seriesConcluded");
  expect(endedForB?.reason).toBe("seriesConcluded");
  expect(endedForA?.series?.seriesStatus).toBe("abandoned");
  expect(endedForA?.series?.seriesWinner).toBeNull();
  // Neither player's requestQuit was itself a won game — the series ends
  // with the score exactly as it was before this mutual abandon (0-0, since
  // this was still the series' very first game).
  expect(endedForA?.series?.gamesWon).toEqual({ A: 0, B: 0 });
  // Both players are told the SAME final score, not divergent views of it.
  expect(endedForB?.series).toEqual(endedForA?.series);

  // Both sessions were released — rejoining the queue starts a genuinely
  // fresh pairing/series, it doesn't resume the abandoned one.
  send(a.ws, { type: "joinQueue" });
  await wait(100);
  expect(a.messages.filter((m) => m.type === "queued").length).toBeGreaterThan(0);

  a.ws.close();
  b.ws.close();
});

// --- Stage 4b: concurrent, independent series ---------------------------

it("forms two independent concurrent series from a single FIFO queue, not one series gating the other", async () => {
  // Formed SEQUENTIALLY, not concurrently: the FIFO queue pairs strictly by
  // arrival order with no notion of "these two belong together" beyond
  // that order, so running formAPairing() concurrently would interleave
  // the four joins and pair session 1 with session 3 instead of with
  // session 2 — a test bug, not a server bug, caught by actually running
  // this once. Sequential calls guarantee each pairing's own two sessions
  // queue back to back and so pair with each other.
  const first = await formAPairing();
  const second = await formAPairing();

  expect(first.a.messages).toContainEqual({ type: "assigned", player: "A" });
  expect(first.b.messages).toContainEqual({ type: "assigned", player: "B" });
  expect(second.a.messages).toContainEqual({ type: "assigned", player: "A" });
  expect(second.b.messages).toContainEqual({ type: "assigned", player: "B" });

  expect(lastState(first.a.messages)?.status).toBe("active");
  expect(lastState(second.a.messages)?.status).toBe("active");

  first.a.ws.close();
  first.b.ws.close();
  second.a.ws.close();
  second.b.ws.close();
  await wait(200);
});

it("never leaks one series' broadcasts or actions into an unrelated concurrent series", async () => {
  const one = await formAPairing();
  const two = await formAPairing();

  const oneBMessageCountBefore = one.b.messages.length;
  const twoAMessageCountBefore = two.a.messages.length;
  const twoBMessageCountBefore = two.b.messages.length;

  // An action in series "one" (A draws, or ends its turn depending on whose
  // turn it is) must only ever produce a new state broadcast for "one"'s
  // own two sockets — never for "two"'s, which has nothing to do with it.
  const oneState = lastState(one.a.messages);
  if (!oneState) throw new Error("expected series one to be active");
  const oneActor = oneState.currentPlayer === "A" ? one.a : one.b;
  send(oneActor.ws, { type: "draw" });
  await wait(200);

  const oneBNew = one.b.messages.slice(oneBMessageCountBefore);
  expect(oneBNew.some((m) => m.type === "state")).toBe(true);

  const twoANew = two.a.messages.slice(twoAMessageCountBefore);
  const twoBNew = two.b.messages.slice(twoBMessageCountBefore);
  expect(twoANew).toHaveLength(0);
  expect(twoBNew).toHaveLength(0);

  one.a.ws.close();
  one.b.ws.close();
  two.a.ws.close();
  two.b.ws.close();
  await wait(200);
});

it("reconnects a session to its own series, not an unrelated concurrent one", async () => {
  const one = await formAPairing();
  const two = await formAPairing();

  const beforeReconnect = lastState(one.a.messages);
  if (!beforeReconnect) throw new Error("expected series one to be active");

  // Reload one.a's page: close, reopen with the SAME cookie. It must
  // resume series ONE's state specifically (same currentPlayer, same hand
  // size) — not series two's, which has a completely independent board/
  // hand/turn order by virtue of being a different createInitialState().
  one.a.ws.close();
  await wait(100);
  const oneAAgain = await connect(one.cookieA);
  await wait(200);

  expect(withoutIdentity(oneAAgain.messages)[0]).toEqual({ type: "assigned", player: "A" });
  const resumedState = lastState(oneAAgain.messages);
  expect(resumedState).toBeDefined();
  expect(resumedState?.currentPlayer).toBe(beforeReconnect.currentPlayer);
  expect(resumedState?.players.A.hand.length).toBe(beforeReconnect.players.A.hand.length);

  // Series two's players must see nothing at all from series one's player
  // reconnecting — no stray state push, no assignment.
  const twoAMessageCountBefore = two.a.messages.length;
  const twoBMessageCountBefore = two.b.messages.length;
  expect(two.a.messages.slice(twoAMessageCountBefore)).toHaveLength(0);
  expect(two.b.messages.slice(twoBMessageCountBefore)).toHaveLength(0);

  oneAAgain.ws.close();
  one.b.ws.close();
  two.a.ws.close();
  two.b.ws.close();
  await wait(200);
});

it("forfeits the WHOLE series to the survivor once the disconnected opponent's grace period elapses, without disturbing an unrelated concurrent series", async () => {
  const toForfeit = await formAPairing();
  const unrelated = await formAPairing();

  const survivor = toForfeit.a;
  const departing = toForfeit.b;

  departing.ws.close();
  await wait(disconnectGraceMs + 500);

  // UX fix (2026-11-08): the disconnect grace period now fires via its own
  // live timer (see PROCESS.md) rather than only being checked lazily
  // inside resolveSession on the next WebSocket upgrade — so, unlike every
  // other disconnect-expiry test in this file, no trigger connection is
  // needed here anymore for the forfeit itself to have already happened by
  // the time the wait above returns. A plain wait is enough.
  const unrelatedACountBefore = unrelated.a.messages.length;
  const unrelatedBCountBefore = unrelated.b.messages.length;

  expect(survivor.messages).toContainEqual({ type: "seriesEnded", reason: "opponentDisconnected" });

  // The unrelated, still-fully-connected concurrent series must be
  // completely undisturbed by the OTHER series' forfeit settling
  // specifically — it's still allowed to have timed out its OWN turn
  // during this same wait (disconnectGraceMs here is deliberately longer
  // than TURN_DURATION_MS — see this file's own top-of-file comment on
  // that ordering — so a same-length live match easily can, and that's a
  // real, unrelated "state" broadcast, not cross-series leakage). What
  // must never appear is a seriesEnded for this pairing, or its status
  // leaving "active".
  const unrelatedANew = unrelated.a.messages.slice(unrelatedACountBefore);
  const unrelatedBNew = unrelated.b.messages.slice(unrelatedBCountBefore);
  expect(unrelatedANew.some((m) => m.type === "seriesEnded")).toBe(false);
  expect(unrelatedBNew.some((m) => m.type === "seriesEnded")).toBe(false);
  expect(lastState(unrelated.a.messages)?.status).toBe("active");

  // The survivor's own session was released — rejoining the queue starts a
  // genuinely fresh pairing, it doesn't resume the forfeited series.
  send(survivor.ws, { type: "joinQueue" });
  await wait(100);
  expect(survivor.messages.filter((m) => m.type === "queued").length).toBeGreaterThan(0);

  survivor.ws.close();
  unrelated.a.ws.close();
  unrelated.b.ws.close();
  await wait(200);
}, disconnectGraceMs + 5000);

it("abandons a series with no winner, notifying nobody, once BOTH players' grace periods elapse close together", async () => {
  const both = await formAPairing();

  both.a.ws.close();
  both.b.ws.close();
  await wait(disconnectGraceMs + 500);

  // Trigger the lazy reap via an unrelated connection (must be a real
  // WebSocket connect — resolveSession, where reaping happens, only runs
  // on a WS upgrade, never on a plain HTTP GET).
  const trigger = await connect(await newSessionCookie());
  await wait(200);

  // Neither socket is open to receive anything, so the only observable
  // proof is that the server didn't crash and a genuinely fresh pairing
  // can form afterward without colliding with the abandoned series' old
  // state — covered by the next ordinary pairing test implicitly trusting
  // a clean queue.
  const fresh = await formAPairing();
  expect(lastState(fresh.a.messages)?.status).toBe("active");
  expect(lastState(fresh.a.messages)?.players.A.hand.length).toBe(3);

  trigger.ws.close();
  fresh.a.ws.close();
  fresh.b.ws.close();
  await wait(200);
}, disconnectGraceMs + 5000);

// --- Stage 2 (Turn Timer): server-authoritative 45s turn deadline --------
//
// These tests actually wait out the server's configured TURN_DURATION_MS
// (src/server/index.ts), same pattern as the disconnect-expiry tests above —
// set it to a few seconds locally (and export it before `pnpm check`) for a
// fast run; CI sets it in checks.yml.

it("auto-ends the current player's turn once the deadline elapses, broadcasting a fresh turn and deadline to both players", async () => {
  const match = await formAPairing();
  const state = lastState(match.a.messages);
  if (!state) throw new Error("expected a state after pairing");
  const timedOutPlayer = state.currentPlayer;
  const other = timedOutPlayer === "A" ? match.b : match.a;
  const self = timedOutPlayer === "A" ? match.a : match.b;

  await wait(turnDurationMs + 500);

  // The timeout fires via a live in-process setTimeout (the confirmed
  // "Live" decision) — no trigger connection needed, unlike the
  // disconnect-expiry tests above, which only reap lazily on the next
  // WebSocket upgrade.
  const afterTimeout = lastState(self.messages);
  expect(afterTimeout?.currentPlayer).not.toBe(timedOutPlayer);
  expect(afterTimeout?.status).toBe("active");
  // Both players get the SAME new state/deadline — this is a server-level
  // broadcast, not a message to just the timed-out player.
  expect(lastState(other.messages)?.currentPlayer).toBe(afterTimeout?.currentPlayer);
  const newDeadline = lastSeries(self.messages)?.turnDeadline;
  expect(newDeadline).not.toBeNull();
  expect(newDeadline!).toBeGreaterThan(Date.now());
  expect(lastSeries(other.messages)?.turnDeadline).toBe(newDeadline);

  match.a.ws.close();
  match.b.ws.close();
  await wait(200);
}, turnDurationMs + 5000);

it("rejects an action from the just-timed-out player, leaving the auto-advanced turn unchanged", async () => {
  // By the time a real message can arrive over the wire after waiting out
  // the full turnDurationMs, the server's own handleTurnTimeout has ALREADY
  // fired and armed a brand new future deadline for the new current player
  // — so this lands on engine.ts's ordinary turn-order guard ("not this
  // player's turn"), the same path any out-of-turn action already takes,
  // not the narrow same-tick "your turn already timed out" pre-check in
  // server.ts (that race — a message and this series' own timeout callback
  // both already queued for the same event-loop tick — isn't practically
  // reachable via a real wall-clock wait in a black-box test; it's covered
  // by this file's reasoning alongside the already-established
  // not-practical-to-script states noted elsewhere in this file).
  const match = await formAPairing();
  const state = lastState(match.a.messages);
  if (!state) throw new Error("expected a state after pairing");
  const timedOutPlayer = state.currentPlayer === "A" ? match.a : match.b;

  await wait(turnDurationMs + 500);

  const stateAfterTimeout = lastState(timedOutPlayer.messages);
  const countBefore = timedOutPlayer.messages.length;

  // The timed-out player's own socket is still open — sending an action
  // for a turn that's no longer theirs must be rejected, not silently
  // accepted as if it were the (different) new current player's action.
  send(timedOutPlayer.ws, { type: "draw" });
  await wait(200);

  const newMessages = timedOutPlayer.messages.slice(countBefore);
  expect(newMessages).toHaveLength(1);
  expect(newMessages[0].type).toBe("error");
  expect(newMessages[0].message).toMatch(/turn/);
  // No new state was pushed as a result of the rejected action — the state
  // this player last saw is still the one from right after the auto-timeout.
  expect(lastState(timedOutPlayer.messages)).toEqual(stateAfterTimeout);

  match.a.ws.close();
  match.b.ws.close();
  await wait(200);
}, turnDurationMs + 5000);

it("keeps the timer running and still times out a turn even while the current player is disconnected (confirmed: disconnect never pauses the clock)", async () => {
  const match = await formAPairing();
  const state = lastState(match.a.messages);
  if (!state) throw new Error("expected a state after pairing");
  const timedOutPlayer = state.currentPlayer === "A" ? match.a : match.b;
  const other = timedOutPlayer === match.a ? match.b : match.a;

  // The timed-out player disconnects WITHOUT acting — well within the
  // disconnect grace period, so their seat isn't forfeited, but per the
  // confirmed "Continue" decision this must not pause or reset their own
  // turn's deadline either.
  timedOutPlayer.ws.close();
  await wait(turnDurationMs + 500);

  // Only the still-connected opponent can observe the result directly —
  // the disconnected player's old socket is closed.
  const afterTimeout = lastState(other.messages);
  expect(afterTimeout?.currentPlayer).toBe(state.currentPlayer === "A" ? "B" : "A");
  expect(afterTimeout?.status).toBe("active");

  match.a.ws.close();
  match.b.ws.close();
  await wait(200);
}, turnDurationMs + 5000);

it("never leaks one series' turn-timeout broadcast into an unrelated concurrent series", async () => {
  // Both series pair at nearly the same moment, so both of their OWN
  // independent timers legitimately fire around the same ~turnDurationMs
  // mark — "unrelated gets no broadcast at all" would be the wrong
  // expectation (it has its own active turn being timed too). The real
  // isolation claim this test checks: whichever series "unrelated" plays
  // out, the player/deadline it settles on is its OWN series' outcome, not
  // "toTimeOut"'s — two broadcasts that happen to look similar because they
  // each independently ran the same timeout logic, not evidence of a leak
  // between them.
  const toTimeOut = await formAPairing();
  const unrelated = await formAPairing();

  const toTimeOutState = lastState(toTimeOut.a.messages);
  const unrelatedState = lastState(unrelated.a.messages);
  if (!toTimeOutState || !unrelatedState) throw new Error("expected both pairings to have a state");

  await wait(turnDurationMs + 500);

  const toTimeOutAfter = lastState(toTimeOut.a.messages);
  const unrelatedAfter = lastState(unrelated.a.messages);
  expect(toTimeOutAfter?.currentPlayer).not.toBe(toTimeOutState.currentPlayer);
  expect(unrelatedAfter?.currentPlayer).not.toBe(unrelatedState.currentPlayer);

  // Each series' player hands are still exactly 3 cards (nobody drew or
  // played a card as part of a timeout — only endTurn ever runs) and belong
  // to their own series, never swapped with the other's.
  expect(toTimeOutAfter?.players.A.hand.length).toBe(3);
  expect(unrelatedAfter?.players.A.hand.length).toBe(3);

  toTimeOut.a.ws.close();
  toTimeOut.b.ws.close();
  unrelated.a.ws.close();
  unrelated.b.ws.close();
  await wait(200);
}, turnDurationMs + 5000);

// --- Stage 3 (Hand Limit): 5-card cap, Partial Water overflow ------------

it("rejects an ordinary Draw once the hand reaches the 5-card cap, leaving it unchanged", async () => {
  const match = await formAPairing();
  const initialState = lastState(match.a.messages);
  if (!initialState) throw new Error("expected a state after pairing");
  // The very first mover is always firstPlayer (§2 First Player), whose own
  // first turn is exactly 1 AP (engine.ts's own confirmed exception) — a
  // single Draw (1 AP) spends it all, auto-ending the turn to the opponent
  // (whose OWN first turn is the normal 2 AP). Exploiting this known,
  // deterministic AP sequence avoids needing a polling loop: draw once
  // (hand 3->4, auto-ends to opponent) -> opponent endTurn's their 2 AP away
  // unused (passing it back) -> actor's now-normal 2-AP turn draws again
  // (hand 4->5, 1 AP left, still actor's turn) -> the cap-rejection draw.
  const actorSeat = initialState.currentPlayer;
  const actor = actorSeat === "A" ? match.a : match.b;
  const opponent = actorSeat === "A" ? match.b : match.a;

  send(actor.ws, { type: "draw" });
  await wait(100);
  expect(lastState(actor.messages)?.players[actorSeat].hand.length).toBe(4);
  expect(lastState(actor.messages)?.currentPlayer).not.toBe(actorSeat);

  send(opponent.ws, { type: "endTurn" });
  await wait(100);
  expect(lastState(actor.messages)?.currentPlayer).toBe(actorSeat);

  send(actor.ws, { type: "draw" });
  await wait(100);
  expect(lastState(actor.messages)?.players[actorSeat].hand.length).toBe(5);
  expect(lastState(actor.messages)?.currentPlayer).toBe(actorSeat); // 1 AP still left

  const countBefore = actor.messages.length;
  send(actor.ws, { type: "draw" });
  await wait(200);

  const newMessages = actor.messages.slice(countBefore);
  expect(newMessages).toHaveLength(1);
  expect(newMessages[0].type).toBe("error");
  expect(newMessages[0].message).toMatch(/maximum/);
  // The rejected Draw didn't change anything — hand still exactly 5, and no
  // new state was broadcast as a result of it.
  expect(lastState(actor.messages)?.players[actorSeat].hand.length).toBe(5);

  match.a.ws.close();
  match.b.ws.close();
  await wait(200);
});

// --- Stage 5: best-of-three series lifecycle ----------------------------

it("a mutual abandon in one series never touches an unrelated concurrent series' score or state", async () => {
  const toAbandon = await formAPairing();
  const unrelated = await formAPairing();

  const unrelatedACountBefore = unrelated.a.messages.length;
  const unrelatedBCountBefore = unrelated.b.messages.length;

  send(toAbandon.a.ws, { type: "requestQuit" });
  await wait(100);
  send(toAbandon.b.ws, { type: "requestQuit" });
  await wait(200);

  expect(toAbandon.a.messages).toContainEqual(
    expect.objectContaining({ type: "seriesEnded", reason: "seriesConcluded" }),
  );

  // The unrelated, still fully-connected concurrent series receives nothing
  // as a side effect of the other one's series-level settlement.
  expect(unrelated.a.messages.slice(unrelatedACountBefore)).toHaveLength(0);
  expect(unrelated.b.messages.slice(unrelatedBCountBefore)).toHaveLength(0);
  expect(lastState(unrelated.a.messages)?.status).toBe("active");

  toAbandon.a.ws.close();
  toAbandon.b.ws.close();
  unrelated.a.ws.close();
  unrelated.b.ws.close();
  await wait(200);
});

// --- Stage 6: unilateral forfeitSeries -----------------------------------

it("lets one player unilaterally forfeit the WHOLE series, awarding it to the opponent with no agreement needed", async () => {
  const match = await formAPairing();
  const unrelated = await formAPairing();

  const unrelatedACountBefore = unrelated.a.messages.length;
  const unrelatedBCountBefore = unrelated.b.messages.length;

  send(match.a.ws, { type: "forfeitSeries" });
  await wait(200);

  // The forfeiting player (A) gets their own confirmation, distinct in
  // wording from what the opponent receives.
  const forfeitConfirmation = match.a.messages.find((m) => m.type === "seriesEnded");
  expect(forfeitConfirmation?.reason).toBe("forfeited");
  expect(forfeitConfirmation?.series?.seriesWinner).toBe("B");
  expect(forfeitConfirmation?.series?.seriesStatus).toBe("finished");
  // The forfeited game was never credited as an actual win — forfeiting
  // judges the series directly, it never manufactures a game-win out of an
  // in-progress, undecided game.
  expect(forfeitConfirmation?.series?.gamesWon).toEqual({ A: 0, B: 0 });

  // B, who did nothing, is told the opponent forfeited specifically —
  // distinct from both the disconnect-forfeit and mutual-abandon reasons.
  const opponentNotice = match.b.messages.find((m) => m.type === "seriesEnded");
  expect(opponentNotice?.reason).toBe("opponentForfeited");
  expect(opponentNotice?.series).toEqual(forfeitConfirmation?.series);

  // Both sessions released — rejoining the queue starts a genuinely fresh
  // pairing/series for either of them, not a resumption of anything.
  send(match.a.ws, { type: "joinQueue" });
  await wait(100);
  expect(match.a.messages.filter((m) => m.type === "queued").length).toBeGreaterThan(0);

  // The unrelated, still fully-connected concurrent series receives nothing
  // as a side effect of this one's forfeit settling.
  expect(unrelated.a.messages.slice(unrelatedACountBefore)).toHaveLength(0);
  expect(unrelated.b.messages.slice(unrelatedBCountBefore)).toHaveLength(0);
  expect(lastState(unrelated.a.messages)?.status).toBe("active");

  match.a.ws.close();
  match.b.ws.close();
  unrelated.a.ws.close();
  unrelated.b.ws.close();
  await wait(200);
});

// --- Stage 2 (authorization/logging hardening): new authorization tests ----

it("ignores a forged player/playerId field — the acting seat is always resolved from the real connection, never the message body", async () => {
  const match = await formAPairing();
  const unrelated = await formAPairing();

  const state = lastState(match.a.messages);
  if (!state) throw new Error("expected a state after pairing");
  // The socket that is NOT allowed to act right now, per the real server-side
  // turn order.
  const outOfTurnClient = state.currentPlayer === "A" ? match.b : match.a;
  const outOfTurnSeat = state.currentPlayer === "A" ? "B" : "A";
  const legitimateSeat = state.currentPlayer;

  const messageCountBefore = outOfTurnClient.messages.length;
  const unrelatedACountBefore = unrelated.a.messages.length;
  const unrelatedBCountBefore = unrelated.b.messages.length;

  // Sent from the wrong socket, but claiming — via extra fields the protocol
  // doesn't even declare (see protocol.ts's ClientMessage: no variant has a
  // player/playerId field) — to be the legitimate current player.
  send(outOfTurnClient.ws, { type: "draw", player: legitimateSeat, playerId: legitimateSeat });
  await wait(200);

  const newMessages = outOfTurnClient.messages.slice(messageCountBefore);
  expect(newMessages).toHaveLength(1);
  expect(newMessages[0].type).toBe("error");
  // Identical rejection reason to the plain out-of-turn case (the earlier
  // "enforces turn order" test, with no forged fields at all) — the forged
  // fields changed nothing about the outcome, confirming the server never
  // even looks at them to decide who's acting.
  expect(newMessages[0].message).toMatch(/turn/);

  // The legitimate seat's own hand/AP is completely unaffected — no draw was
  // actually applied to anyone, since the message was rejected outright, not
  // partially honored.
  const afterState = lastState(match.a.messages);
  expect(afterState?.currentPlayer).toBe(legitimateSeat);
  expect(afterState?.ap).toBe(state.ap);
  expect(afterState?.players[outOfTurnSeat]).toEqual(state.players[outOfTurnSeat]);

  // An unrelated concurrent series receives nothing as a side effect.
  expect(unrelated.a.messages.slice(unrelatedACountBefore)).toHaveLength(0);
  expect(unrelated.b.messages.slice(unrelatedBCountBefore)).toHaveLength(0);

  match.a.ws.close();
  match.b.ws.close();
  unrelated.a.ws.close();
  unrelated.b.ws.close();
  await wait(200);
});

it("silently discards a game message from an already-released session, without reviving or mutating its old series", async () => {
  const match = await formAPairing();
  const unrelated = await formAPairing();

  // Release both of match's sessions via the existing, already-verified
  // unilateral forfeit path (Stage 6) — the simplest deterministic way to
  // reach "a session whose SessionEntry has been deleted, while its socket
  // is still technically open" without waiting out a real disconnect grace
  // period.
  send(match.a.ws, { type: "forfeitSeries" });
  await wait(200);
  expect(match.a.messages).toContainEqual(expect.objectContaining({ type: "seriesEnded", reason: "forfeited" }));
  expect(match.b.messages).toContainEqual(expect.objectContaining({ type: "seriesEnded", reason: "opponentForfeited" }));

  const aCountBefore = match.a.messages.length;
  const bCountBefore = match.b.messages.length;
  const unrelatedACountBefore = unrelated.a.messages.length;
  const unrelatedBCountBefore = unrelated.b.messages.length;

  // Both sockets are still open (never closed), but their SessionEntry is
  // gone — per docs/authorization.md, this hits the `!entry` guard in
  // server.ts and the message is discarded, not errored (this repo's
  // established convention for a session the server no longer recognizes).
  send(match.a.ws, { type: "draw" });
  send(match.b.ws, { type: "endTurn" });
  await wait(200);

  // Neither released socket receives anything at all in response — no error,
  // no state, nothing. A real error response here would mean the server was
  // still treating this as a live, seated session.
  expect(match.a.messages.slice(aCountBefore)).toHaveLength(0);
  expect(match.b.messages.slice(bCountBefore)).toHaveLength(0);

  // The unrelated, still-active concurrent series is completely undisturbed
  // by a stale message against a dead series — cross-series isolation holds
  // even for a released session's leftover messages, not just live ones.
  expect(unrelated.a.messages.slice(unrelatedACountBefore)).toHaveLength(0);
  expect(unrelated.b.messages.slice(unrelatedBCountBefore)).toHaveLength(0);
  expect(lastState(unrelated.a.messages)?.status).toBe("active");

  // A fresh pairing can still form cleanly afterward — the released session
  // ids aren't left in some half-cleaned-up state that would corrupt a new
  // series reusing the same queue.
  const fresh = await formAPairing();
  expect(lastState(fresh.a.messages)?.status).toBe("active");

  match.a.ws.close();
  match.b.ws.close();
  unrelated.a.ws.close();
  unrelated.b.ws.close();
  fresh.a.ws.close();
  fresh.b.ws.close();
  await wait(200);
});

// Not covered here: rejecting forfeitSeries once the current game has
// already concluded (finished/locked) but the series itself is still
// active (both players only waiting to confirm the next game). Reaching a
// real finished/locked game through actual live play with real random card
// draws isn't practical to script deterministically over this transport —
// the same already-established limitation this file's own top comment
// notes for best-of-three's score progressions. Verified instead by the
// same manual, real-process method Stage 5 used (see PROCESS.md's Stage 6
// entry): force a game one move from lethal via a direct SQLite edit, let
// the real transport finish it for real, then send forfeitSeries into the
// resulting "game concluded, series still active" gap and confirm it's
// rejected rather than silently forfeiting a game that already has a real
// winner.
