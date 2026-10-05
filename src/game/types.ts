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

export type GameStatus = "active" | "finished";

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
  type: CardType;
  owner: PlayerId;
  cells: Array<[number, number]>;
}
