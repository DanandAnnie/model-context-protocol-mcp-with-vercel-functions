# CLAUDE.md - AI Assistant Guide

## Project Overview

**Project Name**: MCP on Vercel
**Type**: Model Context Protocol (MCP) Server Template
**Runtime**: Vercel Serverless Functions
**Language**: TypeScript (ES Modules)
**License**: MIT (Copyright 2025 Vercel, Inc)

This repository is a template for running an MCP (Model Context Protocol) server on Vercel's serverless infrastructure. It demonstrates how to expose tools, prompts, and resources through the MCP protocol, making them accessible to AI assistants and other MCP clients.

### Key Purpose
- Provide a deployable MCP server that can be hosted on Vercel
- Demonstrate tool creation patterns using the `mcp-handler` library
- Show integration with external APIs (example: weather data)
- Enable AI assistants to access custom tools via HTTP/SSE protocols

## Repository Structure

```
.
├── api/
│   └── server.ts           # Main MCP server with tool definitions
├── public/
│   └── index.html          # Simple landing page
├── scripts/
│   ├── test-client.mjs                    # SSE transport test client
│   └── test-streamable-http-client.mjs    # HTTP transport test client
├── package.json            # Dependencies and project metadata
├── tsconfig.json           # TypeScript configuration
├── vercel.json             # Vercel deployment configuration
├── pnpm-lock.yaml          # Package lock file (pnpm)
├── .gitignore              # Git ignore rules
├── LICENSE                 # MIT License
└── README.md               # User-facing documentation
```

### Directory Purposes

- **`api/`**: Vercel serverless functions directory. Contains the MCP server implementation.
- **`public/`**: Static files served by Vercel. Contains a basic HTML landing page.
- **`scripts/`**: Development and testing utilities for the MCP server.

## Architecture

### MCP Server Pattern

The server uses the `mcp-handler` package which provides:
- Automatic request routing (GET, POST, DELETE)
- Tool registration with Zod schema validation
- Server-Sent Events (SSE) and HTTP transport support
- MCP protocol compliance

### Request Flow

1. Client sends HTTP request to `/mcp` (streamable HTTP) or `/sse` (SSE transport)
2. Vercel routes all requests via `vercel.json` rewrites to `/api/server`
3. `mcp-handler` processes the MCP protocol request
4. Tools execute with validated parameters
5. Response returned to client in MCP format

### Vercel Configuration

The `vercel.json` file:
- Rewrites all paths to `/api/server` for centralized handling
- Sets `maxDuration: 60` seconds (can be increased to 800s on Pro/Enterprise)
- Requires Fluid Compute for efficient execution

## Key Dependencies

### Production Dependencies
- **`mcp-handler`** (^1.0.1): MCP protocol handler for Vercel functions
- **`zod`** (^3.24.2): Schema validation for tool parameters

### Development Dependencies
- **`@types/node`** (^22.13.10): TypeScript type definitions for Node.js

### External (Test Only)
The test clients require `@modelcontextprotocol/sdk` which is not in package.json - you'll need to install it separately for testing.

## Development Workflow

### Prerequisites
1. Node.js installed
2. pnpm package manager (version 9.4.0 specified)
3. Vercel CLI for local development (`npm i -g vercel`)

### Local Development

```bash
# Install dependencies
pnpm install

# Run local development server
vercel dev

# Test with client scripts
node scripts/test-client.mjs http://localhost:3000
node scripts/test-streamable-http-client.mjs http://localhost:3000
```

### MCP Endpoints

When deployed or running locally:
- **HTTP Transport**: `https://your-deployment.vercel.app/mcp`
- **SSE Transport**: `https://your-deployment.vercel.app/sse`
- **Landing Page**: `https://your-deployment.vercel.app/`

## Creating Tools

### Tool Definition Pattern

Located in `api/server.ts`, tools follow this structure:

```typescript
server.tool(
  "tool_name",              // Tool identifier
  "Tool description",       // Human-readable description
  {                         // Zod schema for parameters
    param1: z.string(),
    param2: z.number().int().min(0),
  },
  async ({ param1, param2 }) => {  // Handler function
    // Tool logic here
    return {
      content: [
        { type: "text", text: "Response text" }
      ],
    };
  }
);
```

### Example Tools

1. **`roll_dice`**: Demonstrates random number generation
   - Parameter: `sides` (number, min 2)
   - Returns emoji + text response

2. **`get_weather`**: Demonstrates API integration
   - Parameters: `latitude`, `longitude`, `city`
   - Fetches from Open-Meteo API
   - Returns formatted weather data

### Adding New Tools

When adding tools as an AI assistant:

1. **Read the existing `api/server.ts` file first**
2. **Add new tool using `server.tool()` method**
3. **Use Zod schemas for parameter validation**
4. **Return MCP-compliant response format**: `{ content: [{ type: "text", text: "..." }] }`
5. **Handle errors gracefully** with try-catch blocks
6. **Test locally** with `vercel dev` before committing

### Parameter Validation

Always use Zod schemas for type safety:
- `z.string()` - String parameter
- `z.number()` - Number parameter
- `z.number().int().min(n).max(n)` - Integer with constraints
- `z.boolean()` - Boolean parameter
- `z.array(z.string())` - Array of strings
- `z.object({ ... })` - Nested object

## TypeScript Configuration

### Key Settings (`tsconfig.json`)

- **Module System**: NodeNext (ES modules)
- **Target**: ES2021
- **Strict Mode**: Enabled
- **Declaration Files**: Generated
- **Include**: `api/**/*` and `src/**/*`
- **Exclude**: `node_modules`, test files

### Import Conventions
- Use `.js` extensions in imports (TypeScript ES module requirement)
- Use ES module syntax (`import`/`export`)
- Set `"type": "module"` in package.json

