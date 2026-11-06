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
// "abandoned" (Stage 8b): both players voluntarily agreed to end an active
// game early, via requestQuit — distinct from "locked" so a client can tell
// "the board filled up" apart from "we agreed to stop," even though both are
// equally winner-less terminal states as far as the engine is concerned.
export type GameStatus = "active" | "finished" | "locked" | "abandoned";

export interface GameState {
  status: GameStatus;
  players: Record<PlayerId, PlayerState>;
  board: Cell[][];
  currentPlayer: PlayerId;
  firstPlayer: PlayerId;
  ap: number;
  // Stage 2 (Turn Timer): incremented every time engine.ts's beginTurn()
  // runs — the first turn of a fresh game is turnNumber 1. Exists purely so
  // a caller (server.ts) can detect "did a new turn actually begin" by
  // comparing this value before/after an action, which `currentPlayer`
  // alone cannot: two stacked Lightning hits can skip an entire turn and
  // leave currentPlayer right back where it started (see engine.test.ts's
  // "stacks two Lightning combos into a 0-AP opponent turn that is skipped
  // entirely"), which is still two real turn transitions, not zero. Never
  // read by anything inside engine.ts itself beyond beginTurn's own
  // increment — a server-facing signal, not a rule.
  turnNumber: number;
  // Lightning hits stacked against each player, to be applied to (and
  // consumed by) that player's own next turn only.
  pendingLightning: Record<PlayerId, number>;
  winner: PlayerId | null;
  // New Game confirmations (playtesting revision): only meaningful once
  // status is "finished" or "locked". Both must be true before a fresh game
  // replaces this one — one player confirming alone must not reset it.
  restartConfirmed: Record<PlayerId, boolean>;
  // Voluntary termination (Stage 8b): only meaningful while status is
  // "active" — mirrors restartConfirmed's "both must agree" shape, but for
  // ending a still-active game early rather than starting a new one after it
  // ended. Both true moves status straight to "abandoned". Either player
  // rejecting (see engine.ts's rejectQuit) clears both back to false rather
  // than leaving the other player's flag standing.
  quitRequested: Record<PlayerId, boolean>;
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

// Combat Events (Stage: Combat Events). The public-safe digest of what one
// Play's applyCombos() (engine.ts) computed — surfaced so a client can show
// *why* HP/hand/AP changed, not just the new numbers. Built once per Play
// that formed at least one Combo (see engine.ts's playCard, which returns
// CombatEvent | null); never produced for a Play that formed none. Every
// field here is already public board/damage information read off of
// placed cards already sent in full inside GameState.board — nothing here
// ever exposes either player's hidden hand.
export interface CombatEvent {
  actingPlayer: PlayerId;
  // The board's own size (3 or 5) at the moment these combos were detected
  // — i.e. BEFORE Phase 6's clear and Phase 7's possible expand/shrink in
  // this same Play (engine.ts's applyCombos: detectCombos runs first, the
  // board can resize afterward). A client wanting to highlight these exact
  // cells must check this against whatever board size it's about to render
  // next, not assume it matches — the one case this matters is a Play that
  // both completes a Combo AND causes the Main Board to shrink from 5x5
  // back to 3x3 in that same Play (confirmed reachable, see
  // engine.test.ts's "shrinks back to 3x3 when a combo clears a Main Board
  // cell"), where the combos[].cells coordinates are still in 5x5 terms
  // even though GameState.board sent alongside/after this event is already
  // back to 3x3.
  boardSize: number;
  combos: Array<{
    cells: Array<[number, number]>;
    ownerMatch: boolean;
    sameType: CardType | null;
    // This one combo's own base damage (15 Owner, 5 Type-only) — summed
    // across the array is the same total engine.ts's own damage formula
    // already applies to the opponent, just itemised per combo rather than
    // collapsed into one number.
    damage: number;
  }>;
  // Summed across every combo in this event that also carried a Fire effect
  // (engine.ts's own stacking rule: two simultaneous Fire combos is 2x10) —
  // 0 when no Fire effect fired at all.
  fireBonusDamage: number;
  // One entry per combo that triggered a same-type effect, in the same
  // order applyCombos() itself iterates them — two simultaneous Water
  // combos means two "water" entries here, matching the stacking behaviour
  // engine.test.ts already covers for Lightning/Nature/Fire.
  effectsApplied: CardType[];
}
