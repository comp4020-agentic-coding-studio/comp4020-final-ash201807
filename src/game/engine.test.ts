import { describe, expect, it } from "vitest";
import { confirmNewGame, createInitialState, detectCombos, drawCard, endTurn, playCard } from "./engine.ts";
import type { RandomSource } from "./rng.ts";
import type { CardType, Cell, GameState, PlayerId } from "./types.ts";

function queueRandom(values: number[]): RandomSource {
  let i = 0;
  return () => {
    const v = values[i] ?? values.at(-1) ?? 0;
    i++;
    return v;
  };
}

function emptyBoard(size = 3): Cell[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, (): Cell => null));
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    status: "active",
    players: {
      A: { id: "A", hp: 100, hand: ["fire", "fire", "fire"], firstTurnTaken: true },
      B: { id: "B", hp: 100, hand: ["fire", "fire", "fire"], firstTurnTaken: true },
    },
    board: emptyBoard(),
    currentPlayer: "A",
    firstPlayer: "A",
    ap: 2,
    pendingLightning: { A: 0, B: 0 },
    winner: null,
    restartConfirmed: { A: false, B: false },
    ...overrides,
  };
}

function place(state: GameState, owner: PlayerId, type: CardType, row: number, col: number): void {
  state.board[row][col] = { owner, type };
}

describe("createInitialState", () => {
  it("gives each player 3 cards and full HP", () => {
    const state = createInitialState(queueRandom([0.1, 0, 0, 0, 0, 0, 0]));
    expect(state.players.A.hand).toHaveLength(3);
    expect(state.players.B.hand).toHaveLength(3);
    expect(state.players.A.hp).toBe(100);
    expect(state.players.B.hp).toBe(100);
    expect(state.status).toBe("active");
  });

  it("gives the random first player 1 AP, and the other player gets a normal 2 AP first turn", () => {
    const a = createInitialState(queueRandom([0.1, 0, 0, 0, 0, 0, 0]));
    expect(a.firstPlayer).toBe("A");
    expect(a.currentPlayer).toBe("A");
    expect(a.ap).toBe(1);

    endTurn(a, "A");
    expect(a.currentPlayer).toBe("B");
    expect(a.ap).toBe(2);

    const b = createInitialState(queueRandom([0.9, 0, 0, 0, 0, 0, 0]));
    expect(b.firstPlayer).toBe("B");
    expect(b.ap).toBe(1);
  });
});

describe("turn and AP rules", () => {
  it("costs 1 AP to Play and 1 AP to Draw, auto-ending the turn at 0 AP", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    state.players.A.hand = ["fire"];

    playCard(state, "A", 0, 0, 0);
    expect(state.ap).toBe(1);
    expect(state.currentPlayer).toBe("A");

    drawCard(state, "A");
    expect(state.currentPlayer).toBe("B");
    expect(state.ap).toBe(2);
  });

  it("lets a player End Turn early, discarding unused AP", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    endTurn(state, "A");
    expect(state.currentPlayer).toBe("B");
    expect(state.ap).toBe(2);
  });

  it("rejects actions out of turn or without enough AP", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    expect(() => drawCard(state, "B")).toThrow(/turn/);

    const noAp = makeState({ ap: 0, currentPlayer: "A" });
    expect(() => drawCard(noAp, "A")).toThrow(/AP/);
  });

  it("rejects playing onto an occupied cell", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    place(state, "B", "water", 0, 0);
    expect(() => playCard(state, "A", 0, 0, 0)).toThrow(/occupied/);
  });
});

