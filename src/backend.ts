import { promises as fs, existsSync } from "node:fs";
import { join } from "node:path";
import { LoopState } from "./types";

/**
 * Persistence port for the ledger. `AgentLoopStore` holds the whole `LoopState`
 * in memory and delegates loading/saving to a backend, so the same domain logic
 * runs over the filesystem, an in-memory store, or Postgres.
 */
export interface StateBackend {
  /** Return the persisted state, or null if nothing has been stored yet. */
  load(): Promise<LoopState | null>;
  /** Persist the full state snapshot. */
  save(state: LoopState): Promise<void>;
  /** Optional one-time setup (e.g. create schema). No-op for filesystem/memory. */
  migrate?(): Promise<void>;
}

/** Default backend: JSON at `<cwd>/.agentloops/state.json`. */
export class FilesystemStateBackend implements StateBackend {
  private readonly dirPath: string;
  private readonly statePath: string;

  constructor(cwd: string, dir = ".agentloops", fileName = "state.json") {
    this.dirPath = join(cwd, dir);
    this.statePath = join(this.dirPath, fileName);
  }

  async load(): Promise<LoopState | null> {
    if (!existsSync(this.statePath)) return null;
    const text = await fs.readFile(this.statePath, "utf-8");
    return JSON.parse(text) as LoopState;
  }

  async save(state: LoopState): Promise<void> {
    await fs.mkdir(this.dirPath, { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2), "utf-8");
  }
}

/** Ephemeral backend, handy for tests and short-lived processes. */
export class MemoryStateBackend implements StateBackend {
  private state: LoopState | null;

  constructor(initial: LoopState | null = null) {
    this.state = initial ? structuredClone(initial) : null;
  }

  async load(): Promise<LoopState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: LoopState): Promise<void> {
    this.state = structuredClone(state);
  }
}
