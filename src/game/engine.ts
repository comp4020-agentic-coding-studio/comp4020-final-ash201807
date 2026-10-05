// Core rules engine for the two-player card/board game (Game Specification
// v1.0). Pure state-transition functions, no I/O, no transport, no storage —
// server/session/persistence code calls these and owns broadcasting and
// saving the result.
import { randomCard, pickFirstPlayer, type RandomSource } from "./rng.ts";
import type { Cell, Combo, GameState, PlacedCard, PlayerId } from "./types.ts";

const BOARD_SIZE = 3;
const STARTING_HP = 100;
const STARTING_HAND_SIZE = 3;
const NORMAL_TURN_AP = 2;
const FIRST_TURN_AP = 1;
const PLAY_COST = 1;
const DRAW_COST = 1;
const COMBO_DAMAGE = 15;
const WATER_DRAW_COUNT = 2;
const NATURE_AP_BONUS = 1;

// Each line direction scanned once from every cell, so a run of 3 is found
// exactly once and a run of 4+ (possible once the 5x5 Expansion lands) is
// found as its overlapping 3-windows — the reading confirmed for §8/§9.
const DIRECTIONS: ReadonlyArray<[number, number]> = [
  [0, 1], // horizontal
  [1, 0], // vertical
  [1, 1], // diagonal, down-right
  [1, -1], // diagonal, down-left
];

const otherPlayer = (id: PlayerId): PlayerId => (id === "A" ? "B" : "A");

// Board size is a parameter here and in detectCombos on purpose: the
// Expansion (3x3 -> 5x5, spec §12) is out of scope for this stage, but the
// detection algorithm already works on any square grid, so growing the board
// later is a board-management change, not a combo-detection rewrite.
function emptyBoard(size: number): Cell[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, (): Cell => null));
}

function beginTurn(state: GameState): void {
  const player = state.players[state.currentPlayer];
  let ap: number;
  if (!player.firstTurnTaken) {
    // §2 First Player: first player's first turn is 1 AP, the other
    // player's first turn is the normal 2 AP.
    ap = state.currentPlayer === state.firstPlayer ? FIRST_TURN_AP : NORMAL_TURN_AP;
  } else {
    // §2 Normal Turn + Lightning (§5, as clarified): stacked Lightning hits
    // reduce this turn's starting AP, floored at 0, and are consumed here —
    // they only ever affect the one turn immediately after they land.
    ap = Math.max(0, NORMAL_TURN_AP - state.pendingLightning[state.currentPlayer]);
  }
  state.pendingLightning[state.currentPlayer] = 0;
  player.firstTurnTaken = true;
  state.ap = ap;
}

function advanceTurn(state: GameState): void {
  state.currentPlayer = otherPlayer(state.currentPlayer);
  beginTurn(state);
}

// A turn that starts at 0 AP (two stacked Lightning hits) has no possible
// action, so it ends immediately and the turn after it is normal again — as
// clarified, this never leaves the game sitting in a dead 0-AP turn.
function settleZeroApTurns(state: GameState): void {
  let guard = 0;
  while (state.status === "active" && state.ap === 0 && guard < 100) {
    advanceTurn(state);
    guard++;
  }
}

export function detectCombos(board: Cell[][]): Combo[] {
  const size = board.length;
  const combos: Combo[] = [];

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      for (const [dRow, dCol] of DIRECTIONS) {
        const cells: Array<[number, number]> = [
          [row, col],
          [row + dRow, col + dCol],
          [row + 2 * dRow, col + 2 * dCol],
        ];
        if (cells.some(([r, c]) => r < 0 || r >= size || c < 0 || c >= size)) continue;

        const values = cells.map(([r, c]) => board[r][c]);
        if (values.some((v) => v === null)) continue;
        const [a, b, c] = values as PlacedCard[];

        // §8 Combo Definition: same player, same card type, 3 consecutive
        // cells in one of the directions above.
        if (a.owner === b.owner && b.owner === c.owner && a.type === b.type && b.type === c.type) {
          combos.push({ type: a.type, owner: a.owner, cells });
        }
      }
    }
  }

  return combos;
}

function unionCells(combos: Combo[]): Array<[number, number]> {
  const seen = new Set<string>();
  const cells: Array<[number, number]> = [];
  for (const combo of combos) {
    for (const [r, c] of combo.cells) {
      const key = `${r},${c}`;
      if (!seen.has(key)) {
        seen.add(key);
        cells.push([r, c]);
      }
    }
  }
  return cells;
}

