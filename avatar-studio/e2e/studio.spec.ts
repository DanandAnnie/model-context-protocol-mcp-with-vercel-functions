import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { parseCsv } from "../src/lib/csv";

// Demo-mode flows. The mock renderer completes ~12s after submission.

async function createVideoViaApi(page: Page, title: string, extra: Record<string, unknown> = {}) {
  const res = await page.request.post("/api/videos", {
    data: { title, script: "Hello there. This is the first sentence. And here is the second one!", avatarId: "stock_2", voiceId: "stock_voice_2", aspect: "1:1", ...extra },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).video as { id: string };
}

test.beforeEach(async ({ page }) => {
  await page.goto("/create");
  await page.evaluate(() => localStorage.removeItem("avatar-studio:draft"));
});

test("health endpoint and email preferences", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  const h = await health.json();
  expect(h.ok).toBe(true);
  expect(h.providers.avatar).toBe("mock");
  expect((await request.put("/api/prefs", { data: { emailOnComplete: "not-an-email" } })).status()).toBe(400);
  expect((await request.put("/api/prefs", { data: { emailOnComplete: "dana@example.com" } })).status()).toBe(200);
  const prefs = await (await request.get("/api/prefs")).json();
  expect(prefs.prefs.emailOnComplete).toBe("dana@example.com");
  expect(prefs.emailDelivers).toBe(false);
  expect((await request.put("/api/prefs", { data: {} })).status()).toBe(200);
  expect((await (await request.get("/api/prefs")).json()).prefs.emailOnComplete).toBeUndefined();
});

test("status reports demo mode", async ({ request }) => {
  const status = await (await request.get("/api/status")).json();
  expect(status.mode).toBe("demo");
  expect(status.authMode).toBe("open");
});

test("write with AI, pick a voice, generate, reach Completed", async ({ page }) => {
  await page.goto("/create?writer=1");
  await page.getByPlaceholder(/What is the video about/).fill("how to pay rent through the tenant portal");
  await page.getByRole("button", { name: "Write script" }).click();
  await expect(page.locator("textarea")).not.toHaveValue("");
  await page.getByRole("button", { name: "Voice" }).click();
  await page.getByLabel("Voice language").selectOption({ label: "British English" });
  await expect(page.getByText("James")).toHaveCount(0);
  await page.getByLabel("Voice language").selectOption("all");
  await page.getByText("James").click();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /9:16/ }).click();
  await page.getByRole("button", { name: "Generate video" }).click();
  await page.waitForURL(/\/videos\/vid_/);
  await expect(page.getByText("Completed")).toBeVisible({ timeout: 30_000 });
  // A completed demo must play, rather than only displaying a status badge.
  const player = page.locator("video");
  await player.evaluate(async (video: HTMLVideoElement) => { video.muted = true; await video.play(); });
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0);
  await expect(page.getByRole("link", { name: /Captions \(\.srt\)/ })).toBeVisible();
});

test("the library shows a render completing on its own", async ({ page }) => {
  const v = await createVideoViaApi(page, "Library watch");
  await page.goto("/videos");
  const card = page.getByRole("link", { name: /Library watch/ }).first();
  await expect(card.getByText("Processing")).toBeVisible();
  // Only the list is polled here (6s cadence); the detail route is never requested.
  const detailHits: string[] = [];
  page.on("request", (req) => { if (req.url().includes(`/api/videos/${v.id}`)) detailHits.push(req.url()); });
  await expect(card.getByText("Completed")).toBeVisible({ timeout: 30_000 });
  expect(detailHits).toEqual([]);
});

test("the library pages large batches and filters on the server", async ({ page }) => {
  const rows = Array.from({ length: 50 }, (_, i) => `Guest ${String(i + 1).padStart(2, "0")}`);
  const made = await page.request.post("/api/videos/batch", {
    data: { title: "Paging", scriptTemplate: "Hello {name}, welcome aboard.", csv: `name\n${rows.join("\n")}`, avatarId: "stock_1", voiceId: "stock_voice_1" },
  });
  expect(made.status()).toBe(201);
  const { batchId } = (await made.json()) as { batchId: string };

  const first = (await (await page.request.get(`/api/videos?batch=${batchId}&limit=2&sort=title`)).json()) as { videos: Array<{ title: string }>; matched: number; hasMore: boolean };
  expect(first.videos.map((v) => v.title)).toEqual(["Paging – Guest 01", "Paging – Guest 02"]);
  expect(first.matched).toBe(50);
  expect(first.hasMore).toBe(true);
  expect((await page.request.get(`/api/videos?batch=${batchId}&q=guest%2007`)).ok()).toBe(true);
  expect(((await (await page.request.get(`/api/videos?batch=${batchId}&q=guest%2007`)).json()).videos as unknown[]).length).toBe(1);
  expect((await page.request.get("/api/videos?limit=0")).status()).toBe(400);

  await page.goto(`/videos?batch=${batchId}`);
  const cards = page.locator("a[href^='/videos/vid_']");
  await expect(cards).toHaveCount(48);
  await expect(page.getByText("Showing 48 of 50")).toBeVisible();
  await page.getByTestId("load-more").click();
  await expect(cards).toHaveCount(50);
  await expect(page.getByTestId("load-more")).toHaveCount(0);
  // Typing a search narrows the page without a reload.
  await page.getByPlaceholder(/Search title/).fill("guest 4");
  await expect(cards).toHaveCount(10);
});

test("a video can be saved as a template and reopened from it", async ({ page }) => {
  const made = await page.request.post("/api/videos", {
    data: {
      title: "Template source",
      avatarId: "stock_1",
      voiceId: "stock_voice_1",
      aspect: "9:16",
      captions: true,
      scenes: [
        { script: "First scene text.", background: { type: "color", value: "#0f172a" } },
        { script: "Second scene text.", background: { type: "color", value: "#ffffff" }, voiceId: "stock_voice_3" },
      ],
    },
  });
  expect(made.status()).toBe(201);
  const { video } = (await made.json()) as { video: { id: string } };
  await page.goto(`/videos/${video.id}`);
  page.once("dialog", (d) => d.accept("Listing opener"));
  await page.getByRole("button", { name: "Save as template" }).click();
  await expect(page.getByRole("link", { name: /View templates/ })).toBeVisible();
  await page.getByRole("link", { name: /View templates/ }).click();
  await page.waitForURL(/\/templates/);
  const mine = page.getByTestId("my-templates");
  await expect(mine.getByText("Listing opener")).toBeVisible();
  await expect(mine.getByText("9:16 · 2 scenes")).toBeVisible();
  // A brand kit with different defaults must not win over the template, whichever request lands last.
  expect((await page.request.put("/api/brand", { data: { name: "Acme", primaryColor: "#0f766e", defaultVoiceId: "stock_voice_2", defaultResolution: "720p", captionsByDefault: false } })).ok()).toBe(true);
  try {
    await mine.getByRole("link", { name: "Use template" }).first().click();
    await page.waitForURL(/\/create\?template=tpl_/);
    await expect(page.locator("input[placeholder='Video title']")).toHaveValue("Listing opener");
    await expect(page.getByText(/2 scenes/)).toBeVisible();
    await expect(page.locator("textarea")).toHaveValue("First scene text.");
    await page.getByRole("button", { name: /^Scene 2,/ }).click();
    await expect(page.getByLabel("Scene voice")).toHaveValue("stock_voice_3");
    await expect(page.getByText(/Emma · 9:16 · 2 scenes · captions on/)).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("button", { name: /^1080p/ })).toHaveAttribute("aria-pressed", "true");
  } finally {
    await page.request.delete("/api/brand");
  }
  // Delete it again from the Templates page.
  await page.goto("/templates");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete template Listing opener" }).click();
  await expect(page.getByTestId("my-templates").getByText("Listing opener")).toHaveCount(0);
  expect(((await (await page.request.get("/api/templates")).json()).templates as unknown[]).length).toBe(0);
});

test("each scene shows its own running time", async ({ page }) => {
  await page.goto("/create");
  await page.locator("textarea").fill(Array.from({ length: 25 }, (_, i) => `word${i}`).join(" "));
  await expect(page.getByTestId("script-length")).toHaveText("25 words · ~10s");
  await page.getByRole("button", { name: "Add scene" }).click();
  // The new, empty scene carries the empty marker, not a duration.
  await expect(page.getByTestId("scene-duration")).toHaveCount(1);
  await page.locator("textarea").fill("one two three four five");
  await expect(page.getByTestId("scene-duration")).toHaveText(["~10s", "~2s"]);
  await expect(page.getByTestId("script-length")).toHaveText("5 words · ~2s this scene · ~12s total");
});

/** A mono 16-bit WAV of a quiet tone, for audio-scene uploads. */
function toneWav(seconds: number, rate = 8000): Buffer {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 3000), 44 + i * 2);
  return buf;
}

test("a scene can speak uploaded audio instead of a voice", async ({ page }) => {
  await page.goto("/create");
  await page.locator("input[placeholder='Video title']").fill("Recorded intro");
  await page.locator("textarea").fill("Typed opening line here.");
  await page.getByRole("button", { name: "Add scene" }).click();
  // The browser converts the upload to WAV and saves it as a reusable clip; the scene then speaks it.
  await page.getByLabel("Upload scene audio").setInputFiles({ name: "founder-take.wav", mimeType: "audio/wav", buffer: toneWav(3) });
  await expect(page.getByTestId("scene-audio-name")).toHaveText("founder-take");
  await expect(page.getByText("Scene 2: what the clip says")).toBeVisible();
  // An audio scene has no voice to pick and nothing to preview with one.
  await expect(page.getByLabel("Scene voice")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Listen" })).toHaveCount(0);
  await page.locator("textarea").fill("Hi, I recorded this myself.");
  // The audio scene lasts exactly as long as its clip; the typed one is an estimate.
  await expect(page.getByTestId("scene-duration")).toHaveText(["~2s", "3s"]);
  // Each scene has its own audio panel, one at a time.
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await expect(page.getByTestId("scene-audio")).toHaveCount(1);
  await expect(page.getByText("Or use your own audio")).toBeVisible();
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.getByTestId("scene-audio-name")).toHaveText("founder-take");
  await page.getByRole("button", { name: "Generate video" }).click();
  await page.waitForURL(/\/videos\/vid_/);
  const id = page.url().split("/").pop()!;
  const video = (await (await page.request.get(`/api/videos/${id}`)).json()).video;
  expect(video.scenes[1]).toMatchObject({ audioName: "founder-take", audioSeconds: 3, script: "Hi, I recorded this myself." });
  expect(video.scenes[1].voiceId).toBeUndefined();
  expect(video.scenes[0].audioId).toBeUndefined();
  await expect(page.getByText("recorded audio: founder-take")).toBeVisible();
  await expect(page.getByText(/plus recorded audio/)).toBeVisible();

  // The clip is listed for reuse and its audio is served to the owner.
  const clips = (await (await page.request.get("/api/clips")).json()).clips as Array<{ id: string; name: string; durationSec: number }>;
  const clip = clips.find((c) => c.id === video.scenes[1].audioId)!;
  expect(clip).toMatchObject({ name: "founder-take", durationSec: 3 });
  const audio = await page.request.get(`/api/clips/${clip.id}`);
  expect(audio.headers()["content-type"]).toBe("audio/wav");
  // A new scene can reuse the saved clip, and go back to a voice.
  await page.goto("/create");
  await page.getByLabel("Use a saved clip").selectOption(clip.id);
  await expect(page.getByTestId("scene-audio-name")).toHaveText("founder-take");
  await page.getByRole("button", { name: "Use a voice instead" }).click();
  await expect(page.getByText("Or use your own audio")).toBeVisible();
  // The API takes WAV or MP3 only, and reads a WAV's length itself.
  expect((await page.request.post("/api/clips", { data: { name: "Webm", audio: "data:audio/webm;base64,AAAA" } })).status()).toBe(400);
  expect((await page.request.delete(`/api/clips/${clip.id}`)).status()).toBe(204);
  expect((await page.request.get(`/api/clips/${clip.id}`)).status()).toBe(404);
});

test("scenes can be duplicated and reordered", async ({ page }) => {
  await page.goto("/create");
  await page.locator("textarea").fill("A.");
  await page.getByRole("button", { name: "Add scene" }).click();
  await page.locator("textarea").fill("B.");
  await page.getByRole("button", { name: "Duplicate scene" }).click();
  await expect(page.getByText("Scene 3 script")).toBeVisible();
  await expect(page.locator("textarea")).toHaveValue("B.");
  await page.locator("textarea").fill("C.");
  await page.getByRole("button", { name: "Move scene left" }).click();
  await expect(page.getByText("Scene 2 script")).toBeVisible();
  await expect(page.locator("textarea")).toHaveValue("C.");
  await page.getByRole("button", { name: "Move scene left" }).click();
  await expect(page.getByRole("button", { name: "Move scene left" })).toBeDisabled();
  await page.getByRole("button", { name: "Generate video" }).click();
  await page.waitForURL(/\/videos\/vid_/);
  const id = page.url().split("/").pop()!;
  const video = (await (await page.request.get(`/api/videos/${id}`)).json()).video as { scenes: Array<{ script: string }> };
  expect(video.scenes.map((sc) => sc.script)).toEqual(["C.", "A.", "B."]);
});

