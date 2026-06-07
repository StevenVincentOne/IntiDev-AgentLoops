import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SummaryCards } from "../src/SummaryCards";
import { TicketList } from "../src/TicketList";
import { PatternList } from "../src/PatternList";
import { AgentLoopSummary, Pattern, Ticket } from "../src/types";

const SUMMARY: AgentLoopSummary = {
  project: "demo",
  totalTickets: 3,
  activeTickets: 1,
  triagedTickets: 1,
  resolvedTickets: 1,
  reopenedTickets: 0,
  deferredTickets: 0,
  openPatterns: 1,
  stalledPatterns: 0,
  resolvedPatterns: 0,
};

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "ISSUE-000001",
    family: "export_pipeline",
    kind: "bug",
    source: "smoke",
    title: "Export crashes on large batches",
    summary: "The export pipeline throws on batches over 500 rows.",
    severity: "high",
    confidence: "high",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    aliases: ["ISSUE-000001"],
    tags: [],
    ...overrides,
  };
}

function pattern(overrides: Partial<Pattern> = {}): Pattern {
  return {
    id: "PATTERN-000001",
    family: "export_pipeline",
    title: "Recurring export_pipeline issues",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ticketIds: ["ISSUE-000001", "ISSUE-000002"],
    ...overrides,
  };
}

test("SummaryCards renders one card per summary field with its value and label", () => {
  const html = renderToStaticMarkup(<SummaryCards summary={SUMMARY} />);
  assert.match(html, /agentloops-summary-cards/);
  assert.match(html, /agentloops-summary-card-value">3</);
  assert.match(html, /agentloops-summary-card-label">Total/);
  assert.match(html, /agentloops-summary-card-value">1</);
  assert.match(html, /agentloops-summary-card-label">Active/);
});

test("SummaryCards appends a custom className", () => {
  const html = renderToStaticMarkup(<SummaryCards summary={SUMMARY} className="dashboard-cards" />);
  assert.match(html, /class="agentloops-summary-cards dashboard-cards"/);
});

test("TicketList renders a row per ticket with alias, status badge, and title", () => {
  const html = renderToStaticMarkup(<TicketList tickets={[ticket()]} />);
  assert.match(html, /ISSUE-000001/);
  assert.match(html, /agentloops-status-active">active/);
  assert.match(html, /Export crashes on large batches/);
});

test("TicketList shows an empty state when there are no tickets", () => {
  const html = renderToStaticMarkup(<TicketList tickets={[]} />);
  assert.match(html, /agentloops-empty/);
  assert.match(html, /No tickets\./);
});

test("TicketList marks rows clickable only when onSelectTicket is provided", () => {
  const plain = renderToStaticMarkup(<TicketList tickets={[ticket()]} />);
  assert.doesNotMatch(plain, /agentloops-clickable/);

  const interactive = renderToStaticMarkup(<TicketList tickets={[ticket()]} onSelectTicket={() => {}} />);
  assert.match(interactive, /agentloops-clickable/);
});

test("PatternList renders id, status, family, title, and ticket count", () => {
  const html = renderToStaticMarkup(<PatternList patterns={[pattern()]} />);
  assert.match(html, /PATTERN-000001/);
  assert.match(html, /agentloops-status-active">active/);
  assert.match(html, /Recurring export_pipeline issues/);
  assert.match(html, /\(2 tickets\)/);
});

test("PatternList shows an empty state when there are no patterns", () => {
  const html = renderToStaticMarkup(<PatternList patterns={[]} />);
  assert.match(html, /agentloops-empty/);
  assert.match(html, /No patterns\./);
});
