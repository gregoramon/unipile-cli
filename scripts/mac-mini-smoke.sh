#!/usr/bin/env bash
set -euo pipefail

: "${UNIPILE_DSN:?Set UNIPILE_DSN}"
: "${UNIPILE_API_KEY:?Set UNIPILE_API_KEY}"

PROFILE="${UNIPILE_PROFILE:-mac-mini}"

unipile auth set --profile "$PROFILE" --dsn "$UNIPILE_DSN" --api-key "$UNIPILE_API_KEY"
unipile --profile "$PROFILE" auth status
unipile --profile "$PROFILE" accounts list

echo "Smoke check complete."
