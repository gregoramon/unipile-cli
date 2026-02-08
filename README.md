# unipile-cli

Headless-safe CLI for Unipile messaging workflows (WhatsApp, Instagram, LinkedIn, and more).

## Design goals

- Work without OpenClaw installed.
- Use only Unipile DSN + API key for auth.
- Keep contact search robust in automation mode.
- Use OpenClaw QMD optionally for better recipient ranking.

## Runtime

- Node `>=22.12.0`

## Install

```bash
npm install
npm run build
npm link
```

## Auth setup

```bash
unipile auth set --dsn <YOUR_UNIPILE_DSN> --api-key <YOUR_KEY>
unipile auth status
```

Get `<YOUR_UNIPILE_DSN>` from your Unipile dashboard/API settings. Do not assume a fixed host/port.

## Core commands

```bash
unipile accounts list
unipile contacts search --account-id <ACCOUNT_ID> --query "john sales"
unipile contacts resolve --account-id <ACCOUNT_ID> --query "john sales"
unipile send --account-id <ACCOUNT_ID> --to-query "john sales" --text "Hello"
unipile inbox pull --account-id <ACCOUNT_ID> --chat-id <CHAT_ID> --non-interactive
unipile inbox watch --account-id <ACCOUNT_ID> --chat-id <CHAT_ID> --interval-seconds 20 --max-iterations 3 --non-interactive
unipile doctor run --account-id <ACCOUNT_ID>
```

## Automation behavior

Use `--non-interactive` to force prompt-free behavior.

- If recipient resolution is high confidence, `send` proceeds.
- If resolution is ambiguous or not found, `send` exits with code `2` and returns candidate details.

Use `--output json` only when deterministic field parsing is needed in toolchains.

`inbox watch` is poll-based and headless-safe:

- emits newly seen messages per poll
- supports scoped polling with `--chat-id` and/or `--sender-id`
- persists cursor + dedupe state in local sqlite by default
- supports `--once` for one-shot checks
- supports `--max-iterations <n>` for bounded runs
- supports `--no-state` for stateless one-off polling

`doctor run` is the end-to-end readiness check:

- validates DSN + API key availability
- validates `/api/v1/accounts` access
- optionally validates attendee/chat endpoints for a specific account
- validates QMD query path (warns if unavailable, does not hard-fail MVP)

## Stateful inbox storage

Inbound polling stores state locally to avoid duplicate reprocessing:

- sqlite database: `~/.config/unipile-cli/inbox.db`
- stores:
  - per-scope cursor (`since`) for incremental pulls
  - per-scope seen message ids for idempotent watch loops
  - full message payload JSON for historical context/debugging

Scope keys are built from profile + account + chat/sender filters and are provider-agnostic.
This applies to all connected Unipile messaging providers (including WhatsApp, Instagram, and LinkedIn) because polling uses shared messaging endpoints.

Useful flags:

```bash
--chat-id <CHAT_ID[,CHAT_ID2]>
--sender-id <SENDER_ID>
--state-key <CUSTOM_SCOPE_NAME>
--reset-state
--no-state
--max-pages <N>
```

## Optional QMD integration

QMD is query-only in this CLI.

- No custom semantic database is created by this project.
- CLI calls existing `qmd query` if available.
- If QMD is unavailable, lexical + recency ranking still works.

Configure defaults per profile in `auth set`:

```bash
unipile auth set \
  --dsn <YOUR_UNIPILE_DSN> \
  --api-key <YOUR_KEY> \
  --qmd-command qmd \
  --qmd-collection memory-root
```

If OpenClaw/QMD runs on another machine (for example, a Mac mini), use the SSH proxy script:

```bash
export UNIPILE_QMD_SSH_TARGET=user@mac-mini.local
export UNIPILE_QMD_SSH_OPTS="-i ~/.ssh/id_ed25519"

unipile auth set \
  --dsn <YOUR_UNIPILE_DSN> \
  --api-key <YOUR_KEY> \
  --qmd-command /Users/gregoramon/coding/unipile/scripts/qmd-ssh-proxy.sh \
  --qmd-collection memory-root
```

When you need maximum reliability and no semantic enrichment, disable QMD per call:

```bash
unipile send --account-id <ACCOUNT_ID> --to-query "john sales" --text "Hello" --no-qmd --non-interactive
```

## Branch workflow + CodeRabbit

Never develop directly on `main`. Always create a feature/fix branch and open a PR.

```bash
git checkout -b codex/feature-my-change
npm run coderabbit:status
npm run coderabbit:review
```

If not logged in yet:

```bash
coderabbit auth login
```

## Security notes

- API key storage backend:
  - keychain (if optional `keytar` is available)
  - file fallback at `~/.config/unipile-cli/secrets.json` with mode `0600`
- DSN and non-secret settings are stored in `~/.config/unipile-cli/config.json`.
- Provider credentials are never handled by this CLI.
