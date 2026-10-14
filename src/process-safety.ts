// THI-54: process-level safety net for unhandled promise rejections.
//
// Every HTTP surface already converts its own async faults into responses:
// the /mcp gate has a full try/catch (THI-27), /api (THI-58) and /oauth
// (THI-42) wrap their handlers in asyncHandler with terminal error
// middleware, and the website pages are wrapped the same way (THI-54).
// What none of that can reach is everything else: a future route mounted
// without asyncHandler, a rejection inside a background timer (OAuth
// retention sweeps, order deadline sweeps), or any other code path outside
// request handling. On Node >= 15 an unhandled rejection terminates the
// process — /mcp, the website, /api and /healthz would all die together,
// and the in-memory rate limiters reset with the process, so they do not
// bound a crash loop either.
//
// Policy: log loudly, keep serving. This is a last-resort net, not an
// error strategy — anything landing here is a bug to fix at the source.
// uncaughtException is deliberately NOT swallowed: after a synchronous
// crash the process state is unknown, so dying and letting the container
// supervisor restart us stays the safe default.

/** The registered listener, exported separately for unit testing. */
export function logUnhandledRejection(reason: unknown): void {
  console.error("unhandledRejection (bug — nothing caught this; see THI-54):", reason);
}

/** Installs the net on the current process. Idempotent: calling it again
 *  (e.g. from tests) never stacks duplicate listeners. */
export function installProcessSafetyNet(): void {
  if (!process.listeners("unhandledRejection").includes(logUnhandledRejection)) {
    process.on("unhandledRejection", logUnhandledRejection);
  }
}
