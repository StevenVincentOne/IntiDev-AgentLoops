/**
 * Shared test helpers for AgentLoops test suite.
 *
 * Exports a minimal but valid `RootCauseCertificate` for use in tests that
 * need to resolve bug/incident/user_feedback tickets but are not specifically
 * testing the certificate validation logic.
 */

import type { RootCauseCertificate } from "../src/types";

/**
 * A minimal valid RootCauseCertificate for use in tests that resolve bug
 * tickets but are not specifically exercising root-cause validation.
 * Every field is ≥ MIN_CERTIFICATE_FIELD_LENGTH and contains no TODO placeholders.
 */
export const MINIMAL_ROOT_CAUSE_CERT: RootCauseCertificate = {
  symptom: "Regression detected by the automated smoke test suite",
  rootCause: "Missing null guard in the affected code path caused a runtime failure",
  earliestFailureStage: "Runtime — the null reference is reached before the guard executes",
  whySourceLevelFixOrWhyNot:
    "Source-level fix: added a null guard at the call site; no architectural change required",
  affectedContractOrInvariant:
    "The public API contract that input is non-null before processing was not enforced",
  filesChanged: ["src/affected-module.ts"],
  guardDecision:
    "Existing smoke test now covers the null path and gates the CI pipeline on every push",
  regressionRisk: "low",
};
