# Contributing

Thanks for helping improve IntiDev AgentLoops.

1. Keep changes scoped and configuration-driven.
2. Extend via `agentloop.config.json` when behavior is project policy.
3. Add or update docs whenever CLI behavior changes.
4. Include reproducible command output in PR descriptions.

## Local development

```bash
npm install
npm run build
npm run hooks:install
npm run cli -- init
npm run cli -- create --title "Example ticket" --summary "Example symptom" --family "reader_rendering"
```

## Security hygiene

- Run `npm run pre-push:scan` before pushing major changes (uses `gitleaks` when available, with a fallback regex scan).
- Install the project hooks once: `npm run hooks:install`.
  This enables `.githooks/pre-push` to block pushes if secrets are detected.

## Design priorities

- keep the loop durable
- preserve a stable audit trail
- make handoff prompts deterministic
- prefer small, explicit schemas over implicit inference