describe("combo detection", () => {
  it("finds a horizontal combo but not a same-type combo split across two owners", () => {
    const board = emptyBoard();
    board[0][0] = { owner: "A", type: "fire" };
    board[0][1] = { owner: "A", type: "fire" };
    board[0][2] = { owner: "A", type: "fire" };
    expect(detectCombos(board)).toHaveLength(1);

    // Game Specification v1.0 section 8: "Fire-A Fire-A Fire-A" is valid,
    // but "Fire-A Fire-B Fire-A" is not: same type alone is not enough, all
    // three cells must share an owner.
    board[0][1] = { owner: "B", type: "fire" };
    expect(detectCombos(board)).toHaveLength(0);
  });

  it("finds vertical and both diagonal combos", () => {
    const vertical = emptyBoard();
    vertical[0][1] = { owner: "A", type: "water" };
    vertical[1][1] = { owner: "A", type: "water" };
    vertical[2][1] = { owner: "A", type: "water" };
    expect(detectCombos(vertical)).toHaveLength(1);

    const diagDown = emptyBoard();
    diagDown[0][0] = { owner: "B", type: "nature" };
    diagDown[1][1] = { owner: "B", type: "nature" };
    diagDown[2][2] = { owner: "B", type: "nature" };
    expect(detectCombos(diagDown)).toHaveLength(1);

    const diagUp = emptyBoard();
    diagUp[0][2] = { owner: "B", type: "lightning" };
    diagUp[1][1] = { owner: "B", type: "lightning" };
    diagUp[2][0] = { owner: "B", type: "lightning" };
    expect(detectCombos(diagUp)).toHaveLength(1);
  });

  it("counts a shared-card cross shape as two independent combos (section 9)", () => {
    const board = emptyBoard();
    board[0][0] = { owner: "A", type: "fire" };
    board[0][1] = { owner: "A", type: "fire" };
    board[0][2] = { owner: "A", type: "fire" };
    board[1][1] = { owner: "A", type: "fire" };
    board[2][1] = { owner: "A", type: "fire" };

    expect(detectCombos(board)).toHaveLength(2);
  });

  it("resolves a 4-in-a-row as two overlapping combos", () => {
    const board = emptyBoard(4);
    board[0][0] = { owner: "A", type: "fire" };
    board[0][1] = { owner: "A", type: "fire" };
    board[0][2] = { owner: "A", type: "fire" };
    board[0][3] = { owner: "A", type: "fire" };

    expect(detectCombos(board)).toHaveLength(2);
  });

  it("forms a combo for 3 different card types sharing the same owner (revised rule)", () => {
    const board = emptyBoard();
    board[0][0] = { owner: "A", type: "fire" };
    board[0][1] = { owner: "A", type: "lightning" };
    board[0][2] = { owner: "A", type: "water" };

    const combos = detectCombos(board);
    expect(combos).toHaveLength(1);
    expect(combos[0].sameType).toBeNull(); // mixed type: no same-type bonus
  });
});

