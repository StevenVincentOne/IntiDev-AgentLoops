# Architecture

IntiDev AgentLoops is organized around a tiny local persistence and CLI layer:

## Core primitives

- `src/store.ts`
  - owns durable state in `.agentloops/state.json`
  - manages create/list/update transitions
  - maintains ticket aliases and simple pattern grouping
- `src/config.ts`
  - project-level config schema and defaults
  - alias mapping and required fields
- `src/cli.ts`
  - command parser and user-facing workflows
- `agentloop.config.json`
  - local configuration created from template

## Extensibility points

- ticket kinds and aliases can be customized in config
- custom required fields are represented through `requiredFields` per kind
- patterns currently group by family; teams can replace that in a fork or add source-level adapters

## Planned extraction roadmap

1. add MCP read-only tools for dashboard integrations,
2. add pluggable storage adapters (SQLite/Postgres/HTTP API),
3. add source adapters (Sentry, GitHub, Linear, Jira),
4. split CLI/API/SDK packages.
