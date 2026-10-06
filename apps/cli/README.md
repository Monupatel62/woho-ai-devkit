# @woho/cli

The first usable WoHo AI developer product: a local, read-only project agent built on the existing WoHo AI DevKit packages.

## Run

```bash
pnpm --filter @woho/cli build
OPENAI_API_KEY=... node apps/cli/dist/index.js "analyze this project and find the main architecture"
```

Windows PowerShell:

```powershell
$env:OPENAI_API_KEY="..."
pnpm --filter @woho/cli build
node apps/cli/dist/index.js "analyze this project and find the main architecture"
```

Use `--root <path>` to inspect another local project.

## Security boundary

This first release is intentionally read-only. Project scope is fixed to the selected root and the agent permission policy allows only `file:read`. File writes, deletes, moves, shell commands, and implicit environment inheritance are not enabled.

The next execution layer can add explicit owner approval for mutations, command allowlists, test execution, git operations, and persistent execution history.
