// Share links to social networks: each carries the share page, encoded, and the title where the network takes one.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { socialShareLinks } from "../social";

describe("social share links", () => {
  it("encode the share page and the title for each network", () => {
    const links = socialShareLinks("https://studio.example.com/share/vid_1?x=1&y=2", "  Tour: 48 Harbor View & more  ");
    const by = Object.fromEntries(links.map((l) => [l.network, l.href]));
    const page = "https%3A%2F%2Fstudio.example.com%2Fshare%2Fvid_1%3Fx%3D1%26y%3D2";
    assert.deepEqual(links.map((l) => l.network), ["linkedin", "x", "facebook", "whatsapp", "email"]);
    assert.equal(by.linkedin, `https://www.linkedin.com/sharing/share-offsite/?url=${page}`);
    assert.equal(by.x, `https://x.com/intent/post?url=${page}&text=Tour%3A%2048%20Harbor%20View%20%26%20more`);
    assert.equal(by.facebook, `https://www.facebook.com/sharer/sharer.php?u=${page}`);
    assert.equal(by.whatsapp, `https://wa.me/?text=Tour%3A%2048%20Harbor%20View%20%26%20more%20${page}`);
    assert.equal(by.email, `mailto:?subject=Tour%3A%2048%20Harbor%20View%20%26%20more&body=${page}`);
    // Nothing in the title can break out of its parameter.
    const separators = { linkedin: 0, x: 1, facebook: 0, whatsapp: 0, email: 1 };
    for (const l of links) {
      assert.doesNotMatch(l.href, /[ #]/, l.network);
      assert.equal(l.href.split("&").length - 1, separators[l.network], `${l.network} has only its own parameters`);
    }
  });

  it("leave the title out when there is none", () => {
    const by = Object.fromEntries(socialShareLinks("https://s.example/share/v", " ").map((l) => [l.network, l.href]));
    assert.equal(by.x, "https://x.com/intent/post?url=https%3A%2F%2Fs.example%2Fshare%2Fv");
    assert.equal(by.whatsapp, "https://wa.me/?text=https%3A%2F%2Fs.example%2Fshare%2Fv");
    assert.equal(by.email, "mailto:?subject=A%20video%20for%20you&body=https%3A%2F%2Fs.example%2Fshare%2Fv");
  });
});
