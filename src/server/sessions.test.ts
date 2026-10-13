import { describe, expect, it } from "vitest";
import {
  dequeuePair,
  enqueue,
  markDisconnected,
  normalizeQueue,
  normalizeSessions,
  reapExpiredSessions,
  releaseSession,
  removeFromQueue,
  seatPair,
  sessionsInSeries,
  type SessionMap,
} from "./sessions.ts";

describe("enqueue", () => {
  it("appends a new session id to an empty queue", () => {
    expect(enqueue([], "s1")).toEqual(["s1"]);
  });

  it("appends to the back, preserving FIFO order", () => {
    expect(enqueue(["s1", "s2"], "s3")).toEqual(["s1", "s2", "s3"]);
  });

  it("is a no-op if the session id is already queued (uniqueness: no double-queueing)", () => {
    const queue = ["s1", "s2"];
    expect(enqueue(queue, "s1")).toBe(queue);
  });
});

describe("removeFromQueue", () => {
  it("removes the given session id, leaving the rest in order", () => {
    expect(removeFromQueue(["s1", "s2", "s3"], "s2")).toEqual(["s1", "s3"]);
  });

  it("is a no-op (same reference) for a session id that isn't queued", () => {
    const queue = ["s1", "s2"];
    expect(removeFromQueue(queue, "unknown")).toBe(queue);
  });
});

describe("dequeuePair", () => {
  it("returns null when fewer than two are waiting", () => {
    expect(dequeuePair([])).toBeNull();
    expect(dequeuePair(["s1"])).toBeNull();
  });

  it("dequeues the front two (the longest-waiting), preserving the rest in order", () => {
    expect(dequeuePair(["s1", "s2", "s3", "s4"])).toEqual({ first: "s1", second: "s2", rest: ["s3", "s4"] });
  });

  it("dequeues exactly two even when only two are waiting, leaving an empty rest", () => {
    expect(dequeuePair(["s1", "s2"])).toEqual({ first: "s1", second: "s2", rest: [] });
  });

  it("dequeues two pairs in succession from a queue of four, leaving none behind (Stage 4b: multiple concurrent series from one queue)", () => {
    const firstPair = dequeuePair(["s1", "s2", "s3", "s4"]);
    expect(firstPair).toEqual({ first: "s1", second: "s2", rest: ["s3", "s4"] });
    const secondPair = dequeuePair(firstPair!.rest);
    expect(secondPair).toEqual({ first: "s3", second: "s4", rest: [] });
  });
});

describe("seatPair", () => {
  it("seats the first dequeued id as A and the second as B, under the given seriesId", () => {
    const result = seatPair({}, "series-1", "s1", "s2");
    expect(result).toEqual({
      s1: { player: "A", seriesId: "series-1", disconnectedAt: null },
      s2: { player: "B", seriesId: "series-1", disconnectedAt: null },
    });
  });

  it("does not disturb other sessions already in the map, including ones from a different active series", () => {
    const sessions: SessionMap = { other: { player: "A", seriesId: "old-series", disconnectedAt: null } };
    const result = seatPair(sessions, "series-2", "s1", "s2");
    expect(result.other).toEqual({ player: "A", seriesId: "old-series", disconnectedAt: null });
    expect(result.s1).toEqual({ player: "A", seriesId: "series-2", disconnectedAt: null });
    expect(result.s2).toEqual({ player: "B", seriesId: "series-2", disconnectedAt: null });
  });
});

describe("sessionsInSeries", () => {
  it("returns only the session ids bound to the given seriesId", () => {
    const sessions: SessionMap = {
      s1: { player: "A", seriesId: "series-1", disconnectedAt: null },
      s2: { player: "B", seriesId: "series-1", disconnectedAt: null },
      s3: { player: "A", seriesId: "series-2", disconnectedAt: null },
    };
    expect(sessionsInSeries(sessions, "series-1").sort()).toEqual(["s1", "s2"]);
    expect(sessionsInSeries(sessions, "series-2")).toEqual(["s3"]);
  });

  it("returns an empty array when nobody is bound to that seriesId", () => {
    const sessions: SessionMap = { s1: { player: "A", seriesId: "series-1", disconnectedAt: null } };
    expect(sessionsInSeries(sessions, "no-such-series")).toEqual([]);
  });
});

describe("releaseSession", () => {
  it("removes the given session's entry entirely", () => {
    const sessions: SessionMap = { s1: { player: "A", seriesId: "series-1", disconnectedAt: null } };
    expect(releaseSession(sessions, "s1")).toEqual({});
  });

  it("leaves other sessions untouched", () => {
    const sessions: SessionMap = {
      s1: { player: "A", seriesId: "series-1", disconnectedAt: null },
      s2: { player: "B", seriesId: "series-1", disconnectedAt: null },
    };
    expect(releaseSession(sessions, "s1")).toEqual({
      s2: { player: "B", seriesId: "series-1", disconnectedAt: null },
    });
  });

  it("is a no-op (same reference) for a session id that isn't present", () => {
    const sessions: SessionMap = { s1: { player: "A", seriesId: "series-1", disconnectedAt: null } };
    expect(releaseSession(sessions, "unknown")).toBe(sessions);
  });
});

