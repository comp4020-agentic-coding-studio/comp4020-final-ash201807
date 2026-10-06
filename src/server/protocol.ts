import type { GameState, PlayerId } from "../game/types.ts";

export type ServerMessage =
  | { type: "assigned"; player: PlayerId }
  | { type: "waiting" }
  | { type: "state"; state: GameState }
  | { type: "full" }
  | { type: "error"; message: string };

export type ClientMessage =
  | { type: "play"; handIndex: number; row: number; col: number }
  | { type: "draw" }
  | { type: "endTurn" }
  | { type: "confirmNewGame" }
  | { type: "requestQuit" }
  | { type: "rejectQuit" };
