# Card Board Game

## What this is

Two players share a 3x3 board (growing to 5x5 once it fills). Each turn you
place a card from your hand — Fire, Lightning, Water or Nature. Three cards
in a row, column or diagonal form a Combo on a shared **owner**, a shared
**type**, or both: same owner deals 15 damage regardless of type; same type
across different owners deals only 5, credited to whoever placed the
completing card; both at once still counts once, for 15, never 20. Only a
same-type Combo — credited to whoever triggered it — fires that type's
effect: Lightning steals the opponent's next-turn AP, Water refills the
credited player's hand, Nature grants them another action now. Neither match
means no Combo. First to 0 HP loses outright; a full board with neither
player dead locks instead, with no winner. Either ending needs both players
to confirm a new game before one starts — a rematch doesn't reset it out
from under the other. The rules are fixed by a specification, twice revised
after real two-player playtesting, agreed before this code was written; what
to build on top was mine to decide.

## What good means here

Before deciding, I read the brief's own pointers: "the small web, games made
for a handful of friends, tools built for one workshop" — software for
people who already know each other, not scaled past that. This game is
exactly that shape: built for two named people, not a matchmaking pool.

Given that, good means:

1. **The server is the only authority.** Neither browser decides whose turn
   it is, whether a line is a real Combo, who won, or whether a restart was
   agreed to — it only renders what it's told. A game where one side could
   cheat, or reset the other alone, isn't worth trusting a friend with.

2. **Nothing is lost by stepping away.** A reload, a dropped connection, a
   server restart shouldn't cost either player their place in the game, since
   losing progress to a flaky connection is the likeliest thing to kill a
   casual game between friends.

3. **The state is always legible, not just correct.** At a glance, both
   players should see whose turn it is, how much AP is left, and what a
   Combo just did — an engine that's correct but unreadable isn't good by
   this app's own standard, even with every `spec/` check green.

4. **It stays small on purpose.** No accounts, matchmaking, leaderboard, or
   chat. One game exists at a time; a third visitor is turned away, not given
   a lesser spectator role — any of that would serve a bigger audience than
   this is built for.

## Checked vs. judged

Checked in `spec/`, against the real running app: a third visitor is told the
game is full; an out-of-turn action, and confirming a new game mid-match, are
rejected and change nothing; reconnecting with the same session resumes the
game rather than losing it. Checked in `src/game/engine.test.ts`, against the
rules engine directly: AP costs, every Combo direction and type combination,
damage and effect stacking, the Expansion, Board Locked, and restart
confirmation all match the specification — reaching a real finished/locked
game, or controlling which cards complete a Combo, isn't practical live, so
these are checked where that control exists.

Judged, not checked: whether the board is genuinely legible at a glance
(point 3) — the debug client renders state correctly but doesn't try to look
clear, since visual design is a later stage. Whether two people enjoy
playing it is likewise not something a test can answer.
