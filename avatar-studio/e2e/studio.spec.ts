import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { strToU8, zipSync } from "fflate";
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
  // The template's blanks are pointed out, since the presenter would read them out as written.
  await expect(page.getByTestId("unfilled-placeholders")).toContainText("Fill in {address}, {bedrooms}");
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

test("the video agent plans a video from a prompt, to review in the editor or to render", async ({ page }) => {
  await page.goto("/agent");
  await expect(page.getByRole("button", { name: "Generate video" })).toBeDisabled();
  await page.getByLabel("What should the video be?").fill("Make a TikTok about our spring open house");
  await page.getByRole("button", { name: "Review in editor first" }).click();
  // The plan opens in the editor like a template: title, scenes, and a note saying where they came from.
  await expect(page).toHaveURL(/\/create\?plan=agent$/);
  await expect(page.getByTestId("agent-plan")).toContainText("planned these 4 scenes");
  await expect(page.locator("input[placeholder='Video title']")).toHaveValue("Our spring open house");
  await expect(page.locator("textarea")).toHaveValue("Hi there! Let's talk about our spring open house.");
  await expect(page.getByRole("button", { name: /^Scene 4,/ })).toBeVisible();
  // It is read once: a refresh comes back to the autosaved draft of it, not to the plan.
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("avatar-studio:draft") ?? "{}").title)).toBe("Our spring open house");
  await page.reload();
  await expect(page.getByTestId("agent-plan")).toHaveCount(0);
  await expect(page.locator("input[placeholder='Video title']")).toHaveValue("Our spring open house");
  await page.evaluate(() => localStorage.removeItem("avatar-studio:draft"));

  // Generate renders straight away, in the format asked for, with captions on.
  await page.goto("/agent");
  await page.getByLabel("What should the video be?").fill("A short video about our refund policy");
  await page.getByLabel("Format").selectOption("square");
  await page.getByRole("button", { name: "Generate video" }).click();
  await expect(page).toHaveURL(/\/videos\/vid_/);
  const id = page.url().split("/videos/")[1];
  const video = (await (await page.request.get(`/api/videos/${id}`)).json()).video as { title: string; aspect: string; captions: boolean; scenes: Array<{ script: string; layout?: { framing?: string } }> };
  expect(video.title).toBe("Our refund policy");
  expect(video.aspect).toBe("1:1");
  expect(video.captions).toBe(true);
  expect(video.scenes).toHaveLength(4);
  expect(video.scenes[0].layout?.framing).toBe("closeUp");
  expect((await page.request.post("/api/video-agent", { data: { prompt: "hi" } })).status()).toBe(400);
  await page.request.delete(`/api/videos/${id}?permanent=true`);
});

