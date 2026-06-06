import { AgentLoopStore } from "./store";
import { Pattern, Ticket } from "./types";
import { SourceConvergenceReport } from "./convergence";
import { GuardGapReport } from "./guards";

export interface DashboardData {
  project: string;
  generatedAt: string;
  summary: Awaited<ReturnType<AgentLoopStore["summary"]>>;
  tickets: Ticket[];
  patterns: Pattern[];
  convergence: SourceConvergenceReport;
  guardGaps: GuardGapReport;
}

/** Gather everything the dashboard renders from a store (filesystem or Postgres). */
export async function gatherDashboardData(store: AgentLoopStore): Promise<DashboardData> {
  const summary = await store.summary();
  return {
    project: summary.project,
    generatedAt: new Date().toISOString(),
    summary,
    tickets: await store.listTickets({ status: "all" }),
    patterns: await store.listPatterns({ status: "all" }),
    convergence: await store.sourceConvergence({ includeAll: true }),
    guardGaps: await store.guardGaps({}),
  };
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

const QUEUE_LABELS: Record<string, string> = {
  ISSUE: "Issues",
  USER: "User",
  DEV: "Development",
};
const QUEUE_ORDER = ["ISSUE", "USER", "DEV"];

function prefixOf(ticket: Ticket): string {
  const alias = ticket.aliases[0] ?? ticket.id;
  return alias.split("-")[0];
}

function card(label: string, value: number | string): string {
  return `<div class="card"><div class="num">${escapeHtml(String(value))}</div><div class="lbl">${escapeHtml(label)}</div></div>`;
}

function statusBadge(status: string): string {
  return `<span class="badge s-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function ticketTable(tickets: Ticket[]): string {
  if (tickets.length === 0) return `<p class="empty">No tickets.</p>`;
  const rows = tickets
    .map(
      (t) => `<tr>
        <td class="mono">${escapeHtml(t.aliases[0] ?? t.id)}</td>
        <td>${escapeHtml(t.kind)}</td>
        <td>${statusBadge(t.status)}</td>
        <td>${escapeHtml(t.family)}</td>
        <td>${escapeHtml(t.source)}</td>
        <td>${escapeHtml(t.title || "(untitled)")}</td>
      </tr>`,
    )
    .join("\n");
  return `<table>
    <thead><tr><th>Alias</th><th>Kind</th><th>Status</th><th>Family</th><th>Source</th><th>Title</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function ticketsTab(tickets: Ticket[]): string {
  const groups = new Map<string, Ticket[]>();
  for (const ticket of tickets) {
    const prefix = prefixOf(ticket);
    const list = groups.get(prefix) ?? [];
    list.push(ticket);
    groups.set(prefix, list);
  }
  const orderedPrefixes = [
    ...QUEUE_ORDER.filter((p) => groups.has(p)),
    ...[...groups.keys()].filter((p) => !QUEUE_ORDER.includes(p)).sort(),
  ];
  if (orderedPrefixes.length === 0) return `<p class="empty">No tickets yet.</p>`;
  return orderedPrefixes
    .map((prefix) => {
      const list = groups.get(prefix) ?? [];
      const label = QUEUE_LABELS[prefix] ?? prefix;
      return `<h3>${escapeHtml(label)} <span class="count">${list.length}</span></h3>${ticketTable(list)}`;
    })
    .join("\n");
}

function patternsTab(patterns: Pattern[]): string {
  if (patterns.length === 0) return `<p class="empty">No patterns yet.</p>`;
  const rows = patterns
    .map(
      (p) => `<tr>
        <td class="mono">${escapeHtml(p.id)}</td>
        <td>${escapeHtml(p.family)}</td>
        <td>${statusBadge(p.status)}</td>
        <td>${p.ticketIds.length}</td>
        <td>${escapeHtml(p.title)}</td>
      </tr>`,
    )
    .join("\n");
  return `<table>
    <thead><tr><th>Pattern</th><th>Family</th><th>Status</th><th>Tickets</th><th>Title</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function convergenceTab(report: SourceConvergenceReport): string {
  const head = `<p class="note">${report.summary.convergedPatterns} of ${report.summary.totalPatterns} patterns span multiple sources (max ${report.summary.maxSourceConvergence}).</p>`;
  if (report.patterns.length === 0) return `${head}<p class="empty">No patterns.</p>`;
  const rows = report.patterns
    .map((p) => {
      const sources = Object.entries(p.sources)
        .map(([s, n]) => `${escapeHtml(s)}×${n}`)
        .join(", ");
      return `<tr>
        <td class="mono">${escapeHtml(p.id)}</td>
        <td>${escapeHtml(p.family)}</td>
        <td>${p.sourceCount}</td>
        <td>${p.ticketCount}</td>
        <td>${p.converged ? "✓" : ""}</td>
        <td>${sources}</td>
      </tr>`;
    })
    .join("\n");
  return `${head}<table>
    <thead><tr><th>Pattern</th><th>Family</th><th>Sources</th><th>Tickets</th><th>Converged</th><th>Breakdown</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function guardGapsTab(report: GuardGapReport): string {
  const head = `<p class="note">${report.summary.gaps} gap(s): ${report.summary.missing} missing, ${report.summary.deferred} deferred (of ${report.summary.resolvedConsidered} resolved considered).</p>`;
  if (report.gaps.length === 0) return `${head}<p class="empty">No guard gaps. 🎉</p>`;
  const rows = report.gaps
    .map(
      (g) => `<tr>
        <td class="mono">${escapeHtml(g.alias)}</td>
        <td>${escapeHtml(g.kind)}</td>
        <td><span class="badge gap-${escapeHtml(g.reason)}">${escapeHtml(g.reason)}</span></td>
        <td>${escapeHtml(g.family)}</td>
      </tr>`,
    )
    .join("\n");
  return `${head}<table>
    <thead><tr><th>Ticket</th><th>Kind</th><th>Gap</th><th>Family</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

const STYLE = `
  :root { --bg:#0f1117; --panel:#171a21; --line:#272b35; --txt:#e6e8ee; --muted:#9aa3b2; --accent:#6ea8fe; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--txt); }
  header { padding:24px 28px 8px; }
  h1 { margin:0; font-size:20px; }
  .meta { color:var(--muted); margin:4px 0 0; }
  .cards { display:flex; flex-wrap:wrap; gap:12px; padding:16px 28px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 16px; min-width:110px; }
  .card .num { font-size:22px; font-weight:600; }
  .card .lbl { color:var(--muted); font-size:12px; }
  nav { display:flex; gap:4px; padding:0 28px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  nav button { background:none; border:none; color:var(--muted); padding:10px 14px; cursor:pointer; font-size:14px; border-bottom:2px solid transparent; }
  nav button.active { color:var(--txt); border-bottom-color:var(--accent); }
  main { padding:18px 28px 60px; }
  .tab { display:none; }
  h3 { margin:18px 0 8px; font-size:15px; }
  h3 .count { color:var(--muted); font-weight:400; }
  table { width:100%; border-collapse:collapse; margin-bottom:8px; }
  th, td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; font-size:12px; text-transform:uppercase; letter-spacing:.03em; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--accent); white-space:nowrap; }
  .badge { font-size:12px; padding:1px 8px; border-radius:999px; background:#2a2f3a; }
  .s-resolved { background:#163a2b; color:#7ee2a8; }
  .s-active { background:#16314a; color:#7fb6ff; }
  .s-reopened { background:#4a2516; color:#ffb27f; }
  .s-deferred { background:#33363f; color:#c9ced8; }
  .gap-missing { background:#4a1616; color:#ff8f8f; }
  .gap-deferred { background:#4a3b16; color:#ffd98f; }
  .empty, .note { color:var(--muted); }
  footer { color:var(--muted); padding:0 28px 28px; font-size:12px; }
`;

/**
 * Render a complete, dependency-free HTML dashboard for the ledger. All dynamic
 * text is HTML-escaped. The output is a single self-contained document (inline
 * CSS + a few lines of tab-switching JS), so it opens directly in a browser or
 * is served as-is.
 */
export function renderDashboard(data: DashboardData): string {
  const s = data.summary;
  const cards = [
    card("Tickets", s.totalTickets),
    card("Triaged", s.triagedTickets),
    card("Active", s.activeTickets),
    card("Resolved", s.resolvedTickets),
    card("Patterns", data.patterns.length),
    card("Converged", data.convergence.summary.convergedPatterns),
    card("Guard gaps", data.guardGaps.summary.gaps),
  ].join("");

  const tabs: Array<{ id: string; label: string; body: string }> = [
    { id: "tickets", label: "Tickets", body: ticketsTab(data.tickets) },
    { id: "patterns", label: "Patterns", body: patternsTab(data.patterns) },
    { id: "convergence", label: "Convergence", body: convergenceTab(data.convergence) },
    { id: "guards", label: "Guard Gaps", body: guardGapsTab(data.guardGaps) },
  ];
  const nav = tabs
    .map((t, i) => `<button class="${i === 0 ? "active" : ""}" onclick="showTab('${t.id}', this)">${escapeHtml(t.label)}</button>`)
    .join("");
  const sections = tabs
    .map((t, i) => `<section id="${t.id}" class="tab" style="display:${i === 0 ? "block" : "none"}">${t.body}</section>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(data.project)} — AgentLoops</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>${escapeHtml(data.project)}</h1>
  <p class="meta">AgentLoops dashboard · generated ${escapeHtml(data.generatedAt)}</p>
</header>
<div class="cards">${cards}</div>
<nav>${nav}</nav>
<main>
${sections}
</main>
<footer>Read-only snapshot. Manage tickets with the <code>agentloop</code> CLI or MCP server.</footer>
<script>
function showTab(id, btn) {
  document.querySelectorAll('.tab').forEach(function (t) { t.style.display = 'none'; });
  document.getElementById(id).style.display = 'block';
  document.querySelectorAll('nav button').forEach(function (b) { b.classList.remove('active'); });
  btn.classList.add('active');
}
</script>
</body>
</html>`;
}
