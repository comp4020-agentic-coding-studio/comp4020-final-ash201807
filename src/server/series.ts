import type { SeriesState } from "./persistence.ts";

// Confirmed with the project owner: a "locked" (drawn) game counts toward
// neither player's score, and there is no cap on how many games a series
// can run through — "best of three" describes the normal case (no draws),
// not a hard ceiling. A series with several "locked" draws along the way
// simply keeps playing until one player's gamesWon reaches this threshold;
// games.length is never checked as a terminating condition anywhere below.
const GAMES_TO_WIN = 2;

// Reads the just-concluded game's outcome — the LAST entry in
// `series.games`, which must not be "active" — and folds it into the
// series' own running score/status, in place. Pure: no I/O, no socket or
// session knowledge, mirrors engine.ts's own "pure state transition, caller
// owns broadcasting" shape, just one level up (series instead of game).
// `engine.ts` itself stays completely unaware this function exists, per
// PROCESS.md's Stage 9 guiding principle — best-of-three logic lives here,
// server-side, never inside the pure game engine.
//
// Must be called at most once per concluded game. server.ts's own calling
// convention guarantees this naturally: every action that can newly produce
// a non-"active" status (play/draw/endTurn/requestQuit) already throws if
// the game is already non-"active", so by the time one of them succeeds and
// leaves the game non-"active", that transition JUST happened — there is no
// path that calls this twice against the same concluded game.
export function settleGameOutcome(series: SeriesState): void {
  const game = series.games[series.games.length - 1];
  if (game.status === "active") return; // nothing concluded yet, nothing to settle

  if (game.status === "finished") {
    // engine.ts guarantees `winner` is set whenever status is "finished".
    const winner = game.winner!;
    series.gamesWon[winner] += 1;
    if (series.gamesWon[winner] >= GAMES_TO_WIN) {
      series.seriesWinner = winner;
      series.seriesStatus = "finished";
    }
    return;
  }

  if (game.status === "locked") {
    // A drawn game (full board, nobody dead) — confirmed with the project
    // owner: counts toward neither player's score. The series simply
    // continues to its next game once both confirm, same as any other
    // still-active series.
    return;
  }

  // game.status === "abandoned": both players mutually agreed (Stage 8b's
  // requestQuit/rejectQuit) to end THIS one game early. Confirmed with the
  // project owner: there is no rule yet for fairly continuing a series
  // after one of its games was called off, so the WHOLE series ends here,
  // winner-less — regardless of the score so far (even a 1-0 leader gets
  // no credit for the game that was abandoned, and gamesWon is left exactly
  // as it was, neither incremented nor reset, since the series itself is
  // simply over, not replayed).
  series.seriesStatus = "abandoned";
  series.seriesWinner = null;
}
