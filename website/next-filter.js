// Safe `?next=` redirect filter (spec THI-11 rev 2 §2.5(4), F2).
// A regex alone is bypassable: `/\evil.com` and its %5C encoding pass `^/[^/]`
// but navigate off-site because WHATWG URLs treat `\` as `/` in special
// schemes. Normalize first, then require same-origin via URL parsing.
// Shared by website/login.html and the unit tests.

export const MAX_NEXT_LEN = 4096;

/**
 * Returns the safe navigation target (normalized), or null when `next` is
 * absent, too long, or would leave `origin`.
 */
export function safeNextTarget(next, origin) {
  if (typeof next !== "string" || next.length === 0 || next.length > MAX_NEXT_LEN) return null;
  const normalized = next.replace(/\\/g, "/");
  try {
    const url = new URL(normalized, origin);
    return url.origin === origin ? normalized : null;
  } catch {
    return null;
  }
}
