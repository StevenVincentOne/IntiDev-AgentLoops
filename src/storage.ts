import { ProjectConfig } from "./types";
import { StateBackend, FilesystemStateBackend } from "./backend";
import { PgClient, PostgresStateBackend } from "./postgres";

export interface BackendSelection {
  backend: StateBackend;
  kind: "filesystem" | "postgres";
  /** Release any held resources (e.g. close the Postgres pool). */
  dispose(): Promise<void>;
}

export interface ResolveBackendOptions {
  cwd: string;
  config: ProjectConfig;
  /** Explicit connection string; overrides env and config. */
  databaseUrl?: string;
}

/** Connection string precedence: explicit arg → `DATABASE_URL` env → config. */
export function resolvePostgresUrl(options: ResolveBackendOptions): string | undefined {
  return options.databaseUrl ?? process.env.DATABASE_URL ?? options.config.storage?.databaseUrl;
}

/**
 * Pick a `StateBackend` for the CLI/MCP: Postgres when a connection string is
 * configured, otherwise the filesystem. `pg` is loaded lazily and is an optional
 * peer dependency — filesystem users never need it.
 */
export async function resolveBackend(options: ResolveBackendOptions): Promise<BackendSelection> {
  const url = resolvePostgresUrl(options);
  if (!url) {
    return {
      backend: new FilesystemStateBackend(options.cwd),
      kind: "filesystem",
      dispose: async () => {},
    };
  }
  const { client, end } = await connectPostgres(url);
  return { backend: new PostgresStateBackend(client), kind: "postgres", dispose: end };
}

async function connectPostgres(
  connectionString: string,
): Promise<{ client: PgClient; end: () => Promise<void> }> {
  let mod: typeof import("pg");
  try {
    mod = await import("pg");
  } catch {
    throw new Error(
      "Postgres backend selected (DATABASE_URL or storage.databaseUrl is set) but the 'pg' package is not installed. Install it with: npm install pg",
    );
  }
  const pool = new mod.Pool({ connectionString });
  return { client: pool as unknown as PgClient, end: () => pool.end() };
}
