import { buildClearCookie } from "./services/auth.js";

async function handler(req: Request): Promise<Response> {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "set-cookie": buildClearCookie(req),
    },
  });
}

export { handler as POST };
