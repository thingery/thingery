import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolves in dev (src/../), in the Docker image (/app/../), and in the npm package.
export const VERSION: string = (
  JSON.parse(
    readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
  ) as { version: string }
).version;

/**
 * Build metadata (git commit + build timestamp) baked in at image build time.
 *
 * The Dockerfile writes a `build-info.json` next to the compiled output
 * (`dist/build-info.json`) from the GIT_COMMIT / BUILD_TIME build args — the
 * runtime image carries no `.git`, so this is the only source of truth.
 * Anything missing (local dev, npm package installs) reports "unknown"
 * rather than guessing: never shell out to git at runtime.
 */
export interface BuildInfo {
  commit: string;
  buildTime: string;
}

const UNKNOWN: BuildInfo = { commit: "unknown", buildTime: "unknown" };

export function readBuildInfo(dir: string): BuildInfo {
  const file = path.resolve(dir, "build-info.json");
  if (!existsSync(file)) return { ...UNKNOWN };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { commit?: unknown; buildTime?: unknown };
    return {
      commit: typeof raw.commit === "string" && raw.commit ? raw.commit : UNKNOWN.commit,
      buildTime: typeof raw.buildTime === "string" && raw.buildTime ? raw.buildTime : UNKNOWN.buildTime,
    };
  } catch {
    return { ...UNKNOWN };
  }
}

export const BUILD: BuildInfo = readBuildInfo(path.dirname(fileURLToPath(import.meta.url)));
export const COMMIT: string = BUILD.commit;
export const BUILD_TIME: string = BUILD.buildTime;
