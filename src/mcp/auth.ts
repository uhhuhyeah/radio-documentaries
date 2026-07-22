/**
 * Bearer-token authorization for the MCP HTTP server — a pure predicate so it can
 * be unit-tested and checked BEFORE the transport ever sees a request.
 */

/**
 * True iff `authHeader` is exactly `Bearer <expectedToken>`.
 *
 * Fails closed: an empty/whitespace `expectedToken` is never authorized (the
 * server itself refuses to start without a token, but this is a second belt).
 * A constant-time compare guards against timing oracles on the token.
 */
export function isAuthorized(authHeader: string | undefined, expectedToken: string): boolean {
  if (!expectedToken || expectedToken.trim() === "") return false;
  if (!authHeader) return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const presented = authHeader.slice(prefix.length);
  return timingSafeEqual(presented, expectedToken);
}

/** Length-independent constant-time string comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
