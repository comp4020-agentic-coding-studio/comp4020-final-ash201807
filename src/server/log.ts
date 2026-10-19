// Structured business-event logging to stdout, per crits/10-fly-by-instruments'
// requirement that "your final project logs who did what, server-side, and
// the logging outlives the crit" — satisfied here by Fly's own log
// aggregation (`flyctl logs -a <app>`) reading this process' stdout, rather
// than this app building its own log persistence layer (see PROCESS.md's
// Stage 1 entry for why that's the minimal-sufficient reading of the
// requirement, flagged as not fully verified against course text).
//
// One line of JSON per event, never anything else interleaved into stdout by
// this module, so a tailing `flyctl logs` is line-delimited JSON a presenter
// can read live during a crit. Deliberately never includes a cookie header,
// a raw sessionId, or anything else that would let a log reader impersonate
// a session — only the one-way displayId (see identity.ts) identifies a
// player across log lines.
export interface LogEvent {
  event: string;
  displayId?: string;
  seriesId?: string;
  [key: string]: unknown;
}

export function logEvent(event: LogEvent): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}