describe("combo resolution (section 11 phases)", () => {
  it("applies 15 damage to the opponent for a single combo", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    place(state, "A", "fire", 0, 0);
    place(state, "A", "fire", 0, 1);
    state.players.A.hand = ["fire"];

    playCard(state, "A", 0, 0, 2);

    expect(state.players.B.hp).toBe(85);
    expect(state.players.A.hp).toBe(100);
  });

  it("deals damage for a mixed-type combo but triggers no special effect", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    place(state, "A", "lightning", 0, 0);
    place(state, "A", "water", 0, 1);
    state.players.A.hand = ["nature"]; // the completing card is a 3rd type too

    const apBefore = state.ap;
    playCard(state, "A", 0, 0, 2);

    // Damage is unconditional on type-matching: still a flat 15.
    expect(state.players.B.hp).toBe(85);
    // None of the three types' bonus effects fired: no Lightning penalty
    // queued, no extra cards drawn (Water), no AP bonus (Nature) beyond the
    // normal 1-point Play cost already deducted.
    expect(state.pendingLightning.B).toBe(0);
    expect(state.players.A.hand).toHaveLength(0);
    expect(state.ap).toBe(apBefore - 1);
  });

  it("sums damage from multiple simultaneous combos before applying it", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    place(state, "A", "fire", 0, 0);
    place(state, "A", "fire", 0, 1);
    place(state, "A", "fire", 1, 1);
    place(state, "A", "fire", 2, 1);
    state.players.A.hand = ["fire"];

    playCard(state, "A", 0, 0, 2);

    expect(state.players.B.hp).toBe(70);
  });

  it("clears every cell that took part in a combo, including the shared one", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    place(state, "A", "fire", 0, 0);
    place(state, "A", "fire", 0, 1);
    place(state, "A", "fire", 1, 1);
    place(state, "A", "fire", 2, 1);
    state.players.A.hand = ["fire"];

    playCard(state, "A", 0, 0, 2);

    for (const [r, c] of [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 1],
      [2, 1],
    ]) {
      expect(state.board[r][c]).toBeNull();
    }
  });

  it("one Lightning combo gives the opponent exactly 1 AP on their next turn", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    place(state, "A", "lightning", 0, 0);
    place(state, "A", "lightning", 0, 1);
    state.players.A.hand = ["lightning"];

    playCard(state, "A", 0, 0, 2);
    expect(state.pendingLightning.B).toBe(1);
    expect(state.ap).toBe(1);

    endTurn(state, "A");

    expect(state.currentPlayer).toBe("B");
    expect(state.ap).toBe(1);
  });

  it("stacks two Lightning combos into a 0-AP opponent turn that is skipped entirely", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    place(state, "A", "lightning", 0, 0);
    place(state, "A", "lightning", 0, 1);
    place(state, "A", "lightning", 1, 1);
    place(state, "A", "lightning", 2, 1);
    state.players.A.hand = ["lightning"];

    playCard(state, "A", 0, 0, 2);
    expect(state.ap).toBe(1);

    endTurn(state, "A");

    expect(state.currentPlayer).toBe("A");
    expect(state.ap).toBe(2);
    expect(state.pendingLightning.B).toBe(0);
  });

  it("stacks two Nature combos into +2 AP usable immediately in the same turn", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    place(state, "A", "nature", 0, 0);
    place(state, "A", "nature", 0, 1);
    place(state, "A", "nature", 1, 1);
    place(state, "A", "nature", 2, 1);
    state.players.A.hand = ["nature"];

    playCard(state, "A", 0, 0, 2);
    expect(state.ap).toBe(3);
    expect(state.currentPlayer).toBe("A");

    drawCard(state, "A");
    drawCard(state, "A");
    expect(state.ap).toBe(1);
  });

  it("draws 2 cards per Water combo", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    place(state, "A", "water", 0, 0);
    place(state, "A", "water", 0, 1);
    state.players.A.hand = ["water"];

    playCard(state, "A", 0, 0, 2);

    expect(state.players.A.hand).toHaveLength(2);
  });

  it("ends the game immediately on lethal HP and skips effects, clear, and update (section 11 phase 4)", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    state.players.B.hp = 20;
    place(state, "A", "fire", 0, 0);
    place(state, "A", "fire", 0, 1);
    state.players.A.hand = ["fire"];

    playCard(state, "A", 0, 0, 2);
    expect(state.status).toBe("active");
    expect(state.players.B.hp).toBe(5);

    place(state, "A", "fire", 1, 0);
    place(state, "A", "fire", 1, 1);
    state.players.A.hand = ["fire"];

    playCard(state, "A", 0, 1, 2);
    expect(state.status).toBe("finished");
    expect(state.winner).toBe("A");
    expect(state.board[1][0]).not.toBeNull();
    expect(state.board[1][1]).not.toBeNull();
  });

  it("skips the Lightning effect itself when the combo is lethal (section 11 phase 4 before phase 5)", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    state.players.B.hp = 15; // exactly lethal from one Lightning combo
    place(state, "A", "lightning", 0, 0);
    place(state, "A", "lightning", 0, 1);
    state.players.A.hand = ["lightning"];

    playCard(state, "A", 0, 0, 2);

    expect(state.status).toBe("finished");
    expect(state.winner).toBe("A");
    expect(state.players.B.hp).toBeLessThanOrEqual(0);
    // The Lightning effect (Phase 5) never ran: pendingLightning is untouched.
    expect(state.pendingLightning.B).toBe(0);
    // Phase 6 (clear) never ran either: the combo's cells are still there.
    expect(state.board[0][0]).not.toBeNull();
    expect(state.board[0][1]).not.toBeNull();
    expect(state.board[0][2]).not.toBeNull();
  });

  it("rejects further actions once the game has finished", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    state.players.B.hp = 10;
    place(state, "A", "fire", 0, 0);
    place(state, "A", "fire", 0, 1);
    state.players.A.hand = ["fire"];

    playCard(state, "A", 0, 0, 2);
    expect(state.status).toBe("finished");
    expect(() => drawCard(state, "A")).toThrow(/finished/);
  });
});

