// Stage 6d manual verification, step 1: pair two sessions, save their
// cookies to disk, then disconnect. Not part of pnpm check.
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const BASE = process.env.APP_URL ?? "http://localhost:8081";
const WS_URL = BASE.replace(/^http/, "ws") + "/ws";

function connect(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Cookie: cookie } });
    const messages = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function newSessionCookie() {
  const res = await fetch(new URL("/", BASE));
  return res.headers.get("set-cookie").split(";")[0];
}

const cookieA = await newSessionCookie();
const a = await connect(cookieA);
await wait(100);
const cookieB = await newSessionCookie();
const b = await connect(cookieB);
await wait(200);

console.log("A assigned:", a.messages[0]);
console.log("B assigned:", b.messages[0]);

writeFileSync("/tmp/restart-check-cookies.json", JSON.stringify({ cookieA, cookieB }));
a.ws.close();
b.ws.close();
console.log("cookies saved to /tmp/restart-check-cookies.json");
