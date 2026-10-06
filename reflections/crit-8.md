# Crit 8 reflection

## What was the breakthrough that moved the work forward?

A real "game is full" lockout on the live app — a lost cookie, a session
that never released its seat, no fix short of SSHing into the Fly machine
and editing the SQLite row by hand — forced the actual design question: how
do you free a disconnected player's slot without a scheduled timer, when
Fly stops the machine itself the moment nobody's connected (exactly when a
grace-period timer would be running)? The answer was to stop thinking in
callbacks and store a timestamp instead, letting every new connection
attempt derive "has the grace period passed" from wall-clock time rather
than from anything still running. We proved this by actually killing the
server process mid-grace-period and restarting it against the same database
file, not just by waiting inside one long session.

## What did this work change about who I want to be as a software developer?

The plan Claude produced after its read-only analysis looked complete, and
I almost shipped it as-is. But when I actually played through it myself —
two browsers, one of them incognito, both closed — I found a case the
analysis hadn't covered: if both original players vanish, nobody is left to
ever confirm "yes, end this," and the old game would block forever. The
design read as solid on paper and still had a real hole once I actually
used it. That's the habit I want to keep: a plan isn't trustworthy because
it's well-reasoned, it's trustworthy once I've tried to break it myself.