describe("markDisconnected", () => {
  it("stamps a known session with the given disconnect time", () => {
    const sessions: SessionMap = { s1: { player: "A", seriesId: "series-1", disconnectedAt: null } };
    const result = markDisconnected(sessions, "s1", 5000);
    expect(result).toEqual({ s1: { player: "A", seriesId: "series-1", disconnectedAt: 5000 } });
  });

  it("is a no-op for a session id that was never assigned", () => {
    const sessions: SessionMap = { s1: { player: "A", seriesId: "series-1", disconnectedAt: null } };
    const result = markDisconnected(sessions, "unknown", 5000);
    expect(result).toBe(sessions);
  });

  it("overwrites an earlier disconnect timestamp with a later one", () => {
    const sessions: SessionMap = { s1: { player: "A", seriesId: "series-1", disconnectedAt: 1000 } };
    const result = markDisconnected(sessions, "s1", 2000);
    expect(result).toEqual({ s1: { player: "A", seriesId: "series-1", disconnectedAt: 2000 } });
  });
});

describe("reapExpiredSessions", () => {
  it("keeps a session whose grace period has not yet elapsed", () => {
    const sessions: SessionMap = { s1: { player: "A", seriesId: "series-1", disconnectedAt: 1000 } };
    expect(reapExpiredSessions(sessions, 1000 + 29_999, 30_000)).toEqual(sessions);
  });

  it("drops a session whose grace period has fully elapsed", () => {
    const sessions: SessionMap = { s1: { player: "A", seriesId: "series-1", disconnectedAt: 1000 } };
    expect(reapExpiredSessions(sessions, 1000 + 30_000, 30_000)).toEqual({});
  });

  it("never drops a currently-connected session (disconnectedAt: null), regardless of `now`", () => {
    const sessions: SessionMap = { s1: { player: "A", seriesId: "series-1", disconnectedAt: null } };
    expect(reapExpiredSessions(sessions, Number.MAX_SAFE_INTEGER, 30_000)).toEqual(sessions);
  });

  it("drops only the expired session, leaving the other one untouched — even across two different series", () => {
    const sessions: SessionMap = {
      s1: { player: "A", seriesId: "series-1", disconnectedAt: 1000 },
      s2: { player: "A", seriesId: "series-2", disconnectedAt: null },
    };
    expect(reapExpiredSessions(sessions, 1000 + 30_000, 30_000)).toEqual({
      s2: { player: "A", seriesId: "series-2", disconnectedAt: null },
    });
  });

  it("drops both sessions when both have expired, leaving an empty map", () => {
    const sessions: SessionMap = {
      s1: { player: "A", seriesId: "series-1", disconnectedAt: 1000 },
      s2: { player: "B", seriesId: "series-1", disconnectedAt: 2000 },
    };
    expect(reapExpiredSessions(sessions, 3000 + 30_000, 30_000)).toEqual({});
  });
});

describe("normalizeSessions", () => {
  it("passes a current-shape SessionMap through unchanged", () => {
    const sessions: SessionMap = { s1: { player: "A", seriesId: "series-1", disconnectedAt: null } };
    expect(normalizeSessions(sessions)).toEqual(sessions);
  });

  it("upgrades a pre-Stage-8a bare-PlayerId entry to a connected SessionEntry", () => {
    expect(normalizeSessions({ s1: "A", s2: "B" })).toEqual({
      s1: { player: "A", seriesId: null, disconnectedAt: null },
      s2: { player: "B", seriesId: null, disconnectedAt: null },
    });
  });

  it("handles a mix of old- and new-shape entries in the same map", () => {
    expect(normalizeSessions({ s1: "A", s2: { player: "B", seriesId: "series-1", disconnectedAt: 1234 } })).toEqual({
      s1: { player: "A", seriesId: null, disconnectedAt: null },
      s2: { player: "B", seriesId: "series-1", disconnectedAt: 1234 },
    });
  });

  it("upgrades a pre-Stage-2 SessionEntry (no seriesId field) to seriesId: null", () => {
    expect(normalizeSessions({ s1: { player: "A", disconnectedAt: null } })).toEqual({
      s1: { player: "A", seriesId: null, disconnectedAt: null },
    });
  });

  it("treats missing, null or non-object input as no sessions at all", () => {
    expect(normalizeSessions(undefined)).toEqual({});
    expect(normalizeSessions(null)).toEqual({});
    expect(normalizeSessions("garbage")).toEqual({});
  });
});

describe("normalizeQueue", () => {
  it("passes a current-shape queue array through unchanged", () => {
    expect(normalizeQueue(["s1", "s2"])).toEqual(["s1", "s2"]);
  });

  it("treats missing (pre-Stage-3) or non-array input as an empty queue", () => {
    expect(normalizeQueue(undefined)).toEqual([]);
    expect(normalizeQueue(null)).toEqual([]);
    expect(normalizeQueue("garbage")).toEqual([]);
    expect(normalizeQueue({})).toEqual([]);
  });

  it("drops any non-string entries rather than guessing at them", () => {
    expect(normalizeQueue(["s1", 42, null, "s2"])).toEqual(["s1", "s2"]);
  });
});
