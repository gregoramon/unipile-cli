# Repository Agent Rules

## Branching

- Never implement features or fixes directly on `main`.
- Always create a dedicated branch first:
  - feature work: `codex/feature-...`
  - bug fixes: `codex/fix-...`
- Open a PR and merge via PR workflow.

## CodeRabbit Compatibility

- Keep docstring coverage high by adding concise JSDoc comments for newly added or changed functions/classes.
- Prefer fixing CodeRabbit findings in-branch before merge.
