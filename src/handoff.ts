import { Ticket } from "./types";

/**
 * Build the copyable agent handoff prompt for a ticket.
 *
 * Pure and deterministic: if the ticket carries an explicit `handoffText`,
 * that is used verbatim; otherwise a structured default is derived from the
 * ticket fields. Shared by the CLI `handoff` command and the MCP
 * `agentloop_handoff` tool so both stay in sync.
 */
export function buildHandoffPrompt(ticket: Ticket): string {
  if (ticket.handoffText) {
    return ticket.handoffText;
  }
  return [
    `Fix ${ticket.kind} ${ticket.id}: ${ticket.title}`,
    `Symptom: ${ticket.summary}`,
    `Family: ${ticket.family}`,
    `Severity: ${ticket.severity}`,
  ].join("\n");
}
