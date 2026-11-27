#!/bin/bash
# Ignore-pattern regression matrix for the .env snapshot policy (THI-1363/THI-1373).
#
# The ignore rules ARE the policy: nothing else prevents `.env.bak-*` secret
# snapshots from landing in git history or in a docker build context (47 such
# files accumulated on the VPS before the THI-1363 fix). If a future change
# narrows `.env*` back to `.env`, drops the `!.env.example` negation, un-ignores
# the `metrics/` runtime output, or narrows `.dockerignore`, this matrix fails
# the exact PR that did it. Runs in milliseconds on every CI run.
#
# Checked (git check-ignore):
#   .env.bak-webpin-20261124T000000Z   ignored      — snapshot class, `.env*`
#   .env                               ignored      — base case
#   .env.example                       NOT ignored  — `!.env.example` stays tracked
#   metrics/daily.json                 ignored      — `metrics/` dir rule propagates
#   node_modules                       ignored      — no-slash form: symlink blobs (THI-1619)
#   node_modules/lodash/index.js       ignored      — `node_modules/` dir rule propagates
# Docker build context (the real engine; skipped when docker is unavailable):
#   .env.bak-webpin-20261124T000000Z   excluded from `docker build` context
#
# Exits nonzero on any violation. Run from anywhere inside the repo:
#   bash scripts/check-ignore-matrix.sh

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0
ok()  { echo "ok: $*"; }
bad() { echo "FAIL: $*" >&2; fail=1; }

# --- git check-ignore matrix ---------------------------------------------------
assert_ignored() {
  if git check-ignore -q "$1"; then
    ok "$1 is ignored"
  else
    bad "$1 is NOT ignored — the .env snapshot / metrics ignore policy regressed"
  fi
}
assert_not_ignored() {
  if git check-ignore -q "$1"; then
    bad "$1 IS ignored — it must stay trackable (pattern negation removed?)"
  else
    ok "$1 is not ignored"
  fi
}

assert_ignored ".env.bak-webpin-20261124T000000Z"
assert_ignored ".env"
assert_not_ignored ".env.example"
# The `metrics/` pattern only matches a directory, so assert a path *under* it —
# that works in a fresh checkout where metrics/ does not exist on disk.
assert_ignored "metrics/daily.json"

# Tracked node_modules symlink-blob policy: the directory-only `node_modules/`
# pattern never matches a symlink (git stores symlinks as 120000-mode file
# blobs), which is how a workspace node_modules symlink twice entered history
# via `git add -A`. The no-slash `node_modules` rule closes that gap; both
# forms must stay (slash = directories, no-slash = blobs/symlinks/files).
assert_ignored "node_modules"
assert_ignored "node_modules/lodash/index.js"
assert_ignored "packages/client/node_modules"

# --- docker build context probe --------------------------------------------------
# .dockerignore semantics differ from gitignore (root-anchored, no negation),
# so evaluate the real engine instead of approximating: `FROM scratch` plus a
# COPY of the snapshot. A failed COPY that names the file proves .dockerignore
# excluded it from the context; a successful build would mean snapshots ship
# into every image build (the pre-THI-1363 behavior).
if command -v docker >/dev/null 2>&1; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  cp .dockerignore "$tmp/.dockerignore"
  : > "$tmp/.env.bak-webpin-20261124T000000Z"
  cat > "$tmp/Dockerfile" <<'EOF'
FROM scratch
COPY .env.bak-webpin-20261124T000000Z /
EOF
  log="$(docker build "$tmp" 2>&1 || true)"
  missing='not found|no such file'
  if grep -qE 'Successfully built|writing image' <<<"$log" && ! grep -qiE "$missing" <<<"$log"; then
    # Build succeeded => the snapshot entered the context. Clean up the image
    # this produced, then fail.
    imgid="$(grep -oE 'writing image sha256:[0-9a-f]+|Successfully built [0-9a-f]+' <<<"$log" \
      | grep -oE '[0-9a-f]{8,}' | head -1)" || true
    [[ -n "$imgid" ]] && docker rmi -f "$imgid" >/dev/null 2>&1 || true
    bad "docker build context INCLUDES .env.bak-* — .dockerignore is too narrow"
  elif grep -q '.env.bak-webpin-20261124T000000Z' <<<"$log" && grep -qiE "$missing" <<<"$log"; then
    ok "docker build context excludes .env.bak-*"
  else
    bad "docker probe could not classify the build result — inspect manually; log head:"
    sed -n '1,20p' <<<"$log" >&2
  fi
else
  echo "skip: docker unavailable — run scripts/check-ignore-matrix.sh on a docker machine to verify the build-context case"
fi

exit "$fail"
