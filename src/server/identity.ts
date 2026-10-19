import { createHash } from "node:crypto";

// A one-way, deterministic display handle derived from a session's real id —
// same session always yields the same displayId (across reconnects, across a
// server restart, since it's a pure function of the persisted sessionId, not
// anything generated per-connection), but the real sessionId can never be
// recovered from it. For UI/log correlation only: nothing in server.ts ever
// uses this to look up or authorize a session — that's always done via the
// real sessionId resolved from the connection's own cookie. An 8-hex-char
// prefix is short enough to read in logs and is NOT collision-free (two
// different sessions could in principle share one) — a display collision is
// a cosmetic/log-readability risk only, never a security boundary, since no
// server-side decision is ever keyed on displayId.
export function displayIdFor(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
}
