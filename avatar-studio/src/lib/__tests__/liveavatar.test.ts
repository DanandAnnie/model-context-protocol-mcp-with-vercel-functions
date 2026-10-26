// HeyGen's LiveAvatar, which replaces HeyGen's v1 streaming API for the interactive avatar: a session token made on
// the server, started there, kept alive and stopped there, with replies spoken in the room by the browser.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { LiveAvatarStreamingProvider } from "../providers/streaming/liveavatar";
import { COMMAND_TOPIC, RESPONSE_TOPIC, commandId, isSessionStopped, speakCommand } from "../live-commands";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; headers: Headers; body: Record<string, unknown> };
function serve(route: (path: string) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) });
    return route(url.replace("https://api.liveavatar.com/v1/sessions", ""));
  }) as typeof fetch;
  return calls;
}
const ok = (data: unknown) => Response.json({ code: 1000, data, message: "Success" });

describe("LiveAvatar", () => {
  it("makes a session token with the account key, starts it with that token, and keeps the token on the server", async () => {
    const calls = serve((path) =>
      path === "/token" ? ok({ session_id: "sess_1", session_token: "tok_1" }) : path === "/start" ? ok({ session_id: "sess_1", livekit_url: "wss://room.example", livekit_client_token: "lk_1", max_session_duration: 600 }) : ok({}),
    );
    const live = new LiveAvatarStreamingProvider("la_key", { avatarId: "la_avatar", voiceId: "la_voice" });
    const out = await live.createSession();
    assert.deepEqual(out, { session: { id: "sess_1", secret: "tok_1" }, url: "wss://room.example", accessToken: "lk_1", waitFor: ["heygen", "liveavatar-agent-sess_1"] });
    assert.equal(calls[0].url, "https://api.liveavatar.com/v1/sessions/token");
    assert.equal(calls[0].headers.get("x-api-key"), "la_key");
    assert.deepEqual(calls[0].body, { mode: "FULL", avatar_id: "la_avatar", max_session_duration: 900, avatar_persona: { voice_id: "la_voice" } });
    assert.equal(calls[1].url, "https://api.liveavatar.com/v1/sessions/start");
    assert.equal(calls[1].headers.get("authorization"), "Bearer tok_1");
    assert.equal(calls[1].headers.get("x-api-key"), null, "the account key is only sent to make the token");
    assert.equal(live.speaksInRoom, true);
    await live.speak(out!.session);
    await live.stop(out!.session);
    assert.deepEqual(calls.slice(2).map((c) => [c.url.split("/").at(-1), c.headers.get("authorization"), c.body.session_id]), [["keep-alive", "Bearer tok_1", "sess_1"], ["stop", "Bearer tok_1", "sess_1"]]);
  });

  it("leaves every presenter to its portrait until a LiveAvatar avatar is configured", async () => {
    const calls = serve(() => ok({}));
    assert.equal(await new LiveAvatarStreamingProvider("k").createSession(), null);
    assert.equal(calls.length, 0, "a studio presenter's id is never sent as a LiveAvatar avatar");
  });

  it("reports a refusal in LiveAvatar's words and stops a session that could not start", async () => {
    serve(() => Response.json({ code: 4001, message: "Avatar not found", data: null }));
    await assert.rejects(new LiveAvatarStreamingProvider("k", { avatarId: "a" }).createSession(), /LiveAvatar \/token failed: 200 Avatar not found/);
    const calls = serve((path) => (path === "/token" ? ok({ session_id: "s2", session_token: "t2" }) : path === "/start" ? new Response(JSON.stringify({ code: 500, message: "Internal server error" }), { status: 500 }) : ok({})));
    await assert.rejects(new LiveAvatarStreamingProvider("k", { avatarId: "a" }).createSession(), /\/start failed: 500 Internal server error/);
    assert.equal(calls.at(-1)!.url.endsWith("/stop"), true, "the half-made session is stopped");
    // A keep-alive that fails after a reply was said in the room is logged, never thrown, so nothing says it twice.
    serve(() => new Response("{}", { status: 404 }));
    const quiet = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      await new LiveAvatarStreamingProvider("k").speak({ id: "s", secret: "t" });
      await new LiveAvatarStreamingProvider("k").keepAlive({ id: "s", secret: "t" });
    } finally {
      console.error = quiet;
    }
    assert.equal(logged.length, 2, "each failed keep-alive is logged");
  });

  it("speaks a reply in the room as LiveAvatar's speak_text command, and knows when LiveAvatar stopped the session", () => {
    assert.equal(COMMAND_TOPIC, "agent-control");
    assert.equal(RESPONSE_TOPIC, "agent-response");
    assert.deepEqual(JSON.parse(new TextDecoder().decode(speakCommand("Welcome in.", "evt_1"))), { event_id: "evt_1", event_type: "avatar.speak_text", text: "Welcome in." });
    const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    assert.equal(isSessionStopped(encode({ event_type: "session.stopped", stop_reason: "IDLE_TIMEOUT" })), true);
    assert.equal(isSessionStopped(encode({ event_type: "avatar.speak_ended" })), false);
    assert.equal(isSessionStopped(new TextEncoder().encode("not json")), false);
    // An id even where the page is not a secure context and has no crypto.randomUUID.
    const real = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
      assert.match(commandId(() => 0.5), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      if (real) Object.defineProperty(globalThis, "crypto", real);
    }
    assert.match(commandId(), /^[0-9a-f-]{36}$/);
  });
});
