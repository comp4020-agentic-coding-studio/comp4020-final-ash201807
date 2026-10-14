import { describe, expect, it } from "vitest";
import type { GameState } from "../game/types.ts";
import type { SeriesState } from "./persistence.ts";
import { forfeitSeriesTo, settleGameOutcome } from "./series.ts";

// Minimal stand-ins — settleGameOutcome only ever reads status/winner off
// the last game, so these omit every other GameState field real play would
// produce (hand, board, AP, etc.) rather than constructing a full one.
function game(status: GameState["status"], winner: GameState["winner"] = null): GameState {
  return { status, winner } as GameState;
}

function freshSeries(games: GameState[]): SeriesState {
  return {
    seriesId: "s1",
    games,
    gamesWon: { A: 0, B: 0 },
    seriesWinner: null,
    seriesStatus: "active",
  };
}

describe("settleGameOutcome", () => {
  it("is a no-op while the last game is still active", () => {
    const series = freshSeries([game("active")]);
    settleGameOutcome(series);
    expect(series.gamesWon).toEqual({ A: 0, B: 0 });
    expect(series.seriesStatus).toBe("active");
    expect(series.seriesWinner).toBeNull();
  });

  it("1:0 — a single finished game increments the winner's score and leaves the series active", () => {
    const series = freshSeries([game("finished", "A")]);
    settleGameOutcome(series);
    expect(series.gamesWon).toEqual({ A: 1, B: 0 });
    expect(series.seriesStatus).toBe("active");
    expect(series.seriesWinner).toBeNull();
  });

  it("1:1 — the second game's winner increments independently, series still active", () => {
    const series = freshSeries([game("finished", "A"), game("finished", "B")]);
    series.gamesWon = { A: 1, B: 0 }; // as if settled after game 1 already
    settleGameOutcome(series);
    expect(series.gamesWon).toEqual({ A: 1, B: 1 });
    expect(series.seriesStatus).toBe("active");
    expect(series.seriesWinner).toBeNull();
  });

  it("2:0 — reaching 2 wins finishes the series immediately, crediting the right winner", () => {
    const series = freshSeries([game("finished", "A"), game("finished", "A")]);
    series.gamesWon = { A: 1, B: 0 };
    settleGameOutcome(series);
    expect(series.gamesWon).toEqual({ A: 2, B: 0 });
    expect(series.seriesStatus).toBe("finished");
    expect(series.seriesWinner).toBe("A");
  });

  it("2:1 — the series winner is whoever reached 2 wins overall, not whoever won the last game", () => {
    const series = freshSeries([game("finished", "A"), game("finished", "B"), game("finished", "A")]);
    series.gamesWon = { A: 1, B: 1 }; // as if settled after games 1-2 already
    settleGameOutcome(series);
    expect(series.gamesWon).toEqual({ A: 2, B: 1 });
    expect(series.seriesStatus).toBe("finished");
    expect(series.seriesWinner).toBe("A");
  });

  it("a locked (drawn) game counts toward neither player's score and leaves the series active", () => {
    const series = freshSeries([game("finished", "A"), game("locked")]);
    series.gamesWon = { A: 1, B: 0 };
    settleGameOutcome(series);
    expect(series.gamesWon).toEqual({ A: 1, B: 0 });
    expect(series.seriesStatus).toBe("active");
    expect(series.seriesWinner).toBeNull();
  });

  it("several locked draws in a row never force an end — no cap on games played", () => {
    const series = freshSeries([game("locked"), game("locked"), game("locked"), game("locked")]);
    settleGameOutcome(series);
    expect(series.gamesWon).toEqual({ A: 0, B: 0 });
    expect(series.seriesStatus).toBe("active");
  });

  it("an abandoned single game (mutual requestQuit) ends the WHOLE series winner-less, regardless of the score so far", () => {
    const series = freshSeries([game("finished", "A"), game("abandoned")]);
    series.gamesWon = { A: 1, B: 0 }; // A was leading 1-0 when the second game was abandoned
    settleGameOutcome(series);
    // gamesWon is left exactly as it was — neither incremented nor reset.
    expect(series.gamesWon).toEqual({ A: 1, B: 0 });
    expect(series.seriesStatus).toBe("abandoned");
    expect(series.seriesWinner).toBeNull();
  });
});

describe("forfeitSeriesTo", () => {
  it("awards the series to the given winner, from a 0-0 start — not credited as a won game", () => {
    const series = freshSeries([game("active")]);
    forfeitSeriesTo(series, "B");
    expect(series.seriesStatus).toBe("finished");
    expect(series.seriesWinner).toBe("B");
    // The in-progress game being forfeited is NOT credited as a win — a
    // forfeit at 0-0 must not manufacture a game neither player finished.
    expect(series.gamesWon).toEqual({ A: 0, B: 0 });
  });

  it("awards the series regardless of the leader's own score (forfeiting while BEHIND still wins the series)", () => {
    const series = freshSeries([game("finished", "B"), game("active")]);
    series.gamesWon = { A: 0, B: 1 }; // B is leading 1-0
    forfeitSeriesTo(series, "A"); // A forfeits anyway (e.g. conceding to B) -- exercised the other way below
    expect(series.seriesWinner).toBe("A");
    expect(series.seriesStatus).toBe("finished");
    // The 1-0 score standing at the moment of forfeit is left untouched —
    // forfeiting judges the SERIES directly, it never rewrites gamesWon.
    expect(series.gamesWon).toEqual({ A: 0, B: 1 });
  });

  it("does not touch the current game's own GameState object at all — the engine never learns a forfeit happened", () => {
    const activeGame = game("active");
    const series = freshSeries([activeGame]);
    forfeitSeriesTo(series, "A");
    expect(series.games[0]).toBe(activeGame);
    expect(series.games[0].status).toBe("active");
  });
});