// A verified "no accidental combo" owner layout for a fully-occupied 3x3
// region — a classic filled tic-tac-toe draw board: no 3 consecutive cells,
// in any row, column or diagonal, share an owner. Confirmed by inspection of
// all 8 lines. Under the revised Combo rule (owner alone, §6a) this is what
// "full but combo-free" now requires — a single owner can no longer fill a
// region without every line in it becoming a Combo, so these fixtures must
// vary owner, not card type (which is why card type below is uniformly
// "fire" throughout: it no longer affects whether a Combo exists at all).
const SAFE_MAIN_OWNERS: readonly PlayerId[][] = [
  ["A", "B", "A"],
  ["A", "B", "B"],
  ["B", "A", "A"],
];

// Places the verified-safe pattern at the given offset (0 for a plain 3x3
// board, 1 for the Main Board once the grid is 5x5), skipping any cells
// listed in `skip` so a test can fill the rest via playCard instead.
function placeSafeMain(state: GameState, rowOffset: number, colOffset: number, skip: Array<[number, number]> = []): void {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (skip.some(([sr, sc]) => sr === r && sc === c)) continue;
      place(state, SAFE_MAIN_OWNERS[r][c], "fire", r + rowOffset, c + colOffset);
    }
  }
}

describe("Expansion (section 12)", () => {
  it("keeps the board at 3x3 while the Main Board is not yet full", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    // 7 of 9 cells filled via the safe pattern, no combo among them; (2,1)
    // and (2,2) are left empty.
    placeSafeMain(state, 0, 0, [
      [2, 1],
      [2, 2],
    ]);
    state.players.A.hand = ["fire"];

    playCard(state, "A", 0, 2, 1); // fills the 8th cell (2,1); (2,2) stays empty

    expect(state.board.length).toBe(3);
  });

  it("expands to a 5x5 board the moment the Main Board becomes full, even with no combo on that Play", () => {
    const state = makeState({ ap: 2, currentPlayer: "A" });
    placeSafeMain(state, 0, 0, [[2, 2]]); // 8 of 9, safe-pattern verified combo-free
    state.players.A.hand = ["fire"];

    playCard(state, "A", 0, 2, 2); // fills (2,2) per the pattern (owner A), completing the Main Board

    // A full 3x3 always expands rather than locking (Board Locked only ever
    // applies to an already-expanded 5x5 — see the "Board Locked" suite).
    expect(state.status).toBe("active");
    expect(state.board.length).toBe(5);
    // §12: "原来的 3x3 是 5x5 的中心区域" — the prior contents move to the
    // center untouched, offset by 1 in both directions.
    expect(state.board[1][1]).toEqual({ owner: "A", type: "fire" });
    expect(state.board[3][3]).toEqual({ owner: "A", type: "fire" }); // the just-played (2,2)
    // The new outer ring is empty.
    expect(state.board[0][0]).toBeNull();
    expect(state.board[4][4]).toBeNull();
  });

  it("detects a combo entirely inside the Expansion ring", () => {
    const board = emptyBoard(5);
    // Row 0 is outside the Main Board (rows/cols 1-3) regardless of column.
    board[0][0] = { owner: "A", type: "water" };
    board[0][1] = { owner: "A", type: "water" };
    board[0][2] = { owner: "A", type: "water" };

    expect(detectCombos(board)).toHaveLength(1);
  });

  it("detects a combo that spans the Main Board and the Expansion ring", () => {
    const board = emptyBoard(5);
    // Row 1 is a Main Board row; column 0 on that row is still Expansion.
    board[1][0] = { owner: "A", type: "nature" }; // Expansion
    board[1][1] = { owner: "A", type: "nature" }; // Main Board
    board[1][2] = { owner: "A", type: "nature" }; // Main Board

    expect(detectCombos(board)).toHaveLength(1);
  });

  it("keeps the Expansion when a combo clears only Expansion cells and the Main Board stays full", () => {
    const state = makeState({ ap: 2, currentPlayer: "A", board: emptyBoard(5) });
    // Main Board (rows/cols 1-3), safe pattern, fully occupied and untouched
    // by this Play — the triggering combo lives entirely in row 4, which has
    // no Main Board cells at all, so it can't also disturb the Main Board's
    // fullness (confirmed: no column or diagonal through row 4 reaches a
    // same-owner pair in the Main pattern above it).
    placeSafeMain(state, 1, 1);
    place(state, "A", "water", 4, 0);
    place(state, "A", "water", 4, 1);
    state.players.A.hand = ["water"];

    playCard(state, "A", 0, 4, 2); // completes the row-4 Water combo

    expect(state.board.length).toBe(5); // still expanded
    expect(state.board[4][0]).toBeNull(); // the Expansion combo cleared
    expect(state.board[1][1]).not.toBeNull(); // Main Board untouched
  });

  it("shrinks back to 3x3 when a combo clears a Main Board cell, discarding the rest of the Expansion ring", () => {
    const state = makeState({ ap: 2, currentPlayer: "A", board: emptyBoard(5) });
    // Main Board (rows/cols 1-3), safe pattern, fully occupied. The pattern's
    // (1,1) and (2,1) are both owner A, so completing (0,1) — Expansion, same
    // owner — forms exactly one vertical Combo through those two Main cells
    // (card type is irrelevant to Combo formation now, so no other line is
    // at risk of forming incidentally).
    placeSafeMain(state, 1, 1);
    // An unrelated card sitting elsewhere in the ring — expected to simply
    // vanish once the board shrinks, per instruction: no hidden persistence.
    place(state, "A", "lightning", 4, 4);
    state.players.A.hand = ["fire"];

    playCard(state, "A", 0, 0, 1); // (0,1): Expansion, completes the vertical Combo

    expect(state.board.length).toBe(3); // Main Board no longer full -> shrunk
    // The cleared Main cells (old (1,1), (2,1)) map to new (0,0) and (1,0).
    expect(state.board[0][0]).toBeNull();
    expect(state.board[1][0]).toBeNull();
    // The untouched Main cells survive, shifted back by the same offset.
    expect(state.board[0][1]).toEqual({ owner: "B", type: "fire" }); // old (1,2)
    expect(state.board[2][0]).toEqual({ owner: "B", type: "fire" }); // old (3,1)
    // Only a 3x3 grid exists now — the old (4,4) card has no cell to live in.
    expect(state.board.every((row) => row.length === 3)).toBe(true);
  });
});

