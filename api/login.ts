import { buildSessionCookie, verifyToken } from "./services/auth.js";

async function handler(req: Request): Promise<Response> {
  if (!process.env.MISSION_CONTROL_TOKEN) {
    return json(400, { error: "MISSION_CONTROL_TOKEN is not configured on the server" });
  }

  let body: any;
  try { body = await req.json(); }
  catch { return json(400, { error: "invalid JSON body" }); }

  const token = typeof body?.token === "string" ? body.token : "";
  if (!token || !verifyToken(token)) {
    await new Promise((r) => setTimeout(r, 400));
    return json(401, { error: "invalid token" });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "set-cookie": buildSessionCookie(token, req),
    },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export { handler as POST };
