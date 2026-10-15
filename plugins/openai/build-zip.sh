#!/usr/bin/env bash
# Build the OpenAI plugin submission ZIP (THI-218).
#
# Stages exactly what the ZIP must contain — plugin.json, mcp.json, and every
# local file the manifest references (icons, screenshots) — then zips it.
# Refuses to build unless validate.mjs reports the package submission-ready
# (exit 0), so a blocked draft can never produce a final artifact.
#
# Usage: plugins/openai/build-zip.sh [output.zip]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/thingery-openai-plugin.zip}"
# zip runs from inside the staging dir — resolve the output path first.
if [[ "$out" != /* ]]; then out="$PWD/$out"; fi
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

node "$here/validate.mjs"

cp "$here/plugin.json" "$here/mcp.json" "$stage/"

# Copy every relative file path referenced by the manifest (./-prefixed).
node -e '
const m = require("'"$here"'/plugin.json");
const ext = m.extensions?.["com.openai"] ?? {};
const refs = [
  ext.interface?.composerIcon, ext.interface?.composerIconDark,
  ext.interface?.logo, ext.interface?.logoDark,
  ...(ext.interface?.screenshots ?? []),
  ext.onboardingSkill,
];
for (const r of refs) if (typeof r === "string" && r.startsWith("./")) console.log(r.slice(2));
' | while read -r rel; do
  mkdir -p "$stage/$(dirname "$rel")"
  cp "$here/$rel" "$stage/$rel"
done

(cd "$stage" && zip -qrX "$out" .)
echo "Built $out:"
unzip -l "$out"
