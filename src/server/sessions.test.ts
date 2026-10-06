import { describe, expect, it } from "vitest";
import { joinSession, markDisconnected, normalizeSessions, reapExpiredSessions, type SessionMap } from "./sessions.ts";

describe("joinSession", () => {
  it("assigns the first session Player A", () => {
    const result = joinSession({}, "s1");
    expect(result).toEqual({
      kind: "joined",
      player: "A",
      sessions: { s1: { player: "A", disconnectedAt: null } },
      justCompletedPair: false,
    });
  });

  it("assigns the second distinct session Player B and reports the pair as complete", () => {
    const afterFirst = joinSession({}, "s1");
    if (afterFirst.kind !== "joined") throw new Error("expected joined");

    const afterSecond = joinSession(afterFirst.sessions, "s2");
    expect(afterSecond).toEqual({
      kind: "joined",
      player: "B",
      sessions: { s1: { player: "A", disconnectedAt: null }, s2: { player: "B", disconnectedAt: null } },
      justCompletedPair: true,
    });
  });

  it("returns an already-assigned session its existing slot without marking the pair as newly completed", () => {
    const sessions: SessionMap = { s1: { player: "A", disconnectedAt: null } };
    const result = joinSession(sessions, "s1");
    expect(result).toEqual({ kind: "joined", player: "A", sessions, justCompletedPair: false });
  });

  it("rejects a third distinct session once both slots are taken", () => {
    const sessions: SessionMap = { s1: { player: "A", disconnectedAt: null }, s2: { player: "B", disconnectedAt: null } };
    const result = joinSession(sessions, "s3");
    expect(result).toEqual({ kind: "full" });
  });

  it("still returns an existing player's own slot even after a third session has been rejected", () => {
    const sessions: SessionMap = { s1: { player: "A", disconnectedAt: null }, s2: { player: "B", disconnectedAt: null } };
    const result = joinSession(sessions, "s2");
    expect(result).toEqual({ kind: "joined", player: "B", sessions, justCompletedPair: false });
  });

  it("assigns Player A even if the first session to join happens to be recorded as B-first in an empty map", () => {
    // Order of arrival determines the slot, not any fixed identity — the
    // first ever caller gets A regardless of session id contents.
    const result = joinSession({}, "whoever-shows-up-first");
    expect(result.kind).toBe("joined");
    if (result.kind === "joined") expect(result.player).toBe("A");
  });

  it("clears a previously-disconnected session's grace mark on reconnect", () => {
    const sessions: SessionMap = { s1: { player: "A", disconnectedAt: 1000 } };
    const result = joinSession(sessions, "s1");
    expect(result).toEqual({
      kind: "joined",
      player: "A",
      sessions: { s1: { player: "A", disconnectedAt: null } },
      justCompletedPair: false,
    });
  });

  it("leaves an already-connected session's entry identity untouched (no unnecessary copy)", () => {
    const sessions: SessionMap = { s1: { player: "A", disconnectedAt: null } };
    const result = joinSession(sessions, "s1");
    if (result.kind !== "joined") throw new Error("expected joined");
    expect(result.sessions).toBe(sessions);
  });
});

describe("markDisconnected", () => {
  it("stamps a known session with the given disconnect time", () => {
    const sessions: SessionMap = { s1: { player: "A", disconnectedAt: null } };
    const result = markDisconnected(sessions, "s1", 5000);
    expect(result).toEqual({ s1: { player: "A", disconnectedAt: 5000 } });
  });

  it("is a no-op for a session id that was never assigned", () => {
    const sessions: SessionMap = { s1: { player: "A", disconnectedAt: null } };
    const result = markDisconnected(sessions, "unknown", 5000);
    expect(result).toBe(sessions);
  });

  it("overwrites an earlier disconnect timestamp with a later one", () => {
    const sessions: SessionMap = { s1: { player: "A", disconnectedAt: 1000 } };
    const result = markDisconnected(sessions, "s1", 2000);
    expect(result).toEqual({ s1: { player: "A", disconnectedAt: 2000 } });
  });
});

describe("reapExpiredSessions", () => {
  it("keeps a session whose grace period has not yet elapsed", () => {
    const sessions: SessionMap = { s1: { player: "A", disconnectedAt: 1000 } };
    expect(reapExpiredSessions(sessions, 1000 + 29_999, 30_000)).toEqual(sessions);
  });

  it("drops a session whose grace period has fully elapsed", () => {
    const sessions: SessionMap = { s1: { player: "A", disconnectedAt: 1000 } };
    expect(reapExpiredSessions(sessions, 1000 + 30_000, 30_000)).toEqual({});
  });

  it("never drops a currently-connected session (disconnectedAt: null), regardless of `now`", () => {
    const sessions: SessionMap = { s1: { player: "A", disconnectedAt: null } };
    expect(reapExpiredSessions(sessions, Number.MAX_SAFE_INTEGER, 30_000)).toEqual(sessions);
  });

  it("drops only the expired session, leaving the other one untouched", () => {
    const sessions: SessionMap = {
      s1: { player: "A", disconnectedAt: 1000 },
      s2: { player: "B", disconnectedAt: null },
    };
    expect(reapExpiredSessions(sessions, 1000 + 30_000, 30_000)).toEqual({ s2: { player: "B", disconnectedAt: null } });
  });

  it("drops both sessions when both have expired, leaving an empty map", () => {
    const sessions: SessionMap = {
      s1: { player: "A", disconnectedAt: 1000 },
      s2: { player: "B", disconnectedAt: 2000 },
    };
    expect(reapExpiredSessions(sessions, 3000 + 30_000, 30_000)).toEqual({});
  });
});

describe("normalizeSessions", () => {
  it("passes a current-shape SessionMap through unchanged", () => {
    const sessions: SessionMap = { s1: { player: "A", disconnectedAt: null } };
    expect(normalizeSessions(sessions)).toEqual(sessions);
  });

  it("upgrades a pre-Stage-8a bare-PlayerId entry to a connected SessionEntry", () => {
    expect(normalizeSessions({ s1: "A", s2: "B" })).toEqual({
      s1: { player: "A", disconnectedAt: null },
      s2: { player: "B", disconnectedAt: null },
    });
  });

  it("handles a mix of old- and new-shape entries in the same map", () => {
    expect(normalizeSessions({ s1: "A", s2: { player: "B", disconnectedAt: 1234 } })).toEqual({
      s1: { player: "A", disconnectedAt: null },
      s2: { player: "B", disconnectedAt: 1234 },
    });
  });

  it("treats missing, null or non-object input as no sessions at all", () => {
    expect(normalizeSessions(undefined)).toEqual({});
    expect(normalizeSessions(null)).toEqual({});
    expect(normalizeSessions("garbage")).toEqual({});
  });
});