test("the avatar library filters by gender and name", async ({ page }) => {
  await page.goto("/avatars");
  await expect(page.getByRole("img", { name: "Ava Chen" })).toBeVisible();
  // Library presenters with a preview clip play it, muted, while hovered; others show nothing.
  await expect(page.getByTestId("avatar-preview-badge")).toHaveCount(2);
  await page.getByRole("img", { name: "Ava Chen" }).hover();
  await expect(page.getByTestId("avatar-preview")).toHaveAttribute("src", /\/demo\/render\.webm$/);
  await expect(page.getByTestId("avatar-preview")).toHaveJSProperty("muted", true);
  // The clip sits under the favourite star, so the star still takes the click while the clip plays.
  await page.getByRole("button", { name: "Add Ava Chen to favourites" }).click();
  await expect(page.getByRole("button", { name: "Remove Ava Chen from favourites" })).toBeVisible();
  await page.getByRole("button", { name: "Remove Ava Chen from favourites" }).click();
  await page.getByRole("img", { name: "Sofia Reyes" }).hover();
  await expect(page.getByTestId("avatar-preview")).toHaveCount(0);
  await page.getByLabel("Gender").selectOption("male");
  await expect(page.getByRole("img", { name: "Marcus Hill" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Ava Chen" })).toHaveCount(0);
  await page.getByPlaceholder(/Search by name or style/).fill("tech");
  await expect(page.getByRole("img", { name: "Lucas Meyer" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Marcus Hill" })).toHaveCount(0);
  await expect(page.getByText(/^1 of \d+$/)).toBeVisible();
  // A photo avatar can be renamed in place; a library presenter cannot be edited at all.
  const tag = Date.now().toString(36);
  const created = (await (await page.request.post("/api/avatars", { data: { name: `Rename me ${tag}`, imageUrl: "https://example.com/p.jpg" } })).json()).avatar as { id: string };
  await page.goto("/avatars");
  page.once("dialog", (d) => d.accept(`Renamed ${tag}`));
  await page.getByRole("button", { name: `Rename Rename me ${tag}` }).click();
  await expect(page.getByRole("img", { name: `Renamed ${tag}` })).toBeVisible();
  expect((await (await page.request.get(`/api/avatars/${created.id}`)).json()).avatar.name).toBe(`Renamed ${tag}`);
  expect((await page.request.patch("/api/avatars/stock_1", { data: { name: "Nope" } })).status()).toBe(404);
  expect((await page.request.patch(`/api/avatars/${created.id}`, { data: {} })).status()).toBe(400);
  // A default voice set on the avatar follows it into the editor when the avatar is picked.
  await page.getByLabel(`Default voice for Renamed ${tag}`).selectOption("stock_voice_2");
  await expect.poll(async () => (await (await page.request.get(`/api/avatars/${created.id}`)).json()).avatar.defaultVoiceId).toBe("stock_voice_2");
  expect((await page.request.patch(`/api/avatars/${created.id}`, { data: { defaultVoiceId: "nope" } })).status()).toBe(400);
  await page.goto("/create");
  // Other tests may leave a brand kit or newer avatars behind, so the editor's own first pick is not
  // asserted; wait until both lists have landed (the summary names a voice), then pick the avatar.
  const summary = page.getByText(/ · 16:9 · 1 scene · /);
  await expect(summary).toBeVisible();
  await expect(summary).not.toContainText("No voice");
  await page.getByRole("button", { name: "Avatar", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`^Renamed ${tag} Renamed ${tag}`) }).click();
  await expect(page.getByText(new RegExp(`Renamed ${tag} · James · `))).toBeVisible();
  await page.getByRole("button", { name: "Voice", exact: true }).click();
  await page.getByText("Emma").click();
  await expect(page.getByText(new RegExp(`Renamed ${tag} · Emma · `))).toBeVisible();
  // Picking the avatar again brings the voice back; a presenter without one leaves the voice alone.
  await page.getByRole("button", { name: "Avatar", exact: true }).click();
  await page.getByRole("button", { name: "Ava Chen Ava Chen" }).click();
  await expect(page.getByText(/Ava Chen · Emma · /)).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^Renamed ${tag} Renamed ${tag}`) }).click();
  await expect(page.getByText(new RegExp(`Renamed ${tag} · James · `))).toBeVisible();
  // A scene's own presenter brings its default voice along too, unless the scene already chose a voice.
  await page.getByRole("button", { name: "Add scene" }).click();
  await page.getByLabel("Scene avatar").selectOption({ label: "Ava Chen" });
  await expect(page.getByLabel("Scene voice")).toHaveValue("");
  await page.getByLabel("Scene avatar").selectOption({ label: `Renamed ${tag}` });
  await expect(page.getByLabel("Scene voice")).toHaveValue("stock_voice_2");
  await page.getByLabel("Scene voice").selectOption({ label: "Olivia" });
  await page.getByLabel("Scene avatar").selectOption({ label: "Ava Chen" });
  await page.getByLabel("Scene avatar").selectOption({ label: `Renamed ${tag}` });
  await expect(page.getByLabel("Scene voice")).toHaveValue("stock_voice_3");
  expect((await page.request.delete(`/api/avatars/${created.id}`)).status()).toBe(200);
});

test("the voice library filters by language and gender", async ({ page }) => {
  await page.goto("/voices");
  await expect(page.getByText("Emma", { exact: true })).toBeVisible();
  await page.getByLabel("Language").selectOption({ label: "British English" });
  await expect(page.getByText("Olivia", { exact: true })).toBeVisible();
  await expect(page.getByText("Emma", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/1 of \d+ voices/)).toBeVisible();
  await page.getByLabel("Language").selectOption("all");
  await page.getByLabel("Gender").selectOption("male");
  await expect(page.getByText("James", { exact: true })).toBeVisible();
  await expect(page.getByText("Olivia", { exact: true })).toHaveCount(0);
  await page.getByPlaceholder(/Search by name/).fill("Kenji");
  await expect(page.getByText("Kenji", { exact: true })).toBeVisible();
  await expect(page.getByText("James", { exact: true })).toHaveCount(0);
});

test("templates pre-fill the editor and edit-a-copy restores settings", async ({ page }) => {
  await page.goto("/templates");
  await page.getByRole("button", { name: "Real estate" }).click();
  await page.locator("a[href='/create?template=listing-walkthrough']").click();
  await page.waitForURL(/\/create\?template=/);
  await expect(page.locator("textarea")).toHaveValue(/Welcome to \{address\}/);
  await expect(page.locator("input[placeholder='Video title']")).toHaveValue("Property listing walkthrough");
  await expect(page.getByText("9:16 preview")).toBeVisible();
  await page.getByRole("button", { name: "Voice" }).click();
  await page.getByText("Olivia").click();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^720p/ }).click();
  await page.getByRole("button", { name: "Generate video" }).click();
  await page.waitForURL(/\/videos\/vid_/);
  await expect(page.getByText(/9:16 · 720p/)).toBeVisible();
  await page.locator("a:has-text('Edit a copy')").click();
  await page.waitForURL(/\/create\?from=/);
  await expect(page.locator("textarea")).toHaveValue(/Welcome to \{address\}/);
  await expect(page.getByText(/Olivia · 9:16/)).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("button", { name: /^720p/ })).toHaveAttribute("aria-pressed", "true");
});

test("multi-scene videos keep per-scene scripts and backgrounds", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill("Two scene demo");
  await page.locator("textarea").fill("Scene one says hello.");
  await page.getByRole("button", { name: "Add scene" }).click();
  await page.locator("textarea").fill("Scene two says goodbye.");
  await page.getByRole("button", { name: "Background" }).click();
  await page.getByLabel("Background #0f172a").click();
  // A looping video can sit behind the presenter; the stage previews it and the scene stores it.
  await page.getByLabel("Video URL").fill("https://example.com/loop.mp4");
  await expect(page.getByTestId("stage-video")).toHaveAttribute("src", "https://example.com/loop.mp4");
  await expect(page.getByText(/2 scenes/)).toBeVisible();
  // The second scene gets its own presenter and voice; the stage preview follows the choice.
  await page.getByLabel("Scene avatar").selectOption({ label: "Marcus Hill" });
  await page.getByLabel("Scene voice").selectOption({ label: "Olivia" });
  await expect(page.getByTestId("stage-avatar")).toHaveAttribute("alt", "Marcus Hill");
  // The presenter can be sized and moved per scene; the stage preview follows and the scene stores it.
  await page.getByTestId("scene-layout").locator("summary").click();
  await page.getByLabel("Presenter size").fill("1.2");
  await page.getByLabel("Presenter horizontal position").fill("0.5");
  await expect(page.getByTestId("stage-avatar")).toHaveCSS("transform", /matrix\(1\.2, 0, 0, 1\.2, 0, 0\)/);
  await expect(page.getByTestId("stage-presenter")).toHaveCSS("transform", /matrix\(1, 0, 0, 1, [1-9]\d*(\.\d+)?, 0\)/);
  await expect(page.getByTestId("scene-layout")).toContainText("120%, moved");
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await expect(page.getByTestId("scene-layout")).not.toContainText("120%");
  await expect(page.getByTestId("stage-avatar")).not.toHaveAttribute("alt", "Marcus Hill");
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  // The voice can be pitched up or down for the whole video.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Voice pitch").fill("10");
  await expect(page.getByText(/Voice pitch · \+10/)).toBeVisible();
  await page.getByRole("button", { name: "Generate video" }).click();
  await page.waitForURL(/\/videos\/vid_/);
  const id = page.url().split("/").pop()!;
  const video = (await (await page.request.get(`/api/videos/${id}`)).json()).video;
  expect(video.pitch).toBe(10);
  expect(video.scenes).toHaveLength(2);
  expect(video.script).toBe("Scene one says hello.\n\nScene two says goodbye.");
  expect(video.scenes[0].avatarName).toBeUndefined();
  expect(video.scenes[1]).toMatchObject({ avatarId: "stock_2", avatarName: "Marcus Hill", voiceId: "stock_voice_3", voiceName: "Olivia", layout: { scale: 1.2, x: 0.5, y: 0 }, background: { type: "video", value: "https://example.com/loop.mp4" } });
  expect((await page.request.post("/api/videos", { data: { title: "Bad", script: "Hi.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "16:9", background: { type: "video", value: "loop.mp4" } } })).status()).toBe(400);
  expect(video.scenes[0].layout).toBeUndefined();
  await expect(page.getByText("Script · 2 scenes")).toBeVisible();
  await expect(page.getByText("Marcus Hill · Olivia")).toBeVisible();
  // Edit a copy keeps the scene's presenter.
  await page.goto(`/create?from=${id}`);
  await expect(page.getByText(/2 scenes/)).toBeVisible();
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.getByLabel("Scene voice")).toHaveValue("stock_voice_3");
  // A scene whose presenter was deleted since falls back to the video's and still renders.
  const custom = await page.request.post("/api/avatars", { data: { name: "Gone soon", imageUrl: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E" } });
  expect(custom.status()).toBe(201);
  const customId = ((await custom.json()) as { avatar: { id: string } }).avatar.id;
  const withCustom = await page.request.post("/api/videos", {
    data: { title: "Custom scene", avatarId: "stock_1", voiceId: "stock_voice_1", scenes: [{ script: "One.", background: { type: "color", value: "#fff" } }, { script: "Two.", background: { type: "color", value: "#fff" }, avatarId: customId }] },
  });
  expect(withCustom.status()).toBe(201);
  const withCustomId = ((await withCustom.json()) as { video: { id: string } }).video.id;
  expect((await page.request.delete(`/api/avatars/${customId}`)).ok()).toBe(true);
  await page.goto(`/create?from=${withCustomId}`);
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.getByLabel("Scene avatar")).toHaveValue("");
  await page.getByRole("button", { name: "Generate video" }).click();
  await page.waitForURL(/\/videos\/vid_/);
});

test("captions, share page, rename, and library filters", async ({ page }) => {
  const a = await createVideoViaApi(page, "Alpha walkthrough");
  await createVideoViaApi(page, "Beta update");

  const srt = await page.request.get(`/api/videos/${a.id}/captions`);
  expect(srt.status()).toBe(200);
  expect(srt.headers()["content-disposition"]).toContain("Alpha_walkthrough.srt");
  expect((await srt.text()).match(/-->/g)?.length).toBe(3);

  await page.goto(`/share/${a.id}`);
  await expect(page.getByText(/still rendering/)).toBeVisible();

  await page.goto("/videos");
  await page.getByPlaceholder(/Search title/).fill("beta");
  await expect(page.locator("a[href^='/videos/vid_']")).toHaveCount(1);

  await page.goto(`/videos/${a.id}`);
  await page.locator("button[title='Rename']").click();
  await page.getByLabel("Video title").fill("Renamed video");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Renamed video")).toBeVisible();
  expect((await (await page.request.get(`/api/videos/${a.id}`)).json()).video.title).toBe("Renamed video");
});

test("library sorts by date, title, and views", async ({ page }) => {
  const older = await createVideoViaApi(page, "Zulu sortcheck");
  await createVideoViaApi(page, "Alpha sortcheck");
  await page.goto("/videos");
  await page.getByPlaceholder(/Search title/).fill("sortcheck");
  const titles = page.locator("a[href^='/videos/vid_'] .truncate");
  await expect(titles).toHaveCount(2);
  await expect(titles.first()).toHaveText("Alpha sortcheck"); // newest first by default
  await page.getByLabel("Sort videos").selectOption("oldest");
  await expect(titles.first()).toHaveText("Zulu sortcheck");
  await page.getByLabel("Sort videos").selectOption("title");
  await expect(titles.first()).toHaveText("Alpha sortcheck");
  // Views only accrue on completed renders; the share beacon counts one for the older video.
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${older.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  expect((await page.request.post(`/api/videos/${older.id}/view`)).status()).toBe(200);
  // Polling stops once every render has finished, so a fresh load picks up the view count.
  await page.reload();
  await page.getByPlaceholder(/Search title/).fill("sortcheck");
  await page.getByLabel("Sort videos").selectOption("views");
  await expect(titles.first()).toHaveText("Zulu sortcheck");
});

test("share page offers a download only when the owner allows it", async ({ page }) => {
  const v = await createVideoViaApi(page, `Downloadable ${Date.now().toString(36)}`);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  await page.goto(`/share/${v.id}`);
  await expect(page.getByRole("link", { name: "Download video" })).toHaveCount(0);

  await page.goto(`/videos/${v.id}`);
  await page.getByLabel("Viewers can download").check();
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.shareDownload).toBe(true);
  await page.goto(`/share/${v.id}`);
  await expect(page.getByRole("link", { name: "Download video" })).toBeVisible();

  // Team comments live on the video page only; the author can remove their own.
  await page.goto(`/videos/${v.id}`);
  await page.getByLabel("New comment").fill("Tighten the intro.");
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByTestId("comment-list")).toContainText("Tighten the intro.");
  await expect(page.getByTestId("comments")).toContainText("Comments · 1");
  expect(await (await page.request.get(`/share/${v.id}`)).text()).not.toContain("Tighten the intro.");
  expect((await page.request.post("/api/videos/vid_nope/comments", { data: { text: "x" } })).status()).toBe(404);
  expect((await page.request.post(`/api/videos/${v.id}/comments`, { data: { text: "" } })).status()).toBe(400);
  await page.getByRole("button", { name: "Delete comment" }).click();
  await expect(page.getByTestId("comment-list")).toHaveCount(0);
  // A note pinned to the player's moment shows its time, which seeks the player back there.
  const player = page.getByTestId("video-player");
  const comments = page.getByTestId("comments");
  // The demo sample runs past the script's estimated length (about 5 s here), and the pin must still be accepted.
  await expect(comments.getByText("Pin to 0:00 in the video")).toBeVisible();
  await player.evaluate((el: HTMLVideoElement) => (el.currentTime = 8));
  await expect(comments.getByText("Pin to 0:08 in the video")).toBeVisible();
  await comments.getByLabel("Pin to 0:08 in the video").check();
  // Playing on while typing keeps the moment the box was ticked at.
  await player.evaluate((el: HTMLVideoElement) => (el.currentTime = 10));
  await expect(comments.getByLabel("Pin to 0:08 in the video")).toBeChecked();
  await page.getByLabel("New comment").fill("Cut the pause here.");
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByTestId("comment-list")).toContainText("0:08Cut the pause here.");
  await expect(comments.getByRole("checkbox")).not.toBeChecked();
  await expect(comments.getByText("Pin to 0:10 in the video")).toBeVisible();
  const listed = (await (await page.request.get(`/api/videos/${v.id}/comments`)).json()).comments;
  expect(listed.map((c: { atSec?: number }) => c.atSec)).toEqual([8]);
  await player.evaluate((el: HTMLVideoElement) => (el.currentTime = 0));
  await comments.getByRole("button", { name: "Go to 0:08 in the video" }).click();
  await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.currentTime)).toBe(8);
  await expect(player).toBeFocused();
  // A mention email's ?t= opens the player at the note.
  await page.goto(`/videos/${v.id}?t=3`);
  await expect.poll(() => page.getByTestId("video-player").evaluate((el: HTMLVideoElement) => el.currentTime)).toBe(3);
  await page.getByRole("button", { name: "Delete comment" }).click();
  await expect(page.getByTestId("comment-list")).toHaveCount(0);
  // Translated subtitle tracks: added from the video page, served by language, offered on the share page.
  await page.goto(`/videos/${v.id}`);
  await page.getByLabel("Subtitle language").fill("Spanish");
  await page.getByRole("button", { name: "Add subtitles" }).click();
  await expect(page.getByTestId("subtitle-list")).toContainText("Spanish");
  const esVtt = await page.request.get(`/api/videos/${v.id}/captions?format=vtt&lang=spanish`);
  expect(esVtt.status()).toBe(200);
  expect(await esVtt.text()).toContain("[Spanish]");
  expect(esVtt.headers()["content-disposition"]).toContain(".spanish.vtt");
  expect((await page.request.get(`/api/videos/${v.id}/captions?lang=French`)).status()).toBe(404);
  await page.goto(`/share/${v.id}`);
  await expect(page.getByTestId("share-player").locator("track[srclang='es']")).toHaveAttribute("label", "Spanish");
  await page.goto(`/videos/${v.id}`);
  await page.getByRole("button", { name: "Remove Spanish subtitles" }).click();
  await expect(page.getByTestId("subtitle-list")).toHaveCount(0);
  expect((await page.request.get(`/api/videos/${v.id}/captions?lang=Spanish`)).status()).toBe(404);
  // A description saved from the video page shows under the share-page player and in the link preview.
  await page.goto(`/videos/${v.id}`);
  await expect(page.getByRole("button", { name: "Save description" })).toBeDisabled();
  await page.getByLabel("Share page description").fill("Three things to know before the tour.");
  await page.getByRole("button", { name: "Save description" }).click();
  await expect(page.getByRole("button", { name: "Save description" })).toBeDisabled();
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.description).toBe("Three things to know before the tour.");
  const shareHtml = await (await page.request.get(`/share/${v.id}`)).text();
  expect(shareHtml).toContain('property="og:description" content="Three things to know before the tour."');
  await page.goto(`/share/${v.id}`);
  await expect(page.getByTestId("share-description")).toHaveText("Three things to know before the tour.");
  // A call-to-action button set from the video page shows under the share-page player.
  await page.goto(`/videos/${v.id}`);
  await page.getByLabel("Button label").fill("Book a showing");
  // A link without a scheme is refused with the field's own message, not a generic one.
  await page.getByLabel("Button link").fill("example.com/book");
  await page.getByRole("button", { name: "Save button" }).click();
  await expect(page.getByTestId("share-cta-card")).toContainText("The link must start with http:// or https://");
  await page.getByLabel("Button link").fill("https://example.com/book");
  await page.getByLabel("Button link").press("Enter");
  await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
  await page.goto(`/share/${v.id}`);
  const cta = page.getByTestId("share-cta");
  await expect(cta).toHaveText(/^Book a showing/);
  await expect(cta).toHaveAttribute("href", "https://example.com/book");
  // Clicking opens the link in a new tab and counts one click per viewer; a second click is not counted.
  await page.context().route("https://example.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<p>ok</p>" }));
  for (let i = 0; i < 2; i++) {
    const [popup] = await Promise.all([page.waitForEvent("popup"), cta.click()]);
    await popup.close();
  }
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.ctaClicks).toBe(1);
  // The player reports how far viewers get; each quarter counts once per viewer.
  await expect(page.getByTestId("share-player")).toBeAttached();
  const watch = async (quarter: number, headers?: Record<string, string>) =>
    (await (await page.request.post(`/api/videos/${v.id}/watch`, { data: { quarter }, headers })).json()) as { counted: boolean; watch: { q25: number; q100: number } };
  expect((await watch(25)).counted).toBe(true);
  expect((await watch(25)).counted).toBe(false);
  expect((await watch(100, { "sec-fetch-site": "cross-site" })).counted).toBe(false);
  expect((await page.request.post(`/api/videos/${v.id}/watch`, { data: { quarter: 30 } })).status()).toBe(400);
  // Reaching the end counts every marker this viewer has not been counted for yet.
  expect((await watch(100)).watch).toEqual({ q25: 1, q50: 1, q75: 1, q100: 1 });
  // Embeds may ask the page to start muted and repeat; the plain link does neither. Visited after the
  // beacon checks so an autoplaying player could never use up this viewer's quarter slots first.
  await page.goto(`/share/${v.id}`);
  await expect(page.getByTestId("share-player")).not.toHaveAttribute("autoplay", "");
  await page.goto(`/share/${v.id}?autoplay=1&loop=1`);
  await expect(page.getByTestId("share-player")).toHaveAttribute("autoplay", "");
  await expect(page.getByTestId("share-player")).toHaveAttribute("loop", "");
  await expect(page.getByTestId("share-player")).toHaveJSProperty("muted", true);
  await page.goto(`/videos/${v.id}`);
  await expect(page.getByTestId("cta-clicks")).toHaveText("1");
  // Views land on today's bar of the per-day sparkline.
  const views = (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.views as number;
  expect(views).toBeGreaterThan(0);
  await expect(page.getByTestId("views-by-day")).toHaveAttribute("data-total", String(views));
  await expect(page.getByTestId("views-by-day")).toContainText(`${views} in 14 days`);
  await expect(page.getByTestId("watch-through")).toContainText("25% 1");
  await expect(page.getByTestId("watch-through")).toContainText("100% 1");
  // The row stays readable rather than ellipsised at laptop widths.
  const cell = page.getByTestId("watch-through");
  expect(
    await cell.evaluate((el) => {
      const dd = el.closest("dd")!;
      return dd.scrollWidth <= dd.clientWidth + 1 && getComputedStyle(dd).textOverflow !== "ellipsis";
    }),
  ).toBe(true);
  // Home insights total the clicks and finishes across the library next to share views.
  await page.goto("/home");
  await expect(page.getByTestId("cta-click-summary")).toContainText(/button clicks?/);
  await expect(page.getByTestId("finish-rate-summary")).toContainText(/\d+% watched to the end/);
  await expect(page.getByTestId("finish-rate").first()).toContainText(/\d+%/);
  // The same numbers download as a spreadsheet.
  await expect(page.getByTestId("analytics-csv")).toBeVisible();
  const analytics = await page.request.get("/api/videos/analytics");
  expect(analytics.headers()["content-type"]).toContain("text/csv");
  const sheet = parseCsv(await analytics.text());
  expect(sheet.columns).toEqual(["id", "title", "status", "created", "folder", "duration_sec", "views", "views_7d", "last_viewed", "watched_25", "watched_50", "watched_75", "watched_100", "finish_rate", "cta_clicks", "share_link"]);
  const row = sheet.rows.find((r) => r.id === v.id)!;
  expect([row.watched_25, row.watched_50, row.watched_75, row.watched_100, row.cta_clicks]).toEqual(["1", "1", "1", "1", "1"]);
  expect(Number(row.views)).toBeGreaterThan(0);
  expect(row.views_7d).toBe(row.views);
  expect(Number(row.finish_rate)).toBeGreaterThan(0);
  expect(row.share_link).toContain(`/share/${v.id}`);
  await page.goto(`/share/${v.id}`);
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareCta: { label: "Go", url: "javascript:alert(1)" } } })).status()).toBe(400);
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareCta: null } })).status()).toBe(200);
  await page.goto(`/share/${v.id}`);
  await expect(page.getByTestId("share-cta")).toHaveCount(0);

  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareDownload: false } })).status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("link", { name: "Download video" })).toHaveCount(0);
});

test("the owner can take a share link offline and back", async ({ page }) => {
  const v = await createVideoViaApi(page, `Offline ${Date.now().toString(36)}`);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  const html = await (await page.request.get(`/share/${v.id}`)).text();
  // Link previews: the title, a script excerpt, the thumbnail, and the rendered video.
  const meta = (prop: string) => new RegExp(`<meta property="${prop}" content="([^"]*)"`).exec(html)?.[1];
  expect(meta("og:title")).toContain("Offline ");
  expect(meta("og:description")).toContain("Hello there.");
  expect(meta("og:image")).toMatch(/^https?:\/\//);
  expect(meta("og:video")).toMatch(/^https?:\/\//);
  expect(meta("og:type")).toBe("video.other");
  // A beacon sent from another site does not count and does not use up the viewer's slot.
  const beacon = async (headers?: Record<string, string>) => ((await (await page.request.post(`/api/videos/${v.id}/view`, { headers })).json()) as { counted: boolean }).counted;
  expect(await beacon({ "sec-fetch-site": "cross-site" })).toBe(false);
  expect(await beacon({ "sec-fetch-site": "same-origin" })).toBe(true);
  expect(await beacon()).toBe(false);
  await page.goto(`/videos/${v.id}`);
  await page.getByLabel("Share link is live").uncheck();
  await expect(page.getByTestId("share-off-note")).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.shareDisabled).toBe(true);
  const gone = await page.request.get(`/share/${v.id}`);
  expect(gone.status()).toBe(404);
  expect(await gone.text()).not.toContain('property="og:video"');
  expect((await page.request.post(`/api/videos/${v.id}/view`)).status()).toBe(404);
  // The owner's own captions download keeps working (open mode: every request is the owner's).
  expect((await page.request.get(`/api/videos/${v.id}/captions`)).status()).toBe(200);
  await page.reload();
  await expect(page.getByLabel("Share link is live")).not.toBeChecked();
  // The library card says so.
  await page.goto("/videos");
  await expect(page.locator(`a[href="/videos/${v.id}"]`).getByTestId("share-badges")).toContainText("Link off");
  await page.goto(`/videos/${v.id}`);
  await page.getByLabel("Share link is live").check();
  await expect(page.getByTestId("share-off-note")).toHaveCount(0);
  // An expiry set from the page is stored as an instant and shown back; a past one is refused.
  const pad = (n: number) => String(n).padStart(2, "0");
  const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const past = new Date(Date.now() - 60 * 60 * 1000);
  const expiry = page.getByTestId("share-expiry");
  await page.getByLabel("Share link expiry").fill(local(past));
  await expiry.getByRole("button", { name: "Set expiry" }).click();
  await expect(page.getByText("The expiry must be in the future")).toBeVisible();
  const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  future.setHours(12, 0, 0, 0); // noon: never inside a daylight-saving transition
  await page.getByLabel("Share link expiry").fill(local(future));
  await expiry.getByRole("button", { name: "Set expiry" }).click();
  await expect(page.getByTestId("share-expiry-badge")).toContainText("Expires");
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.shareExpiresAt).toBe(future.toISOString());
  expect((await page.request.get(`/share/${v.id}`)).status()).toBe(200);
  await expiry.getByRole("button", { name: "Clear expiry" }).click();
  await expect(page.getByTestId("share-expiry-badge")).toHaveCount(0);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.shareExpiresAt).toBeUndefined();
  await expect.poll(async () => (await (await page.request.get(`/share/${v.id}`)).status())).toBe(200);
});

test("a share link can require a password", async ({ page }) => {
  const v = await createVideoViaApi(page, `Locked ${Date.now().toString(36)}`);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  await page.goto(`/videos/${v.id}`);
  await page.getByLabel("Share password").fill("abc");
  await page.getByRole("button", { name: "Protect" }).click();
  await expect(page.getByTestId("share-password")).toContainText("at least 4 characters");
  await page.getByLabel("Share password").fill("open sesame");
  await page.getByRole("button", { name: "Protect" }).click();
  await expect(page.getByTestId("share-locked")).toBeVisible();
  const record = (await (await page.request.get(`/api/videos/${v.id}`)).json()).video as Record<string, unknown>;
  expect(record.shareLocked).toBe(true);
  expect(JSON.stringify(record)).not.toContain("sesame");
  await page.goto("/videos");
  await expect(page.locator(`a[href="/videos/${v.id}"]`).getByTestId("share-badges")).toContainText("Password");

  // Visitors see the password form and no player; the preview carries no excerpt or thumbnail.
  const html = await (await page.request.get(`/share/${v.id}`)).text();
  expect(html).toContain("password protected");
  expect(html).not.toContain('property="og:image"');
  await page.goto(`/share/${v.id}`);
  await expect(page.getByTestId("share-unlock")).toBeVisible();
  await expect(page.locator("video")).toHaveCount(0);
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Watch video" }).click();
  await expect(page.getByTestId("share-unlock").getByRole("alert")).toHaveText("Incorrect password");
  await page.getByLabel("Password").fill("open sesame");
  await page.getByRole("button", { name: "Watch video" }).click();
  await expect(page.locator("video")).toBeVisible();
  await expect(page.getByTestId("share-unlock")).toHaveCount(0);
  // The unlocked visit is counted (the beacon carries the cookie).
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.views).toBe(1);

  await page.goto(`/videos/${v.id}`);
  await page.getByRole("button", { name: "Remove password" }).click();
  await expect(page.getByTestId("share-locked")).toHaveCount(0);
  await page.goto(`/share/${v.id}`);
  await expect(page.locator("video")).toBeVisible();
});

test("starred avatars and voices come first everywhere and persist", async ({ page }) => {
  await page.goto("/avatars");
  await expect(page.getByRole("img", { name: "Ava Chen" })).toBeVisible();
  const firstTile = () => page.getByTestId("avatar-library").locator("> div").first();
  await expect(firstTile()).not.toContainText("Marcus Hill");
  await page.getByRole("button", { name: "Add Marcus Hill to favourites" }).click();
  await expect(page.getByRole("button", { name: "Remove Marcus Hill from favourites" })).toHaveAttribute("aria-pressed", "true");
  await expect(firstTile()).toContainText("Marcus Hill");
  await page.reload();
  await expect(firstTile()).toContainText("Marcus Hill");
  expect(((await (await page.request.get("/api/prefs")).json()).prefs as { favoriteAvatarIds?: string[] }).favoriteAvatarIds).toEqual(["stock_2"]);

  await page.goto("/voices");
  await expect(page.getByText("Olivia", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add Olivia to favourites", exact: true }).click();
  await page.reload();
  await expect(page.getByTestId("voice-list").locator("> div").first()).toContainText("Olivia");

  // The editor's pickers follow the same order.
  await page.goto("/create");
  await expect(page.locator("[data-testid=stage-avatar]")).toBeVisible();
  await expect(page.getByTestId("avatar-grid").locator("> div").first()).toContainText("Marcus Hill");
  await page.getByRole("button", { name: /^Voice$/ }).click();
  await expect(page.getByRole("button", { name: "Remove Olivia from favourites", exact: true })).toBeVisible();

  // Unstar from the editor; the library follows.
  await page.getByRole("button", { name: "Remove Olivia from favourites", exact: true }).click();
  await page.getByRole("button", { name: /^Avatar$/ }).click();
  await page.getByRole("button", { name: "Remove Marcus Hill from favourites" }).click();
  await expect.poll(async () => (await (await page.request.get("/api/prefs")).json()).prefs?.favoriteAvatarIds).toBeUndefined();
  await page.goto("/avatars");
  await expect(firstTile()).not.toContainText("Marcus Hill");
});

test("a finished video can be sent by email or posted to a network from its page", async ({ page, baseURL }) => {
  const title = `Mail & more ${Date.now().toString(36)}`;
  const v = await createVideoViaApi(page, title);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  // The API validates recipients and refuses an offline link.
  const bad = await page.request.post(`/api/videos/${v.id}/share`, { data: { to: ["nope"] } });
  expect(bad.status()).toBe(400);
  expect(((await bad.json()) as { issues: { message: string }[] }).issues[0].message).toContain("email address");
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareDisabled: true } })).status()).toBe(200);
  expect((await page.request.post(`/api/videos/${v.id}/share`, { data: { to: ["jane@example.com"] } })).status()).toBe(409);
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareDisabled: false } })).status()).toBe(200);
  await page.goto(`/videos/${v.id}`);
  const card = page.getByTestId("share-email-card");
  await expect(card.getByRole("button", { name: "Send link" })).toBeDisabled();
  await card.getByLabel("Recipients").fill("jane@example.com, sam@example.com\njane@example.com");
  await card.getByLabel("Message").fill("Here is the walkthrough.");
  await card.getByRole("button", { name: "Send link" }).click();
  await expect(page.getByTestId("share-email-status")).toContainText("Sent to 2 recipients");
  await expect(page.getByTestId("share-email-status")).toContainText("demo");
  await expect(card.getByLabel("Recipients")).toHaveValue("");
  // Each network opens in a new tab with the share page filled in (and the title where it takes one).
  const social = page.getByTestId("share-social-card").getByRole("group", { name: "Post the link to" });
  const sharePage = encodeURIComponent(`${new URL(baseURL!).origin}/share/${v.id}`);
  const t = encodeURIComponent(title);
  const expected = [
    ["LinkedIn", `https://www.linkedin.com/sharing/share-offsite/?url=${sharePage}`],
    ["X", `https://x.com/intent/post?url=${sharePage}&text=${t}`],
    ["Facebook", `https://www.facebook.com/sharer/sharer.php?u=${sharePage}`],
    ["WhatsApp", `https://wa.me/?text=${t}%20${sharePage}`],
  ];
  await expect(social.getByRole("link")).toHaveCount(5);
  for (const [name, href] of expected) {
    const link = social.getByRole("link", { name: `${name} (opens in a new tab)`, exact: true });
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  // The mail app takes a mailto link itself; a new tab for it would be left empty.
  const mail = social.getByRole("link", { name: "Email app", exact: true });
  await expect(mail).toHaveAttribute("href", `mailto:?subject=${t}&body=${sharePage}`);
  await expect(mail).not.toHaveAttribute("target", /.*/);
  // The link going off disables the form rather than sending a dead link, and takes the network links away.
  await page.getByLabel("Share link is live").uncheck();
  await expect(card.getByText("Turn the share link on first.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Send link" })).toBeDisabled();
  await expect(page.getByTestId("share-social-card").getByText("Turn the share link on first.")).toBeVisible();
  await expect(page.getByTestId("share-social-card").getByRole("link")).toHaveCount(0);
});

