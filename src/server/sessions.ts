import type { PlayerId } from "../game/types.ts";

export interface SessionEntry {
  player: PlayerId;
  // Which series (Stage 9/2) this session is bound to. Null while a session
  // has joined but is still alone, waiting for a second player — there's no
  // series to bind to until bindSessionsToSeries runs, which only happens
  // once a pair completes. Stage 2 keeps exactly one series alive at a time;
  // this field exists so a session resolves to "which series" rather than
  // that being an unstated singleton assumption.
  seriesId: string | null;
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
//
// `seriesId` starts null even for the completing half of a pair — joining
// only assigns a seat, it doesn't know the series id the caller is about to
// generate for it. The caller binds both sessions to that id afterward, via
// bindActiveSeries, once justCompletedPair is true (see server.ts).
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
  const next: SessionMap = { ...sessions, [sessionId]: { player, seriesId: null, disconnectedAt: null } };
  return { kind: "joined", player, sessions: next, justCompletedPair: Object.keys(next).length === 2 };
}

// Stage 2 only ever has one series alive at a time, so completing a pair
// means both sessions in the map belong to it — this just stamps the
// server-generated seriesId onto every entry, rather than engine.ts or
// joinSession needing to know how ids are generated.
export function bindActiveSeries(sessions: SessionMap, seriesId: string): SessionMap {
  const next: SessionMap = {};
  for (const [id, entry] of Object.entries(sessions)) {
    if (!entry) continue;
    next[id] = { ...entry, seriesId };
  }
  return next;
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
//
// Pre-Stage-2 rows (SessionEntry without seriesId) are normalized the same
// way: a missing seriesId reads as null, same "safe default, never
// auto-abandon" reasoning as the disconnectedAt case above.
export function normalizeSessions(value: unknown): SessionMap {
  if (!value || typeof value !== "object") return {};
  const next: SessionMap = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      next[id] = { player: entry as PlayerId, seriesId: null, disconnectedAt: null };
    } else if (entry && typeof entry === "object" && "player" in entry) {
      const e = entry as Partial<SessionEntry> & { player: PlayerId };
      next[id] = { player: e.player, seriesId: e.seriesId ?? null, disconnectedAt: e.disconnectedAt ?? null };
    }
  }
  return next;
}