test("importing a script file makes one scene per section", async ({ page }) => {
  await page.locator("textarea").fill("A first draft.");
  const doc = ["# Welcome aboard", "", "Hi, I'm **Ava**.", "", "Glad you're here.", "---", "- Read the [handbook](https://example.com/h).", "## Wrap up", "See you Monday!"].join("\n");
  // Written scenes are only replaced once confirmed.
  page.once("dialog", (d) => d.dismiss());
  await page.getByLabel("Import a script file").setInputFiles({ name: "welcome.md", mimeType: "text/markdown", buffer: Buffer.from(doc) });
  await expect(page.locator("textarea")).toHaveValue("A first draft.");
  page.once("dialog", (d) => d.accept());
  await page.getByLabel("Import a script file").setInputFiles({ name: "welcome.md", mimeType: "text/markdown", buffer: Buffer.from(doc) });
  await expect(page.getByTestId("import-note")).toContainText("Imported 3 scenes from welcome.md.");
  await expect(page.locator("input[placeholder='Video title']")).toHaveValue("Welcome aboard");
  await expect(page.locator("textarea")).toHaveValue("Hi, I'm Ava.\n\nGlad you're here.");
  await page.getByRole("button", { name: /^Scene 3,/ }).click();
  await expect(page.locator("textarea")).toHaveValue("See you Monday!");
  // A file with no words changes nothing.
  await page.getByLabel("Import a script file").setInputFiles({ name: "empty.txt", mimeType: "text/plain", buffer: Buffer.from("\n---\n") });
  await expect(page.getByTestId("import-note")).toHaveText("No script found in empty.txt.");
  await expect(page.getByRole("button", { name: /^Scene 3,/ })).toBeVisible();
  // A plain-text file is read as written, and a document longer than a video holds keeps what fits and says so.
  const para = "Plain text keeps **stars** as typed. ".repeat(80).trim();
  page.once("dialog", (d) => d.accept());
  await page.getByLabel("Import a script file").setInputFiles({ name: "long.txt", mimeType: "text/plain", buffer: Buffer.from(`${para}\n\n${para}`) });
  await expect(page.getByTestId("import-note")).toContainText("the rest did not fit");
  await expect(page.locator("textarea")).toHaveValue(/^Plain text keeps \*\*stars\*\* as typed\./);
  await expect(page.getByTestId("script-too-long")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Generate video" })).toBeEnabled();
  // A Word document: its title names the video, each heading starts a scene, and its words are taken as written.
  const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const wp = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const word = zipSync({
    "word/document.xml": strToU8(`<w:document ${w}><w:body>${wp("Open house tour", "Title")}${wp("Welcome to *12 Elm*.")}${wp("Upstairs", "Heading1")}${wp("Three bedrooms.")}</w:body></w:document>`),
  });
  page.once("dialog", (d) => d.accept());
  await page.locator("input[placeholder='Video title']").fill("");
  await page.getByLabel("Import a script file").setInputFiles({ name: "tour.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from(word) });
  await expect(page.getByTestId("import-note")).toHaveText("Imported 2 scenes from tour.docx.");
  await expect(page.locator("input[placeholder='Video title']")).toHaveValue("Open house tour");
  await expect(page.locator("textarea")).toHaveValue("Welcome to *12 Elm*.");
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.locator("textarea")).toHaveValue("Three bedrooms.");
  // An old .doc says how to save it rather than importing nothing.
  await page.getByLabel("Import a script file").setInputFiles({ name: "old.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) });
  await expect(page.getByTestId("import-note")).toContainText("old.docx is password-protected or a Word 97–2003 file");
  // One picked under another name is known by its first bytes, not imported as noise.
  await page.getByLabel("Import a script file").setInputFiles({ name: "minutes.txt", mimeType: "text/plain", buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) });
  await expect(page.getByTestId("import-note")).toContainText("minutes.txt is password-protected or a Word 97–2003 file");
});

test("photo avatar motion is set in the editor, kept with the video and its copy", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill("Moving portrait");
  await page.locator("textarea").fill("Welcome to the open house.");
  await page.getByRole("button", { name: "Settings" }).click();
  const group = page.getByTestId("photo-motion");
  // A library presenter is not a photo avatar, so the panel says the settings wait for one (or, for gestures, for Avatar V).
  await expect(group).toContainText("For photo avatars (an uploaded portrait or a HeyGen photo avatar), and gestures also for video avatars on Avatar V;");
  await group.getByLabel("Expressiveness").selectOption("high");
  await group.getByLabel("Gestures (optional)").fill("  Nods warmly and   gestures toward the room ");
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate video" }).click();
  expect((await sent).postDataJSON()).toMatchObject({ expressiveness: "high", motionPrompt: "Nods warmly and   gestures toward the room" });
  await page.waitForURL(/\/videos\/vid_/);
  const id = page.url().split("/").pop()!;
  const video = (await (await page.request.get(`/api/videos/${id}`)).json()).video;
  expect([video.expressiveness, video.motionPrompt]).toEqual(["high", "Nods warmly and gestures toward the room"]);
  await expect(page.getByText("high expressiveness · “Nods warmly and gestures toward the room” (not applied by this renderer)")).toBeVisible();
  await page.goto(`/create?from=${id}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByTestId("photo-motion").getByLabel("Expressiveness")).toHaveValue("high");
  await expect(page.getByTestId("photo-motion").getByLabel("Gestures (optional)")).toHaveValue("Nods warmly and gestures toward the room");
  // Back to the default sends nothing.
  await page.getByTestId("photo-motion").getByLabel("Expressiveness").selectOption("low");
  await page.getByTestId("photo-motion").getByLabel("Gestures (optional)").fill("");
  const again = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate video" }).click();
  const body = (await again).postDataJSON() as Record<string, unknown>;
  expect("expressiveness" in body || "motionPrompt" in body).toBe(false);
});

test("a voice that speaks several accents can be given one, kept with the video and its copy", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill("Accented tour");
  await page.locator("textarea").fill("Welcome to the open house.");
  // Other tests may change the editor's first voice, so Emma is picked.
  await expect(page.getByText(/ · 16:9 · 1 scene · /)).not.toContainText("No voice");
  await page.getByRole("button", { name: "Voice", exact: true }).click();
  await page.getByRole("button", { name: /^Emma en-US/ }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  const accent = page.getByLabel("Accent", { exact: true });
  // Emma speaks English in several accents, so only English ones are offered.
  await expect(accent).toBeEnabled();
  await expect(accent.locator("option[value='en-GB']")).toHaveCount(1);
  await expect(accent.locator("option[value='es-MX']")).toHaveCount(0);
  await accent.selectOption("en-GB");
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate video" }).click();
  expect((await sent).postDataJSON()).toMatchObject({ accent: "en-GB" });
  await page.waitForURL(/\/videos\/vid_/);
  const id = page.url().split("/").pop()!;
  expect((await (await page.request.get(`/api/videos/${id}`)).json()).video.accent).toBe("en-GB");
  await expect(page.getByText("British English (en-GB) (not applied by this renderer)")).toBeVisible();
  await page.goto(`/create?from=${id}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Accent", { exact: true })).toHaveValue("en-GB");
  // James speaks one accent, so the copy's accent is kept on screen but not sent.
  await page.getByRole("button", { name: "Voice", exact: true }).click();
  await page.getByRole("button", { name: /^James en-US/ }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Accent", { exact: true }).locator("option:checked")).toHaveText("British English (en-GB), not sent: no voice here takes it");
  const again = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate video" }).click();
  expect("accent" in ((await again).postDataJSON() as Record<string, unknown>)).toBe(false);
  // With two voices that offer accents, each is offered its own, and a copy keeps an accent the second one takes.
  const bg = { type: "color", value: "#0f172a" };
  const two = await createVideoViaApi(page, "Two voices", { voiceId: "stock_voice_1", accent: "es-MX", script: undefined, scenes: [{ script: "Welcome in.", background: bg }, { script: "Bienvenidos.", background: bg, voiceId: "stock_voice_4" }] });
  await page.goto(`/create?from=${two.id}`);
  await page.getByRole("button", { name: "Settings" }).click();
  const both = page.getByLabel("Accent", { exact: true });
  await expect(both).toHaveValue("es-MX");
  await expect(both.locator("option:checked")).toHaveText("Mexican Spanish (es-MX)");
  await expect(both.locator("option[value='en-GB']")).toHaveCount(1);
  await expect(page.locator("#accent-hint")).toContainText("How Mateo pronounces the script");
  const kept = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate video" }).click();
  expect((await kept).postDataJSON()).toMatchObject({ accent: "es-MX" });
});

test("Avatar V is chosen for presenters whose look supports it, kept with the video and its copy", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill("Sharper tour");
  await page.locator("textarea").fill("Welcome to the open house.");
  await expect(page.getByText(/ · 16:9 · 1 scene · /)).not.toContainText("No voice");
  // Ava Chen's look supports Avatar V; Sofia Reyes's does not.
  await page.getByRole("button", { name: "Avatar", exact: true }).click();
  await page.getByRole("button", { name: "Ava Chen Ava Chen" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  const engine = page.getByLabel("Avatar engine", { exact: true });
  await expect(engine).toBeEnabled();
  // On Avatar IV, Ava's gestures wait for Avatar V, and the panel says so.
  await expect(page.locator("#photo-motion-hint")).toContainText("choose Avatar V above for gestures to reach this video's presenter");
  // More blinking is an Avatar V setting, offered once Avatar V is chosen.
  const blink = page.getByLabel("More blinking", { exact: true });
  await expect(blink).toBeDisabled();
  await expect(page.locator("#more-blinking-hint")).toContainText("choose Avatar V above to use it");
  await engine.selectOption("avatar_v");
  await blink.check();
  await expect(page.locator("#more-blinking-hint")).toContainText("Avatar V blinks more naturally");
  // Back on Avatar IV the box keeps its tick, can still be cleared, and says it is not sent.
  await engine.selectOption("avatar_iv");
  await expect(blink).toBeEnabled();
  await expect(page.locator("#more-blinking-hint")).toHaveText("Not sent on Avatar IV; kept for when you choose Avatar V above.");
  await engine.selectOption("avatar_v");
  // Ava is a video avatar, so on Avatar V she takes gestures too.
  await expect(page.locator("#photo-motion-hint")).toContainText("Gestures reach the video avatars rendering on Avatar V");
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate video" }).click();
  expect((await sent).postDataJSON()).toMatchObject({ avatarEngine: "avatar_v", moreBlinking: true });
  await page.waitForURL(/\/videos\/vid_/);
  const id = page.url().split("/").pop()!;
  const saved = (await (await page.request.get(`/api/videos/${id}`)).json()).video;
  expect([saved.avatarEngine, saved.moreBlinking]).toEqual(["avatar_v", true]);
  await expect(page.getByText("Avatar V, more blinking (not applied by this renderer)")).toBeVisible();
  await page.goto(`/create?from=${id}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Avatar engine", { exact: true })).toHaveValue("avatar_v");
  await expect(page.getByLabel("More blinking", { exact: true })).toBeChecked();
  // A batch started from a template on Avatar V says so, blinking included, and can go back to Avatar IV with neither sent.
  const engineTpl = await (await page.request.post("/api/templates", { data: { fromVideoId: id } })).json();
  await page.goto("/batch");
  await page.getByLabel("Start from a saved template").selectOption(engineTpl.template.id);
  await expect(page.getByTestId("batch-engine")).toContainText("Avatar V with more blinking, from the template: HeyGen's higher-quality engine, for this presenter's look.");
  await page.getByRole("button", { name: "Use Avatar IV" }).click();
  await expect(page.getByTestId("batch-engine")).toHaveCount(0);
  // The focus does not fall to the page with the button gone, and the change is announced.
  await expect(page.getByLabel("Start from a saved template")).toBeFocused();
  await expect(page.getByText("Each video now uses Avatar IV.")).toBeAttached();
  const batchSent = page.waitForRequest((r) => r.url().endsWith("/api/videos/batch") && r.method() === "POST");
  await page.getByRole("button", { name: /^Generate \d+ videos?$/ }).click();
  const batchBody = (await batchSent).postDataJSON() as Record<string, unknown>;
  expect(["avatarEngine" in batchBody, "moreBlinking" in batchBody]).toEqual([false, false]);
  await page.waitForURL(/\/videos\?batch=batch_/);
  expect((await page.request.delete(`/api/templates/${engineTpl.template.id}`)).ok()).toBe(true);
  await page.goto(`/create?from=${id}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Avatar", exact: true }).click();
  await page.getByRole("button", { name: "Sofia Reyes Sofia Reyes" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Avatar engine", { exact: true }).locator("option:checked")).toHaveText("Avatar V (not sent: no presenter here renders on it)");
  await expect(page.locator("#more-blinking-hint")).toHaveText("Not sent: no presenter in this video renders on Avatar V.");
  const again = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate video" }).click();
  const body = (await again).postDataJSON() as Record<string, unknown>;
  expect(["avatarEngine" in body, "moreBlinking" in body]).toEqual([false, false]);
});

test("a one-scene video can render over a transparent background, kept with the video and its copy", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill("Overlay");
  await page.locator("textarea").fill("Welcome to the open house.");
  await page.getByRole("button", { name: "Settings" }).click();
  const alpha = page.getByLabel("Transparent background", { exact: true });
  await expect(alpha).toBeEnabled();
  await alpha.check();
  // The stage previews the transparency instead of the scene background.
  await expect(page.getByTestId("stage")).toHaveAttribute("data-transparent", "");
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate video" }).click();
  expect((await sent).postDataJSON()).toMatchObject({ transparent: true });
  await page.waitForURL(/\/videos\/vid_/);
  const id = page.url().split("/").pop()!;
  expect((await (await page.request.get(`/api/videos/${id}`)).json()).video.transparent).toBe(true);
  await expect(page.getByText("Transparent (WebM, the presenter alone) (not applied by this renderer)")).toBeVisible();
  // A batch started from a transparent template says so, and can go back to the background.
  const tpl = await (await page.request.post("/api/templates", { data: { fromVideoId: id } })).json();
  await page.goto("/batch");
  await page.getByLabel("Start from a saved template").selectOption(tpl.template.id);
  await expect(page.getByTestId("batch-transparent")).toContainText("Transparent background, from the template");
  await page.getByRole("button", { name: "Use the background" }).click();
  await expect(page.getByTestId("batch-transparent")).toHaveCount(0);
  await page.goto(`/create?from=${id}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Transparent background", { exact: true })).toBeChecked();
  // A second scene cannot be transparent: the choice stays on screen but is not sent.
  await page.getByRole("button", { name: "Add scene" }).click();
  await page.locator("textarea").fill("And here is the kitchen.");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("#transparent-hint")).toContainText("this one has more than one scene");
  await expect(page.getByTestId("stage")).not.toHaveAttribute("data-transparent", "");
  const again = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate video" }).click();
  expect("transparent" in ((await again).postDataJSON() as Record<string, unknown>)).toBe(false);
});

test("a finished video can be cut into short clips, listed with the video until deleted", async ({ page }) => {
  // About 75 seconds long (the pauses count), so 30-second and 1-minute clips are offered and 3-minute ones are not.
  const v = await createVideoViaApi(page, `Clips ${Date.now().toString(36)}`, { script: `Welcome to the open house. ${"[pause 10s] ".repeat(7)}Thanks for watching.` });
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  await page.goto(`/videos/${v.id}`);
  const card = page.getByTestId("highlight-clips");
  await expect(card.getByRole("heading", { name: "Short clips" })).toBeVisible();
  await expect(card.getByLabel("3 minutes")).toHaveCount(0);
  await card.getByLabel("1 minute").check();
  await card.getByLabel("Framing").selectOption("1:1");
  await card.getByLabel("Burn in captions").uncheck();
  await card.getByLabel("What to look for (optional)").fill("the welcome");
  const sent = page.waitForRequest((r) => r.url().endsWith(`/api/videos/${v.id}/highlights`) && r.method() === "POST");
  await card.getByRole("button", { name: "Cut 2 clips" }).click();
  expect((await sent).postDataJSON()).toEqual({ lengths: ["30", "60"], frame: "1:1", captions: false, prompt: "the welcome" });
  await expect(card.getByText("30 seconds, 1 minute · 1:1 · no captions · “the welcome”")).toBeVisible();
  // The demo renderer finishes a few seconds later; the card checks again on its own.
  await expect(card.getByTestId("highlight-clip")).toHaveCount(2, { timeout: 20_000 });
  await expect(card.getByRole("link", { name: /^Download Demo highlight/ }).first()).toHaveAttribute("href", /\/demo\/render\.webm$/);
  await page.reload();
  await expect(page.getByTestId("highlight-clip")).toHaveCount(2);
  // Deleting asks first; declined, the set stays.
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: /^Delete these clips/ }).click();
  await expect(page.getByTestId("highlight-clip")).toHaveCount(2);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: /^Delete these clips/ }).click();
  await expect(page.getByTestId("highlight-clip")).toHaveCount(0);
  // Focus goes to the card rather than being lost with the button.
  await expect(page.getByRole("heading", { name: "Short clips" })).toBeFocused();
  expect((await (await page.request.get(`/api/videos/${v.id}/highlights`)).json()).highlights).toEqual([]);
});

test("a recording can be cleaned of filler words, from a link or the library, and deleted", async ({ page }) => {
  const v = await createVideoViaApi(page, `Cleanup source ${Date.now().toString(36)}`);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  await page.goto("/cleanup");
  await expect(page.getByRole("heading", { name: "Clean up a recording" })).toBeVisible();
  // A link must be a public https address; a private one is refused with the reason.
  await page.getByLabel("Recording URL").fill("https://127.0.0.1/webinar.mp4");
  await page.getByRole("button", { name: "Clean up recording" }).click();
  await expect(page.getByText("must point to a public host")).toBeVisible();
  // Focus stays on the button rather than dropping to the page.
  await expect(page.getByRole("button", { name: "Clean up recording" })).toBeFocused();
  // From the library: the video's title, marked cleaned. The link's error no longer applies.
  await page.getByLabel("One of my videos").check();
  await expect(page.getByText("must point to a public host")).toHaveCount(0);
  // The picker is named by its label and its hint ("Video A finished video of your library.").
  await page.getByRole("combobox", { name: /^Video\b/ }).selectOption(v.id);
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/cleanups") && r.method() === "POST");
  await page.getByRole("button", { name: "Clean up recording" }).click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({ videoId: v.id });
  // The start carries a key, so the same start sent again returns the same cleanup instead of paying for another.
  const key = request.headers()["idempotency-key"];
  expect(key).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  const again = await page.request.post("/api/cleanups", { data: { videoId: v.id }, headers: { "Idempotency-Key": key } });
  expect(again.status()).toBe(202);
  const item = page.getByTestId("cleanup").first();
  await expect(item).toContainText("(cleaned)");
  await expect(item).toContainText("From the library");
  // The demo renderer finishes a few seconds later; the page checks again on its own.
  await expect(item.getByTestId("cleanup-stats")).toContainText("7 filler cuts · 1m 04s → 59s (8.6% shorter)", { timeout: 20_000 });
  await expect(item.getByRole("link", { name: /^Download / })).toHaveAttribute("href", /\/demo\/render\.webm$/);
  const listed = (await (await page.request.get("/api/cleanups")).json()).cleanups as Array<Record<string, unknown>>;
  expect(Object.keys(listed[0])).not.toContain("providerJobId");
  expect(listed.filter((c) => c.videoId === v.id)).toHaveLength(1);
  expect((await again.json()).cleanup.id).toBe(listed[0].id);
  // Deleting asks first, then focus stays on the page.
  page.once("dialog", (d) => d.accept());
  await item.getByRole("button", { name: /^Delete / }).click();
  await expect(page.getByTestId("cleanup")).toHaveCount(listed.length - 1);
});

test("a video is lip-synced to an uploaded clip or a linked track, at the chosen quality, and deleted", async ({ page }) => {
  const v = await createVideoViaApi(page, `Lip sync source ${Date.now().toString(36)}`);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  await page.goto("/lipsync");
  await expect(page.getByRole("heading", { name: "Lip sync", exact: true })).toBeVisible();
  const start = page.getByRole("button", { name: "Lip-sync video" });
  // Nothing to start until both the footage and the new audio are chosen.
  await page.getByRole("combobox", { name: /^Library video\b/ }).selectOption(v.id);
  await expect(start).toBeDisabled();
  // An uploaded file is converted to WAV in the browser, saved as an audio clip, and chosen.
  await page.getByRole("button", { name: "Upload audio" }).focus();
  await page.getByLabel("Upload the new audio").setInputFiles({ name: "retake.wav", mimeType: "audio/wav", buffer: toneWav(2) });
  const clipPicker = page.getByRole("combobox", { name: /^Audio clip\b/ });
  await expect(clipPicker.locator("option:checked")).toHaveText("retake (2s)");
  // The button is busy, not disabled, while it uploads, so a keyboard user's focus stays on it.
  await expect(page.getByRole("button", { name: "Upload audio" })).toBeFocused();
  const clipId = await clipPicker.inputValue();
  await page.getByLabel(/^Precise/).check();
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/lipsyncs") && r.method() === "POST");
  await start.click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({ videoId: v.id, clipId, mode: "precision" });
  // The start carries a key, so the same start sent again returns the same lip sync instead of paying for another.
  const key = request.headers()["idempotency-key"];
  expect(key).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  const again = await page.request.post("/api/lipsyncs", { data: { videoId: v.id, clipId, mode: "precision" }, headers: { "Idempotency-Key": key } });
  expect(again.status()).toBe(202);
  const item = page.getByTestId("lipsync").first();
  await expect(item).toContainText("(lip-synced)");
  await expect(item.getByTestId("lipsync-meta")).toContainText("A library video · audio clip “retake” · Precise");
  // Focus goes to the new lip sync rather than being lost with the cleared form.
  await expect(item).toBeFocused();
  // The demo renderer finishes a few seconds later; the page checks again on its own.
  await expect(item.getByRole("link", { name: /^Download / })).toHaveAttribute("href", /\/demo\/render\.webm$/, { timeout: 20_000 });
  const listed = (await (await page.request.get("/api/lipsyncs")).json()).lipsyncs as Array<Record<string, unknown>>;
  expect(Object.keys(listed[0])).not.toContain("providerJobId");
  expect((await again.json()).lipsync.id).toBe(listed[0].id);
  // A linked track must be a public https address; a private one is refused with the reason, at the fast default.
  await page.getByLabel("A link").nth(1).check();
  await page.getByLabel("Audio URL").fill("https://127.0.0.1/voice-over.mp3");
  await page.getByRole("combobox", { name: /^Library video\b/ }).selectOption(v.id);
  const refused = page.waitForRequest((r) => r.url().endsWith("/api/lipsyncs") && r.method() === "POST");
  await page.getByLabel(/^Fast/).check();
  await start.click();
  expect((await refused).postDataJSON()).toEqual({ videoId: v.id, audioUrl: "https://127.0.0.1/voice-over.mp3", mode: "speed" });
  await expect(page.getByText("must point to a public host")).toBeVisible();
  await expect(page.getByTestId("lipsync")).toHaveCount(listed.length);
  // Deleting asks first.
  page.once("dialog", (d) => d.accept());
  await item.getByRole("button", { name: /^Delete / }).click();
  await expect(page.getByTestId("lipsync")).toHaveCount(listed.length - 1);
  // An MP3 is kept as it is, as the clip becomes the whole soundtrack; its length is read in the browser.
  await page.getByLabel("An audio clip").check();
  await page.getByLabel("Upload the new audio").setInputFiles("e2e/fixtures/voice-over.mp3");
  await expect(clipPicker.locator("option:checked")).toHaveText("voice-over (3s)");
  const mp3 = ((await (await page.request.get("/api/clips")).json()).clips as Array<{ id: string; name: string; mimeType: string; durationSec: number }>).find((c) => c.name === "voice-over")!;
  expect(mp3.mimeType).toBe("audio/mpeg");
  expect(mp3.durationSec).toBeGreaterThan(2.5);
  expect((await page.request.get(`/api/clips/${mp3.id}`)).headers()["content-type"]).toBe("audio/mpeg");
  expect((await page.request.delete(`/api/clips/${mp3.id}`)).status()).toBe(204);
  expect((await page.request.delete(`/api/clips/${clipId}`)).status()).toBe(204);
});

test("a catalog track found by describing it is mixed under a finished video, followed until ready, and deleted", async ({ page }) => {
  const v = await createVideoViaApi(page, `Music source ${Date.now().toString(36)}`);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  await page.goto("/music");
  await expect(page.getByRole("heading", { name: "Music", exact: true })).toBeVisible();
  const start = page.getByRole("button", { name: "Add music" });
  await page.getByRole("combobox", { name: /^Library video\b/ }).selectOption(v.id);
  // Nothing to add until a track is found and chosen.
  await expect(start).toBeDisabled();
  await page.getByLabel("Describe the music").fill("upbeat energetic");
  await page.getByRole("button", { name: "Search music" }).click();
  const tracks = page.getByTestId("music-tracks");
  // The best match is chosen and focused, and each track can be heard first.
  await expect(tracks.getByLabel("Bright steps", { exact: true })).toBeChecked();
  await expect(tracks.getByLabel("Bright steps", { exact: true })).toBeFocused();
  await expect(tracks.getByRole("radio")).toHaveCount(3);
  await expect(tracks.getByLabel("Hear Bright steps")).toHaveAttribute("src", /\/demo\/music-upbeat\.mp3$/);
  await page.getByLabel("Medium").check();
  // Sound effects are found by describing them too, and each placed at a moment of the video.
  await page.getByLabel("Describe a sound effect").fill("whoosh transition");
  await page.getByRole("button", { name: "Search sound effects" }).click();
  await expect(page.getByRole("button", { name: "Add Whoosh" })).toBeFocused();
  await expect(page.getByLabel("Hear Whoosh")).toHaveAttribute("src", /\/demo\/effect-whoosh\.mp3$/);
  await page.getByRole("button", { name: "Add Whoosh" }).click();
  const whoosh = page.getByRole("textbox", { name: "When Whoosh plays, in seconds from the start" });
  await expect(whoosh).toBeFocused();
  await whoosh.fill("1.5");
  await page.getByRole("button", { name: "Add Pop" }).click();
  const pop = page.getByRole("textbox", { name: "When Pop plays, in seconds from the start" });
  // A moment past the end of the video is caught before anything is sent.
  await pop.fill("999");
  await expect(page.getByTestId("music-effects")).toContainText("Pop (16:39.0) plays at or after the end of the video");
  await expect(pop).toHaveAttribute("aria-describedby", "effects-problem");
  // Not a number of seconds says so, and a decimal comma is read as a point.
  await pop.fill("soon");
  await expect(page.getByTestId("music-effects")).toContainText("Write when Pop plays as seconds from the start");
  await pop.fill("2,5");
  await expect(start).toBeEnabled();
  // Typed one key at a time, a partial number is left as it is, and an empty field asks for a moment.
  await pop.fill("");
  await expect(page.getByTestId("music-effects")).toContainText("Say when Pop plays");
  await expect(start).toBeDisabled();
  await pop.pressSequentially("2.");
  await expect(pop).toHaveValue("2.");
  await pop.press("Tab");
  await expect(pop).toHaveValue("2");
  await expect(start).toBeEnabled();
  // One taken out again leaves the focus on the one before it.
  await page.getByRole("button", { name: "Add Bright chime" }).click();
  await page.getByRole("button", { name: /^Remove Bright chime at / }).click();
  await expect(pop).toBeFocused();
  await expect(page.getByTestId("chosen-effects").getByRole("listitem")).toHaveCount(2);
  // The names stay readable, and nothing widens the page, on a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("chosen-effects").getByText("Whoosh", { exact: true })).toBeVisible();
  expect(await page.getByTestId("chosen-effects").getByText("Whoosh", { exact: true }).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await page.locator("main").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/music") && r.method() === "POST");
  await start.click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({
    videoId: v.id,
    trackId: "demo_music_upbeat",
    query: "upbeat energetic",
    volume: "medium",
    effects: [
      { trackId: "demo_effect_whoosh", query: "whoosh transition", atSec: 1.5 },
      { trackId: "demo_effect_pop", query: "whoosh transition", atSec: 2 },
    ],
  });
  await expect(page.getByTestId("chosen-effects")).toHaveCount(0);
  expect(request.headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  const item = page.getByTestId("mix").first();
  await expect(item).toBeFocused();
  await expect(item).toContainText("(with music)");
  await expect(item.getByTestId("mix-meta")).toContainText("“Bright steps” · Medium volume · 2 sound effects");
  // The demo renderer finishes a few seconds later; the page checks again on its own.
  await expect(item.getByRole("link", { name: /^Download / })).toHaveAttribute("href", /\/demo\/render\./, { timeout: 20_000 });
  const listed = (await (await page.request.get("/api/music")).json()).mixes as Array<Record<string, unknown>>;
  for (const key of ["provider", "providerJobId", "ownerId"]) expect(Object.keys(listed[0])).not.toContain(key);
  expect(listed[0].effects).toEqual([
    { trackId: "demo_effect_whoosh", name: "Whoosh", query: "whoosh transition", atSec: 1.5 },
    { trackId: "demo_effect_pop", name: "Pop", query: "whoosh transition", atSec: 2 },
  ]);
  // A suggestion searches at once.
  await page.getByRole("button", { name: "Cinematic and inspiring" }).click();
  await expect(tracks.getByLabel("Wide horizon", { exact: true })).toBeChecked();
  // Deleting asks first; the focus goes to the next video with music, or to the list's heading when none is left.
  page.once("dialog", (d) => d.accept());
  await item.getByRole("button", { name: /^Delete / }).click();
  await expect(page.getByTestId("mix")).toHaveCount(listed.length - 1);
  await expect(page.locator('[data-testid="mix"]:focus, h2:focus')).toHaveCount(1);
});

test("text is spoken in one of HeyGen's public voices, heard first, without the instant-only delivery", async ({ page }) => {
  const tag = Date.now().toString(36);
  await page.goto("/voice-changer");
  const speakingVoice = page.getByRole("combobox", { name: /^Speaking voice\b/ });
  await expect(speakingVoice.locator("optgroup[label='HeyGen voices'] option")).toHaveText(["Atlas · English", "Nadine · English"]);
  // Delivery set for an instant voice first, then a professional voice chosen: it speaks without Turbo or the boost.
  await speakingVoice.selectOption({ label: "Atlas · English" });
  const turbo = page.getByRole("checkbox", { name: /^Turbo/ });
  await turbo.check();
  const boost = page.getByRole("slider", { name: "Expressiveness boost" });
  await boost.focus();
  await page.keyboard.press("ArrowLeft");
  await speakingVoice.selectOption({ label: "Nadine · English" });
  // The voice can be heard first.
  await expect(page.getByLabel("Sample of the voice Nadine")).toHaveAttribute("src", /\/demo\/revoiced\.mp3$/);
  await expect(turbo).toBeDisabled();
  await expect(turbo).not.toBeChecked();
  await expect(page.getByRole("group", { name: "Delivery" })).toHaveAccessibleDescription(/Nadine is one of HeyGen's professional voices/);
  await page.getByRole("textbox", { name: /^Text\b/ }).fill(`Welcome to the team ${tag}.`);
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/voice-changer/speech") && r.method() === "POST");
  await page.getByRole("button", { name: "Speak the text" }).click();
  expect((await sent).postDataJSON()).toEqual({ voiceId: "pv_mockpv_nadine", text: `Welcome to the team ${tag}.` });
  const card = page.getByTestId("voice-change").filter({ hasText: tag });
  await expect(card).toContainText("in Nadine");
  // An instant one takes them again, as they were left.
  await speakingVoice.selectOption({ label: "Atlas · English" });
  await expect(turbo).toBeEnabled();
  await expect(turbo).toBeChecked();
  await expect(boost).toHaveValue("9");
  await expect(page.getByLabel("Sample of the voice Atlas")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await card.getByRole("button", { name: /^Delete / }).click();
  await expect(card).toHaveCount(0);
});

test("an instant voice is made from a recording with the speaker's agreement, and a recording is spoken again in it", async ({ page }) => {
  // A picture of the speaker's setting, from the account's uploaded pictures.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString("base64");
  const settingName = `Street ${Date.now().toString(36)}`;
  const setting = (await (await page.request.post("/api/backdrops", { data: { name: settingName, image: `data:image/png;base64,${png}` } })).json()).backdrop as { id: string };
  await page.goto("/voice-changer");
  await expect(page.getByRole("heading", { name: "Voice changer", exact: true })).toBeVisible();
  const make = page.getByRole("button", { name: "Make the voice" });
  const change = page.getByRole("button", { name: "Change the voice" });
  await expect(make).toBeDisabled();
  await expect(change).toBeDisabled();
  // A voice needs a name, a recording of it, and the speaker's agreement.
  const name = `Narrator ${Date.now().toString(36)}`;
  await page.getByLabel("Voice name").fill(name);
  await page.getByLabel("Upload a recording of the voice").setInputFiles("e2e/fixtures/voice-over.mp3");
  await expect(page.getByRole("combobox", { name: /^Recording of the voice\b/ }).locator("option:checked")).toHaveText("voice-over (3s)");
  await expect(make).toBeDisabled();
  await page.getByLabel(/agreed to have their voice cloned/).check();
  await page.getByRole("combobox", { name: /^Setting \(optional\)/ }).selectOption({ label: settingName });
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/voice-changer/voices") && r.method() === "POST");
  await make.click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({ name, clipId: expect.stringMatching(/^clip_/), agreed: true, settingPictureId: setting.id });
  expect(request.headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  const voiceRow = page.getByTestId("instant-voices").locator("li").filter({ hasText: name });
  await expect(voiceRow).toBeFocused();
  // The demo renderer makes it in a moment; the page checks again on its own.
  await expect(voiceRow).toContainText("Ready", { timeout: 20_000 });
  await expect(voiceRow).toContainText(`set in “${settingName}”`);
  // Ready, the voice can be heard first: HeyGen's preview, asked for on each listen (the demo's is the sample recording).
  const previewAsked = page.waitForResponse((r) => /\/api\/voice-changer\/voices\/iv_[^/]+\/preview$/.test(r.url()));
  const listenButton = voiceRow.getByRole("button", { name: `Listen to the voice ${name}` });
  await listenButton.click();
  expect((await previewAsked).headers()["cache-control"]).toContain("no-store");
  await expect(voiceRow.getByLabel(`Preview of the voice ${name}`)).toHaveAttribute("src", /\/demo\/revoiced\.mp3$/);
  // Listening again from the keyboard asks for a fresh link and keeps the focus on the button.
  const again = page.waitForResponse((r) => /\/api\/voice-changer\/voices\/iv_[^/]+\/preview$/.test(r.url()));
  await listenButton.focus();
  await page.keyboard.press("Enter");
  await again;
  await expect(listenButton).toBeFocused();
  await expect(voiceRow.getByLabel(`Preview of the voice ${name}`)).toHaveCount(1);
  expect((await page.request.get("/api/voice-changer/voices/iv_nope/preview")).status()).toBe(404);
  // The choice is cleared with the rest of the card, and the picture can go: the voice keeps its name.
  await expect(page.getByRole("combobox", { name: /^Setting \(optional\)/ })).toHaveValue("");
  expect((await page.request.delete(`/api/backdrops/${setting.id}`)).ok()).toBe(true);
  // A second voice of the same name is refused, with the reason in the card it was made from (an alert scoped to the
  // card: Next's route announcer is an alert too).
  const voiceCard = page.getByRole("heading", { name: "Make a voice", exact: true }).locator("..");
  const taken = `already have a voice named "${name.toUpperCase()}"`;
  await page.getByLabel("Voice name").fill(name.toUpperCase());
  await page.getByLabel(/agreed to have their voice cloned/).check();
  await make.click();
  await expect(voiceCard.getByRole("alert")).toContainText(taken);
  // A good upload in that card clears the old message.
  await page.getByLabel("Upload a recording of the voice").setInputFiles("e2e/fixtures/voice-over.mp3");
  await expect(page.getByRole("alert").filter({ hasText: taken })).toHaveCount(0);
  await page.getByLabel("Voice name").fill("");
  await page.getByLabel(/agreed to have their voice cloned/).uncheck();
  await page.getByRole("combobox", { name: /^Voice\b/ }).selectOption({ label: name });
  // A recording chosen and then deleted from the page is no longer chosen, and the focus stays on the choice.
  const changeCard = page.getByRole("heading", { name: "Change a recording's voice", exact: true }).locator("..");
  const recording = page.getByRole("combobox", { name: /^Recording\b(?! of)/ });
  await page.getByLabel("Upload the recording to change").setInputFiles("e2e/fixtures/voice-over.mp3");
  await expect(recording.locator("option:checked")).toHaveText("voice-over (3s)");
  page.once("dialog", (d) => d.accept());
  await changeCard.getByRole("button", { name: "Delete the audio clip voice-over" }).click();
  await expect(recording).toHaveValue("");
  await expect(recording).toBeFocused();
  await expect(change).toBeDisabled();
  await page.getByLabel("Upload the recording to change").setInputFiles("e2e/fixtures/voice-over.mp3");
  await page.getByLabel("Clean up background noise first").check();
  const spoken = page.waitForRequest((r) => r.url().endsWith("/api/voice-changer/changes") && r.method() === "POST");
  await change.click();
  expect((await spoken).postDataJSON()).toEqual({ voiceId: expect.stringMatching(/^iv_/), clipId: expect.stringMatching(/^clip_/), removeNoise: true });
  const card = page.getByTestId("voice-change").filter({ hasText: `voice-over in ${name}` });
  await expect(card).toBeFocused();
  await expect(card).toContainText(`voice-over in ${name}`);
  await expect(card.getByTestId("voice-change-meta")).toContainText(`In “${name}”`);
  await expect(card.getByTestId("voice-change-meta")).toContainText("noise removed");
  await expect(card.getByRole("link", { name: /^Download / })).toHaveAttribute("href", /\/demo\/revoiced\.mp3$/);
  const listed = (await (await page.request.get("/api/voice-changer")).json()) as { voices: Array<Record<string, unknown>>; changes: Array<Record<string, unknown>> };
  for (const key of ["provider", "providerVoiceId", "ownerId"]) expect(Object.keys(listed.voices[0])).not.toContain(key);
  expect(Object.keys(listed.changes[0])).not.toContain("providerAudio");
  // Text is spoken in the same voice, kept with the recordings, and marked as from text.
  const speak = page.getByRole("button", { name: "Speak the text" });
  await expect(speak).toBeDisabled();
  await page.getByRole("combobox", { name: /^Speaking voice\b/ }).selectOption({ label: name });
  await expect(speak).toBeDisabled();
  await page.getByRole("textbox", { name: /^Text\b/ }).fill("Welcome to the team.");
  const said = page.waitForRequest((r) => r.url().endsWith("/api/voice-changer/speech") && r.method() === "POST");
  await speak.click();
  const saidRequest = await said;
  expect(saidRequest.postDataJSON()).toEqual({ voiceId: expect.stringMatching(/^iv_/), text: "Welcome to the team." });
  expect(saidRequest.headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  const spokenCard = page.getByTestId("voice-change").filter({ hasText: `Welcome to the team in ${name}` });
  await expect(spokenCard).toBeFocused();
  await expect(spokenCard.getByTestId("voice-change-meta")).toContainText("from text");
  await expect(spokenCard.getByRole("link", { name: /^Download (?!captions )/ })).toHaveAttribute("href", /\/demo\/revoiced\.mp3$/);
  // Captions timed by when each word was said, as SRT or WebVTT; a recording spoken again has no words to time.
  const srt = spokenCard.getByRole("link", { name: /^Download captions for .* as SRT/ });
  const vtt = spokenCard.getByRole("link", { name: /^Download captions for .* as WebVTT/ });
  await expect(srt).toBeVisible();
  const srtFile = await page.request.get((await srt.getAttribute("href"))!);
  expect(srtFile.status()).toBe(200);
  expect(srtFile.headers()["content-disposition"]).toMatch(/^attachment; filename="Welcome_to_the_team_in_.+\.srt"$/);
  expect(await srtFile.text()).toBe("1\n00:00:00,000 --> 00:00:01,600\nWelcome to the team.\n");
  const vttFile = await page.request.get((await vtt.getAttribute("href"))!);
  expect(vttFile.headers()["content-type"]).toContain("text/vtt");
  expect(await vttFile.text()).toBe("WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.600\nWelcome to the team.\n");
  await expect(card).toBeVisible();
  await expect(card.getByText("Captions")).toHaveCount(0);
  const timedList = await (await page.request.get("/api/voice-changer")).json();
  const timedChange = timedList.changes.find((c: { text?: string }) => c.text === "Welcome to the team.");
  expect(timedChange.timed).toBe(true);
  expect(Object.keys(timedChange)).not.toContain("words");
  expect((await page.request.get(`/api/voice-changer/changes/${timedList.changes.find((c: { text?: string }) => c.text === undefined).id}/captions`)).status()).toBe(404);
  // Delivery: Turbo and an expressiveness boost, set from the keyboard, are sent and shown with the recording.
  const boost = page.getByRole("slider", { name: "Expressiveness boost" });
  await expect(boost).toHaveAttribute("aria-valuetext", "100 percent, the default");
  await page.getByRole("checkbox", { name: /^Turbo\b/ }).check();
  await boost.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
  await expect(boost).toHaveAttribute("aria-valuetext", "40 percent");
  await expect(page.locator("output[for='speech-boost']")).toHaveText("40%");
  await page.getByRole("textbox", { name: /^Title for the text\b/ }).fill("Lively welcome");
  const lively = page.waitForRequest((r) => r.url().endsWith("/api/voice-changer/speech") && r.method() === "POST");
  await speak.click();
  expect((await lively).postDataJSON()).toEqual({ voiceId: expect.stringMatching(/^iv_/), text: "Welcome to the team.", title: "Lively welcome", turbo: true, expressivenessBoost: 0.4 });
  const livelyCard = page.getByTestId("voice-change").filter({ hasText: "Lively welcome" });
  await expect(livelyCard.getByTestId("voice-change-meta")).toContainText("from text · Turbo · expressiveness boost 40%");
  await expect(spokenCard.getByTestId("voice-change-meta")).not.toContainText("Turbo");
  await expect(spokenCard.getByTestId("voice-change-meta")).not.toContainText("expressiveness");
  page.once("dialog", (d) => d.accept());
  await livelyCard.getByRole("button", { name: /^Delete / }).click();
  await expect(livelyCard).toHaveCount(0);
  await page.getByRole("checkbox", { name: /^Turbo\b/ }).uncheck();
  await boost.fill("10");
  await expect(boost).toHaveAttribute("aria-valuetext", "100 percent, the default");
  // The count is read with the field; a message stays in its own card when another card's choice changes.
  await expect(page.getByText("20 of 2,000 characters", { exact: true })).toBeVisible();
  const speechCard = page.getByRole("heading", { name: "Speak text in a voice", exact: true }).locator("..");
  const late = "HeyGen did not finish speaking the text in time; try again, or try a shorter text";
  await page.route("**/api/voice-changer/speech", (r) => r.fulfill({ status: 502, json: { error: late } }));
  await speak.click();
  await expect(speechCard.getByRole("alert")).toHaveText(late);
  await page.getByRole("combobox", { name: /^Voice\b/ }).selectOption({ index: 0 });
  await expect(speechCard.getByRole("alert")).toHaveText(late);
  await page.unroute("**/api/voice-changer/speech");
  // A voice gone meanwhile clears the choice, and the focus goes to it rather than with the button now disabled.
  const gone = "That voice is no longer available; choose another";
  await page.route("**/api/voice-changer/speech", (r) => r.fulfill({ status: 400, json: { error: gone } }));
  await speak.focus();
  await page.keyboard.press("Enter");
  await expect(speechCard.getByRole("alert")).toHaveText(gone);
  const speakingVoice = page.getByRole("combobox", { name: /^Speaking voice\b/ });
  await expect(speakingVoice).toHaveValue("");
  await expect(speakingVoice).toBeFocused();
  await page.unroute("**/api/voice-changer/speech");
  await page.getByRole("textbox", { name: /^Text\b/ }).press("End");
  await page.getByRole("textbox", { name: /^Text\b/ }).pressSequentially(" ");
  await expect(speechCard.getByRole("alert")).toHaveCount(0);
  const withText = (await (await page.request.get("/api/voice-changer")).json()) as { changes: Array<Record<string, unknown>> };
  const spokenRow = withText.changes.find((c) => c.text === "Welcome to the team.")!;
  // It can go straight onto a video: the lip sync page opens with it chosen as the new audio.
  const lipsyncLink = spokenCard.getByRole("link", { name: /^Lip-sync a video to Welcome to the team in / });
  await expect(lipsyncLink).toHaveAttribute("href", `/lipsync?voiceChange=${spokenRow.id}`);
  const lipsyncPage = await page.context().newPage();
  await lipsyncPage.goto(`/lipsync?voiceChange=${spokenRow.id}`);
  await expect(lipsyncPage.getByLabel("In one of my voices")).toBeChecked();
  await expect(lipsyncPage.getByRole("combobox", { name: /^Recording in your voice\b/ })).toHaveValue(String(spokenRow.id));
  await expect(lipsyncPage).toHaveURL(/\/lipsync$/);
  // One the page cannot offer (deleted, made up, too old) is not chosen, says so, and is never sent.
  await lipsyncPage.goto("/lipsync?voiceChange=vc_madeup123&keep=1");
  const voicePicker = lipsyncPage.getByRole("combobox", { name: /^Recording in your voice\b/ });
  await expect(lipsyncPage.locator("#voice-gone")).toHaveText(/^That recording is no longer available, or was made over an hour ago/);
  await expect(voicePicker).toHaveAccessibleDescription(/^That recording is no longer available/);
  await expect(lipsyncPage).toHaveURL(/\/lipsync\?keep=1$/);
  await expect(voicePicker).toHaveValue("");
  // With footage chosen, it is still the missing recording that holds the start back.
  await lipsyncPage.getByLabel("A link").first().check();
  await lipsyncPage.getByRole("textbox", { name: /^Video URL\b/ }).fill("https://example.com/a.mp4");
  await expect(lipsyncPage.getByRole("button", { name: "Lip-sync video" })).toBeDisabled();
  // Choosing a recording again takes the note away.
  await voicePicker.selectOption(String(spokenRow.id));
  await expect(lipsyncPage.locator("#voice-gone")).toHaveCount(0);
  await expect(lipsyncPage.getByRole("button", { name: "Lip-sync video" })).toBeEnabled();
  await lipsyncPage.close();
  for (const key of ["provider", "providerVoiceId", "providerAudio", "ownerId", "clipId"]) expect(Object.keys(spokenRow)).not.toContain(key);
  page.once("dialog", (d) => d.accept());
  await spokenCard.getByRole("button", { name: /^Delete / }).click();
  await expect(spokenCard).toHaveCount(0);
  // Deleting asks first; the recording spoken already stays when its voice is deleted.
  page.once("dialog", (d) => d.accept());
  await voiceRow.getByRole("button", { name: `Delete the voice ${name}` }).click();
  await expect(page.getByTestId("instant-voices").locator("li").filter({ hasText: name })).toHaveCount(0);
  await expect(page.getByTestId("voice-change").filter({ hasText: name })).toHaveCount(1);
  page.once("dialog", (d) => d.accept());
  await card.getByRole("button", { name: /^Delete / }).click();
  await expect(page.getByTestId("voice-change").filter({ hasText: name })).toHaveCount(0);
});

test("a cinematic shot is directed from a description with chosen presenters, kept in the library, and made again", async ({ page }) => {
  // A presenter of the account's own, newest first in the library, and three more whose names no other has.
  const tag = Date.now().toString(36);
  const svg = "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";
  const own = (await (await page.request.post("/api/avatars", { data: { name: `Shot ${tag}`, imageUrl: svg, gender: "neutral" } })).json()).avatar as { id: string; name: string };
  const all = (await (await page.request.get("/api/avatars")).json()).avatars as Array<{ id: string; name: string }>;
  const unique = all.filter((a) => all.filter((b) => b.name === a.name).length === 1);
  const avatars = [own, ...unique.filter((a) => a.id !== own.id).slice(0, 3)];
  await page.goto("/cinematic");
  await expect(page.getByRole("heading", { name: "Cinematic", exact: true })).toBeVisible();
  const start = page.getByRole("button", { name: "Make the shot" });
  const presenters = page.getByTestId("cinematic-presenters");
  // Nothing to direct until a presenter is chosen.
  await expect(start).toBeDisabled();
  await page.getByRole("button", { name: "Office walkthrough" }).click();
  await expect(page.getByLabel("Describe the shot")).toHaveValue(/sunlit open-plan office/);
  // At most three presenters: once three are ticked, the others cannot be.
  for (const a of avatars.slice(0, 3)) await presenters.getByRole("checkbox", { name: a.name, exact: true }).check();
  await expect(presenters.getByRole("checkbox", { name: avatars[3].name, exact: true })).toBeDisabled();
  await expect(page.getByText("3 chosen (the most a shot takes)")).toBeVisible();
  await presenters.getByRole("checkbox", { name: avatars[2].name, exact: true }).uncheck();
  await expect(presenters.getByRole("checkbox", { name: avatars[3].name, exact: true })).toBeEnabled();
  await page.getByRole("combobox", { name: "Shape" }).selectOption("9:16");
  await page.getByRole("combobox", { name: "Length" }).selectOption("6");
  await page.getByLabel("Title (optional)").fill("Office walk shot");
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/cinematic") && r.method() === "POST");
  await start.click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({
    prompt: expect.stringContaining("sunlit open-plan office"),
    avatarIds: [avatars[0].id, avatars[1].id],
    aspect: "9:16",
    resolution: "1080p",
    duration: 6,
    enhancePrompt: false,
    title: "Office walk shot",
  });
  expect(request.headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  // The shot is a library video: its page shows the description and the presenters, and offers no script tools.
  await expect(page).toHaveURL(/\/videos\/vid_/);
  await expect(page.getByRole("heading", { name: "Shot", exact: true })).toBeVisible();
  await expect(page.getByText(/sunlit open-plan office/)).toBeVisible();
  await expect(page.getByText(`${avatars[0].name}, ${avatars[1].name}`).first()).toBeVisible();
  await expect(page.getByText("6 seconds")).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit a copy" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save as template" })).toHaveCount(0);
  // The demo renderer finishes a few seconds later; a finished shot still has no captions to download.
  await expect(page.getByRole("link", { name: /^Download$/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("link", { name: "Captions (.srt)" })).toHaveCount(0);
  // Nor anything to dub: a shot has no script or voice.
  await expect(page.getByRole("link", { name: "Translate", exact: true })).toHaveCount(0);
  // "Make the shot again" fills the form with this shot.
  await page.getByRole("link", { name: "Make the shot again" }).click();
  await expect(page).toHaveURL(/\/cinematic\?from=vid_/);
  await expect(page.getByLabel("Describe the shot")).toHaveValue(/sunlit open-plan office/);
  await expect(presenters.getByRole("checkbox", { checked: true })).toHaveCount(2);
  await expect(page.getByRole("combobox", { name: "Shape" })).toHaveValue("9:16");
  await expect(page.getByRole("combobox", { name: "Length" })).toHaveValue("6");
  await expect(page.getByTestId("cinematic-notice")).toContainText("is filled in");
  // Shared, the shot has no transcript to read along with.
  const videoId = new URL(page.url()).searchParams.get("from")!;
  await page.goto(`/share/${videoId}`);
  await expect(page.locator("video")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Transcript" })).toHaveCount(0);
  // A presenter deleted since is left out when the shot is made again, and the page says so.
  expect((await page.request.delete(`/api/avatars/${own.id}`)).ok()).toBe(true);
  await page.goto(`/cinematic?from=${videoId}`);
  await expect(page.getByTestId("cinematic-notice")).toContainText(`${own.name} is no longer in your library and was left out`);
  await expect(presenters.getByRole("checkbox", { checked: true })).toHaveCount(1);
  await expect(start).toBeEnabled();
  // A video that is not a shot fills nothing in, and the page says so.
  const plain = await createVideoViaApi(page, `Not a shot ${tag}`);
  await page.goto(`/cinematic?from=${plain.id}`);
  await expect(page.getByTestId("cinematic-notice")).toContainText("is not a cinematic shot");
  await expect(page.getByLabel("Describe the shot")).toHaveValue("");
});

test("a photo avatar is dressed in a look pack, each look kept as a presenter of its own", async ({ page }) => {
  const tag = Date.now().toString(36);
  const name = `Looks ${tag}`;
  const svg = "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";
  const avatar = (await (await page.request.post("/api/avatars", { data: { name, imageUrl: svg, gender: "neutral" } })).json()).avatar as { id: string };
  await page.goto("/avatars");
  const open = page.getByRole("button", { name: `New looks of ${name}` });
  await open.click();
  const panel = page.getByTestId("look-pack-panel");
  await expect(panel.getByRole("heading", { name: `New looks of ${name}` })).toBeFocused();
  // A presenter whose gender is neutral needs the pack's women's or men's looks chosen first.
  await expect(panel.getByRole("button", { name: "Make new looks" })).toBeDisabled();
  await panel.getByLabel("Men's", { exact: true }).check();
  await panel.getByLabel(/^Healthcare/).check();
  await panel.getByLabel("Portrait 9:16").check();
  await expect(panel.getByText("cut from the middle of landscape ones")).toBeVisible();
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/look-packs") && r.method() === "POST");
  await panel.getByRole("button", { name: "Make new looks" }).click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({ avatarId: avatar.id, pack: "healthcare", gender: "male", aspect: "9:16" });
  expect(request.headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  // The pack is listed and focused; the demo renderer's five looks are ready at once and join the library.
  const pack = page.getByTestId("look-pack").filter({ hasText: `Healthcare looks of ${name}` });
  await expect(pack).toBeFocused();
  await expect(pack.getByTestId("look-pack-meta")).toContainText("5 of 5 ready · 9:16");
  await expect(pack.getByRole("img")).toHaveCount(5);
  await expect(page.getByTestId("avatar-library").getByText(`${name} · Healthcare 1`)).toBeVisible();
  const listed = (await (await page.request.get("/api/look-packs")).json()).lookPacks as Array<Record<string, unknown>>;
  const mine = listed.find((p) => p.avatarId === avatar.id)!;
  expect(Object.keys(mine)).not.toContain("lookIds");
  const made = (mine.looks as Array<{ avatarId: string }>).map((l) => l.avatarId);
  const all = (await (await page.request.get("/api/avatars")).json()).avatars as Array<{ id: string; name: string; gender?: string; source: string }>;
  expect(made.map((id) => all.find((a) => a.id === id))).toEqual([1, 2, 3, 4, 5].map((n) => expect.objectContaining({ name: `${name} · Healthcare ${n}`, gender: "male", source: "custom" })));
  // Forgetting the pack asks first and keeps its presenters.
  page.once("dialog", (d) => d.accept());
  await pack.getByRole("button", { name: `Forget the Healthcare looks of ${name}` }).click();
  await expect(pack).toHaveCount(0);
  // With no pack left the list goes, and focus moves to the page's own button rather than being lost.
  await expect(page.getByRole("button", { name: "New photo avatar" })).toBeFocused();
  await expect(page.getByTestId("avatar-library").getByText(`${name} · Healthcare 1`)).toBeVisible();
  for (const id of [avatar.id, ...made]) expect((await page.request.delete(`/api/avatars/${id}`)).status()).toBe(200);
});

test("a photo avatar is given a look described in words, with a picture of the clothes to go by", async ({ page }) => {
  const tag = Date.now().toString(36);
  const name = `Described ${tag}`;
  const svg = "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";
  const avatar = (await (await page.request.post("/api/avatars", { data: { name, imageUrl: svg, gender: "female" } })).json()).avatar as { id: string };
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.goto("/avatars");
  await page.getByRole("button", { name: `New looks of ${name}` }).click();
  const panel = page.getByTestId("look-pack-panel");
  await panel.getByLabel("A look you describe").check();
  const draw = panel.getByRole("button", { name: "Draw the look" });
  await expect(draw).toBeDisabled();
  await expect(draw).toHaveAccessibleDescription("Describe the outfit and setting in a few words first.");
  const prompt = "A camel coat over a black turtleneck, on a city street at dusk, warm light";
  await panel.getByLabel("Describe the look").fill(prompt);
  await expect(draw).toBeEnabled();
  // Escape asks before a typed description is thrown away; declining keeps it.
  const discard = new Promise<string>((resolve) =>
    page.once("dialog", (d) => {
      resolve(d.message());
      void d.dismiss();
    }),
  );
  await panel.getByLabel("Describe the look").press("Escape");
  expect(await discard).toBe("Discard this look? The description and pictures are not saved.");
  await expect(panel.getByLabel("Describe the look")).toHaveValue(prompt);
  // It asks after a switch to the packs too, as the description is kept for switching back.
  await panel.getByLabel("A pack of about five looks").check();
  const discardFromPack = new Promise<void>((resolve) =>
    page.once("dialog", (d) => {
      resolve();
      void d.dismiss();
    }),
  );
  await panel.getByLabel("A pack of about five looks").press("Escape");
  await discardFromPack;
  await expect(panel).toBeVisible();
  await panel.getByLabel("A look you describe").check();
  await expect(panel.getByLabel("Describe the look")).toHaveValue(prompt);
  // A file that only claims to be a picture is refused as it is added, not when the look is drawn.
  await panel.locator("#look-pictures").setInputFiles({ name: "fake.png", mimeType: "image/png", buffer: Buffer.from("not a picture at all") });
  await expect(panel.getByText("That file is not an image the browser can read")).toBeVisible();
  await expect(panel.getByRole("img")).toHaveCount(0);
  // Two pictures are added; the first is taken off again, and the focus stays on the pictures rather than being lost.
  await panel.locator("#look-pictures").setInputFiles([
    { name: "coat.png", mimeType: "image/png", buffer: pixel },
    { name: "street.png", mimeType: "image/png", buffer: pixel },
  ]);
  await expect(panel.getByRole("img")).toHaveCount(2);
  await panel.getByRole("button", { name: "Remove coat.png" }).click();
  await expect(panel.getByRole("img")).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Remove street.png" })).toBeFocused();
  // Filling the last places takes the add control away; the focus goes to the last picture rather than the page.
  await panel.getByLabel("Add pictures").setInputFiles([
    { name: "hat.png", mimeType: "image/png", buffer: pixel },
    { name: "shoes.png", mimeType: "image/png", buffer: pixel },
  ]);
  await expect(panel.getByRole("img")).toHaveCount(3);
  await expect(panel.getByLabel("Add pictures")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Remove shoes.png" })).toBeFocused();
  await expect(panel.getByRole("textbox", { name: "Describe the look", exact: true })).toHaveValue(prompt);
  await panel.getByLabel("Landscape 16:9").check();
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/look-packs") && r.method() === "POST");
  await draw.click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({ avatarId: avatar.id, pack: "described", prompt, aspect: "16:9", references: Array(3).fill(`data:image/png;base64,${pixel.toString("base64")}`) });
  // The look is listed with its description, and the demo renderer's look is ready at once and joins the library.
  const look = page.getByTestId("look-pack").filter({ hasText: `A described look of ${name}` });
  await expect(look).toBeFocused();
  await expect(look.getByTestId("look-prompt")).toHaveText(prompt);
  await expect(look.getByTestId("look-pack-meta")).toContainText("1 of 1 ready · 16:9 · 3 pictures");
  await expect(page.getByTestId("avatar-library").getByText(`${name} · A camel coat over a black…`)).toBeVisible();
  const listed = (await (await page.request.get("/api/look-packs")).json()).lookPacks as Array<Record<string, unknown>>;
  const mine = listed.find((p) => p.avatarId === avatar.id)!;
  expect(Object.keys(mine)).not.toContain("referenceDigest");
  const made = (mine.looks as Array<{ avatarId: string }>).map((l) => l.avatarId);
  // Forgetting it asks first and keeps its presenter.
  const asked = new Promise<string>((resolve) =>
    page.once("dialog", (d) => {
      resolve(d.message());
      void d.accept();
    }),
  );
  await look.getByRole("button", { name: `Forget the described look of ${name}` }).click();
  expect(await asked).toBe(`Forget the described look of “${name}”? The photo avatar made of it stays.`);
  await expect(look).toHaveCount(0);
  await expect(page.getByTestId("avatar-library").getByText(`${name} · A camel coat over a black…`)).toBeVisible();
  for (const id of [avatar.id, ...made]) expect((await page.request.delete(`/api/avatars/${id}`)).status()).toBe(200);
});

test("a b-roll clip features pictures the description names as <Picture 1>, <Picture 2>", async ({ page }) => {
  const tag = Date.now().toString(36);
  await page.goto("/footage");
  const prompt = page.getByRole("textbox", { name: "Describe the shot", exact: true });
  await prompt.fill(`A runner ${tag} laces up the shoe in`);
  const make = page.getByRole("button", { name: "Make the clip" });
  // A label with no picture featured names nothing, so it holds the start.
  await prompt.fill(`A runner ${tag} laces up the shoe in <Picture 1>`);
  await expect(make).toHaveAccessibleDescription("The description names <Picture 1>, but no picture is featured: choose Feature my pictures, or take the labels out.");
  await expect(make).toBeDisabled();
  await prompt.fill(`A runner ${tag} laces up the shoe in`);
  // A mode that needs a picture says so until it has one.
  await page.getByLabel("Open on a picture").check();
  await expect(make).toBeDisabled();
  await expect(make).toHaveAccessibleDescription("Add the picture to open on, or choose No pictures.");
  await page.getByLabel("Feature my pictures").check();
  await expect(page.locator("#footage-use-hint")).toContainText("Name them in the description as <Picture 1>, <Picture 2>, in this order.");
  // Each choice is named by its label alone and described by its own hint.
  await expect(page.getByLabel("Feature my pictures", { exact: true })).toHaveAccessibleDescription(/Up to 3 pictures of a product, a place, or a person/);
  await expect(page.getByLabel("No pictures", { exact: true })).toHaveAccessibleDescription("The shot is made from the description alone.");
  await expect(make).toBeDisabled();
  await expect(make).toHaveAccessibleDescription("Add a picture to feature, or choose No pictures.");
  const file = page.locator('input[type="file"][accept="image/*"]');
  await file.setInputFiles({ name: "shoe.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG, "base64") });
  await expect(page.getByTestId("footage-feature")).toHaveCount(1);
  // The label goes into the description where it is needed.
  await page.getByRole("button", { name: "Put in the description: <Picture 1>" }).click();
  await expect(prompt).toHaveValue(`A runner ${tag} laces up the shoe in <Picture 1>`);
  await expect(prompt).toBeFocused();
  await prompt.press("Control+End");
  await prompt.pressSequentially(" on the track in ");
  await file.setInputFiles({ name: "track.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG, "base64") });
  await page.getByRole("button", { name: "Put in the description: <Picture 2>" }).click();
  await expect(prompt).toHaveValue(`A runner ${tag} laces up the shoe in <Picture 1> on the track in <Picture 2>`);
  await expect(page.getByText("2 of 3 pictures")).toBeVisible();
  // A label goes where the cursor was, although pressing its button takes the focus, and typing carries on after it.
  const value = await prompt.inputValue();
  const at = value.indexOf(" laces");
  await prompt.evaluate((el: HTMLTextAreaElement, i: number) => el.setSelectionRange(i, i), at);
  await prompt.press("ArrowRight");
  await prompt.press("ArrowLeft");
  await page.getByRole("button", { name: "Put in the description: <Picture 2>" }).click();
  await page.keyboard.type(" and");
  await expect(prompt).toHaveValue(`A runner ${tag} <Picture 2> and laces up the shoe in <Picture 1> on the track in <Picture 2>`);
  // A label that names no picture added holds the start, with the reason.
  await prompt.press("Control+End");
  await prompt.pressSequentially(" past <Picture 3>");
  await expect(make).toBeDisabled();
  await expect(make).toHaveAccessibleDescription("The description names <Picture 3>, but 2 pictures are added.");
  // Removing a picture takes its label out and renumbers the ones after it, as the pictures are.
  await page.getByRole("button", { name: "Remove Picture 1, shoe.png" }).click();
  await expect(page.locator('p[role="status"]')).toHaveText("Picture 1 removed. Its label is taken out of the description. Later labels are numbered one lower.");
  await expect(prompt).toHaveValue(`A runner ${tag} <Picture 1> and laces up the shoe in on the track in <Picture 1> past <Picture 2>`);
  await expect(page.getByRole("img", { name: "Picture 1: track.png" })).toBeVisible();
  await prompt.fill(`A runner ${tag} laces up the shoe in <Picture 1> on the track in <Picture 2>`);
  await file.setInputFiles({ name: "track.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG, "base64") });
  await expect(make).toBeEnabled();
  // The clip can take the first picture's shape, at standard quality only.
  await page.getByLabel("Like Picture 1").check();
  await expect(page.getByLabel("HD (1080p)")).toBeDisabled();
  await expect(page.getByText("a clip shaped like Picture 1 is standard")).toBeVisible();
  // A third picture fills the list: the add control goes and the focus lands on that picture's remove button.
  await file.setInputFiles({ name: "extra.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG, "base64") });
  await expect(page.getByRole("button", { name: "Remove Picture 3, extra.png" })).toBeFocused();
  await expect(file).toHaveCount(0);
  await page.getByRole("button", { name: "Remove Picture 3, extra.png" }).click();
  await expect(file).toBeFocused();
  // A label never pushes text out at the length limit: the description stays as it is and the reason is given.
  const kept = await prompt.inputValue();
  await prompt.fill(`${"x".repeat(1995)} end.`);
  await prompt.focus();
  await page.getByRole("button", { name: "Put in the description: <Picture 1>" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "No room for" })).toHaveText("No room for <Picture 1>: the description is at most 2000 characters. Shorten it first.");
  await expect(prompt).toHaveValue(`${"x".repeat(1995)} end.`);
  await prompt.fill(kept);
  await page.getByLabel("Portrait 9:16").check();
  await page.getByLabel("HD (1080p)").check();
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/footage") && r.method() === "POST");
  await make.click();
  const body = (await sent).postDataJSON() as { references: string[]; aspect: string; quality: string; image?: string };
  expect([body.references.length, body.aspect, body.quality, body.image]).toEqual([2, "9:16", "hd", undefined]);
  expect(body.references.every((r) => r.startsWith("data:image/png;base64,"))).toBe(true);
  const item = page.getByTestId("footage").filter({ hasText: tag });
  await expect(item.getByTestId("footage-meta")).toContainText("5 s · features 2 pictures · 9:16 · HD");
  const first = (await item.getAttribute("data-footage"))!;
  // A clip shaped like its first picture says so; the pictures themselves are not kept.
  const shaped = (await (await page.request.post("/api/footage", { data: { prompt: `A shelf ${tag} with the jar in <Picture 1>`, references: [`data:image/png;base64,${TINY_PNG}`] } })).json()).footage as { id: string; aspect?: string; references: number };
  expect([shaped.references, shaped.aspect]).toEqual([1, undefined]);
  await page.reload();
  await expect(page.getByTestId("footage").filter({ hasText: `A shelf ${tag}` }).getByTestId("footage-meta")).toContainText("features a picture · shaped like Picture 1");
  expect(JSON.stringify((await (await page.request.get("/api/footage")).json()).footage)).not.toContain(TINY_PNG);
  // Made again, it asks for its picture back and would take its shape again, unless HD is chosen meanwhile: that
  // choice holds (HD is landscape or portrait), and the frame stays landscape.
  const shapedItem = page.getByTestId("footage").filter({ hasText: `A shelf ${tag}` });
  await expect(shapedItem.getByText("Completed")).toBeVisible({ timeout: 20_000 });
  await shapedItem.getByRole("button", { name: /^Make again with changes: / }).click();
  await expect(page.getByLabel("Feature my pictures")).toBeChecked();
  await page.getByLabel("HD (1080p)").check();
  await file.setInputFiles({ name: "jar.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG, "base64") });
  await expect(page.getByRole("img", { name: "Picture 1: jar.png" })).toBeVisible();
  await expect(page.getByLabel("HD (1080p)")).toBeChecked();
  await expect(page.getByLabel("Landscape 16:9")).toBeChecked();
  await expect(page.getByLabel("Like Picture 1")).not.toBeChecked();
  for (const id of [shaped.id, first]) expect((await page.request.delete(`/api/footage/${id}`)).ok()).toBe(true);
});

test("a b-roll take is made again with changes, from its seed, longer or word for word", async ({ page }) => {
  const tag = Date.now().toString(36);
  await page.goto("/footage");
  const prompt = page.getByRole("textbox", { name: "Describe the shot", exact: true });
  await prompt.fill(`A slow dolly past a bakery window ${tag} at dawn, steam on the glass`);
  // Up to 30 seconds from a description; 15 when it is followed exactly, and the length follows with a word why.
  const length = page.getByRole("slider", { name: /Length/ });
  await expect(length).toHaveAttribute("max", "30");
  await length.focus();
  await page.keyboard.press("End");
  await expect(page.getByLabel("Length: 30 seconds")).toBeVisible();
  const exact = page.getByLabel("Follow my description exactly");
  await expect(exact).toHaveAccessibleDescription(/sends yours word for word/);
  await exact.check();
  await expect(length).toHaveAttribute("max", "15");
  await expect(page.getByLabel("Length: 15 seconds")).toBeVisible();
  await expect(page.locator('p[role="status"]')).toHaveText("The length is now 15 seconds, the longest for a clip that features pictures or follows the description exactly.");
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/footage") && r.method() === "POST");
  await page.getByRole("button", { name: "Make the clip" }).click();
  expect((await sent).postDataJSON()).toMatchObject({ durationSec: 15, exact: true });
  const first = page.getByTestId("footage").filter({ hasText: `bakery window ${tag}` });
  await expect(first.getByTestId("footage-meta")).toContainText("15 s · 16:9 · as written · standard");
  // Once made, the take can be made again: the form takes its description and settings, and its seed.
  await expect(first.getByText("Completed")).toBeVisible({ timeout: 20_000 });
  const firstId = (await first.getAttribute("data-footage"))!;
  const listed = ((await (await page.request.get("/api/footage")).json()).footage as Array<{ id: string; takeSeed?: number }>).find((f) => f.id === firstId)!;
  expect(typeof listed.takeSeed).toBe("number");
  await exact.uncheck();
  await first.getByRole("button", { name: /^Make again with changes: / }).click();
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue(`A slow dolly past a bakery window ${tag} at dawn, steam on the glass`);
  await expect(exact).toBeChecked();
  await expect(page.getByLabel("Length: 15 seconds")).toBeVisible();
  await expect(page.getByTestId("footage-take")).toContainText(`(seed ${listed.takeSeed}): only what you change differs.`);
  await prompt.fill(`A slow dolly past a bakery window ${tag} at dusk, steam on the glass`);
  const again = page.waitForRequest((r) => r.url().endsWith("/api/footage") && r.method() === "POST");
  await page.getByRole("button", { name: "Make the clip" }).click();
  expect((await again).postDataJSON()).toMatchObject({ prompt: `A slow dolly past a bakery window ${tag} at dusk, steam on the glass`, durationSec: 15, exact: true, seed: listed.takeSeed });
  await expect(page.getByTestId("footage-take")).toHaveCount(0);
  const second = page.getByTestId("footage").filter({ hasText: `at dusk` }).filter({ hasText: tag });
  await expect(second).toHaveCount(1);
  // A take dropped goes back to HeyGen choosing the seed, and the focus goes back to the description.
  await first.getByRole("button", { name: /^Make again with changes: / }).click();
  await page.getByRole("button", { name: "Use a new take" }).click();
  await expect(page.getByTestId("footage-take")).toHaveCount(0);
  await expect(prompt).toBeFocused();
  // Without exact wording the clip runs to 30 seconds, sent with no seed.
  await exact.uncheck();
  await expect(length).toHaveAttribute("max", "30");
  await length.focus();
  await page.keyboard.press("End");
  await expect(page.getByLabel("Length: 30 seconds")).toBeVisible();
  // A limit that changes while the slider has the focus (a picture that lands, say) leaves the focus on it, in step.
  await exact.evaluate((el: HTMLInputElement) => el.click());
  await expect(page.getByLabel("Length: 15 seconds")).toBeVisible();
  await expect(length).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByLabel("Length: 14 seconds")).toBeVisible();
  await exact.evaluate((el: HTMLInputElement) => el.click());
  await expect(length).toHaveAttribute("max", "30");
  await expect(length).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByLabel("Length: 30 seconds")).toBeVisible();
  await prompt.fill(`A long dolly past a bakery window ${tag} from dawn to noon`);
  const long = page.waitForRequest((r) => r.url().endsWith("/api/footage") && r.method() === "POST");
  await page.getByRole("button", { name: "Make the clip" }).click();
  const longBody = (await long).postDataJSON() as Record<string, unknown>;
  expect([longBody.durationSec, "seed" in longBody, "exact" in longBody]).toEqual([30, false, false]);
  const third = page.getByTestId("footage").filter({ hasText: `long dolly past a bakery window ${tag}` });
  await expect(third.getByTestId("footage-meta")).toContainText("30 s · 16:9 · standard");
  for (const id of [firstId, (await second.getAttribute("data-footage"))!, (await third.getAttribute("data-footage"))!]) expect((await page.request.delete(`/api/footage/${id}`)).ok()).toBe(true);
});

test("a b-roll clip can leave its length to HeyGen, and is made again at the length it picked", async ({ page }) => {
  const tag = Date.now().toString(36);
  await page.goto("/footage");
  const prompt = page.getByRole("textbox", { name: "Describe the shot", exact: true });
  await prompt.fill(`A baker ${tag} turns to the camera and says "Fresh bread every morning, since 1982."`);
  const length = page.getByRole("slider", { name: /Length/ });
  const auto = page.getByLabel("Let HeyGen pick the length");
  await expect(auto).not.toBeChecked();
  await expect(auto).toHaveAccessibleDescription(/8 to 30 seconds, fitted to any lines the description quotes/);
  await auto.check();
  // The slider gives way, and its limit still follows the clip's settings.
  await expect(length).toBeDisabled();
  await expect(page.getByLabel("Length: picked by HeyGen")).toBeVisible();
  const exact = page.getByLabel("Follow my description exactly");
  await exact.check();
  await expect(auto).toHaveAccessibleDescription(/^8 to 15 seconds/);
  await exact.uncheck();
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/footage") && r.method() === "POST");
  await page.getByRole("button", { name: "Make the clip" }).click();
  const body = (await sent).postDataJSON() as Record<string, unknown>;
  expect([body.autoLength, "durationSec" in body]).toEqual([true, false]);
  const item = page.getByTestId("footage").filter({ hasText: `A baker ${tag}` });
  await expect(item.getByTestId("footage-meta")).toContainText("length picked by HeyGen · 16:9 · standard");
  // Once made, the clip names the length HeyGen picked (the demo picks 10 seconds).
  await expect(item.getByText("Completed")).toBeVisible({ timeout: 20_000 });
  await expect(item.getByTestId("footage-meta")).toContainText("10 s, picked by HeyGen · 16:9");
  // Made again, the take asks for that length, so it comes out the same.
  await item.getByRole("button", { name: /^Make again with changes: / }).click();
  await expect(auto).not.toBeChecked();
  await expect(length).toBeEnabled();
  await expect(page.getByLabel("Length: 10 seconds")).toBeVisible();
  await expect(page.locator('p[role="status"]')).toContainText("The length HeyGen picked, 10 seconds, is now set; tick “Let HeyGen pick the length” for it to pick again");
  expect((await page.request.delete(`/api/footage/${await item.getAttribute("data-footage")}`)).ok()).toBe(true);
});

test("a b-roll clip is made from a description and loops behind a presenter as a scene's background", async ({ page }) => {
  const tag = Date.now().toString(36);
  await page.goto("/footage");
  const make = page.getByRole("button", { name: "Make the clip" });
  await expect(make).toBeDisabled();
  await expect(make).toHaveAccessibleDescription("Describe the shot in a few words first.");
  const prompt = `A slow push-in on a sunlit kitchen ${tag}; steam rises from a coffee cup`;
  await page.getByRole("textbox", { name: "Describe the shot", exact: true }).fill(prompt);
  const length = page.getByLabel("Length: 5 seconds");
  await length.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Length: 8 seconds")).toBeFocused();
  await page.getByLabel("Portrait 9:16").check();
  // A square clip cannot be HD; the choice says why.
  await page.getByLabel("HD (1080p)").check();
  await page.getByLabel("Square 1:1").check();
  await expect(page.getByLabel("HD (1080p)")).toBeDisabled();
  await expect(page.getByText("HD clips are landscape or portrait, not square.")).toBeVisible();
  // HD chosen for a picture does not come back once the picture is removed on a square frame.
  await page.getByLabel("Open on a picture").check();
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({ name: "frame.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG, "base64") });
  await page.getByLabel("HD (1080p)").check();
  await page.getByRole("button", { name: "Remove frame.png" }).click();
  await expect(page.getByLabel("Standard (768p)")).toBeChecked();
  await page.getByLabel("No pictures").check();
  await page.getByLabel("Landscape 16:9").check();
  await expect(page.getByLabel("Standard (768p)")).toBeChecked();
  await page.getByLabel("Square 1:1").check();
  // Square moves the choice to standard, and it stays standard when the frame changes back (HD costs three times as much).
  await page.getByLabel("Portrait 9:16").check();
  await expect(page.getByLabel("Standard (768p)")).toBeChecked();
  await page.getByLabel("HD (1080p)").check();
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/footage") && r.method() === "POST");
  await make.click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({ prompt, durationSec: 8, aspect: "9:16", quality: "hd" });
  const key = request.headers()["idempotency-key"];
  expect(key).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  const item = page.getByTestId("footage").filter({ hasText: tag });
  await expect(item).toBeFocused();
  await expect(item.getByTestId("footage-meta")).toContainText("8 s · 9:16 · HD");
  // The same start sent again returns the same clip instead of paying for another.
  const again = (await (await page.request.post("/api/footage", { data: { prompt, durationSec: 8, aspect: "9:16", quality: "hd" }, headers: { "Idempotency-Key": key } })).json()).footage as { id: string };
  const id = (await item.getAttribute("data-footage"))!;
  expect(again.id).toBe(id);
  // The demo clip is ready a few seconds later, to watch and download.
  await expect(item.getByText("Completed")).toBeVisible({ timeout: 20_000 });
  await expect(item.locator("video")).toBeVisible();
  const listed = ((await (await page.request.get("/api/footage")).json()).footage as Array<Record<string, unknown>>).find((f) => f.id === id)!;
  expect(Object.keys(listed)).not.toContain("providerJobId");
  // In the editor the clip is offered as a scene's video background and previewed on the stage.
  await page.goto("/create");
  await page.getByRole("button", { name: "Background" }).click();
  await expect(page.getByRole("button", { name: "Background", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("combobox", { name: "Generated clip", exact: true }).selectOption(id);
  await expect(page.getByTestId("stage-video")).toHaveAttribute("src", `/api/footage/${id}/clip`);
  const clip = await page.request.get(`/api/footage/${id}/clip`, { maxRedirects: 0 });
  expect(clip.status()).toBe(302);
  expect(clip.headers()["location"]).toContain("/demo/");
  // A video looping it renders, and keeps the clip's fixed address as its background.
  const video = await createVideoViaApi(page, `B-roll ${tag}`, { background: { type: "video", value: `/api/footage/${id}/clip` } });
  const stored = (await (await page.request.get(`/api/videos/${video.id}`)).json()).video as { background: unknown };
  expect(stored.background).toEqual({ type: "video", value: `/api/footage/${id}/clip` });
  // The brand kit can loop it behind every new video too (the kit is put back afterwards: later tests expect the plain defaults).
  const before = (await (await page.request.get("/api/brand")).json()).brand as Record<string, unknown> | null;
  try {
    await page.goto("/brand");
    await page.getByLabel("Default background", { exact: true }).selectOption("clip");
    await page.getByRole("combobox", { name: "Generated clip", exact: true }).selectOption(id);
    await page.getByRole("button", { name: "Save brand kit" }).click();
    await expect.poll(async () => ((await (await page.request.get("/api/brand")).json()).brand as { defaultBackground?: unknown } | null)?.defaultBackground).toEqual({ type: "video", value: `/api/footage/${id}/clip` });
    // A clip deleted since can no longer be looped, and a render naming it is refused with a reason.
    await page.goto("/footage");
    page.once("dialog", (d) => d.accept());
    await page.getByTestId("footage").filter({ hasText: tag }).getByRole("button", { name: /^Delete / }).click();
    await expect(page.getByTestId("footage").filter({ hasText: tag })).toHaveCount(0);
    expect(((await (await page.request.get("/api/brand")).json()).brand as { defaultBackground?: unknown }).defaultBackground, "the kit lets go of the deleted clip").toBeUndefined();
  } finally {
    const restored = before ? await page.request.put("/api/brand", { data: before }) : await page.request.delete("/api/brand");
    expect(restored.ok()).toBe(true);
  }
  expect((await page.request.get(`/api/footage/${id}/clip`)).status()).toBe(404);
  expect((await page.request.get("/api/footage/not-a-clip/clip")).status(), "a malformed id reads as not found too").toBe(404);
  const refused = await page.request.post("/api/videos", { data: { title: "Gone clip", avatarId: "stock_1", voiceId: "stock_voice_1", script: "Hello there.", background: { type: "video", value: `/api/footage/${id}/clip` } } });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error).toContain("generated clip that was deleted");
});

test("a digital twin is trained from footage, waits for the person's consent, then is a presenter", async ({ page }) => {
  const name = `Twin ${Date.now().toString(36)}`;
  await page.goto("/avatars");
  const section = page.getByTestId("digital-twins");
  await section.getByRole("button", { name: "New digital twin" }).click();
  const panel = page.getByTestId("twin-panel");
  await expect(panel.getByRole("heading", { name: "New digital twin" })).toBeFocused();
  await panel.getByLabel("Name").fill(name);
  await panel.getByRole("textbox", { name: /^Footage URL/ }).fill("https://93.184.216.34/footage.mp4");
  // Training needs the account's word that the person agreed, besides the consent they record themselves.
  const train = panel.getByRole("button", { name: "Train the twin" });
  await expect(train).toBeDisabled();
  await panel.getByLabel(/agreed to be made into a digital twin/).check();
  await panel.getByLabel("Female").check();
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/twins") && r.method() === "POST");
  await train.click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({ name, footageUrl: "https://93.184.216.34/footage.mp4", gender: "female", agreed: true });
  expect(request.headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  const twin = page.getByTestId("twin").filter({ hasText: name });
  await expect(twin).toBeFocused();
  // The demo renderer trains at once; the twin is not a presenter until the person consents.
  await expect(twin.getByTestId("twin-step")).toContainText("consent not asked for yet");
  await expect(page.getByTestId("avatar-library").getByText(name, { exact: true })).toHaveCount(0);
  await twin.getByRole("button", { name: "Get the consent link" }).click();
  const link = twin.getByRole("textbox", { name: `Consent link for ${name}` });
  await expect(link).toBeFocused();
  await expect(link).toHaveValue(/\/demo-consent$/);
  await expect(twin.getByTestId("twin-step")).toContainText("waiting for the person's consent");
  // The page checks again on its own; the demo counts consent as given a few seconds after the link was made.
  await expect(twin.getByTestId("twin-step")).toContainText("Ready: it is in your avatars", { timeout: 30_000 });
  // The consent row went with the wait; the keyboard is taken to the twin rather than dropped on the page.
  await expect(twin).toBeFocused();
  await expect(page.getByTestId("avatar-library").getByText(name, { exact: true })).toBeVisible();
  const listed = (await (await page.request.get("/api/twins")).json()).twins as Array<Record<string, unknown>>;
  const mine = listed.find((t) => t.name === name)!;
  for (const key of ["lookId", "groupId", "voiceId"]) expect(Object.keys(mine)).not.toContain(key);
  // The voice cloned from the footage is the account's own, and the presenter opens the editor with it.
  const voices = (await (await page.request.get("/api/voices")).json()).voices as Array<{ id: string; name: string; source?: string }>;
  const voice = voices.find((v) => v.name === `${name} (twin)`)!;
  expect(voice.source).toBe("custom");
  const presenter = (await (await page.request.get("/api/avatars")).json()).avatars.find((a: { id: string }) => a.id === mine.avatarId);
  expect(presenter.defaultVoiceId).toBe(voice.id);
  // Forgetting the twin asks first, saying what stays, and keeps its presenter and voice.
  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    void d.accept();
  });
  await twin.getByRole("button", { name: `Forget the digital twin ${name}` }).click();
  await expect(twin).toHaveCount(0);
  expect(asked).toContain("The presenter it became stays in your avatars");
  await expect(page.getByRole("button", { name: "New digital twin" })).toBeFocused();
  expect((await page.request.delete(`/api/avatars/${mine.avatarId}`)).status()).toBe(200);
  expect((await page.request.delete(`/api/voices/${voice.id}`)).status()).toBe(204);
});

test("a HeyGen Studio template is filled in and rendered as a library video", async ({ page }) => {
  await page.goto("/templates");
  const section = page.getByTestId("studio-templates");
  await expect(section.getByRole("heading", { name: "HeyGen templates" })).toBeVisible();
  await section.getByRole("button", { name: "Fill in Open house invitation" }).click();
  const form = page.getByTestId("studio-template-form");
  await expect(form.getByRole("heading", { name: /Open house invitation/ })).toBeFocused();
  // Each slot starts from the template's own; a text with no default must be filled in before rendering.
  await expect(form.getByRole("textbox", { name: /^Agent name/ })).toHaveValue("Ava");
  await expect(form.getByText("Fill in Open time to render.")).toBeVisible();
  await expect(form.getByRole("button", { name: "Render video" })).toBeDisabled();
  await form.getByRole("textbox", { name: /^Open time/ }).fill("Saturday at 10");
  await form.getByRole("textbox", { name: /^Video title/ }).fill("Harbor Lane invite");
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/studio-templates/demo_open_house/videos") && r.method() === "POST");
  await form.getByRole("button", { name: "Render video" }).click();
  const request = await sent;
  const body = request.postDataJSON() as { title: string; captions: boolean; variables: Record<string, unknown> };
  expect(body.title).toBe("Harbor Lane invite");
  expect(body.variables.open_time).toEqual({ type: "text", content: "Saturday at 10" });
  expect(body.variables.cover_image, "a link left empty keeps the template's").toBeUndefined();
  await page.waitForURL(/\/videos\/vid_/);
  // The render carries a key, so the same render sent again (after a lost answer) returns this video, not a second.
  const key = request.headers()["idempotency-key"];
  expect(key).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  const again = await page.request.post("/api/studio-templates/demo_open_house/videos", { data: body, headers: { "Idempotency-Key": key } });
  expect(page.url()).toContain(`/videos/${(await again.json()).video.id}`);
  await expect(page.getByText("Open house invitation", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit a copy" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save as template" })).toHaveCount(0);
  // The template can be used again from the video, opening its form directly.
  await page.getByRole("link", { name: "Use the template again" }).click();
  await expect(page.getByTestId("studio-template-form").getByRole("heading", { name: /Open house invitation/ })).toBeVisible();
  // Closing goes back to its card, and the link no longer reopens the form.
  await page.getByTestId("studio-template-form").getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: "Fill in Open house invitation" })).toBeFocused();
  await expect(page).toHaveURL(/\/templates$/);
});

test("a scene can leave the presenter out and let its picture fill the frame", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill("Kitchen tour");
  await page.locator("textarea").fill("Welcome in, let me show you around.");
  await page.getByRole("button", { name: "Add scene" }).click();
  await page.locator("textarea").fill("The kitchen was redone last spring.");
  const show = page.getByRole("checkbox", { name: /Show the presenter in scene 2/ });
  // A colour cannot stand in for the presenter, so the choice waits for a picture or video.
  await expect(show).toBeChecked();
  await expect(show).toBeDisabled();
  await expect(page.getByTestId("scene-show-presenter")).toContainText("give the scene an image or video background first");
  await page.getByRole("button", { name: "Background" }).click();
  await page.getByLabel("Image URL").fill("https://example.com/kitchen.jpg");
  await expect(show).toBeEnabled();
  await show.uncheck();
  // The stage shows the picture alone, and nothing about a presenter is offered for the scene.
  await expect(page.getByTestId("stage-avatar")).toHaveCount(0);
  await expect(page.getByTestId("scene-layout")).toHaveCount(0);
  await expect(page.getByLabel("Scene avatar")).toHaveCount(0);
  await expect(page.getByLabel("Scene voice")).toBeVisible();
  await expect(page.getByTestId("scene-show-presenter")).toContainText("The picture fills the frame and the voice narrates it");
  // The first scene still has its presenter.
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await expect(page.getByTestId("stage-avatar")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Show the presenter in scene 1/ })).toBeChecked();
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.getByTestId("stage-avatar")).toHaveCount(0);
  await page.getByRole("button", { name: "Generate video" }).click();
  await page.waitForURL(/\/videos\/vid_/);
  const id = page.url().split("/").pop()!;
  const video = (await (await page.request.get(`/api/videos/${id}`)).json()).video;
  expect(video.scenes[0].hidePresenter).toBeUndefined();
  expect(video.scenes[1]).toMatchObject({ hidePresenter: true, background: { type: "image", value: "https://example.com/kitchen.jpg" } });
  await expect(page.getByText(/no presenter: the picture fills the frame/)).toBeVisible();
  // A copy keeps it, and going back to a colour brings the presenter back.
  await page.goto(`/create?from=${id}`);
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.getByRole("checkbox", { name: /Show the presenter in scene 2/ })).not.toBeChecked();
  await expect(page.getByTestId("stage-avatar")).toHaveCount(0);
  await page.getByRole("button", { name: "Background" }).click();
  await page.getByLabel("Background #0f172a").click();
  await expect(page.getByRole("checkbox", { name: /Show the presenter in scene 2/ })).toBeChecked();
  await expect(page.getByTestId("stage-avatar")).toBeVisible();
  // The API refuses a colour scene without the presenter.
  const bad = await page.request.post("/api/videos", { data: { title: "Bad", avatarId: "stock_1", voiceId: "stock_voice_1", scenes: [{ script: "Hi.", background: { type: "color", value: "#000000" }, hidePresenter: true }] } });
  expect(bad.status()).toBe(400);
  expect(JSON.stringify(await bad.json())).toMatch(/image or video background/);
});

test("a scene without the presenter gets the presenter back when its uploaded image is deleted", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  const tag = Date.now().toString(36);
  await page.locator("textarea").fill("Just the view from the deck.");
  await page.getByRole("button", { name: "Background", exact: true }).click();
  await page.getByLabel("Background image file").setInputFiles({ name: `deck-${tag}.png`, mimeType: "image/png", buffer: png });
  await expect(page.getByRole("button", { name: `Use deck-${tag}` })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("checkbox", { name: "Show the presenter" }).uncheck();
  await expect(page.getByTestId("stage-avatar")).toHaveCount(0);
  await page.waitForTimeout(700); // the draft autosaves
  const { backdrops } = (await (await page.request.get("/api/backdrops")).json()) as { backdrops: Array<{ id: string; name: string }> };
  const deck = backdrops.find((b) => b.name === `deck-${tag}`)!;
  expect((await page.request.delete(`/api/backdrops/${deck.id}`)).status()).toBe(204);
  await page.reload();
  await expect(page.getByText("Restored your unsent draft")).toBeVisible();
  // A plain colour cannot stand in for the presenter, so the presenter is back, and the video can be made.
  await expect(page.getByRole("checkbox", { name: "Show the presenter" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Show the presenter" })).toBeDisabled();
  await expect(page.getByTestId("stage-avatar")).toBeVisible();
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate video" }).click();
  expect("hidePresenter" in ((await sent).postDataJSON() as { scenes: object[] }).scenes[0]).toBe(false);
  await page.waitForURL(/\/videos\/vid_/);
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
  // Shown whole rather than cropped to the frame, which the stage previews.
  await page.getByRole("group", { name: "Background fit" }).getByRole("button", { name: /Show all of it/ }).click();
  await expect(page.getByTestId("stage")).toHaveAttribute("data-fit", "contain");
  await expect(page.getByTestId("stage-video")).toHaveClass(/object-contain/);
  await expect(page.getByText(/2 scenes/)).toBeVisible();
  // The second scene gets its own presenter and voice; the stage preview follows the choice.
  await page.getByLabel("Scene avatar").selectOption({ label: "Marcus Hill" });
  await page.getByLabel("Scene voice").selectOption({ label: "Olivia" });
  await expect(page.getByTestId("stage-avatar")).toHaveAttribute("alt", "Marcus Hill");
  // And its own pace, which the scene's running time follows.
  await page.getByLabel("Scene speed").selectOption("0.75");
  // The presenter can be sized and moved per scene; the stage preview follows and the scene stores it.
  await page.getByTestId("scene-layout").locator("summary").click();
  await page.getByLabel("Presenter size").fill("1.2");
  await page.getByLabel("Presenter horizontal position").fill("0.5");
  await expect(page.getByTestId("stage-avatar")).toHaveCSS("transform", /matrix\(1\.2, 0, 0, 1\.2, 0, 0\)/);
  await expect(page.getByTestId("stage-presenter")).toHaveCSS("transform", /matrix\(1, 0, 0, 1, [1-9]\d*(\.\d+)?, 0\)/);
  await expect(page.getByTestId("scene-layout")).toContainText("120%, moved");
  // And framed in a circle over the background, which the stage previews.
  await page.getByRole("group", { name: "Presenter framing" }).getByRole("button", { name: "Circle" }).click();
  await expect(page.getByTestId("stage-presenter")).toHaveAttribute("data-framing", "circle");
  await expect(page.getByTestId("scene-layout")).toContainText("circle, 120%, moved");
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await expect(page.getByTestId("scene-layout")).not.toContainText("120%");
  await expect(page.getByTestId("stage-avatar")).not.toHaveAttribute("alt", "Marcus Hill");
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  // The voice can be pitched up or down for the whole video.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Voice pitch").fill("10");
  await expect(page.getByText(/Voice pitch · \+10/)).toBeVisible();
  // And given a speaking style, which the video page lists.
  await page.getByLabel("Voice emotion").selectOption("Friendly");
  await page.getByRole("button", { name: "Generate video" }).click();
  await page.waitForURL(/\/videos\/vid_/);
  const id = page.url().split("/").pop()!;
  const video = (await (await page.request.get(`/api/videos/${id}`)).json()).video;
  expect(video.pitch).toBe(10);
  expect(video.scenes.map((sc: { speed?: number }) => sc.speed)).toEqual([undefined, 0.75]);
  expect(video.emotion).toBe("Friendly");
  await expect(page.getByText("Voice emotion")).toBeVisible();
  expect(video.scenes).toHaveLength(2);
  expect(video.script).toBe("Scene one says hello.\n\nScene two says goodbye.");
  expect(video.scenes[0].avatarName).toBeUndefined();
  expect(video.scenes[1]).toMatchObject({ avatarId: "stock_2", avatarName: "Marcus Hill", voiceId: "stock_voice_3", voiceName: "Olivia", layout: { scale: 1.2, x: 0.5, y: 0, framing: "circle" }, background: { type: "video", value: "https://example.com/loop.mp4", fit: "contain" } });
  expect((await page.request.post("/api/videos", { data: { title: "Bad", script: "Hi.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "16:9", background: { type: "video", value: "loop.mp4" } } })).status()).toBe(400);
  expect(video.scenes[0].layout).toBeUndefined();
  await expect(page.getByText("Script · 2 scenes")).toBeVisible();
  await expect(page.getByText("Marcus Hill · Olivia · 0.75x speed · presenter in a circle, 120%, moved")).toBeVisible();
  // The demo renderer neither places the presenter nor fits the background, and the line says so.
  await expect(page.getByText(/· background shown whole \(preview only\)$/)).toBeVisible();
  // Edit a copy keeps the scene's presenter.
  await page.goto(`/create?from=${id}`);
  await expect(page.getByText(/2 scenes/)).toBeVisible();
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.getByLabel("Scene voice")).toHaveValue("stock_voice_3");
  await expect(page.getByLabel("Scene speed")).toHaveValue("0.75");
  await expect(page.getByTestId("stage")).toHaveAttribute("data-fit", "contain");
  // And the copy keeps the voice settings.
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Voice emotion")).toHaveValue("Friendly");
  await expect(page.getByText(/Voice pitch · \+10/)).toBeVisible();
  // With the other scene removed, the one left hands its pace to the video's speed slider.
  await expect(page.getByText("Speaking speed · 1.00x")).toBeVisible();
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await page.getByRole("button", { name: "Remove scene", exact: true }).click();
  await expect(page.getByText(/1 scene\b/)).toBeVisible();
  await expect(page.getByText("Speaking speed · 0.75x")).toBeVisible();
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
  // The keyboard user is back on the title, not at the top of the page.
  await expect(page.locator("button[title='Rename']")).toBeFocused();
  // Enter on an unchanged (or emptied) title closes the field too, rather than the same key reopening it.
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Video title")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Video title")).toHaveCount(0);
  await expect(page.locator("button[title='Rename']")).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByLabel("Video title").fill("");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Video title")).toHaveCount(0);
  await expect(page.locator("button[title='Rename']")).toHaveText("Renamed video");
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

test("the share page transcript plays the video from a line and marks the line being spoken", async ({ page }) => {
  const v = await createVideoViaApi(page, `Transcript ${Date.now().toString(36)}`, { script: "First we open the doors. [pause 1s] Then the team walks you through every room. Finally we hand over the keys." });
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  const { cues } = (await (await page.request.get(`/api/videos/${v.id}/captions?format=json`)).json()) as { cues: Array<{ startMs: number; endMs: number; text: string }> };
  expect(cues.length).toBeGreaterThan(1);
  await page.goto(`/share/${v.id}`);
  const transcript = page.getByTestId("share-transcript");
  await expect(page.getByRole("heading", { name: "Transcript", exact: true })).toBeVisible();
  // The lines are the captions, pause markers left out, each with its start time.
  await expect(transcript.getByRole("button")).toHaveCount(cues.length);
  await expect(transcript).not.toContainText("[pause");
  const line = transcript.getByRole("button").nth(1);
  await expect(line).toContainText(cues[1].text.split("\n")[0]);
  const player = page.getByTestId("share-player");
  await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(1);
  const duration = await player.evaluate((el: HTMLVideoElement) => el.duration);
  await line.click();
  const target = Math.min(cues[1].startMs / 1000, duration);
  await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThanOrEqual(target - 0.25);
  await player.evaluate((el: HTMLVideoElement) => el.pause());
  // The line marked is the one spoken where the player stopped: the clicked one, or a later one if playback ran on.
  const at = Math.round((await player.evaluate((el: HTMLVideoElement) => el.currentTime)) * 1000);
  const spoken = cues.findIndex((c) => c.startMs <= at && at < c.endMs);
  expect(spoken).toBeGreaterThanOrEqual(1);
  await expect(transcript.getByRole("button").nth(spoken)).toHaveAttribute("aria-current", "true");
  await expect(transcript.locator('[aria-current="true"]')).toHaveCount(1);
  await player.evaluate((el: HTMLVideoElement) => (el.currentTime = 0));
  await expect(transcript.getByRole("button").first()).toHaveAttribute("aria-current", "true");
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
  // The transcript follows the track the viewer turns on: Spanish lines while it shows, the script's otherwise.
  const transcript = page.getByTestId("share-transcript");
  await expect(transcript).not.toContainText("[Spanish]");
  const showTrack = (label: string | null) =>
    page.getByTestId("share-player").evaluate((el: HTMLVideoElement, wanted) => {
      for (const t of Array.from(el.textTracks)) t.mode = t.label === wanted ? "showing" : "disabled";
    }, label);
  await showTrack("Spanish");
  await expect(page.getByRole("heading", { name: "Transcript · Spanish" })).toBeVisible();
  await expect(transcript).toContainText("[Spanish]");
  await expect(transcript).toHaveAttribute("lang", "es");
  await showTrack(null);
  await expect(page.getByRole("heading", { name: "Transcript", exact: true })).toBeVisible();
  await expect(transcript).not.toContainText("[Spanish]");
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
  // The page an embed loads is the player alone, filling the frame it is given, controls included.
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto(`/share/${v.id}?embed=1`);
  const box = (await page.getByTestId("share-player").boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(361);
  expect(box.height).toBeGreaterThan(330);
  // In a frame wider than the (square) video, the player keeps its shape, centred, so its logo and captions sit on the
  // picture rather than in black bars.
  await page.setViewportSize({ width: 900, height: 360 });
  const wide = (await page.getByTestId("share-player").boundingBox())!;
  expect(Math.abs(wide.width - 360)).toBeLessThanOrEqual(1);
  expect(Math.abs(wide.x - 270)).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("share-transcript")).toHaveCount(0);
  await expect(page.getByTestId("share-cta")).toHaveCount(0);
  if (viewport) await page.setViewportSize(viewport);
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
  // A paused frame of the video itself can be the cover, at the video's own size (fitted in a 1280px box).
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
    return [Math.round(el.videoWidth * Math.min(1, 1280 / el.videoWidth, 1280 / el.videoHeight)), img.naturalWidth];
  }, `/api/videos/${v.id}/cover?v=${Date.parse(frame.cover!.updatedAt)}`);
  expect(coverWidth).toBe(videoWidth);
  expect(coverWidth).toBeGreaterThan(1);
  // The frame is the one the player is on: the start and a later moment give different covers.
  const coverBytes = async () => {
    const meta = (await (await page.request.get(`/api/videos/${v.id}`)).json()).video as { cover: { updatedAt: string } };
    return Buffer.from(await (await page.request.get(`/api/videos/${v.id}/cover?v=${Date.parse(meta.cover.updatedAt)}`)).body()).toString("base64");
  };
  const atThree = await coverBytes();
  // At 0 the capture takes the frame 0.04s in (a seek to where it already is may load nothing); still the start.
  await player.evaluate((el: HTMLVideoElement) => (el.currentTime = 0));
  await page.getByRole("button", { name: "Use current frame" }).click();
  await expect.poll(coverBytes).not.toBe(atThree);
  const atZero = await coverBytes();
  await player.evaluate((el: HTMLVideoElement) => (el.currentTime = 3));
  await page.getByRole("button", { name: "Use current frame" }).click();
  await expect.poll(coverBytes).not.toBe(atZero);
  expect(await coverBytes()).toBe(atThree);
});

test("discarding a restored draft resets its voice settings", async ({ page }) => {
  await page.goto("/create");
  await page.locator("textarea").fill("A draft with a mood.");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Voice emotion").selectOption("Excited");
  await page.getByRole("checkbox", { name: /Captions/ }).check();
  const position = page.getByRole("group", { name: "Caption position" });
  await position.getByRole("button", { name: "top" }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("avatar-studio:draft") ?? "{}").emotion)).toBe("Excited");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("avatar-studio:draft") ?? "{}").captionStyle?.position)).toBe("top");
  await page.reload();
  await expect(page.getByText("Restored your unsent draft")).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Voice emotion")).toHaveValue("Excited");
  await expect(position.getByRole("button", { name: "top" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(page.getByLabel("Voice emotion")).toHaveValue("");
  // Captions go back off with the rest; switched on again, they start from the default style.
  await page.getByRole("checkbox", { name: /Captions/ }).check();
  await expect(position.getByRole("button", { name: "bottom" })).toHaveAttribute("aria-pressed", "true");
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

test("an uploaded background image fills the stage, renders, and leaves every scene when deleted", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  const tag = Date.now().toString(36);
  await page.locator("textarea").fill("Here is our new office.");
  await page.getByRole("button", { name: "Background", exact: true }).click();
  await page.getByLabel("Background image file").setInputFiles({ name: `office-${tag}.png`, mimeType: "image/png", buffer: png });
  const use = page.getByRole("button", { name: `Use office-${tag}` });
  await expect(use).toHaveAttribute("aria-pressed", "true");
  const { backdrops } = (await (await page.request.get("/api/backdrops")).json()) as { backdrops: Array<{ id: string; name: string; mimeType: string }> };
  const office = backdrops.find((b) => b.name === `office-${tag}`)!;
  expect(office.mimeType).toBe("image/png");
  await expect(page.getByTestId("stage")).toHaveCSS("background-image", new RegExp(`/api/backdrops/${office.id}`));
  // The image URL field stays for pictures given by address.
  await expect(page.getByPlaceholder("https://…/background.jpg")).toHaveValue("");
  // A picture the server would not take as it is (a GIF) is redrawn as a JPEG first.
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  await page.getByLabel("Background image file").setInputFiles({ name: `logo-${tag}.gif`, mimeType: "image/gif", buffer: gif });
  await expect(page.getByRole("button", { name: `Use logo-${tag}` })).toHaveAttribute("aria-pressed", "true");
  const after = (await (await page.request.get("/api/backdrops")).json()) as { backdrops: Array<{ id: string; name: string; mimeType: string }> };
  const logo = after.backdrops.find((b) => b.name === `logo-${tag}`)!;
  expect(logo.mimeType).toBe("image/jpeg");
  await use.click();
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate video" }).click();
  expect(((await sent).postDataJSON() as { scenes: Array<{ background: unknown }> }).scenes[0].background).toEqual({ type: "image", value: `/api/backdrops/${office.id}` });
  await page.waitForURL(/\/videos\/vid_/);
  // An image deleted elsewhere (another tab) leaves a restored draft that named it with a plain background and a note.
  await page.goto("/create");
  await page.locator("textarea").fill("Back to plain.");
  await page.getByRole("button", { name: "Background", exact: true }).click();
  await page.getByRole("button", { name: `Use office-${tag}` }).click();
  await page.waitForTimeout(700); // the draft autosaves
  expect((await page.request.delete(`/api/backdrops/${office.id}`)).status()).toBe(204);
  await page.reload();
  await expect(page.getByText("Restored your unsent draft")).toBeVisible();
  await page.getByRole("button", { name: "Background", exact: true }).click();
  await expect(page.getByTestId("import-note")).toContainText("has been deleted, so they have a plain background now");
  await expect(page.getByTestId("stage")).toHaveCSS("background-image", "none");
  await expect(page.getByRole("button", { name: `Use office-${tag}` })).toHaveCount(0);
  expect((await page.request.get(`/api/backdrops/${office.id}`)).status()).toBe(404);
  // Deleting from the picker takes the image off the scene too.
  await page.getByRole("button", { name: `Use logo-${tag}` }).click();
  await expect(page.getByTestId("stage")).toHaveCSS("background-image", new RegExp(`/api/backdrops/${logo.id}`));
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: `Delete logo-${tag}` }).click();
  await expect(page.getByRole("button", { name: `Use logo-${tag}` })).toHaveCount(0);
  await expect(page.getByTestId("stage")).toHaveCSS("background-image", "none");
  expect((await page.request.get(`/api/backdrops/${logo.id}`)).status()).toBe(404);
  // An image background is a public address or an uploaded image, nothing in between.
  const bad = await page.request.post("/api/videos", {
    data: { title: "Bad", script: "Hi", avatarId: "stock_1", voiceId: "stock_voice_1", background: { type: "image", value: `/api/backdrops/${logo.id}/` } },
  });
  expect(bad.status()).toBe(400);
});

/** A minimal PDF with one landscape page per entry, each showing its lines of text in Helvetica. */
function slidesPdf(pages: string[][], width = 960, height = 540): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  const catalog = add(""); // filled in once the page ids are known
  const pagesId = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const lines of pages) {
    const ops = lines.map((line, i) => `BT /F1 ${i === 0 ? 40 : 28} Tf 60 ${height - 90 - i * 60} Td (${line.replace(/[()\\]/g, "\\$&")}) Tj ET`).join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("a slide deck as PDF becomes one scene per page, each page behind the presenter", async ({ page }) => {
  const tag = Date.now().toString(36);
  const pdf = slidesPdf([["Welcome aboard", "Meet the team"], ["Questions?"], []]);
  await page.getByLabel("Import slides from a PDF").setInputFiles({ name: `onboarding-${tag}.pdf`, mimeType: "application/pdf", buffer: pdf });
  await expect(page.getByTestId("import-note")).toContainText("Imported 3 pages", { timeout: 30_000 });
  await expect(page.getByTestId("import-note")).toContainText("1 page has no text");
  await expect(page.locator("textarea")).toHaveValue("Welcome aboard. Meet the team.");
  await expect(page.locator("input[placeholder='Video title']")).toHaveValue(`onboarding-${tag}`);
  const { backdrops } = (await (await page.request.get("/api/backdrops")).json()) as { backdrops: Array<{ id: string; name: string; mimeType: string }> };
  const mine = backdrops.filter((b) => b.name.startsWith(`onboarding-${tag} – page`));
  expect(mine.map((b) => b.name).sort()).toEqual([1, 2, 3].map((n) => `onboarding-${tag} – page ${n}`));
  expect(mine.every((b) => b.mimeType === "image/jpeg")).toBe(true);
  const first = mine.find((b) => b.name.endsWith("page 1"))!;
  await expect(page.getByTestId("stage")).toHaveCSS("background-image", new RegExp(`/api/backdrops/${first.id}`));
  // The page was drawn: a 1080p landscape picture whose title letters show.
  const drawn = await page.evaluate(async (id) => {
    const img = new Image();
    img.src = `/api/backdrops/${id}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] < 128) dark++;
    return { w: img.naturalWidth, h: img.naturalHeight, dark };
  }, first.id);
  expect([drawn.w, drawn.h]).toEqual([1920, 1080]);
  expect(drawn.dark, "the title's letters show").toBeGreaterThan(500);
  for (const b of mine) expect((await page.request.delete(`/api/backdrops/${b.id}`)).status()).toBe(204);
  // A 4:3 deck is landscape and letterboxed in white, not cropped: the page's top line is still in the picture.
  page.once("dialog", (d) => d.accept());
  await page.getByLabel("Import slides from a PDF").setInputFiles({ name: `classic-${tag}.pdf`, mimeType: "application/pdf", buffer: slidesPdf([["Top of the slide"]], 1024, 768) });
  await expect(page.getByTestId("import-note")).toContainText("Imported 1 page", { timeout: 30_000 });
  const classic = ((await (await page.request.get("/api/backdrops")).json()) as { backdrops: Array<{ id: string; name: string }> }).backdrops.find((b) => b.name === `classic-${tag} – page 1`)!;
  const framed = await page.evaluate(async (id) => {
    const img = new Image();
    img.src = `/api/backdrops/${id}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let y = 0; y < 200; y++) for (let x = 0; x < c.width; x++) if (px[(y * c.width + x) * 4] < 128) dark++;
    return { w: img.naturalWidth, h: img.naturalHeight, topDark: dark };
  }, classic.id);
  expect([framed.w, framed.h]).toEqual([1920, 1080]);
  expect(framed.topDark, "the title near the top of a 4:3 page survives").toBeGreaterThan(200);
  expect((await page.request.delete(`/api/backdrops/${classic.id}`)).status()).toBe(204);
  // A file that is not a PDF says so (after confirming the scenes it would replace).
  page.once("dialog", (d) => d.accept());
  await page.getByLabel("Import slides from a PDF").setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") });
  await expect(page.getByTestId("import-note")).toContainText("could not be read as a PDF", { timeout: 30_000 });
});

/** A minimal PowerPoint deck: each slide's title and, optionally, its speaker notes and whether it is hidden. */
function slidesPptx(slides: Array<{ title: string; notes?: string; hidden?: boolean }>): Buffer {
  const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const sp = (type: string, text: string) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const files: Record<string, Uint8Array> = {
    "ppt/presentation.xml": strToU8(`<p:presentation ${ns}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`),
  };
  slides.forEach((s, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(`<p:sld ${ns}${s.hidden ? ' show="0"' : ""}><p:cSld><p:spTree>${sp("title", s.title)}</p:spTree></p:cSld></p:sld>`);
    if (s.notes) {
      files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/></Relationships>`);
      files[`ppt/notesSlides/notesSlide${i + 1}.xml`] = strToU8(`<p:notes ${ns}><p:cSld><p:spTree>${sp("body", s.notes)}</p:spTree></p:cSld></p:notes>`);
    }
  });
  return Buffer.from(zipSync(files));
}

test("a PowerPoint deck's speaker notes become the scripts, alone or with the deck saved as PDF", async ({ page }) => {
  const tag = Date.now().toString(36);
  const deck = slidesPptx([
    { title: "Welcome aboard", notes: "Hi everyone, I&apos;m so glad you&apos;re here" },
    { title: "Backup numbers", notes: "Skip this one", hidden: true },
    { title: "Questions?" },
  ]);
  const pptx = { name: `kickoff-${tag}.pptx`, mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", buffer: deck };
  // On its own: one scene per shown slide, scripted from its notes (its title where it has none).
  await page.getByLabel("Import slides from a PDF or PowerPoint file").setInputFiles(pptx);
  await expect(page.getByTestId("import-note")).toContainText("Imported 2 slides", { timeout: 30_000 });
  await expect(page.getByTestId("import-note")).toContainText("1 hidden slide was left out");
  await expect(page.getByTestId("import-note")).toContainText("1 slide has no notes, so its text is the script");
  await expect(page.locator("textarea")).toHaveValue("Hi everyone, I'm so glad you're here.");
  await expect(page.locator("input[placeholder='Video title']")).toHaveValue(`kickoff-${tag}`);
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.locator("textarea")).toHaveValue("Questions?");
  // With the deck saved as PDF (which leaves the hidden slide out): the pages behind the presenter, the notes as scripts.
  page.once("dialog", (d) => d.accept());
  await page.getByLabel("Import slides from a PDF or PowerPoint file").setInputFiles([pptx, { name: `kickoff-${tag}.pdf`, mimeType: "application/pdf", buffer: slidesPdf([["Welcome aboard"], ["Questions?"]]) }]);
  await expect(page.getByTestId("import-note")).toContainText(`Imported 2 pages of kickoff-${tag}.pdf as scenes, each page behind the presenter and the speaker notes from kickoff-${tag}.pptx`, { timeout: 30_000 });
  await expect(page.getByTestId("import-note")).not.toContainText("may be off");
  await expect(page.locator("textarea")).toHaveValue("Hi everyone, I'm so glad you're here.");
  const { backdrops } = (await (await page.request.get("/api/backdrops")).json()) as { backdrops: Array<{ id: string; name: string }> };
  const mine = backdrops.filter((b) => b.name.startsWith(`kickoff-${tag} – page`));
  expect(mine).toHaveLength(2);
  await expect(page.getByTestId("stage")).toHaveCSS("background-image", new RegExp(`/api/backdrops/${mine.find((b) => b.name.endsWith("page 1"))!.id}`));
  // The .pptx on its own over those scenes, one per slide, changes the scripts and keeps each page behind the presenter.
  await page.locator("textarea").fill("Edited");
  page.once("dialog", (d) => d.accept());
  await page.getByLabel("Import slides from a PDF or PowerPoint file").setInputFiles(pptx);
  await expect(page.getByTestId("import-note")).toContainText("each scene kept its background");
  await expect(page.locator("textarea")).toHaveValue("Hi everyone, I'm so glad you're here.");
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.getByTestId("stage")).toHaveCSS("background-image", new RegExp(`/api/backdrops/${mine.find((b) => b.name.endsWith("page 2"))!.id}`));
  for (const b of mine) expect((await page.request.delete(`/api/backdrops/${b.id}`)).status()).toBe(204);
  // Two decks at once, or an old .ppt, are refused with a reason.
  await page.getByLabel("Import slides from a PDF or PowerPoint file").setInputFiles([pptx, { ...pptx, name: "other.pptx" }]);
  await expect(page.getByTestId("import-note")).toContainText("Choose one slide deck");
  await page.getByLabel("Import slides from a PDF or PowerPoint file").setInputFiles({ ...pptx, name: "old.pptx", buffer: Buffer.from("not a zip") });
  await expect(page.getByTestId("import-note")).toContainText("old.pptx could not be read as a PowerPoint (.pptx) file");
});

test("the video agent writes from an attached document, read in the browser", async ({ page }) => {
  await page.goto("/agent");
  await page.getByLabel("What should the video be?").fill("A video about our open house");
  // A PDF with no words (a scan, say) is refused with a reason; nothing is attached.
  await page.getByLabel("Attach a document").setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: slidesPdf([[]]) });
  await expect(page.getByText(/^No text found in scan\.pdf/)).toBeVisible({ timeout: 30_000 });
  // A PDF is known by its first bytes, whatever it is named.
  await page.getByLabel("Attach a document").setInputFiles({ name: "report", mimeType: "", buffer: slidesPdf([["Unnamed but still a PDF."]]) });
  await expect(page.getByTestId("agent-document")).toContainText("report", { timeout: 30_000 });
  // The focus moves to Remove; clicking the file's name does not remove it (it once sat inside a label for that button).
  await expect(page.getByRole("button", { name: "Remove report" })).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "report attached" })).toBeVisible();
  await page.getByTestId("agent-document").getByText(/^report ·/).click();
  await expect(page.getByTestId("agent-document")).toBeVisible();
  await page.getByRole("button", { name: "Remove report" }).click();
  await expect(page.getByLabel("Attach a document")).toBeFocused();
  await page.getByLabel("Attach a document").setInputFiles({ name: "flyer.pdf", mimeType: "application/pdf", buffer: slidesPdf([["Open house is Saturday at noon."], ["Parking is behind the building."]]) });
  await expect(page.getByTestId("agent-document")).toContainText("flyer.pdf", { timeout: 30_000 });
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/video-agent") && r.method() === "POST");
  await page.getByRole("button", { name: "Review in editor first" }).click();
  // Only the words travel, never the file.
  const body = JSON.parse((await sent).postData() ?? "{}") as { document?: { name: string; text: string } };
  expect(body.document).toEqual({ name: "flyer.pdf", text: "Open house is Saturday at noon.\n\nParking is behind the building." });
  await expect(page).toHaveURL(/\/create\?plan=agent$/);
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.locator("textarea")).toHaveValue("Open house is Saturday at noon.");
  await page.evaluate(() => localStorage.removeItem("avatar-studio:draft"));
});

