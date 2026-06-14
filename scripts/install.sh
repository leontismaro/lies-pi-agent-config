#!/usr/bin/env sh
set -eu

TARGET_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
INSTALL_PI=1
INSTALL_PACKAGES=1
DRY_RUN=0
FORCE=0
REPO_URL="${PI_AGENT_CONFIG_REPO:-https://github.com/leontismaro/lies-pi-agent-config.git}"
REPO_REF="${PI_AGENT_CONFIG_REF:-}"
BOOTSTRAPPED=0

SCRIPT_PATH="$0"
case "$SCRIPT_PATH" in
  /*) SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd) ;;
  */*) SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$PWD/$SCRIPT_PATH")" && pwd) ;;
  *) SCRIPT_DIR="" ;;
esac

if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/.." ]; then
  REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
else
  REPO_ROOT=""
fi

usage() {
  cat <<'USAGE'
Usage: scripts/install.sh [options]

Install Pi itself, then restore this repository's public-safe Pi agent config.

Local usage after cloning:
  ./scripts/install.sh

Remote usage from a public GitHub repository:
  curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/<ref>/scripts/install.sh \
    | sh -s -- --repo https://github.com/<owner>/<repo>.git

Options:
  --repo URL         Git repository to clone when the script is run through curl/stdin
  --ref REF          Branch, tag, or commit to checkout after cloning
  --target DIR       Pi agent config directory. Default: $PI_AGENT_DIR or ~/.pi/agent
  --skip-pi          Do not install/update the global pi CLI
  --skip-packages    Do not install package dependencies or reconcile Pi packages
  --force            Overwrite existing non-secret config files in the target directory
  --dry-run          Print planned actions without changing files
  -h, --help         Show this help

This script never copies known secret-bearing files such as models.json, mcp.json,
auth.json, trust.json, sessions, logs, or runtime caches.

USAGE
}

log() {
  printf '==> %s\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

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

copy_file() {
  src=$1
  dest=$2

  if [ ! -e "$src" ]; then
    return 0
  fi

  if [ -e "$dest" ] && [ "$FORCE" -ne 1 ]; then
    warn "Keeping existing $dest. Use --force to overwrite."
    return 0
  fi

  run mkdir -p "$(dirname -- "$dest")"
  run cp "$src" "$dest"
}

copy_dir_contents() {
  src=$1
  dest=$2

  if [ ! -d "$src" ]; then
    return 0
  fi

  run mkdir -p "$dest"

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ rsync -a --delete '\''%s/'\'' '\''%s/'\''\n' "$src" "$dest"
  else
    rsync -a --delete "$src/" "$dest/"
  fi
}

require_command() {
  command_name=$1
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'ERROR: required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
}

is_local_checkout() {
  [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT" ] && [ -d "$REPO_ROOT/scripts" ] && { [ -d "$REPO_ROOT/agents" ] || [ -f "$REPO_ROOT/settings.json" ]; }
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      REPO_URL=${2:-}
      if [ -z "$REPO_URL" ]; then
        printf 'ERROR: --repo requires a URL\n' >&2
        exit 1
      fi
      shift 2
      ;;
    --ref)
      REPO_REF=${2:-}
      if [ -z "$REPO_REF" ]; then
        printf 'ERROR: --ref requires a branch, tag, or commit\n' >&2
        exit 1
      fi
      shift 2
      ;;
    --target)
      TARGET_DIR=${2:-}
      if [ -z "$TARGET_DIR" ]; then
        printf 'ERROR: --target requires a directory\n' >&2
        exit 1
      fi
      shift 2
      ;;
    --skip-pi)
      INSTALL_PI=0
      shift
      ;;
    --skip-packages)
      INSTALL_PACKAGES=0
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --bootstrapped)
      BOOTSTRAPPED=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'ERROR: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! is_local_checkout; then
  if [ -z "$REPO_URL" ]; then
    printf 'ERROR: repository files were not found.\n' >&2
    printf 'When running through curl, pass --repo https://github.com/<owner>/<repo>.git\n' >&2
    exit 1
  fi

  require_command git
  tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-agent-config.XXXXXX")
  cleanup() {
    rm -rf "$tmp_dir"
  }
  trap cleanup EXIT INT TERM

  log "Cloning config repository"
  if [ "$DRY_RUN" -eq 1 ]; then
    quote_command git clone --depth 1 "$REPO_URL" "$tmp_dir"
  else
    git clone --depth 1 "$REPO_URL" "$tmp_dir"
  fi

  if [ -n "$REPO_REF" ]; then
    log "Checking out $REPO_REF"
    if [ "$DRY_RUN" -eq 1 ]; then
      quote_command git -C "$tmp_dir" fetch --depth 1 origin "$REPO_REF"
      quote_command git -C "$tmp_dir" checkout FETCH_HEAD
    else
      git -C "$tmp_dir" fetch --depth 1 origin "$REPO_REF"
      git -C "$tmp_dir" checkout FETCH_HEAD
    fi
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log "Dry run stops before re-entering cloned installer"
    exit 0
  fi

  set -- "$tmp_dir/scripts/install.sh" --target "$TARGET_DIR"
  if [ "$INSTALL_PI" -eq 0 ]; then
    set -- "$@" --skip-pi
  fi
  if [ "$INSTALL_PACKAGES" -eq 0 ]; then
    set -- "$@" --skip-packages
  fi
  if [ "$FORCE" -eq 1 ]; then
    set -- "$@" --force
  fi

  sh "$@"
  exit $?
