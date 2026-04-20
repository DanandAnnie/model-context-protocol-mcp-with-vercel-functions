// Mission Control tool proxy.
// GET  /api/invoke            → list tools with JSON input schemas
// POST /api/invoke            → { name, arguments } → tool result
//
// Acts as an MCP client against this deployment's own /mcp endpoint so the
// browser dashboard can invoke tools with a plain JSON fetch instead of
// speaking the streamable-HTTP MCP protocol directly.
//
// If MISSION_CONTROL_TOKEN is set, requests must carry a valid mc_auth cookie
// or Authorization: Bearer header (see api/services/auth.ts).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getAuthState } from "./services/auth.js";

async function withClient<T>(origin: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "mission-control", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`));
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default async function handler(req: Request): Promise<Response> {
  const origin = new URL(req.url).origin;

  const auth = getAuthState(req);
  if (auth.required && !auth.authenticated) {
    return jsonResponse(401, { error: "authentication required" });
  }

  try {
    if (req.method === "GET") {
      const { tools } = await withClient(origin, (c) => c.listTools());
      return jsonResponse(200, { tools });
    }

    if (req.method === "POST") {
      let body: any;
      try { body = await req.json(); }
      catch { return jsonResponse(400, { error: "invalid JSON body" }); }

      const name = body?.name;
      const args = body?.arguments ?? {};
      if (!name || typeof name !== "string") {
        return jsonResponse(400, { error: "missing 'name' (string) in body" });
      }

      const started = Date.now();
      const result = await withClient(origin, (c) => c.callTool({ name, arguments: args }));
      return jsonResponse(200, { result, durationMs: Date.now() - started });
    }

    return jsonResponse(405, { error: `method ${req.method} not allowed` });
  } catch (err: any) {
    return jsonResponse(500, { error: err?.message || String(err) });
  }
}