test("each space keeps its own draft, so a workspace never shows or spoils the personal one", async ({ page }) => {
  const tag = Date.now().toString(36);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  await page.locator("textarea").fill(`Personal draft ${tag}`);
  await page.getByRole("button", { name: "Background", exact: true }).click();
  await page.getByLabel("Background image file").setInputFiles({ name: `mine-${tag}.png`, mimeType: "image/png", buffer: png });
  await expect(page.getByRole("button", { name: `Use mine-${tag}` })).toHaveAttribute("aria-pressed", "true");
  const mine = ((await (await page.request.get("/api/backdrops")).json()) as { backdrops: Array<{ id: string; name: string }> }).backdrops.find((b) => b.name === `mine-${tag}`)!;
  await expect.poll(() => page.evaluate(() => localStorage.getItem("avatar-studio:draft") ?? "")).toContain(`/api/backdrops/${mine.id}`);
  const ws = (await (await page.request.post("/api/workspaces", { data: { name: `Drafts ${tag}` } })).json()).workspace as { id: string };
  try {
    expect((await page.request.post("/api/workspaces/switch", { data: { id: ws.id } })).status()).toBe(200);
    // The editor restores a draft once it knows the space; wait for that answer before checking nothing came back.
    const spaces = page.waitForResponse((r) => r.url().endsWith("/api/workspaces") && r.request().method() === "GET");
    await page.goto("/create");
    await spaces;
    await page.waitForTimeout(300);
    // The workspace starts clean: no personal script, no note about a "deleted" image it cannot see.
    await expect(page.getByRole("button", { name: "Generate video" })).toBeVisible();
    await expect(page.locator("textarea")).toHaveValue("");
    await expect(page.getByTestId("import-note")).toHaveCount(0);
    await page.locator("textarea").fill(`Team draft ${tag}`);
    await expect.poll(() => page.evaluate((id) => localStorage.getItem(`avatar-studio:draft:${id}`) ?? "", ws.id)).toContain(`Team draft ${tag}`);
    expect((await page.request.post("/api/workspaces/switch", { data: { id: "local" } })).status()).toBe(200);
    await page.goto("/create");
    // Back in Personal, the draft and its image are as they were.
    await expect(page.locator("textarea")).toHaveValue(`Personal draft ${tag}`);
    await expect(page.getByTestId("stage")).toHaveCSS("background-image", new RegExp(`/api/backdrops/${mine.id}`));
  } finally {
    await page.request.post("/api/workspaces/switch", { data: { id: "local" } });
    await page.request.delete(`/api/workspaces/${ws.id}`);
    await page.request.delete(`/api/backdrops/${mine.id}`);
    await page.evaluate((id) => localStorage.removeItem(`avatar-studio:draft:${id}`), ws.id);
  }
});

