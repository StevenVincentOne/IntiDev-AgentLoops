# Storage backends (filesystem & Postgres)

`AgentLoopStore` holds the whole ledger in memory and delegates persistence to a
`StateBackend`, so the same domain logic (tickets, patterns, audits, prior art)
runs over different stores:

| Backend | Use |
| --- | --- |
| `FilesystemStateBackend` (default) | JSON at `<cwd>/.agentloops/state.json` |
| `MemoryStateBackend` | ephemeral; tests and short-lived processes |
| `PostgresStateBackend` | a relational `ticket_*` schema in Postgres |

```ts
import { AgentLoopStore, MemoryStateBackend } from "@stevenvincentone/intidev-agentloops";

const store = new AgentLoopStore(process.cwd(), config, { backend: new MemoryStateBackend() });
```

## Postgres

`PostgresStateBackend` brings **no `pg` dependency** — you inject a client that
matches `pg.Pool`/`pg.Client` (`{ query(text, params) => Promise<{ rows }> }`).

```ts
import { Pool } from "pg";
import { AgentLoopStore, PostgresStateBackend } from "@stevenvincentone/intidev-agentloops";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const backend = new PostgresStateBackend(pool);
await backend.migrate(); // optional; load()/save() also create the schema on first use

const store = new AgentLoopStore("", config, { backend });
```

- Saves are **transactional** (whole-snapshot replace), so a failed write never
  leaves a partially-updated ledger. A `pg.Pool` is used via a single dedicated
  connection per operation.
- Schema is created with `CREATE TABLE IF NOT EXISTS`, so `migrate()` is safe to
  run repeatedly.

### Public schema

The canonical relational schema is exported as `TICKET_SCHEMA_SQL`:

- `loop_meta` — single row of top-level ledger state (project, sequences)
- `ticket_patterns`, `ticket_pattern_links` — patterns and their members
- `tickets`, `ticket_aliases`, `ticket_tags`, `ticket_notes`

Timestamps are stored as ISO text to keep round-trips identical to the JSON
backend. `serializeState` / `deserializeRows` are exported pure mappers between
`LoopState` and these rows.

### Running the Postgres tests

The Postgres integration test is skipped unless `DATABASE_URL` is set:

```bash
docker run -d --name agentloops-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=agentloops -p 55432:5432 postgres:16
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/agentloops npm test
```

CI runs it automatically against a `postgres:16` service container.