test("a custom cover image replaces the poster everywhere", async ({ page }) => {
  const v = await createVideoViaApi(page, `Cover ${Date.now().toString(36)}`);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  expect((await page.request.get(`/api/videos/${v.id}/cover`)).status()).toBe(404);
  await page.goto(`/videos/${v.id}`);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  await page.getByLabel("Cover image").setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: png });
  await expect(page.getByRole("button", { name: "Remove cover" })).toBeVisible();
  const record = (await (await page.request.get(`/api/videos/${v.id}`)).json()).video as { cover?: { updatedAt: string } };
  expect(record.cover?.updatedAt).toBeTruthy();
  const served = await page.request.get(`/api/videos/${v.id}/cover?v=${Date.parse(record.cover!.updatedAt)}`);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toBe("image/jpeg");
  expect(served.headers()["cache-control"]).toContain("public");
  expect(served.headers()["cache-control"]).toContain("immutable");
  // The share page's poster and link preview use it.
  const html = await (await page.request.get(`/share/${v.id}`)).text();
  expect(html).toContain(`/api/videos/${v.id}/cover?v=`);
  expect(/<meta property="og:image" content="[^"]*\/cover\?v=/.test(html)).toBe(true);
  await page.goto("/videos");
  await expect(page.locator(`a[href="/videos/${v.id}"] img`)).toHaveAttribute("src", /\/cover\?v=/);
  // Offline links hide it from the public; the owner still sees it.
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareDisabled: true } })).status()).toBe(200);
  expect((await page.request.get(`/api/videos/${v.id}/cover`)).status()).toBe(200);
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareDisabled: false } })).status()).toBe(200);
  await page.goto(`/videos/${v.id}`);
  await page.getByRole("button", { name: "Remove cover" }).click();
  await expect(page.getByRole("button", { name: "Remove cover" })).toHaveCount(0);
  await expect.poll(async () => (await page.request.get(`/api/videos/${v.id}/cover`)).status()).toBe(404);
  // A paused frame of the video itself can be the cover, at the video's own size (capped at 1280px wide).
  const player = page.getByTestId("video-player");
  await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(1);
  await player.evaluate((el: HTMLVideoElement) => (el.currentTime = 3));
  await page.getByRole("button", { name: "Use current frame" }).click();
  await expect(page.getByRole("button", { name: "Remove cover" })).toBeVisible();
  const frame = (await (await page.request.get(`/api/videos/${v.id}`)).json()).video as { cover?: { updatedAt: string; mimeType: string } };
  expect(frame.cover?.mimeType).toBe("image/jpeg");
  const [videoWidth, coverWidth] = await page.evaluate(async (src) => {
    const el = document.querySelector<HTMLVideoElement>('[data-testid="video-player"]')!;
    const img = new Image();
    img.src = src;
    await img.decode();
    return [Math.min(1280, el.videoWidth), img.naturalWidth];
  }, `/api/videos/${v.id}/cover?v=${Date.parse(frame.cover!.updatedAt)}`);
  expect(coverWidth).toBe(videoWidth);
  expect(coverWidth).toBeGreaterThan(1);
  // The frame is the one the player is on: the start and a later moment give different covers.
  const coverBytes = async () => {
    const meta = (await (await page.request.get(`/api/videos/${v.id}`)).json()).video as { cover: { updatedAt: string } };
    return Buffer.from(await (await page.request.get(`/api/videos/${v.id}/cover?v=${Date.parse(meta.cover.updatedAt)}`)).body()).toString("base64");
  };
  const atThree = await coverBytes();
  await player.evaluate((el: HTMLVideoElement) => (el.currentTime = 0));
  await page.getByRole("button", { name: "Use current frame" }).click();
  await expect.poll(coverBytes).not.toBe(atThree);
  const atZero = await coverBytes();
  await player.evaluate((el: HTMLVideoElement) => (el.currentTime = 3));
  await page.getByRole("button", { name: "Use current frame" }).click();
  await expect.poll(coverBytes).not.toBe(atZero);
  expect(await coverBytes()).toBe(atThree);
});