test("a portrait video has a portrait stage, at desktop and phone width", async ({ page }) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /^9:16/ }).click();
  const ratio = async () => {
    const box = (await page.getByTestId("stage").boundingBox())!;
    return box.width / box.height;
  };
  await expect.poll(ratio).toBeCloseTo(9 / 16, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(ratio).toBeCloseTo(9 / 16, 2);
  // The narrowest phones too, where the column is under the 292 pixels a 520-pixel-high stage would need.
  await page.setViewportSize({ width: 320, height: 640 });
  await expect.poll(ratio).toBeCloseTo(9 / 16, 2);
});

test("the AI script writer takes the focus and Escape closes it", async ({ page }) => {
  const write = page.getByRole("button", { name: "Write with AI" });
  await write.click();
  await expect(page.getByLabel("Topic")).toBeFocused();
  await expect(page.getByLabel("Tone", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Length", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Script language")).toHaveValue("English");
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Topic")).toHaveCount(0);
  await expect(write).toBeFocused();
});

test("Improve menu revises the active scene", async ({ page }) => {
  await page.locator("textarea").fill("Hi there! One. Two. Three. Four.");
  const improve = page.getByRole("button", { name: "Improve" });
  await improve.click();
  await expect(improve).toHaveAttribute("aria-expanded", "true");
  // Escape closes it and leaves the focus on the button.
  await page.getByRole("button", { name: "Expand", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Shorten", exact: true })).toHaveCount(0);
  await expect(improve).toBeFocused();
  await expect(improve).toHaveAttribute("aria-expanded", "false");
  await improve.click();
  await expect(page.getByLabel("New tone")).toBeVisible();
  await expect(page.getByLabel("Translate to")).toBeVisible();
  await page.getByRole("button", { name: "Shorten", exact: true }).click();
  await expect(page.locator("textarea")).toHaveValue("Hi there! One. Two.");
});

test("mobile drawer opens, navigates, and closes", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: "http://localhost:3100" });
  const page = await ctx.newPage();
  await page.goto("/home");
  // Closed, its links are out of the tab order (hidden, not only off screen).
  await expect(page.getByTestId("sidebar")).toBeHidden();
  const openMenu = page.getByRole("button", { name: "Open menu" });
  await openMenu.click();
  await expect(page.getByRole("button", { name: "Close menu" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sidebar")).toBeHidden();
  await expect(openMenu).toBeFocused();
  await openMenu.click();
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
    // A transparent video's Background row and a cleaned recording with a long title are the widest content of their pages.
    const clear = await createVideoViaApi(page, "Phone width transparent", { transparent: true });
    expect((await page.request.post("/api/cleanups", { data: { sourceUrl: "https://93.184.216.34/webinar.mp4", title: "Team webinar on pricing and the spring roadmap (cleaned)" } })).status()).toBe(202);
    const pages = ["/home", "/create", "/agent", "/videos", `/videos/${v.id}`, `/videos/${clear.id}`, "/templates", "/avatars", "/voices", "/batch", "/brand", "/interactive", "/workspace", "/settings", "/translate", "/cleanup", "/lipsync", "/music", "/cinematic", "/footage", "/photos", "/voice-changer", `/share/${v.id}`];
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
  // A row whose cells leave the script empty is named, and the batch cannot start, as an empty video cannot.
  await page.locator("textarea").first().fill("{oops2}");
  await page.locator("textarea").nth(1).fill("name,oops2\nJordan,\nPriya,Hello Priya");
  await expect(page.getByTestId("batch-row-problem")).toHaveText("Row 1 leaves the script empty; fill in its cells.");
  await expect(page.getByRole("button", { name: /Generate/ })).toBeDisabled();
  // The CSV upload is reachable from the keyboard (hidden visually, not removed from the tab order).
  await expect(page.locator('input[type="file"][accept*="csv"]')).not.toHaveCSS("display", "none");
  await page.locator('input[type="file"][accept*="csv"]').setInputFiles({ name: "people.csv", mimeType: "text/csv", buffer: Buffer.from("name,property,move_in\nJordan,12 Elm Street,November 1\nPriya,48 Harbor View,November 15") });
  await page.locator("textarea").first().fill("Hi {name}, see you at {property} on {move_in}.");
  await expect(page.getByTestId("batch-row-problem")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Generate 2 videos" })).toBeEnabled();
  await page.getByLabel("Output quality").selectOption("720p");
  // Every row is spoken with the same voice settings.
  await page.getByLabel("Voice emotion").selectOption("Friendly");
  await page.getByLabel("Voice pitch").fill("10");
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
  expect(mine.every((v) => (v as { emotion?: string; pitch?: number }).emotion === "Friendly" && (v as { pitch?: number }).pitch === 10)).toBe(true);
  // A saved template fills in the script (its scenes as paragraphs) and its settings.
  const tpl = await page.request.post("/api/templates", {
    data: { title: `Batch start ${Date.now().toString(36)}`, scenes: [{ script: "Hi {name}.", background: { type: "color", value: "#112233" } }, { script: "See you at {property}.", background: { type: "color", value: "#112233" } }], aspect: "9:16", captions: true, captionStyle: { position: "top", size: "large" }, speed: 1.2, emotion: "Serious", expressiveness: "high", motionPrompt: "Waves hello" },
  });
  expect(tpl.status()).toBe(201);
  const tplId = ((await tpl.json()) as { template: { id: string } }).template.id;
  try {
    await page.goto("/batch");
    await page.getByLabel("Start from a saved template").selectOption(tplId);
    await expect(page.locator("textarea").first()).toHaveValue("Hi {name}.\n\nSee you at {property}.");
    await expect(page.getByLabel("Voice emotion")).toHaveValue("Serious");
    await expect(page.getByLabel("Aspect ratio")).toHaveValue("9:16");
    await expect(page.getByText("Speaking speed · 1.20x")).toBeVisible();
    // The settings the page has no controls for (caption style, background, photo avatar motion) reach every row too.
    await page.getByRole("button", { name: "Generate 2 videos" }).click();
    await page.waitForURL(/\/videos\?batch=batch_/);
    const fromTpl = new URL(page.url()).searchParams.get("batch");
    const rows = ((await (await page.request.get("/api/videos")).json()).videos as Array<{ batchId?: string; aspect: string; speed: number; emotion?: string; captions: boolean; captionStyle?: { position: string; size: string }; background: { value: string }; expressiveness?: string; motionPrompt?: string }>).filter((v) => v.batchId === fromTpl);
    expect(rows).toHaveLength(2);
    for (const v of rows) {
      expect([v.aspect, v.speed, v.emotion, v.captions]).toEqual(["9:16", 1.2, "Serious", true]);
      expect(v.captionStyle).toMatchObject({ position: "top", size: "large" });
      expect(v.background.value).toBe("#112233");
      expect([v.expressiveness, v.motionPrompt]).toEqual(["high", "Waves hello"]);
    }
  } finally {
    await page.request.delete(`/api/templates/${tplId}`);
  }
});

test("captions are served as SRT and VTT, security headers are set", async ({ page, request }) => {
  const v = await createVideoViaApi(page, "Caption formats", { captions: true, captionStyle: { position: "top", size: "large", look: "yellow", font: "serif" } });
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
  await expect(page.getByTestId("share-player")).toHaveClass(/cue-font-serif/);
  // The track is on from the start: the demo renderer (like D-ID, or HeyGen with a style) burns no captions into the file.
  await expect(page.getByTestId("share-player").locator("track")).toHaveAttribute("default", "");
  await page.goto(`/videos/${v.id}`);
  await expect(page.getByText("On · top, large, yellow, serif type")).toBeVisible();
  // The editor offers the style once captions are on, previews it on the stage, and a copy keeps it.
  await page.goto(`/create?from=${v.id}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("group", { name: "Caption position" }).getByRole("button", { name: "top" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("stage-caption")).toHaveClass(/top-4/);
  await page.getByRole("group", { name: "Caption size" }).getByRole("button", { name: "small" }).click();
  await expect(page.getByTestId("stage-caption")).toHaveClass(/text-xs/);
  await expect(page.getByRole("group", { name: "Caption look" }).getByRole("button", { name: "yellow" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("stage-caption")).toHaveAttribute("data-look", "yellow");
  // The typeface comes along too, and the stage sets its caption in it.
  await expect(page.getByRole("group", { name: "Caption font" }).getByRole("button", { name: "serif" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("stage-caption")).toHaveCSS("font-family", /Georgia/);
  await page.getByRole("group", { name: "Caption font" }).getByRole("button", { name: "mono" }).click();
  await expect(page.getByTestId("stage-caption")).toHaveAttribute("data-font", "mono");
  await expect(page.getByTestId("stage-caption")).toHaveCSS("font-family", /monospace/);
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

test("the editor's chosen options, scene chips, and hints keep readable text on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator("textarea").fill("Welcome in, let me show you around.");
  await page.getByRole("button", { name: "Add scene" }).click();
  await page.locator("textarea").fill("The kitchen was redone last spring.");
  // Every node in view is judged: none fails, and none is left undecided.
  const contrast = async (...selectors: string[]) => {
    let builder = new AxeBuilder({ page }).withRules(["color-contrast"]);
    for (const sel of selectors) builder = builder.include(sel);
    const axe = await builder.analyze();
    expect(axe.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")))).toEqual([]);
    expect(axe.incomplete.filter((r) => r.id === "color-contrast").flatMap((r) => r.nodes.map((n) => n.target.join(" ")))).toEqual([]);
    return axe.passes.filter((r) => r.id === "color-contrast").flatMap((r) => r.nodes.map((n) => n.html));
  };
  // The note under an option is its own node, so the check names it, not the button around it.
  const note = (html: string, text: string) => html.startsWith("<div") && html.includes("text-[11px]") && html.includes(text);
  // The chosen scene's chip sits on the tinted brand fill, the other on white.
  await page.getByTestId("scene-duration").first().scrollIntoViewIfNeeded();
  let checked = await contrast('[data-testid="scene-duration"]');
  expect(checked.filter((html) => html.includes('data-testid="scene-duration"'))).toHaveLength(2);
  // The on-screen text hint and the character count under it.
  const overlay = page.getByLabel(/On-screen text for scene 2/);
  await overlay.fill("Spring sale");
  const [notes, input] = await page.evaluate(
    ([a, b]) => [CSS.escape(a), CSS.escape(b)],
    [(await overlay.getAttribute("aria-describedby"))!, (await overlay.getAttribute("id"))!],
  );
  // axe passes over text outside the viewport without a word, so the notes are brought into view.
  await page.locator(`#${notes}`).scrollIntoViewIfNeeded();
  checked = await contrast(`#${notes}`, `label[for="${input}"]`);
  expect(checked.some((html) => html.includes("characters, shown on one line")), "the character count was checked").toBe(true);
  expect(checked.some((html) => html.includes("(optional: a title")), "the hint was checked").toBe(true);
  await page.getByRole("button", { name: "Background" }).click();
  await page.getByLabel("Image URL").fill("https://example.com/kitchen.jpg");
  const fit = page.getByRole("group", { name: "Background fit" });
  await expect(fit.getByRole("button", { name: /Fill the frame/ })).toHaveAttribute("aria-pressed", "true");
  await fit.scrollIntoViewIfNeeded();
  checked = await contrast('[aria-label="Background fit"]');
  expect(checked.some((html) => note(html, "Cropped to the frame")), "the chosen fit's note was checked").toBe(true);
  await page.getByRole("button", { name: "Settings" }).click();
  // The chosen ratio is announced as chosen, as the chosen quality is, not shown by colour alone.
  const aspect = page.getByRole("group", { name: "Aspect ratio" });
  await expect(aspect.getByRole("button", { name: /16:9/ })).toHaveAttribute("aria-pressed", "true");
  await expect(aspect.getByRole("button", { name: /9:16/ })).toHaveAttribute("aria-pressed", "false");
  await aspect.scrollIntoViewIfNeeded();
  checked = await contrast('[aria-label="Aspect ratio"]', '[aria-label="Output quality"]');
  expect(checked.some((html) => note(html, "Landscape")), "the chosen ratio's note was checked").toBe(true);
  expect(checked.some((html) => note(html, "Full HD")), "the chosen quality's note was checked").toBe(true);
});

/** A 1x1 transparent PNG. */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

test("the brand kit can be filled in from a website, for review before saving", async ({ page }) => {
  await page.goto("/brand");
  // The server will not fetch a private address, and says so.
  await page.getByLabel("Website address").fill("localhost");
  await page.getByRole("button", { name: "Fill in" }).click();
  await expect(page.getByTestId("brand-import-status")).toContainText(/public|private|not allowed/i);
  // A public site is read on the server (stood in for here); its details fill the form and nothing is saved yet.
  await page.route("**/api/brand/import", (route) =>
    route.fulfill({ json: { suggestion: { sourceUrl: "https://www.maple.example/", name: "Maple Street Realty", logoUrl: "http://localhost:3100/demo/poster.svg", primaryColor: "#0f766e", accentColor: "#f59e0b" } } }),
  );
  await page.getByLabel("Website address").fill("maple.example");
  await page.getByLabel("Website address").press("Enter");
  await expect(page.getByTestId("brand-import-status")).toHaveText("Filled in the name, a logo and two colours from www.maple.example. Check them, then save the brand kit.");
  await expect(page.getByPlaceholder("Acme Realty")).toHaveValue("Maple Street Realty");
  await expect(page.getByLabel("Primary color", { exact: true })).toHaveValue("#0f766e");
  await expect(page.getByLabel("Accent color", { exact: true })).toHaveValue("#f59e0b");
  await expect(page.getByAltText("Logo preview")).toHaveAttribute("src", "http://localhost:3100/demo/poster.svg");
  expect((await (await page.request.get("/api/brand")).json()).brand?.name ?? "").not.toBe("Maple Street Realty");
  // A second site asks before replacing what is filled in; declining keeps it.
  await page.unroute("**/api/brand/import");
  await page.route("**/api/brand/import", (route) => route.fulfill({ json: { suggestion: { sourceUrl: "https://other.example/", name: "Other Co", primaryColor: "#dc2626" } } }));
  let asked = "";
  page.once("dialog", (d) => ((asked = d.message()), d.dismiss()));
  await page.getByLabel("Website address").fill("other.example");
  await page.getByRole("button", { name: "Fill in" }).click();
  await expect(page.getByTestId("brand-import-status")).toHaveText("Kept what you had; other.example offered nothing for the empty fields.");
  expect(asked).toBe("Replace your name and colours with the ones from other.example? Cancel keeps yours and fills in only what is empty.");
  await expect(page.getByPlaceholder("Acme Realty")).toHaveValue("Maple Street Realty");
  await expect(page.getByLabel("Primary color", { exact: true })).toHaveValue("#0f766e");
});

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
    await page.getByLabel(/Show all of it instead of cropping/).check();
    // A rule for one language ends in [Language]; a bracket that names none is pointed out by line, not saved.
    await page.getByLabel("Pronunciation", { exact: true }).fill("Nair = Nye-er\nNair = Naïr [French]\nSaaS = sass\nQ = queue [Klingon]");
    await page.getByRole("button", { name: "Save brand kit" }).click();
    await expect(page.getByText('Pronunciation, line 4: "Klingon" is not a language name (for example [French] or [Spanish]).')).toBeVisible();
    await page.getByLabel("Pronunciation", { exact: true }).fill("Nair = Nye-er\nNair = Naïr [French]\nSaaS = sass");
    // Terms to keep untranslated: one per line, repeats (ignoring case) dropped.
    await page.getByLabel("Never translate").fill("Acme Cloud\n\nacme cloud\nNimbus");
    // An uploaded logo, laid over the share player as a watermark.
    await page.locator('input[type="file"][accept*="image/svg+xml"]').setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG, "base64") });
    await expect(page.getByAltText("Logo preview")).toBeVisible();
    await page.getByLabel("Logo on the player").selectOption("bottom-right");
    await page.getByRole("button", { name: "Save brand kit" }).click();
    await expect(page.getByText(/^Saved /)).toBeVisible();
    const kit = (await (await page.request.get("/api/brand")).json()).brand;
    expect(kit.defaultBackground).toEqual({ type: "image", value: "https://example.com/brand-bg.jpg", fit: "contain" });
    expect(kit.pronunciations).toEqual([{ word: "Nair", sayAs: "Nye-er" }, { word: "Nair", sayAs: "Naïr", language: "French" }, { word: "SaaS", sayAs: "sass" }]);
    expect(kit.glossary).toEqual(["Acme Cloud", "Nimbus"]);
    expect(kit.watermark).toBe("bottom-right");
    expect(kit.logoUrl).toBe(`data:image/png;base64,${TINY_PNG}`);
    await page.reload();
    await expect(page.getByLabel("Pronunciation", { exact: true })).toHaveValue("Nair = Nye-er\nNair = Naïr [French]\nSaaS = sass");
    await expect(page.getByLabel("Never translate")).toHaveValue("Acme Cloud\nNimbus");
    await expect(page.getByLabel("Logo on the player")).toHaveValue("bottom-right");
    await expect(page.getByLabel(/Show all of it instead of cropping/)).toBeChecked();
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
  await expect(page.getByRole("button", { name: /^Move to a folder/ })).toContainText(folder);
  await page.getByRole("button", { name: /^Move to a folder/ }).click();
  await page.getByLabel("Folder name").fill("Archive");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /^Move to a folder/ })).toContainText("Archive");
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
  expect(dialogs).toEqual(["Folder name (leave empty to move to Unfiled)", "Move 1 video to the trash? You can restore it for 30 days.", "Delete this video for good? Its short clips, and the cleaned and lip-synced copies made from it, go too. This cannot be undone."]);
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
  const paths = ["/", "/login", "/home", "/create", "/agent", "/videos", `/videos/${v.id}`, "/templates", "/batch", "/avatars", "/voices", "/translate", "/cleanup", "/lipsync", "/music", "/cinematic", "/footage", "/photos", "/voice-changer", "/interactive", "/brand", "/settings", `/share/${v.id}`, `/talk/${agent.id}`, "/demo-consent"];
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
    ["/agent", "make videos"],
    ["/batch", "start batches"],
    ["/translate", "start translations"],
    ["/cleanup", "clean up recordings"],
    ["/lipsync", "lip-sync videos"],
    ["/music", "add music to videos"],
    ["/cinematic", "make cinematic shots"],
    ["/footage", "make clips"],
    ["/photos", "make photo shoots"],
    ["/voice-changer", "change voices or make new ones"],
    ["/avatars", "add or change avatars"],
    ["/voices", "clone, design, or change voices"],
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
  // Arriving by a photo shoot's "Make a presenter" link opens no panel for a viewer, nor even looks the photo up, where an
  // editor's would open on it; the address is cleaned.
  let lookedUp = 0;
  await page.route("**/api/shoots", (route) => {
    lookedUp++;
    return route.fulfill({ json: { available: true, shoots: [{ id: "sh_viewer", title: "Viewer shoot", status: "completed", photos: [{ url: `data:image/png;base64,${TINY_PNG}` }] }] } });
  });
  await page.goto("/avatars?shoot=sh_viewer&photo=1");
  await expect(page.getByTestId("view-only")).toBeVisible();
  await expect(page).toHaveURL(/\/avatars$/);
  await page.waitForTimeout(500);
  expect(lookedUp).toBe(0);
  await expect(page.getByLabel("Avatar name")).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: "upload a portrait instead" })).toHaveCount(0);
  await page.unroute("**/api/shoots");
  // A voice of the space's own is listed for the viewer, without rename or delete.
  const sample = "data:audio/webm;base64," + Buffer.from("viewer sees this voice").toString("base64");
  const own = (await (await page.request.post("/api/voices/clone", { data: { name: `Viewer hears ${Date.now().toString(36)}`, samples: [sample] } })).json()).voice as { id: string; name: string };
  await page.goto("/voices");
  await expect(page.getByTestId("voice-cloner")).toHaveCount(0);
  await expect(page.getByTestId("view-only")).toBeVisible();
  await expect(page.getByText(own.name, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Rename ${own.name}` })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Delete ${own.name}` })).toHaveCount(0);
  expect((await page.request.delete(`/api/voices/${own.id}`)).status()).toBe(204);
  // Starred avatars and voices are the workspace's, so a viewer gets no stars to click. The view-only notice
  // shows once the role is known, so the star checks below cannot pass merely because it is still loading.
  await expect(page.getByTestId("view-only")).toBeVisible();
  // With the role known to be a viewer's, the designer stays hidden too (it never shows before the role is known).
  await expect(page.getByTestId("voice-designer")).toHaveCount(0);
  await expect(page.getByText("Emma", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /to favourites$/ })).toHaveCount(0);
  // A photo avatar of the space is shown, but a viewer gets no rename, delete, new looks, or default voice for it.
  const svg = "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";
  const photo = (await (await page.request.post("/api/avatars", { data: { name: `Viewer sees ${Date.now().toString(36)}`, imageUrl: svg } })).json()).avatar as { id: string; name: string };
  await page.goto("/avatars");
  await expect(page.getByTestId("view-only")).toBeVisible();
  await expect(page.getByTestId("avatar-library")).toBeVisible();
  await expect(page.getByRole("button", { name: /to favourites$/ })).toHaveCount(0);
  await expect(page.getByTestId("avatar-library").getByText(photo.name)).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Rename |New looks of |Delete avatar)/ })).toHaveCount(0);
  await expect(page.getByLabel(/^Default voice for /)).toHaveCount(0);
  // Viewers see the workspace's twins, but cannot train one.
  await expect(page.getByRole("heading", { name: "Digital twins" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New digital twin" })).toHaveCount(0);
  expect((await page.request.delete(`/api/avatars/${photo.id}`)).status()).toBe(200);
  // The workspace's settings show, but only owners and editors can change them.
  await page.goto("/settings");
  await expect(page.getByTestId("settings-read-only")).toHaveCount(2);
  await expect(page.getByLabel("Webhook URL")).toBeDisabled();
  await expect(page.getByLabel("Notification email")).toBeDisabled();
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

test("a LiveAvatar session speaks each reply in the room once its avatar and agent have joined, and falls back when it ends", async ({ page }) => {
  // LiveAvatar is not reachable from tests: its status, session, and LiveKit's browser SDK are stood in for. The
  // stand-in room records what the page sends on its data channel, and the test decides who joins and when.
  await page.addInitScript(() => {
    const w = window as unknown as { __spoken: string[] };
    w.__spoken = [];
    if ("speechSynthesis" in window) window.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => void w.__spoken.push(u.text);
  });
  await page.route("**/api/status", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), streaming: "liveavatar" } });
  });
  await page.route("https://cdn.jsdelivr.net/npm/livekit-client@*/dist/livekit-client.umd.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.__published = []; window.__attached = [];
        window.LivekitClient = { Room: class {
          constructor() {
            this.handlers = {}; this.remoteParticipants = new Map();
            this.localParticipant = { publishData: async (data, opts) => { window.__published.push({ text: new TextDecoder().decode(data), topic: opts.topic, reliable: opts.reliable }); } };
            window.__room = this;
          }
          on(event, cb) { (this.handlers[event] ||= []).push(cb); return this; }
          emit(event, ...args) { for (const cb of this.handlers[event] || []) cb(...args); }
          join(identity) { const p = { identity }; this.remoteParticipants.set(identity, p); this.emit("participantConnected", p); }
          track(identity) { this.emit("trackSubscribed", { kind: "video", attach: () => window.__attached.push(identity) }, {}, { identity }); }
          async connect(url, token) { window.__joined = [url, token]; }
          async disconnect() { this.emit("disconnected"); }
        } };`,
    }),
  );
  const told: unknown[] = [];
  let closed = 0;
  await page.route("**/api/live", (route) =>
    route.fulfill({ json: { available: true, sessionId: "live_test", url: "wss://room.example", accessToken: "lk_token", expiresAt: new Date(Date.now() + 600_000).toISOString(), speakInRoom: true, waitFor: ["heygen", "liveavatar-agent-s1"] } }),
  );
  await page.route("**/api/live/live_test", async (route) => {
    if (route.request().method() === "DELETE") {
      closed++;
      return route.fulfill({ status: 204 });
    }
    told.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, spoken: false } });
  });
  type W = { __published: Array<{ text: string; topic: string; reliable: boolean }>; __spoken: string[]; __attached: string[]; __joined: string[]; __room: { join(id: string): void; track(id: string): void; emit(e: string, ...a: unknown[]): void } };
  const win = <T,>(fn: (w: W) => T) => page.evaluate((src) => new Function("w", `return (${src})(w)`)(window), fn.toString()) as Promise<T>;
  await page.goto("/interactive");
  await expect.poll(() => win((w) => w.__joined)).toEqual(["wss://room.example", "lk_token"]);
  await expect(page.getByText("connecting…")).toBeVisible();
  // Before the avatar and its agent are in the room, a reply is the browser's to say: nothing goes into the room.
  await page.getByLabel("Your message").fill("Hi there");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("[data-testid=chat-log] [data-role=assistant]")).toHaveCount(1);
  await expect.poll(() => win((w) => w.__spoken.length)).toBe(1);
  expect(await win((w) => w.__published.length)).toBe(0);
  await win((w) => w.__room.join("heygen"));
  await expect(page.getByText("Live", { exact: true })).toBeHidden();
  await win((w) => w.__room.join("liveavatar-agent-s1"));
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  // Only the avatar's own tracks are shown.
  await win((w) => (w.__room.track("liveavatar-agent-s1"), w.__room.track("heygen")));
  expect(await win((w) => w.__attached)).toEqual(["heygen"]);
  await page.getByLabel("Your message").fill("How much does it cost?");
  await page.keyboard.press("Enter");
  const reply = page.locator("[data-testid=chat-log] [data-role=assistant]").nth(1);
  await expect(reply).toContainText(/pricing/i);
  await expect.poll(() => win((w) => w.__published.length)).toBe(1);
  const [sent] = await win((w) => w.__published);
  expect([sent.topic, sent.reliable]).toEqual(["agent-control", true]);
  const command = JSON.parse(sent.text) as { event_id: string; event_type: string; text: string };
  expect(command.event_type).toBe("avatar.speak_text");
  expect(command.event_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(command.text).toBe((await reply.textContent())?.trim());
  await expect.poll(() => told).toEqual([{ text: command.text }]);
  expect(await win((w) => w.__spoken.length), "said in the room, not also by the browser").toBe(1);
  // LiveAvatar ends the session: the page stops showing it as live, closes it, and the browser speaks again.
  await win((w) => w.__room.emit("dataReceived", new TextEncoder().encode(JSON.stringify({ event_type: "session.stopped", stop_reason: "IDLE" })), undefined, undefined, "agent-response"));
  await expect(page.getByText("Live", { exact: true })).toBeHidden();
  await expect.poll(() => closed).toBe(1);
  await page.getByLabel("Your message").fill("Hi again");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-testid=chat-log] [data-role=assistant]")).toHaveCount(3);
  await expect.poll(() => win((w) => w.__spoken.length)).toBe(2);
  expect(await win((w) => w.__published.length)).toBe(1);
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

test("a voice provider that clones from one recording is sent the samples joined into one WAV", async ({ page }) => {
  // HeyGen clones from one WAV or MP3 recording; the page says so and joins the samples in order before sending.
  await page.route("**/api/status", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), voiceCloneOneRecording: true } });
  });
  let sent: string[] = [];
  await page.route("**/api/voices/clone", async (route) => {
    sent = route.request().postDataJSON().samples;
    await route.fulfill({ status: 201, json: { voice: { id: "joined_voice", name: "Joined", provider: "mock", source: "custom" } } });
  });
  await page.goto("/voices");
  const cloner = page.getByTestId("voice-cloner");
  await expect(cloner).toContainText("HeyGen clones from one recording");
  // A second of silence, then about three seconds of speech: joined in that order.
  await cloner.locator('input[type="file"]').setInputFiles(["e2e/fixtures/silence-1s.mp3", "e2e/fixtures/voice-over.mp3"]);
  await expect(cloner.getByRole("list", { name: "Samples" }).getByRole("listitem")).toHaveCount(2);
  await cloner.getByLabel("Voice name").fill("Joined");
  await cloner.getByRole("button", { name: "Clone voice" }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatch(/^data:audio\/wav;base64,/);
  // 16 kHz mono 16-bit: 32 kB a second after the 44-byte header.
  const pcm = (url: string) => {
    const bytes = Buffer.from(url.split(",")[1], "base64");
    expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
    return new Int16Array(bytes.buffer.slice(bytes.byteOffset + 44, bytes.byteOffset + bytes.length));
  };
  const joined = pcm(sent[0]);
  expect(joined.length / 16_000).toBeGreaterThan(3.8);
  expect(joined.length / 16_000).toBeLessThan(4.6);
  const loudness = (from: number, to: number) => joined.subarray(from * 16_000, to * 16_000).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  expect(loudness(0, 0.9)).toBeLessThan(200);
  expect(loudness(1.3, 3.5)).toBeGreaterThan(2000);
  // A long sample is cut at a minute and a half, so the request stays within one upload.
  sent = [];
  await cloner.locator('input[type="file"]').setInputFiles("e2e/fixtures/tone-95s.mp3");
  await cloner.getByLabel("Voice name").fill("Long");
  await cloner.getByRole("button", { name: "Clone voice" }).click();
  await expect.poll(() => sent.length).toBe(1);
  const long = pcm(sent[0]).length / 16_000;
  expect(long).toBeGreaterThan(89.9);
  expect(long).toBeLessThanOrEqual(90.01);
});

test("the voice cloner caps its samples, announces the clone, and keeps the keyboard's place", async ({ page }) => {
  await page.goto("/voices");
  const cloner = page.getByTestId("voice-cloner");
  const mp3 = "e2e/fixtures/voice-over.mp3";
  const input = cloner.locator('input[type="file"]');
  await input.setInputFiles([mp3, mp3, mp3, mp3]);
  await expect(cloner.getByRole("listitem")).toHaveCount(4);
  // Five at most, however they are picked; the rest are left out with a reason.
  await input.setInputFiles([mp3, mp3, mp3]);
  await expect(cloner.getByRole("listitem")).toHaveCount(5);
  await expect(cloner.getByText("Up to 5 samples; the rest were left out.")).toBeVisible();
  // Removing one moves the focus to the sample that took its place, and the same file can be picked again.
  await cloner.getByRole("button", { name: "Remove voice-over.mp3" }).first().focus();
  await page.keyboard.press("Enter");
  await expect(cloner.getByRole("listitem")).toHaveCount(4);
  await expect(cloner.getByRole("button", { name: "Remove voice-over.mp3" }).first()).toBeFocused();
  for (let i = 0; i < 4; i++) await cloner.getByRole("button", { name: "Remove voice-over.mp3" }).first().click();
  await expect(cloner.getByRole("button", { name: "Upload" })).toBeFocused();
  await input.setInputFiles(mp3);
  await expect(cloner.getByRole("listitem")).toHaveCount(1);
  const name = `Announced ${Date.now().toString(36)}`;
  await cloner.getByLabel("Voice name").fill(name);
  await cloner.getByRole("button", { name: "Clone voice" }).click();
  await expect(cloner.getByRole("status")).toHaveText(`${name} is cloned and listed with your voices.`);
  await expect(cloner.getByLabel("Voice name")).toBeFocused();
  const voice = ((await (await page.request.get("/api/voices")).json()).voices as Array<{ id: string; name: string }>).find((v) => v.name === name)!;
  expect((await page.request.delete(`/api/voices/${voice.id}`)).status()).toBe(204);
  // More than a request can carry is refused with the reason, not as malformed JSON.
  const big = await page.request.post("/api/voices/clone", { data: { name: "Big", samples: ["data:audio/webm;base64," + "A".repeat(5_000_000)] } });
  expect(big.status()).toBe(400);
  const refused = (await big.json()) as { error: string; issues?: Array<{ message: string }> };
  expect(refused.issues?.[0]?.message ?? refused.error).toMatch(/under 3 MB in total|too large/);
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
  // Removing a line is an unsaved change like any other, so "saved" no longer shows.
  await editor.getByRole("button", { name: "Remove line 2" }).click();
  await expect(editor.getByTestId("caption-status")).not.toHaveText("Captions saved");
  await editor.getByRole("button", { name: "Save captions" }).click();
  await expect(editor.getByTestId("caption-status")).toHaveText("Captions saved");
  expect(await (await page.request.get(`/api/videos/${v.id}/captions`)).text()).not.toContain("A line of my own.");

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

test("a copy keeps its own unsent draft, apart from the editor's", async ({ page }) => {
  const made = await page.request.post("/api/videos", { data: { title: "Original tour", script: "The original words.", avatarId: "stock_1", voiceId: "stock_voice_1" } });
  const id = ((await made.json()) as { video: { id: string } }).video.id;
  // An unsent draft in the editor.
  await page.locator("input[placeholder='Video title']").fill("My own draft");
  await page.locator("textarea").fill("Words I was writing.");
  await page.waitForTimeout(600);
  // Edit a copy, then reload: the copy's edits come back, not the original.
  await page.goto(`/create?from=${id}`);
  await expect(page.locator("textarea")).toHaveValue("The original words.");
  await page.locator("textarea").fill("The copy, edited.");
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.locator("textarea")).toHaveValue("The copy, edited.");
  await expect(page.getByText(/Restored your unsent draft/)).toBeVisible();
  // The editor's own draft is untouched.
  await page.goto("/create");
  await expect(page.locator("input[placeholder='Video title']")).toHaveValue("My own draft");
  await expect(page.locator("textarea")).toHaveValue("Words I was writing.");
});

test("find and replace changes every scene's script, pause markers left whole", async ({ page }) => {
  const box = page.locator("textarea");
  await box.fill("Welcome to 12 Maple Street. [pause 2s] Maple trees line it.");
  await page.getByRole("button", { name: "Add scene" }).click();
  await box.fill("Call about Maple Street today.");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByLabel("Find", { exact: true })).toBeFocused();
  await page.getByLabel("Find", { exact: true }).fill("maple street");
  await expect(page.getByTestId("find-status")).toHaveText("2 matches in 2 scenes");
  await page.getByLabel("Replace with").fill("Oak Lane");
  await page.getByLabel("Replace with").press("Enter");
  await expect(page.getByTestId("find-status")).toHaveText("Replaced 2 matches.");
  await expect(box).toHaveValue("Call about Oak Lane today.");
  // It can be taken back while nothing else has changed.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(box).toHaveValue("Call about Maple Street today.");
  await expect(page.getByTestId("find-status")).toHaveText("2 matches in 2 scenes");
  await page.getByRole("button", { name: "Replace all" }).click();
  await expect(box).toHaveValue("Call about Oak Lane today.");
  // Typing in a script afterwards retires the note and the Undo.
  await box.press("End");
  await box.type(" Thanks.");
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeHidden();
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await expect(box).toHaveValue("Welcome to 12 Oak Lane. [pause 2s] Maple trees line it.");
  // A search never reaches into a pause marker.
  await page.getByLabel("Find", { exact: true }).fill("pause");
  await expect(page.getByTestId("find-status")).toHaveText("No matches");
  await expect(page.getByRole("button", { name: "Replace all" })).toBeDisabled();
  // Enter in the search moves on to the replacement.
  await page.getByLabel("Find", { exact: true }).fill("Oak");
  await page.getByLabel("Find", { exact: true }).press("Enter");
  await expect(page.getByLabel("Replace with")).toBeFocused();
  // A replacement that would take the video past its 5000 characters is refused, and nothing changes.
  const long = Array(400).fill("Oak").join(" ");
  await box.fill(long);
  await page.getByLabel("Replace with").fill("Oakwood Heights");
  await page.getByRole("button", { name: "Replace all" }).click();
  await expect(page.getByTestId("find-status")).toHaveText(/^Not replaced: the script would be \d+ of 5000 characters$/);
  await expect(box).toHaveValue(long);
  // A refusal has nothing to undo, and the note goes once the scripts change.
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeHidden();
  await box.fill(Array(399).fill("Oak").join(" "));
  await expect(page.getByTestId("find-status")).toHaveText("400 matches in 2 scenes");
  // On-screen text is not searched, and the panel says so.
  await expect(page.getByText("is not changed")).toHaveCount(0);
  await page.getByLabel("On-screen text for scene 1").fill("Oak Lane open house");
  await expect(page.getByText("Searches the typed scripts; on-screen text is not changed.")).toBeVisible();
  await expect(page.getByLabel("Find", { exact: true })).toHaveAttribute("aria-describedby", "find-skipped");
  await page.getByLabel("Find", { exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "Find and replace" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Find", exact: true })).toBeFocused();
});

test("a scene of only pauses is a silent one, held without a word", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill(`Silent ${Date.now().toString(36)}`);
  const box = page.locator("textarea");
  // A video of nothing but silence has nothing to say.
  await box.fill("[pause 2s]");
  await expect(page.getByText("Every scene is silent; give at least one some words")).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate video" })).toBeDisabled();
  await box.fill("Welcome home.");
  await page.getByRole("button", { name: "Add scene" }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(box).toHaveValue("[pause 1s] ");
  await box.fill("[pause 4s]");
  await expect(page.getByTestId("script-length")).toHaveText("Silent scene: the presenter holds for 4s · ~5s total");
  await page.getByRole("button", { name: "Generate video" }).click();
  await page.waitForURL(/\/videos\/vid_/);
  const id = page.url().split("/videos/")[1].split(/[?#]/)[0];
  const video = (await (await page.request.get(`/api/videos/${id}`)).json()).video;
  expect(video.scenes.map((sc: { script: string }) => sc.script)).toEqual(["Welcome home.", "[pause 4s]"]);
  await expect(page.getByText(/silent for 4s/)).toBeVisible();
});

test("a scene can show text on screen, placed, sized, and coloured, and a copy keeps it", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill(`On screen ${Date.now().toString(36)}`);
  await page.locator("textarea").fill("Welcome to the open house.");
  const text = page.getByLabel("On-screen text");
  await text.fill("12 Maple Street");
  const stage = page.getByTestId("stage-text");
  await expect(stage).toHaveText("12 Maple Street");
  await expect(stage).toHaveAttribute("data-position", "top");
  await page.getByLabel("Text position").selectOption("bottom");
  await page.getByLabel("Text size").selectOption("large");
  await page.getByLabel("Text colour").fill("#facc15");
  await expect(stage).toHaveAttribute("data-position", "bottom");
  await expect(stage).toHaveCSS("color", "rgb(250, 204, 21)");
  // Another scene starts without text; clearing a field removes the text from its scene.
  await page.getByRole("button", { name: "Add scene" }).click();
  await page.locator("textarea").fill("Priced to sell.");
  await expect(page.getByTestId("stage-text")).toHaveCount(0);
  await expect(page.getByLabel("On-screen text for scene 2")).toHaveValue("");
  await page.getByLabel("On-screen text for scene 2").fill("Gone soon");
  await page.getByLabel("On-screen text for scene 2").fill("");
  await expect(page.getByLabel("Text position")).toHaveCount(0);
  await page.getByRole("button", { name: "Generate video" }).click();
  await page.waitForURL(/\/videos\/vid_/);
  const id = page.url().split("/videos/")[1].split(/[?#]/)[0];
  const video = (await (await page.request.get(`/api/videos/${id}`)).json()).video;
  expect(video.scenes.map((sc: { overlay?: unknown }) => sc.overlay)).toEqual([{ text: "12 Maple Street", position: "bottom", size: "large", color: "#facc15" }, undefined]);
  await expect(page.getByText(/text “12 Maple Street”/)).toBeVisible();
  // A copy opens with the scene's text in the editor.
  await page.goto(`/create?from=${id}`);
  await expect(page.getByLabel("On-screen text for scene 1")).toHaveValue("12 Maple Street");
  await expect(page.getByTestId("stage-text")).toHaveAttribute("data-position", "bottom");
});

test("on-screen text survives a reload, a voice that is gone, and warns when it will not fit one line", async ({ page }) => {
  // Text typed before any script is a draft worth keeping.
  await page.getByLabel("On-screen text").fill("Coming soon");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("avatar-studio:draft") ?? "{}").scenes?.[0]?.overlay?.text)).toBe("Coming soon");
  // A scene whose own voice no longer exists loses the voice, not its text.
  await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("avatar-studio:draft") ?? "{}");
    d.scenes = [{ script: "Welcome.", background: { type: "color", value: "#0f172a" }, voiceId: "voice_gone", overlay: { text: "12   Maple Street", position: "bottom" } }];
    localStorage.setItem("avatar-studio:draft", JSON.stringify(d));
  });
  await page.reload();
  await expect(page.getByLabel("On-screen text")).toHaveValue("12   Maple Street");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("avatar-studio:draft") ?? "{}").scenes?.[0]?.voiceId ?? null)).toBeNull();
  await expect(page.getByLabel("On-screen text")).toHaveValue("12   Maple Street");
  // The stage shows it as it renders: spaces collapsed, on one line.
  await expect(page.getByTestId("stage-text")).toHaveText("12 Maple Street");
  await expect(page.getByText("Too long for one line")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^9:16/ }).click();
  await page.getByLabel("Text size").selectOption("large");
  await page.getByLabel("On-screen text").fill("Dana Lee, Listing agent at Maple Realty");
  await expect(page.getByText(/Too long for one line across a 9:16 frame/)).toBeVisible();
  await page.getByLabel("Text size").selectOption("small");
  await page.getByLabel("On-screen text").fill("Dana Lee, Listing agent");
  await expect(page.getByText("Too long for one line")).toHaveCount(0);
  // A full field takes no more: a key typed in the middle changes nothing, and the end is not lost.
  const field = page.getByLabel("On-screen text");
  const full = `${"x".repeat(119)}Z`;
  await field.fill(full);
  await field.evaluate((el: HTMLInputElement) => el.setSelectionRange(60, 60));
  await page.keyboard.type("Q");
  await expect(field).toHaveValue(full);
  await expect(page.getByText("120/120 characters, shown on one line")).toBeVisible();
  await expect.poll(() => field.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(60);
});

test("a multi-scene video has chapters: the share page jumps to a scene and the video page copies them for YouTube", async ({ page, context }) => {
  const bg = { type: "color", value: "#0f172a" };
  const v = await createVideoViaApi(page, `Chapters ${Date.now().toString(36)}`, {
    script: undefined,
    scenes: [
      { script: "Welcome to twelve Maple Street, a bright family home on a quiet road.", background: bg, overlay: { text: "12 Maple Street" } },
      { script: "The kitchen was redone last spring with quartz counters and an island.", background: bg },
      { script: "Call Dana to book a showing this weekend.", background: bg },
    ],
  });
  // Listed on the video page before it renders, with estimated times.
  await page.goto(`/videos/${v.id}`);
  const list = page.getByTestId("video-chapters");
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(list.getByRole("listitem").first()).toHaveText("0:0012 Maple Street");
  await expect(page.getByText("Times are estimated until the video renders.")).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.reload();
  await page.getByRole("button", { name: "Copy for YouTube" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.split("\n")).toHaveLength(3);
  expect(copied).toMatch(/^0:00 12 Maple Street\n\d+:\d\d The kitchen was redone last spring with quartz counters and…\n\d+:\d\d Call Dana to book a showing this weekend\.$/);

  await page.goto(`/share/${v.id}`);
  const chapters = page.getByTestId("share-chapters");
  await expect(page.getByRole("heading", { name: "Chapters", exact: true })).toBeVisible();
  await expect(chapters.getByRole("button")).toHaveCount(3);
  await expect(chapters.getByRole("button").first()).toHaveAttribute("aria-current", "true");
  const player = page.getByTestId("share-player");
  await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(1);
  const duration = await player.evaluate((el: HTMLVideoElement) => el.duration);
  const thirdStart = Number(/^(\d+):(\d\d)/.exec(copied.split("\n")[2])!.slice(1).reduce((m, s) => String(Number(m) * 60 + Number(s))));
  await chapters.getByRole("button").nth(2).click();
  await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThanOrEqual(Math.min(thirdStart, duration) - 0.25);
  await player.evaluate((el: HTMLVideoElement) => el.pause());
  // Where the player stopped decides the chapter marked; seeking back to the start marks the first.
  await player.evaluate((el: HTMLVideoElement) => (el.currentTime = 0));
  await expect(chapters.getByRole("button").first()).toHaveAttribute("aria-current", "true");
  await expect(chapters.locator('[aria-current="true"]')).toHaveCount(1);
  // On a phone the chapter titles are cut with an ellipsis rather than pushing the page sideways.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.reload();
  await expect(chapters.getByRole("button")).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("a video can be made in other sizes, each a new video with the same scenes", async ({ page }) => {
  const bg = { type: "color", value: "#0f172a" };
  const sizesTitle = `Sizes ${Date.now().toString(36)}`;
  const v = await createVideoViaApi(page, sizesTitle, {
    script: undefined,
    aspect: "16:9",
    scenes: [
      { script: "Welcome to twelve Maple Street.", background: bg, overlay: { text: "Dana Lee, Listing agent at Maple Realty", size: "large" } },
      { script: "Call Dana to book a showing.", background: bg },
    ],
  });
  await page.goto(`/videos/${v.id}`);
  await expect(page.getByRole("heading", { name: "Other sizes" })).toBeVisible();
  // The text that would run off a portrait frame is named before anything renders.
  await expect(page.getByText("On-screen text in scene 1 may not fit one line at 9:16.")).toBeVisible();
  await page.getByLabel("1:1 square").uncheck();
  await page.getByRole("button", { name: "Make 1 size" }).click();
  const made = page.getByTestId("other-sizes").getByRole("link");
  await expect(made).toHaveText(/ \(9:16\)$/);
  // Focus moves to the size just made, and a size the video has is not offered again, after a reload too.
  await expect(made).toBeFocused();
  await expect(page.getByLabel("9:16 portrait")).toHaveCount(0);
  // The card asks again while the size renders, so it stops saying so without a reload.
  await expect(page.getByTestId("other-sizes")).toContainText("rendering");
  await expect(page.getByTestId("other-sizes")).not.toContainText("rendering", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Make 1 size" })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("other-sizes").getByRole("link")).toHaveText(/ \(9:16\)$/);
  // The card has loaded (it offers the square) before the portrait's absence means anything.
  await expect(page.getByLabel("1:1 square")).toBeVisible();
  await expect(page.getByLabel("9:16 portrait")).toHaveCount(0);
  await made.click();
  await page.waitForURL((url) => /\/videos\/vid_/.test(url.pathname) && !url.pathname.endsWith(v.id));
  await expect(page.getByText("Made from")).toBeVisible();
  const id = page.url().split("/videos/")[1].split(/[?#]/)[0];
  const copy = (await (await page.request.get(`/api/videos/${id}`)).json()).video;
  expect(copy.aspect).toBe("9:16");
  expect(copy.resizedFrom).toBe(v.id);
  expect(copy.scenes.map((sc: { script: string }) => sc.script)).toEqual(["Welcome to twelve Maple Street.", "Call Dana to book a showing."]);
  // A copy offers only the shape still missing: never the original's own.
  await expect(page.getByLabel("1:1 square")).toBeVisible();
  await expect(page.getByLabel("16:9 landscape")).toHaveCount(0);
  // Made from the copy, the square is linked beside the original, and the focus goes to it, not the first link.
  await page.getByRole("button", { name: "Make 1 size" }).click();
  await expect(page.getByRole("link", { name: `${sizesTitle} (1:1)` })).toBeFocused();
  await expect(page.getByText("This video has every size.")).toBeVisible();
  await page.getByRole("link", { name: sizesTitle, exact: true }).first().click();
  await page.waitForURL(new RegExp(`/videos/${v.id}`));
});

test("a script the AI writer replaced can be taken back", async ({ page }) => {
  const box = page.locator("textarea");
  await box.fill("My own words about the open house.");
  await page.getByRole("button", { name: "Write with AI" }).click();
  await page.getByPlaceholder(/What is the video about/).fill("an open house this weekend");
  await page.getByRole("button", { name: "Write script" }).click();
  await expect(box).not.toHaveValue("My own words about the open house.");
  await expect(box).toBeFocused();
  await expect(page.getByText("Written by AI.")).toBeVisible();
  await page.getByRole("button", { name: "Undo the rewrite" }).click();
  await expect(box).toHaveValue("My own words about the open house.");
  await expect(page.getByRole("button", { name: "Undo the rewrite" })).toHaveCount(0);
});

test("a rewrite follows its scene when it moves, and is refused only when that scene was edited", async ({ page }) => {
  const box = page.locator("textarea");
  await box.fill("Hi there! One. Two. Three. Four.");
  await page.getByRole("button", { name: "Add scene" }).click();
  await box.fill("The second scene's own words.");
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  // Each answer is held until the scenes have been changed.
  let release!: () => void;
  let held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/script", async (route) => {
    await held;
    await route.continue();
  });
  await page.getByRole("button", { name: "Improve" }).click();
  await page.getByRole("button", { name: "Shorten", exact: true }).click();
  await page.getByRole("button", { name: "Move scene right" }).click();
  // Moved to the end, the focus goes to the button that can still move it.
  await expect(page.getByRole("button", { name: "Move scene left" })).toBeFocused();
  release();
  // The rewrite lands on the scene it was asked for, now the second, and the other keeps its own words.
  await expect(page.getByText("Rewritten.")).toBeVisible();
  await expect(box).toHaveValue("Hi there! One. Two.");
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await expect(box).toHaveValue("The second scene's own words.");
  // Typed in while the answer comes, the scene keeps what was typed and says why the rewrite was not applied.
  held = new Promise<void>((resolve) => (release = resolve));
  await page.getByRole("button", { name: "Improve" }).click();
  await page.getByRole("button", { name: "Shorten", exact: true }).click();
  await box.fill("Words typed meanwhile.");
  release();
  await expect(page.getByRole("alert").filter({ hasText: "The scene changed while it was being rewritten" })).toBeVisible();
  await expect(box).toHaveValue("Words typed meanwhile.");
  await expect(page.getByRole("button", { name: "Undo the rewrite" })).toHaveCount(0);
});

test("a rewrite of one scene leaves the scene being typed in selected", async ({ page }) => {
  const box = page.locator("textarea");
  await box.fill("Hi there! One. Two. Three. Four.");
  await page.getByRole("button", { name: "Add scene" }).click();
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/script", async (route) => {
    await held;
    await route.continue();
  });
  await page.getByRole("button", { name: "Improve" }).click();
  await page.getByRole("button", { name: "Shorten", exact: true }).click();
  // The user moves on to the second scene and types there while the answer comes.
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await box.fill("Typing in the second scene");
  release();
  await expect(page.getByRole("button", { name: /^Scene 1, about/ })).toBeVisible();
  await page.waitForTimeout(300);
  // Still on the second scene, with what was typed; the first has its rewrite.
  await expect(page.getByRole("button", { name: /^Scene 2,/ })).toHaveAttribute("aria-current", "true");
  await box.press("End");
  await box.pressSequentially(" still here.");
  await expect(box).toHaveValue("Typing in the second scene still here.");
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await expect(box).toHaveValue("Hi there! One. Two.");
});

test("the AI writer fills the empty scene it was opened on, even after it moves past another empty one", async ({ page }) => {
  await page.getByRole("button", { name: "Add scene" }).click();
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/script", async (route) => {
    await held;
    await route.continue();
  });
  await page.getByRole("button", { name: "Write with AI" }).click();
  await page.getByPlaceholder(/What is the video about/).fill("an open house this weekend");
  await page.getByRole("button", { name: "Write script" }).click();
  await page.getByRole("button", { name: "Move scene right" }).click();
  release();
  // The written scene is now the second; the first is the other empty scene, still empty.
  await expect(page.getByRole("button", { name: /^Scene 2, about/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Scene 1, empty/ })).toBeVisible();
});

test("a voice can be designed from a description, chosen from previews, and kept", async ({ page }) => {
  await page.goto("/voices");
  const designer = page.getByTestId("voice-designer");
  const design = designer.getByRole("button", { name: "Design previews" });
  await designer.getByLabel("Describe the voice").fill("Warm voice");
  await expect(design).toBeDisabled();
  await designer.getByRole("button", { name: "Documentary voice" }).click();
  await expect(designer.getByLabel("Describe the voice")).toHaveValue(/documentary narrator/);
  // A sample of the account's own must be long enough for the previews to read.
  await designer.getByLabel("Sample text (optional)").fill("Too short.");
  await expect(designer.getByText(/at least 100 characters to read \(10 so far\)/)).toBeVisible();
  await expect(design).toBeDisabled();
  await designer.getByLabel("Sample text (optional)").fill("");
  await design.click();
  const previews = designer.getByTestId("voice-previews");
  await expect(previews.getByRole("radio")).toHaveCount(3);
  await expect(previews.getByRole("radio").first()).toBeFocused();
  await expect(previews.getByRole("button", { name: "Play preview 2" })).toBeVisible();
  const save = designer.getByRole("button", { name: "Save voice" });
  await expect(save).toBeDisabled();
  await expect(designer.getByTestId("own-voices")).toHaveText("0 of 5 voices of your own used.");
  await previews.getByRole("radio", { name: "Preview 2" }).check();
  // As long a name as a voice may have (60 characters), to see it fits a phone screen too.
  const name = `Narrator ${Date.now().toString(36)}`.padEnd(60, " x").slice(0, 60).trimEnd();
  await designer.getByLabel("Name for the voice").fill(name);
  try {
    await save.click();
    await expect(designer.getByRole("status")).toContainText(`Saved "${name}"`);
    await expect(previews).toHaveCount(0);
    // The focus goes back to the description rather than being lost with the Save button.
    await expect(designer.getByLabel("Describe the voice")).toBeFocused();
    // Listed with the account's own voices, ready for any video.
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    const voices = (await (await page.request.get("/api/voices")).json()).voices as Array<{ id: string; name: string; tags?: string[] }>;
    expect(voices.find((v) => v.name === name)?.tags).toEqual(["designed voice"]);
    await expect(designer.getByTestId("own-voices")).toHaveText("1 of 5 voices of your own used.");
    await page.setViewportSize({ width: 390, height: 844 });
    const del = page.getByRole("button", { name: `Delete ${name}` });
    await del.scrollIntoViewIfNeeded();
    const box = (await del.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await page.locator("main").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  } finally {
    // Kept or not, the voice goes, so it never counts toward the account's five in later tests.
    const voices = (await (await page.request.get("/api/voices")).json()).voices as Array<{ id: string; name: string }>;
    for (const v of voices.filter((x) => x.name === name)) await page.request.delete(`/api/voices/${v.id}`);
  }
});

test("a presenter can be drawn from a description and kept as a photo avatar", async ({ page }) => {
  await page.goto("/avatars");
  const opener = page.getByRole("button", { name: "New photo avatar" });
  await opener.click();
  const name = `Drawn ${Date.now().toString(36)}`;
  await page.getByLabel("Avatar name").fill(name);
  // Escape asks before a name or picture is thrown away; declined, the panel stays as it was.
  page.once("dialog", (d) => void d.dismiss());
  await page.getByLabel("Avatar name").press("Escape");
  await expect(page.getByLabel("Avatar name")).toHaveValue(name);
  // The upload is a button too, for the keyboard.
  await expect(page.getByRole("button", { name: "Upload a portrait" })).toBeVisible();
  const generator = page.getByTestId("portrait-generator");
  const draw = generator.getByRole("button", { name: "Draw presenter" });
  await generator.getByLabel("Or describe a presenter").fill("A woman");
  await expect(draw).toBeDisabled();
  await generator.getByRole("button", { name: "Use an example" }).click();
  await draw.click();
  await expect(generator.getByRole("status")).toContainText("The portrait is in the preview");
  // The Draw button was disabled while it ran; the outcome has the focus instead of the page.
  await expect(generator.getByRole("status")).toBeFocused();
  await expect(page.getByRole("img", { name: "Portrait preview" })).toHaveAttribute("src", /^data:image\/svg\+xml/);
  await page.getByRole("button", { name: "Create avatar" }).click();
  try {
    await expect(page.getByRole("img", { name, exact: true })).toBeVisible();
    // The panel has gone; the focus is back on the button that opened it.
    await expect(opener).toBeFocused();
    await opener.click();
    // Escape belongs to the panel: from inside it, an untouched panel closes without asking.
    await page.getByLabel("Avatar name").press("Escape");
    await expect(page.getByLabel("Avatar name")).toHaveCount(0);
    await expect(opener).toBeFocused();
    // The API refuses a description too short to draw from.
    expect((await page.request.post("/api/avatars/generate", { data: { name, prompt: "Short" } })).status()).toBe(400);
  } finally {
    const avatars = (await (await page.request.get("/api/avatars")).json()).avatars as Array<{ id: string; name: string }>;
    for (const a of avatars.filter((x) => x.name === name)) await page.request.delete(`/api/avatars/${a.id}`);
  }
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

test("a dub can be made at precision, without the music, and with cleaner speech", async ({ page }) => {
  const tag = Date.now().toString(36);
  await page.goto("/translate");
  await page.getByPlaceholder("https://…/video.mp4").fill("https://cdn.example.com/podcast.mp4");
  await page.getByLabel("Quality").selectOption("precision");
  await page.getByLabel("Remove background music").check();
  await page.getByLabel("Enhance speech").check();
  await page.getByLabel("Title (optional)").fill(`Podcast ${tag}`);
  await page.getByRole("button", { name: "Translate video" }).click();
  const card = page.locator("div", { has: page.getByText(`Podcast ${tag}`, { exact: true }) }).getByTestId("translation-meta").first();
  await expect(card).toContainText("→ Spanish · precision · no music · enhanced speech");
  // They are preferences, so they stay set for the next video.
  await expect(page.getByLabel("Quality")).toHaveValue("precision");
  await expect(page.getByLabel("Remove background music")).toBeChecked();
  const list = (await (await page.request.get("/api/translate")).json()).translations as Array<{ title: string; quality?: string; removeMusic?: boolean; enhanceSpeech?: boolean }>;
  const made = list.find((t) => t.title === `Podcast ${tag}`);
  expect([made?.quality, made?.removeMusic, made?.enhanceSpeech]).toEqual(["precision", true, true]);
  expect((await page.request.post("/api/translate", { data: { title: "Bad", sourceVideoUrl: "https://cdn.example.com/v.mp4", targetLanguage: "French", quality: "best" } })).status()).toBe(400);
});

test("a dub can be proofread: the translated lines are corrected before the dub is made", async ({ page }) => {
  const tag = Date.now().toString(36);
  const title = `Proofread ${tag}`;
  await page.goto("/translate");
  await page.getByPlaceholder("https://…/video.mp4").fill("https://cdn.example.com/launch.mp4");
  await page.getByLabel("Proofread the lines first").check();
  await page.getByLabel("Title (optional)").fill(title);
  await page.getByRole("button", { name: "Translate video" }).click();
  const card = page.getByTestId("translation").filter({ has: page.getByText(title, { exact: true }) });
  await expect(card.getByTestId("translation-meta")).toContainText("→ Spanish · proofread");
  // The page polls until the lines are translated.
  await expect(card.getByText("Ready to proofread")).toBeVisible({ timeout: 20_000 });
  const editor = card.getByTestId("proofread");
  await expect(editor.getByLabel("Line 1")).toHaveValue("Hola y bienvenidos a Avatar Studio.");
  await editor.getByLabel("Line 2").fill("En un minuto te enseño cómo se hace un video.");
  await editor.getByRole("button", { name: "Save corrections" }).click();
  await expect(editor.getByText("Saved")).toBeVisible();
  await page.reload();
  await expect(card.getByTestId("proofread").getByLabel("Line 2")).toHaveValue("En un minuto te enseño cómo se hace un video.");
  // A blank line cannot be dubbed.
  await card.getByTestId("proofread").getByLabel("Line 3").fill(" ");
  await expect(card.getByRole("button", { name: "Approve and dub" })).toBeDisabled();
  await card.getByTestId("proofread").getByLabel("Line 3").fill("¡Empecemos!");
  await card.getByRole("button", { name: "Approve and dub" }).click();
  await expect(card.getByTestId("proofread")).toHaveCount(0);
  await expect(card.getByText("Processing")).toBeVisible();

  const list = (await (await page.request.get("/api/translate")).json()).translations as Array<Record<string, unknown> & { id: string; title: string }>;
  const made = list.find((t) => t.title === title)!;
  expect(made.providerJobId).toBeTruthy();
  expect(made.proofreadStage).toBeUndefined();
  expect((made.proofreadCues as Array<{ text: string }>).map((c) => c.text)).toEqual(["Hola y bienvenidos a Avatar Studio.", "En un minuto te enseño cómo se hace un video.", "¡Empecemos!"]);
  expect(list.some((t) => "proofreadToken" in t)).toBe(false);
  // The lines are closed once the dub has started, and the SRT link needs the job's secret.
  expect((await page.request.post(`/api/translate/${made.id}/dub`)).status()).toBe(409);
  expect((await page.request.patch(`/api/translate/${made.id}`, { data: { lines: ["a", "b", "c"] } })).status()).toBe(409);
  expect((await page.request.get(`/api/translate/${made.id}/srt?token=wrong`)).status()).toBe(404);
});

test("a dub can follow the brand glossary: terms kept as written and fixed translations", async ({ page }) => {
  const tag = Date.now().toString(36);
  const before = (await (await page.request.get("/api/brand")).json()).brand;
  try {
    expect((await page.request.put("/api/brand", { data: { ...(before ?? {}), name: before?.name ?? "Acme", primaryColor: before?.primaryColor ?? "#0f766e", glossary: ["Acme Cloud", "Zeno"] } })).ok()).toBe(true);
    // The rules are written on the brand page, one per line; a line it cannot read is pointed out.
    await page.goto("/brand");
    const rules = page.getByLabel("Always translate as");
    await rules.fill("free trial = prueba gratis [Spanish]\nCEO PDG");
    await page.getByRole("button", { name: "Save brand kit" }).click();
    await expect(page.getByText("Always translate, line 2: write it as term = translation")).toBeVisible();
    await rules.fill("free trial = prueba gratis [Spanish]\nCEO = PDG [French]");
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/brand") && r.request().method() === "PUT");
    await page.getByRole("button", { name: "Save brand kit" }).click();
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await expect(page.getByLabel("Always translate as")).toHaveValue("free trial = prueba gratis [Spanish]\nCEO = PDG [French]");

    await page.goto("/translate");
    const keep = page.getByLabel(/Follow the brand glossary/);
    await expect(keep).toBeChecked();
    await expect(page.getByText(/Acme Cloud, Zeno stay untranslated\. 2 terms are always translated one way/)).toBeVisible();
    await page.getByPlaceholder("https://…/video.mp4").fill("https://cdn.example.com/launch.mp4");
    await page.getByLabel("Title (optional)").fill(`Glossary ${tag}`);
    await page.getByRole("button", { name: "Translate video" }).click();
    const card = page.getByTestId("translation").filter({ has: page.getByText(`Glossary ${tag}`, { exact: true }) });
    // Only the Spanish rule is for this dub's language.
    await expect(card.getByTestId("translation-meta")).toContainText("→ Spanish · keeps 2 brand terms · 1 fixed translation");
    // Turned off, the next dub keeps none.
    await keep.uncheck();
    await page.getByPlaceholder("https://…/video.mp4").fill("https://cdn.example.com/launch.mp4");
    await page.getByLabel("Title (optional)").fill(`Plain ${tag}`);
    await page.getByRole("button", { name: "Translate video" }).click();
    const plain = page.getByTestId("translation").filter({ has: page.getByText(`Plain ${tag}`, { exact: true }) });
    await expect(plain.getByTestId("translation-meta")).toBeVisible();
    await expect(plain.getByTestId("translation-meta")).not.toContainText("brand term");
    await expect(plain.getByTestId("translation-meta")).not.toContainText("fixed translation");
  } finally {
    const restored = before ? await page.request.put("/api/brand", { data: before }) : await page.request.delete("/api/brand");
    expect(restored.ok()).toBe(true);
  }
});

test("brand defaults reach the batch and interactive pages, and Ctrl+Enter renders with the settings on screen", async ({ page }) => {
  const before = (await (await page.request.get("/api/brand")).json()).brand;
  const avatars = ((await (await page.request.get("/api/avatars")).json()).avatars as Array<{ id: string; name: string }>);
  const voices = ((await (await page.request.get("/api/voices")).json()).voices as Array<{ id: string }>);
  const avatar = avatars[3];
  const voice = voices[2];
  try {
    expect((await page.request.put("/api/brand", { data: { name: "Acme", primaryColor: "#1e3a8a", defaultAvatarId: avatar.id, defaultVoiceId: voice.id, defaultAspect: "9:16", defaultResolution: "720p", captionsByDefault: true } })).ok()).toBe(true);
    // A fresh batch starts from the kit.
    await page.goto("/batch");
    await expect(page.getByLabel("Avatar")).toHaveValue(avatar.id);
    // The voice select comes before "Voice emotion" and "Voice pitch".
    await expect(page.getByLabel("Voice").first()).toHaveValue(voice.id);
    await expect(page.getByLabel("Aspect ratio")).toHaveValue("9:16");
    await expect(page.getByLabel("Output quality")).toHaveValue("720p");
    // A CSV saved by a spreadsheet in Windows-1252 keeps its accents.
    await page.locator("input[type=file]").setInputFiles({ name: "people.csv", mimeType: "text/csv", buffer: Buffer.from("name,property,move_in\nJosé,Café Street,May 1\n", "latin1") });
    await expect(page.getByText(/Hi José, welcome to Café Street!/)).toBeVisible();

    // Every presenter can answer on the interactive page, starting with the kit's.
    await page.goto("/interactive");
    const grid = page.getByTestId("avatar-grid");
    await expect(grid.getByRole("button")).toHaveCount(avatars.length);
    await expect(page.getByLabel("Voice")).toHaveValue(voice.id);

    // The editor starts at the kit's 720p; switched to 1080p, the shortcut renders at 1080p.
    await page.goto("/create");
    await page.locator("textarea").first().fill("A short script for the shortcut.");
    await page.locator("input[placeholder='Video title']").fill(`Shortcut ${Date.now().toString(36)}`);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("button", { name: /^720p/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: /^1080p/ }).click();
    const sent = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
    await page.keyboard.press("Control+Enter");
    expect(JSON.parse((await sent).postData() ?? "{}").resolution).toBe("1080p");
    await page.waitForURL(/\/videos\/vid_/);
  } finally {
    const restored = before ? await page.request.put("/api/brand", { data: before }) : await page.request.delete("/api/brand");
    expect(restored.ok()).toBe(true);
  }
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

  // Neither the link preview nor the page source carries the video, its download, button, or script, which would stand in for the form.
  const patched = await page.request.patch(`/api/videos/${v.id}`, { data: { shareDownload: true, shareCta: { label: "Book a tour", url: "https://example.com/tour" } } });
  expect(patched.ok()).toBe(true);
  const { video: stored } = (await (await page.request.get(`/api/videos/${v.id}`)).json()) as { video: { videoUrl: string } };
  const html = await (await page.request.get(`/share/${v.id}`)).text();
  expect(html).not.toContain('property="og:video"');
  expect(html).not.toMatch(/<meta[^>]+og:description[^>]+Hello there/);
  expect(html).not.toContain(stored.videoUrl);
  expect(html).not.toContain("Hello there");
  expect(html).not.toContain("Book a tour");
  expect(html).not.toContain("Download video");
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
  // Past the form, the page shows what it held back: the button, the download, and the transcript.
  await expect(share.getByRole("link", { name: "Book a tour" })).toBeVisible();
  await expect(share.getByRole("link", { name: "Download video" })).toBeVisible();
  await expect(share.getByText(/Hello there/).first()).toBeVisible();
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

test("a shared video is copied for an email as its moving preview, linked to the share page", async ({ page, context }) => {
  const v = await createVideoViaApi(page, `Email preview ${Date.now().toString(36)}`, { aspect: "16:9" });
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/videos/${v.id}`);
  await page.getByRole("button", { name: "Email", exact: true }).click();
  await expect(page.getByRole("button", { name: "Email copied" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Email preview copied" })).toHaveCount(1);
  // A mail client pastes the linked picture; a plain-text field gets the share link.
  const copied = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return { html: await (await item.getType("text/html")).text(), text: await (await item.getType("text/plain")).text() };
  });
  const share = new URL(`/share/${v.id}`, page.url()).href;
  expect(copied.text).toBe(share);
  expect(copied.html).toContain(`<a href="${share}"><img src="${share}/preview.gif" alt="Watch the video: Email preview`);
  expect(copied.html).toContain('width="480" height="270"');
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Share link copied" })).toHaveCount(1);
  // The picture's address is fixed and redirects to the renderer's GIF, which loads as an image.
  const preview = await page.request.get(`/share/${v.id}/preview.gif`, { maxRedirects: 0 });
  expect(preview.status()).toBe(302);
  expect(new URL(preview.headers().location).pathname).toBe("/demo/preview.gif");
  expect(preview.headers()["cache-control"]).toBe("public, max-age=300");
  // A kept answer may not outlive the share link.
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareExpiresAt: new Date(Date.now() + 60_000).toISOString() } })).status()).toBe(200);
  const expiring = await page.request.get(`/share/${v.id}/preview.gif`, { maxRedirects: 0 });
  expect(Number(/max-age=(\d+)/.exec(expiring.headers()["cache-control"])?.[1])).toBeLessThanOrEqual(60);
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareExpiresAt: null } })).status()).toBe(200);
  // Without rich clipboard writes the copy command carries both forms, not the page's styles or the alt text.
  const bare = await context.newPage();
  await bare.addInitScript(() => {
    delete (window as { ClipboardItem?: unknown }).ClipboardItem;
  });
  await bare.goto(`/videos/${v.id}`);
  expect(await bare.evaluate(() => typeof (window as { ClipboardItem?: unknown }).ClipboardItem)).toBe("undefined");
  await bare.evaluate(() => navigator.clipboard.writeText("sentinel"));
  await bare.getByRole("button", { name: "Email", exact: true }).click();
  await expect(bare.getByRole("button", { name: "Email copied" })).toBeVisible();
  const fallback = await bare.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return { html: await (await item.getType("text/html")).text(), text: await (await item.getType("text/plain")).text() };
  });
  expect(fallback.text).toBe(share);
  expect(fallback.html).toContain(`<a href="${share}"><img src="${share}/preview.gif"`);
  expect(fallback.html).not.toContain("font-family");
  await bare.close();
  await page.setContent(copied.html);
  await expect.poll(() => page.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(480);
  // A link that asks for an email first shows the cover instead, so the footage does not stand in for the form.
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareGate: true } })).status()).toBe(200);
  const gated = await page.request.get(`/share/${v.id}/preview.gif`, { maxRedirects: 0 });
  expect(new URL(gated.headers().location).pathname).toBe("/demo/poster.svg");
  // Behind a password there is no picture, and the button says why.
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareGate: false, sharePassword: "letmein1" } })).status()).toBe(200);
  expect((await page.request.get(`/share/${v.id}/preview.gif`, { maxRedirects: 0 })).status()).toBe(404);
  await page.goto(`/videos/${v.id}`);
  await expect(page.getByRole("button", { name: "Email", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Email", exact: true })).toHaveAccessibleDescription("Email preview unavailable while the link has a password.");
  // Nor while the link is off, and the page says why.
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { sharePassword: null, shareDisabled: true } })).status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("button", { name: "Email", exact: true })).toBeDisabled();
  await expect(page.locator("#email-preview-note")).toHaveText("Turn the share link on to copy an email preview.");
  // Nor once the link expires, while the page is open.
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareDisabled: false, shareExpiresAt: new Date(Date.now() + 6_000).toISOString() } })).status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("button", { name: "Email", exact: true })).toBeEnabled();
  await expect(page.locator("#email-preview-note")).toHaveText("Link expired: set a later expiry to copy an email preview.", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Email", exact: true })).toBeDisabled();
  expect((await page.request.get(`/share/vid_missing/preview.gif`, { maxRedirects: 0 })).status()).toBe(404);
});


