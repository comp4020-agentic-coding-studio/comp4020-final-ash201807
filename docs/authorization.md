# Authorization model

How this app decides who is who, and what they're allowed to do — written
against the actual code in `src/server/server.ts`, `src/server/sessions.ts`,
and `src/server/cookies.ts`, not an idealized design. Required by
`crits/10-fly-by-instruments`: "what each person may see and change is
checked on the server, and that decision is written down in the repo with
why."

## How a connection becomes a session

`ensureSessionCookie` (`server.ts`) sets an HttpOnly `session_id` cookie
(`cookies.ts`) the first time a browser does a plain `GET /`, if it doesn't
already have one. HttpOnly means client-side JavaScript can never read or
forge it; the browser just sends it back automatically on every subsequent
request, including the WebSocket upgrade.

When a WebSocket connects, `resolveSession` (`server.ts`) reads that cookie
via `parseSessionId`. There is no login, no password, no account — "this
browser" and "this session" are the same thing, identified purely by
possession of that one cookie value. This matches the app's own stated scope
(`README.md`/`CLAUDE.md`: no accounts, no login) — the cookie is the entire
identity mechanism, by design, not a stopgap.

## How the server resolves "who is acting"

This is the core authorization boundary, and it never reads anything the
client sends to decide who's asking:

- On every WebSocket message, the handler looks up `appState.sessions[sessionId]`
  — `sessionId` here comes from `resolveSession`'s read of the connection's own
  cookie, resolved once at connection time, not from any field inside the
  message payload (`server.ts`'s `ws.on("message", ...)` closure captures
  `sessionId` from the outer scope).
- That lookup yields a `SessionEntry` (`sessions.ts`) with a `player: "A" | "B"`
  field. `const seatedPlayer = entry.player;` is the ONLY source of truth for
  "which seat is this action being made as" — every game action
  (`playCard`, `drawCard`, `endTurn`, `requestQuit`, `rejectQuit`,
  `confirmNewGame`, `forfeitSeries`) is dispatched using `seatedPlayer`, never
  a `player`/`playerId` field read off the incoming `ClientMessage`.
- `protocol.ts`'s `ClientMessage` type doesn't even have a `player` field on
  any variant — there is nothing for a malicious client to put a forged
  identity into that the server would ever look at. A client sending extra
  JSON keys the type doesn't declare is simply ignored (the handler
  destructures only the fields it expects).

Consequence: a client cannot act as a seat it doesn't hold, no matter what it
puts in the message body, because the server's notion of "who sent this"
never comes from the message body at all — it comes from which authenticated
connection (`ws`, keyed to a `sessionId` resolved from that connection's own
cookie at connect time) the message arrived on. See `spec/`'s "伪造身份字段无效"
test (Stage 2 of this plan) for a black-box check of exactly this property.

## What each session may do, and where that's enforced

- **A session not seated in any series** (`!entry || !seriesId || !series || !game`
  guard, `server.ts`) can only send `joinQueue`. Every other message type is
  silently ignored (the function returns early) — not because the client is
  untrusted to format a message correctly, but because there is no game
  action that makes sense for a session with no seat.
- **A seated session** can act only on its own series' current game, and only
  as its own seat — `playCard(game, seatedPlayer, ...)` etc. all take the
  game object resolved from `entry.seriesId`, which is itself resolved from
  the session, which is itself resolved from the connection's cookie. There
  is no code path that resolves "the game" from anything the client supplies
  except the connection it's already authenticated on.
- **Turn order, AP cost, Combo legality, and every other game rule** are
  enforced inside `src/game/engine.ts` (`playCard`/`drawCard`/`endTurn` throw
  on an illegal action), not duplicated or second-guessed in `server.ts`. The
  server's own job stops at "resolve the real seat, then hand control to the
  engine" — it never pre-approves or pre-rejects an action based on guesses
  about legality, so there's exactly one place game rules live.
- **`forfeitSeries`** has one additional server-level check beyond "is this
  session seated": `game.status !== "active"` is rejected (`server.ts`), so a
  forfeit can't retroactively apply to a game that's already concluded.