test("draft autosave survives a reload and clears after generating", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill("Draft title");
  await page.locator("textarea").fill("Draft script survives reload.");
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.getByText("Restored your unsent draft")).toBeVisible();
  await expect(page.locator("textarea")).toHaveValue("Draft script survives reload.");
  await page.getByRole("button", { name: "Generate video" }).click();
  await page.waitForURL(/\/videos\/vid_/);
  expect(await page.evaluate(() => localStorage.getItem("avatar-studio:draft"))).toBeNull();
});

test("Improve menu revises the active scene", async ({ page }) => {
  await page.locator("textarea").fill("Hi there! One. Two. Three. Four.");
  await page.getByRole("button", { name: "Improve" }).click();
  await page.getByRole("button", { name: "Shorten", exact: true }).click();
  await expect(page.locator("textarea")).toHaveValue("Hi there! One. Two.");
});

test("mobile drawer opens, navigates, and closes", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: "http://localhost:3100" });
  const page = await ctx.newPage();
  await page.goto("/home");
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "Templates" }).click();
  await page.waitForURL(/\/templates/);
  await expect(page.locator("aside")).not.toBeInViewport();
  await ctx.close();
});

test("no page scrolls sideways at phone width", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  let agentId: string | undefined;
  try {
    const v = await createVideoViaApi(page, "Phone width check");
    // A shared presenter makes the Interactive page render its widest row (six actions per presenter).
    agentId = ((await (await page.request.post("/api/agents", { data: { name: "Phone width presenter", avatarId: "stock_1" } })).json()).agent as { id: string }).id;
    const pages = ["/home", "/create", "/videos", `/videos/${v.id}`, "/templates", "/avatars", "/voices", "/batch", "/brand", "/interactive", "/workspace", "/settings", "/translate", `/share/${v.id}`];
    for (const path of pages) {
      await page.goto(path);
      await expect(page.locator("h1").first()).toBeVisible();
      if (path === "/create") await page.getByRole("button", { name: "Settings" }).click();
      // Studio pages scroll inside <main>; public pages scroll the document. Neither may be wider than the viewport.
      const over = await page.evaluate(() =>
        [document.documentElement, ...document.querySelectorAll("main")].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => `${el.tagName} ${el.scrollWidth}>${el.clientWidth}`),
      );
      expect(over, `${path} overflows: ${over.join(", ")}`).toEqual([]);
    }
  } finally {
    if (agentId) await page.request.delete(`/api/agents/${agentId}`);
    await ctx.close();
  }
});

test("script writer refuses private page URLs", async ({ request }) => {
  const res = await request.post("/api/script", { data: { url: "http://127.0.0.1:3100/home" } });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toMatch(/public host/);
  expect((await request.post("/api/script", { data: { topic: "" } })).status()).toBe(400);
});

test("API validation and webhook guard", async ({ request }) => {
  expect((await request.post("/api/videos", { data: { title: "", script: "" } })).status()).toBe(400);
  const badVoice = await request.post("/api/videos", { data: { title: "t", script: "hi", avatarId: "stock_1", voiceId: "zzz" } });
  expect(badVoice.status()).toBe(400);
  const base = { title: "q", script: "hi", avatarId: "stock_1", voiceId: "stock_voice_1" };
  expect((await request.post("/api/videos", { data: { ...base, resolution: "4k" } })).status()).toBe(400);
  const hd = await request.post("/api/videos", { data: { ...base, resolution: "720p" } });
  expect(hd.status()).toBe(201);
  expect((await hd.json()).video.resolution).toBe("720p");
  const full = await request.post("/api/videos", { data: base });
  expect((await full.json()).video.resolution).toBe("1080p");
  // Retry is only for failed renders; a healthy one is refused and an unknown id is not found.
  expect((await request.post(`/api/videos/${(await full.json()).video.id}/retry`)).status()).toBe(409);
  expect((await request.post("/api/videos/vid_nope/retry")).status()).toBe(404);
  expect((await request.post("/api/webhooks/heygen", { data: {} })).status()).toBe(503);
  const preview = await request.post("/api/voices/preview", { data: { voiceId: "stock_voice_1", text: "hi" } });
  expect(preview.status()).toBe(204);
});

test("personalized batch creates one video per CSV row", async ({ page }) => {
  await page.goto("/batch");
  await expect(page.getByText(/2 rows · columns: name, property, move_in/)).toBeVisible();
  await expect(page.getByText("Hi Jordan, welcome to 12 Elm Street!")).toBeVisible();
  await page.locator("textarea").first().fill("Hi {name}, see you at {property} on {move_in}. Also {oops}.");
  await expect(page.getByText(/placeholders the CSV does not have: \{oops\}/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Generate/ })).toBeDisabled();
  await page.locator("textarea").first().fill("Hi {name}, see you at {property} on {move_in}.");
  await expect(page.getByRole("button", { name: "Generate 2 videos" })).toBeEnabled();
  await page.getByLabel("Output quality").selectOption("720p");
  await page.screenshot({ path: "test-results/batch-page.png" });
  await page.getByRole("button", { name: "Generate 2 videos" }).click();
  await page.waitForURL(/\/videos\?batch=batch_/);
  await expect(page.getByText("Showing one personalized batch")).toBeVisible();
  await expect(page.locator("a[href^='/videos/vid_']")).toHaveCount(2);
  await expect(page.getByText("Welcome video – Jordan")).toBeVisible();
  const batch = new URL(page.url()).searchParams.get("batch");
  const videos = (await (await page.request.get("/api/videos")).json()).videos as Array<{ batchId?: string; script: string; rowLabel?: string; resolution?: string }>;
  const mine = videos.filter((v) => v.batchId === batch);
  expect(mine.map((v) => v.rowLabel).sort()).toEqual(["Jordan", "Priya"]);
  expect(mine.every((v) => v.resolution === "720p")).toBe(true);
  expect(mine.find((v) => v.rowLabel === "Priya")?.script).toBe("Hi Priya, see you at 48 Harbor View on November 15.");
});

