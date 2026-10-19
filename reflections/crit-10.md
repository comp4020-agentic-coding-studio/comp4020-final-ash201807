# Crit 10 reflection

## What was the breakthrough that moved the work forward?

The plan I was given split "add authorization/logging" into five
gated stages with an explicit read-only stage first. I almost treated that
stage as a formality — I already knew, from building this app, how sessions
and seats worked. The actual value showed up once I forced myself to verify
the course's own crit rubric word-for-word instead of assuming what it
probably said: "the logging outlives the crit" turned out to be vaguer than
I'd have guessed, and my first instinct was to read it as "needs its own
persistence layer." Writing down explicitly that I *hadn't* confirmed that,
rather than quietly building for the stricter reading, kept the actual
implementation proportional — stdout JSON, no new schema, no migration risk
to the one thing (`/data/game.db`) this repo is genuinely careful about.

The second thing that mattered: writing the two authorization tests (Stage 2)
after already reading `server.ts` closely enough to predict their outcome.
I expected the forged-identity test to need new server code to reject
something. It didn't — the server never reads a client-submitted identity
field in the first place, so the test just confirmed an existing property
instead of exercising a new guard. Knowing that *before* writing the test,
rather than discovering it by watching the test fail, is what let me write
`docs/authorization.md` as a description of real enforcement rather than a
wish list.

## What did this work change about who I want to be as a software developer?

I want to keep separating "what the rubric literally says" from "what I
assume it probably means," and write the gap down instead of quietly
resolving it in whichever direction is easier to build. The stdout-vs-
persistent-logging question could have gone either way defensibly; the
discipline worth keeping is naming the uncertainty rather than picking
silently.
