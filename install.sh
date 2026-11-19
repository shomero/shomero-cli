#!/usr/bin/env bash
# Installs the shomero CLI for the current user:
#   curl -fsSL https://github.com/shomero/shomero-cli/releases/latest/download/install.sh | bash
# Pin a version with SHOMERO_VERSION=v0.1.0.
set -euo pipefail

main() {
  local releases="https://github.com/shomero/shomero-cli/releases"
  local version="${SHOMERO_VERSION:-latest}"
  local default_url="$releases/download/$version"
  [ "$version" = "latest" ] && default_url="$releases/latest/download"
  local base_url="${SHOMERO_CLI_BASE_URL:-$default_url}"
  local install_dir="${SHOMERO_INSTALL_DIR:-$HOME/.shomero/bin}"
  local target="$install_dir/shomero"
  local script="$install_dir/shomero.mjs"

  say() { printf '%s\n' "$*"; }
  fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

  command -v node >/dev/null 2>&1 || fail "Node.js 18 or newer is required. Install it from https://nodejs.org, then run this again."
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 18 ] || fail "Node.js 18 or newer is required (found $(node --version))."
  command -v git >/dev/null 2>&1 || fail "git is required to fetch the skills."

  mkdir -p "$install_dir"
  local tmp
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  if [ -n "${SHOMERO_CLI_FILE:-}" ]; then
    cp "$SHOMERO_CLI_FILE" "$tmp"
  else
    if ! curl -fsSL "$base_url/shomero.mjs" -o "$tmp" 2>/dev/null; then
      command -v gh >/dev/null 2>&1 || fail "Could not download $base_url/shomero.mjs"
      local tag=()
      [ "$version" = "latest" ] || tag=("$version")
      gh release download ${tag[@]+"${tag[@]}"} -R shomero/shomero-cli -p shomero.mjs -O "$tmp" --clobber \
        || fail "Could not download shomero.mjs, with curl or with your gh login."
    fi
  fi
  head -n 1 "$tmp" | grep -q '^#!/usr/bin/env node' || fail "The download isn't the shomero CLI."
  mv "$tmp" "$script"
  chmod +x "$script"
  ln -sf "$script" "$target"
  trap - EXIT

  local on_path=""
  case ":$PATH:" in *":$install_dir:"*) on_path=1 ;; esac
  if [ -z "$on_path" ] && [ -z "${SHOMERO_NO_MODIFY_PATH:-}" ] && [ -d "$HOME/.local/bin" ] && case ":$PATH:" in *":$HOME/.local/bin:"*) true ;; *) false ;; esac; then
    ln -sf "$target" "$HOME/.local/bin/shomero"
    on_path=1
  fi
  if [ -z "$on_path" ] && [ -z "${SHOMERO_NO_MODIFY_PATH:-}" ]; then
    local rc line
    case "${SHELL##*/}" in
      zsh) rc="$HOME/.zshrc"; line="export PATH=\"$install_dir:\$PATH\"" ;;
      bash) rc="$HOME/.bashrc"; [ "$(uname)" = "Darwin" ] && rc="$HOME/.bash_profile"; line="export PATH=\"$install_dir:\$PATH\"" ;;
      fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path \"$install_dir\"" ;;
      *) rc="$HOME/.profile"; line="export PATH=\"$install_dir:\$PATH\"" ;;
    esac
    mkdir -p "$(dirname "$rc")"
    grep -qsF "$install_dir" "$rc" || printf '\n# shomero\n%s\n' "$line" >> "$rc"
    say "✓ Added $install_dir to your PATH in $rc. Open a new terminal, or run: $line"
  fi

  local installed
  installed="$("$target" --version 2>&1)" || fail "shomero was installed but does not run: $installed"
  say "✓ shomero $installed installed at $target"
  say ""
  say "Next: cd into your project and run"
  say "  shomero add all"
}

main "$@"
