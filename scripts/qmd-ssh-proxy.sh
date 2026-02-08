#!/usr/bin/env bash
set -euo pipefail

# Drop-in wrapper for running qmd on a remote machine over SSH.
# This script preserves qmd CLI arguments so it can be used as:
#   unipile auth set --qmd-command /abs/path/scripts/qmd-ssh-proxy.sh ...

: "${UNIPILE_QMD_SSH_TARGET:?Set UNIPILE_QMD_SSH_TARGET, e.g. user@mac-mini.local}"

REMOTE_QMD_BIN="${UNIPILE_QMD_BIN:-qmd}"
SSH_ARGS=()

if [[ -n "${UNIPILE_QMD_SSH_OPTS:-}" ]]; then
  # Intentional word splitting so callers can pass multiple ssh args.
  # Example: UNIPILE_QMD_SSH_OPTS="-i ~/.ssh/id_ed25519 -p 22"
  # shellcheck disable=SC2206
  SSH_ARGS=(${UNIPILE_QMD_SSH_OPTS})
fi

exec ssh "${SSH_ARGS[@]}" "${UNIPILE_QMD_SSH_TARGET}" "${REMOTE_QMD_BIN}" "$@"
