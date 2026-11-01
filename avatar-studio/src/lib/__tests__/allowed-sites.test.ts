// The websites a shared presenter may be embedded on: how a typed site is read, the talk page's frame-ancestors, and
// which pages a site covers. Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { frameAncestors, normalizeSite, parseSites, siteAllows, splitSites } from "../allowed-sites";
import { MemoryStore } from "../store/memory";
import { agentPatchSchema, agentSchema, createAgent, duplicateAgent, getAgent, publicAgent, updateAgent } from "../services";
import { GET as launcherScript } from "../../app/embed/agent.js/route";
import { proxy } from "../../proxy";
import { NextRequest } from "next/server";

/** Runs the website launcher on a page at `origin` (a stand-in document) and says whether it added itself. */
function launches(js: string, origin: string, ancestors?: string[]): boolean {
  const page = Object.assign(new URL(origin), ancestors ? { ancestorOrigins: ancestors } : {});
  let warned = false;
  const element = () => ({ style: {}, setAttribute() {}, addEventListener() {} });
  const document = { getElementById: () => null, createElement: element, addEventListener() {}, body: null };
  const console = { warn: () => (warned = true) };
  new Function("document", "location", "window", "console", js)(document, page, { console }, console);
  return !warned;
}

const OWNER = "user_sites";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