test("HeyGen's Video Agent directs a whole video from a brief, and is asked again from the video's page", async ({ page }) => {
  await page.goto("/agent");
  // This studio's planner is the default; HeyGen's agent is the other choice where the renderer offers it.
  await expect(page.getByLabel(/^This studio's agent/)).toBeChecked();
  // Each choice is named briefly and described by its line.
  await expect(page.getByRole("radio", { name: "HeyGen's Video Agent", exact: true })).toHaveAccessibleDescription(/^Writes the script and chooses the presenter/);
  await page.getByLabel(/^HeyGen's Video Agent/).check();
  await expect(page.getByRole("button", { name: "Review in editor first" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Presenter" }).locator("option").first()).toHaveText("Let HeyGen choose");
  await expect(page.getByRole("combobox", { name: "Format" }).locator("option", { hasText: "Square" })).toHaveCount(0);
  const start = page.getByRole("button", { name: "Generate with HeyGen" });
  await expect(start).toBeDisabled();
  await page.getByLabel("What should the video be?").fill("A TikTok with three quick tips for staging a home before a showing");
  await page.getByRole("combobox", { name: "Length" }).selectOption("90");
  await page.getByRole("combobox", { name: "Language" }).selectOption("Spanish");
  await start.click();
  await page.waitForURL(/\/videos\/vid_/);
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  // The page shows the brief, who directed it, and nothing that needs a script.
  await expect(page.getByRole("heading", { name: "Brief" })).toBeVisible();
  const brief = page.getByRole("heading", { name: "Brief" }).locator("..");
  await expect(brief.getByText("A TikTok with three quick tips for staging a home before a showing", { exact: true })).toBeVisible();
  await expect(brief).toContainText("About 90 seconds");
  await expect(brief).toContainText("Spanish");
  await expect(page.getByText("HeyGen's Video Agent", { exact: true })).toBeVisible();
  // The presenter, voice, and style were all left to HeyGen.
  await expect(page.getByText("Chosen by HeyGen")).toHaveCount(3);
  await expect(page.getByRole("link", { name: "Edit a copy" })).toHaveCount(0);
  const video = (await (await page.request.get(`/api/videos/${id}`)).json()).video as { aspect: string; script: string; directed: { orientation: string } };
  expect([video.aspect, video.script, video.directed.orientation]).toEqual(["9:16", "", "portrait"]);
  // Followed as the agent's session, then its render, to a finished video.
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  await page.reload();
  await expect(page.getByRole("link", { name: /^Captions/ })).toHaveCount(0);
  // Asked again, the agent page opens with the same brief and HeyGen's agent chosen.
  await page.getByRole("link", { name: "Ask the agent again" }).click();
  await page.waitForURL(/\/agent\?from=/);
  await expect(page.getByLabel(/^HeyGen's Video Agent/)).toBeChecked();
  await expect(page.getByLabel("What should the video be?")).toHaveValue("A TikTok with three quick tips for staging a home before a showing");
  // Left to the agent, it is left to the agent again.
  await expect(page.getByRole("combobox", { name: "Format" })).toHaveValue("auto");
  await expect(page.getByRole("combobox", { name: "Length" })).toHaveValue("90");
  await expect(page.getByRole("combobox", { name: "Language" })).toHaveValue("Spanish");
  // A square video is refused by the API too, with the reason.
  const square = await page.request.post("/api/video-agent", { data: { prompt: "A square video for our feed", mode: "direct", orientation: "square" } });
  expect(square.status()).toBe(400);
  expect((await square.json()).error).toMatch(/landscape or portrait/);
});

test("HeyGen's Video Agent composes a video in a curated style chosen from its groups, kept when asked again", async ({ page }) => {
  await page.goto("/agent");
  // The styles are HeyGen's agent's: none are offered for this studio's own.
  await expect(page.getByRole("group", { name: "Style (optional)" })).toHaveCount(0);
  await page.getByLabel(/^HeyGen's Video Agent/).check();
  const styles = page.getByRole("group", { name: "Style (optional)" });
  await expect(styles).toHaveAccessibleDescription(/curated look HeyGen's agent composes the video in/);
  await expect(styles.getByRole("radio", { name: "No style" })).toBeChecked();
  await expect(styles.getByTestId("agent-style")).toHaveCount(5);
  // Filtered by group; a style chosen and then filtered out stays chosen, and says so.
  await styles.getByRole("radio", { name: /^Paper cut-out/ }).check();
  await styles.getByRole("combobox", { name: "Show" }).selectOption("cinematic");
  await expect(styles.getByTestId("agent-style")).toHaveCount(1);
  await expect(styles.getByText("Chosen: Paper cut-out")).toBeVisible();
  await styles.getByRole("combobox", { name: "Show" }).selectOption("");
  await expect(styles.getByRole("radio", { name: /^Paper cut-out/ })).toBeChecked();
  await expect(styles.getByRole("link", { name: "Watch a sample of Paper cut-out (opens in a new tab)" })).toHaveAttribute("target", "_blank");
  await page.getByLabel("What should the video be?").fill("A short tour of our new bakery, warm and friendly");
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/video-agent") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate with HeyGen" }).click();
  expect(((await sent).postDataJSON() as Record<string, unknown>).styleId).toBe("demo_style_paper");
  await page.waitForURL(/\/videos\/vid_/);
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  // The style is named on the video's page, and, its shape left to the agent, the portrait style made it portrait.
  await expect(page.getByText("Paper cut-out", { exact: true })).toBeVisible();
  const video = (await (await page.request.get(`/api/videos/${id}`)).json()).video as { aspect: string; directed: { styleId: string; styleName: string } };
  expect([video.aspect, video.directed.styleId, video.directed.styleName]).toEqual(["9:16", "demo_style_paper", "Paper cut-out"]);
  // Asked again, the same style is chosen.
  await page.getByRole("link", { name: "Ask the agent again" }).click();
  await page.waitForURL(/\/agent\?from=/);
  await expect(page.getByRole("group", { name: "Style (optional)" }).getByRole("radio", { name: /^Paper cut-out/ })).toBeChecked();
  // The API lists the styles, and refuses one it does not offer, or one sent to this studio's own agent.
  const listed = (await (await page.request.get("/api/video-agent/styles")).json()) as { styles: Array<{ id: string }>; available: boolean };
  expect([listed.available, listed.styles.length]).toEqual([true, 5]);
  const retired = await page.request.post("/api/video-agent", { data: { prompt: "A video in an old style", mode: "direct", styleId: "style_retired" } });
  expect([retired.status(), (await retired.json()).error]).toEqual([400, "HeyGen no longer offers that style; choose another, or none"]);
  const planned = await page.request.post("/api/video-agent", { data: { prompt: "A planned video", mode: "plan", styleId: "demo_style_noir" } });
  expect(planned.status()).toBe(400);
});

test("a video HeyGen's Video Agent directed has its scenes edited into a new cut, keeping the rest", async ({ page }) => {
  const tag = Date.now().toString(36);
  const made = (await (await page.request.post("/api/video-agent", { data: { prompt: `A welcome for new bakery staff ${tag}`, mode: "direct" } })).json()).video as { id: string; title: string };
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${made.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  await page.goto(`/videos/${made.id}`);
  const panel = page.getByTestId("scene-edits");
  // Read on request (a heavy read at HeyGen), then one box per scene, each described by what it says.
  await panel.getByRole("button", { name: "Open the scenes" }).click();
  const first = panel.getByRole("textbox", { name: "What to change in scene 1" });
  await expect(first).toBeFocused();
  await expect(first).toHaveAccessibleDescription(/It says: “Welcome!/);
  await expect(panel.getByRole("textbox", { name: /^What to change in scene/ })).toHaveCount(3);
  const make = panel.getByRole("button", { name: "Make the edited cut" });
  await expect(make).toBeDisabled();
  await panel.getByRole("textbox", { name: "What to change in scene 2" }).fill(`Make the kitchen darker ${tag}; keep the narration.`);
  await expect(panel.getByText("1 of 3 scenes to change")).toBeVisible();
  const sent = page.waitForRequest((r) => r.url().endsWith(`/api/videos/${made.id}/scenes`) && r.method() === "POST");
  await make.click();
  const body = (await sent).postDataJSON() as { editVersion: string; edits: Array<{ sceneId: string; text: string }> };
  expect(body.edits).toEqual([{ sceneId: expect.stringMatching(/_2$/), text: `Make the kitchen darker ${tag}; keep the narration.` }]);
  // The cut is a new video, named after the one it edits, which it links to with what changed.
  await page.waitForURL((u) => /\/videos\/vid_/.test(u.pathname) && !u.pathname.endsWith(made.id));
  await expect(page.getByRole("heading", { name: `${made.title} (edited)` })).toBeVisible();
  await expect(page.getByRole("link", { name: made.title, exact: true })).toHaveAttribute("href", `/videos/${made.id}`);
  await expect(page.getByText(`Make the kitchen darker ${tag}; keep the narration.`)).toBeVisible();
  await expect(page.getByText("Scene 2 changed")).toBeVisible();
  // While the cut renders it has no scenes to edit yet.
  await expect(page.getByTestId("scene-edits")).toHaveCount(0);
  const cutId = new URL(page.url()).pathname.split("/").at(-1);
  // The same edit sent again (a retried request) is the same cut, not a second render.
  const again = await page.request.post(`/api/videos/${made.id}/scenes`, { data: body });
  expect([again.status(), (await again.json()).video.id]).toEqual([201, cutId]);
  // Sent against a version that moved on, the edit is a conflict to read again, and leaves no cut behind.
  const stale = await page.request.post(`/api/videos/${made.id}/scenes`, { data: { editVersion: "mockev_1", edits: [{ sceneId: body.edits[0].sceneId, text: "Brighter" }] } });
  expect(stale.status()).toBe(409);
  const cuts = ((await (await page.request.get(`/api/videos?q=${encodeURIComponent(made.title)}`)).json()).videos as Array<{ title: string }>).filter((v) => v.title.endsWith("(edited)"));
  expect(cuts).toHaveLength(1);
});

test("HeyGen's Video Agent is given the account's own pictures to use, named on the video and chosen again when asked again", async ({ page }) => {
  const tag = Date.now().toString(36);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const made = await page.request.post("/api/backdrops", { data: { name: `Storefront ${tag}`, image: `data:image/png;base64,${png.toString("base64")}` } });
  expect(made.status()).toBe(201);
  const storefront = ((await made.json()) as { backdrop: { id: string } }).backdrop.id;
  await page.goto("/agent");
  // Pictures and clips are for HeyGen's agent: not offered for this studio's own.
  await expect(page.getByRole("group", { name: "Pictures and clips (optional)" })).toHaveCount(0);
  await page.getByLabel(/^HeyGen's Video Agent/).check();
  const media = page.getByRole("group", { name: "Pictures and clips (optional)" });
  await expect(media).toHaveAccessibleDescription(/for HeyGen's agent to use where they fit, up to 10/);
  // One chosen from the account's pictures (picked, then added, so moving through the list adds nothing), another uploaded here.
  const add = media.getByRole("combobox", { name: "Add a picture or clip" });
  const addButton = media.getByRole("button", { name: "Add", exact: true });
  await expect(addButton).toBeDisabled();
  await add.selectOption({ label: `Storefront ${tag}` });
  const chosen = media.getByRole("list", { name: "Chosen pictures and clips" }).getByRole("listitem");
  await expect(chosen).toHaveCount(0);
  await addButton.click();
  await expect(chosen).toHaveCount(1);
  // The Add button is disabled once nothing is picked: the focus goes back to the list, or, with nothing left in it, to the upload field.
  const uploadField = media.getByLabel("Upload a picture");
  await expect((await add.isEnabled()) ? add : uploadField).toBeFocused();
  await uploadField.setInputFiles({ name: `counter-${tag}.png`, mimeType: "image/png", buffer: png });
  await expect(chosen).toHaveCount(2);
  await expect(chosen.nth(1)).toContainText(`counter-${tag}`);
  await expect(uploadField).toBeFocused();
  // A chosen one removed: the focus goes to the next one's Remove button, and it can be chosen again from the list.
  await media.getByRole("button", { name: `Remove Storefront ${tag}` }).click();
  await expect(media.getByRole("button", { name: `Remove counter-${tag}` })).toBeFocused();
  await expect(add.getByRole("option", { name: `Storefront ${tag}` })).toHaveCount(1);
  await add.selectOption({ label: `Storefront ${tag}` });
  await addButton.click();
  await page.getByLabel("What should the video be?").fill(`A tour of our bakery counter ${tag}`);
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/video-agent") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate with HeyGen" }).click();
  const asked = ((await sent).postDataJSON() as { media: Array<{ kind: string; id: string }> }).media;
  expect(asked.map((m) => m.kind)).toEqual(["picture", "picture"]);
  expect(asked[1].id).toBe(storefront);
  await page.waitForURL(/\/videos\/vid_/);
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  // Named on the video's page, one per line, in the order chosen.
  await expect(page.getByRole("list", { name: "Pictures and clips HeyGen's agent was given" }).getByRole("listitem")).toHaveText([`counter-${tag}`, `Storefront ${tag}`]);
  // Asked again once the uploaded one was deleted, the one still there is chosen, by name, and the page says one is not.
  const uploaded = ((await (await page.request.get(`/api/videos/${id}`)).json()).video as { directed: { media: Array<{ id: string }> } }).directed.media[0].id;
  expect((await page.request.delete(`/api/backdrops/${uploaded}`)).ok()).toBe(true);
  await page.getByRole("link", { name: "Ask the agent again" }).click();
  await page.waitForURL(/\/agent\?from=/);
  const again = page.getByRole("group", { name: "Pictures and clips (optional)" });
  await expect(again.getByRole("button", { name: `Remove Storefront ${tag}` })).toBeVisible();
  await expect(again.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByText("One of the pictures and clips chosen for it is no longer in your library or not finished, so it is not chosen.")).toBeVisible();
  // The API refuses them for this studio's own planner, and a picture that is not the account's.
  const planned = await page.request.post("/api/video-agent", { data: { prompt: "A planned video", mode: "plan", media: [{ kind: "picture", id: storefront }] } });
  expect(planned.status()).toBe(400);
  const unknown = await page.request.post("/api/video-agent", { data: { prompt: "A video with a picture nobody has", mode: "direct", media: [{ kind: "picture", id: "bd_nobodyhasthis" }] } });
  expect([unknown.status(), (await unknown.json()).error]).toEqual([400, "A picture you chose was deleted; remove it from the brief"]);
  expect((await page.request.delete(`/api/backdrops/${storefront}`)).ok()).toBe(true);
});

test("HeyGen's Video Agent stops at its storyboard for review, takes feedback, and renders on the go-ahead", async ({ page }) => {
  const tag = Date.now().toString(36);
  await page.goto("/agent");
  // The review is HeyGen's agent's: not offered for this studio's own, which has its plan reviewed in the editor.
  await expect(page.getByLabel("Let me review the storyboard first")).toHaveCount(0);
  await page.getByLabel(/^HeyGen's Video Agent/).check();
  const review = page.getByLabel("Let me review the storyboard first");
  await expect(review).toHaveAccessibleDescription(/stops at its storyboard/);
  await review.check();
  await page.getByLabel("What should the video be?").fill(`A welcome for new bakery staff ${tag}`);
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/video-agent") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate with HeyGen" }).click();
  expect(((await sent).postDataJSON() as Record<string, unknown>).review).toBe(true);
  await page.waitForURL(/\/videos\/vid_/);
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  const talk = page.getByTestId("agent-conversation");
  // The agent drafts a storyboard and waits: its message and storyboard show, with an answer box.
  await expect(talk.getByText(/drafted a storyboard with three scenes/)).toBeVisible({ timeout: 15_000 });
  await expect(talk.getByRole("img", { name: "Storyboard" })).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${id}`)).json()).video.agentWaiting, { timeout: 15_000 }).toBe(true);
  // The library says so too.
  const library = await page.context().newPage();
  await library.goto("/videos");
  await expect(library.getByText("Waiting for your review").first()).toBeVisible();
  await library.close();
  // Feedback first: it is shown as the account's, and the agent works on it and answers again.
  const answer = talk.getByRole("textbox", { name: "Your answer" });
  await answer.fill(`Make the intro shorter, and add a scene about parking ${tag}`);
  await talk.getByRole("button", { name: "Send", exact: true }).click();
  await expect(talk.getByText(`Make the intro shorter, and add a scene about parking ${tag}`, { exact: true })).toBeVisible();
  // The form goes while the agent works: the focus is on what happened, not lost.
  await expect(talk.getByRole("status")).toBeFocused();
  await expect(talk.getByRole("status")).toHaveText("Sent. HeyGen's Video Agent is working on your answer.");
  await expect(talk.getByText(new RegExp(`updated the storyboard: Make the intro shorter, and add a scene about parking ${tag}`))).toBeVisible({ timeout: 15_000 });
  // The go-ahead: the video is made, and the conversation stays as the record without an answer box.
  await talk.getByRole("button", { name: "Looks good, make the video" }).click();
  await expect(talk.getByText("Looks good, go ahead and make the video.")).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  await page.reload();
  await expect(page.getByTestId("agent-conversation").getByRole("textbox", { name: "Your answer" })).toHaveCount(0);
  await expect(page.getByTestId("agent-conversation").getByText(/What you and HeyGen's Video Agent agreed/)).toBeVisible();
  // Nothing is left to answer once it is made; an answer of nothing is refused.
  const late = await page.request.post(`/api/videos/${id}/agent`, { data: { text: "One more change" } });
  expect(late.status()).toBe(409);
  expect((await page.request.post(`/api/videos/${id}/agent`, { data: { text: " " } })).status()).toBe(400);
});

test("a photo shoot puts a person's face in a scene picture, with their consent, and lists the photos to download", async ({ page }) => {
  const tag = Date.now().toString(36);
  await page.goto("/photos");
  await expect(page.getByRole("link", { name: "Photo shoot" })).toBeVisible();
  const make = page.getByRole("button", { name: "Make the photos" });
  await expect(make).toBeDisabled();
  await expect(make).toHaveAccessibleDescription("Add a photo of the person first.");
  const person = page.getByLabel("Add a photo of the person");
  await expect(person).toHaveAccessibleDescription(/1 to 5 clear photos of one person's face/);
  await person.setInputFiles({ name: "front.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG, "base64") });
  await expect(page.getByRole("img", { name: "Photo 1 of the person: front.png" })).toBeVisible();
  await expect(page.locator('p[role="status"]')).toHaveText("Photo 1 of the person added (front.png).");
  await page.getByLabel("Add another photo of the person").setInputFiles({ name: "side.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG, "base64") });
  await expect(page.getByText("2 of 5 photos")).toBeVisible();
  await expect(make).toHaveAccessibleDescription("Add the scene picture.");
  await page.getByLabel("Add the scene picture").setInputFiles({ name: "train.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG, "base64") });
  // The scene's add control gives way to the picture, and the focus goes to its remove button.
  await expect(page.getByRole("button", { name: "Remove the scene picture, train.png" })).toBeFocused();
  await expect(page.locator('p[role="status"]')).toHaveText("Scene picture added (train.png).");
  await expect(make).toHaveAccessibleDescription("Confirm that you have the right to use this person's face.");
  const consent = page.getByLabel("I have the right to use this person's face");
  await expect(consent).toHaveAccessibleDescription(/A public photo is not permission/);
  await consent.check();
  await expect(make).toBeEnabled();
  // Removing a photo of the person is announced, and the focus goes back to the add control.
  await page.getByRole("button", { name: "Remove photo 2 of the person, side.png" }).click();
  await expect(page.locator('p[role="status"]')).toHaveText("Photo 2 of the person removed (side.png).");
  await expect(page.getByLabel("Add another photo of the person")).toBeFocused();
  await page.getByLabel("Add another photo of the person").setInputFiles({ name: "side.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG, "base64") });
  await page.getByLabel("Shape").selectOption("4:5");
  await page.getByLabel("Photos", { exact: true }).selectOption("2");
  await page.getByLabel("Title (optional)").fill(`Train window ${tag}`);
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/shoots") && r.method() === "POST");
  await make.click();
  const request = await sent;
  const body = request.postDataJSON() as { identity: string[]; reference: string; aspect: string; count: number; consent: boolean; title: string };
  expect([body.identity.length, body.aspect, body.count, body.consent, body.title]).toEqual([2, "4:5", 2, true, `Train window ${tag}`]);
  expect([...body.identity, body.reference].every((p) => p.startsWith("data:image/png;base64,"))).toBe(true);
  expect(request.headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  const item = page.getByTestId("shoot").filter({ hasText: `Train window ${tag}` });
  await expect(item).toBeFocused();
  await expect(item.getByTestId("shoot-meta")).toContainText("2 photos · 4:5 · from 2 photos of the person");
  // The person stays for another scene; the scene and the consent go with the shoot.
  await expect(page.getByTestId("shoot-person")).toHaveCount(2);
  await expect(page.getByTestId("shoot-scene")).toHaveCount(0);
  await expect(consent).not.toBeChecked();
  // Once made, each photo is shown in its shape, with a download link, and its being ready is announced.
  await expect(item.getByText("Completed")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('p[role="status"]')).toHaveText(`Train window ${tag} is ready.`);
  await expect(item.getByTestId("shoot-photo")).toHaveCount(2);
  await expect(item.getByRole("img", { name: `Photo 1 of Train window ${tag}, 2176 × 2720` })).toBeVisible();
  await expect(item.getByRole("link", { name: `Download photo 2 of Train window ${tag}` })).toHaveAttribute("download", "");
  // Without a title, the scene's file name names the shoot, so two shoots are told apart.
  await page.getByLabel("Add the scene picture").setInputFiles({ name: "harbour.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG, "base64") });
  await expect(page.getByLabel("Title (optional)")).toHaveAttribute("placeholder", "Photo shoot: harbour, and the time");
  await consent.check();
  const untitled = page.waitForRequest((r) => r.url().endsWith("/api/shoots") && r.method() === "POST");
  await make.click();
  expect((await untitled).postDataJSON().title).toMatch(/^Photo shoot: harbour, \S/);
  const harbour = page.getByTestId("shoot").filter({ hasText: "Photo shoot: harbour" }).first();
  await expect(harbour).toBeVisible();
  expect((await page.request.delete(`/api/shoots/${await harbour.getAttribute("data-shoot")}`)).ok()).toBe(true);
  // (Deleted elsewhere, so the page is loaded again to list what is left.)
  await page.reload();
  await expect(item).toBeVisible();
  // The API refuses a shoot without consent, and keeps the renderer's job to itself.
  const refused = await page.request.post("/api/shoots", { data: { identity: [`data:image/png;base64,${TINY_PNG}`], reference: `data:image/png;base64,${TINY_PNG}` } });
  expect(refused.status()).toBe(400);
  expect(((await refused.json()).issues as Array<{ message: string }>).map((i) => i.message)).toEqual(["Confirm that you have the right to use this person's face"]);
  const listed = (await (await page.request.get("/api/shoots")).json()).shoots as Array<Record<string, unknown>>;
  const id = (await item.getAttribute("data-shoot"))!;
  expect(Object.keys(listed.find((s) => s.id === id)!).filter((k) => ["provider", "providerJobId", "pictureDigest", "ownerId"].includes(k))).toEqual([]);
  // A long file name or title is cut short: the page never scrolls sideways, on a phone or beside the list.
  const longName = `IMG_${"2026041214352200".repeat(6)}.png`;
  const long = (await (await page.request.post("/api/shoots", { data: { identity: [`data:image/png;base64,${TINY_PNG}`], reference: `data:image/png;base64,${TINY_PNG}`, consent: true, aspect: "16:9", title: "x".repeat(120) } })).json()).shoot as { id: string };
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await expect(page.getByTestId("shoot").filter({ hasText: "x".repeat(120) }).getByText("Completed")).toBeVisible({ timeout: 20_000 });
  // Studio pages scroll inside <main>, so that is what must not be wider than it shows.
  const overflow = () => page.evaluate(() => [document.documentElement, ...document.querySelectorAll("main")].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => `${el.tagName} ${el.scrollWidth}>${el.clientWidth}`));
  expect(await overflow()).toEqual([]);
  expect((await page.getByLabel("Shape").boundingBox())!.width).toBeGreaterThan(150);
  // The demo's photos are drawn in the shape asked for, as HeyGen's are.
  const wide = page.getByRole("img", { name: `Photo 1 of ${"x".repeat(120)}, 3840 × 2160` });
  // Measured from the picture itself once loaded (its box takes the shape from its size attributes before then).
  await expect.poll(() => wide.evaluate((i: HTMLImageElement) => (i.complete && i.naturalWidth ? i.naturalWidth / i.naturalHeight : 0))).toBeCloseTo(16 / 9, 1);
  await page.setViewportSize({ width: 375, height: 800 });
  // (The form starts again after the reload.)
  await page.getByLabel("Add a photo of the person").setInputFiles({ name: longName, mimeType: "image/png", buffer: Buffer.from(TINY_PNG, "base64") });
  await expect(page.getByRole("img", { name: `Photo 1 of the person: ${longName}` })).toBeVisible();
  expect(await overflow()).toEqual([]);
  // An unreadable file's name in the message wraps too.
  await page.getByLabel("Add another photo of the person").setInputFiles({ name: `X${longName}`, mimeType: "image/png", buffer: Buffer.from("not a picture") });
  await expect(page.getByRole("alert").filter({ hasText: "not an image the browser can read" })).toBeVisible();
  expect(await overflow()).toEqual([]);
  expect((await page.request.delete(`/api/shoots/${long.id}`)).ok()).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await expect(item).toBeVisible();
  // Deleting it says so and moves the focus to the next shoot, or to the list's heading when it was the last one.
  const next = (await page.getByTestId("shoot").count()) > 1 ? page.getByTestId("shoot").filter({ hasNotText: `Train window ${tag}` }).first() : page.getByRole("heading", { name: "Your photo shoots" });
  page.once("dialog", (d) => void d.accept());
  await item.getByRole("button", { name: `Delete Train window ${tag}` }).click();
  await expect(page.locator('p[role="status"]')).toHaveText(`Deleted Train window ${tag}.`);
  await expect(page.getByTestId("shoot").filter({ hasText: `Train window ${tag}` })).toHaveCount(0);
  await expect(next).toBeFocused();
});

test("a photo shoot's photo becomes a presenter, kept as a photo avatar", async ({ page }) => {
  const tag = Date.now().toString(36);
  const shoot = (await (await page.request.post("/api/shoots", { data: { identity: [`data:image/png;base64,${TINY_PNG}`], reference: `data:image/png;base64,${TINY_PNG}`, consent: true, count: 2, title: `Studio ${tag}` } })).json()).shoot as { id: string };
  const name = `Dana ${tag}`;
  try {
    await page.goto("/photos");
    const item = page.getByTestId("shoot").filter({ hasText: `Studio ${tag}` });
    await expect(item.getByText("Completed")).toBeVisible({ timeout: 20_000 });
    const photoUrl = await item.getByRole("img", { name: /^Photo 2 of / }).getAttribute("src");
    await item.getByRole("link", { name: `Make a presenter: photo 2 of Studio ${tag}` }).click();
    // The new photo avatar panel opens with that photo as the portrait; the name is what is left, and has the focus.
    await expect(page).toHaveURL(/\/avatars$/);
    await expect(page.getByRole("img", { name: `Portrait preview: photo 2 of Studio ${tag}` })).toBeVisible();
    // Shown whole, in whatever shape the shoot made it, rather than cropped to the portrait tile.
    await expect(page.getByRole("img", { name: `Portrait preview: photo 2 of Studio ${tag}` })).toHaveCSS("object-fit", "contain");
    await expect(page.getByRole("status").filter({ hasText: "The portrait is photo 2" })).toHaveText(`The portrait is photo 2 of “Studio ${tag}”. Name the presenter to create it, or upload another portrait.`);
    const create = page.getByRole("button", { name: "Create avatar" });
    await expect(create).toBeDisabled();
    await expect(page.getByLabel("Avatar name")).toBeFocused();
    await page.keyboard.type(name);
    const sent = page.waitForRequest((r) => r.url().endsWith("/api/avatars") && r.method() === "POST");
    await create.click();
    const body = (await sent).postDataJSON() as Record<string, unknown>;
    // The server is named the photo, and keeps its own copy of it, rather than being sent the picture.
    expect([body.shootPhoto, "imageUrl" in body]).toEqual([{ shootId: shoot.id, photo: 2 }, false]);
    await expect(page.getByRole("img", { name, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New photo avatar" })).toBeFocused();
    const made = ((await (await page.request.get("/api/avatars")).json()).avatars as Array<{ name: string; imageUrl: string; source: string }>).find((a) => a.name === name);
    expect([made?.source, made?.imageUrl === photoUrl]).toEqual(["custom", true]);
    // Opened again from the photo, another portrait chosen instead is the one sent.
    await page.goto(`/avatars?shoot=${shoot.id}&photo=1`);
    await expect(page.getByRole("img", { name: `Portrait preview: photo 1 of Studio ${tag}` })).toBeVisible();
    // The name says which photo is the portrait, for a screen reader too.
    await expect(page.getByLabel("Avatar name")).toHaveAccessibleDescription(/The portrait is photo 1 of/);
    await page.getByLabel("Avatar name").fill(`${name} again`);
    // "New photo avatar" with the panel open keeps what is in it, and goes to its name.
    await page.getByRole("button", { name: "New photo avatar" }).click();
    await expect(page.getByLabel("Avatar name")).toHaveValue(`${name} again`);
    await expect(page.getByLabel("Avatar name")).toBeFocused();
    await expect(page.getByRole("img", { name: `Portrait preview: photo 1 of Studio ${tag}` })).toBeVisible();
    const address = page.getByLabel("Or paste an image URL");
    await address.fill("https://cdn.example.com/portrait.jpg");
    await expect(page.getByRole("status").filter({ hasText: "The portrait is photo" })).toHaveCount(0);
    await expect(page.getByRole("img", { name: "Portrait preview", exact: true })).toHaveAttribute("src", "https://cdn.example.com/portrait.jpg");
    // Emptied, the photo is the portrait again.
    await address.fill("");
    await expect(page.getByRole("img", { name: `Portrait preview: photo 1 of Studio ${tag}` })).toBeVisible();
    page.once("dialog", (d) => void d.accept());
    await page.getByLabel("Avatar name").press("Escape");
    await expect(page.getByLabel("Avatar name")).toHaveCount(0);
    // A link that names no photo, or a photo that is gone, is said so; no panel opens, and the address is cleaned.
    await page.goto("/avatars?shoot=x&photo=abc");
    await expect(page.getByRole("alert").filter({ hasText: "does not name a photo" })).toBeVisible();
    await expect(page).toHaveURL(/\/avatars$/);
    await page.goto(`/avatars?shoot=${shoot.id}&photo=3`);
    await expect(page.getByRole("alert").filter({ hasText: "has no photo 3" })).toHaveText(`“Studio ${tag}” has no photo 3; upload a portrait instead.`);
    await expect(page.getByLabel("Avatar name")).toHaveCount(0);
    // The API is named the photo the same way, and refuses one the account does not have.
    expect((await page.request.post("/api/avatars", { data: { name, shootPhoto: { shootId: shoot.id, photo: 3 } } })).status()).toBe(400);
    expect((await page.request.post("/api/avatars", { data: { name, shootPhoto: { shootId: "sh_nope", photo: 1 } } })).status()).toBe(404);
  } finally {
    const avatars = (await (await page.request.get("/api/avatars")).json()).avatars as Array<{ id: string; name: string }>;
    for (const a of avatars.filter((x) => x.name === name)) await page.request.delete(`/api/avatars/${a.id}`);
    await page.request.delete(`/api/shoots/${shoot.id}`);
  }
});

test("a photo shoot's photo is brought to life as a b-roll clip's first frame, and made again from it", async ({ page }) => {
  const tag = Date.now().toString(36);
  const shoot = (await (await page.request.post("/api/shoots", { data: { identity: [`data:image/png;base64,${TINY_PNG}`], reference: `data:image/png;base64,${TINY_PNG}`, consent: true, count: 2, title: `Harbour ${tag}` } })).json()).shoot as { id: string };
  await page.goto("/photos");
  const item = page.getByTestId("shoot").filter({ hasText: `Harbour ${tag}` });
  await expect(item.getByText("Completed")).toBeVisible({ timeout: 20_000 });
  await item.getByRole("link", { name: `Bring to life: photo 2 of Harbour ${tag}` }).click();
  // The B-roll page opens on that photo, the description started as HeyGen advises, ready for a camera move.
  await expect(page).toHaveURL(/\/footage$/);
  await expect(page.getByLabel("Open on a picture")).toBeChecked();
  await expect(page.getByRole("img", { name: `Photo 2 of Harbour ${tag}` })).toBeVisible();
  const prompt = page.getByRole("textbox", { name: "Describe the shot", exact: true });
  await expect(prompt).toHaveValue("Keep the person exactly as they appear in the first frame. ");
  await expect(prompt).toBeFocused();
  await expect(page.locator('p[role="status"]')).toHaveText("The clip opens on photo 2 of the photo shoot. Describe one camera move after the first sentence.");
  await page.keyboard.type(`A slow push-in ${tag} as the wind lifts her hair.`);
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/footage") && r.method() === "POST");
  await page.getByRole("button", { name: "Make the clip" }).click();
  const body = (await sent).postDataJSON() as Record<string, unknown>;
  expect([body.shootPhoto, "image" in body, "aspect" in body]).toEqual([{ shootId: shoot.id, photo: 2 }, false, false]);
  const clip = page.getByTestId("footage").filter({ hasText: `push-in ${tag}` });
  await expect(clip.getByTestId("footage-meta")).toContainText("from photo 2 of a photo shoot");
  // Named after the camera move, not the advice every clip from a photo starts with.
  await expect(clip.getByRole("button", { name: /^Delete A slow push-in/ })).toBeVisible();
  // Made again, it opens on the same photo, which the account still has.
  await expect(clip.getByText("Completed")).toBeVisible({ timeout: 20_000 });
  await clip.getByRole("button", { name: /^Make again with changes: / }).click();
  await expect(page.getByRole("img", { name: `Photo 2 of Harbour ${tag}` })).toBeVisible();
  await expect(page.getByLabel("Open on a picture")).toBeChecked();
  // A picture of one's own takes its place, and the focus goes to its remove button.
  await page.getByRole("button", { name: `Remove Photo 2 of Harbour ${tag}` }).click();
  await page.getByLabel("Add a picture").setInputFiles({ name: "dock.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG, "base64") });
  await expect(page.getByRole("button", { name: "Remove dock.png" })).toBeFocused();
  // A link that names no photo is said so, and the address is cleaned.
  await page.goto("/footage?shoot=x&photo=abc");
  await expect(page.getByRole("alert").filter({ hasText: "does not name a photo" })).toBeVisible();
  await expect(page).toHaveURL(/\/footage$/);
  // A photo that is gone is said so, and nothing is opened on.
  expect((await page.request.delete(`/api/shoots/${shoot.id}`)).ok()).toBe(true);
  await page.goto(`/footage?shoot=${shoot.id}&photo=1`);
  await expect(page.getByRole("alert").filter({ hasText: "no longer there" })).toHaveText("That photo shoot is no longer there; add a picture to open on instead.");
  await expect(page.getByLabel("No pictures")).toBeChecked();
  expect((await page.request.delete(`/api/footage/${await clip.getAttribute("data-footage")}`)).ok()).toBe(true);
});