## Cross-series isolation

`broadcastState(seriesId)` filters `sockets` down to exactly the sessions
whose `SessionEntry.seriesId` matches (`server.ts`) — a session seated in
series X is structurally incapable of receiving series Y's state pushes,
because the filter is keyed off the server's own persisted binding, not
anything the client declares. The same filtering principle applies to every
notification path (`concludeSeries`, `reapAndSettleSeries`): a session's own
`SessionEntry.seriesId` is what decides which series it can see or affect,
and that field is never written from a client message — only `pumpQueue`
(server-initiated pairing) and `seatPair`/`releaseSession` (`sessions.ts`)
ever set or clear it.

## Illegal, expired, and released sessions

- **An action referencing a game rule the engine rejects** (wrong turn, dead
  card index, insufficient AP, etc.) throws inside `engine.ts`; the server
  catches it, sends `{type: "error", message: ...}` back to that one socket,
  and does not mutate or broadcast any state — confirmed by
  `spec/game.test.ts`'s "enforces turn order and leaves state unchanged"
  test.
- **A session whose grace period has expired** is removed from
  `appState.sessions` by `reapExpiredSessions` (`sessions.ts`) before its next
  action could ever be resolved — the `!entry` guard then makes any further
  message from that old socket a silent no-op, not an error (this repo's
  established convention: a message from a session the server no longer
  recognizes is discarded, not reported, since there's no one left who holds
  that identity to tell).
- **A session whose series has concluded** (ordinary win, mutual abandon, or
  forfeit) has its `SessionEntry` deleted by `concludeSeries` in the same
  synchronous handler call that settled the series (`server.ts`) — a stale
  message arriving on that now-unseated socket afterward hits the same
  `!entry` guard and is silently discarded. There is no window where a
  released session's message could still mutate the series it used to belong
  to, because the release and the settlement happen atomically in one
  handler invocation, not across a later tick.
- **A queued-but-unseated session that disconnects** is removed from
  `appState.queue` outright (`removeFromQueue`), no grace period — Stage 9's
  own rule that a merely-queued session holds no state worth protecting.

## Why client-submitted identity fields are never trusted

Nothing in `ClientMessage` (`protocol.ts`) carries a player or session
identifier, and nothing in `server.ts`'s message handler reads one even if a
client sent extra fields — the acting player is always `seatedPlayer`,
resolved server-side from the connection's own cookie-derived session. This
is a deliberate, load-bearing design choice, not an oversight: any field a
client supplies is, by definition, something the client controls and could
lie about, so it can never be the basis for "who is allowed to do this." The
only thing the server trusts is which TCP/WebSocket connection a message
arrived on, and which `sessionId` that connection's cookie resolved to at
connect time.

## Known limits of this model

- **Cookie theft is identity theft.** Anyone who obtains another browser's
  `session_id` cookie value (e.g. via a shared machine, a leaked log line, or
  a MITM on an unencrypted connection) can act as that session. HttpOnly
  blocks script-based theft from the page itself; it does not block someone
  with filesystem or network access to the cookie. This is an accepted
  limitation given the app's own scope (friends playing together, not a
  security-sensitive application) — see `CLAUDE.md`'s "don't grow the
  audience" section.
- **Multi-tab is unsupported, not insecure.** Two tabs open on the same
  session cookie will fight over the single `sockets` entry per `sessionId`
  (documented in `server.ts`'s own comment on `ws.on("close")`) — this is a
  usability gap, not an authorization gap: neither tab can do anything the
  other couldn't already do as that same session.
- **Display IDs are not an authorization boundary.** See
  `src/server/identity.ts` — `displayId` is derived one-way from `sessionId`
  for UI/log correlation only and is never read back by the server to decide
  anything. A display-ID collision (two sessions sharing one 8-hex-char
  prefix, a real but low-probability possibility) could only ever confuse a
  human reading logs, never let one session act as another, since no
  authorization check anywhere is keyed on `displayId`.