describe("allowed websites", () => {
  it("reads a typed site as an origin", () => {
    assert.equal(normalizeSite("example.com"), "https://example.com");
    assert.equal(normalizeSite("  WWW.Example.com/pricing?x=1#top "), "https://www.example.com");
    assert.equal(normalizeSite("http://localhost:3000/"), "http://localhost:3000");
    assert.equal(normalizeSite("https://example.com:443"), "https://example.com", "the default port is dropped");
    assert.equal(normalizeSite("*.example.com"), "https://*.example.com");
    assert.equal(normalizeSite("https://*.shop.example.co.uk:8443"), "https://*.shop.example.co.uk:8443");
    assert.equal(normalizeSite("bücher.de"), "https://xn--bcher-kva.de");
    for (const bad of ["", "ftp://example.com", "javascript:alert(1)", "example", "*.com", "*.10.0.0.1", "https://user:pw@example.com", "exa mple.com", "example.com; script-src *", "*", "https://*", "a.*.example.com", "'self'", "http://[::1]:3000", "example.com."]) {
      assert.equal(normalizeSite(bad), null, bad);
    }
  });

  it("lists sites without repeats and names the first that is not one", () => {
    assert.deepEqual(splitSites("example.com\n www.example.com,  *.example.com "), ["example.com", "www.example.com", "*.example.com"]);
    assert.deepEqual(parseSites(["example.com", "https://example.com/", "", "shop.example.com"]), { sites: ["https://example.com", "https://shop.example.com"] });
    assert.deepEqual(parseSites(["example.com", "nope", "also bad"]), { bad: "nope" });
  });

  it("frames the talk page in the studio and on the sites only", () => {
    assert.equal(frameAncestors([]), "frame-ancestors 'self'");
    assert.equal(frameAncestors(["https://example.com", "https://*.example.com", "https://x.com; script-src *"]), "frame-ancestors 'self' https://example.com https://*.example.com");
  });

  it("covers the pages a browser would let frame the talk page", () => {
    const sites = ["https://example.com", "https://*.shop.example.com", "http://localhost:3000"];
    assert.ok(siteAllows(sites, "https://example.com"));
    assert.ok(!siteAllows(sites, "https://www.example.com"), "www is a site of its own");
    assert.ok(!siteAllows(sites, "http://example.com"), "an https site does not cover http");
    assert.ok(!siteAllows(sites, "https://example.com:8443"));
    assert.ok(siteAllows(sites, "https://a.shop.example.com"));
    assert.ok(siteAllows(sites, "https://a.b.shop.example.com"));
    assert.ok(!siteAllows(sites, "https://shop.example.com"), "*. covers subdomains, not the domain itself");
    assert.ok(!siteAllows(sites, "https://evilshop.example.com"));
    assert.ok(siteAllows(sites, "http://localhost:3000"));
    assert.ok(siteAllows(sites, "https://localhost:3000"), "an http site also covers its https address");
    assert.ok(!siteAllows(sites, "http://localhost:3001"));
    assert.ok(!siteAllows(sites, "not a url"));
  });

  it("is kept on the presenter, copied by a duplicate, changed or removed by a patch, and not shown to visitors", async () => {
    const agent = await createAgent(agentSchema.parse({ name: "Kept", avatarId: "stock_1", allowedSites: ["Example.com/contact", "*.example.com", "example.com"] }), OWNER);
    assert.deepEqual(agent.allowedSites, ["https://example.com", "https://*.example.com"]);
    assert.deepEqual((await duplicateAgent(agent.id, OWNER)).allowedSites, ["https://example.com", "https://*.example.com"]);
    assert.equal("allowedSites" in (await publicAgent(agent.id)), false);
    await updateAgent(agent.id, agentPatchSchema.parse({ allowedSites: ["other.org"] }), OWNER);
    assert.deepEqual((await getAgent(agent.id, OWNER)).allowedSites, ["https://other.org"]);
    await updateAgent(agent.id, agentPatchSchema.parse({ name: "Renamed" }), OWNER);
    assert.deepEqual((await getAgent(agent.id, OWNER)).allowedSites, ["https://other.org"], "a patch without the list leaves it");
    await updateAgent(agent.id, agentPatchSchema.parse({ allowedSites: [] }), OWNER);
    assert.equal("allowedSites" in (await getAgent(agent.id, OWNER)), false);
    assert.equal("allowedSites" in (await createAgent(agentSchema.parse({ name: "Open", avatarId: "stock_1", allowedSites: [] }), OWNER)), false);
  });

  it("keeps the website launcher off the pages a site does not cover, as the talk page's frame-ancestors does", async () => {
    const sites = ["https://example.com", "https://*.shop.example.com", "http://localhost:3000"];
    const agent = await createAgent(agentSchema.parse({ name: "Launched", avatarId: "stock_1", allowedSites: sites }), OWNER);
    const js = await (await launcherScript(new Request(`http://studio.test/embed/agent.js?id=${agent.id}`))).text();
    for (const origin of ["https://example.com", "https://www.example.com", "http://example.com", "https://example.com:8443", "https://a.shop.example.com", "https://shop.example.com", "https://evilshop.example.com", "http://localhost:3000", "https://localhost:3000", "http://localhost:3001"]) {
      assert.equal(launches(js, origin), siteAllows(sites, origin), origin);
    }
    // A page of an allowed site shown in another site's frame is not one, where the browser lists the frames around it.
    assert.ok(launches(js, "https://example.com", ["https://a.shop.example.com"]));
    assert.ok(!launches(js, "https://example.com", ["https://builder.example.org"]));
    const open = await createAgent(agentSchema.parse({ name: "Anywhere", avatarId: "stock_1" }), OWNER);
    const anywhere = await (await launcherScript(new Request(`http://studio.test/embed/agent.js?id=${open.id}`))).text();
    assert.ok(launches(anywhere, "https://anything.example.org"));
  });

  it("frames the talk page however its address is written, as the router reads it", async () => {
    const agent = await createAgent(agentSchema.parse({ name: "Framed", avatarId: "stock_1", allowedSites: ["example.com"] }), OWNER);
    const policy = async (path: string) => (await proxy(new NextRequest(`http://studio.test${path}`))).headers.get("content-security-policy");
    const id = agent.id;
    for (const path of [`/talk/${id}`, `/talk/${id}/`, `/talk/${id}?embed=1`, `/talk/${id.replace("_", "%5F")}?embed=1`, `/talk/%61${id.slice(1)}`]) {
      assert.equal(await policy(path), "frame-ancestors 'self' https://example.com", path);
    }
    assert.equal(await policy("/talk/%E0%A4%A"), "frame-ancestors 'self'", "a segment that cannot be decoded is framed by the studio only");
    assert.equal(await policy("/talk/agent%255Fx1y2z3"), "frame-ancestors 'self'", "nor is one that is not a presenter's id");
    assert.equal(await policy("/talk/agent_nosuch1"), null);
    assert.equal(await policy(`/share/${id}`), null);
    const open = await createAgent(agentSchema.parse({ name: "Open", avatarId: "stock_1" }), OWNER);
    assert.equal(await policy(`/talk/${open.id}`), null);
  });

  it("refuses a list with something that is not a site, or more than ten", () => {
    const bad = agentSchema.safeParse({ name: "X", avatarId: "stock_1", allowedSites: ["example.com", "javascript:alert(1)"] });
    assert.equal(bad.success, false);
    assert.match(bad.error!.issues[0].message, /"javascript:alert\(1\)" is not a website address/);
    assert.equal(agentSchema.safeParse({ name: "X", avatarId: "stock_1", allowedSites: Array.from({ length: 11 }, (_, i) => `s${i}.example.com`) }).success, false);
    assert.equal(agentPatchSchema.safeParse({ allowedSites: "example.com" }).success, false);
  });
});
