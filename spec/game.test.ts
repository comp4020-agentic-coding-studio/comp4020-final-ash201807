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
const baseUrl = inject("baseUrl");
const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";

interface ServerMessage {
  type: "assigned" | "waiting" | "state" | "full" | "error";
  player?: "A" | "B";
  state?: {
    status: "active" | "finished" | "locked";
    ap: number;
    currentPlayer: "A" | "B";
    players: Record<"A" | "B", { hand: unknown[] }>;
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

  aAgain.ws.close();
  b.ws.close();
});
