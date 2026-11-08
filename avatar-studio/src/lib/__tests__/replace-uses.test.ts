// Replacing a presenter or voice in every interactive presenter, template, brand kit default, and photo avatar.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { collectOtherUses, listVoices, replaceUses } from "../services";
import type { Agent, Avatar, BrandKit, VideoTemplate } from "../types";

const OWNER = "user_replace";
const at = "2026-01-01T00:00:00.000Z";
const bg = { type: "color", value: "#fff" } as VideoTemplate["scenes"][number]["background"];
const photo = (id: string, name: string, defaultVoiceId?: string) => ({ id, ownerId: OWNER, name, imageUrl: `https://example.com/${id}.jpg`, source: "custom", createdAt: at, ...(defaultVoiceId ? { defaultVoiceId } : {}) }) as unknown as Avatar;
const agent = (id: string, avatarId: string, voiceId?: string) => ({ id, ownerId: OWNER, name: id, avatarId, voiceId, avatarName: "Old", avatarImageUrl: "https://example.com/old.jpg", instructions: "", isPublic: true, createdAt: at, updatedAt: at }) as unknown as Agent;

async function uses() {
  const store = getStore();
  const [agents, templates, brand, avatars] = await Promise.all([store.list<Agent>("agent", OWNER), store.list<VideoTemplate>("template", OWNER), store.get<BrandKit>("brand", `brand_${OWNER}`), store.list<Avatar>("avatar", OWNER)]);
  return collectOtherUses({ agents, templates, brand, avatars });
}

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

describe("replaceUses", () => {
  it("moves every use of a presenter to another, even for a presenter whose voice has since been deleted", async () => {
    const store = getStore();
    await store.put("avatar", photo("av_old", "Old"));
    await store.put("avatar", photo("av_new", "New"));
    // Its clone voice was deleted after it was saved: the presenter is still switched, the voice left as it is.
    await store.put("agent", agent("desk", "av_old", "clone_gone"));
    await store.put("agent", agent("other", "av_kept"));
    await store.put("template", { id: "tpl", ownerId: OWNER, title: "Promo", avatarId: "av_old", scenes: [{ script: "Hi", background: bg }, { script: "Bye", background: bg, avatarId: "av_old" }], aspect: "16:9", captions: false, speed: 1, createdAt: at, updatedAt: at } as VideoTemplate);
    await store.put("brand", { id: `brand_${OWNER}`, ownerId: OWNER, name: "Acme", primaryColor: "#000000", defaultAvatarId: "av_old", defaultAspect: "16:9", captionsByDefault: false, updatedAt: at } as unknown as BrandKit);
    const before = (await uses()).avatars.av_old;
    const replaced = await replaceUses({ kind: "avatar", from: "av_old", to: "av_new" }, OWNER);
    assert.deepEqual(replaced, { agents: 1, templates: 1, brand: true, avatars: 0 });
    const after = await uses();
    assert.equal(after.avatars.av_old, undefined, "nothing names the old presenter any more");
    assert.deepEqual(after.avatars.av_new, before, "and the new one takes every use it had");
    const desk = (await store.get<Agent>("agent", "desk"))!;
    assert.equal(desk.avatarName, "New", "the talk page shows the new presenter's name");
    assert.equal(desk.voiceId, "clone_gone");
    assert.notEqual(desk.updatedAt, at);
    assert.equal((await store.get<Agent>("agent", "other"))!.avatarId, "av_kept");
  });

  it("moves a voice in the brand kit, a photo avatar's default, and an interactive presenter (with its language)", async () => {
    const store = getStore();
    const [first, second] = await listVoices(OWNER);
    await store.put("avatar", photo("av_me", "Me", first.id));
    await store.put("agent", agent("desk", "av_me", first.id));
    await store.put("brand", { id: `brand_${OWNER}`, ownerId: OWNER, name: "Acme", primaryColor: "#000000", defaultVoiceId: first.id, defaultAspect: "16:9", captionsByDefault: false, updatedAt: at } as unknown as BrandKit);
    const replaced = await replaceUses({ kind: "voice", from: first.id, to: second.id }, OWNER);
    assert.deepEqual(replaced, { agents: 1, templates: 0, brand: true, avatars: 1 });
    assert.equal((await store.get<Avatar>("avatar", "av_me"))!.defaultVoiceId, second.id);
    assert.equal((await store.get<BrandKit>("brand", `brand_${OWNER}`))!.defaultVoiceId, second.id);
    const desk = (await store.get<Agent>("agent", "desk"))!;
    assert.equal(desk.voiceId, second.id);
    assert.equal(desk.voiceLanguage, second.language);
    assert.equal((await uses()).voices[first.id], undefined);
  });

  it("checks the replacement before writing anything", async () => {
    const store = getStore();
    await store.put("agent", agent("desk", "av_old"));
    await assert.rejects(replaceUses({ kind: "avatar", from: "av_old", to: "av_nowhere" }, OWNER), /not found/i);
    await assert.rejects(replaceUses({ kind: "voice", from: "x", to: "voice_nowhere" }, OWNER), /not available/i);
    assert.equal((await store.get<Agent>("agent", "desk"))!.avatarId, "av_old");
  });
});
