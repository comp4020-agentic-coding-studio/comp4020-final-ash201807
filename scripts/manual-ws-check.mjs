// Manual two-client simulation, not part of pnpm check — exercises the real
// WS protocol against a locally running server to verify realtime sync and
// persistence before a browser-based manual pass. Run with:
//   node scripts/manual-ws-check.mjs
import WebSocket from "ws";

const BASE = process.env.APP_URL ?? "http://localhost:8081";
const WS_URL = BASE.replace(/^http/, "ws") + "/ws";

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const messages = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      console.log(`[${label}] <-`, msg.type, msg.type === "state" ? `(status=${msg.state.status}, turn=${msg.state.currentPlayer})` : msg.message ?? msg.player ?? "");
    });
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });
}

function send(ws, label, msg) {
  console.log(`[${label}] ->`, msg.type);
  ws.send(JSON.stringify(msg));
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const a = await connect("A");
  await wait(100);
  const b = await connect("B");
  await wait(200);

  const aLast = () => a.messages.filter((m) => m.type === "state").at(-1);
  const bLast = () => b.messages.filter((m) => m.type === "state").at(-1);

  if (!aLast() || !bLast()) throw new Error("FAIL: both clients should have a state after pairing");
  console.log("OK: both clients received state once paired");

  const firstPlayer = aLast().state.currentPlayer;
  const firstSocket = firstPlayer === "A" ? a : b;
  const otherSocket = firstPlayer === "A" ? b : a;

  // Draw with whoever's turn it is, then confirm the OTHER client saw it too
  // (proves server-push realtime sync, not just an echo to the sender).
  send(firstSocket.ws, firstPlayer, { type: "draw" });
  await wait(200);

  const otherStateCountAfterDraw = otherSocket.messages.filter((m) => m.type === "state").length;
  if (otherStateCountAfterDraw < 2) throw new Error("FAIL: the other client never received the pushed state update");
  console.log("OK: a Draw by one player pushed a new state to the other client without it acting");

  const afterDraw = aLast().state;
  if (afterDraw.players[firstPlayer].hand.length !== 4) {
    throw new Error(`FAIL: expected 4 cards in hand after Draw, got ${afterDraw.players[firstPlayer].hand.length}`);
  }
  console.log("OK: hand grew by one card after Draw");

  // A third connection must be rejected outright.
  const third = await connect("C");
  await wait(200);
  const thirdSawFull = third.messages.some((m) => m.type === "full");
  if (!thirdSawFull) throw new Error("FAIL: a third connection should receive {type: full}");
  console.log("OK: third connection correctly rejected with 'full'");

  // Wrong-turn rejection: whoever's turn it is NOW (the first player's turn
  // may have just auto-ended if that Draw was their 1-AP first turn), have
  // the OTHER socket try to act.
  const currentPlayerNow = afterDraw.currentPlayer;
  const outOfTurnSocket = currentPlayerNow === "A" ? b : a;
  send(outOfTurnSocket.ws, "out-of-turn", { type: "draw" });
  await wait(200);
  const outOfTurnErrors = outOfTurnSocket.messages.filter((m) => m.type === "error");
  if (outOfTurnErrors.length === 0) throw new Error("FAIL: an out-of-turn action should produce an error message");
  console.log("OK: out-of-turn action rejected:", outOfTurnErrors.at(-1).message);

  a.ws.close();
  b.ws.close();
  third.ws.close();
  console.log("\nALL CHECKS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
