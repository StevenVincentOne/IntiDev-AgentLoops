# @stevenvincentone/intidev-agentloops-react

React components and hooks for [IntiDev AgentLoops](https://github.com/StevenVincentOne/IntiDev-AgentLoops)
dashboards. Where the core package's `agentloop dashboard`/`agentloop serve` ship a
self-contained, zero-dependency static page, this package gives you composable
pieces — a data hook plus presentational components — to embed AgentLoops data
in your own React app, styled with your own CSS.

It's a thin client: it only talks to the read-only JSON API exposed by
`agentloop serve` (`/api/summary`, `/api/tickets`, `/api/patterns`). It does not
depend on the core package, the MCP SDK, or zod, so it stays light in your
frontend bundle. `react` (and `react-dom` if you render to the DOM) are peer
dependencies.

## Install

```bash
npm install @stevenvincentone/intidev-agentloops-react react react-dom
```

## Usage

Run `agentloop serve` somewhere your app can reach (e.g. `agentloop serve --port 4319`),
then:

```tsx
import { useAgentLoopData, SummaryCards, TicketList, PatternList } from "@stevenvincentone/intidev-agentloops-react";

function LoopDashboard() {
  const { data, loading, error, refresh } = useAgentLoopData({ baseUrl: "http://localhost:4319" });

  if (error) return <p>Failed to load: {error.message}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <section>
      <button onClick={refresh} disabled={loading}>Refresh</button>
      <SummaryCards summary={data.summary} />
      <TicketList tickets={data.tickets} onSelectTicket={(t) => console.log(t.id)} />
      <PatternList patterns={data.patterns} />
    </section>
  );
}
```

Omit `baseUrl` to fetch from the same origin your app is served from (e.g. if
you proxy `/api/*` to `agentloop serve`).

## Components

- `useAgentLoopData(options?)` — fetches summary, tickets, and patterns; returns
  `{ data, loading, error, refresh }`. Fetches once on mount; call `refresh()`
  to reload.
- `<SummaryCards summary />` — headline counts (total/active/triaged/resolved/…)
  as a row of stat cards.
- `<TicketList tickets onSelectTicket? />` — a table of tickets with alias,
  kind, status badge, family, source, and title.
- `<PatternList patterns onSelectPattern? />` — a list of patterns with id,
  status, family, title, and ticket count.

All components are unstyled beyond predictable `agentloops-*` class names —
bring your own CSS (or pass `className` to extend the root element). All text
is rendered through JSX, so it's escaped automatically.

## Lower-level access

If you want to fetch data yourself (e.g. with your own caching or polling),
use the underlying client functions directly — they accept the same
`{ baseUrl, fetchImpl }` options as the hook:

```ts
import { fetchSummary, fetchTickets, fetchPatterns } from "@stevenvincentone/intidev-agentloops-react";
```

## License

MIT