describe("Board Locked", () => {
  // Verified by script (no hand-checking of a 25-cell grid): every row,
  // column and both diagonals avoid 3 consecutive same-owner cells anywhere
  // on this 5x5 grid, including once the last cell (4,4) is filled.
  const SAFE_5X5_OWNERS: readonly PlayerId[][] = [
    ["A", "A", "B", "B", "A"],
    ["B", "B", "A", "A", "B"],
    ["A", "A", "B", "B", "A"],
    ["B", "B", "A", "A", "B"],
    ["A", "A", "B", "B", "A"],
  ];

  it("locks when a Play fills the last cell of a full 5x5 board, forming no combo, with no winner", () => {
    const state = makeState({ ap: 2, currentPlayer: "A", board: emptyBoard(5) });
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        if (r === 4 && c === 4) continue; // left empty for the triggering Play
        place(state, SAFE_5X5_OWNERS[r][c], "fire", r, c);
      }
    }
    state.players.A.hand = ["fire"];

    playCard(state, "A", 0, 4, 4); // (4,4) is owner A in the pattern

    expect(state.status).toBe("locked");
    expect(state.winner).toBeNull();
    expect(state.board.every((row) => row.every((cell) => cell !== null))).toBe(true);
  });

  it("finishes (not locks) when the Play that fills the board is also lethal", () => {
    const state = makeState({ ap: 2, currentPlayer: "A", board: emptyBoard(5) });
    state.players.B.hp = 1; // any combo at all is lethal
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        if (r === 4 && c === 4) continue;
        place(state, "A", "fire", r, c); // single owner: plenty of combos once completed
      }
    }
    state.players.A.hand = ["fire"];

    playCard(state, "A", 0, 4, 4);

    expect(state.status).toBe("finished");
    expect(state.winner).toBe("A");
    // Phase 4 (lethal) returns before Phase 7 ever runs, so the board is
    // still fully occupied — it was never evaluated for locking, and
    // clearing (Phase 6) never ran either.
    expect(state.board.every((row) => row.every((cell) => cell !== null))).toBe(true);
  });

  it("rejects Play, Draw and End Turn once the board is locked", () => {
    const state = makeState({ ap: 2, currentPlayer: "A", board: emptyBoard(5) });
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        if (r === 4 && c === 4) continue;
        place(state, SAFE_5X5_OWNERS[r][c], "fire", r, c);
      }
    }
    state.players.A.hand = ["fire"];
    playCard(state, "A", 0, 4, 4);
    expect(state.status).toBe("locked");

    expect(() => drawCard(state, "B")).toThrow();
    expect(() => endTurn(state, "B")).toThrow();
    state.players.B.hand = ["fire"];
    expect(() => playCard(state, "B", 0, 0, 0)).toThrow();
  });
});

