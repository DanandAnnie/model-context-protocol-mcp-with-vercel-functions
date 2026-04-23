// Mission Control tool proxy.
// GET  /api/invoke            → list tools with JSON input schemas
// POST /api/invoke            → { name, arguments } → tool result
//
// Calls into the in-process tool registry exported from api/server.ts.
// Previously this did a self-HTTP call to /mcp via the MCP SDK client,
// which crashed the Vercel function runtime (FUNCTION_INVOCATION_FAILED).
//
// If MISSION_CONTROL_TOKEN is set, requests must carry a valid mc_auth
// cookie or Authorization: Bearer header (see api/services/auth.ts).

import { getToolList, runTool } from "./server.js";
import { getAuthState } from "./services/auth.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function handler(req: Request): Promise<Response> {
  const auth = getAuthState(req);
  if (auth.required && !auth.authenticated) {
    return jsonResponse(401, { error: "authentication required" });
  }

  try {
    if (req.method === "GET") {
      return jsonResponse(200, { tools: getToolList() });
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
      const result = await runTool(name, args);
      return jsonResponse(200, { result, durationMs: Date.now() - started });
    }

    return jsonResponse(405, { error: `method ${req.method} not allowed` });
  } catch (err: any) {
    return jsonResponse(500, { error: err?.message || String(err) });
  }
}

export { handler as GET, handler as POST };
