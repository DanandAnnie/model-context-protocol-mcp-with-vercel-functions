// The Supabase store is exercised against a recording fetch, so the PostgREST requests it
// builds (filters on the JSON document, ordering, upsert semantics) are checked without a database.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { SupabaseStore } from "../store/supabase";

type Call = { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: unknown };

let calls: Call[] = [];
let respond: (call: Call) => unknown = () => [];

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
  const call: Call = {
    method: init?.method ?? "GET",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
  calls.push(call);
  return new Response(JSON.stringify(respond(call)), { status: 200, headers: { "content-type": "application/json" } });
};

const store = new SupabaseStore("https://example.supabase.co", "service-role-key", fakeFetch);

beforeEach(() => {
  calls = [];
  respond = () => [];
});

describe("SupabaseStore", () => {
  it("lists a kind newest first, filtered by the document's ownerId when given", async () => {
    respond = () => [{ data: { id: "v1", ownerId: "u1" } }, { data: { id: "v2", ownerId: "u1" } }];
    const items = await store.list<{ id: string }>("video", "u1");
    assert.deepEqual(items.map((v) => v.id), ["v1", "v2"]);
    const [call] = calls;
    assert.equal(call.method, "GET");
    assert.equal(call.path, "/rest/v1/studio_items");
    assert.equal(call.query.select, "data");
    assert.equal(call.query.kind, "eq.video");
    assert.equal(call.query["data->>ownerId"], "eq.u1");
    assert.equal(call.query.order, "created_at.desc");
    assert.equal(call.headers.apikey, "service-role-key");

    await store.list("avatar");
    assert.equal("data->>ownerId" in calls[1].query, false, "no owner filter without an owner");
  });

  it("gets one document by kind and id, and null when absent", async () => {
    respond = () => [{ data: { id: "v1", title: "Hi" } }];
    assert.deepEqual(await store.get("video", "v1"), { id: "v1", title: "Hi" });
    assert.equal(calls[0].query.id, "eq.v1");
    assert.equal(calls[0].query.kind, "eq.video");
    respond = () => [];
    assert.equal(await store.get("video", "missing"), null);
  });

  it("upserts the whole document under its id and bumps updated_at", async () => {
    const item = { id: "v1", ownerId: "u1", title: "Hi" };
    assert.equal(await store.put("video", item), item);
    const [call] = calls;
    assert.equal(call.method, "POST");
    assert.match(call.headers.prefer ?? "", /resolution=merge-duplicates/);
    const body = call.body as { id: string; kind: string; data: unknown; updated_at: string };
    assert.equal(body.id, "v1");
    assert.equal(body.kind, "video");
    assert.deepEqual(body.data, item);
    assert.ok(!Number.isNaN(Date.parse(body.updated_at)));
  });

  it("removes by kind and id", async () => {
    await store.remove("video", "v1");
    assert.equal(calls[0].method, "DELETE");
    assert.equal(calls[0].query.kind, "eq.video");
    assert.equal(calls[0].query.id, "eq.v1");
  });

  it("finds by a top-level document field and rejects unsafe field names", async () => {
    respond = () => [{ data: { id: "v9", providerJobId: "job_1" } }];
    const found = await store.findBy<{ id: string }>("video", "providerJobId", "job_1");
    assert.equal(found?.id, "v9");
    assert.equal(calls[0].query["data->>providerJobId"], "eq.job_1");
    assert.equal(calls[0].query.limit, "1");
    await assert.rejects(store.findBy("video", "hash)=eq.x--", "v"), /invalid field name/);
  });

  it("surfaces PostgREST errors with the operation name", async () => {
    const failing = new SupabaseStore("https://example.supabase.co", "k", async () => new Response(JSON.stringify({ message: "permission denied", code: "42501" }), { status: 403, headers: { "content-type": "application/json" } }));
    await assert.rejects(failing.list("video", "u1"), /supabase list failed: permission denied/);
    await assert.rejects(failing.put("video", { id: "v1" }), /supabase put failed/);
  });
});