## Testing

### Test Clients

Two test clients are provided:

1. **SSE Transport** (`scripts/test-client.mjs`):
   ```bash
   node scripts/test-client.mjs https://your-url.vercel.app
   ```
   - Uses Server-Sent Events transport
   - Endpoint: `/sse`

2. **HTTP Transport** (`scripts/test-streamable-http-client.mjs`):
   ```bash
   node scripts/test-streamable-http-client.mjs https://your-url.vercel.app
   ```
   - Uses Streamable HTTP transport
   - Endpoint: `/mcp`

### Testing Workflow

1. Start local server: `vercel dev`
2. Run test client: `node scripts/test-client.mjs http://localhost:3000`
3. Verify tools are listed correctly
4. Test tool invocations through MCP client

## Deployment

### Vercel Deployment

1. **Enable Fluid Compute** in Vercel project settings (required for efficiency)
2. **Adjust `maxDuration`** in `vercel.json`:
   - Free/Hobby: 60 seconds (default)
   - Pro/Enterprise: Up to 800 seconds
3. **Deploy**:
   ```bash
   vercel --prod
   ```

### Environment Variables

This template doesn't use environment variables by default, but if you add API keys:
- Set them in Vercel dashboard or `.env` file
- Access via `process.env.VARIABLE_NAME`
- Never commit secrets to the repository

## Key Conventions for AI Assistants

### When Modifying Code

1. **Always read `api/server.ts` before making changes**
2. **Preserve existing tools** unless explicitly asked to remove them
3. **Follow the established pattern** for tool definitions
4. **Use TypeScript** with proper type annotations
5. **Export handler** as GET, POST, and DELETE (required pattern)
6. **Test changes locally** with `vercel dev` when possible

### Code Style

- Use async/await for asynchronous operations
- Prefer const over let
- Use template literals for string interpolation
- Include descriptive tool names and descriptions
- Add comments for complex logic
- Keep tools focused and single-purpose

### Error Handling

- Wrap external API calls in try-catch blocks
- Return meaningful error messages in MCP format
- Validate all inputs with Zod schemas (automatic)
- Handle edge cases (network failures, invalid responses)

### API Integration Best Practices

When integrating external APIs:
- Use `fetch()` for HTTP requests (built-in)
- Handle response parsing errors
- Validate response data before using it
- Consider rate limiting and quotas
- Return user-friendly formatted data

### Response Formatting

MCP tool responses must follow this structure:
```typescript
{
  content: [
    { type: "text", text: "Your response text here" }
  ]
}
```

For multiple content blocks:
```typescript
{
  content: [
    { type: "text", text: "First part" },
    { type: "text", text: "Second part" }
  ]
}
```

## Git Workflow

### Branch Strategy
- Develop on feature branches with prefix `claude/`
- Branch names should include session identifier
- Never push directly to main without permission

### Commit Messages
- Use clear, descriptive commit messages
- Start with verb in imperative mood (Add, Update, Fix, Remove)
- Reference issue numbers when applicable
- Include Claude session URL in commit body

### Common Git Operations

```bash
# Create and switch to feature branch
git checkout -b claude/feature-name-sessionid

# Stage and commit changes
git add api/server.ts
git commit -m "Add new tool for data processing"

# Push to remote
git push -u origin claude/feature-name-sessionid
```

## Common Tasks

### Adding a New Tool

1. Read `api/server.ts`
2. Add new `server.tool()` call within the handler
3. Define Zod schema for parameters
4. Implement tool logic in async handler
5. Return MCP-formatted response
6. Test locally
7. Commit and push changes

### Modifying an Existing Tool

1. Read `api/server.ts` to understand current implementation
2. Locate the specific tool definition
3. Update parameters, description, or logic
4. Preserve backward compatibility if possible
5. Test with both SSE and HTTP clients
6. Document breaking changes in commit message

### Debugging Tools

1. Check Vercel function logs for server errors
2. Use test clients to verify tool registration
3. Test parameter validation with invalid inputs
4. Check response format compliance
5. Verify API integrations with curl/fetch

### Updating Dependencies

```bash
# Update specific package
pnpm update mcp-handler

# Update all packages
pnpm update

# Check for outdated packages
pnpm outdated
```

## Resources

### Official Documentation
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Vercel Functions Documentation](https://vercel.com/docs/functions)
- [Fluid Compute Documentation](https://vercel.com/docs/functions/fluid-compute)
- [Zod Documentation](https://zod.dev)

### Related Templates
- [MCP with Next.js](https://vercel.com/templates/next.js/model-context-protocol-mcp-with-next-js)
- [MCP Template on Vercel](https://vercel.com/templates/other/model-context-protocol-mcp-with-vercel-functions)

## Troubleshooting

### Common Issues

1. **"Module not found" errors**
   - Ensure pnpm install has been run
   - Check import paths use .js extensions
   - Verify "type": "module" in package.json

2. **Tool not appearing in client**
   - Check tool registration syntax
   - Verify server restart after changes
   - Test with both transport types

3. **Parameter validation failing**
   - Review Zod schema definitions
   - Check parameter names match schema
   - Test with valid sample data

4. **Timeout errors**
   - Increase maxDuration in vercel.json
   - Enable Fluid Compute
   - Optimize long-running operations

## Version Information

- **Created**: January 2025
- **Template Version**: 1.0.0
- **Node Requirement**: NodeNext with ES2021 target
- **Package Manager**: pnpm 9.4.0

---

**Note for AI Assistants**: This document should be referenced when working with this codebase. Always read the current state of files before making modifications, follow established patterns, and test changes when possible. The MCP protocol requires strict response formatting - always return content in the specified structure.