test("captions are served as SRT and VTT, security headers are set", async ({ page, request }) => {
  const v = await createVideoViaApi(page, "Caption formats", { captions: true, captionStyle: { position: "top", size: "large", look: "yellow" } });
  const vtt = await request.get(`/api/videos/${v.id}/captions?format=vtt`);
  expect(vtt.headers()["content-type"]).toContain("text/vtt");
  expect(await vtt.text()).toMatch(/^WEBVTT/);
  // The chosen position rides along as a cue setting; the SRT has no such thing.
  expect(await vtt.text()).toMatch(/--> 00:00:\d\d\.\d{3} line:5%\n/);
  expect(await (await request.get(`/api/videos/${v.id}/captions`)).text()).not.toMatch(/line:/);
  expect((await request.post("/api/videos", { data: { title: "Bad style", script: "Hi.", avatarId: "stock_1", voiceId: "stock_voice_1", captions: true, captionStyle: { position: "middle", size: "large" } } })).status()).toBe(400);
  const home = await request.get("/home");
  expect(home.headers()["x-frame-options"]).toBe("DENY");
  expect(home.headers()["x-content-type-options"]).toBe("nosniff");
  // Voice cloning records from the microphone and photo avatars use the camera, so both stay allowed for the app itself.
  expect(home.headers()["permissions-policy"]).toBe("camera=(self), microphone=(self), geolocation=()");
  // The subtitle track renders once the (mock) render completes, ~12s after submission.
  await expect.poll(async () => (await (await request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  const share = await request.get(`/share/${v.id}`);
  expect(share.headers()["x-frame-options"]).toBeUndefined();
  expect(await share.text()).toContain(`/api/videos/${v.id}/captions?format=vtt`);
  // The player carries the size as a class, which the stylesheet turns into a cue font size.
  await page.goto(`/share/${v.id}`);
  await expect(page.getByTestId("share-player")).toHaveClass(/cue-large/);
  await expect(page.getByTestId("share-player")).toHaveClass(/cue-look-yellow/);
  // The track is on from the start: the demo renderer (like D-ID, or HeyGen with a style) burns no captions into the file.
  await expect(page.getByTestId("share-player").locator("track")).toHaveAttribute("default", "");
  await page.goto(`/videos/${v.id}`);
  await expect(page.getByText("On · top, large, yellow")).toBeVisible();
  // The editor offers the style once captions are on, previews it on the stage, and a copy keeps it.
  await page.goto(`/create?from=${v.id}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("group", { name: "Caption position" }).getByRole("button", { name: "top" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("stage-caption")).toHaveClass(/top-4/);
  await page.getByRole("group", { name: "Caption size" }).getByRole("button", { name: "small" }).click();
  await expect(page.getByTestId("stage-caption")).toHaveClass(/text-xs/);
  await expect(page.getByRole("group", { name: "Caption look" }).getByRole("button", { name: "yellow" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("stage-caption")).toHaveAttribute("data-look", "yellow");
  // Rendered, not just classed: yellow is semibold (its colour is reported in lab(), so the weight is the stable check).
  await expect(page.getByTestId("stage-caption")).toHaveCSS("font-weight", "600");
  await page.getByRole("group", { name: "Caption look" }).getByRole("button", { name: "bold" }).click();
  await expect(page.getByTestId("stage-caption")).toHaveCSS("font-weight", "700");
  // The lightest look on the lightest stage at the smallest size still reads (and the look buttons pass too).
  await page.getByRole("group", { name: "Caption look" }).getByRole("button", { name: "minimal" }).click();
  await page.getByRole("button", { name: "Background", exact: true }).click();
  await page.getByRole("button", { name: "Background #ffffff" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByTestId("stage-caption")).toHaveAttribute("data-look", "minimal");
  // axe can only judge contrast it can see: bring the look buttons into view and hide the presenter layered under the caption.
  await page.getByTestId("caption-style").scrollIntoViewIfNeeded();
  await page.getByTestId("stage-presenter").evaluate((el) => ((el as HTMLElement).style.display = "none"));
  const axe = await new AxeBuilder({ page }).include('[data-testid="stage-caption"]').include('[data-testid="caption-style"]').withRules(["color-contrast"]).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  expect(axe.incomplete.filter((r) => r.id === "color-contrast").flatMap((r) => r.nodes.map((n) => n.target.join(" "))), "every node's contrast was decided").toEqual([]);
  const checked = axe.passes.filter((r) => r.id === "color-contrast").flatMap((r) => r.nodes.map((n) => n.html));
  expect(checked.some((html) => html.includes('data-testid="stage-caption"')), "the stage caption itself was checked").toBe(true);
  expect(checked.some((html) => html.includes('aria-pressed="true"') && html.includes("minimal")), "and the chosen look button").toBe(true);
});

/** A 1x1 transparent PNG. */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

test("brand kit pre-fills the editor and brands the share page", async ({ page }) => {
  try {
    await page.goto("/brand");
    await page.getByPlaceholder("Acme Realty").fill("Acme Realty");
    await page.getByLabel("Primary color", { exact: true }).fill("#0f766e");
    await page.getByLabel("Default voice").selectOption("stock_voice_3");
    await page.getByLabel("Captions on by default").check();
    await page.getByLabel("Default output quality").selectOption("720p");
    await page.getByLabel("Default background").selectOption("image");
    await expect(page.getByRole("button", { name: "Save brand kit" })).toBeDisabled();
    await page.getByLabel("Default background URL").fill("https://example.com/brand-bg.jpg");
    await page.getByLabel("Pronunciation", { exact: true }).fill("Nair = Nye-er\nSaaS = sass");
    // Terms to keep untranslated: one per line, repeats (ignoring case) dropped.
    await page.getByLabel("Never translate").fill("Acme Cloud\n\nacme cloud\nNimbus");
    // An uploaded logo, laid over the share player as a watermark.
    await page.locator('input[type="file"][accept*="image/svg+xml"]').setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG, "base64") });
    await expect(page.getByAltText("Logo preview")).toBeVisible();
    await page.getByLabel("Logo on the player").selectOption("bottom-right");
    await page.getByRole("button", { name: "Save brand kit" }).click();
    await expect(page.getByText(/^Saved /)).toBeVisible();
    const kit = (await (await page.request.get("/api/brand")).json()).brand;
    expect(kit.defaultBackground).toEqual({ type: "image", value: "https://example.com/brand-bg.jpg" });
    expect(kit.pronunciations).toEqual([{ word: "Nair", sayAs: "Nye-er" }, { word: "SaaS", sayAs: "sass" }]);
    expect(kit.glossary).toEqual(["Acme Cloud", "Nimbus"]);
    expect(kit.watermark).toBe("bottom-right");
    expect(kit.logoUrl).toBe(`data:image/png;base64,${TINY_PNG}`);
    await page.reload();
    await expect(page.getByLabel("Pronunciation", { exact: true })).toHaveValue("Nair = Nye-er\nSaaS = sass");
    await expect(page.getByLabel("Never translate")).toHaveValue("Acme Cloud\nNimbus");
    await expect(page.getByLabel("Logo on the player")).toHaveValue("bottom-right");
    // Clearing the logo turns the corner off with it (not saved here: the reload below discards it).
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(page.getByLabel("Logo on the player")).toBeDisabled();
    await expect(page.getByLabel("Logo on the player")).toHaveValue("");
    await page.reload();
    await expect(page.getByLabel("Logo on the player")).toHaveValue("bottom-right");
    // Plumbing only: the translate route reads the kit and answers (the demo writer copies its input, so the
    // glossary's effect is shown by the unit tests, which use a translator that rewrites every word).
    const translated = await page.request.post("/api/script", { data: { script: "Acme Cloud and Nimbus [pause 1s] ship today.", action: "translate", language: "Spanish" } });
    expect(translated.status()).toBe(200);
    expect((await translated.json()).script).toBe("[Spanish] Acme Cloud and Nimbus [pause 1s] ship today.");

    await page.goto("/create");
    await expect(page.getByText(/· Olivia · 16:9 · 1 scene · captions on$/)).toBeVisible({ timeout: 10_000 });
    // The kit's background sits behind the first scene.
    await expect(page.getByTestId("stage")).toHaveCSS("background-image", /brand-bg\.jpg/);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("button", { name: /^720p/ })).toHaveAttribute("aria-pressed", "true");

    const v = await createVideoViaApi(page, "Branded video");
    await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
    await page.goto(`/share/${v.id}`);
    await expect(page.getByTestId("share-brand")).toContainText("Acme Realty");
    // The header logo and the watermark link one cacheable URL for the uploaded file, which the page no longer carries inline.
    const logoSrc = await page.getByRole("img", { name: "Acme Realty logo" }).getAttribute("src");
    expect(logoSrc).toMatch(new RegExp(`^/api/videos/${v.id}/logo\\?v=`));
    const mark = page.getByTestId("share-watermark");
    await expect(mark).toHaveAttribute("src", logoSrc!);
    await expect(mark).toHaveAttribute("data-corner", "bottom-right");
    await expect(mark).toHaveAttribute("aria-hidden", "true");
    await expect(mark).toHaveAttribute("alt", "");
    // The logo is drawn in the corner of its box, not centred along one side.
    await expect(mark).toHaveCSS("object-position", "100% 100%");
    expect((await (await page.request.get(`/share/${v.id}`)).text()).includes(TINY_PNG)).toBe(false);
    const logo = await page.request.get(logoSrc!);
    expect(logo.status()).toBe(200);
    expect(logo.headers()["content-type"]).toBe("image/png");
    expect(logo.headers()["content-security-policy"]).toContain("sandbox");
    expect(Buffer.from(await logo.body()).toString("base64")).toBe(TINY_PNG);
    // A click on the mark reaches the player beneath it.
    const box = (await mark.boundingBox())!;
    expect(box.width).toBeGreaterThan(0);
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [box.x + box.width / 2, box.y + box.height / 2])).toBe("VIDEO");
    // A shared presenter's talk page links the same file through its own route.
    const agent = (await (await page.request.post("/api/agents", { data: { name: "Logo check", avatarId: "stock_1", isPublic: true } })).json()).agent;
    const talkLogo = (await (await page.request.get(`/api/talk/${agent.id}`)).json()).agent.brand.logoUrl;
    expect(talkLogo).toMatch(new RegExp(`^/api/talk/${agent.id}/logo\\?v=`));
    expect(Buffer.from(await (await page.request.get(talkLogo)).body()).toString("base64")).toBe(TINY_PNG);
    // A paused link takes the logo down with the page, as deleting the presenter does.
    expect((await page.request.patch(`/api/agents/${agent.id}`, { data: { isPublic: false } })).ok()).toBe(true);
    expect((await page.request.get(talkLogo)).status()).toBe(404);
    expect((await page.request.delete(`/api/agents/${agent.id}`)).ok()).toBe(true);
    expect((await page.request.get(talkLogo)).status()).toBe(404);
    // The logo follows the share page's rules: an offline link takes it down too.
    await page.request.patch(`/api/videos/${v.id}`, { data: { shareDisabled: true } });
    expect((await page.request.get(logoSrc!)).status()).toBe(404);
    await expect(page.getByRole("link", { name: "Avatar Studio" })).toBeVisible();
  } finally {
    // The suite shares one in-memory store; later tests expect the plain defaults.
    expect((await page.request.delete("/api/brand")).status()).toBe(204);
  }
});

test("folders filter the library and share views are counted once per viewer", async ({ page }) => {
  // Unique names: the suite shares one store, and a retry must not see the previous attempt's videos.
  const tag = Date.now().toString(36);
  const folder = `Listings ${tag}`;
  const a = await createVideoViaApi(page, `Filed video ${tag}`);
  await createVideoViaApi(page, `Loose video ${tag}`);
  const patch = await page.request.patch(`/api/videos/${a.id}`, { data: { folder } });
  expect(patch.status()).toBe(200);
  expect((await page.request.patch(`/api/videos/${a.id}`, { data: {} })).status()).toBe(400);

  await page.goto("/videos");
  await page.getByLabel("Folder", { exact: true }).selectOption(folder);
  await expect(page.locator("a[href^='/videos/vid_']")).toHaveCount(1);
  await expect(page.getByText(`Filed video ${tag}`)).toBeVisible();
  await page.getByLabel("Folder", { exact: true }).selectOption("unfiled");
  await expect(page.getByText(`Filed video ${tag}`)).toHaveCount(0);

  // Views: nothing while rendering, then one per viewer per window once completed.
  expect((await (await page.request.post(`/api/videos/${a.id}/view`)).json()).counted).toBe(false);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${a.id}`)).json()).video.status, { timeout: 20_000 }).toBe("completed");
  await page.goto(`/share/${a.id}`);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${a.id}`)).json()).video.views).toBe(1);
  await page.reload();
  await page.waitForTimeout(500);
  expect((await (await page.request.get(`/api/videos/${a.id}`)).json()).video.views).toBe(1);

  await page.goto(`/videos/${a.id}`);
  await expect(page.getByRole("button", { name: "Move to a folder" })).toContainText(folder);
  await page.getByRole("button", { name: "Move to a folder" }).click();
  await page.getByLabel("Folder name").fill("Archive");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Move to a folder" })).toContainText("Archive");
  expect((await (await page.request.get(`/api/videos/${a.id}`)).json()).video.folder).toBe("Archive");

  // The library renames and removes the chosen folder; the actions only show for a real folder.
  expect((await page.request.patch(`/api/videos/${a.id}`, { data: { folder: `Keep ${tag}` } })).status()).toBe(200);
  await page.goto("/videos");
  await expect(page.getByTestId("folder-actions")).toHaveCount(0);
  await page.getByLabel("Folder", { exact: true }).selectOption(`Keep ${tag}`);
  page.once("dialog", (d) => d.accept(`Kept ${tag}`));
  await page.getByRole("button", { name: "Rename folder" }).click();
  await expect(page.getByLabel("Folder", { exact: true })).toHaveValue(`Kept ${tag}`);
  await expect(page.getByText(`Filed video ${tag}`)).toBeVisible();
  expect((await (await page.request.get(`/api/videos/${a.id}`)).json()).video.folder).toBe(`Kept ${tag}`);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Remove folder" }).click();
  await expect(page.getByTestId("folder-actions")).toHaveCount(0);
  await expect(page.getByText(`Filed video ${tag}`)).toBeVisible();
  expect((await (await page.request.get(`/api/videos/${a.id}`)).json()).video.folder).toBeUndefined();
  expect((await page.request.post("/api/videos/folders", { data: { from: "", to: "x" } })).status()).toBe(400);
});

test("library multi-select moves and deletes videos in bulk", async ({ page }) => {
  const tag = Date.now().toString(36);
  const a = await createVideoViaApi(page, `Bulk one ${tag}`);
  const b = await createVideoViaApi(page, `Bulk two ${tag}`);
  // Only Move (prompt) and Delete (confirm) may open a dialog; the share buttons must not.
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.accept(`Bulk ${tag}`);
  });

  await page.goto("/videos");
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk one ${tag}` }).click();
  await page.getByRole("button", { name: `Select Bulk two ${tag}` }).click();
  await expect(page.getByTestId("bulk-bar")).toContainText("2 selected");
  await page.getByRole("button", { name: "Move to folder" }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  expect((await (await page.request.get(`/api/videos/${a.id}`)).json()).video.folder).toBe(`Bulk ${tag}`);
  expect((await (await page.request.get(`/api/videos/${b.id}`)).json()).video.folder).toBe(`Bulk ${tag}`);

  // Share links switch off and on for the selection; the cards show the badge.
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk one ${tag}` }).click();
  await page.getByRole("button", { name: `Select Bulk two ${tag}` }).click();
  await page.getByRole("button", { name: "Links off" }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  const badgeOn = (id: string) => page.locator(`a[href="/videos/${id}"]`).getByTestId("share-badges");
  await expect(badgeOn(a.id)).toContainText("Link off");
  await expect(badgeOn(b.id)).toContainText("Link off");
  expect((await page.request.get(`/share/${a.id}`)).status()).toBe(404);
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk one ${tag}` }).click();
  await page.getByRole("button", { name: "Links on" }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  await expect(badgeOn(a.id)).toHaveCount(0);
  await expect(badgeOn(b.id)).toContainText("Link off");
  expect((await page.request.get(`/share/${a.id}`)).status()).toBe(200);

  // Delete moves to the trash: gone from the library, 404 to the public, still the owner's to restore.
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk two ${tag}` }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  await expect(page.locator(`a[href="/videos/${b.id}"]`)).toHaveCount(0);
  const trashedB = (await (await page.request.get(`/api/videos/${b.id}`)).json()).video;
  expect(typeof trashedB.deletedAt).toBe("string");
  expect((await page.request.get(`/share/${b.id}`)).status()).toBe(404);
  expect((await page.request.post(`/api/videos/${b.id}/view`)).status()).toBe(404);
  expect((await page.request.get(`/api/videos/${a.id}`)).status()).toBe(200);
  // The trash view lists it with the days left, and Restore brings it back to the library.
  await page.getByTestId("trash-toggle").click();
  await expect(page.getByTestId("trash-toggle")).toContainText(/Trash \(\d+\)/);
  const trashCard = page.locator(`a[href="/videos/${b.id}"]`);
  await expect(trashCard.getByTestId("trash-badge")).toContainText("30 days left");
  await expect(page.locator(`a[href="/videos/${a.id}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk two ${tag}` }).click();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  await expect(trashCard).toHaveCount(0);
  expect((await (await page.request.get(`/api/videos/${b.id}`)).json()).video.deletedAt).toBeUndefined();
  // Its own share switch is still off from above; once that is on again the public page is back.
  expect((await page.request.patch(`/api/videos/${b.id}`, { data: { shareDisabled: false } })).status()).toBe(200);
  expect((await page.request.get(`/share/${b.id}`)).status()).toBe(200);
  // From the video page: trash, see the banner, delete for good.
  expect((await page.request.delete(`/api/videos/${b.id}`)).status()).toBe(200);
  await page.goto(`/videos/${b.id}`);
  await expect(page.getByTestId("trash-banner")).toContainText("in the trash");
  await page.getByRole("button", { name: "Delete forever" }).click();
  await expect(page).toHaveURL(/\/videos$/);
  expect((await page.request.get(`/api/videos/${b.id}`)).status()).toBe(404);
  // Purging only reaches the trash; a live video is reported, not deleted.
  expect(await (await page.request.post("/api/videos/bulk", { data: { action: "purge", ids: [a.id] } })).json()).toEqual({ done: 0, missing: [a.id] });
  expect((await page.request.get(`/api/videos/${a.id}`)).status()).toBe(200);
  expect((await page.request.post("/api/videos/bulk", { data: { action: "move", ids: [] } })).status()).toBe(400);
  expect(dialogs).toEqual(["Folder name (leave empty to move to Unfiled)", "Move 1 video to the trash? You can restore it for 30 days.", "Delete this video for good? This cannot be undone."]);
});

