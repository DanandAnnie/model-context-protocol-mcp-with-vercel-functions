// Brand logos on public pages: linked through a cacheable route instead of sent inline.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { logoResponse, publicLogoSrc } from "../brand-logo";
import { agentSchema, brandKitSchema, createAgent, publicAgent, saveBrandKit } from "../services";
import { STOCK_AVATARS } from "../stock";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const req = (q = "") => new Request(`https://studio.example.com/api/x/logo${q}`);

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

describe("brand logo", () => {
  it("links an uploaded logo through the route, versioned by the kit's save, and an external one as it is", () => {
    assert.equal(publicLogoSrc({ logoUrl: `data:image/png;base64,${PNG}`, updatedAt: "2026-10-25T10:00:00.000Z" }, "/api/videos/vid_1/logo"), "/api/videos/vid_1/logo?v=2026-10-25T10%3A00%3A00.000Z");
    assert.equal(publicLogoSrc({ logoUrl: "https://cdn.example.com/logo.png", updatedAt: "x" }, "/r"), "https://cdn.example.com/logo.png");
    assert.equal(publicLogoSrc({ updatedAt: "x" }, "/r"), undefined);
    assert.equal(publicLogoSrc(null, "/r"), undefined);
  });

  it("serves the bytes with their type, caches a versioned request for good, and sandboxes an SVG", async () => {
    const res = logoResponse(`data:image/png;base64,${PNG}`, req("?v=1"));
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(Buffer.from(await res.arrayBuffer()).toString("base64"), PNG);
    assert.equal(logoResponse(`data:image/png;base64,${PNG}`, req()).headers.get("cache-control"), "public, max-age=300");
    const svg = logoResponse(`data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")}`, req());
    assert.match(svg.headers.get("content-security-policy") ?? "", /default-src 'none'.*sandbox/);
    assert.equal(svg.headers.get("x-content-type-options"), "nosniff");
    // No logo, an external one, or a type that is not an image the page shows: not found.
    for (const url of [undefined, "https://cdn.example.com/logo.png", "data:image/x-icon;base64,AAAA", "data:image/png;base64"]) {
      assert.throws(() => logoResponse(url, req()), /Logo not found/, String(url));
    }
  });

  it("gives the talk page a link to an uploaded logo instead of the file", async () => {
    await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#4f46e5", logoUrl: `data:image/png;base64,${PNG}` }), "u-talk");
    const agent = await createAgent(agentSchema.parse({ name: "Ava", avatarId: STOCK_AVATARS[0].id, isPublic: true }), "u-talk");
    const view = await publicAgent(agent.id);
    assert.match(view.brand?.logoUrl ?? "", new RegExp(`^/api/talk/${agent.id}/logo\\?v=`));
    assert.equal(JSON.stringify(view).includes(PNG), false, "the page data no longer carries the file");
  });
});
