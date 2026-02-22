# CLAUDE.md

## Project Overview

This is an **MCP (Model Context Protocol) server template** that runs on **Vercel serverless functions**. It provides a deployable MCP server exposing tools, prompts, and resources to MCP-compatible clients via HTTP. The server uses Vercel's Fluid Compute for efficient serverless execution.

## Tech Stack

- **Language:** TypeScript (ES2021 target, strict mode)
- **Runtime:** Node.js (ESM via NodeNext module system)
- **Platform:** Vercel serverless functions
- **Package Manager:** pnpm 9.4.0
- **Key Dependencies:**
  - `mcp-handler` - Wrapper for creating MCP server handlers on Vercel
  - `zod` - Runtime schema validation for tool parameters
  - `@modelcontextprotocol/sdk` - MCP SDK (transitive via mcp-handler)

## Repository Structure

```
api/
  server.ts          # Main MCP handler — all tools are defined here
scripts/
  test-client.mjs              # Test client using SSE transport (/sse)
  test-streamable-http-client.mjs  # Test client using HTTP transport (/mcp)
public/
  index.html         # Static landing page
vercel.json          # Vercel routing and function config
tsconfig.json        # TypeScript compiler configuration
package.json         # Dependencies and project metadata
```

## Commands

| Task | Command |
|------|---------|
| Install dependencies | `pnpm install` |
| Local development | `vercel dev` |
| Test (SSE transport) | `node scripts/test-client.mjs <URL>` |
| Test (HTTP transport) | `node scripts/test-streamable-http-client.mjs <URL>` |
| Deploy | `vercel` (or push to connected Git repo) |

There is no test suite configured — the `test` script exits with an error.

## Architecture

### Request Flow

All incoming requests are rewritten to `/api/server` via `vercel.json`. The single handler in `api/server.ts` processes MCP protocol messages over two transport modes:

- **StreamableHTTP** — clients connect to `/mcp`
- **SSE (Server-Sent Events)** — clients connect to `/sse`

The handler is exported for GET, POST, and DELETE HTTP methods.

### Adding Tools

Tools are registered inside the `createMcpHandler()` callback in `api/server.ts` using:

```typescript
server.tool(
  "tool_name",       // unique tool name
  "description",     // human-readable description
  { param: z.type() }, // Zod schema for parameters
  async (params) => ({  // handler function
    content: [{ type: "text", text: "result" }],
  }),
);
```

The same pattern applies for prompts (`server.prompt()`) and resources (`server.resource()`), though none are currently implemented.

### Current Example Tools

- **`roll_dice`** — Rolls an N-sided die (min 2 sides). Demonstrates basic computation.
- **`get_weather`** — Fetches current weather from Open-Meteo API. Demonstrates external API integration.

## Key Conventions

- **All MCP server logic lives in `api/server.ts`** — this is the single entry point for the serverless function.
- **Zod is used for all parameter validation** — every tool parameter must have a Zod schema.
- **Tool handlers return `{ content: [{ type: "text", text: "..." }] }`** — follow the MCP response format.
- **TypeScript strict mode is enabled** — no implicit `any`, strict null checks, etc.
- **ESM modules** — the project uses `"type": "module"` and NodeNext module resolution.

## Vercel Configuration

- All routes rewrite to `/api/server` (see `vercel.json`)
- Function max duration: 60 seconds (increase to 800 for Pro/Enterprise)
- Fluid Compute must be enabled in Vercel project settings for efficient execution

## Client Integration

MCP clients connect using the deployment URL:

```
https://<deployment-url>.vercel.app/mcp    # StreamableHTTP transport
https://<deployment-url>.vercel.app/sse    # SSE transport
```