test("webhook settings reject private hosts and show the signing secret", async ({ page }) => {
  await page.goto("/settings");
  const url = page.getByLabel("Webhook URL");
  await url.fill("http://localhost:9/hook");
  await page.getByRole("button", { name: "Save webhook" }).click();
  await expect(page.getByText(/public host/)).toBeVisible();
  await url.fill("https://203.0.113.5/hooks/studio");
  await page.getByRole("button", { name: "Save webhook" }).click();
  await expect(page.getByTestId("webhook-secret")).toContainText("whsec_");
  expect((await (await page.request.get("/api/notifications")).json()).webhook.url).toBe("https://203.0.113.5/hooks/studio");

  // A finished render schedules a delivery after the response; the unroutable endpoint records a failed attempt.
  const v = await createVideoViaApi(page, `Webhook video ${Date.now().toString(36)}`);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 20_000 }).toBe("completed");
  await expect
    .poll(async () => (await (await page.request.get("/api/notifications")).json()).webhook?.lastDelivery?.event, { timeout: 30_000, intervals: [1000] })
    .toBe("video.completed");
  expect((await (await page.request.get("/api/notifications")).json()).webhook.lastDelivery.ok).toBe(false);

  await page.reload();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Remove webhook" }).click();
  await expect(page.getByTestId("webhook-secret")).toHaveCount(0);
  expect((await (await page.request.get("/api/notifications")).json()).webhook).toBeNull();
});

test("pages have no WCAG 2.1 AA violations", async ({ page }) => {
  const v = await createVideoViaApi(page, "Accessible video");
  const agent = (await (await page.request.post("/api/agents", { data: { name: "Axe agent", avatarId: "stock_1" } })).json()).agent as { id: string };
  const paths = ["/", "/login", "/home", "/create", "/videos", `/videos/${v.id}`, "/templates", "/batch", "/avatars", "/voices", "/translate", "/interactive", "/brand", "/settings", `/share/${v.id}`, `/talk/${agent.id}`];
  const report: string[] = [];
  for (const path of paths) {
    await page.goto(path);
    await page.waitForLoadState("networkidle").catch(() => {});
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    for (const vio of result.violations) report.push(`${path}: ${vio.id} (${vio.impact}) x${vio.nodes.length} ${vio.nodes[0]?.target.join(" ")}`);
  }
  expect(report, report.join("\n")).toEqual([]);
  await page.request.delete(`/api/agents/${agent.id}`);
});

test("workspaces: create, switch, isolate content, invite, join, leave, delete", async ({ page, playwright }) => {
  const tag = Date.now().toString(36);
  const personal = await createVideoViaApi(page, `Personal ${tag}`);
  const created = await page.request.post("/api/workspaces", { data: { name: `Team ${tag}` } });
  expect(created.status()).toBe(201);
  const ws = (await created.json()).workspace as { id: string };
  try {
    expect((await page.request.post("/api/workspaces/switch", { data: { id: ws.id } })).status()).toBe(200);
    const inTeam = (await (await page.request.get("/api/videos")).json()).videos as Array<{ id: string }>;
    expect(inTeam.find((v) => v.id === personal.id)).toBeUndefined();
    const team = await createVideoViaApi(page, `Team video ${tag}`);

    await page.goto("/home");
    await expect(page.getByLabel("Workspace")).toHaveValue(ws.id);
    await expect(page.getByText(`Team video ${tag}`)).toBeVisible();
    await expect(page.getByText(`Personal ${tag}`)).toHaveCount(0);

    // An owner in a workspace keeps every create control; the view-only notice is for viewers.
    await page.goto("/create");
    await expect(page.getByRole("button", { name: "Generate video" })).toBeVisible();
    await expect(page.getByTestId("view-only")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Create video" }).first()).toBeVisible();

    // The activity feed on the members page names the video just created.
    await page.goto("/workspace");
    const feed = page.getByTestId("activity-feed");
    await expect(feed.getByText(`You created "Team video ${tag}"`)).toBeVisible();
    await expect(page.getByRole("option", { name: /Viewer: watch and comment only/ })).toBeAttached();
    expect((await page.request.post(`/api/workspaces/${ws.id}/invites`, { data: { role: "viewer" } })).status()).toBe(201);
    await page.getByRole("button", { name: "Create invite link" }).click();
    const link = (await page.getByTestId("invite-link").locator("code").innerText()).trim();
    expect(link).toContain("/invite/");

    // A second browser context (a teammate) opens the link and joins; in open mode both are "local",
    // so the join is a no-op for membership but must still consume the invite and set the cookie.
    const other = await playwright.request.newContext({ baseURL: "http://localhost:3100" });
    const token = link.split("/invite/")[1];
    expect((await other.get(`/api/invites/${token}`)).status()).toBe(200);
    expect((await other.post(`/api/invites/${token}`)).status()).toBe(200);
    expect((await other.get(`/api/invites/${token}`)).status()).toBe(404);
    const theirs = (await (await other.get("/api/videos")).json()).videos as Array<{ id: string }>;
    expect(theirs.some((v) => v.id === team.id)).toBe(true);
    await other.dispose();
    // A trash from the API lands in the feed, newest first; the feed is scoped to the workspace. The
    // teammate's "join" above was a member opening the link again (both are "local" here), so it is
    // not a join and leaves no line; trashing the same video again changes nothing and leaves none either.
    expect((await page.request.delete(`/api/videos/${team.id}`)).status()).toBe(200);
    expect((await page.request.delete(`/api/videos/${team.id}`)).status()).toBe(200);
    const events = (await (await page.request.get("/api/activity?limit=5")).json()).events as Array<{ kind: string; subject?: string }>;
    expect(events.map((e) => e.kind)).toEqual(["video.trashed", "video.created"]);
    expect(events[0].subject).toBe(`Team video ${tag}`);
    await page.reload();
    await expect(feed.getByText(`You moved "Team video ${tag}" to the trash`)).toBeVisible();

    // Back to personal: the team video is gone, the personal one is back.
    await page.getByLabel("Workspace").selectOption({ label: "Personal" });
    await page.waitForURL(/\/home$/);
    await expect(page.getByLabel("Workspace")).not.toHaveValue(ws.id);
    const mine = (await (await page.request.get("/api/videos")).json()).videos as Array<{ id: string }>;
    expect(mine.some((v) => v.id === personal.id)).toBe(true);
    expect(mine.some((v) => v.id === team.id)).toBe(false);
  } finally {
    await page.request.post("/api/workspaces/switch", { data: { id: "local" } });
    expect((await page.request.delete(`/api/workspaces/${ws.id}`)).status()).toBe(204);
  }
});

test("a workspace viewer sees view-only notices instead of create controls", async ({ page }) => {
  // Demo mode has one user, so stand in a workspace list where that user is a viewer.
  await page.route("**/api/workspaces", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { personalId: "demo-user", activeId: "ws_view", workspaces: [{ id: "ws_view", name: "Read only team", role: "viewer", members: [] }] } })
      : route.continue(),
  );
  const pages: Array<[string, string]> = [
    ["/create", "generate videos"],
    ["/batch", "start batches"],
    ["/translate", "start translations"],
    ["/avatars", "add or change avatars"],
    ["/voices", "clone or change voices"],
    ["/brand", "change the brand kit"],
    ["/interactive", "save or change agents"],
  ];
  for (const [path, what] of pages) {
    await page.goto(path);
    await expect(page.getByTestId("view-only"), path).toContainText(`not ${what}`);
  }
  await page.goto("/create");
  await expect(page.getByRole("button", { name: "Generate video" })).toBeDisabled();
  // The nav item stays (the page explains itself); the sidebar call-to-action button goes.
  await expect(page.getByRole("link", { name: "Create video" })).toHaveCount(1);
  await page.goto("/avatars");
  await expect(page.getByRole("button", { name: "New photo avatar" })).toBeDisabled();
  await page.goto("/voices");
  await expect(page.getByTestId("voice-cloner")).toHaveCount(0);
});

test("workspace videos go through review: ask, request changes, ask again, approve", async ({ page }) => {
  const tag = Date.now().toString(36);
  // Reviews need a team: a personal video is refused.
  const personal = await createVideoViaApi(page, `Solo ${tag}`);
  expect((await page.request.post(`/api/videos/${personal.id}/review`, { data: { action: "request" } })).status()).toBe(400);
  const ws = (await (await page.request.post("/api/workspaces", { data: { name: `Review ${tag}` } })).json()).workspace as { id: string };
  try {
    expect((await page.request.post("/api/workspaces/switch", { data: { id: ws.id } })).status()).toBe(200);
    const video = await createVideoViaApi(page, `Needs sign-off ${tag}`);
    await page.goto(`/videos/${video.id}`);
    const panel = page.getByTestId("review-panel");
    // Only a finished render goes for review.
    expect((await page.request.post(`/api/videos/${video.id}/review`, { data: { action: "request" } })).status()).toBe(409);
    await expect(page.getByText("Completed")).toBeVisible({ timeout: 30_000 });
    await panel.getByLabel("Review note").fill("Ready for the newsletter");
    await panel.getByRole("button", { name: "Ask for review" }).click();
    await expect(panel.getByTestId("review-status")).toHaveText("In review");
    await expect(panel.getByTestId("review-note")).toHaveText("Ready for the newsletter");
    // The owner asks for changes, which needs a note.
    await expect(panel.getByRole("button", { name: "Ask for changes" })).toBeDisabled();
    await panel.getByLabel("Review note").fill("Use the new logo");
    await panel.getByRole("button", { name: "Ask for changes" }).click();
    await expect(panel.getByTestId("review-status")).toHaveText("Changes requested");
    await expect(panel.getByTestId("review-note")).toHaveText("Use the new logo");
    await panel.getByRole("button", { name: "Ask for review again" }).click();
    await expect(panel.getByTestId("review-status")).toHaveText("In review");
    await panel.getByRole("button", { name: "Approve" }).click();
    await expect(panel.getByTestId("review-status")).toHaveText("Approved");
    await expect(panel).toContainText("Approved by you");
    // The library shows the state and filters by it.
    await page.goto("/videos");
    const card = page.locator(`a[href="/videos/${video.id}"]`);
    await expect(card.getByTestId("review-badge")).toHaveText("Approved");
    await page.getByLabel("Filter by review").selectOption("pending");
    await expect(card).toHaveCount(0);
    await page.getByLabel("Filter by review").selectOption("approved");
    await expect(card).toBeVisible();
    // The team's feed names each step.
    const feed = (await (await page.request.get("/api/activity")).json()).events as Array<{ kind: string; subjectId?: string }>;
    expect(feed.filter((e) => e.subjectId === video.id).map((e) => e.kind).slice(0, 4)).toEqual(["video.approved", "video.review_requested", "video.changes_requested", "video.review_requested"]);
    // A decided review cannot be decided again.
    expect((await page.request.post(`/api/videos/${video.id}/review`, { data: { action: "approve" } })).status()).toBe(409);
    // Renaming it changes what the share page shows, so the approval goes.
    const renamed = (await (await page.request.patch(`/api/videos/${video.id}`, { data: { title: `Renamed ${tag}` } })).json()).video;
    expect(renamed.review).toBeUndefined();
  } finally {
    await page.request.post("/api/workspaces/switch", { data: { id: "local" } });
    expect((await page.request.delete(`/api/workspaces/${ws.id}`)).status()).toBe(204);
  }
});