// §11 Combo Resolution, phases 1-7. Detect is detectCombos() above; this
// function runs Calculate through Update Board for one Play.
function applyCombos(state: GameState, actingPlayer: PlayerId, random: RandomSource): Combo[] {
  const combos = detectCombos(state.board); // Phase 1
  if (combos.length === 0) return combos;

  const opponent = otherPlayer(actingPlayer);

  // Phase 2 + 3: every combo deals a flat 15 (the attack values in §4 are all
  // 5, times 3 cards), all combos from this Play summed and applied at once.
  const damage = combos.length * COMBO_DAMAGE;
  state.players[opponent].hp -= damage;

  // Phase 4: a lethal HP ends the game immediately — Phases 5-7 (effects,
  // clearing, board/expansion update) do not run on the finishing Play.
  if (state.players[opponent].hp <= 0) {
    state.status = "finished";
    state.winner = actingPlayer;
    return combos;
  }

  // Phase 5: effects, one application per combo — confirmed stacking, so two
  // simultaneous Lightning combos is two stacked -1 AP hits, two simultaneous
  // Nature combos is +2 AP this same turn, etc.
  for (const combo of combos) {
    if (combo.type === "lightning") {
      state.pendingLightning[opponent] += 1;
    } else if (combo.type === "water") {
      for (let i = 0; i < WATER_DRAW_COUNT; i++) {
        state.players[actingPlayer].hand.push(randomCard(random));
      }
    } else if (combo.type === "nature") {
      state.ap += NATURE_AP_BONUS;
    }
  }

  // Phase 6: clear every cell that took part in any combo this Play (the
  // union, so a shared card is cleared once, not twice).
  for (const [r, c] of unionCells(combos)) {
    state.board[r][c] = null;
  }

  // Phase 7 (Expansion appear/disappear) is out of scope for this stage —
  // detectCombos and the board are already size-agnostic, so this is where
  // that check slots in later without reshaping the engine.

  return combos;
}

export function createInitialState(random: RandomSource = Math.random): GameState {
  const firstPlayer = pickFirstPlayer(random);
  const makeHand = () => Array.from({ length: STARTING_HAND_SIZE }, () => randomCard(random));

  const state: GameState = {
    status: "active",
    players: {
      A: { id: "A", hp: STARTING_HP, hand: makeHand(), firstTurnTaken: false },
      B: { id: "B", hp: STARTING_HP, hand: makeHand(), firstTurnTaken: false },
    },
    board: emptyBoard(BOARD_SIZE),
    currentPlayer: firstPlayer,
    firstPlayer,
    ap: 0,
    pendingLightning: { A: 0, B: 0 },
    winner: null,
  };

  beginTurn(state);
  settleZeroApTurns(state);
  return state;
}

export function playCard(
  state: GameState,
  playerId: PlayerId,
  handIndex: number,
  row: number,
  col: number,
  random: RandomSource = Math.random,
): GameState {
  if (state.status !== "active") throw new Error("game is already finished");
  if (state.currentPlayer !== playerId) throw new Error("not this player's turn");
  if (state.ap < PLAY_COST) throw new Error("not enough AP to play");

  const hand = state.players[playerId].hand;
  if (handIndex < 0 || handIndex >= hand.length) throw new Error("invalid hand index");
  if (row < 0 || row >= state.board.length || col < 0 || col >= state.board.length) {
    throw new Error("cell is out of bounds");
  }
  if (state.board[row][col] !== null) throw new Error("cell is occupied");

  const [card] = hand.splice(handIndex, 1);
  state.board[row][col] = { owner: playerId, type: card };
  state.ap -= PLAY_COST;

  applyCombos(state, playerId, random);

  if (state.status === "active") settleZeroApTurns(state);
  return state;
}

export function drawCard(state: GameState, playerId: PlayerId, random: RandomSource = Math.random): GameState {
  if (state.status !== "active") throw new Error("game is already finished");
  if (state.currentPlayer !== playerId) throw new Error("not this player's turn");
  if (state.ap < DRAW_COST) throw new Error("not enough AP to draw");

  state.players[playerId].hand.push(randomCard(random));
  state.ap -= DRAW_COST;

  if (state.status === "active") settleZeroApTurns(state);
  return state;
}

export function endTurn(state: GameState, playerId: PlayerId): GameState {
  if (state.status !== "active") throw new Error("game is already finished");
  if (state.currentPlayer !== playerId) throw new Error("not this player's turn");

  // Unused AP never carries over (§2) — advanceTurn recomputes AP from
  // scratch for whoever goes next.
  advanceTurn(state);
  settleZeroApTurns(state);
  return state;
}
