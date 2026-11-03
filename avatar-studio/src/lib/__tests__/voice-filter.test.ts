// The library's voice filter: which voices a video speaks in, how many videos each is in, and the filter itself.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { countNeeds, countPresenters, filterVideos, queryVideos, videoNeeds, videoPresenters, videoQuerySchema, videoVoices } from "../services";
import type { Video } from "../types";

const OWNER = "user_voice_filter";
const made = (id: string, createdAt: string, patch: Partial<Video> = {}) =>
  ({ id, ownerId: OWNER, title: id, script: "Hi.", avatarId: "anna", avatarName: "Anna", voiceId: "emma", voiceName: "Emma", status: "completed", provider: "mock", createdAt, updatedAt: createdAt, ...patch }) as Video;
const plain = { type: "color", value: "#ffffff" } as Video["background"] & object;
const scene = (patch: Partial<NonNullable<Video["scenes"]>[number]> = {}) => ({ script: "Hi.", background: plain, ...patch }) as NonNullable<Video["scenes"]>[number];

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

describe("videoVoices", () => {
  it("names the video's own voice, then each scene's, once each, and none for a recording", () => {
    assert.deepEqual(videoVoices(made("a", "2026-10-01T00:00:00Z")), [{ id: "emma", name: "Emma" }]);
    const mixed = made("b", "2026-10-01T00:00:00Z", { scenes: [scene({ voiceId: "james", voiceName: "James" }), scene(), scene({ voiceId: "james", voiceName: "James" })] });
    assert.deepEqual(videoVoices(mixed), [{ id: "james", name: "James" }, { id: "emma", name: "Emma" }]);
    // A scene lip-synced to a recording speaks in no voice; one that hides the presenter is still narrated.
    const recorded = made("c", "2026-10-01T00:00:00Z", { scenes: [scene({ audioId: "clip_1" }), scene({ voiceId: "james", voiceName: "James", hidePresenter: true })] });
    assert.deepEqual(videoVoices(recorded), [{ id: "james", name: "James" }]);
    assert.deepEqual(videoVoices(made("d", "2026-10-01T00:00:00Z", { scenes: [scene({ audioId: "clip_1" })] })), []);
  });

  it("gives a cinematic shot and a directed video HeyGen cast none, and a HeyGen template video its slots", () => {
    const shot = made("e", "2026-10-01T00:00:00Z", { voiceId: "cinematic", voiceName: undefined, cinematic: { prompt: "A walk", avatarIds: ["anna"], avatarNames: ["Anna"] } });
    assert.deepEqual(videoVoices(shot), []);
    assert.deepEqual(videoVoices(made("cast", "2026-10-01T00:00:00Z", { voiceId: "", voiceName: undefined })), []);
    // A template video's labels are the template's; its slots given one of the account's voices or presenters count.
    const bare = { id: "tpl_1", name: "Product launch", variables: {} } as unknown as Video["studioTemplate"];
    assert.deepEqual(videoVoices(made("t", "2026-10-01T00:00:00Z", { voiceId: "studio-template", studioTemplate: bare })), []);
    const filled = { id: "tpl_1", name: "Product launch", variables: { narrator: { type: "voice", voice_id: "clone_1" }, host: { type: "character", avatar_id: "stock_3" }, title: { type: "text", content: "Hi" } } } as unknown as Video["studioTemplate"];
    const tv = made("t2", "2026-10-01T00:00:00Z", { voiceId: "clone_1", voiceName: "Product launch", avatarName: "Product launch", studioTemplate: filled });
    assert.deepEqual(videoVoices(tv), [{ id: "clone_1", name: "" }]);
    assert.deepEqual(videoPresenters(tv), [{ id: "stock_3", name: "" }]);
  });

  it("leaves out a scene of nothing but pauses, which speaks in no voice", () => {
    const quiet = made("q", "2026-10-01T00:00:00Z", { scenes: [scene({ script: "[pause 2s]", voiceId: "james", voiceName: "James" }), scene()] });
    assert.deepEqual(videoVoices(quiet), [{ id: "emma", name: "Emma" }]);
    assert.deepEqual(videoVoices(made("q2", "2026-10-01T00:00:00Z", { script: "[pause 3s]" })), []);
  });
});

