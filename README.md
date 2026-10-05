# Card Board Game

## What this is

Two players share a 3x3 board (growing to 5x5 once it fills). Each turn you
place a card from your hand — Fire, Lightning, Water or Nature — trying to
line three of your own cards up in a row, column or diagonal. A completed
line hits your opponent and triggers that card's effect: Lightning steals AP
from their next turn, Water refills your hand, Nature gives you another
action right now. First to 0 HP loses. The rules themselves are fixed by a
specification agreed before any code was written (`CLAUDE.md` says how it's
used); what to build on top of it was mine to decide.

## What good means here

Before deciding, I read the brief's own pointers: "the small web, games made
for a handful of friends, tools built for one workshop." Those three share a
shape — software built for a specific, small audience who already know each
other, with no attempt to scale past that. This game is exactly that shape:
built for two named people, not a matchmaking pool, with no reason to exist
for a crowd.

Given that, good means:

1. **The server is the only authority.** Neither browser decides whose turn
   it is, whether a line of three is real, or who won — AP, combo detection
   and the win condition all run server-side; the client only renders what
   it's told. A two-player game where one side could plausibly cheat isn't
   worth trusting with a friend.

2. **Nothing is lost by stepping away.** A reload, a dropped connection, a
   server restart — none of them should cost either player their place in
   the game. For two friends playing across a slow afternoon rather than a
   ranked match, losing progress to a flaky connection is the thing most
   likely to kill the experience.

3. **The state is always legible, not just correct.** At a glance, both
   players should be able to tell whose turn it is, how much AP is left, and
   what a combo just did. An engine that's technically correct but unreadable
   to the people using it isn't good by this app's own standard, even with
   every `spec/` check green.

4. **It stays small on purpose.** No accounts, no matchmaking, no
   leaderboard, no chat. One game exists at a time; a third visitor is turned
   away rather than offered a lesser spectator role. Any of those would serve
   a bigger audience than the one this app is built for.

## Checked vs. judged

Checked in `spec/`, against the real running app: a third visitor is told the
game is full and cannot affect it; an out-of-turn action is rejected and
changes nothing; reconnecting with the same session (closing and reopening a
socket, the same thing a reload does) resumes the same game rather than
losing it. Checked in `src/game/engine.test.ts`, against the rules engine in
isolation: AP costs, every combo direction, damage and effect stacking, and
the Expansion all match the specification exactly — random card draws make
these impractical to pin down through the live HTTP/WebSocket surface, so
they're checked at the layer that can actually control them.

Judged, not checked: whether the board is genuinely legible at a glance
(point 3) is a human call the current debug client doesn't attempt — it
renders state correctly but makes no effort to look clear, since the real
visual design is a later stage of this process. Whether two people actually
enjoy playing it is likewise not something a test can answer.
