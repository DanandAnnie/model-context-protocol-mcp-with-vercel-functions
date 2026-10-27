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
  await engine.selectOption("avatar_v");
  // Ava is a video avatar, so on Avatar V she takes gestures too.
  await expect(page.locator("#photo-motion-hint")).toContainText("Gestures reach the video avatars rendering on Avatar V");
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate video" }).click();
  expect((await sent).postDataJSON()).toMatchObject({ avatarEngine: "avatar_v" });
  await page.waitForURL(/\/videos\/vid_/);
  const id = page.url().split("/").pop()!;
  expect((await (await page.request.get(`/api/videos/${id}`)).json()).video.avatarEngine).toBe("avatar_v");
  await expect(page.getByText("Avatar V (not applied by this renderer)")).toBeVisible();
  await page.goto(`/create?from=${id}`);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Avatar engine", { exact: true })).toHaveValue("avatar_v");
  await page.getByRole("button", { name: "Avatar", exact: true }).click();
  await page.getByRole("button", { name: "Sofia Reyes Sofia Reyes" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Avatar engine", { exact: true }).locator("option:checked")).toHaveText("Avatar V (not sent: no presenter here renders on it)");
  const again = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate video" }).click();
  expect("avatarEngine" in ((await again).postDataJSON() as Record<string, unknown>)).toBe(false);
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
  await page.getByRole("button", { name: "Search" }).click();
  const tracks = page.getByTestId("music-tracks");
  // The best match is chosen and focused, and each track can be heard first.
  await expect(tracks.getByLabel("Bright steps", { exact: true })).toBeChecked();
  await expect(tracks.getByLabel("Bright steps", { exact: true })).toBeFocused();
  await expect(tracks.getByRole("radio")).toHaveCount(3);
  await expect(tracks.getByLabel("Hear Bright steps")).toHaveAttribute("src", /\/demo\/music-upbeat\.mp3$/);
  await page.getByLabel("Medium").check();
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/music") && r.method() === "POST");
  await start.click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({ videoId: v.id, trackId: "demo_music_upbeat", query: "upbeat energetic", volume: "medium" });
  expect(request.headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  const item = page.getByTestId("mix").first();
  await expect(item).toBeFocused();
  await expect(item).toContainText("(with music)");
  await expect(item.getByTestId("mix-meta")).toContainText("“Bright steps” · Medium volume");
  // The demo renderer finishes a few seconds later; the page checks again on its own.
  await expect(item.getByRole("link", { name: /^Download / })).toHaveAttribute("href", /\/demo\/render\./, { timeout: 20_000 });
  const listed = (await (await page.request.get("/api/music")).json()).mixes as Array<Record<string, unknown>>;
  for (const key of ["provider", "providerJobId", "ownerId"]) expect(Object.keys(listed[0])).not.toContain(key);
  // A suggestion searches at once.
  await page.getByRole("button", { name: "Cinematic and inspiring" }).click();
  await expect(tracks.getByLabel("Wide horizon", { exact: true })).toBeChecked();
  // Deleting asks first; the focus goes to the next video with music, or to the list's heading when none is left.
  page.once("dialog", (d) => d.accept());
  await item.getByRole("button", { name: /^Delete / }).click();
  await expect(page.getByTestId("mix")).toHaveCount(listed.length - 1);
  await expect(page.locator('[data-testid="mix"]:focus, h2:focus')).toHaveCount(1);
});

test("an instant voice is made from a recording with the speaker's agreement, and a recording is spoken again in it", async ({ page }) => {
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
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/voice-changer/voices") && r.method() === "POST");
  await make.click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({ name, clipId: expect.stringMatching(/^clip_/), agreed: true });
  expect(request.headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  const voiceRow = page.getByTestId("instant-voices").locator("li").filter({ hasText: name });
  await expect(voiceRow).toBeFocused();
  // The demo renderer makes it in a moment; the page checks again on its own.
  await expect(voiceRow).toContainText("Ready", { timeout: 20_000 });
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
  const card = page.getByTestId("voice-change").first();
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
  const spokenCard = page.getByTestId("voice-change").filter({ hasText: `Welcome to the team. in ${name}` });
  await expect(spokenCard).toBeFocused();
  await expect(spokenCard.getByTestId("voice-change-meta")).toContainText("from text");
  await expect(spokenCard.getByRole("link", { name: /^Download / })).toHaveAttribute("href", /\/demo\/revoiced\.mp3$/);
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
    const pages = ["/home", "/create", "/agent", "/videos", `/videos/${v.id}`, `/videos/${clear.id}`, "/templates", "/avatars", "/voices", "/batch", "/brand", "/interactive", "/workspace", "/settings", "/translate", "/cleanup", "/lipsync", "/music", "/cinematic", "/voice-changer", `/share/${v.id}`];
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
    expect(kit.defaultBackground).toEqual({ type: "image", value: "https://example.com/brand-bg.jpg", fit: "contain" });
    expect(kit.pronunciations).toEqual([{ word: "Nair", sayAs: "Nye-er" }, { word: "SaaS", sayAs: "sass" }]);
    expect(kit.glossary).toEqual(["Acme Cloud", "Nimbus"]);
    expect(kit.watermark).toBe("bottom-right");
    expect(kit.logoUrl).toBe(`data:image/png;base64,${TINY_PNG}`);
    await page.reload();
    await expect(page.getByLabel("Pronunciation", { exact: true })).toHaveValue("Nair = Nye-er\nSaaS = sass");
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
  const paths = ["/", "/login", "/home", "/create", "/agent", "/videos", `/videos/${v.id}`, "/templates", "/batch", "/avatars", "/voices", "/translate", "/cleanup", "/lipsync", "/music", "/cinematic", "/voice-changer", "/interactive", "/brand", "/settings", `/share/${v.id}`, `/talk/${agent.id}`, "/demo-consent"];
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
