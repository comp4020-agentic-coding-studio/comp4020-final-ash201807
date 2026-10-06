import type { PlayerId } from "../game/types.ts";

export interface SessionEntry {
  player: PlayerId;
  // epoch ms when this session's last socket closed with no replacement
  // connected since; null while a live connection is on file. Read only as a
  // wall-clock difference against `now` (see reapExpiredSessions) — never via
  // a scheduled timer, so it stays correct across the server process
  // stopping and restarting mid-grace-period (Fly auto-stops the machine
  // when nobody's connected, which is exactly when a grace period would be
  // running).
  disconnectedAt: number | null;
}

export type SessionMap = Partial<Record<string, SessionEntry>>;

export type JoinResult =
  | { kind: "joined"; player: PlayerId; sessions: SessionMap; justCompletedPair: boolean }
  | { kind: "full" };

// Pure assignment logic, no I/O: the first two distinct session ids become
// Player A and Player B, in whichever order they arrive. A session id
// already assigned gets its existing slot back (a reload or reconnect) and
// has its disconnect mark cleared. Any third (or later) distinct session id
// is rejected outright — no spectating, per explicit instruction.
export function joinSession(sessions: SessionMap, sessionId: string): JoinResult {
  const existing = sessions[sessionId];
  if (existing) {
    const resumed: SessionMap =
      existing.disconnectedAt === null ? sessions : { ...sessions, [sessionId]: { ...existing, disconnectedAt: null } };
    return { kind: "joined", player: existing.player, sessions: resumed, justCompletedPair: false };
  }

  if (Object.keys(sessions).length >= 2) {
    return { kind: "full" };
  }

  const taken = new Set(Object.values(sessions).map((entry) => entry!.player));
  const player: PlayerId = taken.has("A") ? "B" : "A";
  const next: SessionMap = { ...sessions, [sessionId]: { player, disconnectedAt: null } };
  return { kind: "joined", player, sessions: next, justCompletedPair: Object.keys(next).length === 2 };
}

// Marks a known session's socket as closed, starting its grace period. A
// no-op for an unknown sessionId — nothing to mark. Call again on a later
// close (e.g. a reconnect that itself disconnects again); the new timestamp
// simply replaces the old one.
export function markDisconnected(sessions: SessionMap, sessionId: string, now: number): SessionMap {
  const existing = sessions[sessionId];
  if (!existing) return sessions;
  return { ...sessions, [sessionId]: { ...existing, disconnectedAt: now } };
}

// Drops every session whose grace period has fully elapsed as of `now` — a
// plain wall-clock comparison, not a scheduled callback, so it gives the
// right answer whether it runs 10ms or 10 hours after the disconnect. The
// caller (server.ts) is responsible for noticing when this empties the map
// entirely and clearing the game that went with it.
export function reapExpiredSessions(sessions: SessionMap, now: number, graceMs: number): SessionMap {
  const next: SessionMap = {};
  for (const [id, entry] of Object.entries(sessions)) {
    if (!entry) continue;
    if (entry.disconnectedAt !== null && now - entry.disconnectedAt >= graceMs) continue;
    next[id] = entry;
  }
  return next;
}

// Pre-Stage-8a persisted rows store a bare PlayerId ("A"/"B") per session,
// not a SessionEntry — reading one of those as {player, disconnectedAt}
// directly would read disconnectedAt as undefined, and `undefined !== null`
// would misread "this field doesn't exist yet" as "already disconnected",
// instantly reaping a perfectly fine session the first time the server
// restarts after this change ships. Treat the old shape as "currently
// connected" (disconnectedAt: null) — the safe default, since it never
// auto-abandons a game that was actually fine. Anything that isn't a
// recognizable string or SessionEntry is dropped rather than guessed at.
export function normalizeSessions(value: unknown): SessionMap {
  if (!value || typeof value !== "object") return {};
  const next: SessionMap = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      next[id] = { player: entry as PlayerId, disconnectedAt: null };
    } else if (entry && typeof entry === "object" && "player" in entry) {
      next[id] = entry as SessionEntry;
    }
  }
  return next;
}
