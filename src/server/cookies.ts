const SESSION_COOKIE = "session_id";

export function parseSessionId(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key === SESSION_COOKIE) return part.slice(separator + 1).trim();
  }
  return undefined;
}

// HttpOnly: the client never reads this directly, the server is the only
// thing matching it to a player slot. No Secure flag, so this also works
// over plain http in local development — Fly terminates TLS in front of the
// app in production, which is a browser-to-proxy concern, not this header.
export function sessionCookieHeader(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax`;
}
