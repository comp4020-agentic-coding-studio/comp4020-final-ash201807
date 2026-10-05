// Stage 6d manual verification, step 2: reconnect with the saved cookies
// (after the server was restarted with a directly-edited "finished" game),
// confirm restart once from A, then again from B, and assert on what both
// connected sockets receive. Not part of pnpm check.
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const BASE = process.env.APP_URL ?? "http://localhost:8081";
const WS_URL = BASE.replace(/^http/, "ws") + "/ws";
const { cookieA, cookieB } = JSON.parse(readFileSync("/tmp/restart-check-cookies.json", "utf8"));

function connect(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Cookie: cookie } });
    const messages = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function lastState(messages) {
  return messages.filter((m) => m.type === "state").at(-1)?.state;
}

function fail(msg) {
  console.error("FAIL:", msg);
  process.exitCode = 1;
}

async function main() {
  const a = await connect(cookieA);
  await wait(100);
  const b = await connect(cookieB);
  await wait(200);

  console.log("A reconnect assigned:", a.messages[0]);
  console.log("B reconnect assigned:", b.messages[0]);
  if (a.messages[0]?.player !== "A") fail("A did not get its original player slot back");
  if (b.messages[0]?.player !== "B") fail("B did not get its original player slot back");

  const stateBefore = lastState(a.messages);
  console.log("state on reconnect: status =", stateBefore?.status, "restartConfirmed =", stateBefore?.restartConfirmed);
  if (stateBefore?.status !== "finished") fail("expected the forced 'finished' status to have survived the restart");

  // One confirmation: both sides must see the updated restartConfirmed, game
  // must NOT reset yet.
  const aCountBefore = a.messages.length;
  const bCountBefore = b.messages.length;
  send(a.ws, { type: "confirmNewGame" });
  await wait(200);

  const aStateAfterOne = lastState(a.messages.slice(aCountBefore));
  const bStateAfterOne = lastState(b.messages.slice(bCountBefore));
  console.log("after A confirms -> A sees:", aStateAfterOne?.restartConfirmed, "B sees:", bStateAfterOne?.restartConfirmed);
  if (!aStateAfterOne || aStateAfterOne.status !== "finished") fail("game should still be 'finished' after only one confirmation");
  if (!bStateAfterOne || JSON.stringify(bStateAfterOne.restartConfirmed) !== JSON.stringify({ A: true, B: false })) {
    fail("B's own socket should have received the updated restartConfirmed too (broadcast, not just to the sender)");
  }

  // Second confirmation: both sides must receive a brand new, active game.
  const aCountBefore2 = a.messages.length;
  const bCountBefore2 = b.messages.length;
  send(b.ws, { type: "confirmNewGame" });
  await wait(200);

  const aStateAfterTwo = lastState(a.messages.slice(aCountBefore2));
  const bStateAfterTwo = lastState(b.messages.slice(bCountBefore2));
  console.log("after B confirms -> A sees:", aStateAfterTwo?.status, "B sees:", bStateAfterTwo?.status);
  if (aStateAfterTwo?.status !== "active" || bStateAfterTwo?.status !== "active") {
    fail("both sides should receive a fresh, active game once both have confirmed");
  }
  if (aStateAfterTwo?.winner !== null) fail("fresh game should have no winner");
  if (aStateAfterTwo?.players.A.hp !== 100 || aStateAfterTwo?.players.B.hp !== 100) fail("fresh game should reset HP to 100");
  if (aStateAfterTwo?.players.A.hand.length !== 3) fail("fresh game should deal a 3-card starting hand");

  a.ws.close();
  b.ws.close();

  if (process.exitCode) {
    console.log("\nSOME CHECKS FAILED");
  } else {
    console.log("\nALL CHECKS PASSED");
  }
}

main();
