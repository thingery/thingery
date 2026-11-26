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
#   4. a committed merge-conflict marker (THI-1659) — a botched conflict
#      resolution landed a literal marker on main-bound docs and passed
#      every existing gate (THI-1649 A6: docs/deploy-vps.md:740 at 26ea3c5,
#      fixed in that PR at a4474bf). pr mode fails when a PR ADDS a marker
#      line; tree mode sweeps full index content via `git grep --cached`,
#      so a marker anywhere in the tracked tree fails regardless of which
#      line introduced it.
#
# Usage (mirrors check-company-markers.sh):
#   check-tracked-tree.sh tree       # full-tree scan of HEAD (push to main + weekly pass)
#   check-tracked-tree.sh pr <base>  # scan added/changed entries AND added lines vs merge base
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

# --- Merge-conflict markers (THI-1659) --------------------------------------
#
# Line-anchored, column-0 patterns exactly as git writes them. Bracket
# expressions ([<]{7}) instead of escaped alternation so the same ERE is
# valid for grep -E, bash [[ =~ ]], and awk. Deliberate narrowness:
#   - markers must start at column 0 — indented examples inside docs that
#     show conflict syntax never match;
#   - the separator needs end-of-line anchoring — markdown setext
#     underlines of any other length (e.g. 8+ equals) never match.
# Binary files are skipped (-I): markers are a text construct. This script
# is itself scanned — keep every literal marker off column 0 in it.
CONFLICT_PATTERNS=(
  '^[<]{7}'             # conflict start  (<<<<<<< HEAD|label)
  '^[>]{7}'             # conflict end    (>>>>>>> label)
  '^[=]{7}[[:space:]]*$' # separator      (exactly "=======" alone on the line)
  '^[|]{7}'             # diff3 separator (||||||| label)
)
CONFLICT_RE="$(IFS='|'; echo "${CONFLICT_PATTERNS[*]}")"

# Explicit allowlist: tracked paths exempt from conflict-marker scanning,
# as case-style glob patterns matched against repo-relative paths. Keep it
# EMPTY unless a tracked file legitimately contains column-0 markers (e.g.
# docs that teach conflict resolution). Every entry MUST carry a comment
# citing the task/PR that justified it — no silent excludes; anything not
# listed here fails the guard.
CONFLICT_ALLOWLIST=(
  # "docs/git/conflict-resolution.md"  # tutorial shows real markers (THI-XXXX)
)

allowlisted() { # $1 = repo-relative path
  local path="$1" pat
  for pat in "${CONFLICT_ALLOWLIST[@]}"; do
    # shellcheck disable=SC2254  # unquoted $pat = intentional glob match
    case "$path" in
      $pat) return 0 ;;
    esac
  done
  return 1
}

conflict_tree_scan() {
  # Full-content sweep over the INDEX (git grep --cached): scans exactly the
  # committed blob content, immune to worktree drift (a tracked symlink
  # materializes as a directory in the worktree and errors GNU grep), and
  # NUL/odd-path safe. -I skips binary files (markers are a text construct);
  # -E for the ERE. Hit paths containing a literal ':' would skew the path
  # split — none exist in this repo; if one ever lands, fix the split before
  # allowlisting around it. git grep exit 1 = no match (clean); >=2 = real
  # error → fail closed so a broken sweep never looks clean.
  local out rc hit path
  if out="$(git grep --cached -nIE -e "$CONFLICT_RE")"; then
    rc=0
  else
    rc=$?
  fi
  if [[ $rc -gt 1 ]]; then
    bad "conflict-marker sweep errored (git grep rc=$rc) — failing closed: ${out:0:200}"
    return
  fi
  [[ $rc -eq 1 ]] && return 0 # no matches anywhere
  while IFS= read -r hit; do
    path="${hit%%:*}"
    if allowlisted "$path"; then
      echo "  allowlisted (not scanned): $hit" >&2
    else
      bad "committed merge-conflict marker: $hit"
    fi
  done <<<"$out"
}

conflict_pr_scan() {
  # ADDED lines only (diff-filter=ACMRT, -U0): a PR fails when it
  # INTRODUCES a marker; markers already on main are the tree scan's job.
  # All paths — conflict markers are not a docs-only failure class.
  local diff_out path line
  diff_out="$(git diff --diff-filter=ACMRT -U0 "$BASE"...HEAD)" || {
    echo "::error::[tracked-tree] git diff vs ${BASE} failed — failing closed" >&2
    fail=1
    return
  }
  while IFS=$'\t' read -r path line; do
    [[ -n "$path" && -n "$line" ]] || continue
    allowlisted "$path" && continue
    bad "PR adds a merge-conflict marker: ${path}: ${line:0:160}"
  done < <(
    printf '%s\n' "$diff_out" \
      | awk -v re="$CONFLICT_RE" '
          /^\+\+\+ /{f=substr($2,3); next}
          /^\+[^+]/ && f != "" && substr($0,2) ~ re { print f "\t" substr($0,2) }
        '
  )
}

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
  conflict_tree_scan
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
  conflict_pr_scan
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
  echo "tracked-tree guard FAILED — fix the entries above (untrack with 'git rm --cached'; conflict markers mean the resolution was botched — keep only the intended side)." >&2
fi
exit "$fail"