describe("videoNeeds", () => {
  it("asks for the video's own presenter and voice and every scene's, whether or not a scene shows or speaks in them", () => {
    const v = made("n", "2026-10-01T00:00:00Z", { scenes: [scene({ audioId: "clip_1" }), scene({ voiceId: "james", avatarId: "ben", hidePresenter: true }), scene({ script: "[pause 1s]", voiceId: "olivia" })] });
    assert.deepEqual(videoVoices(v), [{ id: "james", name: "" }]);
    assert.deepEqual(videoNeeds(v), { avatars: ["anna", "ben"], voices: ["emma", "james", "olivia"] });
    const shot = made("s", "2026-10-01T00:00:00Z", { voiceId: "cinematic", cinematic: { prompt: "A walk", avatarIds: ["anna", "ben"], avatarNames: ["Anna", "Ben"] } });
    assert.deepEqual(videoNeeds(shot), { avatars: ["anna", "ben"], voices: [] });
    assert.deepEqual(videoNeeds(made("cast", "2026-10-01T00:00:00Z", { avatarId: "", voiceId: "" })), { avatars: [], voices: [] });
    const counts = countNeeds([v, made("m", "2026-10-02T00:00:00Z"), made("p", "2026-10-03T00:00:00Z", { voiceId: "constructor" })]);
    assert.deepEqual(counts.voices, { emma: 2, james: 1, olivia: 1, constructor: 1 });
    assert.deepEqual(counts.avatars, { anna: 3, ben: 1 });
  });
});

describe("the voice filter", () => {
  it("keeps the videos a voice speaks in, in any scene, and counts every voice whatever the other filters", async () => {
    const videos = [
      made("solo-emma", "2026-10-01T00:00:00Z", { folder: "Launch" }),
      made("scene-james", "2026-10-02T00:00:00Z", { scenes: [scene(), scene({ voiceId: "james", voiceName: "James" })] }),
      made("only-james", "2026-10-03T00:00:00Z", { voiceId: "james", voiceName: "James" }),
    ];
    const ids = (voice?: string) => filterVideos(videos, videoQuerySchema.parse({ voice })).map((v) => v.id);
    assert.deepEqual(ids("james"), ["only-james", "scene-james"]);
    assert.deepEqual(ids("emma"), ["scene-james", "solo-emma"]);
    assert.deepEqual(ids("nobody"), []);
    assert.throws(() => videoQuerySchema.parse({ voice: "" }));
    // With the presenter filter too, both must hold.
    assert.deepEqual(filterVideos(videos, videoQuerySchema.parse({ voice: "james", presenter: "anna" })).map((v) => v.id), ["only-james", "scene-james"]);
    assert.deepEqual(filterVideos(videos, videoQuerySchema.parse({ voice: "james", presenter: "ben" })), []);
    assert.deepEqual(countPresenters(videos, videoVoices), [
      { id: "emma", name: "Emma", count: 2 },
      { id: "james", name: "James", count: 2 },
    ]);

    for (const v of videos) await getStore().put("video", v);
    await getStore().put("video", made("trashed-james", "2026-10-04T00:00:00Z", { voiceId: "james", voiceName: "James", deletedAt: "2026-10-05T00:00:00Z" }));
    const page = await queryVideos(OWNER, videoQuerySchema.parse({ voice: "james", folder: "Launch" }));
    assert.equal(page.matched, 0);
    assert.deepEqual(page.voices, [
      { id: "emma", name: "Emma", count: 2 },
      { id: "james", name: "James", count: 2 },
    ]);
    const trash = await queryVideos(OWNER, videoQuerySchema.parse({ trash: "true", voice: "james" }));
    assert.deepEqual(trash.voices, [{ id: "james", name: "James", count: 1 }]);
    assert.deepEqual(trash.videos.map((v) => v.id), ["trashed-james"]);
    // The needs count the library and the trash together, whichever view is asked for.
    assert.equal(page.needs.voices.james, 3);
    assert.equal(trash.needs.voices.james, 3);
  });
});