describe("New Game / restart confirmation", () => {
  it("rejects confirmation while the game is still active", () => {
    const state = makeState({ status: "active" });
    expect(() => confirmNewGame(state, "A")).toThrow(/active/);
  });

  it("does not reset the game when only one player has confirmed", () => {
    const state = makeState({ status: "finished", winner: "A" });
    const result = confirmNewGame(state, "A");

    expect(result).toBe(state); // same object: one confirmation never resets
    expect(result.restartConfirmed).toEqual({ A: true, B: false });
    expect(result.status).toBe("finished");
    expect(result.winner).toBe("A");
  });

  it("creates a genuinely fresh game once both players have confirmed", () => {
    const state = makeState({ status: "locked", winner: null });
    // Give the old game some state that must NOT survive into the new one.
    state.players.A.hp = 5;
    state.players.A.hand = ["fire", "fire"];
    state.pendingLightning.B = 1;

    confirmNewGame(state, "A");
    const result = confirmNewGame(state, "B", queueRandom([0.1, 0, 0, 0, 0, 0, 0]));

    expect(result).not.toBe(state); // a wholly new object, not the old one mutated
    expect(result.status).toBe("active");
    expect(result.winner).toBeNull();
    expect(result.players.A.hp).toBe(100);
    expect(result.players.A.hand).toHaveLength(3);
    expect(result.pendingLightning).toEqual({ A: 0, B: 0 });
    expect(result.restartConfirmed).toEqual({ A: false, B: false });
    expect(result.board.length).toBe(3);
    expect(result.board.every((row) => row.every((cell) => cell === null))).toBe(true);
    // The usual first-turn exception still applies to the fresh game.
    expect(result.firstPlayer).toBe("A");
    expect(result.ap).toBe(1);
  });
});
