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
npm run cli -- init
npm run cli -- create --title "Example ticket" --summary "Example symptom" --family "reader_rendering"
```

## Design priorities

- keep the loop durable
- preserve a stable audit trail
- make handoff prompts deterministic
- prefer small, explicit schemas over implicit inference
