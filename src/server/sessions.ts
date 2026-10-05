import type { PlayerId } from "../game/types.ts";

export type SessionMap = Partial<Record<string, PlayerId>>;

export type JoinResult =
  | { kind: "joined"; player: PlayerId; sessions: SessionMap; justCompletedPair: boolean }
  | { kind: "full" };

// Pure assignment logic, no I/O: the first two distinct session ids become
// Player A and Player B, in whichever order they arrive. A session id
// already assigned gets its existing slot back (a reload or reconnect). Any
// third (or later) distinct session id is rejected outright — no
// spectating, per explicit instruction.
export function joinSession(sessions: SessionMap, sessionId: string): JoinResult {
  const existing = sessions[sessionId];
  if (existing) {
    return { kind: "joined", player: existing, sessions, justCompletedPair: false };
  }

  if (Object.keys(sessions).length >= 2) {
    return { kind: "full" };
  }

  const taken = new Set(Object.values(sessions));
  const player: PlayerId = taken.has("A") ? "B" : "A";
  const next: SessionMap = { ...sessions, [sessionId]: player };
  return { kind: "joined", player, sessions: next, justCompletedPair: Object.keys(next).length === 2 };
}
