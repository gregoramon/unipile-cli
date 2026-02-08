---
name: unipile-cli-operator
description: Use this skill when controlling the unipile CLI to list accounts, resolve recipients, send messages, and pull inbox updates through Unipile. Use for WhatsApp, Instagram, LinkedIn, and similar providers connected in Unipile. Prefer non-interactive execution for automation and only use structured output when deterministic parsing is needed.
---

# Unipile CLI Operator

Use this skill to operate `unipile` commands safely in user or automation contexts.

## Preconditions

- Ensure Unipile account connections are managed in the Unipile dashboard.
- Ensure `unipile auth set --dsn ... --api-key ...` has been run.
- Ensure account ID is known before sending messages.
- If QMD runs on another machine, export `UNIPILE_QMD_SSH_TARGET` and use `/Users/gregoramon/coding/unipile/scripts/qmd-ssh-proxy.sh` as `--qmd-command`.

## Command Workflow

1. Check auth and available accounts.

```bash
unipile auth status
unipile accounts list
```

2. Resolve recipient candidates.

```bash
unipile contacts resolve --account-id <ACCOUNT_ID> --query "<person or alias>" --non-interactive --no-qmd
```

3. Send by `chat_id`, `attendee_id`, or `to-query`.

```bash
unipile send --account-id <ACCOUNT_ID> --to-query "<person>" --text "<message>" --non-interactive --no-qmd
```

4. Pull inbox updates.

```bash
unipile inbox pull --account-id <ACCOUNT_ID> --since <ISO8601> --non-interactive
```

## Behavior Rules

- Prefer `--non-interactive` in agent contexts.
- Handle exit code `2` from `send` as unresolved target ambiguity.
- Retry `send` with `--attendee-id` when query-based resolution is ambiguous.
- Use `--output json` only for deterministic field-level parsing.
- Prefer `--no-qmd` for deterministic fallback behavior when remote QMD is unavailable.

## QMD Usage

- Treat QMD as optional enrichment for ranking.
- QMD writes are out of scope for this skill; query-only behavior is assumed.
- Continue with lexical/recency ranking when QMD is unavailable.
- Do not assume QMD write access; it is query-oriented in this workflow.
