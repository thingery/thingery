// THI-115 §2: loud production failure when SESSION_SECRET is unset. The boot
// guard is extracted as assertSecretConfigured() precisely so this is a unit
// test — a process-spawn test would be heavier than the behavior warrants.

import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSecretConfigured } from "../src/auth.js";

function fakeEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  return env as NodeJS.ProcessEnv;
}

/** Intercepts process.exit by throwing — proves the call happened and stops it. */
function interceptExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit intercepted");
  }) as never);
}

describe("assertSecretConfigured (THI-115)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits with code 1 in production when SESSION_SECRET is unset", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = interceptExit();
    expect(() => assertSecretConfigured(fakeEnv({ NODE_ENV: "production" }))).toThrow(
      "process.exit intercepted",
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/FATAL: SESSION_SECRET/);
  });

  it("treats an empty-string secret as unset (compose passes ${SESSION_SECRET:-})", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = interceptExit();
    expect(() =>
      assertSecretConfigured(fakeEnv({ NODE_ENV: "production", SESSION_SECRET: "" })),
    ).toThrow("process.exit intercepted");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("boots quietly in production when the secret is set", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      assertSecretConfigured(fakeEnv({ NODE_ENV: "production", SESSION_SECRET: "a".repeat(64) })),
    ).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });

  it("only warns outside production when the secret is unset", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = interceptExit();
    expect(() => assertSecretConfigured(fakeEnv({ NODE_ENV: "development" }))).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    expect(String(error.mock.calls[0]?.[0])).toMatch(/Warning: SESSION_SECRET/);
  });
});
