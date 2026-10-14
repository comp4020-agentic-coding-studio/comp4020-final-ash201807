import type { GameState, PlayerId } from "../game/types.ts";

// Stage 5: the running best-of-three score, alongside whichever individual
// GameState is currently being shown — server-level bookkeeping the engine
// itself never produces, so it's threaded onto the wire separately rather
// than folded into GameState's own shape (see persistence.ts's SeriesState
// for why: GameState stays single-game-only, every series-level concept
// lives outside it).
export interface SeriesScore {
  gamesWon: Record<PlayerId, number>;
  seriesStatus: "active" | "finished" | "abandoned";
  seriesWinner: PlayerId | null;
}

export type ServerMessage =
  | { type: "assigned"; player: PlayerId }
  | { type: "waiting" }
  // Stage 3: distinct from "waiting" on purpose, per the project owner's own
  // instruction not to reuse that message — "waiting" means this session
  // already holds a seat and is waiting for an opponent; "queued" means it
  // holds no seat yet at all, just a place in line. Replaces "full": a third
  // visitor is no longer rejected outright, so that message is now
  // unreachable and has been removed rather than left as dead protocol.
  | { type: "queued" }
  | { type: "state"; state: GameState; series: SeriesScore }
  // Stage 4b: a seated session's series ended by forfeit rather than by
  // ordinary play — sent only to the survivor (the opponent whose grace
  // period expired is, by definition, not connected to receive anything).
  // Deliberately distinct from GameState's own "finished"/"locked"/
  // "abandoned" statuses: a forfeit is a server-level settlement, not a
  // game-rules outcome, so it's never written into the GameState itself
  // (per PROCESS.md's Stage 9 guiding principle — match/series lifecycle
  // stays out of engine.ts). The survivor's own SessionEntry is released
  // the moment this is sent, so they must explicitly re-queue afterward,
  // same as after any other ended series.
  | { type: "seriesEnded"; reason: "opponentDisconnected" }
  // Stage 5: the series itself concluded through ordinary play — either a
  // player reached 2 game-wins (series.seriesStatus "finished", seriesWinner
  // set), or a mid-series game was mutually abandoned (requestQuit/
  // rejectQuit on an in-progress game), which ends the WHOLE series
  // winner-less per the project owner's confirmed decision, not just that
  // one game. Sent to BOTH players (unlike the forfeit case above, both are
  // still connected here) with the final score attached; both sessions are
  // released the moment this is sent, same "must explicitly re-queue" rule.
  | { type: "seriesEnded"; reason: "seriesConcluded"; series: SeriesScore }
  // Stage 6: one player unilaterally forfeited the WHOLE series (ClientMessage
  // "forfeitSeries" below) — sent to the OPPONENT, who just won the series
  // without needing to agree to anything, mirroring the disconnect-forfeit
  // case above in shape (both are "the other player's seat is gone, you win
  // outright") but distinguished by reason, since "your opponent vanished"
  // and "your opponent explicitly gave up" are different information for a
  // player to receive. The forfeiting player gets their OWN confirmation —
  // "forfeited", not "opponentForfeited" — of the same event; both sessions
  // are released the moment this is sent either way, same as every other
  // ended-series path.
  | { type: "seriesEnded"; reason: "opponentForfeited"; series: SeriesScore }
  | { type: "seriesEnded"; reason: "forfeited"; series: SeriesScore }
  | { type: "error"; message: string };

export type ClientMessage =
  // Stage 3: the explicit "join matchmaking" action — a session takes no
  // seat and joins no queue merely by opening the WebSocket; it must send
  // this first, per the project owner's own instruction that the lobby
  // requires an active "join queue" click rather than auto-joining on
  // connect.
  | { type: "joinQueue" }
  | { type: "play"; handIndex: number; row: number; col: number }
  | { type: "draw" }
  | { type: "endTurn" }
  | { type: "confirmNewGame" }
  | { type: "requestQuit" }
  | { type: "rejectQuit" }
  // Stage 6: unilateral — no agreement from the opponent needed, unlike
  // requestQuit/rejectQuit's mutual shape. Immediately awards the WHOLE
  // series to the opponent, exactly like Stage 4b's disconnect-forfeit, just
  // triggered by this message instead of a grace period elapsing. Only valid
  // while the series' CURRENT game is active (src/server/server.ts's own
  // guard) — rejected, same as any other action, once that game has already
  // concluded and both players are only waiting to confirm the next one.
  | { type: "forfeitSeries" };