test("one video is dubbed into several languages in one go", async ({ page }) => {
  const tag = Date.now().toString(36);
  await page.goto("/translate");
  await page.getByPlaceholder("https://…/video.mp4").fill("https://cdn.example.com/walkthrough.mp4");
  // Spanish is picked to start with; two more make three dubs.
  const langs = page.getByTestId("target-languages");
  await langs.getByText("French", { exact: true }).click();
  await langs.getByText("German", { exact: true }).click();
  await page.getByLabel("Title (optional)").fill(`Walkthrough ${tag}`);
  await page.getByRole("button", { name: "Translate into 3 languages" }).click();
  for (const lang of ["Spanish", "French", "German"]) await expect(page.getByText(`Walkthrough ${tag} (${lang})`)).toBeVisible();
  // The API takes the list directly and keeps the single-language form.
  const res = await page.request.post("/api/translate", { data: { title: `API ${tag}`, sourceVideoUrl: "https://cdn.example.com/v.mp4", targetLanguages: ["Italian", "italian", "Portuguese"] } });
  expect(res.status()).toBe(201);
  expect(((await res.json()).translations as Array<{ title: string }>).map((t) => t.title)).toEqual([`API ${tag} (Italian)`, `API ${tag} (Portuguese)`]);
  const single = await page.request.post("/api/translate", { data: { title: `One ${tag}`, sourceVideoUrl: "https://cdn.example.com/v.mp4", targetLanguage: "French" } });
  expect((await single.json()).translation.title).toBe(`One ${tag}`);
  expect((await page.request.post("/api/translate", { data: { title: "None", sourceVideoUrl: "https://cdn.example.com/v.mp4", targetLanguages: [] } })).status()).toBe(400);
});

test("demo billing upgrades to Pro and back from Settings", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByTestId("plan-name")).toHaveText("Free");
  await page.getByRole("button", { name: "Upgrade to Pro" }).click();
  await expect(page.getByTestId("plan-name")).toHaveText("Pro");
  expect((await (await page.request.get("/api/status")).json()).usage.plan).toBe("pro");
  expect((await page.request.post("/api/webhooks/stripe", { data: {} })).status()).toBe(503);
  await page.getByRole("button", { name: "Manage subscription" }).click();
  await expect(page.getByTestId("plan-name")).toHaveText("Free");
  expect((await (await page.request.get("/api/status")).json()).usage.plan).toBe("free");
});

test("shared presenter: save from the interactive page, talk publicly, turn off", async ({ page, playwright }) => {
  const tag = Date.now().toString(36);
  await page.goto("/interactive");
  await page.getByLabel("Agent name").fill(`Dana ${tag}`);
  // A knowledge page is read with the same guard as the script writer's page import: a private host is refused from the form.
  await page.getByLabel("Knowledge page URL").fill("http://127.0.0.1:3100/home");
  await page.getByRole("button", { name: "Save and get link" }).click();
  await expect(page.getByText(/public host/)).toBeVisible();
  expect((await page.request.post("/api/agents", { data: { name: "Bad", avatarId: "stock_1", knowledgeUrl: "notaurl" } })).status()).toBe(400);
  await page.getByLabel("Knowledge page URL").fill("");
  await page.getByLabel("Suggested questions").fill("x".repeat(81));
  await page.getByRole("button", { name: "Save and get link" }).click();
  await expect(page.getByText(/at most 80 characters/)).toBeVisible();
  await page.getByLabel("Suggested questions").fill("");
  await page.getByRole("button", { name: "Save and get link" }).click();
  const link = (await page.getByTestId("agent-link").locator("code").innerText()).trim();
  const id = link.split("/talk/")[1];
  expect(id).toMatch(/^agent_/);
  await expect(page.getByTestId("agent-list")).toContainText(`Dana ${tag}`);

  // A visitor with no session can read the public view and talk; instructions are never exposed.
  const visitor = await playwright.request.newContext({ baseURL: "http://localhost:3100" });
  const info = await (await visitor.get(`/api/talk/${id}`)).json();
  expect(info.agent.name).toBe(`Dana ${tag}`);
  expect(JSON.stringify(info)).not.toContain("real estate team");
  const turn = await visitor.post(`/api/talk/${id}`, { data: { messages: [{ role: "user", content: "Hi there" }] } });
  expect(turn.status()).toBe(200);
  const first = (await turn.json()) as { reply: string; conversationId: string };
  expect(first.reply).toMatch(/^Hi, I'm /);
  expect(first.conversationId).toMatch(/^conv_/);
  const second = await visitor.post(`/api/talk/${id}`, { data: { conversationId: first.conversationId, messages: [{ role: "user", content: "Hi there" }, { role: "assistant", content: first.reply }, { role: "user", content: "Any open houses?" }] } });
  expect((await second.json()).conversationId).toBe(first.conversationId);
  expect((await visitor.get(`/talk/${id}`)).headers()["x-frame-options"]).toBeUndefined();
  expect((await visitor.get(`/api/agents/${id}`)).status()).toBe(200); // open mode: owner routes need no session

  // Lead capture: turn it on, a visitor sees the form after the first reply, the owner sees the email.
  expect((await page.request.patch(`/api/agents/${id}`, { data: { collectEmail: true } })).status()).toBe(200);
  // Editing one field leaves the rest alone: the instructions (and the greeting built from them) survive the patch.
  const afterPatch = (await (await page.request.get(`/api/agents/${id}`)).json()).agent as { instructions: string; isPublic: boolean };
  expect(afterPatch.instructions).toContain("real estate team");
  expect(afterPatch.isPublic).toBe(true);
  const visitorPage = await page.context().newPage();
  await visitorPage.goto(`/talk/${id}`);
  await expect(visitorPage.getByTestId("lead-form")).toHaveCount(0);
  await visitorPage.getByLabel("Your message").fill("Hello");
  await visitorPage.getByRole("button", { name: "Send" }).click();
  await expect(visitorPage.locator("[data-testid=chat-log] [data-role=assistant]")).toHaveCount(1);
  await visitorPage.getByLabel("Your email").fill(`sam-${tag}@example.com`);
  await visitorPage.getByRole("button", { name: "Send", exact: true }).last().click();
  await expect(visitorPage.getByTestId("lead-form")).toContainText(`follow up at sam-${tag}@example.com`);
  await visitorPage.close();

  // An opening line greets the next visitor before they type, counts as the presenter's first turn, and survives "Start over".
  expect((await page.request.patch(`/api/agents/${id}`, { data: { greeting: `Welcome ${tag}. Ask me about open houses.` } })).status()).toBe(200);
  const greetedPage = await page.context().newPage();
  await greetedPage.goto(`/talk/${id}`);
  await expect(greetedPage.locator("[data-testid=chat-log] [data-opening]")).toHaveText(`Welcome ${tag}. Ask me about open houses.`);
  await expect(greetedPage.getByRole("button", { name: "Start over" })).toBeDisabled();
  await greetedPage.getByLabel("Your message").fill("Hello");
  await greetedPage.getByRole("button", { name: "Send" }).click();
  await expect(greetedPage.locator("[data-testid=chat-log] [data-role=assistant]")).toHaveCount(2);
  await greetedPage.getByRole("button", { name: "Start over" }).click();
  await expect(greetedPage.locator("[data-testid=chat-log] [data-role=assistant]")).toHaveCount(1);
  await greetedPage.close();

  // Suggested questions are offered as chips until the first message; a chip sends its question.
  expect((await page.request.patch(`/api/agents/${id}`, { data: { starters: ["Any open houses this week?", "How do I book a showing?"] } })).status()).toBe(200);
  const chipPage = await page.context().newPage();
  await chipPage.goto(`/talk/${id}`);
  await expect(chipPage.getByTestId("chat-starters").getByRole("button")).toHaveCount(2);
  await chipPage.getByRole("button", { name: "How do I book a showing?" }).click();
  await expect(chipPage.locator("[data-testid=chat-log] [data-role=user]")).toHaveText("How do I book a showing?");
  await expect(chipPage.locator("[data-testid=chat-log] [data-role=assistant]")).toHaveCount(2);
  await expect(chipPage.getByTestId("chat-starters")).toHaveCount(0);
  await chipPage.close();

  await page.reload();
  await expect(page.getByTestId("agent-list")).toContainText("4 conversations");
  await page.getByRole("button", { name: `Transcripts for Dana ${tag}` }).click();
  await expect(page.getByTestId("transcripts")).toContainText("Any open houses?");
  await expect(page.getByTestId("transcripts")).toContainText(`sam-${tag}@example.com`);
  await expect(page.getByTestId("transcripts").locator("summary")).toHaveCount(4);
  // The same conversations download as a lead list.
  await expect(page.getByTestId("transcripts").getByRole("link", { name: "Download CSV" })).toBeVisible();
  const csvRes = await page.request.get(`/api/agents/${id}/conversations?format=csv`);
  expect(csvRes.headers()["content-type"]).toContain("text/csv");
  const csv = await csvRes.text();
  expect(csv.replace(/^\uFEFF/, "").split("\r\n")[0]).toBe('"started","last_message","email","name","messages","first_question","last_reply"');
  expect(csv).toContain(`sam-${tag}@example.com`);
  expect(csv).toContain('"Hi there"');
  await page.getByRole("button", { name: `Turn off link for Dana ${tag}` }).click();
  await expect(page.getByTestId("agent-list")).toContainText("link off");
  expect((await visitor.get(`/api/talk/${id}`)).status()).toBe(404);
  await visitor.dispose();

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: `Delete Dana ${tag}` }).click();
  await expect(page.getByTestId("agent-list")).not.toContainText(`Dana ${tag}`);
});

test("live video reports unavailable in demo mode and the portrait path still works", async ({ page }) => {
  const open = await page.request.post("/api/live", { data: { avatarId: "stock_1" } });
  expect(open.status()).toBe(200);
  expect((await open.json()).available).toBe(false);
  expect((await page.request.post("/api/live/live_nope", { data: { text: "hi" } })).status()).toBe(404);
  const agent = (await (await page.request.post("/api/agents", { data: { name: "Live agent", avatarId: "stock_1" } })).json()).agent as { id: string };
  try {
    const pub = await page.request.post(`/api/talk/${agent.id}/live`);
    expect((await pub.json()).available).toBe(false);
    expect((await (await page.request.get(`/api/talk/${agent.id}`)).json()).agent.liveVideo).toBe(false);
    await page.goto(`/talk/${agent.id}`);
    await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("talk-name")).toContainText("Live agent");
  } finally {
    await page.request.delete(`/api/agents/${agent.id}`);
  }
});

test("interactive avatar answers a visitor in character", async ({ page }) => {
  await page.goto("/interactive");
  await page.getByLabel("Your message").fill("Hi there");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("[data-testid=chat-log] [data-role=assistant]")).toHaveCount(1);
  await expect(page.locator("[data-testid=chat-log] [data-role=assistant]").first()).toContainText(/^Hi, I'm /);
  await page.getByLabel("Your message").fill("How much does it cost?");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-testid=chat-log] [data-role=assistant]")).toHaveCount(2);
  await expect(page.locator("[data-testid=chat-log] [data-role=assistant]").nth(1)).toContainText(/pricing/i);
  expect((await page.request.post("/api/chat", { data: { avatarId: "stock_1", messages: [] } })).status()).toBe(400);
});

test("interactive avatar takes a spoken question when the browser can transcribe", async ({ page }) => {
  // Headless Chromium has no working recogniser; stand in a minimal Web Speech API that hears one sentence.
  await page.addInitScript(() => {
    class FakeRecognition {
      lang = "";
      interimResults = false;
      continuous = false;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        (window as unknown as { __recLang: string }).__recLang = this.lang;
        setTimeout(() => {
          const partial = Object.assign([{ transcript: "How much" }], { isFinal: false });
          this.onresult?.({ results: [partial] });
          const final = Object.assign([{ transcript: "How much does it cost?" }], { isFinal: true });
          this.onresult?.({ results: [final] });
          this.onend?.();
        }, 50);
      }
      stop() {
        this.onend?.();
      }
      abort() {}
    }
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
  });
  await page.goto("/interactive");
  const mic = page.getByRole("button", { name: "Speak a question" });
  await expect(mic).toBeVisible();
  await mic.click();
  await expect(page.locator("[data-testid=chat-log] [data-role=user]").first()).toHaveText("How much does it cost?");
  await expect(page.locator("[data-testid=chat-log] [data-role=assistant]").first()).toContainText(/pricing/i);
  await expect(page.getByLabel("Your message")).toHaveValue("");
  // The recogniser listens in the presenter's voice language (the default stock voice is en-US).
  expect(await page.evaluate(() => (window as unknown as { __recLang: string }).__recLang)).toBe("en-US");
});

test("the microphone button is hidden when the browser cannot transcribe", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.SpeechRecognition;
    delete w.webkitSpeechRecognition;
  });
  await page.goto("/interactive");
  await expect(page.getByLabel("Your message")).toBeVisible();
  await expect(page.getByRole("button", { name: "Speak a question" })).toHaveCount(0);
});

