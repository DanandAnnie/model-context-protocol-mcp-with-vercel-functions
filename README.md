# Run an MCP Server on Vercel

## n8n Email Management Workflows

This project includes n8n workflows for automated email management. See [`workflows/README.md`](./workflows/README.md) for details.

### Quick Start with n8n

```bash
# Option 1: Docker (recommended)
docker-compose up -d
# Open http://localhost:5678 (credentials: admin / changeme)

# Option 2: Local
pnpm install
pnpm run n8n:setup
pnpm run n8n:start
pnpm run n8n:import  # in another terminal
```

### Available Workflows

| Workflow | Description |
|----------|-------------|
| **Email Management** | Categorizes emails, applies labels, sends notifications, creates calendar events |
| **Email Auto-Reply** | Automated out-of-office responses with smart filtering |
| **Email Cleanup** | Daily archiving of old emails and spam deletion |

---

## Usage

Update `api/server.ts` with your tools, prompts, and resources following the [MCP TypeScript SDK documentation](https://github.com/modelcontextprotocol/typescript-sdk/tree/main?tab=readme-ov-file#server).

[There is also a Next.js version of this template](https://vercel.com/templates/next.js/model-context-protocol-mcp-with-next-js)

## MCP Client Integration

When adding this server to an MCP client application, use your deployment URL followed by `/mcp`:

```
https://your-deployment-url.vercel.app/mcp
```

## Example Tools

The template includes two example tools to get you started:

- **`roll_dice`** - Rolls an N-sided die (minimum 2 sides)
- **`get_weather`** - Gets current weather data (via an API) for a location using latitude, longitude, and city name

These tools demonstrate basic functionality and API integration patterns. Replace them with your own tools.

## Notes for running on Vercel

- Make sure you have [Fluid compute](https://vercel.com/docs/functions/fluid-compute) enabled for efficient execution
- After enabling Fluid compute, open `vercel.json` and adjust max duration to 800 if you using a Vercel Pro or Enterprise account
- [Deploy the MCP template](https://vercel.com/templates/other/model-context-protocol-mcp-with-vercel-functions)

## Local dev

- Run `vercel dev` for local development
- Alternatively, integrate the system into the server framework of your choice.

## Sample Client

`script/test-client.mjs` contains a sample client to try invocations.

```sh
node scripts/test-client.mjs https://mcp-on-vercel.vercel.app
```
