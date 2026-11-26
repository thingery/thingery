#!/usr/bin/env bash
# check-tracked-tree.sh — tracked-tree guardrail (THI-1619).
#
# git stores a symlink as a 120000-mode file blob, so a workspace symlink
# bypasses directory-only .gitignore forms and ships its TARGET — often an
# absolute workspace path — into the repo. This happened twice via `git add
# -A` (69cf21e, PR #402): a node_modules symlink rode into the PR diff. The
# no-slash `node_modules` .gitignore rule fixes the ignore side; this guard
# is the backstop that fails the exact push or PR that tracks:
#   1. a mode-120000 entry (symlink blob) — no tracked symlinks exist in
#      either repo today; ban the class, not instances;
#   2. any `node_modules` path (file or directory, at any depth);
#   3. a symlink whose TARGET leaks internal topology (agent workspace
#      roots, host user homes, instance-UUID paths) — defense in depth for
#      the day the blanket symlink ban is ever relaxed; the mode check
#      fires first today, so this scan only has work when policy changes.
#
# Usage (mirrors check-company-markers.sh):
#   check-tracked-tree.sh tree       # full-tree scan of HEAD (push to main)
#   check-tracked-tree.sh pr <base>  # scan added/changed entries vs merge base
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

MODE="${1:-}"
BASE="${2:-origin/main}"

# Internal-topology markers for symlink TARGETS (the blob content of a
# 120000-mode entry). Keep precise: these run only on symlink targets.
MARKERS=(
  '.paperclip/'    # agent workspace roots, any user
  '/home/debian/'  # runner/host user home
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' # instance/project UUIDs
)

fail=0
bad() {
  echo "::error::[tracked-tree] $*"
  echo "  VIOLATION: $*" >&2
  fail=1
}

node_modules_path() { # $1 = path
  [[ "$1" =~ (^|/)node_modules(/|$) ]]
}

check_target() { # $1 = path, $2 = symlink target (raw blob content)
  local path="$1" target="$2" pat
  for pat in "${MARKERS[@]}"; do
    if grep -qE -- "$pat" <<<"$target"; then
      bad "symlink '$path' target leaks internal topology: $target"
      return
    fi
  done
}

tree_mode() {
  # ls-tree -z records: "<mode> <type> <sha>\t<path>\0"
  local rec meta mode sha path target
  while IFS= read -rd '' rec; do
    meta="${rec%%$'\t'*}"
    path="${rec#*$'\t'}"
    mode="${meta%% *}"
    if [[ "$mode" == "120000" ]]; then
      bad "tracked symlink blob (mode 120000): $path — symlinks must not be tracked"
      sha="$(awk '{print $3}' <<<"$meta")"
      target="$(git cat-file blob "$sha")"
      check_target "$path" "$target"
    elif node_modules_path "$path"; then
      bad "tracked node_modules path: $path — never commit dependency trees"
    fi
  done < <(git ls-tree -r -z HEAD)
}

pr_mode() {
  # diff --raw -z emits NUL-terminated fields: ":<oldmode> <newmode> <oldsha>
  # <newsha> <status>\0<path>\0" (renames/copies append \0<newpath>\0).
  local colon newmode newsha status path
  while IFS= read -rd '' colon; do
    IFS= read -rd '' path
    newmode="$(cut -d' ' -f2 <<<"$colon")"
    newsha="$(cut -d' ' -f4 <<<"$colon")"
    status="$(cut -d' ' -f5 <<<"$colon")"
    case "$status" in
      R*|C*) IFS= read -rd '' path ;; # the second path is the post-image
    esac
    # newmode 000000 = deletion: tracking a path that leaves the tree is fine.
    [[ "$newmode" == "000000" ]] && continue
    if [[ "$newmode" == "120000" ]]; then
      bad "PR tracks a symlink blob (mode 120000): $path — symlinks must not be tracked"
      check_target "$path" "$(git cat-file blob "$newsha")"
    elif node_modules_path "$path"; then
      bad "PR tracks a node_modules path: $path — never commit dependency trees"
    fi
  done < <(git diff --raw -z "$BASE"...HEAD)
}

case "$MODE" in
  tree) tree_mode ;;
  pr)
    [[ -n "$BASE" ]] || { echo "usage: $0 pr <base-ref>" >&2; exit 2; }
    git rev-parse --verify "$BASE" >/dev/null 2>&1 || { echo "base ref not found: $BASE" >&2; exit 2; }
    pr_mode
    ;;
  *)
    echo "usage: $0 tree | pr <base-ref>" >&2
    exit 2
    ;;
esac

if [[ "$fail" -ne 0 ]]; then
  echo "tracked-tree guard FAILED — remove the entries above (untrack with 'git rm --cached')." >&2
fi
exit "$fail"
