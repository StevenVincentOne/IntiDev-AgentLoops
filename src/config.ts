import { promises as fs } from "fs";
import { join } from "path";
import { KindConfig, ProjectConfig, TicketKind } from "./types";

export const DEFAULT_CONFIG: ProjectConfig = {
  projectName: "IntiDev AgentLoops",
  description: "Feedback Loops for Agentic Workflows",
  defaultKind: "bug",
  ticketKinds: [
    { kind: "bug", defaultSeverity: "high", requiredFields: ["summary"] },
    { kind: "feature", defaultSeverity: "medium", requiredFields: ["summary"] },
    { kind: "user_feedback", defaultSeverity: "high", requiredFields: ["summary"] },
    { kind: "investigation", defaultSeverity: "medium", requiredFields: ["summary"] },
    { kind: "incident", defaultSeverity: "critical", requiredFields: ["summary"] },
    { kind: "tech_debt", defaultSeverity: "medium", requiredFields: ["summary"] },
    { kind: "task", defaultSeverity: "medium", requiredFields: ["summary"] },
  ],
  queues: [
    { prefix: "USER", kinds: ["user_feedback"], sources: ["user_report"] },
    { prefix: "DEV", kinds: ["feature", "task", "investigation", "tech_debt"] },
    { prefix: "ISSUE", kinds: ["bug", "incident"], default: true },
  ],
  sources: ["user_report", "manual_admin", "agent", "smoke", "ci", "ingestion", "unknown"],
  patterns: {
    autoCreateByFamily: true,
    defaultFamily: "general",
  },
};

export const CONFIG_FILE_NAME = "agentloop.config.json";
export const STATE_DIR = ".agentloops";

export function configPath(cwd: string): string {
  return join(cwd, CONFIG_FILE_NAME);
}

export async function loadConfig(cwd: string): Promise<ProjectConfig> {
  try {
    const text = await fs.readFile(configPath(cwd), "utf-8");
    const parsed = JSON.parse(text);
    return mergeConfig(parsed as Partial<ProjectConfig>);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeDefaultConfig(cwd: string): Promise<ProjectConfig> {
  const path = configPath(cwd);
  await fs.writeFile(path, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
  return { ...DEFAULT_CONFIG };
}

export function requiredFields(config: ProjectConfig, kind: TicketKind): string[] {
  const k = config.ticketKinds.find((entry) => entry.kind === kind);
  return k?.requiredFields ?? [];
}

export function ensureKind(config: ProjectConfig, kind: string | undefined): TicketKind {
  const candidate = (kind ?? config.defaultKind).toLowerCase() as TicketKind;
  const has = config.ticketKinds.some((entry) => entry.kind === candidate);
  if (!has) {
    return config.defaultKind;
  }
  return candidate;
}

export function mergeConfig(partial: Partial<ProjectConfig>): ProjectConfig {
  const mergedKinds: KindConfig[] = (partial.ticketKinds ?? DEFAULT_CONFIG.ticketKinds).map(
    (kind) => ({ ...kind, defaultSeverity: kind.defaultSeverity ?? "medium" }),
  );
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    ticketKinds: mergedKinds,
    queues: partial.queues ?? DEFAULT_CONFIG.queues,
    patterns: {
      ...DEFAULT_CONFIG.patterns,
      ...(partial.patterns ?? {}),
    },
    ticketGroups: partial.ticketGroups
      ? { ...DEFAULT_CONFIG.ticketGroups, ...partial.ticketGroups }
      : DEFAULT_CONFIG.ticketGroups,
  };
}
