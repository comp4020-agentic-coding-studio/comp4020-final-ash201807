import type { PlayerId } from "../game/types.ts";

export interface SessionEntry {
  player: PlayerId;
  // Which series this session is bound to. Always set to a real series the
  // instant a SessionEntry is created at all — Stage 4b's seatPair creates
  // both players' entries and their shared series atomically, so there's no
  // intermediate "has a seat but no series yet" state. Kept nullable in the
  // type purely for normalizeSessions' pre-Stage-2 upgrade path below, which
  // has no way to know what series an old bare-PlayerId row belonged to.
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

// Stage 3: a session that hasn't been seated yet (no SessionEntry) waits in
// a plain FIFO array of session ids — "queued" needs no richer state than
// "present in this list", since nothing about a queued session is known yet
// beyond its identity. Seating (seatPair, below) is the one and only
// transition out of the queue into a SessionEntry.

// Pure: appends sessionId to the back of the queue unless it's already
// present. Re-requesting to join while already queued is a no-op, not a
// duplicate entry — Stage 9's uniqueness rule ("at most one active queue
// slot or active series at a time") depends on this holding even if a
// client sends joinQueue twice.
export function enqueue(queue: string[], sessionId: string): string[] {
  if (queue.includes(sessionId)) return queue;
  return [...queue, sessionId];
}

// Pure: removes sessionId from the queue if present, a no-op (same array
// reference) otherwise. Used for the queued-disconnect rule (Stage 9): a
// session that disconnects while merely queued is dropped outright, no
// grace period — it never held a seat with state at stake.
export function removeFromQueue(queue: string[], sessionId: string): string[] {
  if (!queue.includes(sessionId)) return queue;
  return queue.filter((id) => id !== sessionId);
}

// Pure: if at least two are waiting, dequeues the front two — the two
// longest-waiting, per Stage 9's FIFO rule — and returns them plus the
// remaining queue; null if fewer than two are waiting. Stage 4b: this is
// now the ONLY way sessions leave the queue to become seated — always as a
// complete pair, never one at a time. That's possible (and correct) because
// Stage 4b also adopted the project owner's confirmed forfeit rule: a
// seated session whose grace period expires forfeits its WHOLE series
// rather than having its lone seat quietly refilled by a stranger (see
// server.ts's reapAndSettleSeries) — so there is never a partially-seated
// series sitting around needing a single new arrival to complete it. Every
// series that exists has exactly two sessions, from the moment it's created
// until the moment it ends.
export function dequeuePair(queue: string[]): { first: string; second: string; rest: string[] } | null {
  if (queue.length < 2) return null;
  const [first, second, ...rest] = queue;
  return { first, second, rest };
}

// Pure: seats two freshly-dequeued session ids as Player A/B of a brand new
// series, atomically — both entries are created with the given seriesId
// already set, not seriesId: null followed by a separate binding step,
// since under Stage 4b's model a pairing and its series are created
// together in one step, never one session seated alone waiting for a
// partner to arrive later (dequeuePair already guarantees there IS a
// partner, since it only ever returns a complete pair or nothing at all).
export function seatPair(sessions: SessionMap, seriesId: string, first: string, second: string): SessionMap {
  return {
    ...sessions,
    [first]: { player: "A", seriesId, disconnectedAt: null },
    [second]: { player: "B", seriesId, disconnectedAt: null },
  };
}

// Pure: every session id currently bound to the given seriesId. Used by
// server.ts's reapAndSettleSeries to decide, after reaping, whether a
// series still has both its players (nothing to do), exactly one (forfeit
// to that survivor), or none (abandoned, nobody to notify) — see that
// function's own comment for the three-way split.
export function sessionsInSeries(sessions: SessionMap, seriesId: string): string[] {
  return Object.entries(sessions)
    .filter(([, entry]) => entry?.seriesId === seriesId)
    .map(([id]) => id);
}

// Pure: removes a single session's entry entirely (not just marking it
// disconnected) — a no-op (same reference) if it's already gone. Used when
// a series ends by forfeit or abandonment: the surviving player's own
// SessionEntry is released too, not just the departed one's, since Stage
// 9's rule is that BOTH players return to the lobby and must explicitly
// re-queue, not that the survivor's seat is kept warm for a replacement
// opponent.
export function releaseSession(sessions: SessionMap, sessionId: string): SessionMap {
  if (!(sessionId in sessions)) return sessions;
  const { [sessionId]: _removed, ...rest } = sessions;
  return rest;
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
// caller (server.ts) is responsible for noticing which series this leaves
// short a player (or two) and settling those series — see
// reapAndSettleSeries.
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

// Pre-Stage-3 persisted AppState has no `queue` field at all — reads as
// undefined, not an empty array. Same "safe default" reasoning as the
// SessionEntry upgrades above: treat it as nobody queued, never crash on
// array operations against undefined.
export function normalizeQueue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string");
}
