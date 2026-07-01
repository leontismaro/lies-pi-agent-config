#!/usr/bin/env sh
set -eu

COMMIT=0
PUSH=0
DRY_RUN=0
MESSAGE="config: sync gentle-pi npm setup"

usage() {
  cat <<'USAGE'
Usage: scripts/sync-gentle-pi-config.sh [options]

Stage public-safe Pi agent config files for the gentle-pi + tintinweb setup.

Options:
  --commit           Commit staged files after validation
  --push             Push origin HEAD after committing (implies --commit)
  -m, --message MSG  Commit message
  --dry-run          Print actions without changing git index
  -h, --help         Show this help

This script intentionally does NOT stage ignored/local secret files such as:
settings.json, auth.json, mcp.json, models.json, trust.json, sessions, caches,
logs, node_modules, or package clone directories.
USAGE
}

log() { printf '==> %s\n' "$*"; }

quote_command() {
  printf '+ '
  for arg in "$@"; do
    printf "'%s' " "$(printf '%s' "$arg" | sed "s/'/'\\''/g")"
  done
  printf '\n'
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    quote_command "$@"
  else
    "$@"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --commit) COMMIT=1; shift ;;
    --push) PUSH=1; COMMIT=1; shift ;;
    -m|--message)
      [ "$#" -ge 2 ] || { echo "missing message" >&2; exit 2; }
      MESSAGE=$2
      shift 2
      ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

git rev-parse --is-inside-work-tree >/dev/null

stage_if_exists() {
  for path in "$@"; do
    if [ -e "$path" ]; then
      run git add -- "$path"
    fi
  done
}

log "Staging public-safe gentle-pi/tintinweb config"
stage_if_exists \
  README.md \
  settings.example.json \
  scripts/sync-gentle-pi-config.sh \
  extensions/sdd-tintinweb-fix.ts \
  npm/package.json \
  npm/package-lock.json \
  gentle-ai/support/sdd-status-contract.md \
  gentle-ai/support/strict-tdd.md \
  gentle-ai/support/strict-tdd-verify.md \
  chains/4r-review.chain.md \
  chains/sdd-full.chain.md \
  chains/sdd-plan.chain.md \
  chains/sdd-verify.chain.md

for file in agents/sdd-*.md agents/jd-*.md agents/review-*.md; do
  [ -e "$file" ] || continue
  run git add -- "$file"
done

log "Staged diff summary"
git diff --cached --stat

log "Checking staged diff"
git diff --cached --check

log "Verifying no forbidden local files are staged"
FORBIDDEN='(^|/)(settings|auth|mcp|models|trust)\.json$|(^|/)sessions/|(^|/)npm/node_modules/|(^|/)git/'
if git diff --cached --name-only | grep -E "$FORBIDDEN" >/dev/null; then
  echo "Forbidden local/secret/runtime file staged:" >&2
  git diff --cached --name-only | grep -E "$FORBIDDEN" >&2
  exit 1
fi

if [ "$COMMIT" -eq 1 ]; then
  if git diff --cached --quiet; then
    log "Nothing staged; no commit created"
  else
    log "Committing"
    run git commit -m "$MESSAGE"
  fi
fi

if [ "$PUSH" -eq 1 ]; then
  log "Pushing"
  run git push origin HEAD
fi

log "Done"
