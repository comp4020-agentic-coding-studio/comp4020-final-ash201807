import type { PlayerId } from "../game/types.ts";

export interface SessionEntry {
  player: PlayerId;
  // Which series this session is bound to. Always non-null once an entry
  // exists at all — under Stage 3's queue model, a SessionEntry is only ever
  // created by seatPlayers() at the exact moment a pairing completes, so
  // there's no longer an intermediate "has a seat but no series yet" state
  // the way there briefly was in Stage 2. Kept nullable in the type purely
  // for normalizeSessions' pre-Stage-2 upgrade path below.
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
// beyond its identity. Seating (seatPlayers, below) is the one and only
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

// Pure: dequeues the single front (longest-waiting) session id, if any —
// the atomic unit Stage 3's seating loop operates on. One at a time, not
// two, so that a lone queued session can take over a seat vacated by a
// disconnected-and-reaped player while the OTHER, still-connected player
// keeps theirs (see server.ts's pumpQueue) — matching Stage 8a's original
// one-arrival-at-a-time granularity, now sourced from the queue instead of
// directly from a new connection.
export function dequeueOne(queue: string[]): { sessionId: string; rest: string[] } | null {
  if (queue.length === 0) return null;
  const [sessionId, ...rest] = queue;
  return { sessionId, rest };
}

// Pure: which of the two player identities isn't already held by any of
// the given entries. Stage 4a: deliberately takes an explicit array rather
// than a whole SessionMap — under Stage 3's still-one-series-at-a-time
// model the caller could get away with passing literally every session
// there was (there was only ever one series' worth), but that's a latent
// bug once more than one series can exist concurrently: scanning every
// session EVERYWHERE for a taken "A"/"B" is meaningless once seat
// identities are only unique WITHIN a series, not globally. Pushing the
// filtering responsibility onto the caller now (passing only the entries
// relevant to the specific series being formed or refilled) means this
// function itself is already correct for Stage 4b without needing to
// change again — only the caller's filtering needs to get smarter later.
export function nextOpenSeat(entries: SessionEntry[]): PlayerId {
  const taken = new Set(entries.map((entry) => entry.player));
  return taken.has("A") ? "B" : "A";
}

// Pure: seats a single freshly-dequeued session id as the given player,
// with no series bound yet (null) — set once a second session completes
// the pair, via bindActiveSeries below. This is the only way a SessionEntry
// is created under Stage 3's model; callers must only pass ids that came
// from dequeueOne (and so, by construction, held no SessionEntry yet).
export function seatOne(sessions: SessionMap, sessionId: string, player: PlayerId): SessionMap {
  return { ...sessions, [sessionId]: { player, seriesId: null, disconnectedAt: null } };
}

// Stamps the given seriesId onto every entry currently in `sessions` — used
// the instant a second session's seating brings the count to two, so both
// the newly-seated arrival AND any already-seated survivor (whose own
// seriesId was from whatever series just ended) end up bound to the same
// fresh one.
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
// simply replaces the old one. Only meaningful for a SEATED session — a
// merely queued one is removed outright by removeFromQueue instead (see
// server.ts's close handler for the branch between the two).
export function markDisconnected(sessions: SessionMap, sessionId: string, now: number): SessionMap {
  const existing = sessions[sessionId];
  if (!existing) return sessions;
  return { ...sessions, [sessionId]: { ...existing, disconnectedAt: now } };
}

// Drops every session whose grace period has fully elapsed as of `now` — a
// plain wall-clock comparison, not a scheduled callback, so it gives the
// right answer whether it runs 10ms or 10 hours after the disconnect. The
// caller (server.ts) is responsible for noticing when this empties the map
// entirely and clearing the series that went with it.
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
