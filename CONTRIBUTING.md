# Contributing

Thanks for helping improve kbx. The best contributions are focused, reproducible, and easy for another maintainer to validate.

## Local Setup

1. Install Node.js 20.19 or newer.
2. Install dependencies:

```powershell
npm ci
```

3. Run the CLI in development:

```powershell
$env:KBX_EMBEDDER='hash'
npm run dev -- --help
```

The hash embedder is deterministic and avoids model downloads during development.

## Required Checks

Run before opening a PR:

```powershell
npm run typecheck
$env:KBX_EMBEDDER='hash'; npm test
npm run build
npm pack --dry-run
```

Use a real Transformers.js model for at least one manual smoke test when changing embedding, indexing, search, or model-selection behavior.

## Issues

- Use the bug template for reproducible problems.
- Include kbx version, Node.js version, OS, command output, and a minimal file tree when possible.
- Use the feature template for product ideas and describe the workflow problem first.
- Do not report security vulnerabilities in public issues. Follow [SECURITY.md](./SECURITY.md).

## PR Title Convention

Use Conventional Commit style:

- `feat(cli): add import status command`
- `fix(indexer): preserve stats after failed model switch`
- `docs(readme): document MCP setup`

Allowed types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.

## Commit And PR Quality

- Keep PRs focused and reviewable.
- Update README, command help, or docs when behavior changes.
- Add tests for behavior changes and edge cases.
- Avoid mixing formatting-only churn with feature or bug-fix changes.
