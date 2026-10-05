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
  // New Game confirmations (playtesting revision): only meaningful once
  // status is "finished" or "locked". Both must be true before a fresh game
  // replaces this one — one player confirming alone must not reset it.
  restartConfirmed: Record<PlayerId, boolean>;
}

// Revised rule (2nd playtesting pass): a line of 3 is a Combo if it matches
// on OWNER, on TYPE, or both — evaluated independently. There is no single
// "owner" to report when only type matches (the 3 cells belong to different
// players), so `ownerMatch` is a flag, not an identity. Whoever completed
// this line (always the current Play's acting player — see engine.ts) deals
// the damage and gets any effect either way; nothing here needs to record
// that separately.
export interface Combo {
  cells: Array<[number, number]>;
  // All 3 cells share an owner. Combined with sameType below: both ->
  // 15 damage (counted once, not 20); owner only -> 15 damage, no effect;
  // neither -> this line isn't a Combo at all and was never pushed.
  ownerMatch: boolean;
  // Set when all 3 cells also share a card type, regardless of ownerMatch —
  // this alone gates the special effect (Lightning/Water/Nature) and, when
  // ownerMatch is false, caps damage at 5 instead of 15.
  sameType: CardType | null;
}
