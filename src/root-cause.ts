/**
 * Root Cause Certificate — deterministic guardrails for meaningful fixed-bug resolutions.
 *
 * Problem: an agent can close a meaningful bug with a summary and some verification
 * output, but without ever making an explicit architectural claim about why the code
 * was wrong, what invariant broke, or why the fix is at the right layer. That claim
 * lives only in the transcript, where future agents won't find it.
 *
 * Solution: for `kind: bug | incident | user_feedback` resolutions (configurable via
 * `ProjectConfig.rootCause.meaningfulKinds`), require a structured `rootCauseCertificate`
 * alongside the resolution summary. Deterministic rules check the certificate is
 * present and that required fields are not TODO-placeholders or too short to be
 * actionable; the agent remains responsible for the diagnosis being architecturally
 * correct — no rule can verify that.
 *
 * The certificate is intentionally not a "root-cause oracle". It is a required
 * reasoning surface: the ledger checks that the agent made the claim, not that the
 * claim is right.
 *
 * Generate a scaffold: `agentloop evidence-draft <id> --evidence-only`
 */

import { ProjectConfig, ResolveInput, RootCauseCertificate, Ticket, TicketKind } from "./types";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default ticket kinds that require a Root Cause Certificate on resolution. */
export const DEFAULT_ROOT_CAUSE_KINDS: TicketKind[] = ["bug", "incident", "user_feedback"];

/** Minimum character length for a text field to be considered actionable. */
export const MIN_CERTIFICATE_FIELD_LENGTH = 20;

/** Minimum character length for the regression-risk field (short values like "low" are fine). */
const MIN_RISK_FIELD_LENGTH = 3;

/** Pattern matching placeholder text that must not appear in an actionable certificate. */
const PLACEHOLDER_RE = /\bTODO\b|replace\s*me\b|unknown_or_not_applicable/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if `value` is long enough and does not contain placeholder text.
 * `minLength` defaults to `MIN_CERTIFICATE_FIELD_LENGTH`.
 */
export function certificateFieldIsActionable(value: string, minLength = MIN_CERTIFICATE_FIELD_LENGTH): boolean {
  const trimmed = value.trim();
  if (trimmed.length < minLength) return false;
  if (PLACEHOLDER_RE.test(trimmed)) return false;
  return true;
}

// ── Gate: does this ticket require a certificate? ─────────────────────────────

/**
 * Returns true when resolving `ticket` requires a `RootCauseCertificate`.
 * Gated on ticket `kind` matching `ProjectConfig.rootCause.meaningfulKinds`
 * (defaults to `["bug","incident","user_feedback"]`).
 */
export function requiresRootCauseCertificate(ticket: Ticket, config: ProjectConfig): boolean {
  const meaningfulKinds: readonly TicketKind[] =
    config.rootCause?.meaningfulKinds ?? DEFAULT_ROOT_CAUSE_KINDS;
  // Opt-out: empty array means no certificate required.
  if (meaningfulKinds.length === 0) return false;
  return (meaningfulKinds as TicketKind[]).includes(ticket.kind);
}

// ── Assertion (throws on failure) ─────────────────────────────────────────────

/**
 * Validates `input.rootCauseCertificate` for a resolution that requires one.
 * A no-op when the ticket kind does not require a certificate
 * (`requiresRootCauseCertificate` returns false).
 *
 * Throws a descriptive `Error` for each failure mode:
 * - Missing certificate entirely
 * - Required text fields absent or too short (< `minFieldLength`)
 * - Required text fields contain TODO/placeholder text
 * - `filesChanged` array absent or entirely composed of placeholder entries
 */
export function assertRootCauseCertificateForResolution(
  ticket: Ticket,
  input: Pick<ResolveInput, "rootCauseCertificate">,
  config: ProjectConfig,
): void {
  if (!requiresRootCauseCertificate(ticket, config)) return;

  const cert: RootCauseCertificate | undefined = input.rootCauseCertificate;
  const minLength = config.rootCause?.minFieldLength ?? MIN_CERTIFICATE_FIELD_LENGTH;

  const help = [
    `${ticket.id}: resolving a ${ticket.kind} ticket requires a rootCauseCertificate.`,
    "Required fields: symptom, rootCause, earliestFailureStage, whySourceLevelFixOrWhyNot,",
    "  affectedContractOrInvariant, filesChanged, guardDecision, regressionRisk.",
    `Generate a scaffold: agentloop evidence-draft ${ticket.id} --evidence-only`,
  ].join("\n");

  if (!cert) throw new Error(help);

  // Required text fields (all must be actionable — non-placeholder, >= minLength).
  const textFields: Array<{ label: string; value: string; min?: number }> = [
    { label: "symptom", value: cert.symptom ?? "" },
    { label: "rootCause", value: cert.rootCause ?? "" },
    { label: "earliestFailureStage", value: cert.earliestFailureStage ?? "" },
    { label: "whySourceLevelFixOrWhyNot", value: cert.whySourceLevelFixOrWhyNot ?? "" },
    { label: "affectedContractOrInvariant", value: cert.affectedContractOrInvariant ?? "" },
    { label: "guardDecision", value: cert.guardDecision ?? "" },
    { label: "regressionRisk", value: cert.regressionRisk ?? "", min: MIN_RISK_FIELD_LENGTH },
  ];

  const missing: string[] = [];
  for (const { label, value, min } of textFields) {
    if (!certificateFieldIsActionable(value, min ?? minLength)) missing.push(label);
  }

  // filesChanged: must have at least one non-placeholder entry.
  const files = Array.isArray(cert.filesChanged) ? cert.filesChanged : [];
  const actionableFiles = files.filter(
    (f) => typeof f === "string" && f.trim() && !PLACEHOLDER_RE.test(f),
  );
  if (actionableFiles.length === 0) missing.push("filesChanged");

  if (missing.length > 0) {
    throw new Error(
      `${ticket.id}: rootCauseCertificate is missing or has TODO placeholders in: ${missing.join(", ")}.\n`
      + "Do not leave placeholder values. Each field should state the actual architectural claim.\n"
      + `Generate a scaffold: agentloop evidence-draft ${ticket.id} --evidence-only`,
    );
  }
}
