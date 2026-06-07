import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AgentLoopStore } from "./store";
import { gatherDashboardData, renderDashboard } from "./dashboard";

function sendJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}

async function handle(
  store: AgentLoopStore,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = (req.url ?? "/").split("?")[0];
  try {
    if (url === "/api/summary") return sendJson(res, await store.summary());
    if (url === "/api/tickets") return sendJson(res, await store.listTickets({ status: "all" }));
    if (url === "/api/patterns") return sendJson(res, await store.listPatterns({ status: "all" }));
    if (url === "/api/convergence") {
      return sendJson(res, await store.sourceConvergence({ includeAll: true }));
    }
    if (url === "/api/guard-gaps") return sendJson(res, await store.guardGaps({}));
    if (url === "/api/workflow-audit") return sendJson(res, await store.workflowAudit({}));
    if (url === "/api/near-duplicates") return sendJson(res, await store.nearDuplicates({}));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderDashboard(await gatherDashboardData(store)));
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(error instanceof Error ? error.message : String(error));
  }
}

/**
 * A zero-dependency HTTP server that renders the dashboard at `/` and exposes
 * read-only JSON at `/api/*`, re-reading the store on each request (so it
 * reflects the live ledger over filesystem or Postgres).
 */
export function createDashboardServer(store: AgentLoopStore): Server {
  return createServer((req, res) => {
    void handle(store, req, res);
  });
}
