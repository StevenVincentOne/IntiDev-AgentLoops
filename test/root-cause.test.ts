/**
 * Tests for the Root Cause Certificate guardrail (src/root-cause.ts).
 *
 * Covers:
 * - certificateFieldIsActionable edge cases
 * - requiresRootCauseCertificate with default and overridden meaningfulKinds
 * - assertRootCauseCertificateForResolution: happy path, missing cert, placeholder
 *   fields, too-short fields, placeholder filesChanged
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  certificateFieldIsActionable,
  requiresRootCauseCertificate,
  assertRootCauseCertificateForResolution,
  DEFAULT_ROOT_CAUSE_KINDS,
  MIN_CERTIFICATE_FIELD_LENGTH,
} from "../src/root-cause";
import type { ProjectConfig, RootCauseCertificate, Ticket } from "../src/types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "T-1",
    title: "widget explodes on null input",
    summary: "Null pointer in widget.render()",
    status: "open",
    kind: "bug",
    family: "widget",
    priority: "high",
    severity: "high",
    notes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const VALID_CERT: RootCauseCertificate = {
  symptom:
    "widget.render() throws TypeError: Cannot read properties of null when input prop is absent",
  rootCause:
    "render() accesses input.value without a null guard; the contract assumed input is always provided",
  earliestFailureStage: "widget.render() at line 42 — null check missing before property access",
  whySourceLevelFixOrWhyNot:
    "Source-level fix: add null guard in render(). No deeper architectural change needed.",
  affectedContractOrInvariant:
    "Widget.render(input) contract: input must be non-null; was never enforced at the call site",
  filesChanged: ["src/widget/render.ts", "test/widget/render.test.ts"],
  guardDecision:
    "Added unit test asserting render(null) returns empty string; test now gates the CI pipeline",
  regressionRisk: "low",
};

const emptyConfig: ProjectConfig = {
  projectName: "Test Project",
};

// ── certificateFieldIsActionable ──────────────────────────────────────────────

describe("certificateFieldIsActionable", () => {
  it("returns true for a long enough, non-placeholder string", () => {
    assert.equal(
      certificateFieldIsActionable("This is a meaningful description of the root cause."),
      true,
    );
  });

  it("returns false when value is shorter than MIN_CERTIFICATE_FIELD_LENGTH", () => {
    const short = "too short";
    assert.ok(short.length < MIN_CERTIFICATE_FIELD_LENGTH);
    assert.equal(certificateFieldIsActionable(short), false);
  });

  it("returns false when value contains TODO", () => {
    assert.equal(
      certificateFieldIsActionable("TODO: fill in the actual root cause here please"),
      false,
    );
  });

  it("returns false when value contains 'replace me'", () => {
    assert.equal(
      certificateFieldIsActionable("replace me with the actual value once known"),
      false,
    );
  });

  it("returns false when value contains unknown_or_not_applicable", () => {
    assert.equal(
      certificateFieldIsActionable("unknown_or_not_applicable — will update later"),
      false,
    );
  });

  it("respects a custom minLength", () => {
    assert.equal(certificateFieldIsActionable("short", 3), true);
    assert.equal(certificateFieldIsActionable("sh", 3), false);
  });
});

// ── requiresRootCauseCertificate ──────────────────────────────────────────────

describe("requiresRootCauseCertificate", () => {
  it("requires a certificate for a bug ticket by default", () => {
    assert.equal(requiresRootCauseCertificate(makeTicket({ kind: "bug" }), emptyConfig), true);
  });

  it("requires a certificate for an incident ticket by default", () => {
    assert.equal(
      requiresRootCauseCertificate(makeTicket({ kind: "incident" }), emptyConfig),
      true,
    );
  });

  it("requires a certificate for a user_feedback ticket by default", () => {
    assert.equal(
      requiresRootCauseCertificate(makeTicket({ kind: "user_feedback" }), emptyConfig),
      true,
    );
  });

  it("does NOT require a certificate for a feature ticket by default", () => {
    assert.equal(
      requiresRootCauseCertificate(makeTicket({ kind: "feature" }), emptyConfig),
      false,
    );
  });

  it("does NOT require a certificate for a task ticket by default", () => {
    assert.equal(
      requiresRootCauseCertificate(makeTicket({ kind: "task" }), emptyConfig),
      false,
    );
  });

  it("opts out entirely when meaningfulKinds is empty", () => {
    const config: ProjectConfig = {
      ...emptyConfig,
      rootCause: { meaningfulKinds: [] },
    };
    assert.equal(requiresRootCauseCertificate(makeTicket({ kind: "bug" }), config), false);
  });

  it("respects a custom meaningfulKinds override", () => {
    const config: ProjectConfig = {
      ...emptyConfig,
      rootCause: { meaningfulKinds: ["feature"] },
    };
    assert.equal(requiresRootCauseCertificate(makeTicket({ kind: "feature" }), config), true);
    assert.equal(requiresRootCauseCertificate(makeTicket({ kind: "bug" }), config), false);
  });

  it("DEFAULT_ROOT_CAUSE_KINDS includes bug, incident, user_feedback", () => {
    assert.deepEqual(DEFAULT_ROOT_CAUSE_KINDS, ["bug", "incident", "user_feedback"]);
  });
});

// ── assertRootCauseCertificateForResolution ───────────────────────────────────

describe("assertRootCauseCertificateForResolution", () => {
  it("is a no-op for a non-meaningful ticket kind", () => {
    const ticket = makeTicket({ kind: "feature" });
    // should not throw
    assert.doesNotThrow(() =>
      assertRootCauseCertificateForResolution(ticket, {}, emptyConfig),
    );
  });

  it("is a no-op when meaningfulKinds is []", () => {
    const config: ProjectConfig = { ...emptyConfig, rootCause: { meaningfulKinds: [] } };
    const ticket = makeTicket({ kind: "bug" });
    assert.doesNotThrow(() =>
      assertRootCauseCertificateForResolution(ticket, {}, config),
    );
  });

  it("throws when cert is missing for a bug ticket", () => {
    const ticket = makeTicket({ kind: "bug" });
    assert.throws(
      () => assertRootCauseCertificateForResolution(ticket, {}, emptyConfig),
      /rootCauseCertificate/,
    );
  });

  it("throws with a helpful scaffold hint", () => {
    const ticket = makeTicket({ kind: "bug" });
    assert.throws(
      () => assertRootCauseCertificateForResolution(ticket, {}, emptyConfig),
      /evidence-draft T-1 --evidence-only/,
    );
  });

  it("accepts a fully valid certificate without throwing", () => {
    const ticket = makeTicket({ kind: "bug" });
    assert.doesNotThrow(() =>
      assertRootCauseCertificateForResolution(
        ticket,
        { rootCauseCertificate: VALID_CERT },
        emptyConfig,
      ),
    );
  });

  it("throws when symptom field is a TODO placeholder", () => {
    const cert: RootCauseCertificate = {
      ...VALID_CERT,
      symptom: "TODO: describe the symptom here once observed",
    };
    assert.throws(
      () =>
        assertRootCauseCertificateForResolution(
          makeTicket({ kind: "bug" }),
          { rootCauseCertificate: cert },
          emptyConfig,
        ),
      /symptom/,
    );
  });

  it("throws when rootCause field is too short", () => {
    const cert: RootCauseCertificate = {
      ...VALID_CERT,
      rootCause: "null ptr", // < MIN_CERTIFICATE_FIELD_LENGTH
    };
    assert.throws(
      () =>
        assertRootCauseCertificateForResolution(
          makeTicket({ kind: "bug" }),
          { rootCauseCertificate: cert },
          emptyConfig,
        ),
      /rootCause/,
    );
  });

  it("throws when filesChanged is an empty array", () => {
    const cert: RootCauseCertificate = { ...VALID_CERT, filesChanged: [] };
    assert.throws(
      () =>
        assertRootCauseCertificateForResolution(
          makeTicket({ kind: "bug" }),
          { rootCauseCertificate: cert },
          emptyConfig,
        ),
      /filesChanged/,
    );
  });

  it("throws when filesChanged contains only placeholder entries", () => {
    const cert: RootCauseCertificate = {
      ...VALID_CERT,
      filesChanged: ["TODO: add the changed files"],
    };
    assert.throws(
      () =>
        assertRootCauseCertificateForResolution(
          makeTicket({ kind: "bug" }),
          { rootCauseCertificate: cert },
          emptyConfig,
        ),
      /filesChanged/,
    );
  });

  it("accepts regressionRisk: low (short but valid, above MIN_RISK_FIELD_LENGTH)", () => {
    const cert: RootCauseCertificate = { ...VALID_CERT, regressionRisk: "low" };
    assert.doesNotThrow(() =>
      assertRootCauseCertificateForResolution(
        makeTicket({ kind: "bug" }),
        { rootCauseCertificate: cert },
        emptyConfig,
      ),
    );
  });

  it("throws when multiple fields fail — lists all of them", () => {
    const cert: RootCauseCertificate = {
      ...VALID_CERT,
      symptom: "TODO: fill",
      rootCause: "TODO: fill in",
    };
    assert.throws(
      () =>
        assertRootCauseCertificateForResolution(
          makeTicket({ kind: "bug" }),
          { rootCauseCertificate: cert },
          emptyConfig,
        ),
      (err: Error) => {
        assert.ok(err.message.includes("symptom"), "should mention symptom");
        assert.ok(err.message.includes("rootCause"), "should mention rootCause");
        return true;
      },
    );
  });

  it("respects a custom minFieldLength from config", () => {
    const config: ProjectConfig = {
      ...emptyConfig,
      rootCause: { minFieldLength: 5 },
    };
    // With minFieldLength=5, a short but non-TODO value like "null ptr" (8 chars) should pass
    const cert: RootCauseCertificate = {
      ...VALID_CERT,
      rootCause: "null ptr", // 8 chars — passes minFieldLength=5
    };
    assert.doesNotThrow(() =>
      assertRootCauseCertificateForResolution(
        makeTicket({ kind: "bug" }),
        { rootCauseCertificate: cert },
        config,
      ),
    );
  });
});
