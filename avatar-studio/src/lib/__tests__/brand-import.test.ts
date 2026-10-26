// A brand kit read from a company's web page: its name, logo, and colours, and how the page is fetched.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { brandFromHtml, normalizeColor } from "../brand-import";
import { importBrandFromWebsite } from "../services";

const page = (head: string, body = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe("brandFromHtml", () => {
  it("takes the site's declared name, logo, and colours", () => {
    const html = page(
      `<title>Pricing | Acme Cloud</title>
       <meta property="og:site_name" content="Acme &amp; Co">
       <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#111827">
       <meta name="theme-color" media="(prefers-color-scheme: light)" content="#0F766E">
       <link rel="icon" href="/favicon.ico">
       <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"Organization","logo":{"@type":"ImageObject","url":"/img/logo.svg"}}]}</script>
       <style>:root { --brand-accent: #F59E0B; }</style>`,
    );
    assert.deepEqual(brandFromHtml(html, "https://acme.example/pricing"), {
      sourceUrl: "https://acme.example/pricing",
      name: "Acme & Co",
      logoUrl: "https://acme.example/img/logo.svg",
      primaryColor: "#0f766e",
      accentColor: "#f59e0b",
    });
  });

  it("falls back to the title, the sharpest icon, and colours that are not white or grey", () => {
    const html = page(
      `<title>Maple Street Realty — Homes in Portland</title>
       <meta name="theme-color" content="#ffffff">
       <link rel="icon" href="data:image/png;base64,AAAA">
       <link rel="icon" sizes="16x16" href="/fav-16.png">
       <link rel="icon" sizes="192x192" href="https://cdn.example/fav-192.png">
       <link rel="mask-icon" href="/pin.svg" color="rgb(220, 38, 38)">
       <style>.x { --color-primary: #fff; --primary-500: #2563eb; }</style>`,
    );
    const s = brandFromHtml(html, "https://maple.example/");
    assert.equal(s.name, "Maple Street Realty");
    assert.equal(s.logoUrl, "https://cdn.example/fav-192.png", "the largest favicon, never a data URI");
    assert.equal(s.primaryColor, "#dc2626", "white is a header colour, not the brand's");
    assert.equal(s.accentColor, "#2563eb");
    // A touch icon beats any favicon; a page that declares nothing yields only its address.
    assert.equal(brandFromHtml(page(`<link rel="apple-touch-icon" href="touch.png"><link rel="icon" sizes="any" href="/a.svg">`), "https://a.example/x/").logoUrl, "https://a.example/x/touch.png");
    assert.deepEqual(brandFromHtml(page(""), "https://b.example/"), { sourceUrl: "https://b.example/" });
  });

  it("reads colours written as short hex, hex with alpha, and rgb()", () => {
    assert.equal(normalizeColor("#0Af"), "#00aaff");
    assert.equal(normalizeColor("#0f766e80"), "#0f766e");
    assert.equal(normalizeColor("rgba(15, 118, 110, 0.5)"), "#0f766e");
    assert.equal(normalizeColor("rgb(300, 0, 0)"), undefined);
    assert.equal(normalizeColor("teal"), undefined);
  });
});

describe("importBrandFromWebsite", () => {
  const html = page(`<title>Acme</title><meta name="theme-color" content="#4f46e5">`);
  it("follows a few redirects, each to a public address, and takes a bare domain as https", async () => {
    const asked: string[] = [];
    const fetchImpl = async (url: string) => {
      asked.push(url);
      if (url === "https://203.0.113.5/") return new Response(null, { status: 301, headers: { location: "/home" } });
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    };
    const s = await importBrandFromWebsite({ url: "203.0.113.5" }, fetchImpl);
    assert.deepEqual(asked, ["https://203.0.113.5/", "https://203.0.113.5/home"]);
    assert.deepEqual(s, { sourceUrl: "https://203.0.113.5/home", name: "Acme", primaryColor: "#4f46e5" });
  });

  it("refuses a redirect to a private address, endless redirects, and a page that names nothing", async () => {
    const toPrivate = async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
    await assert.rejects(importBrandFromWebsite({ url: "https://203.0.113.5/" }, toPrivate), /public|private|not allowed/i);
    const loop = async (url: string) => new Response(null, { status: 302, headers: { location: `${url}x` } });
    await assert.rejects(importBrandFromWebsite({ url: "https://203.0.113.5/" }, loop), /redirects too many times/);
    const bare = async () => new Response(page(""), { headers: { "content-type": "text/html" } });
    await assert.rejects(importBrandFromWebsite({ url: "https://203.0.113.5/" }, bare), /names no brand name, logo, or colour/);
    await assert.rejects(importBrandFromWebsite({ url: "ftp://203.0.113.5/" }, bare), /http/i);
  });
});
