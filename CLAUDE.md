# CLAUDE.md

## Project Overview

MCP (Model Context Protocol) server template deployed as a Vercel Function. Exposes tools to AI/LLM clients (e.g., Claude) via the MCP protocol over HTTP and SSE transports. Built with TypeScript and the `mcp-handler` library.

## Repository Structure

```
├── api/
│   └── server.ts              # MCP server entry point — all tools defined here
├── public/
│   └── index.html             # Static landing page
├── scripts/
│   ├── test-client.mjs        # SSE transport test client
│   └── test-streamable-http-client.mjs  # HTTP transport test client
├── package.json               # Dependencies and metadata
├── pnpm-lock.yaml             # pnpm lockfile
├── tsconfig.json              # TypeScript configuration
├── vercel.json                # Vercel deployment and routing config
└── .gitignore
```

## Tech Stack

- **Runtime:** Node.js >= 18, TypeScript (strict mode, ES2021 target, NodeNext modules)
- **Package manager:** pnpm 9.4.0 (required — declared in `package.json` `packageManager` field)
- **Key dependencies:**
  - `mcp-handler` — abstracts the MCP SDK into a `createMcpHandler` factory
  - `zod` — schema validation for tool parameters
- **Deployment:** Vercel Functions (serverless), configured in `vercel.json`

## Development

### Setup

```sh
pnpm install
```

### Local dev server

```sh
vercel dev
```

This starts the Vercel development environment with hot reloading.

### Testing with sample clients

```sh
# HTTP/Streamable transport (preferred)
node scripts/test-streamable-http-client.mjs http://localhost:3000

# SSE transport
node scripts/test-client.mjs http://localhost:3000
```

### No build step required

Vercel Functions compile TypeScript on deploy. There is no explicit build script.

### No test framework

The project has no test runner configured. The `test` script in `package.json` is a placeholder.

### No linter/formatter configured

No ESLint, Prettier, or similar tooling is set up.

## Architecture

### Request Flow

All HTTP requests matching `/(.*+)` are rewritten to `/api/server` via `vercel.json`. The server function (`api/server.ts`) exports a single handler for GET, POST, and DELETE methods:

```
Client → Vercel Edge → rewrite → /api/server.ts handler → MCP protocol response
```

### Adding Tools

All tools are defined in `api/server.ts` inside the `createMcpHandler` callback. Each tool is registered with:

1. **Name** — string identifier
2. **Description** — human-readable purpose
3. **Schema** — Zod schema defining parameters
4. **Handler** — async function returning `{content: [{type: "text", text: "..."}]}`

Example pattern:

```typescript
server.tool(
  "tool_name",
  "Description of the tool",
  { param: z.string() },
  async ({ param }) => {
    return {
      content: [{ type: "text", text: `Result: ${param}` }],
    };
  },
);
```

### Existing Tools

- **`roll_dice`** — rolls an N-sided die (param: `sides`, min 2)
- **`get_weather`** — fetches current weather from Open-Meteo API (params: `latitude`, `longitude`, `city`)

### MCP Client Endpoint

Clients connect to `/mcp` (HTTP transport) or `/sse` (SSE transport).

## Deployment

- Deployed to Vercel as a serverless function
- `vercel.json` sets `maxDuration: 60` (seconds) for the server function
- Enable [Fluid Compute](https://vercel.com/docs/functions/fluid-compute) for efficient execution
- On Vercel Pro/Enterprise, increase `maxDuration` to 800 in `vercel.json`

## Environment Variables

No environment variables are currently required. The example tools use only public APIs (Open-Meteo). If you add tools that need secrets, configure them in Vercel project settings and reference via `process.env`.

## Conventions

- All MCP tools go in `api/server.ts` — single-file server pattern
- Use Zod schemas for all tool parameter validation
- Tool handlers are async functions returning the MCP content format
- ESM throughout (`"type": "module"` in `package.json`)
- TypeScript strict mode is enabled
- Trailing commas used in function arguments (Prettier-like style)
- Test scripts use `.mjs` extension for Node ESM compatibility
