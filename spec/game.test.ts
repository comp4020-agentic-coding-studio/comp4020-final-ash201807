import { beforeAll, expect, inject, it } from "vitest";
import WebSocket from "ws";

// Black-box checks against the RUNNING app's real HTTP + WebSocket surface
// (see global-setup.ts) — no mocking, no reaching into the engine directly.
// These exercise the claims README.md makes under "Checked in spec/": a
// third visitor is rejected, an out-of-turn action changes nothing, and
// reconnecting with the same session resumes rather than loses the game.
//
// This app is a single shared game (no rooms), so every `it` below shares
// ONE pairing established once in beforeAll and runs in declaration order —
// unusual for tests, but unavoidable here: a second, independent pairing
// attempt in the same run would just see the game already full.
//
// IMPORTANT for local runs: running this file consumes both player slots on
// whatever server APP_URL points at. Re-running `pnpm check` against the
// SAME long-lived local dev server will see the game already full on the
// second run — restart the dev server (or point DB_PATH at a fresh file)
// between runs. CI is unaffected: it always starts a fresh container with a
// throwaway /data. Never point APP_URL at the deployed production app for
// this file — it would occupy the one live game's two seats.
//
// The disconnect-expiry tests near the end of this file actually wait out
// the server's configured DISCONNECT_GRACE_MS (src/server/index.ts) — this
// file reads the same env var so it knows how long to wait, defaulting to
// the real 30s if unset. CI sets it to 1s (.github/workflows/checks.yml).
// Running locally against the real default makes this file take 60+ extra
// seconds; start your dev server with DISCONNECT_GRACE_MS=1000 (and export it
// before `pnpm check` too) for a fast local run.
const disconnectGraceMs = Number(process.env.DISCONNECT_GRACE_MS ?? 30_000);
const baseUrl = inject("baseUrl");
const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";

interface ServerMessage {
  type: "assigned" | "waiting" | "state" | "full" | "error";
  player?: "A" | "B";
  state?: {
    status: "active" | "finished" | "locked" | "abandoned";
    ap: number;
    currentPlayer: "A" | "B";
    players: Record<"A" | "B", { hand: unknown[] }>;
    quitRequested: Record<"A" | "B", boolean>;
  };
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

let cookieA: string;
let a: Client;
let b: Client;

beforeAll(async () => {
  cookieA = await newSessionCookie();
  a = await connect(cookieA);
  await wait(100);
  b = await connect(await newSessionCookie());
  await wait(200);
});

it("pairs the first two sessions as A and B, and starts the game for both", () => {
  expect(a.messages[0]).toEqual({ type: "assigned", player: "A" });
  expect(a.messages[1]).toEqual({ type: "waiting" });
  expect(b.messages[0]).toEqual({ type: "assigned", player: "B" });
  // A was already connected and waiting; completing the pair must have
  // pushed it a state too, not just the newly-connecting B.
  expect(lastState(a.messages)).toBeDefined();
  expect(lastState(b.messages)).toBeDefined();
});

it("rejects a third visitor outright", async () => {
  const c = await connect(await newSessionCookie());
  await wait(200);
  expect(c.messages).toContainEqual({ type: "full" });
  c.ws.close();
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
  // this never calls newSessionCookie() again).
  a.ws.close();
  await wait(100);
  const aAgain = await connect(cookieA);
  await wait(200);

  expect(aAgain.messages[0]).toEqual({ type: "assigned", player: "A" });
  const resumedState = lastState(aAgain.messages);
  expect(resumedState).toBeDefined();
  expect(resumedState?.currentPlayer).toBe(beforeReconnect.currentPlayer);
  expect(resumedState?.players.A.hand.length).toBe(beforeReconnect.players.A.hand.length);

  // Leave A closed (no further reconnect) and B still connected — the next
  // test relies on exactly this to check that only A's slot gets reaped.
  aAgain.ws.close();
  a = aAgain;
});

it("frees only the disconnected player's slot once its grace period elapses, leaving the still-connected opponent's session untouched", async () => {
  // Default vitest per-test timeout (5s) isn't enough once this actually
  // waits out a real DISCONNECT_GRACE_MS — see the timeout arg below.
  // A has been closed (previous test) with no reconnect since; B never
  // disconnected at all. Waiting out the grace period relies purely on
  // wall-clock time having passed — there's no timer running anywhere for
  // this test to depend on (Stage 8a is deliberately timer-free).
  await wait(disconnectGraceMs + 500);

  const messageCountBeforeB = b.messages.length;
  const c = await connect(await newSessionCookie());
  await wait(200);

  // The third visitor claims A's now-freed slot rather than being rejected.
  expect(c.messages[0]).toEqual({ type: "assigned", player: "A" });

  // Freeing exactly one slot and refilling it still takes the session map
  // from 1 entry back to 2, which is indistinguishable from the very first
  // pairing ever completing — so it replaces the WHOLE game via the same
  // justCompletedPair path, not just the departed player's seat. B, who
  // never left, gets pushed this fresh state too even though B did nothing.
  const newMessagesForB = b.messages.slice(messageCountBeforeB);
  expect(newMessagesForB.some((m) => m.type === "state")).toBe(true);
  const freshState = lastState(b.messages);
  expect(freshState?.status).toBe("active");
  expect(freshState?.players.A.hand.length).toBe(3);
  expect(freshState?.players.B.hand.length).toBe(3);

  c.ws.close();
  b.ws.close();
}, disconnectGraceMs + 5000);

it("frees both slots once nobody reconnects within the grace period, starting a genuinely fresh pairing", async () => {
  // Both c (as A) and b (as B) were closed at the end of the previous test
  // with no reconnect since.
  await wait(disconnectGraceMs + 500);

  const freshA = await connect(await newSessionCookie());
  await wait(100);
  expect(freshA.messages[0]).toEqual({ type: "assigned", player: "A" });
  expect(freshA.messages[1]).toEqual({ type: "waiting" });

  const freshB = await connect(await newSessionCookie());
  await wait(200);
  expect(freshB.messages[0]).toEqual({ type: "assigned", player: "B" });

  const state = lastState(freshB.messages);
  expect(state).toBeDefined();
  expect(state?.status).toBe("active");
  expect(state?.players.A.hand.length).toBe(3);
  expect(state?.players.B.hand.length).toBe(3);

  // Left open on purpose — the voluntary-termination tests below continue
  // using this exact pairing instead of closing it.
  a = freshA;
  b = freshB;
}, disconnectGraceMs + 5000);

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

it("ends the game with no winner once both players request it, and allows a fresh game afterward", async () => {
  send(a.ws, { type: "requestQuit" });
  await wait(100);
  send(b.ws, { type: "requestQuit" });
  await wait(200);

  expect(lastState(a.messages)?.status).toBe("abandoned");
  expect(lastState(b.messages)?.status).toBe("abandoned");

  // The ordinary New Game flow (already covered for "locked"/"finished" in
  // the engine suite) works the same way for "abandoned" over the real
  // transport — nothing abandonment-specific needed in confirmNewGame.
  send(a.ws, { type: "confirmNewGame" });
  await wait(100);
  send(b.ws, { type: "confirmNewGame" });
  await wait(200);

  const freshState = lastState(b.messages);
  expect(freshState?.status).toBe("active");
  expect(freshState?.quitRequested).toEqual({ A: false, B: false });
  expect(freshState?.players.A.hand.length).toBe(3);

  a.ws.close();
  b.ws.close();
});
