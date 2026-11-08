// A brand kit as a file: downloaded from one space, loaded into another. Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { BRAND_FILE_KIND, brandKitFile, brandKitFileName, createBackdrop, readBrandKitFile, saveBrandKit, brandKitSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { backdropPath } from "../types";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const dataUrl = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;

describe("brand kit file", () => {
  beforeEach(() => {
    globalThis.__avatarStudioStore = new MemoryStore();
  });

  it("holds every setting but where the kit is kept and when it was saved, named after the brand", async () => {
    const kit = await saveBrandKit(brandKitSchema.parse({ name: "Acme Realty", primaryColor: "#112233", glossary: ["Acme"], writingStyle: "Warm and plain." }), "user_from");
    const file = brandKitFile(kit);
    assert.equal(file.kind, BRAND_FILE_KIND);
    assert.equal(file.version, 1);
    assert.deepEqual(Object.keys(file.kit).filter((k) => ["id", "ownerId", "updatedAt"].includes(k)), []);
    assert.equal(file.kit.name, "Acme Realty");
    assert.deepEqual(file.kit.glossary, ["Acme"]);
    assert.equal(brandKitFileName(kit), "brand-kit-acme-realty.json");
    assert.equal(brandKitFileName({ name: "" }), "brand-kit.json");
    assert.equal(brandKitFileName({ name: "Café Noël!" }), "brand-kit-cafe-noel.json");
    assert.equal(brandKitFileName({ name: "東京" }), "brand-kit.json");
    // Cut to 40 characters before the ends are trimmed, so a long name never ends in a hyphen.
    assert.equal(brandKitFileName({ name: `${"a".repeat(39)} b` }), `brand-kit-${"a".repeat(39)}.json`);
  });

  it("reads a file back for another space, as a save would check it, saving nothing", async () => {
    const from = await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#112233", defaultAvatarId: STOCK_AVATARS[0].id, defaultVoiceId: STOCK_VOICES[0].id, captionsByDefault: true }), "user_from");
    const round = JSON.parse(JSON.stringify(brandKitFile(from)));
    const { kit, leftOut } = await readBrandKitFile(round, "user_to");
    assert.deepEqual(leftOut, [], "library presenters and voices are in every space");
    assert.equal(kit.defaultAvatarId, STOCK_AVATARS[0].id);
    assert.equal(kit.defaultVoiceId, STOCK_VOICES[0].id);
    assert.equal(kit.captionsByDefault, true);
    assert.equal(kit.primaryColor, "#112233");
    // Saving it in the new space works as it stands.
    await saveBrandKit(kit, "user_to");
  });

  it("leaves out the presenter, voice, and background the space does not have, and names them", async () => {
    const picture = await createBackdrop({ name: "Office", image: dataUrl(PNG) }, "user_from");
    const file = {
      kind: BRAND_FILE_KIND,
      version: 1,
      kit: { name: "Acme", primaryColor: "#112233", defaultAvatarId: "av_not_here", defaultVoiceId: "voice_not_here", defaultBackground: { type: "image", value: backdropPath(picture.id) } },
    };
    const { kit, leftOut } = await readBrandKitFile(file, "user_to");
    assert.deepEqual(leftOut, ["the default presenter", "the default voice", "the default background picture"]);
    assert.equal(kit.defaultAvatarId, undefined);
    assert.equal(kit.defaultVoiceId, undefined);
    assert.equal(kit.defaultBackground, undefined);
    // In its own space, the picture is kept.
    const own = await readBrandKitFile(file, "user_from");
    assert.deepEqual(own.leftOut, ["the default presenter", "the default voice"]);
    assert.equal(own.kit.defaultBackground?.value, backdropPath(picture.id));
  });

  it("refuses what is not a brand kit file, or a kit the rules refuse", async () => {
    await assert.rejects(readBrandKitFile({ name: "Acme" }, "u"), /not a brand kit file/);
    await assert.rejects(readBrandKitFile(null, "u"), /not a brand kit file/);
    await assert.rejects(readBrandKitFile([1, 2], "u"), /not a brand kit file/);
    await assert.rejects(readBrandKitFile({ kind: BRAND_FILE_KIND, version: 2, kit: {} }, "u"), /newer version/);
    for (const version of ["1", 0, undefined, -1]) await assert.rejects(readBrandKitFile({ kind: BRAND_FILE_KIND, version, kit: {} }, "u"), /not a brand kit file/);
    await assert.rejects(readBrandKitFile({ kind: BRAND_FILE_KIND, version: 1, kit: { name: "Acme", primaryColor: "blue" } }, "u"), /cannot be used \(primaryColor\): Use a 6-digit hex color/);
    await assert.rejects(readBrandKitFile({ kind: BRAND_FILE_KIND, version: 1 }, "u"), /cannot be used/);
  });
});
