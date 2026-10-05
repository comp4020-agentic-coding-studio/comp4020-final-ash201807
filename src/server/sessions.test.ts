import { describe, expect, it } from "vitest";
import { joinSession } from "./sessions.ts";

describe("joinSession", () => {
  it("assigns the first session Player A", () => {
    const result = joinSession({}, "s1");
    expect(result).toEqual({ kind: "joined", player: "A", sessions: { s1: "A" }, justCompletedPair: false });
  });

  it("assigns the second distinct session Player B and reports the pair as complete", () => {
    const afterFirst = joinSession({}, "s1");
    if (afterFirst.kind !== "joined") throw new Error("expected joined");

    const afterSecond = joinSession(afterFirst.sessions, "s2");
    expect(afterSecond).toEqual({
      kind: "joined",
      player: "B",
      sessions: { s1: "A", s2: "B" },
      justCompletedPair: true,
    });
  });

  it("returns an already-assigned session its existing slot without marking the pair as newly completed", () => {
    const sessions = { s1: "A" as const };
    const result = joinSession(sessions, "s1");
    expect(result).toEqual({ kind: "joined", player: "A", sessions, justCompletedPair: false });
  });

  it("rejects a third distinct session once both slots are taken", () => {
    const sessions = { s1: "A" as const, s2: "B" as const };
    const result = joinSession(sessions, "s3");
    expect(result).toEqual({ kind: "full" });
  });

  it("still returns an existing player's own slot even after a third session has been rejected", () => {
    const sessions = { s1: "A" as const, s2: "B" as const };
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
});
