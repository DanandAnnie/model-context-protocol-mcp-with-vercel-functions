// What besides videos names a presenter or voice, which a delete on the Avatars or Voices page warns about.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectOtherUses, describeOtherUses } from "../services";
import { nameOtherUses, usesOf, type OtherUse } from "../presenters";
import type { Agent, Avatar, BrandKit, VideoTemplate } from "../types";

const agent = (name: string, avatarId: string, voiceId?: string) => ({ id: name, ownerId: "o", name, avatarId, voiceId, avatarName: "", avatarImageUrl: "", instructions: "" }) as unknown as Agent;
const template = (title: string, patch: Partial<VideoTemplate>) => ({ id: title, title, scenes: [], aspect: "16:9", captions: false, speed: 1, ...patch }) as VideoTemplate;

describe("collectOtherUses", () => {
  it("lists each interactive presenter, template, the brand kit, and a photo avatar's default voice once each", () => {
    const uses = collectOtherUses({
      agents: [agent("Front desk", "anna", "emma"), agent("After hours", "anna")],
      templates: [template("Welcome", { avatarId: "anna", voiceId: "emma", scenes: [{ script: "Hi", background: { type: "color", value: "#fff" }, avatarId: "anna", voiceId: "james" }] as VideoTemplate["scenes"] })],
      brand: { defaultAvatarId: "ben", defaultVoiceId: "emma" } as BrandKit,
      avatars: [{ id: "c1", name: "Me", source: "custom", defaultVoiceId: "emma" } as Avatar, { id: "stock_1", name: "Ava", source: "library", defaultVoiceId: "olivia" } as unknown as Avatar],
    });
    assert.deepEqual(uses.avatars.anna, [
      { kind: "agent", name: "Front desk" },
      { kind: "agent", name: "After hours" },
      { kind: "template", name: "Welcome" },
    ]);
    assert.deepEqual(uses.avatars.ben, [{ kind: "brand", name: "" }]);
    assert.deepEqual(uses.voices.emma, [
      { kind: "agent", name: "Front desk" },
      { kind: "template", name: "Welcome" },
      { kind: "brand", name: "" },
      { kind: "avatar", name: "Me" },
    ]);
    // A presenter or voice only one of a template's scenes names counts for the template too.
    assert.deepEqual(uses.voices.james, [{ kind: "template", name: "Welcome" }]);
    assert.equal(uses.voices.olivia, undefined);
    assert.deepEqual(collectOtherUses({ agents: [], templates: [], brand: null, avatars: [] }), { avatars: {}, voices: {} });
  });
});

describe("describeOtherUses", () => {
  it("names one of each kind, and counts more than one", () => {
    assert.equal(describeOtherUses(undefined), "");
    assert.equal(describeOtherUses([]), "");
    assert.equal(describeOtherUses([{ kind: "brand", name: "" }]), "the brand kit");
    assert.equal(describeOtherUses([{ kind: "agent", name: "Front desk" }]), "the interactive presenter “Front desk”");
    assert.equal(describeOtherUses([{ kind: "template", name: "Welcome" }, { kind: "brand", name: "" }]), "the template “Welcome” and the brand kit");
    assert.equal(describeOtherUses([{ kind: "avatar", name: "A" }, { kind: "avatar", name: "B" }]), "2 photo avatars (as their default voice)");
    assert.equal(
      describeOtherUses([{ kind: "agent", name: "A" }, { kind: "agent", name: "B" }, { kind: "template", name: "Welcome" }, { kind: "brand", name: "" }, { kind: "avatar", name: "Me" }]),
      "2 interactive presenters, the template “Welcome”, the brand kit, and the photo avatar “Me” (as its default voice)",
    );
  });
});

describe("usesOf and nameOtherUses", () => {
  it("reads an id's own entry only, and names every use for the list under a counted line", () => {
    const byId = { anna: [{ kind: "template", name: "Welcome" }, { kind: "template", name: "Promo" }, { kind: "brand", name: "" }] } as Record<string, OtherUse[]>;
    assert.equal(usesOf(byId, "constructor"), undefined);
    assert.equal(usesOf(undefined, "anna"), undefined);
    assert.equal(describeOtherUses(usesOf(byId, "anna")), "2 templates and the brand kit");
    assert.deepEqual(nameOtherUses(usesOf(byId, "anna")), ["the template “Welcome”", "the template “Promo”", "the brand kit"]);
    assert.deepEqual(nameOtherUses(undefined), []);
  });
});
