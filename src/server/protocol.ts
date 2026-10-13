import type { GameState, PlayerId } from "../game/types.ts";

export type ServerMessage =
  | { type: "assigned"; player: PlayerId }
  | { type: "waiting" }
  // Stage 3: distinct from "waiting" on purpose, per the project owner's own
  // instruction not to reuse that message — "waiting" means this session
  // already holds a seat and is waiting for an opponent; "queued" means it
  // holds no seat yet at all, just a place in line. Replaces "full": a third
  // visitor is no longer rejected outright, so that message is now
  // unreachable and has been removed rather than left as dead protocol.
  | { type: "queued" }
  | { type: "state"; state: GameState }
  | { type: "error"; message: string };

export type ClientMessage =
  // Stage 3: the explicit "join matchmaking" action — a session takes no
  // seat and joins no queue merely by opening the WebSocket; it must send
  // this first, per the project owner's own instruction that the lobby
  // requires an active "join queue" click rather than auto-joining on
  // connect.
  | { type: "joinQueue" }
  | { type: "play"; handIndex: number; row: number; col: number }
  | { type: "draw" }
  | { type: "endTurn" }
  | { type: "confirmNewGame" }
  | { type: "requestQuit" }
  | { type: "rejectQuit" };
