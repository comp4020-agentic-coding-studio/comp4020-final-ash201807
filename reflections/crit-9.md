# Crit 9 reflection

## What was the breakthrough that moved the work forward?

I asked for spectator mode and a consent-based seat-swap, on top of the
existing one-shared-game design. On paper it sounded like a reasonable
extension — add a role, add a message type, reuse `requestQuit`'s
agreement shape. A read-only analysis against the real code made the actual
cost visible: `SessionMap` only knows one global seat per session,
`AppState` only ever holds one `GameState`, and the moment I pushed further
and asked "what would real matchmaking and best-of-3 series actually take,"
the honest answer was that it isn't an extension at all — it reverses the
app's own founding design argument, the one `README.md` already states:
built for two named people, not a matchmaking pool. I couldn't see that
from describing the scenario in the abstract; it only became obvious once
someone actually traced it through the data structures and said precisely
what would have to be rewritten, which tests would invert rather than just
update, and which parts of Stage 8a's disconnect handling would stop making
sense. Imagining the feature and testing the feature against the real
architecture gave two completely different pictures of the same idea.

## What did this work change about who I want to be as a software developer?

I want to stop treating "sounds like a natural next feature" as a signal
that it is one. The scenario itself shapes the architecture more than the
feature description does — two people who know each other versus a pool of
strangers are different products, not different settings on the same
product — and the only way I actually believe that now, rather than just
agree with it, is from watching a concrete analysis of my own repo prove it.
