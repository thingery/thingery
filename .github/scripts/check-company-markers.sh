#!/usr/bin/env bash
# check-company-markers.sh — content-boundary guardrail for the public repo.
#
# THI-700 (board decision, Nov 12): the no-private-paths job blocks
# company-private PATHS; this script blocks company-private CONTENT in
# docs/** and scripts/**. A path deny-list alone did not stop company
# specs landing via docs/ on 2026-11-10 — content markers close that gap.
#
# Marker classes:
#   1. internal tracker links / orchestration-platform references
#   2. quoted board-verdict / decision-card choreography
#   3. LLM provider company-account references
#   4. real backup/deploy key fingerprints (age public keys, SSH fingerprints)
#   5. internal program ids inside specs (docs/specs/** only)
#
# This file lives under .github/ — deliberately OUTSIDE the scanned scope —
# so its own pattern strings can never trip a scan.
#
# Usage:
#   check-company-markers.sh tree            # scan all tracked docs/** scripts/**
#   check-company-markers.sh pr [base_ref]   # scan ADDED lines vs merge base
set -uo pipefail

MODE="${1:-tree}"
BASE_REF="${2:-origin/main}"

# Marker patterns (extended regex), applied to docs/** and scripts/**.
# Keep each pattern on one line; add to MARKERS when a new marker class is
# board-approved — never widen scope past docs/ + scripts/ without a spec.
MARKERS=(
  'paperclip\.ing'                    # internal tracker links
  'Paperclip'                         # orchestration-platform references
  'z\.ai'                             # provider company-account references
  'age1[0-9a-z]{58}'                  # real age public keys (placeholders use ... so never match)
  'SHA256:[A-Za-z0-9+/]{43}'          # real SSH key fingerprints
  'board verdict|board-verdict|board decision|board-approved|decision card|confirmation card'
)
# Spec-scope marker: internal program ids are only ever legit outside specs
# (ADRs cite their review trail); inside docs/specs/** they are company
# choreography.
SPEC_MARKER='THI-[0-9]+'

fail=0

scan_lines() {
  # reads "path<TAB>line" pairs on stdin; labels hits and sets fail=1
  local line path pat
  while IFS=$'\t' read -r path line; do
    for pat in "${MARKERS[@]}"; do
      if printf '%s' "$line" | grep -qE "$pat"; then
        echo "::error file=${path}::content marker (${pat}) in: ${line:0:120}"
        echo "  MARKER HIT $path: ${line:0:160}"
        fail=1
        break
      fi
    done
    case "$path" in
      docs/specs/*)
        if printf '%s' "$line" | grep -qE "$SPEC_MARKER"; then
          echo "::error file=${path}::program id in spec: ${line:0:120}"
          echo "  MARKER HIT [spec-ids] $path: ${line:0:160}"
          fail=1
        fi
        ;;
    esac
  done
}

case "$MODE" in
  tree)
    echo "Full-tree content-marker scan (docs/** scripts/**)..."
    # git failures must fail closed — a failed file listing must never look
    # like a clean scan (a bad-revision git diff used to exit 0)
    tree_files="$(git ls-files -- 'docs/**' 'scripts/**')" || {
      echo "::error::git ls-files failed; failing closed" >&2
      exit 1
    }
    # process substitution keeps scan_lines in the main shell so fail= sticks
    scan_lines < <(
      printf '%s\n' "$tree_files" | while IFS= read -r f; do
        awk -v f="$f" '{print f "\t" $0}' "$f"
      done
    )
    ;;
  pr)
    BASE_SHA="$(git rev-parse --verify -q "${BASE_REF}^{commit}" || true)"
    if [ -z "$BASE_SHA" ]; then
      echo "::error::invalid base ref '${BASE_REF}' — cannot compute PR diff; failing closed" >&2
      exit 1
    fi
    echo "PR added-line content-marker scan (docs/** scripts/**) vs ${BASE_SHA}..."
    # one "path<TAB>added-line" pair per + line, with its file header;
    # process substitution keeps scan_lines in the main shell so fail= sticks;
    # a failed git diff must fail closed, never scan-nothing-and-pass
    diff_out="$(git diff --diff-filter=ACMRT -U0 "${BASE_SHA}...HEAD" -- docs scripts)" || {
      echo "::error::git diff failed vs ${BASE_SHA}; failing closed" >&2
      exit 1
    }
    scan_lines < <(
      printf '%s\n' "$diff_out" \
        | awk '/^\+\+\+ /{f=substr($2,3)} /^\+[^+]/{if (f!="") print f "\t" substr($0,2)}'
    )
    ;;
  *)
    echo "unknown mode: $MODE (use 'tree' or 'pr')" >&2
    exit 2
    ;;
esac

if [ "$fail" -ne 0 ]; then
  echo "FAIL: company-content markers found — move the material to thingery/platform (AGENTS.md: Spec-landing policy)."
  exit 1
fi
echo "OK: no company-content markers in scope."
