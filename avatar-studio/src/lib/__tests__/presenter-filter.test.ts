// The library's presenter filter: which presenters a video shows, how many videos each is in, and the filter itself.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { countPresenters, filterVideos, queryVideos, videoPresenters, videoQuerySchema } from "../services";
import type { Video } from "../types";

const OWNER = "user_presenter_filter";
const made = (id: string, createdAt: string, patch: Partial<Video> = {}) =>
  ({ id, ownerId: OWNER, title: id, script: "Hi.", avatarId: "anna", avatarName: "Anna", voiceId: "v", status: "completed", provider: "mock", createdAt, updatedAt: createdAt, ...patch }) as Video;
const plain = { type: "color", value: "#ffffff" } as Video["background"] & object;
const scene = (patch: Partial<NonNullable<Video["scenes"]>[number]> = {}) => ({ script: "Hi.", background: plain, ...patch }) as NonNullable<Video["scenes"]>[number];

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

describe("videoPresenters", () => {
  it("names the video's own presenter, then each scene's, once each", () => {
    assert.deepEqual(videoPresenters(made("a", "2026-10-01T00:00:00Z")), [{ id: "anna", name: "Anna" }]);
    const mixed = made("b", "2026-10-01T00:00:00Z", { scenes: [scene({ avatarId: "ben", avatarName: "Ben" }), scene(), scene({ avatarId: "ben", avatarName: "Ben" }), scene({ avatarId: "anna" })] });
    assert.deepEqual(videoPresenters(mixed), [{ id: "ben", name: "Ben" }, { id: "anna", name: "Anna" }]);
  });

  it("leaves out a presenter only hidden scenes would show, and names a cinematic shot's", () => {
    const hidden = made("c", "2026-10-01T00:00:00Z", { scenes: [scene({ hidePresenter: true, background: { type: "image", value: "https://example.com/a.png" } as never }), scene({ avatarId: "ben", avatarName: "Ben" })] });
    assert.deepEqual(videoPresenters(hidden), [{ id: "ben", name: "Ben" }]);
    const none = made("d", "2026-10-01T00:00:00Z", { scenes: [scene({ hidePresenter: true })] });
    assert.deepEqual(videoPresenters(none), []);
    const shot = made("e", "2026-10-01T00:00:00Z", { cinematic: { prompt: "A walk", avatarIds: ["cara", "ben"], avatarNames: ["Cara", "Ben"] } });
    assert.deepEqual(videoPresenters(shot), [{ id: "cara", name: "Cara" }, { id: "ben", name: "Ben" }]);
  });

  it("gives a HeyGen template video none, whatever its labels say, and a directed video HeyGen cast none", () => {
    // The template's name stands in the presenter's name, and its character (or a placeholder) in the id.
    const template = { id: "tpl_1", name: "Product launch", variables: {} } as unknown as Video["studioTemplate"];
    assert.deepEqual(videoPresenters(made("t1", "2026-10-01T00:00:00Z", { avatarId: "studio-template", avatarName: "Product launch", studioTemplate: template })), []);
    assert.deepEqual(videoPresenters(made("t2", "2026-10-01T00:00:00Z", { avatarId: "anna", avatarName: "Product launch", studioTemplate: template })), []);
    assert.deepEqual(videoPresenters(made("cast", "2026-10-01T00:00:00Z", { avatarId: "", avatarName: undefined })), []);
  });
});

describe("countPresenters", () => {
  it("counts each presenter's videos, named as the newest video gave it, ordered by name", () => {
    const videos = [
      made("old", "2026-09-01T00:00:00Z", { avatarName: "Anna (old name)" }),
      made("new", "2026-10-01T00:00:00Z"),
      made("both", "2026-09-15T00:00:00Z", { scenes: [scene(), scene({ avatarId: "ben", avatarName: "Ben" })] }),
      made("unnamed", "2026-09-20T00:00:00Z", { avatarId: "zed", avatarName: undefined }),
    ];
    assert.deepEqual(countPresenters(videos), [
      { id: "zed", name: "", count: 1 },
      { id: "anna", name: "Anna", count: 3 },
      { id: "ben", name: "Ben", count: 1 },
    ]);
    assert.deepEqual(countPresenters([]), []);
    // A newer template video named after its template does not rename the presenter its character is.
    const template = { id: "tpl_1", name: "Product launch", variables: {} } as unknown as Video["studioTemplate"];
    const withTemplate = [...videos, made("tpl", "2026-11-01T00:00:00Z", { avatarName: "Product launch", studioTemplate: template })];
    assert.deepEqual(countPresenters(withTemplate).find((p) => p.id === "anna"), { id: "anna", name: "Anna", count: 3 });
  });
});

describe("the presenter filter", () => {
  it("keeps the videos a presenter appears in, in any scene, and counts every presenter whatever the other filters", async () => {
    const videos = [
      made("solo-anna", "2026-10-01T00:00:00Z", { folder: "Launch" }),
      made("scene-ben", "2026-10-02T00:00:00Z", { scenes: [scene(), scene({ avatarId: "ben", avatarName: "Ben" })] }),
      made("only-ben", "2026-10-03T00:00:00Z", { avatarId: "ben", avatarName: "Ben" }),
    ];
    const ids = (presenter?: string) => filterVideos(videos, videoQuerySchema.parse({ presenter })).map((v) => v.id);
    assert.deepEqual(ids("ben"), ["only-ben", "scene-ben"]);
    assert.deepEqual(ids("anna"), ["scene-ben", "solo-anna"]);
    assert.deepEqual(ids("nobody"), []);
    assert.deepEqual(ids(undefined), ["only-ben", "scene-ben", "solo-anna"]);
    assert.throws(() => videoQuerySchema.parse({ presenter: "" }));
    assert.throws(() => videoQuerySchema.parse({ presenter: "x".repeat(121) }));

    for (const v of videos) await getStore().put("video", v);
    const page = await queryVideos(OWNER, videoQuerySchema.parse({ presenter: "ben", folder: "Launch" }));
    assert.equal(page.matched, 0);
    // The counts are of the whole view, as the folder counts are, so the picker says what each choice holds.
    assert.deepEqual(page.presenters, [
      { id: "anna", name: "Anna", count: 2 },
      { id: "ben", name: "Ben", count: 2 },
    ]);
    // The trash is its own view, with its own counts, and the filter works there too.
    // Trashed yesterday: a fixed date would be purged, and leave the trash view, once the retention window passed it.
    await getStore().put("video", made("trashed-ben", "2026-10-04T00:00:00Z", { avatarId: "ben", avatarName: "Ben", deletedAt: new Date(Date.now() - 86_400_000).toISOString() }));
    const trash = await queryVideos(OWNER, videoQuerySchema.parse({ trash: "true", presenter: "ben" }));
    assert.deepEqual(trash.presenters, [{ id: "ben", name: "Ben", count: 1 }]);
    assert.deepEqual(trash.videos.map((v) => v.id), ["trashed-ben"]);
    assert.deepEqual((await queryVideos(OWNER, videoQuerySchema.parse({ trash: "true", presenter: "anna" }))).matched, 0);
    assert.equal((await queryVideos(OWNER, videoQuerySchema.parse({}))).presenters.find((p) => p.id === "ben")?.count, 2);
  });
});
