import { ProjectConfig, RedactionRule, TicketRedactor } from "./types";

/** Identity redactor — stores content unchanged. The default. */
export const noopRedactor: TicketRedactor = {
  redactText: (value) => value,
  redactJson: (value) => value,
};

/**
 * Build a redactor from a list of regex rules. Each rule's pattern is replaced
 * with its `replacement` (default `[redacted]`). `redactJson` walks structures
 * and redacts every string leaf.
 */
export function createPatternRedactor(rules: RedactionRule[]): TicketRedactor {
  const compiled = rules.map((rule) => ({
    regex: new RegExp(rule.pattern, rule.flags ?? "g"),
    replacement: rule.replacement ?? "[redacted]",
  }));

  const redactText = (value: string): string => {
    let out = value;
    for (const { regex, replacement } of compiled) {
      regex.lastIndex = 0;
      out = out.replace(regex, replacement);
    }
    return out;
  };

  const redactJson = (value: unknown): unknown => {
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map(redactJson);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        out[key] = redactJson(val);
      }
      return out;
    }
    return value;
  };

  return { redactText, redactJson };
}

/**
 * Resolve the redactor to use: an explicit override wins; otherwise build one
 * from `config.redaction.patterns`; otherwise the no-op redactor.
 */
export function resolveRedactor(
  config: ProjectConfig,
  override?: TicketRedactor,
): TicketRedactor {
  if (override) return override;
  const rules = config.redaction?.patterns;
  if (rules && rules.length > 0) return createPatternRedactor(rules);
  return noopRedactor;
}
