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

  it("serves the bytes with their type, caches only the current version and never past the page's expiry, and sandboxes an SVG", async () => {
    const kit = (logoUrl?: string) => ({ logoUrl, updatedAt: "2026-10-25T10:00:00.000Z" });
    const current = `?v=${encodeURIComponent(kit().updatedAt)}`;
    const res = logoResponse(kit(`data:image/png;base64,${PNG}`), req(current));
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
    assert.equal(Buffer.from(await res.arrayBuffer()).toString("base64"), PNG);
    // An old version (the logo was replaced) or no version is served but never cached.
    assert.equal(logoResponse(kit(`data:image/png;base64,${PNG}`), req("?v=2026-01-01")).headers.get("cache-control"), "no-store");
    assert.equal(logoResponse(kit(`data:image/png;base64,${PNG}`), req()).headers.get("cache-control"), "no-store");
    // A page that expires in ten minutes caps the lifetime; one already expired is not cached.
    const soon = new Date(Date.now() + 600_000).toISOString();
    assert.match(logoResponse(kit(`data:image/png;base64,${PNG}`), req(current), soon).headers.get("cache-control") ?? "", /^public, max-age=(59\d|600)$/);
    assert.equal(logoResponse(kit(`data:image/png;base64,${PNG}`), req(current), new Date(Date.now() - 1000).toISOString()).headers.get("cache-control"), "no-store");
    const svg = logoResponse(kit(`data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")}`), req());
    assert.match(svg.headers.get("content-security-policy") ?? "", /default-src 'none'.*sandbox/);
    assert.equal(svg.headers.get("x-content-type-options"), "nosniff");
    // Every type an <img> shows is served, AVIF, BMP, and ICO included.
    for (const type of ["image/avif", "image/bmp", "image/x-icon"]) assert.equal(logoResponse(kit(`data:${type};base64,AAAA`), req()).headers.get("content-type"), type);
    // No logo, an external one, a type no page shows, or a broken data URL: not found.
    for (const url of [undefined, "https://cdn.example.com/logo.png", "data:image/tiff;base64,AAAA", "data:image/png;base64"]) {
      assert.throws(() => logoResponse(kit(url), req()), /Logo not found/, String(url));
    }
  });

  it("only takes an uploaded logo in a type the pages can show", () => {
    const base = { primaryColor: "#4f46e5" };
    assert.equal(brandKitSchema.safeParse({ ...base, logoUrl: `data:image/png;base64,${PNG}` }).success, true);
    assert.equal(brandKitSchema.safeParse({ ...base, logoUrl: "data:image/avif;base64,AAAA" }).success, true);
    assert.equal(brandKitSchema.safeParse({ ...base, logoUrl: "data:image/tiff;base64,AAAA" }).success, false);
    assert.equal(brandKitSchema.safeParse({ ...base, logoUrl: "https://cdn.example.com/logo.tiff" }).success, true, "an external URL is the owner's to choose");
  });

  it("gives the talk page a link to an uploaded logo instead of the file", async () => {
    await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#4f46e5", logoUrl: `data:image/png;base64,${PNG}` }), "u-talk");
    const agent = await createAgent(agentSchema.parse({ name: "Ava", avatarId: STOCK_AVATARS[0].id, isPublic: true }), "u-talk");
    const view = await publicAgent(agent.id);
    assert.match(view.brand?.logoUrl ?? "", new RegExp(`^/api/talk/${agent.id}/logo\\?v=`));
    assert.equal(JSON.stringify(view).includes(PNG), false, "the page data no longer carries the file");
    // A new save gives the logo a new address, so no cache keeps the old one.
    await new Promise((r) => setTimeout(r, 5));
    await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#4f46e5", logoUrl: `data:image/png;base64,${PNG}` }), "u-talk");
    assert.notEqual((await publicAgent(agent.id)).brand?.logoUrl, view.brand?.logoUrl);
  });
});
