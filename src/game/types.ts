export type PlayerId = "A" | "B";
export type CardType = "fire" | "lightning" | "water" | "nature";

export interface PlacedCard {
  owner: PlayerId;
  type: CardType;
}

export type Cell = PlacedCard | null;

export interface PlayerState {
  id: PlayerId;
  hp: number;
  hand: CardType[];
  // Normal turns give 2 AP; a player's very first turn is the one exception
  // (1 AP for whoever goes first, 2 for the other) — this flag is what tells
  // beginTurn() whether that exception still applies.
  firstTurnTaken: boolean;
}

// "locked": the board (always 5x5 when this happens — a full 3x3 always
// expands instead, see updateBoard) has no empty cell left, so no further
// Play is possible, but neither player reached 0 HP. No winner is recorded
// (confirmed): this is a draw-like terminal state, not a win.
export type GameStatus = "active" | "finished" | "locked";

export interface GameState {
  status: GameStatus;
  players: Record<PlayerId, PlayerState>;
  board: Cell[][];
  currentPlayer: PlayerId;
  firstPlayer: PlayerId;
  ap: number;
  // Lightning hits stacked against each player, to be applied to (and
  // consumed by) that player's own next turn only.
  pendingLightning: Record<PlayerId, number>;
  winner: PlayerId | null;
}

export interface Combo {
  owner: PlayerId;
  cells: Array<[number, number]>;
  // Set only when all 3 cells also share a card type — that's what gates a
  // combo's special effect (Lightning/Water/Nature). A combo always forms
  // and deals damage on owner alone; a mixed-type combo has `sameType: null`
  // and no effect.
  sameType: CardType | null;
}
