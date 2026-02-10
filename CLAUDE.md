# CLAUDE.md

## Project Overview

This is an MCP (Model Context Protocol) server deployed as a Vercel serverless function. It provides a template for exposing tools to LLM clients (like Claude) over HTTP using the MCP protocol. The server supports both StreamableHTTP (`/mcp`) and SSE (`/sse`) transports.

## Repository Structure

```
api/server.ts              # MCP server — all tools are defined here
scripts/test-client.mjs    # Test client using SSE transport
scripts/test-streamable-http-client.mjs  # Test client using StreamableHTTP transport
public/index.html          # Static landing page
vercel.json                # Vercel deployment config (rewrites + function settings)
tsconfig.json              # TypeScript config (strict, ES2021, NodeNext modules)
package.json               # Dependencies and project metadata
```

## Tech Stack

- **Runtime:** Node.js on Vercel Functions
- **Language:** TypeScript (strict mode)
- **Package manager:** pnpm 9.4.0
- **Module system:** ES modules (`"type": "module"`)
- **Key dependencies:**
  - `mcp-handler` — wraps `@modelcontextprotocol/sdk` for Vercel/Next.js compatibility
  - `zod` — runtime schema validation for tool parameters

## How It Works

All requests except `/` are rewritten to `/api/server` via `vercel.json`. The single serverless function in `api/server.ts` handles GET, POST, and DELETE by exporting the same handler for each method:

```typescript
export { handler as GET, handler as POST, handler as DELETE };
```

Tools are registered inside the `createMcpHandler` callback using `server.tool()`. Each tool has a name, description, Zod schema for parameters, and an async handler returning `{ content: [...] }`.

## Adding a New Tool

Edit `api/server.ts` and add a `server.tool()` call inside the `createMcpHandler` callback:

```typescript
server.tool(
  "tool_name",
  "Description of what the tool does",
  { param: z.string() },       // Zod schema for parameters
  async ({ param }) => {
    return {
      content: [{ type: "text", text: `Result: ${param}` }],
    };
  },
);
```

All tools live in `api/server.ts`. There is no separate tool registration system.

## Development

### Local development

```sh
pnpm install
vercel dev
```

### Testing the server

Use the included test clients against a running server (local or deployed):

```sh
# StreamableHTTP transport (preferred)
node scripts/test-streamable-http-client.mjs http://localhost:3000

# SSE transport
node scripts/test-client.mjs http://localhost:3000
```

### No test framework

There is no test framework configured. The `test` script in `package.json` is a placeholder. Test files (`*.test.ts`) are excluded in `tsconfig.json`.

### No linter/formatter

No ESLint, Prettier, or similar tools are configured.

## Deployment

Deployed automatically to Vercel on push. Key `vercel.json` settings:

- All non-root paths rewrite to `/api/server`
- Function `maxDuration`: 60s (increase to 800 for Pro/Enterprise)
- Requires [Fluid compute](https://vercel.com/docs/functions/fluid-compute) enabled

MCP endpoint for clients: `https://<deployment>.vercel.app/mcp`

## Conventions

- **Single entry point:** All server logic lives in `api/server.ts`. Keep it that way unless the file grows significantly.
- **Zod for validation:** Always use Zod schemas for tool parameter definitions.
- **Tool response format:** Return `{ content: [{ type: "text", text: "..." }] }` from tool handlers.
- **No environment variables** are currently used. The `get_weather` tool uses the free Open-Meteo API (no auth). If adding tools that need secrets, configure them as Vercel environment variables.
- **TypeScript strict mode** is enabled. All code must pass strict type checking.
- **ES modules** throughout — use `import`/`export`, not `require`.

## Existing Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `roll_dice` | `sides: number` (int, min 2) | Returns a random dice roll |
| `get_weather` | `latitude: number`, `longitude: number`, `city: string` | Fetches current weather from Open-Meteo API |
