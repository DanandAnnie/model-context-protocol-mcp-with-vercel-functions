// What besides videos names a presenter or voice, which a delete on the Avatars or Voices page warns about.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectOtherUses, describeOtherUses, replaceInTemplate } from "../services";
import { describeReplaced, nameOtherUses, usesOf, type OtherUse } from "../presenters";
import { describeActivity } from "../activity-text";
import type { ActivityEvent, Agent, Avatar, BrandKit, VideoTemplate } from "../types";

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

describe("replaceInTemplate", () => {
  const bg = { type: "color", value: "#fff" } as VideoTemplate["scenes"][number]["background"];
  it("switches the template's own presenter and every scene's, leaving the rest", () => {
    const t = template("Welcome", { avatarId: "anna", voiceId: "emma", scenes: [{ script: "Hi", background: bg, avatarId: "anna" }, { script: "Bye", background: bg, avatarId: "ben", voiceId: "emma" }] as VideoTemplate["scenes"] });
    const next = replaceInTemplate(t, "avatar", "anna", "cleo")!;
    assert.equal(next.avatarId, "cleo");
    assert.deepEqual(next.scenes.map((sc) => sc.avatarId), ["cleo", "ben"]);
    assert.equal(next.voiceId, "emma");
    assert.equal(t.avatarId, "anna", "the original is left as it was");
  });
  it("switches a voice named only in a scene, and returns null when nothing names it", () => {
    const t = template("Promo", { voiceId: "james", scenes: [{ script: "Hi", background: bg, voiceId: "emma" }] as VideoTemplate["scenes"] });
    const next = replaceInTemplate(t, "voice", "emma", "olivia")!;
    assert.equal(next.voiceId, "james");
    assert.equal(next.scenes[0].voiceId, "olivia");
    assert.equal(replaceInTemplate(t, "voice", "nobody", "olivia"), null);
  });
});

describe("describeReplaced", () => {
  it("says what a replace changed, and nothing when it changed nothing", () => {
    assert.equal(describeReplaced({ agents: 1, templates: 2, brand: false, avatars: 0 }), "1 interactive presenter and 2 templates");
    assert.equal(describeReplaced({ agents: 0, templates: 1, brand: true, avatars: 2 }), "1 template, the brand kit, and 2 photo avatars' default voice");
    assert.equal(describeReplaced({ agents: 0, templates: 0, brand: false, avatars: 0 }), "");
  });
});

describe("the activity feed's replace entry", () => {
  const e = { id: "act_1", ownerId: "ws_1", kind: "usage.replaced", actorId: "u_1", actorEmail: "dana@example.com", subject: "Ava", replacement: "Ben", replaced: { kind: "avatar", agents: 0, templates: 2, brand: true, avatars: 0 }, createdAt: "2026-11-03T00:00:00.000Z" } as ActivityEvent;
  it("names both and what changed", () => {
    assert.equal(describeActivity(e), `dana@example.com replaced "Ava" with "Ben" in 2 templates and the brand kit`);
    assert.equal(describeActivity(e, "u_1"), `You replaced "Ava" with "Ben" in 2 templates and the brand kit`);
    assert.equal(describeActivity({ ...e, actorId: "ws_1", actorEmail: undefined }), `A script with an API key replaced "Ava" with "Ben" in 2 templates and the brand kit`);
  });
  it("says every kind that changed in full, however long", () => {
    const all = { ...e, kind: "usage.replaced", replaced: { kind: "voice", agents: 12, templates: 34, brand: true, avatars: 5 } } as ActivityEvent;
    assert.match(describeActivity(all), / in 12 interactive presenters, 34 templates, the brand kit, and 5 photo avatars' default voice$/);
  });
  it("says a deleted presenter or voice when its name could not be found", () => {
    assert.equal(describeActivity({ ...e, subject: undefined }), `dana@example.com replaced a deleted presenter with "Ben" in 2 templates and the brand kit`);
    assert.equal(describeActivity({ ...e, subject: undefined, replacement: undefined, replaced: { ...e.replaced!, kind: "voice" } }), `dana@example.com replaced a deleted voice with another voice in 2 templates and the brand kit`);
  });
});