fi

if [ -z "$TARGET_DIR" ] || [ "$TARGET_DIR" = "/" ]; then
  printf 'ERROR: refusing to install into an empty or root target\n' >&2
  exit 1
fi

require_command npm
require_command rsync

if [ "$INSTALL_PI" -eq 1 ]; then
  log "Installing or updating Pi CLI"
  run npm install -g --ignore-scripts @earendil-works/pi-coding-agent
else
  log "Skipping Pi CLI installation"
fi

log "Restoring public-safe config into $TARGET_DIR"
run mkdir -p "$TARGET_DIR"

copy_dir_contents "$REPO_ROOT/agents" "$TARGET_DIR/agents"
copy_dir_contents "$REPO_ROOT/chains" "$TARGET_DIR/chains"
copy_dir_contents "$REPO_ROOT/extensions" "$TARGET_DIR/extensions"
copy_dir_contents "$REPO_ROOT/gentle-ai" "$TARGET_DIR/gentle-ai"
copy_dir_contents "$REPO_ROOT/openspec" "$TARGET_DIR/openspec"

copy_file "$REPO_ROOT/settings.example.json" "$TARGET_DIR/settings.json"
copy_file "$REPO_ROOT/keybindings.json" "$TARGET_DIR/keybindings.json"
copy_file "$REPO_ROOT/zentui.json" "$TARGET_DIR/zentui.json"
copy_file "$REPO_ROOT/models.example.json" "$TARGET_DIR/models.example.json"

if [ ! -e "$TARGET_DIR/models.json" ] && [ -e "$REPO_ROOT/models.example.json" ]; then
  log "Creating local models.json from models.example.json"
  copy_file "$REPO_ROOT/models.example.json" "$TARGET_DIR/models.json"
else
  warn "Not touching existing $TARGET_DIR/models.json"
fi

if [ "$INSTALL_PACKAGES" -eq 1 ]; then
  if [ -f "$REPO_ROOT/npm/package.json" ]; then
    log "Installing package dependencies into $TARGET_DIR/npm"
    run mkdir -p "$TARGET_DIR/npm"
    copy_file "$REPO_ROOT/npm/package.json" "$TARGET_DIR/npm/package.json"
    copy_file "$REPO_ROOT/npm/package-lock.json" "$TARGET_DIR/npm/package-lock.json"
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '+ npm --prefix '\''%s'\'' ci --omit=dev --legacy-peer-deps\n' "$TARGET_DIR/npm"
    else
      if [ -f "$TARGET_DIR/npm/package-lock.json" ]; then
        npm --prefix "$TARGET_DIR/npm" ci --omit=dev --legacy-peer-deps
      else
        npm --prefix "$TARGET_DIR/npm" install --omit=dev --legacy-peer-deps
      fi
    fi
  fi

  if command -v pi >/dev/null 2>&1; then
    log "Reconciling Pi packages from settings.json"
    run pi update --extensions
  else
    warn "pi command not found after installation; skipping pi update --extensions"
  fi
else
  log "Skipping package installation"
fi

log "Done. Edit $TARGET_DIR/models.json locally with real credentials before launching pi."
