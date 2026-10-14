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
// var so it knows how long to wait, defaulting to the real 30s if unset. CI
// sets it to 1s (.github/workflows/checks.yml). Running locally against the
// real default makes this file take significantly longer; start your dev
// server with DISCONNECT_GRACE_MS=1000 (and export it before `pnpm check`
// too) for a fast local run.
const disconnectGraceMs = Number(process.env.DISCONNECT_GRACE_MS ?? 30_000);
const baseUrl = inject("baseUrl");
const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";

interface SeriesScore {
  gamesWon: Record<"A" | "B", number>;
  seriesStatus: "active" | "finished" | "abandoned";
  seriesWinner: "A" | "B" | null;
}

interface ServerMessage {
  type: "assigned" | "waiting" | "queued" | "state" | "seriesEnded" | "error";
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

  expect(aAgain.messages[0]).toEqual({ type: "assigned", player: "A" });
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

  expect(oneAAgain.messages[0]).toEqual({ type: "assigned", player: "A" });
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

  // Reaping is only checked inside resolveSession, which runs on a
  // WebSocket upgrade — a plain HTTP GET never reaches it. Any new
  // connection attempt is a fine trigger (same pattern every prior
  // disconnect-expiry test in this file relies on, each of those via
  // connectAndJoinQueue's own WebSocket connect).
  const unrelatedACountBefore = unrelated.a.messages.length;
  const unrelatedBCountBefore = unrelated.b.messages.length;
  const trigger = await connect(await newSessionCookie());
  await wait(200);

  expect(survivor.messages).toContainEqual({ type: "seriesEnded", reason: "opponentDisconnected" });

  // The unrelated, still-fully-connected concurrent series must be
  // completely undisturbed by the other one's forfeit settling.
  expect(unrelated.a.messages.slice(unrelatedACountBefore)).toHaveLength(0);
  expect(unrelated.b.messages.slice(unrelatedBCountBefore)).toHaveLength(0);
  expect(lastState(unrelated.a.messages)?.status).toBe("active");

  // The survivor's own session was released — rejoining the queue starts a
  // genuinely fresh pairing, it doesn't resume the forfeited series.
  send(survivor.ws, { type: "joinQueue" });
  await wait(100);
  expect(survivor.messages.filter((m) => m.type === "queued").length).toBeGreaterThan(0);

  trigger.ws.close();
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
