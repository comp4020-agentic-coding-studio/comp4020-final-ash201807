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
credited player's hand, Nature grants them another action now, and Fire deals
10 extra damage straight to the opponent (so a Type Combo's total is 15, and
an Owner Combo that's also same-type totals 25). Neither match means no
Combo. First to 0 HP loses that game — including when Fire's own extra
damage is what crosses zero, not just the base hit — a full board with
neither player dead locks that game instead, as a draw: neither counts
toward either player's score. A match is best of three games: the first
player to win two games wins the match, win/draw scores carrying over from
one game to the next within it. Either player can also end the current game
early if the other agrees; unlike a normal win, that ends the whole match
immediately with no winner, since there's no rule yet for fairly resuming a
match after one of its games was called off. Any non-deciding game needs
both players to confirm starting the next one — a rematch doesn't reset it
out from under the other. The rules are fixed by a specification, four
times revised after real two-player playtesting, agreed before this code
was written; what to build on top was mine to decide.

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

4. **It stays small on purpose.** No accounts, leaderboard, or chat. Any
   number of two-player matches can run at once, each independent of the
   others — but matchmaking itself is still deliberately simple: an explicit
   FIFO queue pairs the two longest-waiting players, no skill rating, no
   choice of opponent, no spectator role. This is matchmaking sized for a
   small group of friends taking turns, not a feature aimed at a larger
   audience than this is built for.

## Checked vs. judged

Checked in `spec/`, against the real running app: a session must explicitly
join the matchmaking queue before it's seated — merely connecting claims
nothing; the FIFO queue pairs the two longest-waiting sessions into their
own independent match the moment a second one arrives, with no ceiling on
how many matches run concurrently; one match's state, actions, and errors
never reach another match's players, and a reconnecting session always
resumes its own match specifically, never an unrelated concurrent one; an
out-of-turn action, and confirming the next game while the current one is
still active, are rejected and change nothing; reconnecting with the same
session resumes the game rather than losing it; a session that disconnects
and never comes back forfeits its *entire match* to the opponent once its
grace period elapses — surviving an actual process restart mid-grace-period,
not just elapsed time in one long-lived process — without disturbing any
other match running at the same time, while a session that's still
connected is left alone; if both players of a match disconnect and neither
returns, that match is abandoned with no winner, silently, rather than
counted as anyone's win; a session that disconnects while still only queued
(never seated) is removed from the queue outright, no grace period;
starting a match's next game resets the board and hands but never its
running score, confirmed directly against the persisted data, not just the
live broadcast; reaching a second win correctly ends the match rather than
starting a third game, crediting whichever player actually reached two
wins rather than whoever happened to win the most recent one; and
voluntarily ending the current game early, including the other player
rejecting that request, works end-to-end over the real transport —
agreeing to end it ends the whole match, not just that one game. Checked in
`src/game/engine.test.ts`, against the rules engine directly: AP costs, every
Combo direction and type combination, damage and effect stacking (including
Fire's own extra-damage effect, and its own lethal check separate from the
base damage's), the Expansion, Board Locked, voluntary termination, and
restart confirmation all match the specification — reaching a real
finished/locked game, or controlling which cards complete a Combo, isn't
practical live, so these are checked where that control exists.

Judged, not checked: whether the board is genuinely legible at a glance
(point 3) — the debug client renders state correctly but doesn't try to look
clear, since visual design is a later stage. Whether two people enjoy
playing it is likewise not something a test can answer.
