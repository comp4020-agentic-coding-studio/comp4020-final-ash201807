// Core rules engine for the two-player card/board game (Game Specification
// v1.0). Pure state-transition functions, no I/O, no transport, no storage —
// server/session/persistence code calls these and owns broadcasting and
// saving the result.
import { randomCard, pickFirstPlayer, type RandomSource } from "./rng.ts";
import type { Cell, Combo, GameState, PlacedCard, PlayerId } from "./types.ts";

const MAIN_BOARD_SIZE = 3;
const EXPANSION_BOARD_SIZE = 5;
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
// exactly once and a run of 4+ is found as its overlapping 3-windows — the
// reading confirmed for §8/§9. This never special-cases Main vs. Expansion:
// once expanded, the 5x5 grid is "一个连续棋盘" (§12), so a combo spanning
// both regions is just an ordinary line on a bigger board.
const DIRECTIONS: ReadonlyArray<[number, number]> = [
  [0, 1], // horizontal
  [1, 0], // vertical
  [1, 1], // diagonal, down-right
  [1, -1], // diagonal, down-left
];

const otherPlayer = (id: PlayerId): PlayerId => (id === "A" ? "B" : "A");

// Board size is a parameter here and in detectCombos on purpose: growing the
// board (3x3 -> 5x5, §12) is a board-management change, not a
// combo-detection rewrite — detectCombos never needed to change for it.
function emptyBoard(size: number): Cell[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, (): Cell => null));
}

// The Main Board is always the centered 3x3 region of whichever grid is
// currently active: offset 0 when the board itself is 3x3, offset 1 once
// it's the 5x5 Expansion grid.
function mainBoardOffset(size: number): number {
  return (size - MAIN_BOARD_SIZE) / 2;
}

function isMainBoardFull(board: Cell[][]): boolean {
  const offset = mainBoardOffset(board.length);
  for (let r = offset; r < offset + MAIN_BOARD_SIZE; r++) {
    for (let c = offset; c < offset + MAIN_BOARD_SIZE; c++) {
      if (board[r][c] === null) return false;
    }
  }
  return true;
}

// §12: "原来的 3x3 是 5x5 的中心区域" — the existing Main Board cells are
// copied in place at the center of a fresh 5x5 grid; everything else starts
// empty.
function expandBoard(board: Cell[][]): Cell[][] {
  const next = emptyBoard(EXPANSION_BOARD_SIZE);
  const offset = mainBoardOffset(EXPANSION_BOARD_SIZE);
  for (let r = 0; r < MAIN_BOARD_SIZE; r++) {
    for (let c = 0; c < MAIN_BOARD_SIZE; c++) {
      next[r + offset][c + offset] = board[r][c];
    }
  }
  return next;
}

// §12 Expansion Removal: once the Main Board stops being full, the
// Expansion disappears. Per explicit direction, whatever was still sitting
// in the outer ring is simply discarded here — it is not carried forward as
// hidden state for a possible future re-expansion, since the specification
// does not say it should be.
function shrinkBoard(board: Cell[][]): Cell[][] {
  const offset = mainBoardOffset(board.length);
  const next = emptyBoard(MAIN_BOARD_SIZE);
  for (let r = 0; r < MAIN_BOARD_SIZE; r++) {
    for (let c = 0; c < MAIN_BOARD_SIZE; c++) {
      next[r][c] = board[r + offset][c + offset];
    }
  }
  return next;
}

// A full 3x3 board always expands (see updateBoard), so this can only ever
// be true for an already-expanded 5x5 board — a full 3x3 never reaches here
// with Phase 7 having left it at size 3.
function isBoardFull(board: Cell[][]): boolean {
  return board.every((row) => row.every((cell) => cell !== null));
}

// §11 Phase 7. Runs after every Play that leaves the game active — including
// a Play that forms no combo at all, since the Main Board can become full
// (or, after a clear, stop being full) without one. §12: "如果 Combo 只清除
// 了 Expansion 的牌，而 Main Board 仍然满: Expansion 保持存在" — so this
// only reacts to the Main Board's own fullness, never the whole grid's.
function updateBoard(state: GameState): void {
  const size = state.board.length;
  const mainFull = isMainBoardFull(state.board);
  if (size === MAIN_BOARD_SIZE && mainFull) {
    state.board = expandBoard(state.board);
  } else if (size === EXPANSION_BOARD_SIZE && !mainFull) {
    state.board = shrinkBoard(state.board);
  }
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

        // Revised rule (post-playtesting): a Combo only requires the same
        // owner across 3 consecutive cells in one of the directions above —
        // card type no longer gates whether a Combo exists at all, only
        // whether it also carries a same-type bonus effect (sameType below).
        if (a.owner === b.owner && b.owner === c.owner) {
          const sameType = a.type === b.type && b.type === c.type ? a.type : null;
          combos.push({ owner: a.owner, cells, sameType });
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
//
// Phase 7 (updateBoard) must run even when this Play formed no combo at all
// — the spec frames phases 1-7 as running "每次 Play 后" (after every Play),
// and the Main Board can become full, or stop being full, without a combo
// (e.g. the Play that fills its very last empty cell). Only phases 2-6
// (damage, win check, effects, clearing) are conditional on combos existing;
// a lethal Play (phase 4) still skips 5-7 entirely, combo count aside.
function applyCombos(state: GameState, actingPlayer: PlayerId, random: RandomSource): Combo[] {
  const combos = detectCombos(state.board); // Phase 1

  if (combos.length > 0) {
    const opponent = otherPlayer(actingPlayer);

    // Phase 2 + 3: every combo deals a flat 15 (the attack values in §4 are
    // all 5, times 3 cards), all combos from this Play summed and applied at
    // once.
    const damage = combos.length * COMBO_DAMAGE;
    state.players[opponent].hp -= damage;

    // Phase 4: a lethal HP ends the game immediately — Phases 5-7 (effects,
    // clearing, board/expansion update) do not run on the finishing Play.
    if (state.players[opponent].hp <= 0) {
      state.status = "finished";
      state.winner = actingPlayer;
      return combos;
    }

    // Phase 5: effects, one application per combo that also carries a
    // same-type bonus (a mixed-type combo deals its damage but triggers
    // nothing here) — confirmed stacking, so two simultaneous same-type
    // Lightning combos is two stacked -1 AP hits, two simultaneous same-type
    // Nature combos is +2 AP this same turn, etc.
    for (const combo of combos) {
      if (combo.sameType === "lightning") {
        state.pendingLightning[opponent] += 1;
      } else if (combo.sameType === "water") {
        for (let i = 0; i < WATER_DRAW_COUNT; i++) {
          state.players[actingPlayer].hand.push(randomCard(random));
        }
      } else if (combo.sameType === "nature") {
        state.ap += NATURE_AP_BONUS;
      }
    }

    // Phase 6: clear every cell that took part in any combo this Play (the
    // union, so a shared card is cleared once, not twice).
    for (const [r, c] of unionCells(combos)) {
      state.board[r][c] = null;
    }
  }

  updateBoard(state); // Phase 7

  // Board Locked (playtesting revision): the board can fill up — with or
  // without a combo on the filling Play — leaving no further Play possible.
  // Confirmed: no winner is recorded for this, unlike a lethal finish.
  if (state.status === "active" && isBoardFull(state.board)) {
    state.status = "locked";
  }

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
    board: emptyBoard(MAIN_BOARD_SIZE),
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