test("website embed script adds a launcher that opens the talk page", async ({ page }) => {
  const agent = (await (await page.request.post("/api/agents", { data: { name: "Embed agent", avatarId: "stock_2" } })).json()).agent as { id: string };
  try {
    const bad = await page.request.get("/embed/agent.js?id=nope");
    expect(bad.status()).toBe(400);
    const js = await page.request.get(`/embed/agent.js?id=${agent.id}&color=%230f766e&label=Ask%20Dana`);
    expect(js.status()).toBe(200);
    expect(js.headers()["content-type"]).toContain("javascript");
    expect(await js.text()).toContain(`/talk/${agent.id}?embed=1`);

    // A customer's page loads the script and gets a working launcher. The host page is served
    // through a routed response because Chrome blocks loopback loads from a null (about:blank) origin.
    await page.route("http://localhost:3100/customer-site.html", (route) =>
      route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><h1>Acme Realty</h1><script src="/embed/agent.js?id=${agent.id}&label=Ask%20Dana"></script></body></html>` }),
    );
    await page.goto("http://localhost:3100/customer-site.html");
    const launcher = page.getByRole("button", { name: "Ask Dana" });
    await expect(launcher).toBeVisible();
    await launcher.click();
    const frame = page.frameLocator("iframe[title='Chat with our presenter']");
    await expect(frame.getByTestId("talk-name")).toContainText("Embed agent");
    // Spoken questions need the host page to delegate the microphone to the iframe.
    await expect(page.locator("iframe[title='Chat with our presenter']")).toHaveAttribute("allow", "autoplay; microphone");
    await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Ask Dana" })).toBeVisible();
  } finally {
    await page.request.delete(`/api/agents/${agent.id}`);
  }
});

test("voice cloning saves a private voice that renders and can be deleted", async ({ page }) => {
  const sample = "data:audio/webm;base64," + Buffer.from("tiny sample bytes for the demo clone").toString("base64");
  const created = await page.request.post("/api/voices/clone", { data: { name: "My voice", samples: [sample] } });
  expect(created.status()).toBe(201);
  const voice = (await created.json()).voice as { id: string };
  try {
    const voices = (await (await page.request.get("/api/voices")).json()).voices as Array<{ id: string; source?: string }>;
    expect(voices[0].id).toBe(voice.id);
    expect(voices[0].source).toBe("custom");
    await page.goto("/voices");
    await expect(page.getByTestId("voice-cloner")).toBeVisible();
    await expect(page.getByText("My voice")).toBeVisible();
    const made = await page.request.post("/api/videos", { data: { title: "Cloned", script: "Hi.", avatarId: "stock_1", voiceId: voice.id, aspect: "16:9" } });
    expect(made.status()).toBe(201);
    expect((await made.json()).video.voiceName).toBe("My voice");
    expect((await page.request.post("/api/voices/clone", { data: { name: "bad", samples: ["data:image/png;base64,AAAA"] } })).status()).toBe(400);
    // Rename in place; the voice keeps its id, so the rendered video still plays with it.
    page.once("dialog", (d) => d.accept("Studio clone"));
    await page.getByRole("button", { name: "Rename My voice" }).click();
    await expect(page.getByText("Studio clone", { exact: true })).toBeVisible();
    expect(((await (await page.request.get("/api/voices")).json()).voices as Array<{ id: string; name: string }>).find((x) => x.id === voice.id)?.name).toBe("Studio clone");
    expect((await page.request.patch("/api/voices/stock_voice_1", { data: { name: "Nope" } })).status()).toBe(404);
    expect((await page.request.patch(`/api/voices/${voice.id}`, { data: { name: "" } })).status()).toBe(400);
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Delete Studio clone" }).click();
    await expect(page.getByText("Studio clone", { exact: true })).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/voices/${voice.id}`);
  }
});

test("a mention link opens the video in its workspace, and teammates can be picked to mention", async ({ page }) => {
  const tag = Date.now().toString(36);
  const ws = (await (await page.request.post("/api/workspaces", { data: { name: `Mentions ${tag}` } })).json()).workspace as { id: string };
  try {
    expect((await page.request.post("/api/workspaces/switch", { data: { id: ws.id } })).status()).toBe(200);
    const video = await createVideoViaApi(page, `Mentioned ${tag}`);
    // The reader is in their personal space; the emailed link carries the workspace and switches to it.
    await page.request.post("/api/workspaces/switch", { data: { id: "local" } });
    expect((await page.request.get(`/api/videos/${video.id}`)).status()).toBe(404);
    await page.goto(`/videos/${video.id}?ws=${ws.id}`);
    await expect(page.getByRole("heading", { name: `Mentioned ${tag}` })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/videos/${video.id}$`));
    await expect(page.getByLabel("Workspace")).toHaveValue(ws.id);
    // A link naming a space the reader is not a member of cannot move them out of this one.
    await page.goto(`/videos/${video.id}?ws=local#top`);
    await expect(page.getByRole("heading", { name: `Mentioned ${tag}` })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/videos/${video.id}#top$`));
    await expect(page.getByLabel("Workspace")).toHaveValue(ws.id);

    // Demo mode has one user without an email, so stand in a teammate to mention.
    await page.route("**/api/workspaces", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { personalId: "local", activeId: ws.id, workspaces: [{ id: ws.id, name: `Mentions ${tag}`, role: "owner", members: [{ userId: "local", role: "owner", you: true }, { userId: "user_bob", email: "bob@example.com", role: "editor" }] }] } })
        : route.continue(),
    );
    await page.reload();
    const chips = page.getByTestId("mention-suggestions");
    await page.getByLabel("New comment").fill("Thoughts @b");
    await chips.getByRole("button", { name: "@bob@example.com" }).click();
    await expect(page.getByLabel("New comment")).toHaveValue("Thoughts @bob@example.com ", { timeout: 5000 });
  } finally {
    await page.request.post("/api/workspaces/switch", { data: { id: "local" } });
    expect((await page.request.delete(`/api/workspaces/${ws.id}`)).status()).toBe(204);
  }
});

test("captions can be corrected on the video page and serve the downloads until reset", async ({ page }) => {
  const v = await createVideoViaApi(page, `Captioned ${Date.now().toString(36)}`);
  await page.goto(`/videos/${v.id}`);
  await expect(page.getByText("Completed")).toBeVisible({ timeout: 30_000 });
  const editor = page.getByTestId("caption-editor");
  await editor.getByRole("button", { name: "Edit captions" }).click();
  const first = editor.getByLabel("Line 1 text");
  await expect(first).not.toHaveValue("");
  await first.fill("Hello, and welcome!");
  const end1 = editor.getByLabel("Line 1 end (seconds)");
  const shown = await end1.inputValue();
  await end1.fill("abc");
  await editor.getByRole("button", { name: "Save captions" }).click();
  await expect(editor.getByTestId("caption-status")).toContainText("Line 1 needs a start and an end");
  // A decimal comma, all a comma-locale phone keypad offers, reads as a point.
  await end1.fill(shown.replace(".", ","));
  // A line added where lines follow on without a gap takes the second half of the line before it.
  await editor.getByRole("button", { name: "Add a line after line 1" }).click();
  const mid = (Math.round((Number(await editor.getByLabel("Line 1 start (seconds)").inputValue()) + Number(shown)) * 5) / 10).toFixed(1);
  await expect(end1).toHaveValue(mid);
  await expect(editor.getByLabel("Line 2 start (seconds)")).toHaveValue(mid);
  await expect(editor.getByLabel("Line 2 end (seconds)")).toHaveValue(shown);
  await editor.getByLabel("Line 2 text").fill("A line of my own.");
  await editor.getByRole("button", { name: "Save captions" }).click();
  await expect(editor.getByTestId("caption-status")).toHaveText("Captions saved");
  await expect(editor.getByTestId("captions-edited")).toBeVisible();

  const srt = await (await page.request.get(`/api/videos/${v.id}/captions`)).text();
  expect(srt).toMatch(/^1\n00:00:00,000 --> [\d:,]+\nHello, and welcome!\n\n2\n/);
  expect(srt).toContain("A line of my own.");
  expect(await (await page.request.get(`/api/videos/${v.id}/captions?format=vtt`)).text()).toContain("Hello, and welcome!");
  const json = await (await page.request.get(`/api/videos/${v.id}/captions?format=json`)).json();
  expect(json.edited).toBe(true);
  // Overlapping lines are refused with the line that is wrong.
  const overlap = await page.request.put(`/api/videos/${v.id}/captions`, { data: { cues: [{ startMs: 0, endMs: 2000, text: "a" }, { startMs: 1000, endMs: 3000, text: "b" }] } });
  expect(overlap.status()).toBe(400);
  expect(JSON.stringify(await overlap.json())).toContain("Line 2 starts before line 1 ends");

  await editor.getByRole("button", { name: "Follow the script" }).click();
  await expect(editor.getByTestId("captions-edited")).toHaveCount(0);
  expect((await (await page.request.get(`/api/videos/${v.id}/captions?format=json`)).json()).edited).toBe(false);
  expect(await (await page.request.get(`/api/videos/${v.id}/captions`)).text()).not.toContain("Hello, and welcome!");
});

test("a pause inserted in the script holds the presenter and leaves a gap in the captions", async ({ page }) => {
  const title = `Paused ${Date.now().toString(36)}`;
  await page.goto("/create");
  await page.locator("input[placeholder='Video title']").fill(title);
  const box = page.locator("textarea");
  await box.fill("Welcome home.");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(box).toHaveValue("Welcome home. [pause 1s] ");
  // The cursor is back after the marker, so typing carries on from there.
  await page.keyboard.type("Here is the kitchen.");
  await expect(box).toHaveValue("Welcome home. [pause 1s] Here is the kitchen.");
  // Markers are not words, but their time counts: six words at 2.5 a second plus one second.
  await expect(page.getByTestId("script-length")).toHaveText("6 words · ~3s");
  await page.getByRole("button", { name: "Generate video" }).click();
  await page.waitForURL(/\/videos\/vid_/);
  const id = page.url().split("/videos/")[1].split(/[?#]/)[0];
  const { cues } = await (await page.request.get(`/api/videos/${id}/captions?format=json`)).json();
  expect(cues.map((c: { text: string }) => c.text)).toEqual(["Welcome home.", "Here is the kitchen."]);
  expect(cues[1].startMs - cues[0].endMs).toBe(1000);
  // The share page's transcript and link preview read as speech.
  const share = await (await page.request.get(`/share/${id}`)).text();
  expect(share).toContain("Welcome home. Here is the kitchen.");
  expect(share).not.toContain("[pause");
});

test("a dub can be voice only and name its speakers", async ({ page }) => {
  const tag = Date.now().toString(36);
  await page.goto("/translate");
  await page.getByPlaceholder("https://…/video.mp4").fill("https://cdn.example.com/interview.mp4");
  await page.getByLabel("Lip-sync the dub").uncheck();
  await page.getByLabel("Speakers").selectOption("2");
  await page.getByLabel("Title (optional)").fill(`Interview ${tag}`);
  await page.getByRole("button", { name: "Translate video" }).click();
  const card = page.locator("div", { has: page.getByText(`Interview ${tag}`, { exact: true }) }).getByTestId("translation-meta").first();
  await expect(card).toContainText("→ Spanish · voice only · 2 speakers");
  // The next video may have a different cast, so the count goes back to detecting it; lip-sync stays as chosen.
  await expect(page.getByLabel("Speakers")).toHaveValue("0");
  await expect(page.getByLabel("Lip-sync the dub")).not.toBeChecked();
  const list = (await (await page.request.get("/api/translate")).json()).translations as Array<{ title: string; audioOnly?: boolean; speakers?: number }>;
  const made = list.find((t) => t.title === `Interview ${tag}`);
  expect([made?.audioOnly, made?.speakers]).toEqual([true, 2]);
  expect((await page.request.post("/api/translate", { data: { title: "Too many", sourceVideoUrl: "https://cdn.example.com/v.mp4", targetLanguage: "French", speakers: 11 } })).status()).toBe(400);
});

test("a share page can ask for an email before playing, and the owner sees who watched", async ({ page, browser }) => {
  const v = await createVideoViaApi(page, `Gated ${Date.now().toString(36)}`);
  await page.goto(`/videos/${v.id}`);
  await expect(page.getByText("Completed")).toBeVisible({ timeout: 30_000 });
  // Nothing to collect yet, so no card until the gate is on.
  await expect(page.getByTestId("viewer-emails")).toHaveCount(0);
  await page.getByLabel("Ask for an email before playing").check();
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.shareGate).toBe(true);
  await expect(page.getByTestId("viewer-emails")).toContainText("Viewer emails · 0");

  // The link preview carries neither the video nor the script, which would stand in for the form.
  const html = await (await page.request.get(`/share/${v.id}`)).text();
  expect(html).not.toContain('property="og:video"');
  expect(html).not.toMatch(/<meta[^>]+og:description[^>]+Hello there/);
  // A visitor with no cookies meets the form, not the player.
  const visitor = await browser.newContext();
  const share = await visitor.newPage();
  await share.goto(`/share/${v.id}`);
  await expect(share.getByTestId("share-gate")).toBeVisible();
  await expect(share.locator("video")).toHaveCount(0);
  await share.getByLabel("Your email").fill("Viewer@Example.com");
  await share.getByLabel("Your name (optional)").fill("Vee");
  await share.getByRole("button", { name: "Watch video" }).click();
  await expect(share.locator("video")).toBeVisible();
  // The pass is remembered for this video.
  await share.reload();
  await expect(share.locator("video")).toBeVisible();
  await expect(share.getByTestId("share-gate")).toHaveCount(0);
  await visitor.close();

  await page.reload();
  const card = page.getByTestId("viewer-emails");
  await expect(card).toContainText("Viewer emails · 1");
  await expect(page.getByTestId("viewer-email-list")).toContainText("viewer@example.com · Vee");
  const csv = await (await page.request.get(`/api/videos/${v.id}/leads?format=csv`)).text();
  expect(csv).toContain('"viewer@example.com","Vee"');
  // A link that does not ask takes no emails.
  await page.getByLabel("Ask for an email before playing").uncheck();
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.shareGate).toBeUndefined();
  expect((await page.request.post(`/api/videos/${v.id}/lead`, { data: { email: "late@example.com" } })).status()).toBe(404);
  expect((await page.request.post(`/api/videos/vid_nope/lead`, { data: { email: "x@example.com" } })).status()).toBe(404);
});
