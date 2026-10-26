// Brand logos on public pages: linked through a cacheable route instead of sent inline.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { logoResponse, publicLogoSrc, servableLogo } from "../brand-logo";
import { logoDataUrlValid, logoFileType } from "../logo-types";
import { watermarkPlace } from "../watermark";
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

  it("judges a logo exactly as the route serves it: type in any case, and a data URL that decodes", () => {
    assert.equal(servableLogo(`data:image/PNG;base64,${PNG}`), true);
    assert.equal(logoResponse({ logoUrl: `data:image/PNG;base64,${PNG}`, updatedAt: "x" }, req()).headers.get("content-type"), "image/png");
    assert.equal(servableLogo("data:image/png;base64"), false, "no comma, nothing to decode");
    assert.equal(servableLogo("data:image/tiff;base64,AAAA"), false);
    // The browser-side check the brand page uses agrees: a logo it keeps is one the kit will accept.
    for (const url of [`data:image/png;base64,${PNG}`, `data:image/PNG;base64,${PNG}`, "data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E", "data:image/png;base64", "data:image/png;base64,", "data:image/png;base64,***", "data:image/tiff;base64,AAAA", "data:image/svg+xml,%E0%A4%A"]) {
      assert.equal(logoDataUrlValid(url), servableLogo(url), url);
    }
    assert.equal(logoDataUrlValid("data:image/png;base64"), false);
    assert.equal(logoDataUrlValid("data:image/png;base64,***"), false);
    assert.equal(brandKitSchema.safeParse({ primaryColor: "#4f46e5", logoUrl: "data:image/png;base64" }).success, false);
    // A picked file's type, or one read from its name when the browser reports none.
    assert.equal(logoFileType({ type: "image/png", name: "a.png" }), "image/png");
    assert.equal(logoFileType({ type: "", name: "brand.ICO" }), "image/x-icon");
    assert.equal(logoFileType({ type: "", name: "brand.avif" }), "image/avif");
    assert.equal(logoFileType({ type: "image/tiff", name: "a.tif" }), undefined);
    assert.equal(logoFileType({ type: "", name: "noext" }), undefined);
  });

  it("puts the watermark in each corner with one position class, clear of controls and captions at the bottom", () => {
    const position = (classes: string) => classes.split(" ").filter((c) => c.startsWith("object-"));
    assert.deepEqual(position(watermarkPlace("top-left", false)), ["object-[left_top]"]);
    assert.deepEqual(position(watermarkPlace("top-right", true)), ["object-[right_top]"]);
    assert.deepEqual(position(watermarkPlace("bottom-left", false)), ["object-[left_bottom]"]);
    assert.deepEqual(position(watermarkPlace("bottom-right", false)), ["object-[right_bottom]"]);
    assert.match(watermarkPlace("top-left", true), /\bleft-\[3%\] top-\[4%\]/);
    assert.match(watermarkPlace("top-right", false), /\bright-\[3%\] top-\[4%\]/);
    assert.match(watermarkPlace("bottom-left", false), /bottom-\[max\(2\.75rem,12%\)\]/);
    assert.match(watermarkPlace("bottom-right", true), /bottom-\[max\(2\.75rem,24%\)\]/, "a captioned video lifts it above the caption band");
    assert.doesNotMatch(watermarkPlace("top-left", true), /bottom-/);
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
