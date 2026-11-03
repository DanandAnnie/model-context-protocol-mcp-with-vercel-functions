import { expect, test, type Dialog, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import jsQR from "jsqr";
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

test("a video can be saved as a template, reopened from it, renamed, and duplicated", async ({ page }) => {
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
  // Renamed and described in place: the form takes the focus, Escape leaves it unchanged, Save keeps the rest.
  await page.goto("/templates");
  // The only saved template here (the test ends by checking none are left); its title is hidden while it is edited.
  await expect(page.getByTestId("my-template")).toHaveCount(1);
  const card = page.getByTestId("my-template");
  await card.getByRole("button", { name: "Edit template Listing opener" }).click();
  await expect(card.getByLabel("Template name")).toBeFocused();
  await card.getByLabel("Template name").fill("Discarded name");
  await page.keyboard.press("Escape");
  await expect(card.getByRole("button", { name: "Edit template Listing opener" })).toBeFocused();
  await card.getByRole("button", { name: "Edit template Listing opener" }).click();
  await expect(card.getByLabel("Template name")).toHaveValue("Listing opener");
  const formAxe = await new AxeBuilder({ page }).include("[data-testid='my-templates']").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(formAxe.violations.map((v) => v.id)).toEqual([]);
  // A name of spaces is refused at the field, which says why.
  await card.getByLabel("Template name").fill("   ");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByRole("alert")).toHaveText("Name the template");
  await expect(card.getByLabel("Template name")).toHaveAttribute("aria-invalid", "true");
  await expect(card.getByLabel("Template name")).toBeFocused();
  await card.getByLabel("Template name").fill("Spring listing opener");
  await card.getByLabel("Description (optional)").fill("For spring listings");
  await card.getByRole("button", { name: "Save" }).click();
  const renamed = page.getByTestId("my-template").filter({ hasText: "Spring listing opener" });
  await expect(renamed.getByText("For spring listings")).toBeVisible();
  await expect(renamed.getByRole("button", { name: "Edit template Spring listing opener" })).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "Saved the template “Spring listing opener”." })).toHaveCount(1);
  const stored = ((await (await page.request.get("/api/templates")).json()) as { templates: Array<{ id: string; title: string; description?: string; scenes: unknown[] }> }).templates[0];
  expect(stored).toMatchObject({ title: "Spring listing opener", description: "For spring listings" });
  expect(stored.scenes).toHaveLength(2);
  // Someone else renames it while the form is open here; saving only the description keeps their name.
  await renamed.getByRole("button", { name: "Edit template Spring listing opener" }).click();
  expect((await page.request.patch(`/api/templates/${stored.id}`, { data: { title: "Their opener" } })).ok()).toBe(true);
  await renamed.getByLabel("Description (optional)").fill("Spring and summer");
  await renamed.getByRole("button", { name: "Save" }).click();
  const theirs = page.getByTestId("my-template").filter({ hasText: "Their opener" });
  await expect(theirs.getByText("Spring and summer")).toBeVisible();
  await expect(page.getByTestId("templates-note")).toHaveText("Saved the template “Their opener”.");
  expect((await page.request.patch(`/api/templates/${stored.id}`, { data: { title: "Spring listing opener" } })).ok()).toBe(true);
  await page.reload();
  expect((await page.request.patch(`/api/templates/${stored.id}`, { data: {} })).status()).toBe(400);
  expect((await page.request.patch(`/api/templates/${stored.id}`, { data: { title: " " } })).status()).toBe(400);
  expect((await page.request.patch("/api/templates/tpl_missing123", { data: { title: "Gone" } })).status()).toBe(404);
  const axe = await new AxeBuilder({ page }).include("[data-testid='my-templates']").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  // Duplicated beside it under a name of its own; the copy's Edit button takes the focus, ready for a new name.
  await page.getByRole("button", { name: "Duplicate template Spring listing opener", exact: true }).click();
  const copyCard = page.getByTestId("my-template").filter({ hasText: "Spring listing opener (copy)" });
  await expect(copyCard.getByText("Spring and summer")).toBeVisible();
  await expect(copyCard.getByRole("button", { name: "Edit template Spring listing opener (copy)" })).toBeFocused();
  await expect(page.getByTestId("templates-note")).toHaveText("Made a copy: “Spring listing opener (copy)”.");
  await expect(page.getByRole("status").filter({ hasText: "Made a copy: “Spring listing opener (copy)”." })).toHaveCount(1);
  const copiedAxe = await new AxeBuilder({ page }).include("[data-testid='my-templates']").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(copiedAxe.violations.map((v) => v.id)).toEqual([]);
  const copies = ((await (await page.request.get("/api/templates")).json()) as { templates: Array<{ title: string; scenes: unknown[] }> }).templates;
  expect(copies.map((x) => x.title).sort()).toEqual(["Spring listing opener", "Spring listing opener (copy)"]);
  expect(copies.every((x) => x.scenes.length === 2)).toBe(true);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete template Spring listing opener (copy)", exact: true }).click();
  await expect(copyCard).toHaveCount(0);
  // A viewer sees the template but cannot change or delete it.
  await page.route("**/api/workspaces", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { personalId: "demo-user", activeId: "ws_view", workspaces: [{ id: "ws_view", name: "Read only team", role: "viewer", members: [] }] } })
      : route.continue(),
  );
  await page.reload();
  await expect(page.getByTestId("view-only")).toContainText("not change or delete your saved templates");
  await expect(renamed.getByRole("link", { name: "Use template" })).toBeVisible();
  await expect(renamed.getByRole("button")).toHaveCount(0);
  await page.unroute("**/api/workspaces");
  await page.reload();
  // Delete it again from the Templates page.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete template Spring listing opener" }).click();
  await expect(page.getByTestId("my-templates").getByText("Spring listing opener")).toHaveCount(0);
  expect(((await (await page.request.get("/api/templates")).json()).templates as unknown[]).length).toBe(0);
});

test("one search looks through the saved templates and the script templates", async ({ page }) => {
  const tag = Date.now().toString(36);
  const v = await createVideoViaApi(page, `Search source ${tag}`, {
    scenes: [
      { script: `Welcome to the ${tag} bakery. [pause 1s] Fresh bread daily.`, name: "Storefront", background: { type: "color", value: "#ffffff" } },
      { script: "Order online tonight.", background: { type: "color", value: "#0f172a" } },
    ],
  });
  const made = await page.request.post("/api/templates", { data: { fromVideoId: v.id, title: `Bakery promo ${tag}` } });
  expect(made.status()).toBe(201);
  try {
    await page.goto("/templates");
    const mine = page.getByTestId("my-templates");
    const search = page.getByRole("searchbox", { name: "Search my templates and script templates" });
    const matches = page.getByTestId("template-matches");
    const card = (title: string) => mine.getByText(title, { exact: true });
    await expect(card(`Bakery promo ${tag}`)).toBeVisible();
    const scriptCards = page.getByTestId("script-templates").getByRole("link", { name: "Use template" });
    const allScripts = await scriptCards.count();
    expect(allScripts).toBeGreaterThan(3);
    await expect(matches).toHaveText("");
    // A word of a saved template's scene finds it, and no script template has it.
    await search.fill(`${tag} BAKERY`);
    await expect(card(`Bakery promo ${tag}`)).toBeVisible();
    await expect(scriptCards).toHaveCount(0);
    await expect(page.getByText(`No script template matches “${tag} BAKERY”.`)).toBeVisible();
    await expect(matches).toHaveText(new RegExp(`^1 of \\d+ saved templates, 0 of ${allScripts} script templates$`));
    // A scene's name counts; a pause marker does not.
    await search.fill("Storefront");
    await expect(card(`Bakery promo ${tag}`)).toBeVisible();
    await search.fill(`${tag} bakery. fresh`);
    await expect(card(`Bakery promo ${tag}`)).toBeVisible();
    await search.fill(`${tag} pause 1s`);
    await expect(card(`Bakery promo ${tag}`)).toHaveCount(0);
    // A category's name finds its script templates; a category chosen that hides them offers the way back.
    await search.fill("real estate");
    await expect(page.getByTestId("script-templates").getByText("Property listing walkthrough")).toBeVisible();
    await expect(card(`Bakery promo ${tag}`)).toHaveCount(0);
    await page.getByRole("button", { name: "Marketing", exact: true }).click();
    await expect(scriptCards).toHaveCount(0);
    await expect(page.getByText("No script template in Marketing matches “real estate”.")).toBeVisible();
    await expect(matches).toContainText("script templates in Marketing");
    await page.getByRole("button", { name: /^Show the \d+ match(es)? in other categories$/ }).click();
    await expect(page.getByTestId("script-templates").getByText("Property listing walkthrough")).toBeVisible();

    // A copy made while searching stays in view, with its Edit button focused, even when its name does not match:
    // a copy of "(copy)" is "(copy 2)", which "(copy)" does not find.
    await search.fill(`Bakery promo ${tag}`);
    await mine.getByRole("button", { name: `Duplicate template Bakery promo ${tag}` }).click();
    await expect(card(`Bakery promo ${tag} (copy)`)).toBeVisible();
    await search.fill(`${tag} (copy)`);
    await expect(card(`Bakery promo ${tag}`)).toHaveCount(0);
    await mine.getByRole("button", { name: `Duplicate template Bakery promo ${tag} (copy)` }).click();
    await expect(card(`Bakery promo ${tag} (copy 2)`)).toBeVisible();
    await expect(mine.getByRole("button", { name: `Edit template Bakery promo ${tag} (copy 2)` })).toBeFocused();
    await expect(matches).toHaveText(new RegExp(`^1 of \\d+ saved templates`), { timeout: 5000 });

    // Renamed while a search is typed to a name it does not find, a template stays in view with its Edit button focused.
    await search.fill(`Bakery promo ${tag} (copy)`);
    await mine.getByRole("button", { name: `Edit template Bakery promo ${tag} (copy)`, exact: true }).click();
    await mine.getByLabel("Template name").fill(`Cake stand ${tag}`);
    await mine.getByRole("button", { name: "Save" }).click();
    await expect(card(`Cake stand ${tag}`)).toBeVisible();
    await expect(mine.getByRole("button", { name: `Edit template Cake stand ${tag}` })).toBeFocused();

    // An open edit form stays in view whatever is typed, so what it holds is not thrown away.
    await search.fill(`Cake stand ${tag}`);
    await mine.getByRole("button", { name: `Edit template Cake stand ${tag}` }).click();
    await mine.getByLabel("Template name").fill(`Cake stand ${tag} draft`);
    await search.fill(`nothing like it ${tag}`);
    await expect(mine.getByLabel("Template name")).toHaveValue(`Cake stand ${tag} draft`);
    await mine.getByRole("button", { name: "Cancel" }).click();
    await expect(card(`Cake stand ${tag}`)).toHaveCount(0);

    // Clearing the search shows everything again.
    await search.fill("");
    await expect(scriptCards).toHaveCount(allScripts);
    await expect(matches).toHaveText("");
  } finally {
    const { templates } = (await (await page.request.get("/api/templates")).json()) as { templates: Array<{ id: string; title: string }> };
    for (const t of templates.filter((x) => x.title.includes(tag))) await page.request.delete(`/api/templates/${t.id}`);
  }
});

test("each scene shows its own running time", async ({ page }) => {
  await page.goto("/create");
  await page.locator("textarea").fill(Array.from({ length: 25 }, (_, i) => `word${i}`).join(" "));
  await expect(page.getByTestId("script-length")).toHaveText("25 words · ~10s");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
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
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  // The browser converts the upload to WAV and saves it as a reusable clip; the scene then speaks it.
  await page.getByLabel("Upload scene audio").setInputFiles({ name: "founder-take.wav", mimeType: "audio/wav", buffer: toneWav(3) });
  await expect(page.getByTestId("scene-audio-name")).toHaveText("founder-take");
  await expect(page.getByText("Scene 2: what the clip says")).toBeVisible();
  // An audio scene has no voice to pick and nothing to preview with one.
  await expect(page.getByLabel("Scene voice")).toHaveCount(0);
  // (Listen to all scenes, for the whole video, stays.)
  await expect(page.getByRole("button", { name: "Listen", exact: true })).toHaveCount(0);
  await page.locator("textarea").fill("Hi, I recorded this myself.");
  // The words typed can go with the clip, so the next scene using it starts with them.
  await page.getByRole("button", { name: "Keep these words with the clip" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The words are kept with the clip" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep these words with the clip" })).toHaveCount(0);
  const founder = ((await (await page.request.get("/api/clips")).json()) as { clips: Array<{ name: string; transcript?: string }> }).clips.find((c) => c.name === "founder-take");
  expect(founder?.transcript).toBe("Hi, I recorded this myself.");
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
  // It starts with the words kept with it; going back to a voice takes them away, so a voice never reads them by mistake.
  await expect(page.locator("textarea")).toHaveValue("Hi, I recorded this myself.");
  await page.getByRole("button", { name: "Use a voice instead" }).click();
  await expect(page.getByText("Or use your own audio")).toBeVisible();
  await expect(page.locator("textarea")).toHaveValue("");
  // An edit with nothing to change is refused.
  expect((await page.request.patch(`/api/clips/${clip.id}`, { data: {} })).status()).toBe(400);
  // The API takes WAV or MP3 only, and reads a WAV's length itself.
  expect((await page.request.post("/api/clips", { data: { name: "Webm", audio: "data:audio/webm;base64,AAAA" } })).status()).toBe(400);
  expect((await page.request.delete(`/api/clips/${clip.id}`)).status()).toBe(204);
  expect((await page.request.get(`/api/clips/${clip.id}`)).status()).toBe(404);
});

test("scenes can be duplicated and reordered", async ({ page }) => {
  await page.goto("/create");
  await page.locator("textarea").fill("A.");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.locator("textarea").fill("B.");
  await page.getByRole("button", { name: "Duplicate scene", exact: true }).click();
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
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
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
  // A heading that starts a scene names it; the scenes before it and after --- have none.
  await expect(page.getByTestId("import-note")).toContainText("Imported 3 scenes from welcome.md, 1 named from its heading.");
  await expect(page.locator("input[placeholder='Video title']")).toHaveValue("Welcome aboard");
  await expect(page.locator("textarea")).toHaveValue("Hi, I'm Ava.\n\nGlad you're here.");
  await expect(page.getByTestId("scene-name-label")).toHaveText(["Wrap up"]);
  await page.getByRole("button", { name: /^Scene 3, Wrap up,/ }).click();
  await expect(page.locator("textarea")).toHaveValue("See you Monday!");
  await expect(page.getByLabel("Scene 3 name", { exact: true })).toHaveValue("Wrap up");
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

test("a pasted conversation makes one scene per turn, each speaker cast with a presenter and a voice", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill("Market chat");
  await page.locator("textarea").fill("A first draft.");
  const open = page.getByRole("button", { name: "Conversation", exact: true });
  await open.click();
  await expect(open).toHaveAttribute("aria-expanded", "true");
  const panel = page.getByTestId("conversation-import");
  await expect(open).toHaveAttribute("aria-controls", (await panel.getAttribute("id"))!);
  const box = panel.getByLabel("Paste or write the conversation");
  await expect(box).toBeFocused();
  // Escape closes it, as Cancel does, and the focus goes back to the button.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(open).toBeFocused();
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await open.click();
  await expect(panel.getByRole("button", { name: "Make scenes" })).toBeDisabled();
  // Text without names says how to write one (once the typing stops), and makes nothing.
  await box.fill("Just a paragraph of script.");
  await expect(page.getByTestId("conversation-status")).toContainText("No speakers found");
  await box.fill(["Spring market update", "Alex: Welcome back to the show.", "Sam: Thanks for having me.", "(laughs)", "ALEX: Prices are up.", "Inventory is down.", "Jordan: (leaning in) And rates?", "Riley: Thanks, all."].join("\n"));
  await expect(page.getByTestId("conversation-status")).toHaveText("4 speakers, 5 scenes; 1 line before the first name is left out; 2 stage directions in parentheses are not spoken.");
  const speakers = panel.getByRole("list", { name: "Speakers" }).getByRole("listitem");
  await expect(speakers).toHaveCount(4);
  await expect(speakers.nth(0)).toContainText("Alex · 2 scenes");
  // The first speaker is the video's presenter and voice; each other is offered a presenter and a voice the video and
  // earlier speakers are not, in the video voice's language (English): with none left, the video's voice.
  await expect(panel.getByLabel("Alex's presenter")).toHaveValue("");
  await expect(panel.getByLabel("Alex's voice")).toHaveValue("");
  const offered = async (name: string) => [await panel.getByLabel(`${name}'s presenter`).inputValue(), await panel.getByLabel(`${name}'s voice`).inputValue()];
  await expect(panel.getByLabel("Sam's presenter")).not.toHaveValue("");
  const [samAvatar, samVoice] = await offered("Sam");
  const [jordanAvatar, jordanVoice] = await offered("Jordan");
  const [rileyAvatar, rileyVoice] = await offered("Riley");
  const label = async (select: string, value: string) => (await panel.getByLabel(select).locator(`option[value="${value}"]`).textContent())!;
  const videoAvatarName = (await label("Alex's presenter", "")).match(/\((.*)\)/)![1];
  const videoVoiceName = (await label("Alex's voice", "")).match(/\((.*)\)/)![1];
  const presenters = [samAvatar, jordanAvatar, rileyAvatar];
  expect(new Set(presenters).size).toBe(3);
  for (const a of presenters) expect(await label("Sam's presenter", a)).not.toBe(videoAvatarName);
  expect(samVoice).not.toBe("");
  expect(jordanVoice).not.toBe("");
  expect(samVoice).not.toBe(jordanVoice);
  const voices = (await (await page.request.get("/api/voices")).json()).voices as Array<{ id: string; name: string; language?: string }>;
  for (const v of [samVoice, jordanVoice, rileyVoice].filter(Boolean)) {
    const voice = voices.find((x) => x.id === v)!;
    expect(voice.name).not.toBe(videoVoiceName);
    expect(voice.language).toMatch(/^en/);
  }
  // Never one of the voices that speak another language, even with no English voice left to offer.
  expect(["stock_voice_4", "stock_voice_5", "stock_voice_6"]).not.toContain(rileyVoice);
  // A presenter chosen for one speaker changes no one else's offer, and keeps the voice the speaker was offered.
  await panel.getByLabel("Sam's presenter").selectOption("stock_8");
  await expect(panel.getByLabel("Sam's voice")).toHaveValue(samVoice);
  expect(await offered("Jordan")).toEqual([jordanAvatar, jordanVoice]);
  await panel.getByLabel("Riley's voice").selectOption("stock_voice_1");
  const axe = await new AxeBuilder({ page }).include("[data-testid='conversation-import']").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations).toEqual([]);
  // Written scenes are only replaced once confirmed; declined, the panel stays as it was.
  page.once("dialog", (d) => d.dismiss());
  await panel.getByRole("button", { name: "Make 5 scenes" }).click();
  await expect(page.getByRole("textbox", { name: "Script", exact: true })).toHaveValue("A first draft.");
  await expect(panel).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await panel.getByRole("button", { name: "Make 5 scenes" }).click();
  await expect(panel).toHaveCount(0);
  await expect(open).toBeFocused();
  await expect(page.getByTestId("import-note")).toHaveText("Made 5 scenes from the conversation: Alex in 2, Sam in 1, Jordan in 1, Riley in 1.");
  await expect(page.locator("textarea")).toHaveValue("Welcome back to the show.");
  await expect(page.getByLabel("Scene avatar")).toHaveValue("");
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.locator("textarea")).toHaveValue("Thanks for having me.");
  await expect(page.getByLabel("Scene avatar")).toHaveValue("stock_8");
  await expect(page.getByLabel("Scene voice")).toHaveValue(samVoice);
  await page.getByRole("button", { name: /^Scene 3,/ }).click();
  await expect(page.locator("textarea")).toHaveValue("Prices are up.\nInventory is down.");
  await expect(page.getByLabel("Scene avatar")).toHaveValue("");
  await page.getByRole("button", { name: /^Scene 4,/ }).click();
  await expect(page.locator("textarea")).toHaveValue("And rates?");
  await expect(page.getByLabel("Scene avatar")).toHaveValue(jordanAvatar);
  // Each scene goes to the renderer with its speaker's presenter and voice.
  await page.getByRole("button", { name: "Generate video" }).click();
  await page.waitForURL(/\/videos\/vid_/);
  const id = page.url().split("/").pop()!;
  const video = (await (await page.request.get(`/api/videos/${id}`)).json()).video as { scenes: Array<{ script: string; avatarId?: string; voiceId?: string }> };
  expect(video.scenes.map((sc) => sc.script)).toEqual(["Welcome back to the show.", "Thanks for having me.", "Prices are up.\nInventory is down.", "And rates?", "Thanks, all."]);
  expect(video.scenes[0].avatarId).toBeUndefined();
  expect(video.scenes[0].voiceId).toBeUndefined();
  expect(video.scenes[1]).toMatchObject({ avatarId: "stock_8", voiceId: samVoice });
  expect(video.scenes[3]).toMatchObject({ avatarId: jordanAvatar, voiceId: jordanVoice });
  expect(video.scenes[4]).toMatchObject({ avatarId: rileyAvatar, voiceId: "stock_voice_1" });
  await page.request.delete(`/api/videos/${id}?permanent=true`);
});

test("a scene is split at the cursor and merged back with the next", async ({ page }) => {
  const script = page.getByRole("textbox", { name: "Script", exact: true });
  await script.fill("Welcome home. Let's look around.");
  // The words after the cursor become the next scene, and the cursor goes to its start.
  await script.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(13, 13));
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await expect(page.getByTestId("import-note")).toHaveText("Split scene 1: the words after the cursor are scene 2 now.");
  const second = page.getByRole("textbox", { name: "Scene 2 script" });
  await expect(second).toHaveValue("Let's look around.");
  await expect(second).toBeFocused();
  expect(await second.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(0);
  // A cut with nothing on one side says where to put the cursor, and makes no scene.
  await page.getByRole("button", { name: "Split", exact: true }).click();
  const refused = "Put the cursor between two words where the scene should be split, with words on both sides; a side of only pauses must last 1 to 60 seconds.";
  await expect(page.getByTestId("import-note")).toHaveText(refused);
  await expect(page.getByRole("button", { name: /^Scene 3,/ })).toHaveCount(0);
  // Nor is a word cut in half.
  await page.getByTestId("import-note").getByRole("button", { name: "Dismiss" }).click();
  await second.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(3, 3));
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await expect(page.getByTestId("import-note")).toHaveText(refused);
  await expect(page.getByRole("button", { name: /^Scene 3,/ })).toHaveCount(0);
  // The last scene has nothing to merge with.
  await expect(page.getByRole("button", { name: "Merge with next scene" })).toBeDisabled();
  await page.getByLabel("Scene avatar").selectOption("stock_3");
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await expect(page.getByRole("textbox", { name: "Scene 1 script" })).toHaveValue("Welcome home.");
  // Merging asks first when the next scene has a presenter of its own, which goes.
  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    void d.dismiss();
  });
  await page.getByRole("button", { name: "Merge with next scene" }).click();
  await expect.poll(() => asked).toBe("Merge scene 2 into scene 1? Scene 2's words join scene 1, which keeps its presenter; scene 2's is dropped.");
  await expect(page.getByRole("button", { name: /^Scene 2,/ })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Merge with next scene" }).click();
  await expect(page.getByTestId("import-note")).toHaveText("Merged scene 2 into scene 1.");
  await expect(page.getByRole("button", { name: /^Scene 2,/ })).toHaveCount(0);
  await expect(script).toHaveValue("Welcome home.\n\nLet's look around.");
  await expect(script).toBeFocused();
});

test("scene changes are undone and redone, by button and by keyboard outside the script", async ({ page }) => {
  const script = page.getByRole("textbox", { name: "Script", exact: true });
  await script.fill("Welcome home.");
  const undoButton = page.getByRole("button", { name: /^Undo/ });
  const redoButton = page.getByRole("button", { name: /^Redo/ });
  await expect(undoButton).toBeDisabled();
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await expect(undoButton).toHaveAccessibleName("Undo add scene 2");
  await undoButton.click();
  await expect(page.getByTestId("import-note")).toHaveText("Undid: add scene 2.");
  await expect(page.getByRole("button", { name: /^Scene 2,/ })).toHaveCount(0);
  await expect(script).toHaveValue("Welcome home.");
  // With nothing left to undo, the focus moves to Redo rather than being lost.
  await expect(redoButton).toBeFocused();
  await expect(redoButton).toHaveAccessibleName("Redo add scene 2");
  await redoButton.click();
  await expect(page.getByRole("button", { name: /^Scene 2,/ })).toBeVisible();
  // The keyboard works outside a text field; inside the script, Ctrl+Z is the text box's own.
  await page.getByRole("textbox", { name: "Scene 2 script" }).fill("A second scene.");
  await page.getByRole("button", { name: "Remove scene", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Scene 2,/ })).toHaveCount(0);
  await script.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByRole("button", { name: /^Scene 2,/ })).toHaveCount(0);
  await expect(script).toHaveValue("Welcome home.");
  await undoButton.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("import-note")).toHaveText("Undid: remove scene 2.");
  // The removed scene comes back selected, with its words.
  await expect(page.getByRole("textbox", { name: "Scene 2 script" })).toHaveValue("A second scene.");
  await redoButton.focus();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.getByRole("button", { name: /^Scene 2,/ })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByRole("button", { name: /^Scene 2,/ })).toBeVisible();
  await page.keyboard.press("Control+y");
  await expect(page.getByTestId("import-note")).toHaveText("Redid: remove scene 2.");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByRole("button", { name: /^Scene 2,/ })).toBeVisible();
  // Undoing over later edits asks first, as those edits would go too.
  await page.getByRole("button", { name: "Duplicate scene", exact: true }).click();
  await page.getByRole("textbox", { name: "Scene 3 script" }).fill("Changed after the copy.");
  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    void d.dismiss();
  });
  await undoButton.click();
  await expect.poll(() => asked).toBe("Undo “duplicate scene 2”? The changes made since then go too (and come back if you redo it).");
  await expect(page.getByRole("button", { name: /^Scene 3,/ })).toBeVisible();
  page.once("dialog", (d) => void d.accept());
  await undoButton.click();
  await expect(page.getByRole("button", { name: /^Scene 3,/ })).toHaveCount(0);
  // Redoing brings back the copy with the words typed into it after.
  await redoButton.click();
  await expect(page.getByRole("textbox", { name: "Scene 3 script" })).toHaveValue("Changed after the copy.");
  await undoButton.click();
  await expect(page.getByRole("button", { name: /^Scene 3,/ })).toHaveCount(0);
  // A merge that leaves one scene makes its presenter the video's; undoing it gives the video its presenter back.
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  const videoAvatar = page.getByLabel("Scene avatar").locator("option").first();
  const original = await videoAvatar.textContent();
  await page.getByLabel("Scene avatar").selectOption("stock_4");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Merge with next scene" }).click();
  await expect(page.getByRole("button", { name: /^Scene 2,/ })).toHaveCount(0);
  await undoButton.click();
  await expect(page.getByTestId("import-note")).toHaveText("Undid: merge scene 2 into scene 1.");
  await expect(page.getByRole("button", { name: /^Scene 2,/ })).toBeVisible();
  await expect(page.getByLabel("Scene avatar")).toHaveValue("stock_4");
  await expect(videoAvatar).toHaveText(original!);
});

test("the brand kit's colours are one-click swatches for a scene's on-screen text", async ({ page }) => {
  const before = (await (await page.request.get("/api/brand")).json()).brand as Record<string, unknown> | null;
  try {
    // Without a brand kit there is only the colour picker.
    if (before) expect((await page.request.delete("/api/brand")).ok()).toBe(true);
    await page.goto("/create");
    await page.evaluate(() => localStorage.removeItem("avatar-studio:draft"));
    const brandLoaded = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/brand");
    await page.reload();
    await brandLoaded;
    await page.getByRole("textbox", { name: "Script", exact: true }).fill("Welcome to 12 Elm Street.");
    await page.getByPlaceholder("Shown over the scene for its whole length").fill("12 Elm Street");
    await expect(page.getByLabel("Text colour")).toBeVisible();
    await expect(page.getByRole("group", { name: "Colour swatches" })).toHaveCount(0);

    expect((await page.request.put("/api/brand", { data: { name: "Acme", primaryColor: "#0F766E", accentColor: "#f59e0b" } })).ok()).toBe(true);
    // A fresh editor, so the kit's primary colour becomes the scene's background.
    await page.evaluate(() => localStorage.removeItem("avatar-studio:draft"));
    await page.reload();
    await page.getByPlaceholder("Shown over the scene for its whole length").fill("12 Elm Street");
    const swatches = page.getByRole("group", { name: "Colour swatches" });
    await expect(swatches.getByRole("button")).toHaveCount(3);
    const white = swatches.getByRole("button", { name: "White text" });
    const primary = swatches.getByRole("button", { name: "Brand primary text" });
    const accent = swatches.getByRole("button", { name: "Brand accent text" });
    await expect(primary).toHaveAttribute("title", "Brand primary: #0f766e");
    await expect(white).toHaveAttribute("aria-pressed", "true");
    await primary.click();
    await expect(primary).toHaveAttribute("aria-pressed", "true");
    await expect(white).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByLabel("Text colour")).toHaveValue("#0f766e");
    await expect(page.getByTestId("stage-text")).toHaveCSS("color", "rgb(15, 118, 110)");
    // On the kit's primary colour as the background, text in that colour cannot be read, and the editor says so.
    const hidden = page.getByText("This colour hardly shows on the scene's background colour");
    await expect(hidden).toBeVisible();
    await accent.click();
    await expect(hidden).toHaveCount(0);
    await expect(page.getByTestId("stage-text")).toHaveCSS("color", "rgb(245, 158, 11)");
    // A colour picked by hand that matches no swatch leaves them all unpressed; white goes back to the default.
    await page.getByLabel("Text colour").fill("#123456");
    await expect(swatches.getByRole("button", { pressed: true })).toHaveCount(0);
    await white.click();
    await expect(page.getByTestId("stage-text")).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(white).toHaveAttribute("aria-pressed", "true");
  } finally {
    await page.evaluate(() => localStorage.removeItem("avatar-studio:draft")).catch(() => {});
    const restored = before ? await page.request.put("/api/brand", { data: before }) : await page.request.delete("/api/brand");
    expect(restored.ok()).toBe(true);
  }
});

test("one scene's on-screen text style is given to every scene's text in one undoable change", async ({ page }) => {
  await page.goto("/create");
  await page.evaluate(() => localStorage.removeItem("avatar-studio:draft"));
  await page.reload();
  const text = page.getByPlaceholder("Shown over the scene for its whole length");
  const button = page.getByRole("button", { name: "Use this text style on every scene" });
  await page.getByRole("textbox", { name: "Script", exact: true }).fill("Welcome to 12 Elm Street.");
  await text.fill("12 Elm Street");
  await page.getByLabel("Text position").selectOption("bottom");
  await page.getByLabel("Text size").selectOption("large");
  await page.getByLabel("Text colour").fill("#000000");
  // Alone, there is no other scene to give it to.
  await expect(button).toHaveCount(0);
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByRole("textbox", { name: "Scene 2 script" }).fill("The kitchen.");
  // 36 characters fit on one line across a 16:9 frame at the medium size, not the large one.
  await text.fill("Kitchen redone with new oak cabinets");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByRole("textbox", { name: "Scene 3 script" }).fill("The garden.");
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await button.click();
  await expect(page.getByTestId("import-note")).toHaveText(
    "Scene 2 now shows its on-screen text as scene 1 does. It is too long for one line across a 16:9 frame at this size in scene 2.",
  );
  const undo = page.getByRole("button", { name: "Undo use scene 1's text style on every scene" });
  await expect(undo).toBeFocused();
  await expect(button).toHaveCount(0);
  // Scene 2 keeps its words in scene 1's style; scene 3, with no words on screen, is left alone.
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(text).toHaveValue("Kitchen redone with new oak cabinets");
  await expect(page.getByLabel("Text position")).toHaveValue("bottom");
  await expect(page.getByLabel("Text size")).toHaveValue("large");
  await expect(page.getByLabel("Text colour")).toHaveValue("#000000");
  await expect(page.getByRole("alert").filter({ hasText: "Too long for one line" })).toBeVisible();
  await page.getByRole("button", { name: /^Scene 3,/ }).click();
  await expect(text).toHaveValue("");
  await undo.click();
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.getByLabel("Text position")).toHaveValue("top");
  await expect(page.getByLabel("Text size")).toHaveValue("medium");
  await expect(page.getByLabel("Text colour")).toHaveValue("#ffffff");
  await page.getByRole("button", { name: "Redo use scene 1's text style on every scene" }).click();
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.getByLabel("Text position")).toHaveValue("bottom");
  await expect(page.getByLabel("Text size")).toHaveValue("large");
  await page.getByRole("button", { name: "Undo use scene 1's text style on every scene" }).click();
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.getByLabel("Text position")).toHaveValue("top");
  // From scene 2, the button offers scene 2's style to scene 1.
  await expect(button).toBeVisible();
  await page.evaluate(() => localStorage.removeItem("avatar-studio:draft"));
});

test("the brand kit's opening scene is set on the brand page and added at the start of a video in one click", async ({ page }) => {
  const before = (await (await page.request.get("/api/brand")).json()).brand as Record<string, unknown> | null;
  try {
    await page.goto("/brand");
    await page.getByLabel("Primary color", { exact: true }).fill("#0f766e");
    await page.getByLabel("Title on screen").fill("Acme Homes");
    await page.getByRole("button", { name: "Save brand kit" }).click();
    await expect(page.getByText("Add what the presenter says in the opening scene")).toBeVisible();
    await page.getByLabel("What the presenter says first").fill("Hi, I'm Dana from Acme Homes.");
    await page.getByRole("button", { name: "Save brand kit" }).click();
    await expect
      .poll(async () => ((await (await page.request.get("/api/brand")).json()).brand as { openingScene?: unknown } | null)?.openingScene)
      .toEqual({ script: "Hi, I'm Dana from Acme Homes.", text: "Acme Homes" });
    await page.reload();
    await expect(page.getByLabel("What the presenter says first")).toHaveValue("Hi, I'm Dana from Acme Homes.");
    await expect(page.getByLabel("Title on screen")).toHaveValue("Acme Homes");

    await page.goto("/create");
    await page.evaluate(() => localStorage.removeItem("avatar-studio:draft"));
    await page.reload();
    const opening = page.getByRole("button", { name: "Opening scene", exact: true });
    // A new video's one blank scene becomes the opening scene.
    await opening.click();
    await expect(page.getByTestId("import-note")).toHaveText("Added the brand kit's opening scene as scene 1.");
    const script = page.getByRole("textbox", { name: "Script", exact: true });
    await expect(script).toHaveValue("Hi, I'm Dana from Acme Homes.");
    await page.getByRole("button", { name: "Undo add the opening scene" }).click();
    await expect(script).toHaveValue("");
    // Before a video's own scenes, which move along.
    await script.fill("Welcome to 12 Elm Street.");
    await page.getByRole("button", { name: "Add scene", exact: true }).click();
    await page.getByRole("textbox", { name: "Scene 2 script" }).fill("The kitchen.");
    await opening.click();
    await expect(page.getByTestId("import-note")).toHaveText("Added the brand kit's opening scene as scene 1; scenes 1–2 are now 2–3.");
    await expect(page.getByRole("textbox", { name: "Scene 1 script" })).toHaveValue("Hi, I'm Dana from Acme Homes.");
    await expect(page.getByPlaceholder("Shown over the scene for its whole length")).toHaveValue("Acme Homes");
    await expect(page.getByLabel("Text position")).toHaveValue("center");
    await expect(page.getByRole("button", { name: /^Scene 1,/ }).locator("span").first()).toHaveCSS("background-color", "rgb(15, 118, 110)");
    await opening.click();
    await expect(page.getByTestId("import-note")).toHaveText("The first scene is already the brand kit's opening scene.");
    await expect(page.getByRole("button", { name: /^Scene 4,/ })).toHaveCount(0);
    await page.getByRole("button", { name: /^Scene 2,/ }).click();
    await expect(page.getByRole("textbox", { name: "Scene 2 script" })).toHaveValue("Welcome to 12 Elm Street.");
    // A kit without one offers no button; removing the kit clears it from the form.
    await page.request.put("/api/brand", { data: { name: "Acme", primaryColor: "#0f766e" } });
    await page.reload();
    await expect(page.getByRole("button", { name: "Opening scene", exact: true })).toHaveCount(0);
    await page.request.put("/api/brand", { data: { name: "Acme", primaryColor: "#0f766e", openingScene: { script: "Hello.", text: "Acme" } } });
    await page.goto("/brand");
    await expect(page.getByLabel("What the presenter says first")).toHaveValue("Hello.");
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Remove brand kit" }).click();
    await expect(page.getByLabel("What the presenter says first")).toHaveValue("");
    await expect(page.getByLabel("Title on screen")).toHaveValue("");
  } finally {
    await page.evaluate(() => localStorage.removeItem("avatar-studio:draft")).catch(() => {});
    const restored = before ? await page.request.put("/api/brand", { data: before }) : await page.request.delete("/api/brand");
    expect(restored.ok()).toBe(true);
  }
});

test("the brand kit's closing scene is set on the brand page and added at the end of a video in one click", async ({ page }) => {
  const before = (await (await page.request.get("/api/brand")).json()).brand as Record<string, unknown> | null;
  try {
    await page.goto("/brand");
    await page.getByLabel("Primary color", { exact: true }).fill("#0f766e");
    // On-screen text without words cannot make a scene, so it is refused with a reason.
    await page.getByLabel("On-screen text").fill("acmehomes.com");
    await page.getByRole("button", { name: "Save brand kit" }).click();
    await expect(page.getByText("Add what the presenter says in the closing scene")).toBeVisible();
    await page.getByLabel("What the presenter says", { exact: true }).fill("Call us today to book a showing.");
    await page.getByRole("button", { name: "Save brand kit" }).click();
    await expect
      .poll(async () => ((await (await page.request.get("/api/brand")).json()).brand as { closingScene?: unknown } | null)?.closingScene)
      .toEqual({ script: "Call us today to book a showing.", text: "acmehomes.com" });
    await page.reload();
    await expect(page.getByLabel("What the presenter says", { exact: true })).toHaveValue("Call us today to book a showing.");
    await expect(page.getByLabel("On-screen text")).toHaveValue("acmehomes.com");

    await page.goto("/create");
    await page.evaluate(() => localStorage.removeItem("avatar-studio:draft"));
    await page.reload();
    const closing = page.getByRole("button", { name: "Closing scene", exact: true });
    // A new video's one blank scene becomes the closing scene rather than being left empty before it.
    await closing.click();
    await expect(page.getByTestId("import-note")).toHaveText("Added the brand kit's closing scene as scene 1.");
    const script = page.getByRole("textbox", { name: "Script", exact: true });
    await expect(script).toHaveValue("Call us today to book a showing.");
    await page.getByRole("button", { name: "Undo add the closing scene" }).click();
    await expect(script).toHaveValue("");
    await script.fill("Welcome to 12 Elm Street.");
    await closing.click();
    await expect(page.getByTestId("import-note")).toHaveText("Added the brand kit's closing scene as scene 2.");
    await expect(page.getByRole("textbox", { name: "Scene 2 script" })).toHaveValue("Call us today to book a showing.");
    await expect(page.getByPlaceholder("Shown over the scene for its whole length")).toHaveValue("acmehomes.com");
    await expect(page.getByLabel("Text position")).toHaveValue("bottom");
    // On the kit's background (its primary colour, with no default picture).
    await expect(page.getByRole("button", { name: /^Scene 2,/ }).locator("span").first()).toHaveCSS("background-color", "rgb(15, 118, 110)");
    // A second click does not add it twice.
    await closing.click();
    await expect(page.getByTestId("import-note")).toHaveText("The last scene is already the brand kit's closing scene.");
    await expect(page.getByRole("button", { name: /^Scene 3,/ })).toHaveCount(0);
    await page.getByRole("button", { name: /^Scene 1,/ }).click();
    await expect(page.getByRole("textbox", { name: "Scene 1 script" })).toHaveValue("Welcome to 12 Elm Street.");
    // A kit without a closing scene offers no button.
    await page.request.put("/api/brand", { data: { name: "Acme", primaryColor: "#0f766e" } });
    await page.reload();
    await expect(page.getByRole("button", { name: "Closing scene", exact: true })).toHaveCount(0);
    // Removing the kit clears the closing scene from the form too, so the next save does not bring it back.
    await page.request.put("/api/brand", { data: { name: "Acme", primaryColor: "#0f766e", closingScene: { script: "Bye.", text: "acme.com" } } });
    await page.goto("/brand");
    await expect(page.getByLabel("What the presenter says", { exact: true })).toHaveValue("Bye.");
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Remove brand kit" }).click();
    await expect(page.getByLabel("What the presenter says", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("On-screen text")).toHaveValue("");
  } finally {
    const restored = before ? await page.request.put("/api/brand", { data: before }) : await page.request.delete("/api/brand");
    expect(restored.ok()).toBe(true);
  }
});

test("the brand kit's writing style is set on the brand page, counted as it is typed, and cleared with the kit", async ({ page }) => {
  const before = (await (await page.request.get("/api/brand")).json()).brand as Record<string, unknown> | null;
  const style = "Warm and plain-spoken, like a neighbour. Say home, not property.";
  try {
    await page.goto("/brand");
    await page.getByLabel("Primary color", { exact: true }).fill("#0f766e");
    const field = page.getByRole("textbox", { name: "Writing style" });
    await expect(field).toHaveAttribute("maxlength", "600");
    await field.fill(`  ${style}  `);
    await expect(page.locator("#writing-style-count")).toHaveText(`${style.length + 4} of 600 characters`);
    await expect(page.locator("#writing-style-hint")).toContainText("not one HeyGen's agent directs");
    await expect(page.locator("#writing-style-hint")).toContainText("share-page description or title ideas");
    // At the limit the count says so, and a screen reader hears it once.
    await field.fill("a".repeat(600));
    await expect(page.locator("#writing-style-count")).toContainText("Limit reached");
    await expect(page.getByText("Writing style: character limit reached.")).toBeAttached();
    await field.fill(`  ${style}  `);
    await page.getByRole("button", { name: "Save brand kit" }).click();
    // Saved without the spaces around it, and read back into the form.
    await expect.poll(async () => ((await (await page.request.get("/api/brand")).json()).brand as { writingStyle?: string } | null)?.writingStyle).toBe(style);
    await page.reload();
    await expect(field).toHaveValue(style);
    // A blank style is none.
    await field.fill("   ");
    await page.getByRole("button", { name: "Save brand kit" }).click();
    await expect.poll(async () => "writingStyle" in (((await (await page.request.get("/api/brand")).json()).brand as object | null) ?? {})).toBe(false);
    // Removing the kit clears it from the form, so the next save does not bring it back.
    await page.request.put("/api/brand", { data: { name: "Acme", primaryColor: "#0f766e", writingStyle: style } });
    await page.reload();
    await expect(field).toHaveValue(style);
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Remove brand kit" }).click();
    await expect(field).toHaveValue("");
    // A style longer than the field allows is refused by the server too.
    const long = await page.request.put("/api/brand", { data: { name: "Acme", primaryColor: "#0f766e", writingStyle: "a".repeat(601) } });
    expect(long.status()).toBe(400);
  } finally {
    const restored = before ? await page.request.put("/api/brand", { data: before }) : await page.request.delete("/api/brand");
    expect(restored.ok()).toBe(true);
  }
});

test("a scene tab dragged onto another moves the scene there, a change Undo takes back", async ({ page }) => {
  await page.getByRole("textbox", { name: "Script", exact: true }).fill("First.");
  // One scene has nowhere to go.
  await expect(page.getByRole("button", { name: /^Scene 1,/ })).toHaveAttribute("draggable", "false");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByRole("textbox", { name: "Scene 2 script" }).fill("Second.");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByRole("textbox", { name: "Scene 3 script" }).fill("Third.");
  await expect(page.getByRole("button", { name: /^Scene 3,/ })).toHaveAttribute("draggable", "true");
  await page.getByRole("button", { name: /^Scene 3,/ }).dragTo(page.getByRole("button", { name: /^Scene 1,/ }));
  await expect(page.getByTestId("import-note")).toHaveText("Moved scene 3 to 1.");
  // The focus follows the moved tab to its new place.
  await expect(page.getByRole("button", { name: /^Scene 1,/ })).toBeFocused();
  // The moved scene is selected in its new place, and the others keep their order after it.
  await expect(page.getByRole("textbox", { name: "Scene 1 script" })).toHaveValue("Third.");
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.getByRole("textbox", { name: "Scene 2 script" })).toHaveValue("First.");
  await page.getByRole("button", { name: /^Scene 3,/ }).click();
  await expect(page.getByRole("textbox", { name: "Scene 3 script" })).toHaveValue("Second.");
  await page.getByRole("button", { name: "Undo move scene 3 to 1" }).click();
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await expect(page.getByRole("textbox", { name: "Scene 1 script" })).toHaveValue("First.");
  // Forward too: the first scene dropped on the last goes last, the others moving up.
  await page.getByRole("button", { name: /^Scene 1,/ }).dragTo(page.getByRole("button", { name: /^Scene 3,/ }));
  await expect(page.getByTestId("import-note")).toHaveText("Moved scene 1 to 3.");
  await expect(page.getByRole("textbox", { name: "Scene 3 script" })).toHaveValue("First.");
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await expect(page.getByRole("textbox", { name: "Scene 1 script" })).toHaveValue("Second.");
  // A tab dropped on itself (a real drag, a few pixels across the same tab) changes nothing.
  const second = page.getByRole("button", { name: /^Scene 2,/ });
  await second.dragTo(second, { sourcePosition: { x: 4, y: 6 }, targetPosition: { x: 16, y: 10 } });
  await expect(page.getByRole("button", { name: /^Undo/ })).toHaveAccessibleName("Undo move scene 1 to 3");
  await expect(page.getByTestId("import-note")).toHaveText("Moved scene 1 to 3.");
});

test("a scene's background is used on every scene in one change, which Undo takes back", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill("Same backdrop");
  await page.getByRole("textbox", { name: "Script", exact: true }).fill("First.");
  // One scene has nothing to share its background with.
  await page.getByRole("button", { name: "Background" }).click();
  await expect(page.getByTestId("background-scope")).toHaveCount(0);
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByRole("textbox", { name: "Scene 2 script" }).fill("Second.");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByRole("textbox", { name: "Scene 3 script" }).fill("Third.");
  // Scenes added after the first share its background, so there is nothing to copy yet.
  await expect(page.getByTestId("background-scope")).toContainText("All of them have this one for now.");
  await expect(page.getByRole("button", { name: "Use on every scene" })).toHaveCount(0);
  // Scenes 2 and 3 get a picture without the presenter, scene 2's shown whole.
  for (const n of [2, 3]) {
    await page.getByRole("button", { name: new RegExp(`^Scene ${n},`) }).click();
    await page.getByLabel("Image URL").fill("https://example.com/kitchen.jpg");
    await page.getByRole("checkbox", { name: new RegExp(`Show the presenter in scene ${n}`) }).uncheck();
  }
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await page.getByRole("button", { name: /Show all of it/ }).click();
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await page.getByLabel("Background #0f172a").click();
  await page.getByRole("button", { name: "Use on every scene" }).click();
  await expect(page.getByTestId("import-note")).toHaveText("Every scene now has scene 1's background. Scenes 2 and 3 show the presenter again, since a color cannot fill the frame in the presenter's place.");
  await expect(page.getByTestId("background-scope")).toContainText("All of them have this one for now.");
  // The button is gone, so the focus is on Undo, which names the change.
  await expect(page.getByRole("button", { name: "Undo use scene 1's background on every scene" })).toBeFocused();
  for (const n of [2, 3]) {
    await page.getByRole("button", { name: new RegExp(`^Scene ${n},`) }).click();
    await expect(page.getByRole("checkbox", { name: new RegExp(`Show the presenter in scene ${n}`) })).toBeChecked();
    await expect(page.getByLabel("Custom color")).toHaveValue("#0f172a");
  }
  // One Undo takes it all back: the pictures, scene 2's fit, the presenter left out; scene 1 keeps its colour.
  await page.getByRole("button", { name: "Undo use scene 1's background on every scene" }).click();
  await expect(page.getByRole("button", { name: /^Undo/ })).toHaveAccessibleName("Undo add scene 3");
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.getByRole("checkbox", { name: /Show the presenter in scene 2/ })).not.toBeChecked();
  await expect(page.getByLabel("Image URL")).toHaveValue("https://example.com/kitchen.jpg");
  await expect(page.getByRole("button", { name: /Show all of it/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^Scene 3,/ }).click();
  await expect(page.getByRole("checkbox", { name: /Show the presenter in scene 3/ })).not.toBeChecked();
  await expect(page.getByRole("button", { name: /Fill the frame/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await expect(page.getByLabel("Custom color")).toHaveValue("#0f172a");
  // Redo gives it again, and Undo takes it back once more.
  await page.getByRole("button", { name: "Redo use scene 1's background on every scene" }).click();
  await page.getByRole("button", { name: /^Scene 3,/ }).click();
  await expect(page.getByRole("checkbox", { name: /Show the presenter in scene 3/ })).toBeChecked();
  await page.getByRole("button", { name: "Undo use scene 1's background on every scene" }).click();
  // From scene 2 the picture, shown whole, goes to the others; nothing about the presenter changes.
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await page.getByRole("button", { name: "Use on every scene" }).click();
  await expect(page.getByTestId("import-note")).toHaveText("Every scene now has scene 2's background.");
  await page.getByRole("button", { name: /^Scene 3,/ }).click();
  await expect(page.getByRole("button", { name: /Show all of it/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("checkbox", { name: /Show the presenter in scene 3/ })).not.toBeChecked();
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate video" }).click();
  const scenes = (await sent).postDataJSON().scenes as Array<{ script: string; background: unknown; hidePresenter?: boolean }>;
  expect(scenes.map((sc) => sc.script)).toEqual(["First.", "Second.", "Third."]);
  expect(scenes.map((sc) => sc.background)).toEqual(Array(3).fill({ type: "image", value: "https://example.com/kitchen.jpg", fit: "contain" }));
  expect(scenes.map((sc) => !!sc.hidePresenter)).toEqual([false, true, true]);
});

test("Add scene puts the new scene right after the selected one, on its background", async ({ page }) => {
  await page.getByRole("textbox", { name: "Script", exact: true }).fill("First.");
  await page.getByRole("button", { name: "Background" }).click();
  // Whatever colour the scenes start on (a brand kit's, say), scene 1 is given another one below.
  const startColor = await page.getByLabel("Custom color").inputValue();
  const marked = startColor === "#0f172a" ? "#be123c" : "#0f172a";
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByRole("textbox", { name: "Scene 2 script" }).fill("Second.");
  // With the last scene selected the new one goes at the end, as before, without a note.
  await expect(page.getByRole("button", { name: "Add scene", exact: true })).not.toHaveAttribute("title");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await expect(page.getByTestId("import-note")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Scene 3 script" }).fill("Third.");
  // From scene 1, on a colour of its own, the new scene comes second, on that colour.
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await page.getByLabel(`Background ${marked}`).click();
  await expect(page.getByRole("button", { name: "Add scene", exact: true })).toHaveAttribute("title", "Add a scene after scene 1");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await expect(page.getByTestId("import-note")).toHaveText("Added scene 2 after scene 1; scenes 2–3 are now 3–4.");
  await expect(page.getByRole("textbox", { name: "Scene 2 script" })).toHaveValue("");
  await expect(page.getByLabel("Custom color")).toHaveValue(marked);
  await page.getByRole("button", { name: /^Scene 3,/ }).click();
  await expect(page.getByRole("textbox", { name: "Scene 3 script" })).toHaveValue("Second.");
  await expect(page.getByLabel("Custom color")).toHaveValue(startColor);
  await page.getByRole("button", { name: /^Scene 4,/ }).click();
  await expect(page.getByRole("textbox", { name: "Scene 4 script" })).toHaveValue("Third.");
  // Undo takes the inserted scene out again; scene 1 keeps the colour it had before the add.
  await page.getByRole("button", { name: "Undo add scene 2" }).click();
  await expect(page.getByRole("button", { name: /^Scene 4,/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await expect(page.getByLabel("Custom color")).toHaveValue(marked);
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.getByRole("textbox", { name: "Scene 2 script" })).toHaveValue("Second.");
  // From the second of three, one scene moves along; an add at the end then clears that note.
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await expect(page.getByTestId("import-note")).toHaveText("Added scene 3 after scene 2; scene 3 is now scene 4.");
  await expect(page.getByRole("textbox", { name: "Scene 3 script" })).toHaveValue("");
  await page.getByRole("button", { name: /^Scene 4,/ }).click();
  await expect(page.getByRole("textbox", { name: "Scene 4 script" })).toHaveValue("Third.");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await expect(page.getByTestId("import-note")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Scene 5 script" })).toHaveValue("");
});

test("a scene copied in one video is pasted into another, in the same space only", async ({ page }) => {
  // A second editor, opened before anything is copied, has nothing to paste.
  const other = await page.context().newPage();
  await other.goto("/create");
  await expect(other.getByRole("button", { name: /^Scene 1,/ })).toBeVisible();
  await expect(other.getByRole("button", { name: "Paste scene" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Script", exact: true }).fill("First.");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByRole("textbox", { name: "Scene 2 script" }).fill("The kitchen was redone last spring.");
  await page.getByRole("button", { name: "Background" }).click();
  await page.getByLabel("Image URL").fill("https://example.com/kitchen.jpg");
  await page.getByRole("button", { name: /Show all of it/ }).click();
  await page.getByRole("checkbox", { name: /Show the presenter in scene 2/ }).uncheck();
  await expect(page.getByRole("button", { name: "Paste scene" })).toHaveCount(0);
  await page.getByRole("button", { name: "Copy scene" }).click();
  await expect(page.getByTestId("import-note")).toHaveText("Copied scene 2. Paste scene puts it after the selected scene, in this video or another one in this space.");
  // Pasted in the same video after scene 1, it is a scene of its own that Undo takes out.
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await expect(page.getByRole("button", { name: "Paste scene" })).toHaveAttribute("title", "Paste the copied scene (“The kitchen was redone last spring.”) after scene 1");
  await page.getByRole("button", { name: "Paste scene" }).click();
  await expect(page.getByTestId("import-note")).toHaveText("Pasted the copied scene as scene 2.");
  await expect(page.getByRole("textbox", { name: "Scene 2 script" })).toHaveValue("The kitchen was redone last spring.");
  await expect(page.getByRole("checkbox", { name: /Show the presenter in scene 2/ })).not.toBeChecked();
  await expect(page.getByLabel("Image URL")).toHaveValue("https://example.com/kitchen.jpg");
  await expect(page.getByRole("button", { name: /Show all of it/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Undo paste scene 2" }).click();
  await expect(page.getByRole("button", { name: /^Scene 3,/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Redo paste scene 2" })).toBeEnabled();
  // The other editor hears of the copy and puts it in place of its one blank scene.
  await expect(other.getByRole("button", { name: "Paste scene" })).toHaveAttribute("title", /in place of the blank scene$/);
  await other.getByRole("button", { name: "Paste scene" }).click();
  await expect(other.getByTestId("import-note")).toHaveText("Pasted the copied scene in place of the blank one.");
  await expect(other.getByRole("button", { name: /^Scene 2,/ })).toHaveCount(0);
  await expect(other.getByRole("textbox", { name: "Script", exact: true })).toHaveValue("The kitchen was redone last spring.");
  await expect(other.getByRole("checkbox", { name: /Show the presenter/ })).not.toBeChecked();
  // A copy made in another space (another workspace's pictures and clips) is not offered here.
  await other.evaluate(() => {
    const copy = JSON.parse(localStorage.getItem("avatar-studio:scene-clipboard")!);
    localStorage.setItem("avatar-studio:scene-clipboard", JSON.stringify({ ...copy, space: "ws_somewhere_else" }));
  });
  await other.reload();
  await expect(other.getByRole("button", { name: /^Scene 1,/ })).toBeVisible();
  await expect(other.getByRole("button", { name: "Copy scene" })).toBeEnabled();
  await expect(other.getByRole("button", { name: "Paste scene" })).toHaveCount(0);
  // Copied again in this space, from the first editor, it is offered in the second without a reload.
  await page.bringToFront();
  await page.getByRole("button", { name: "Copy scene" }).click();
  await other.bringToFront();
  await expect(other.getByRole("button", { name: "Paste scene" })).toBeVisible();
  await other.close();
});

test("a scene's presenter, voice, and pace are used on every scene in one change, which Undo takes back", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill("Same cast");
  await page.getByRole("textbox", { name: "Script", exact: true }).fill("First.");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByRole("textbox", { name: "Scene 2 script" }).fill("Second.");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByRole("textbox", { name: "Scene 3 script" }).fill("Third.");
  const row = page.getByTestId("scene-presenter");
  // Every scene uses the video's presenter and voice, so there is nothing to give.
  await expect(row.getByRole("button", { name: /on every scene$/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await row.getByLabel("Scene avatar").selectOption({ index: 2 });
  const avatarId = await row.getByLabel("Scene avatar").inputValue();
  await row.getByLabel("Scene voice").selectOption({ index: 2 });
  const voiceId = await row.getByLabel("Scene voice").inputValue();
  await row.getByLabel("Scene speed").selectOption("1.25");
  // With the Background tab open over a scene of its own colour, both buttons show, each named for what it gives.
  await page.getByRole("button", { name: "Background" }).click();
  await page.getByLabel("Background #0f172a").click();
  await expect(page.getByRole("button", { name: "Use on every scene", exact: true })).toHaveCount(1);
  const give = page.getByRole("button", { name: "Use this scene's presenter, voice, and pace on every scene" });
  await expect(give).toHaveCount(1);
  await give.click();
  await expect(page.getByTestId("import-note")).toHaveText("Scenes 2 and 3 now have scene 1's presenter, voice, and pace.");
  // Every scene matches, so the button is gone and the focus is on Undo, which names the change.
  await expect(row.getByRole("button", { name: /on every scene$/ })).toHaveCount(0);
  const undo = page.getByRole("button", { name: "Undo use scene 1's presenter, voice, and pace on every scene" });
  await expect(undo).toBeFocused();
  for (const n of [2, 3]) {
    await page.getByRole("button", { name: new RegExp(`^Scene ${n},`) }).click();
    await expect(row.getByLabel("Scene avatar")).toHaveValue(avatarId);
    await expect(row.getByLabel("Scene voice")).toHaveValue(voiceId);
    await expect(row.getByLabel("Scene speed")).toHaveValue("1.25");
  }
  // One Undo puts scenes 2 and 3 back on the video's; scene 1 keeps its own.
  await undo.click();
  await expect(page.getByRole("button", { name: /^Undo/ })).toHaveAccessibleName("Undo add scene 3");
  await page.getByRole("button", { name: /^Scene 3,/ }).click();
  await expect(row.getByLabel("Scene avatar")).toHaveValue("");
  await expect(row.getByLabel("Scene voice")).toHaveValue("");
  await expect(row.getByLabel("Scene speed")).toHaveValue("");
  // Scene 3, on the video's, offers that back, said as what it is: clearing scene 1's own.
  await page.getByRole("button", { name: "Use the video's presenter, voice, and pace on every scene" }).click();
  await expect(page.getByTestId("import-note")).toHaveText("Scene 1 now uses the video's presenter, voice, and pace again.");
  await page.getByRole("button", { name: "Undo use the video's presenter, voice, and pace on every scene" }).click();
  // Given again from scene 1, the render gets the same presenter, voice, and pace for every scene.
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await page.getByRole("button", { name: "Use this scene's presenter, voice, and pace on every scene" }).click();
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate video" }).click();
  const scenes = (await sent).postDataJSON().scenes as Array<{ avatarId?: string; voiceId?: string; speed?: number }>;
  expect(scenes.map((sc) => [sc.avatarId, sc.voiceId, sc.speed])).toEqual(Array(3).fill([avatarId, voiceId, 1.25]));
});

test("Listen to all scenes plays each scene in turn in its voice and pace, holds a silent one, and stops", async ({ page }) => {
  // The browser's speech stands in for the provider's audio (the preview answers 204, as in demo mode); the stand-in
  // records what is said and when, and finishes after a while the test sets.
  await page.addInitScript(() => {
    const w = window as unknown as { __said: Array<{ text: string; rate: number; at: number }>; __sayMs: number };
    w.__said = [];
    w.__sayMs = 50;
    window.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => {
      w.__said.push({ text: u.text, rate: u.rate, at: performance.now() });
      setTimeout(() => u.onend?.(new Event("end") as SpeechSynthesisEvent), w.__sayMs);
    };
    window.speechSynthesis.cancel = () => undefined;
  });
  const asked: Array<{ voiceId: string; text: string; speed: number }> = [];
  await page.route("**/api/voices/preview", async (route) => {
    asked.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.reload();
  const said = () => page.evaluate(() => (window as unknown as { __said: Array<{ text: string; rate: number; at: number }> }).__said);
  await page.getByRole("textbox", { name: "Script", exact: true }).fill("First.");
  // One scene has only its own Listen.
  await expect(page.getByRole("button", { name: "Listen to all scenes" })).toHaveCount(0);
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByRole("textbox", { name: "Scene 2 script" }).fill("Second.");
  await page.getByTestId("scene-presenter").getByLabel("Scene speed").selectOption("1.25");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByRole("textbox", { name: "Scene 3 script" }).fill("[pause 1s]");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByRole("textbox", { name: "Scene 4 script" }).fill("Last.");
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  const listen = page.getByRole("button", { name: "Listen to all scenes" });
  await listen.click();
  await expect(page.getByRole("button", { name: "Stop listening" })).toBeVisible();
  // The scene being heard is marked and read out; the selection stays where it was, so typing is never moved.
  await expect(page.getByTestId("scene-playing")).toHaveCount(1);
  await expect(page.getByRole("status").filter({ hasText: /^Playing scene \d of 4$/ })).toHaveCount(1);
  await expect(listen).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("scene-playing")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Scene 2 script" })).toBeVisible();
  const all = await said();
  expect(all.map(({ text, rate }) => ({ text, rate }))).toEqual([
    { text: "First.", rate: 1 },
    { text: "Second.", rate: 1.25 },
    { text: "Last.", rate: 1 },
  ]);
  // The silent scene held for its second between the second scene and the last.
  expect(all[2].at - all[1].at).toBeGreaterThan(950);
  expect(asked.map((a) => [a.text, a.speed])).toEqual([["First.", 1], ["Second.", 1.25], ["Last.", 1]]);
  expect(new Set(asked.map((a) => a.voiceId)).size).toBe(1);
  // Stopped while the first scene is being said, it says no more.
  await page.evaluate(() => void ((window as unknown as { __sayMs: number }).__sayMs = 400));
  await listen.click();
  await expect.poll(async () => (await said()).length).toBe(4);
  await page.getByRole("button", { name: "Stop listening" }).click();
  await expect(listen).toBeVisible();
  await page.waitForTimeout(1200);
  expect(await said()).toHaveLength(4);
  // A change to the scenes while it plays stops it, so it never plays words that are gone.
  await listen.click();
  await expect.poll(async () => (await said()).length).toBe(5);
  await page.getByRole("textbox", { name: "Scene 2 script" }).fill("Second, reworded.");
  await expect(listen).toBeVisible();
  await page.waitForTimeout(1200);
  expect(await said()).toHaveLength(5);
});

test("← and →, Home, and End move between scene tabs, the focus going with the selection", async ({ page }) => {
  await page.getByRole("textbox", { name: "Script", exact: true }).fill("First.");
  for (const n of [2, 3, 4]) {
    await page.getByRole("button", { name: "Add scene", exact: true }).click();
    await page.getByRole("textbox", { name: `Scene ${n} script` }).fill(`Scene ${n} words.`);
  }
  const tab = (n: number) => page.getByRole("button", { name: new RegExp(`^Scene ${n},`) });
  const at = async (n: number) => {
    await expect(tab(n)).toBeFocused();
    await expect(tab(n)).toHaveAttribute("aria-current", "true");
  };
  await expect(tab(1)).toHaveAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight Home End");
  await tab(1).click();
  await page.keyboard.press("ArrowRight");
  await at(2);
  await expect(page.getByRole("textbox", { name: "Scene 2 script" })).toHaveValue("Scene 2 words.");
  await page.keyboard.press("ArrowLeft");
  await at(1);
  // End and Home jump to the ends, not one step.
  await page.keyboard.press("End");
  await at(4);
  await page.keyboard.press("ArrowLeft");
  await at(3);
  await page.keyboard.press("Home");
  await at(1);
  // Past either end there is nowhere to go; the selection stays.
  await page.keyboard.press("ArrowLeft");
  await at(1);
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowRight");
  await at(4);
  // From a tab that has the focus but is not the selected scene, Home still goes to the first scene.
  await tab(1).focus();
  await expect(tab(4)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Home");
  await at(1);
  // With a modifier the keys are left alone (Shift+arrow belongs to the browser and assistive tech).
  await page.keyboard.press("Shift+ArrowRight");
  await at(1);
  // The shortcuts list names them.
  await page.keyboard.press("Control+/");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toContainText("Go to the scene before or after (on a scene's number in the Scenes row)");
  await expect(dialog).toContainText("Go to the first or last scene (on a scene's number in the Scenes row)");
  await page.keyboard.press("Escape");
  await expect(tab(1)).toBeFocused();
});

test("other scenes without words are named below the script, one is a click away, and blank ones go in one change Undo takes back", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill("Gaps");
  await page.getByRole("textbox", { name: "Script", exact: true }).fill("First.");
  const notice = page.getByTestId("wordless-scenes");
  const addScene = page.getByRole("button", { name: "Add scene", exact: true });
  const tab = (n: number) => page.getByRole("button", { name: new RegExp(`^Scene ${n},`) });
  // A scene just added is the selected one, which is not named: its own box already says it is empty.
  await addScene.click();
  await expect(notice).toHaveCount(0);
  // A pause counts as words: a scene of one holds in silence.
  await page.getByRole("textbox", { name: "Scene 2 script" }).fill("[pause 2s]");
  await expect(notice).toHaveCount(0);
  for (let i = 0; i < 4; i++) await addScene.click();
  await expect(notice.getByRole("status")).toHaveText("Scenes 3, 4, and 5 have no words yet; every scene needs some, or a pause to hold in silence, before the video can be generated.");
  // Scene 4 gets its own pace and scene 5 on-screen text: named still, but not blank, so they stay.
  await tab(4).click();
  await page.getByLabel("Scene speed").selectOption("0.75");
  await tab(5).click();
  await page.getByLabel(/On-screen text for scene 5/).fill("Call 555-0100");
  await tab(1).click();
  await expect(notice.getByRole("status")).toHaveText(/^Scenes 3, 4, 5, and 6 have no words yet/);
  await expect(page.getByRole("button", { name: "Generate video" })).toBeDisabled();
  // Go to scene 3 selects it and puts the cursor in its script; it is then left out, and so is its Remove.
  await notice.getByRole("button", { name: "Go to scene 3" }).click();
  await expect(page.getByRole("textbox", { name: "Scene 3 script" })).toBeFocused();
  await expect(notice.getByRole("status")).toHaveText(/^Scenes 4, 5, and 6 have no words yet/);
  await expect(notice.getByRole("button", { name: "Remove blank scene 6" })).toBeVisible();
  // From scene 2, the two blank ones go in one change, scene 2 staying selected.
  await tab(2).click();
  await notice.getByRole("button", { name: "Remove 2 blank scenes" }).click();
  await expect(page.getByTestId("import-note")).toHaveText("Removed scenes 3 and 6, which were blank.");
  await expect(page.getByRole("button", { name: "Undo remove 2 blank scenes" })).toBeFocused();
  await expect(tab(5)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Scene 2 script" })).toHaveValue("[pause 2s]");
  await expect(page.getByRole("textbox", { name: "Scene 2 script" })).toBeVisible();
  await expect(notice.getByRole("status")).toHaveText(/^Scenes 3 and 4 have no words yet/);
  await expect(notice.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  // Words for both clear the notice and Generate is back.
  await tab(3).click();
  await page.getByRole("textbox", { name: "Scene 3 script" }).fill("Slowly now.");
  await tab(4).click();
  await page.getByRole("textbox", { name: "Scene 4 script" }).fill("Call us today.");
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Generate video" })).toBeEnabled();
  // Undo of the removal asks first, as scenes changed since, and brings the blank scenes back; Redo takes them out again.
  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    void d.accept();
  });
  await page.getByRole("button", { name: "Undo remove 2 blank scenes" }).click();
  expect(asked).toContain("remove 2 blank scenes");
  await expect(tab(6)).toBeVisible();
  await expect(notice.getByRole("status")).toHaveText(/no words yet/);
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Redo remove 2 blank scenes" }).click();
  await expect(tab(5)).toHaveCount(0);
});

test("All scripts shows every scene's script in one column, a box selecting its scene as it is written in", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill("Walkthrough");
  await page.getByRole("textbox", { name: "Script", exact: true }).fill("Welcome in.");
  const addScene = page.getByRole("button", { name: "Add scene", exact: true });
  await addScene.click();
  await page.getByRole("textbox", { name: "Scene 2 script" }).fill("This is the kitchen.");
  await addScene.click();
  const toggle = page.getByRole("button", { name: "All scripts" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const view = page.getByTestId("script-view");
  await expect(view.getByRole("textbox")).toHaveCount(3);
  await expect(page.getByRole("heading", { name: "Every scene's script · scene 3 selected" })).toBeVisible();
  // The selected scene's box has the focus; a scene without words says so.
  await expect(view.getByRole("textbox", { name: "Scene 3 script" })).toBeFocused();
  await expect(view.getByRole("listitem").nth(2)).toContainText("no words yet");
  await expect(view.getByRole("textbox", { name: "Scene 1 script" })).toHaveValue("Welcome in.");
  // Clicking or writing in a box selects its scene, so Pause and the stage follow it.
  await view.getByRole("textbox", { name: "Scene 1 script" }).click();
  await expect(page.getByRole("button", { name: /^Scene 1,/ })).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { name: "Every scene's script · scene 1 selected" })).toBeVisible();
  await view.getByRole("textbox", { name: "Scene 1 script" }).press("End");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(view.getByRole("textbox", { name: "Scene 1 script" })).toHaveValue("Welcome in. [pause 1s] ");
  await view.getByRole("textbox", { name: "Scene 3 script" }).fill("Thanks for watching.");
  await expect(page.getByRole("button", { name: /^Scene 3,/ })).toHaveAttribute("aria-current", "true");
  await expect(view.getByRole("listitem").nth(2)).not.toContainText("no words yet");
  // The focus passing through another box on the way back to the buttons leaves the scene being written selected.
  await page.keyboard.press("Shift+Tab");
  await expect(view.getByRole("textbox", { name: "Scene 2 script" })).toBeFocused();
  await expect(page.getByRole("button", { name: /^Scene 3,/ })).toHaveAttribute("aria-current", "true");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(view.getByRole("textbox", { name: "Scene 3 script" })).toHaveValue("Thanks for watching. [pause 1s] ");
  await expect(view.getByRole("textbox", { name: "Scene 2 script" })).toHaveValue("This is the kitchen.");
  // Back to one scene at a time, on the scene last written in, its words kept.
  await toggle.click();
  await expect(page.getByTestId("script-view")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Scene 3 script" })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Scene 3 script" })).toHaveValue("Thanks for watching. [pause 1s] ");
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await expect(page.getByRole("textbox", { name: "Scene 1 script" })).toHaveValue("Welcome in. [pause 1s] ");
});

test("One scene per paragraph cuts a scene at its blank lines in one change Undo takes back", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill("Tour");
  const script = page.getByRole("textbox", { name: "Script", exact: true });
  await script.fill("Welcome home.\n\nThis is the kitchen.\n\nThanks for watching.");
  const perParagraph = page.getByRole("button", { name: "One scene per paragraph" });
  await perParagraph.click();
  const tab = (n: number) => page.getByRole("button", { name: new RegExp(`^Scene ${n},`) });
  await expect(tab(3)).toBeVisible();
  await expect(page.getByTestId("import-note")).toHaveText("Scene 1 is now scenes 1–3, one per paragraph.");
  await expect(page.getByRole("textbox", { name: "Scene 1 script" })).toHaveValue("Welcome home.");
  await expect(page.getByRole("textbox", { name: "Scene 1 script" })).toBeFocused();
  // One paragraph left: the button stays where it is, off, so the script box never moves.
  await expect(perParagraph).toBeDisabled();
  await expect(perParagraph).toHaveAttribute("title", /blank line/);
  await tab(3).click();
  await expect(page.getByRole("textbox", { name: "Scene 3 script" })).toHaveValue("Thanks for watching.");
  await page.getByRole("button", { name: "Undo split scene 1 into 3 scenes" }).click();
  await expect(tab(2)).toHaveCount(0);
  await expect(script).toHaveValue("Welcome home.\n\nThis is the kitchen.\n\nThanks for watching.");
  // A scene in the middle: the ones after it move along, which the note says.
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByRole("textbox", { name: "Scene 2 script" }).fill("Bye.");
  await expect(perParagraph).toBeDisabled();
  await tab(1).click();
  await perParagraph.click();
  await expect(page.getByTestId("import-note")).toHaveText("Scene 1 is now scenes 1–3, one per paragraph. Scene 2 is now scene 4.");
  await tab(4).click();
  await expect(page.getByRole("textbox", { name: "Scene 4 script" })).toHaveValue("Bye.");
});

test("Download script saves every scene's words, which Import script reads back scene for scene", async ({ page }) => {
  const download = page.getByRole("button", { name: "Download script" });
  await expect(download).toBeDisabled();
  await page.locator("input[placeholder='Video title']").fill("Open house: 12 Elm St");
  await page.getByRole("textbox", { name: "Script", exact: true }).fill("Welcome home.\n\nThis is the kitchen.");
  const addScene = page.getByRole("button", { name: "Add scene", exact: true });
  await addScene.click();
  await page.getByRole("textbox", { name: "Scene 2 script" }).fill("[pause 2s]");
  await addScene.click();
  await page.getByRole("textbox", { name: "Scene 3 script" }).fill("Thanks for watching.");
  // A scene without words is left out, which the note says.
  await addScene.click();
  const saved = page.waitForEvent("download");
  await download.click();
  const file = await saved;
  expect(file.suggestedFilename()).toBe("Open house 12 Elm St.txt");
  const text = await readFile(await file.path(), "utf8");
  expect(text).toBe("\uFEFFWelcome home.\n\nThis is the kitchen.\n\n---\n\n[pause 2s]\n\n---\n\nThanks for watching.\n");
  await expect(page.getByTestId("import-note")).toHaveText(
    "Downloading the script as Open house 12 Elm St.txt, which Import script reads back as 3 scenes (scene 4, without words, is left out). It holds the words only: presenters, voices, backgrounds, clips, and on-screen text stay in the editor.",
  );
  // The file itself, read back into the editor after asking, gives the same three scenes.
  page.once("dialog", (d) => void d.accept());
  await page.getByLabel("Import a script file").setInputFiles(await file.path());
  await expect(page.getByTestId("import-note")).toHaveText(/^Imported 3 scenes from /);
  await expect(page.getByRole("button", { name: /^Scene 4,/ })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Scene 1 script" })).toHaveValue("Welcome home.\n\nThis is the kitchen.");
  await page.getByRole("button", { name: /^Scene 2,/ }).click();
  await expect(page.getByRole("textbox", { name: "Scene 2 script" })).toHaveValue("[pause 2s]");
  await page.getByRole("button", { name: /^Scene 3,/ }).click();
  await expect(page.getByRole("textbox", { name: "Scene 3 script" })).toHaveValue("Thanks for watching.");
});

test("scene names show in the Move scene to list and in All scripts", async ({ page }) => {
  await page.reload();
  const addScene = page.getByRole("button", { name: "Add scene", exact: true });
  await page.getByRole("textbox", { name: "Script", exact: true }).fill("Hook.");
  await addScene.click();
  await page.getByRole("textbox", { name: "Scene 2 script" }).fill("Kitchen.");
  await addScene.click();
  await page.getByRole("textbox", { name: "Scene 3 script" }).fill("Garden.");
  await page.getByLabel("Scene 3 name", { exact: true }).fill("The garden");
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  const moveTo = page.getByRole("combobox", { name: "Move scene 1 to" });
  await expect(moveTo.locator("option")).toHaveText(["Place 1 of 3 (here)", "Place 2", "Place 3 (last): The garden"]);
  // By place (the option's value), not its text, which a name changes.
  await moveTo.selectOption("2");
  await expect(page.getByTestId("import-note")).toHaveText("Moved scene 1 to 3.");
  // The named scene is now second, and All scripts names it there.
  await page.getByRole("button", { name: "All scripts" }).click();
  const view = page.getByTestId("script-view");
  await expect(view.getByRole("listitem").nth(1)).toContainText("Scene 2 · The garden");
  await expect(view.getByRole("listitem").nth(0)).not.toContainText("·");
  // The box is described by its header, so its name is read with it.
  await expect(view.getByRole("textbox", { name: "Scene 2 script" })).toHaveAccessibleDescription("Scene 2 · The garden");
  await page.evaluate(() => localStorage.removeItem("avatar-studio:draft"));
});

test("Move scene to puts the selected scene at any place in one step Undo takes back", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill("Order");
  await page.getByRole("textbox", { name: "Script", exact: true }).fill("Hook.");
  const addScene = page.getByRole("button", { name: "Add scene", exact: true });
  await addScene.click();
  // With two scenes the arrows are enough; the list comes with a third.
  await expect(page.getByRole("combobox", { name: /^Move scene \d+ to$/ })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Scene 2 script" }).fill("Kitchen.");
  await addScene.click();
  await page.getByRole("textbox", { name: "Scene 3 script" }).fill("Garden.");
  await addScene.click();
  await page.getByRole("textbox", { name: "Scene 4 script" }).fill("Call us.");
  const tab = (n: number) => page.getByRole("button", { name: new RegExp(`^Scene ${n},`) });
  await tab(1).click();
  const moveTo = page.getByRole("combobox", { name: "Move scene 1 to" });
  await expect(moveTo.locator("option:checked")).toHaveText("Place 1 of 4 (here)");
  await moveTo.selectOption({ label: "Place 3" });
  await expect(page.getByTestId("import-note")).toHaveText("Moved scene 1 to 3.");
  await expect(tab(3)).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("textbox", { name: "Scene 3 script" })).toHaveValue("Hook.");
  // The list follows the scene to its new place and keeps the focus there.
  const moved = page.getByRole("combobox", { name: "Move scene 3 to" });
  await expect(moved).toBeFocused();
  await expect(moved.locator("option:checked")).toHaveText("Place 3 of 4 (here)");
  await tab(1).click();
  await expect(page.getByRole("textbox", { name: "Scene 1 script" })).toHaveValue("Kitchen.");
  await tab(2).click();
  await expect(page.getByRole("textbox", { name: "Scene 2 script" })).toHaveValue("Garden.");
  await page.getByRole("button", { name: "Undo move scene 1 to 3" }).click();
  await tab(1).click();
  await expect(page.getByRole("textbox", { name: "Scene 1 script" })).toHaveValue("Hook.");
  // With the keyboard, each arrow on the closed list moves the scene a place; while the list has the focus that is one
  // change, which one Ctrl+Z (working from the list) takes back.
  const list = page.getByRole("combobox", { name: "Move scene 1 to" });
  await list.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("import-note")).toHaveText("Moved scene 1 to 4.");
  await expect(page.getByRole("combobox", { name: "Move scene 4 to" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Undo move scene 1 to 4" })).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("import-note")).toHaveText("Undid: move scene 1 to 4.");
  await expect(page.getByRole("button", { name: "Undo add scene 4" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Redo move scene 1 to 4" })).toBeVisible();
  await tab(1).click();
  await expect(page.getByRole("textbox", { name: "Scene 1 script" })).toHaveValue("Hook.");
  // Back where it started counts as no change at all.
  await list.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("import-note")).toHaveText("Scene 1 is back where it was.");
  await expect(page.getByRole("button", { name: "Undo add scene 4" })).toBeVisible();
  // A narrow screen wraps the scene's buttons rather than scrolling the page sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator("main").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
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
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
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
  // Renamed in place; a retried start with the same key is still the same cleanup, and the name it was started with stays on the server.
  const cleanupName = `Renamed cleanup ${Date.now().toString(36)}`;
  page.once("dialog", (d) => void d.accept(cleanupName));
  await item.getByRole("button", { name: /^Rename / }).click();
  await expect(item.getByText(cleanupName, { exact: true })).toBeVisible();
  await expect(page.locator('p[role="status"]').filter({ hasText: `Renamed the cleanup to “${cleanupName}”.` })).toHaveCount(1);
  await expect(item.getByRole("button", { name: `Rename ${cleanupName}` })).toBeFocused();
  const retried = (await (await page.request.post("/api/cleanups", { data: { videoId: v.id }, headers: { "Idempotency-Key": key } })).json()).cleanup as Record<string, unknown>;
  expect([retried.id, retried.title]).toEqual([listed[0].id, cleanupName]);
  expect(Object.keys(retried)).not.toContain("askedTitle");
  expect((await page.request.patch(`/api/cleanups/${listed[0].id}`, { data: { title: " " } })).status()).toBe(400);
  expect((await page.request.patch("/api/cleanups/cu_missing123", { data: { title: "Gone" } })).status()).toBe(404);
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
  // Renamed in place; a retried start with the same key is still the same lip sync, and the name it was started with stays on the server.
  const lipsyncName = `Renamed lip sync ${Date.now().toString(36)}`;
  page.once("dialog", (d) => void d.accept(lipsyncName));
  await item.getByRole("button", { name: /^Rename / }).click();
  await expect(item.getByText(lipsyncName, { exact: true })).toBeVisible();
  await expect(page.locator('p[role="status"]').filter({ hasText: `Renamed the lip sync to “${lipsyncName}”.` })).toHaveCount(1);
  await expect(item.getByRole("button", { name: `Rename ${lipsyncName}` })).toBeFocused();
  const retried = (await (await page.request.post("/api/lipsyncs", { data: { videoId: v.id, clipId, mode: "precision" }, headers: { "Idempotency-Key": key } })).json()).lipsync as Record<string, unknown>;
  expect([retried.id, retried.title]).toEqual([listed[0].id, lipsyncName]);
  expect(Object.keys(retried)).not.toContain("askedTitle");
  expect((await page.request.patch(`/api/lipsyncs/${listed[0].id}`, { data: { title: " " } })).status()).toBe(400);
  expect((await page.request.patch("/api/lipsyncs/ls_missing123", { data: { title: "Gone" } })).status()).toBe(404);
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
  // Renamed in place; a retried start with the same key is still the same video with music, and the name it was started with stays on the server.
  const mixName = `Renamed video with music ${Date.now().toString(36)}`;
  page.once("dialog", (d) => void d.accept(mixName));
  await item.getByRole("button", { name: /^Rename / }).click();
  await expect(item.getByText(mixName, { exact: true })).toBeVisible();
  await expect(page.locator('p[role="status"]').filter({ hasText: `Renamed the video with music to “${mixName}”.` })).toHaveCount(1);
  await expect(item.getByRole("button", { name: new RegExp(`^Rename ${mixName}, `) })).toBeFocused();
  const retried = (await (await page.request.post("/api/music", { data: request.postDataJSON(), headers: { "Idempotency-Key": request.headers()["idempotency-key"] } })).json()).mix as Record<string, unknown>;
  expect([retried.id, retried.title]).toEqual([listed[0].id, mixName]);
  expect(Object.keys(retried)).not.toContain("askedTitle");
  expect((await page.request.patch(`/api/music/${listed[0].id}`, { data: { title: " " } })).status()).toBe(400);
  expect((await page.request.patch("/api/music/mm_missing123", { data: { title: "Gone" } })).status()).toBe(404);
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
  const freeBox = page.getByRole("checkbox", { name: /^Free\b/ });
  await freeBox.check();
  const boost = page.getByRole("slider", { name: "Expressiveness boost" });
  await boost.focus();
  await page.keyboard.press("ArrowLeft");
  await speakingVoice.selectOption({ label: "Nadine · English" });
  // The voice can be heard first.
  await expect(page.getByLabel("Sample of the voice Nadine")).toHaveAttribute("src", /\/demo\/revoiced\.mp3$/);
  await expect(turbo).toBeDisabled();
  await expect(turbo).not.toBeChecked();
  await expect(freeBox).toBeDisabled();
  await expect(freeBox).not.toBeChecked();
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
  await expect(freeBox).toBeChecked();
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
  // With no language chosen, HeyGen's own reading of it is shown.
  await expect(spokenCard.getByTestId("voice-change-meta")).toContainText("spoken in English");
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
  // Free is Turbo at no charge, so it waits for Turbo.
  const free = page.getByRole("checkbox", { name: /^Free\b/ });
  await expect(free).toBeDisabled();
  await page.getByRole("checkbox", { name: /^Turbo\b/ }).check();
  await expect(free).toBeEnabled();
  await expect(free).not.toBeChecked();
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
  // Renamed in place; a retried start with the same key is still the same recording, compared on the title it was started with.
  const livelyName = `Renamed recording ${Date.now().toString(36)}`;
  page.once("dialog", (d) => void d.accept(livelyName));
  await livelyCard.getByRole("button", { name: /^Rename / }).click();
  const renamedCard = page.getByTestId("voice-change").filter({ hasText: livelyName });
  await expect(page.locator('p[role="status"]').filter({ hasText: `Renamed the recording to “${livelyName}”.` })).toHaveCount(1);
  await expect(renamedCard.getByRole("button", { name: new RegExp(`^Rename ${livelyName}, `) })).toBeFocused();
  const livelyRetry = (await (await page.request.post("/api/voice-changer/speech", { data: (await lively).postDataJSON(), headers: { "Idempotency-Key": (await lively).headers()["idempotency-key"] } })).json()).change as Record<string, unknown>;
  expect([livelyRetry.title, Object.keys(livelyRetry).includes("askedTitle")]).toEqual([livelyName, false]);
  expect((await page.request.patch(`/api/voice-changer/changes/${livelyRetry.id}`, { data: { title: " " } })).status()).toBe(400);
  expect((await page.request.patch("/api/voice-changer/changes/vc_missing123", { data: { title: "Gone" } })).status()).toBe(404);
  // The recordings are searched by name, the words of a text, or the voice they are in, ignoring case; the count is read out.
  const searchBox = page.getByRole("searchbox", { name: "Search recordings" });
  const matched = page.getByTestId("list-matches");
  await searchBox.fill(livelyName.toUpperCase());
  await expect(page.getByTestId("voice-change")).toHaveCount(1);
  await expect(renamedCard).toBeVisible();
  await expect(matched).toHaveText(/^1 of \d+ recordings$/);
  await searchBox.fill(name);
  await expect(page.getByTestId("voice-change")).toHaveCount(3);
  await searchBox.fill("no such recording");
  await expect(page.getByTestId("voice-change")).toHaveCount(0);
  await expect(page.getByText("Nothing here matches “no such recording”.")).toBeVisible();
  await expect(matched).toHaveText(/^0 of \d+ recordings$/);
  await searchBox.fill("");
  await expect(matched).toHaveText("");
  await expect(renamedCard).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await renamedCard.getByRole("button", { name: /^Delete / }).click();
  await expect(renamedCard).toHaveCount(0);
  // Turbo Free is sent with Turbo and shown with the recording; Turbo off takes Free with it. The file can be an MP3.
  await free.check();
  const fileFormat = page.getByRole("combobox", { name: /^File\b/ });
  await expect(fileFormat).toHaveValue("wav");
  await expect(fileFormat).toHaveAccessibleDescription(/smaller MP3/);
  await fileFormat.selectOption("mp3");
  // The text's language can be named rather than left to HeyGen to tell.
  const textLanguage = page.getByRole("combobox", { name: /^Language\b/ });
  await expect(textLanguage).toHaveValue("");
  await expect(textLanguage).toHaveAccessibleDescription(/leave it to HeyGen/);
  await textLanguage.selectOption({ label: "Spanish" });
  await page.getByRole("textbox", { name: /^Title for the text\b/ }).fill("Free welcome");
  const freeSaid = page.waitForRequest((r) => r.url().endsWith("/api/voice-changer/speech") && r.method() === "POST");
  await speak.click();
  expect((await freeSaid).postDataJSON()).toEqual({ voiceId: expect.stringMatching(/^iv_/), text: "Welcome to the team.", title: "Free welcome", turbo: true, free: true, expressivenessBoost: 0.4, format: "mp3", language: "Spanish" });
  const freeCard = page.getByTestId("voice-change").filter({ hasText: "Free welcome" });
  await expect(freeCard.getByTestId("voice-change-meta")).toContainText("from text · Turbo Free · expressiveness boost 40% · MP3 · spoken in Spanish");
  await fileFormat.selectOption("wav");
  await textLanguage.selectOption("");
  page.once("dialog", (d) => d.accept());
  await freeCard.getByRole("button", { name: /^Delete / }).click();
  await expect(freeCard).toHaveCount(0);
  await page.getByRole("checkbox", { name: /^Turbo\b/ }).uncheck();
  await expect(free).toBeDisabled();
  await expect(free).not.toBeChecked();
  await expect(free).toHaveAccessibleDescription("Turn on Turbo to choose it.");
  // Turbo on again starts paid; Free is chosen afresh.
  await page.getByRole("checkbox", { name: /^Turbo\b/ }).check();
  await expect(free).not.toBeChecked();
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
  // Kept as an audio clip, it outlives the renderer's link: one click makes one clip, named after the recording.
  const kept = page.waitForResponse((r) => r.url().endsWith(`/api/voice-changer/changes/${spokenRow.id}/clip`) && r.request().method() === "POST");
  await spokenCard.getByRole("button", { name: /^Keep as a clip: Welcome to the team in / }).click();
  expect((await kept).status()).toBe(201);
  await expect(spokenCard.getByTestId("voice-change-kept")).toHaveText(`Kept as the clip “Welcome to the team in ${name}”`);
  await expect(spokenCard.getByTestId("voice-change-kept")).toBeFocused();
  await expect(spokenCard.getByRole("button", { name: /^Keep as a clip/ })).toHaveCount(0);
  await expect(page.getByText(`Kept Welcome to the team in ${name} as the audio clip`)).toBeVisible();
  const keptClips = ((await (await page.request.get("/api/clips")).json()) as { clips: Array<{ id: string; name: string; mimeType: string }> }).clips.filter((c) => c.name === `Welcome to the team in ${name}`);
  expect(keptClips.map((c) => c.mimeType)).toEqual(["audio/wav"]);
  expect((await page.request.get(`/api/clips/${keptClips[0].id}`)).headers()["content-type"]).toMatch(/^audio\/wav/);
  const keptAgain = await page.request.post(`/api/voice-changer/changes/${spokenRow.id}/clip`);
  expect([keptAgain.status(), ((await keptAgain.json()) as { clip: { id: string } }).clip.id]).toEqual([200, keptClips[0].id]);
  // A presenter can speak it: the editor opens with one scene lip-syncing to the clip, its words as the script.
  const makeVideo = spokenCard.getByRole("link", { name: /^Make a video: Welcome to the team in / });
  await expect(makeVideo).toHaveAttribute("href", `/create?clip=${keptClips[0].id}`);
  const editor = await page.context().newPage();
  await editor.goto(`/create?clip=${keptClips[0].id}`);
  await expect(editor.locator("input[placeholder='Video title']")).toHaveValue(`Welcome to the team in ${name}`);
  await expect(editor.getByTestId("scene-audio-name")).toHaveText(`Welcome to the team in ${name}`);
  await expect(editor.getByText("What the clip says")).toBeVisible();
  await expect(editor.locator("textarea").first()).toHaveValue("Welcome to the team.");
  // Its edits are kept in a draft of their own: a reload brings them back rather than the clip's words.
  await editor.locator("textarea").first().fill("Welcome to the team, everyone.");
  await expect.poll(() => editor.evaluate((id) => Object.entries(localStorage).some(([k, v]) => k.endsWith(`:clip:${id}`) && v.includes("everyone")), keptClips[0].id)).toBe(true);
  await editor.reload();
  await expect(editor.locator("textarea").first()).toHaveValue("Welcome to the team, everyone.");
  await expect(editor.getByTestId("scene-audio-name")).toHaveText(`Welcome to the team in ${name}`);
  // In a scene's Audio tab, the clip's words fill an empty script; words typed are kept.
  await editor.getByRole("button", { name: "Add scene", exact: true }).click();
  await editor.getByLabel("Use a saved clip").selectOption(keptClips[0].id);
  await expect(editor.locator("textarea").first()).toHaveValue("Welcome to the team.");
  await editor.getByRole("button", { name: "Add scene", exact: true }).click();
  await editor.locator("textarea").first().fill("My own words.");
  await editor.getByLabel("Use a saved clip").selectOption(keptClips[0].id);
  await expect(editor.locator("textarea").first()).toHaveValue("My own words.");
  // A clip that is gone says so and leaves the video empty.
  await editor.goto("/create?clip=clip_madeup123");
  await expect(editor.getByText("That audio clip is no longer available")).toBeVisible();
  await expect(editor.getByTestId("scene-audio-name")).toHaveCount(0);
  await editor.close();
  expect((await page.request.delete(`/api/clips/${keptClips[0].id}`)).ok()).toBe(true);
  for (const key of ["provider", "providerVoiceId", "providerAudio", "ownerId", "clipId"]) expect(Object.keys(spokenRow)).not.toContain(key);
  page.once("dialog", (d) => d.accept());
  await spokenCard.getByRole("button", { name: /^Delete / }).click();
  await expect(spokenCard).toHaveCount(0);
  // A voice is renamed here (HeyGen keeps the name it was made with), offered under its new name, and a retried start
  // with the same key is still compared on the name it was made with.
  const voiceName = `Renamed ${name}`;
  page.once("dialog", (d) => void d.accept(voiceName));
  await voiceRow.getByRole("button", { name: `Rename the voice ${name}` }).click();
  await expect(page.locator('p[role="status"]').filter({ hasText: `Renamed the voice to “${voiceName}”.` })).toHaveCount(1);
  await expect(voiceRow.getByRole("button", { name: `Rename the voice ${voiceName}` })).toBeFocused();
  await expect(page.getByRole("combobox", { name: /^Speaking voice\b/ }).locator("option", { hasText: voiceName })).toHaveCount(1);
  const retriedVoice = (await (await page.request.post("/api/voice-changer/voices", { data: request.postDataJSON(), headers: { "Idempotency-Key": request.headers()["idempotency-key"] } })).json()).voice as Record<string, unknown>;
  expect([retriedVoice.name, Object.keys(retriedVoice).includes("askedName")]).toEqual([voiceName, false]);
  expect((await page.request.patch(`/api/voice-changer/voices/${retriedVoice.id}`, { data: { name: " " } })).status()).toBe(400);
  expect((await page.request.patch("/api/voice-changer/voices/iv_missing123", { data: { name: "Gone" } })).status()).toBe(404);
  // Deleting asks first; the recording spoken already stays when its voice is deleted.
  page.once("dialog", (d) => d.accept());
  await voiceRow.getByRole("button", { name: `Delete the voice ${voiceName}` }).click();
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

test("a b-roll clip is made from a description, renamed, and loops behind a presenter as a scene's background", async ({ page }) => {
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
  // Renamed in place; a retried start with the same key is still the same clip, and the name it was started with stays on the server.
  const shotName = `Renamed shot ${tag}`;
  page.once("dialog", (d) => void d.accept(shotName));
  await item.getByRole("button", { name: /^Rename / }).click();
  await expect(item.getByText(shotName, { exact: true })).toBeVisible();
  await expect(page.locator('p[role="status"]').filter({ hasText: `Renamed the clip to “${shotName}”.` })).toHaveCount(1);
  await expect(item.getByRole("button", { name: `Rename ${shotName}` })).toBeFocused();
  const retried = (await (await page.request.post("/api/footage", { data: { prompt, durationSec: 8, aspect: "9:16", quality: "hd" }, headers: { "Idempotency-Key": key } })).json()).footage as { id: string; title: string };
  expect([retried.id, retried.title]).toEqual([id, shotName]);
  expect(Object.keys(retried)).not.toContain("askedTitle");
  expect((await page.request.patch(`/api/footage/${id}`, { data: { title: " " } })).status()).toBe(400);
  expect((await page.request.patch("/api/footage/ft_missing123", { data: { title: "Gone" } })).status()).toBe(404);
  // The clips are searched by name or description, and one renamed during a search stays in view until it changes.
  const clipSearch = page.getByRole("searchbox", { name: "Search clips" });
  await clipSearch.fill(`kitchen ${tag}`);
  await expect(page.getByTestId("footage")).toHaveCount(1);
  await expect(page.getByTestId("list-matches")).toHaveText(/^1 of \d+ clips$/);
  await clipSearch.fill(shotName.toLowerCase());
  await expect(page.getByTestId("footage")).toHaveCount(1);
  const keptName = `Kept in view ${tag}`;
  page.once("dialog", (d) => void d.accept(keptName));
  await item.getByRole("button", { name: /^Rename / }).click();
  await expect(item.getByText(keptName, { exact: true })).toBeVisible();
  await expect(item.getByRole("button", { name: `Rename ${keptName}` })).toBeFocused();
  await clipSearch.fill(shotName);
  await expect(page.getByTestId("footage")).toHaveCount(0);
  await clipSearch.fill("");
  await expect(item).toBeVisible();
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
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
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
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
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

test("library sorts by date, title, views, latest view, length, and recent comments", async ({ page }) => {
  // The older one has much the longer script, so the length sort has an order to show.
  const older = await createVideoViaApi(page, "Zulu sortcheck", { script: Array.from({ length: 12 }, (_, i) => `This is sentence number ${i + 1} of a longer tour.`).join(" ") });
  const newer = await createVideoViaApi(page, "Alpha sortcheck");
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
  // The only one viewed comes first by latest view too, and the longer one first by length (each from title order).
  await page.getByLabel("Sort videos").selectOption("title");
  await expect(titles.first()).toHaveText("Alpha sortcheck");
  await page.getByLabel("Sort videos").selectOption("viewed");
  await expect(titles.first()).toHaveText("Zulu sortcheck");
  await page.getByLabel("Sort videos").selectOption("title");
  await expect(titles.first()).toHaveText("Alpha sortcheck");
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${newer.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  const lengths = ((await (await page.request.get("/api/videos?q=sortcheck&sort=length")).json()).videos as { title: string; durationSec?: number }[]).map((v) => [v.title, v.durationSec]);
  expect(lengths[0][0]).toBe("Zulu sortcheck");
  expect(Number(lengths[0][1])).toBeGreaterThan(Number(lengths[1][1]));
  await page.reload();
  await page.getByPlaceholder(/Search title/).fill("sortcheck");
  await page.getByLabel("Sort videos").selectOption("length");
  await expect(titles.first()).toHaveText("Zulu sortcheck");
  expect((await page.request.get("/api/videos?sort=random")).status()).toBe(400);
  // Recent comments puts the video last written about first, whoever wrote, so a note on the older one lifts it.
  await page.getByLabel("Sort videos").selectOption("title");
  await expect(titles.first()).toHaveText("Alpha sortcheck");
  const trim = await page.request.post(`/api/videos/${older.id}/comments`, { data: { text: "Trim the ending." } });
  expect(trim.status()).toBe(201);
  const trimId = ((await trim.json()).comment as { id: string }).id;
  const byComments = async (expected: string[]) => {
    await page.reload();
    await page.getByPlaceholder(/Search title/).fill("sortcheck");
    await page.getByLabel("Sort videos").selectOption("commented");
    await expect(titles).toHaveText(expected);
    // The analytics download follows the order chosen, here too where it is not the newest-made order.
    const csv = await (await page.request.get("/api/videos/analytics?q=sortcheck&sort=commented")).text();
    const [first, second] = expected.map((t) => csv.indexOf(t));
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
  };
  await byComments(["Zulu sortcheck", "Alpha sortcheck"]);
  expect((await page.request.post(`/api/videos/${newer.id}/comments`, { data: { text: "Brighter intro." } })).status()).toBe(201);
  await byComments(["Alpha sortcheck", "Zulu sortcheck"]);
  // A reply counts as much as a note, so answering the older video's thread lifts it again.
  expect((await page.request.post(`/api/videos/${older.id}/comments`, { data: { text: "Trimmed.", parentId: trimId } })).status()).toBe(201);
  await byComments(["Zulu sortcheck", "Alpha sortcheck"]);
});

test("library filters by presenter, in any scene, from its picker, the address, and the video page", async ({ page }) => {
  const tag = `prescheck${Date.now().toString(36)}`;
  const bg = { type: "color", value: "#0f172a" };
  // Priya alone, Marcus with Priya in a second scene, and Marcus alone.
  const priya = await createVideoViaApi(page, `${tag} Priya`, { avatarId: "stock_5" });
  await createVideoViaApi(page, `${tag} Both`, { avatarId: "stock_2", script: undefined, scenes: [{ script: "Marcus opens.", background: bg }, { script: "Priya closes.", background: bg, avatarId: "stock_5" }] });
  const marcus = await createVideoViaApi(page, `${tag} Marcus`, { avatarId: "stock_2" });
  const titles = page.locator("a[href^='/videos/vid_'] .truncate");
  await page.goto("/videos");
  await page.getByPlaceholder(/Search title/).fill(tag);
  await expect(titles).toHaveCount(3);
  const picker = page.getByLabel("Filter by presenter");
  // Each presenter with how many videos it is in, whatever the search.
  const priyaCount = ((await (await page.request.get("/api/videos?limit=1")).json()).presenters as { id: string; name: string; count: number }[]).find((p) => p.id === "stock_5")!;
  expect(priyaCount.name).toBe("Priya Nair");
  await expect(picker.locator("option[value='stock_5']")).toHaveText(`Priya Nair (${priyaCount.count})`);
  await picker.selectOption("stock_5");
  await expect(titles).toHaveText([`${tag} Both`, `${tag} Priya`]);
  await picker.selectOption("stock_2");
  await expect(titles).toHaveText([`${tag} Marcus`, `${tag} Both`]);
  // The analytics download follows it.
  const csv = await (await page.request.get(`/api/videos/analytics?q=${tag}&presenter=stock_5`)).text();
  expect(csv).toContain(`${tag} Priya`);
  expect(csv).not.toContain(`${tag} Marcus`);
  expect((await page.request.get("/api/videos?presenter=")).status()).toBe(400);
  await picker.selectOption("all");
  await expect(titles).toHaveCount(3);
  // The video page's presenter row opens the library at that presenter.
  await page.goto(`/videos/${priya.id}`);
  await page.getByRole("link", { name: "Other videos with Priya Nair" }).click();
  await expect(page).toHaveURL(/\/videos\?presenter=stock_5$/);
  await expect(picker).toHaveValue("stock_5");
  await page.getByPlaceholder(/Search title/).fill(tag);
  await expect(titles).toHaveText([`${tag} Both`, `${tag} Priya`]);
  // A video whose scenes all have presenters of their own links to the first of them.
  const others = await createVideoViaApi(page, `${tag} Others`, { avatarId: "stock_2", script: undefined, scenes: [{ script: "Priya only.", background: bg, avatarId: "stock_5" }] });
  await page.goto(`/videos/${others.id}`);
  await expect(page.getByRole("link", { name: "Other videos with Priya Nair" })).toHaveAttribute("href", "/videos?presenter=stock_5");
  await page.goto(`/videos/${marcus.id}`);
  await expect(page.getByRole("link", { name: "Other videos with Marcus Hill" })).toHaveAttribute("href", "/videos?presenter=stock_2");
  // A presenter no video shows is still offered while chosen, so the way back is there.
  await page.goto("/videos?presenter=stock_nobody");
  await expect(picker).toHaveValue("stock_nobody");
  await expect(picker.locator("option[value='stock_nobody']")).toHaveText("This presenter (0)");
  await expect(page.getByText("No videos match")).toBeVisible();
  await expect(page.getByText(/Try a different search, status, folder, presenter/)).toBeVisible();
  await picker.selectOption("all");
  await expect(page.getByText("No videos match")).toHaveCount(0);
});

test("the avatars page says how many videos each presenter is in, links to them, and warns before a delete", async ({ page }) => {
  const tag = Date.now().toString(36);
  const bg = { type: "color", value: "#0f172a" };
  const used = (await (await page.request.post("/api/avatars", { data: { name: `Counted ${tag}`, imageUrl: "https://example.com/p.jpg" } })).json()).avatar as { id: string };
  const unused = (await (await page.request.post("/api/avatars", { data: { name: `Unused ${tag}`, imageUrl: "https://example.com/p.jpg" } })).json()).avatar as { id: string };
  const single = (await (await page.request.post("/api/avatars", { data: { name: `Single ${tag}`, imageUrl: "https://example.com/p.jpg" } })).json()).avatar as { id: string };
  await createVideoViaApi(page, `${tag} own`, { avatarId: used.id });
  // An interactive presenter names it too, which no video count shows.
  const desk = await page.request.post("/api/agents", { data: { name: `Desk ${tag}`, avatarId: used.id } });
  expect(desk.status()).toBe(201);
  await createVideoViaApi(page, `${tag} scene`, { avatarId: "stock_2", script: undefined, scenes: [{ script: "Opening.", background: bg }, { script: "Closing.", background: bg, avatarId: used.id }] });
  // Neither a trashed video nor a scene that hides the presenter counts.
  const trashed = await createVideoViaApi(page, `${tag} trashed`, { avatarId: used.id });
  expect((await page.request.delete(`/api/videos/${trashed.id}`)).status()).toBe(200);
  await createVideoViaApi(page, `${tag} hidden`, { avatarId: "stock_2", script: undefined, scenes: [{ script: "Opening.", background: bg }, { script: "Picture only.", background: { type: "image", value: "https://example.com/b.jpg" }, avatarId: used.id, hidePresenter: true }] });
  await createVideoViaApi(page, `${tag} single`, { avatarId: single.id });
  // In no video, but first by name: so "most used" and "name" order these four differently.
  expect((await page.request.post("/api/avatars", { data: { name: `Aaron ${tag}`, imageUrl: "https://example.com/p.jpg" } })).status()).toBe(201);
  await page.goto("/avatars");
  const link = page.locator(`[data-avatar-videos="${used.id}"]`);
  await expect(link).toHaveText("In 2 videos");
  await expect(link).toHaveAccessibleName(`In 2 videos: show Counted ${tag}'s videos in the library`);
  await expect(page.locator(`[data-avatar-videos="${single.id}"]`)).toHaveText("In 1 video");
  // What else uses it is named under the count, in the line itself when there is one of a kind; a presenter nothing
  // else uses has no such line.
  await expect(page.locator(`[data-avatar-others="${used.id}"]`)).toHaveText(`Used by the interactive presenter “Desk ${tag}”`);
  await expect(page.locator(`[data-avatar-others="${used.id}"] summary`)).toHaveCount(0);
  await expect(page.locator(`[data-avatar-others="${single.id}"]`)).toHaveCount(0);
  // A presenter in no video has no link.
  await expect(page.getByRole("img", { name: `Unused ${tag}` })).toBeVisible();
  // Sorted: newest first as listed, by name, or the most used first.
  const order = async () => (await page.getByTestId("avatar-library").locator("img").evaluateAll((els) => els.map((e) => (e as HTMLImageElement).alt))).filter((n) => n.endsWith(tag));
  await expect.poll(order).toEqual([`Aaron ${tag}`, `Single ${tag}`, `Unused ${tag}`, `Counted ${tag}`]);
  const sort = page.getByLabel("Sort avatars");
  // Straight from the listed order to the most used: two videos, one, then the unused newest first.
  await sort.selectOption("used");
  await expect.poll(order).toEqual([`Counted ${tag}`, `Single ${tag}`, `Aaron ${tag}`, `Unused ${tag}`]);
  await sort.selectOption("name");
  await expect.poll(order).toEqual([`Aaron ${tag}`, `Counted ${tag}`, `Single ${tag}`, `Unused ${tag}`]);
  // This browser remembers the choice.
  await page.reload();
  await expect(sort).toHaveValue("name");
  await expect.poll(order).toEqual([`Aaron ${tag}`, `Counted ${tag}`, `Single ${tag}`, `Unused ${tag}`]);
  await sort.selectOption("default");
  await expect(page.locator(`[data-avatar-videos="${unused.id}"]`)).toHaveCount(0);
  // The presenters no video needs can be listed alone, to tidy up; and the ones some video does.
  const useFilter = page.getByLabel("Use in videos");
  await useFilter.selectOption("unused");
  await expect(page.getByRole("img", { name: `Unused ${tag}` })).toBeVisible();
  await expect(page.getByRole("img", { name: `Counted ${tag}` })).toHaveCount(0);
  await useFilter.selectOption("used");
  await expect(page.getByRole("img", { name: `Counted ${tag}` })).toBeVisible();
  await expect(page.getByRole("img", { name: `Unused ${tag}` })).toHaveCount(0);
  // With the filter on and nothing matching, the page says so rather than inviting a first avatar.
  await page.getByLabel("Search avatars").fill(`${tag} matches none`);
  await expect(page.getByText("No avatars match")).toBeVisible();
  await page.getByLabel("Search avatars").fill("");
  await useFilter.selectOption("all");
  // Deleting a presenter in use says so first; dismissed, nothing is deleted.
  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    void d.dismiss();
  });
  await page.locator(`[data-avatar-controls="${used.id}"]`).getByRole("button", { name: "Delete avatar" }).click();
  // Shown in two videos, but needed by three: a retry or copy of the trashed one asks for it too (a scene that hides the
  // presenter is kept without one, so that video does not).
  await expect.poll(() => asked).toBe(`Delete avatar "Counted ${tag}"? 3 videos in your library or trash use it: rendered videos keep it, but retrying or copying one needs another presenter. It is also used by the interactive presenter “Desk ${tag}”, which would need another presenter.`);
  expect((await page.request.get(`/api/avatars/${used.id}`)).status()).toBe(200);
  // One not in a video is asked about plainly.
  page.once("dialog", (d) => {
    asked = d.message();
    void d.accept();
  });
  await page.locator(`[data-avatar-controls="${unused.id}"]`).getByRole("button", { name: "Delete avatar" }).click();
  await expect.poll(() => asked).toBe(`Delete avatar "Unused ${tag}"?`);
  await expect(page.getByRole("img", { name: `Unused ${tag}` })).toHaveCount(0);
  // The link opens the library at the presenter.
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/videos\\?presenter=${used.id}$`));
  await expect(page.getByLabel("Filter by presenter")).toHaveValue(used.id);
  await page.getByPlaceholder(/Search title/).fill(tag);
  const shown = page.locator("a[href^='/videos/vid_'] .truncate");
  await expect(shown).toHaveCount(2);
  expect((await shown.allTextContents()).sort()).toEqual([`${tag} own`, `${tag} scene`]);
  // Until the library has been counted, a delete cannot say a presenter is unused.
  await page.route("**/api/videos?limit=1", () => {
    // Never answered: the counts stay unknown.
  });
  // A remembered Most used waits for the counts: until then the page shows, and says, favourites first.
  await page.evaluate(() => window.localStorage.setItem("avatar-studio:avatars-sort", "used"));
  try {
    await page.goto("/avatars");
    await expect(page.getByLabel("Sort avatars")).toHaveValue("default");
    await expect(page.getByLabel("Sort avatars").locator('option[value="used"]')).toBeDisabled();
    page.once("dialog", (d) => {
      asked = d.message();
      void d.dismiss();
    });
    await page.locator(`[data-avatar-controls="${single.id}"]`).getByRole("button", { name: "Delete avatar" }).click();
    await expect.poll(() => asked).toBe(`Delete avatar "Single ${tag}"? It may be used by videos in your library (still counting): rendered videos keep it, but retrying or copying one needs another presenter.`);
    await expect(page.locator(`[data-avatar-videos="${single.id}"]`)).toHaveCount(0);
  } finally {
    await page.unroute("**/api/videos?limit=1");
  }
});

test("Replace switches every interactive presenter and template from one presenter to another, leaving videos as made", async ({ page }) => {
  const tag = Date.now().toString(36);
  const bg = { type: "color", value: "#0f172a" };
  const from = (await (await page.request.post("/api/avatars", { data: { name: `Old ${tag}`, imageUrl: "https://example.com/p.jpg" } })).json()).avatar as { id: string };
  const to = (await (await page.request.post("/api/avatars", { data: { name: `New ${tag}`, imageUrl: "https://example.com/p.jpg" } })).json()).avatar as { id: string };
  const agent = (await (await page.request.post("/api/agents", { data: { name: `Desk ${tag}`, avatarId: from.id } })).json()).agent as { id: string };
  const video = await createVideoViaApi(page, `${tag} swap`, { avatarId: "stock_2", script: undefined, scenes: [{ script: "Opening.", background: bg }, { script: "Closing.", background: bg, avatarId: from.id }] });
  const made = await page.request.post("/api/templates", { data: { fromVideoId: video.id, title: `Swap ${tag}` } });
  expect(made.status()).toBe(201);
  const template = (await made.json()).template as { id: string };
  // The server refuses a replace with itself, or with a presenter it cannot find.
  expect((await page.request.post("/api/usage/replace", { data: { kind: "avatar", from: from.id, to: from.id } })).status()).toBe(400);
  expect((await page.request.post("/api/usage/replace", { data: { kind: "avatar", from: from.id, to: "avatar_nowhere" } })).status()).toBe(404);
  expect((await page.request.post("/api/usage/replace", { data: { kind: "voice", from: "stock_voice_1", to: "voice_nowhere" } })).status()).toBe(400);
  await page.goto("/avatars");
  const others = page.locator(`[data-avatar-others="${from.id}"]`);
  const named = `Used by the interactive presenter “Desk ${tag}” and the template “Swap ${tag}”`;
  await expect(others).toHaveText(named);
  const opener = page.getByRole("button", { name: `Replace Old ${tag} in what uses it` });
  // Opening puts the focus on the choice; Cancel gives it back to the button, with the choice cleared.
  await opener.click();
  await expect(page.getByLabel(`Use instead of Old ${tag}`)).toBeFocused();
  await page.getByLabel(`Use instead of Old ${tag}`).selectOption(to.id);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(page.getByLabel(`Use instead of Old ${tag}`)).toHaveValue("");
  await page.getByLabel(`Use instead of Old ${tag}`).selectOption(to.id);
  // Asked first; dismissed, nothing changes.
  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    void d.dismiss();
  });
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect.poll(() => asked).toBe(`Use “New ${tag}” instead of “Old ${tag}” in the interactive presenter “Desk ${tag}” and the template “Swap ${tag}”? Videos already made are not changed.`);
  expect(((await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent as { avatarId: string }).avatarId).toBe(from.id);
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(page.locator("[data-replaced]")).toHaveText(`“New ${tag}” now stands in for “Old ${tag}” in 1 interactive presenter and 1 template. Videos already made are not changed.`);
  // The control goes with the line, so the focus moves to the note.
  await expect(page.locator("[data-replaced]")).toBeFocused();
  await expect(others).toHaveCount(0);
  await expect(page.locator(`[data-avatar-others="${to.id}"]`)).toHaveText(named);
  // The interactive presenter shows the new presenter's name; the template's scene uses it; the video is as it was made.
  const after = (await (await page.request.get(`/api/agents/${agent.id}`)).json()).agent as { avatarId: string; avatarName: string };
  expect(after).toMatchObject({ avatarId: to.id, avatarName: `New ${tag}` });
  const scenes = ((await (await page.request.get(`/api/templates/${template.id}`)).json()).template as { scenes: Array<{ avatarId?: string }> }).scenes;
  expect(scenes.map((sc) => sc.avatarId)).toEqual([undefined, to.id]);
  await expect(page.locator(`[data-avatar-videos="${from.id}"]`)).toHaveText("In 1 video");
  // A viewer gets no Replace.
  await page.route("**/api/workspaces", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { personalId: "demo-user", activeId: "ws_view", workspaces: [{ id: "ws_view", name: "Read only team", role: "viewer", members: [] }] } })
      : route.continue(),
  );
  await page.goto("/avatars");
  await expect(page.locator(`[data-avatar-others="${to.id}"]`)).toHaveText(named);
  await expect(page.getByRole("button", { name: `Replace New ${tag} in what uses it` })).toHaveCount(0);
});

test("library filters by voice, and the Voices page says how many videos each voice is in and warns before a delete", async ({ page }) => {
  const tag = Date.now().toString(36);
  const bg = { type: "color", value: "#0f172a" };
  // A space of its own, so the voice cloned here is not counted against the account's others.
  const ws = (await (await page.request.post("/api/workspaces", { data: { name: `Voices ${tag}` } })).json()).workspace as { id: string };
  expect((await page.request.post("/api/workspaces/switch", { data: { id: ws.id } })).status()).toBe(200);
  try {
    const sample = "data:audio/webm;base64," + Buffer.from("a voice to count").toString("base64");
    const own = (await (await page.request.post("/api/voices/clone", { data: { name: `Counted ${tag}`, samples: [sample] } })).json()).voice as { id: string; name: string };
    // James alone, James with the cloned voice in a second scene, and Emma alone; a trashed video in the cloned voice is
    // not in the library, but a retry of it would still ask for the voice.
    await createVideoViaApi(page, `${tag} James`, { voiceId: "stock_voice_2" });
    const trashed = await createVideoViaApi(page, `${tag} Trashed`, { voiceId: own.id });
    expect((await page.request.delete(`/api/videos/${trashed.id}`)).status()).toBe(200);
    const both = await createVideoViaApi(page, `${tag} Both`, { voiceId: "stock_voice_2", script: undefined, scenes: [{ script: "James opens.", background: bg }, { script: "The clone closes.", background: bg, voiceId: own.id }] });
    const emma = await createVideoViaApi(page, `${tag} Emma`, { voiceId: "stock_voice_1" });
    // Two templates made from the two-voice video name the cloned voice in their second scene.
    for (const title of [`Promo ${tag}`, `Recap ${tag}`]) expect((await page.request.post("/api/templates", { data: { fromVideoId: both.id, title } })).status()).toBe(201);
    const titles = page.locator("a[href^='/videos/vid_'] .truncate");
    await page.goto("/videos");
    await page.getByPlaceholder(/Search title/).fill(tag);
    await expect(titles).toHaveCount(3);
    const picker = page.getByLabel("Filter by voice");
    await expect(picker.locator(`option[value="${own.id}"]`)).toHaveText(`Counted ${tag} (1)`);
    await expect(picker.locator("option[value='stock_voice_2']")).toHaveText("James (2)");
    await picker.selectOption("stock_voice_2");
    await expect(titles).toHaveCount(2);
    expect((await titles.allTextContents()).sort()).toEqual([`${tag} Both`, `${tag} James`]);
    await picker.selectOption(own.id);
    await expect(titles).toHaveText([`${tag} Both`]);
    const csv = await (await page.request.get(`/api/videos/analytics?q=${tag}&voice=stock_voice_1`)).text();
    expect(csv).toContain(`${tag} Emma`);
    expect(csv).not.toContain(`${tag} James`);
    expect((await page.request.get("/api/videos?voice=")).status()).toBe(400);
    // The video page's voice row opens the library at that voice.
    await page.goto(`/videos/${emma.id}`);
    await page.getByRole("link", { name: "Other videos in Emma" }).click();
    await expect(page).toHaveURL(/\/videos\?voice=stock_voice_1$/);
    await expect(picker).toHaveValue("stock_voice_1");
    await page.goto(`/videos/${both.id}`);
    await expect(page.getByRole("link", { name: "Other videos in James" })).toHaveAttribute("href", "/videos?voice=stock_voice_2");
    // The Voices page counts each voice's videos and links to them.
    await page.goto("/voices");
    const link = page.locator(`[data-voice-videos="${own.id}"]`);
    await expect(link).toHaveText("In 1 video");
    await expect(link).toHaveAccessibleName(`In 1 video: show the videos in Counted ${tag} in the library`);
    await expect(page.locator('[data-voice-videos="stock_voice_2"]')).toHaveText("In 2 videos");
    // Sorted by name, or with the most used first: James is in two videos, the clone and Emma in one each.
    const voiceOrder = async () => (await page.getByTestId("voice-list").locator("[data-voice-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-voice-id")))).filter((id) => id === own.id || id === "stock_voice_1" || id === "stock_voice_2");
    const voiceSort = page.getByLabel("Sort voices");
    await voiceSort.selectOption("name");
    await expect.poll(voiceOrder).toEqual([own.id, "stock_voice_1", "stock_voice_2"]);
    await voiceSort.selectOption("used");
    await expect.poll(voiceOrder).toEqual(["stock_voice_2", own.id, "stock_voice_1"]);
    // Remembered in this browser, and applied once the counts arrive.
    await page.reload();
    await expect(voiceSort).toHaveValue("used");
    await expect.poll(voiceOrder).toEqual(["stock_voice_2", own.id, "stock_voice_1"]);
    await voiceSort.selectOption("default");
    // And what else uses each one under the count: counted, the line opens to name each template.
    const others = page.locator(`[data-voice-others="${own.id}"]`);
    await expect(others.locator("summary")).toHaveText("Used by 2 templates");
    await expect(others.getByRole("listitem").first()).toBeHidden();
    await others.locator("summary").click();
    await expect(others.getByRole("listitem").first()).toBeVisible();
    expect((await others.getByRole("listitem").allTextContents()).sort()).toEqual([`the template “Promo ${tag}”`, `the template “Recap ${tag}”`]);
    await expect(page.locator('[data-voice-others="stock_voice_1"]')).toHaveCount(0);
    // Only the voices some video needs, or only those none does.
    const useFilter = page.getByLabel("Use in videos");
    await useFilter.selectOption("used");
    await expect(page.getByRole("button", { name: `Delete Counted ${tag}` })).toBeVisible();
    await page.getByLabel("Search voices").fill("Olivia");
    await expect(page.getByText("No voices match")).toBeVisible();
    await useFilter.selectOption("unused");
    await expect(page.getByText("No voices match")).toHaveCount(0);
    await page.getByLabel("Search voices").fill("");
    await expect(page.getByRole("button", { name: `Delete Counted ${tag}` })).toHaveCount(0);
    await useFilter.selectOption("all");
    // Deleting a voice in use says so first; dismissed, nothing is deleted.
    let asked = "";
    page.once("dialog", (d) => {
      asked = d.message();
      void d.dismiss();
    });
    await page.getByRole("button", { name: `Delete Counted ${tag}` }).click();
    await expect.poll(() => asked).toBe(`Delete "Counted ${tag}"? 2 videos in your library or trash use it: videos already rendered keep their audio, but retrying or copying one needs another voice. It is also used by 2 templates, which would need another voice.`);
    expect(((await (await page.request.get("/api/voices")).json()).voices as { id: string }[]).some((v) => v.id === own.id)).toBe(true);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/videos\\?voice=${own.id}$`));
    await expect(titles).toHaveText([`${tag} Both`]);
  } finally {
    await page.request.post("/api/workspaces/switch", { data: { id: "local" } });
  }
});

test("Clear filters puts the library's search and every filter back, takes them off the address, and says so", async ({ page }) => {
  const tag = `clearcheck${Date.now().toString(36)}`;
  // Two presenters and two voices, so the library offers both pickers whatever else it holds.
  await createVideoViaApi(page, `${tag} one`, { avatarId: "stock_5", voiceId: "stock_voice_1" });
  await createVideoViaApi(page, `${tag} two`, { avatarId: "stock_2", voiceId: "stock_voice_2" });
  // Opened as a link opens it, with a batch, a presenter, a voice, and a status, plus filters chosen here.
  await page.goto("/videos?batch=batch_nothing&presenter=stock_5&voice=stock_voice_1&status=completed&ref=kept");
  const clear = page.getByTestId("clear-filters");
  await expect(clear).toBeVisible();
  await page.getByPlaceholder(/Search title/).fill(`${tag} nothing like it`);
  await page.getByTestId("starred-toggle").click();
  await page.getByLabel("Filter by date made").selectOption("7d");
  await page.getByLabel("Sort videos").selectOption("title");
  await expect(page.getByText("No videos match")).toBeVisible();
  // The empty state offers the way back too; either button does the same.
  await page.getByTestId("empty-clear-filters").click();
  // The filters leave the address at once; what is not a filter stays.
  await expect(page).toHaveURL(/\/videos\?ref=kept$/);
  await expect(page.getByPlaceholder(/Search title/)).toHaveValue("");
  await expect(page.getByPlaceholder(/Search title/)).toBeFocused();
  await expect(page.getByTestId("filter-note")).toHaveText("Filters cleared");
  await expect(page.getByTestId("starred-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByLabel("Filter by date made")).toHaveValue("all");
  await expect(page.getByLabel("Filter by presenter")).toHaveValue("all");
  await expect(page.getByLabel("Filter by voice")).toHaveValue("all");
  // The sort is not a filter, so it stays; with nothing to clear the button is gone.
  await expect(page.getByLabel("Sort videos")).toHaveValue("title");
  await expect(clear).toHaveCount(0);
  await expect(page.getByText("No videos match")).toHaveCount(0);
  // A reload does not bring the address's filters back.
  await page.reload();
  await expect(page.getByLabel("Filter by presenter")).toHaveValue("all");
  // Typing a search shows it again, and the top button clears that too, said again as it is done again.
  await page.getByPlaceholder(/Search title/).fill(tag);
  await expect(page.locator("a[href^='/videos/vid_'] .truncate")).toHaveText([`${tag} two`, `${tag} one`]);
  await page.getByLabel("Filter by presenter").selectOption("stock_5");
  await expect(page.locator("a[href^='/videos/vid_'] .truncate")).toHaveText([`${tag} one`]);
  await clear.click();
  await expect(page.getByPlaceholder(/Search title/)).toHaveValue("");
  await expect(page.getByLabel("Filter by presenter")).toHaveValue("all");
  await expect(page.getByTestId("filter-note")).toHaveText("Filters cleared");
  await expect(clear).toHaveCount(0);
  // The trash view is not a filter: clearing there keeps it.
  await page.getByTestId("trash-toggle").click();
  await page.getByPlaceholder(/Search title/).fill(`${tag} nothing in the trash`);
  await clear.click();
  await expect(page.getByTestId("trash-toggle")).toHaveAttribute("aria-pressed", "true");
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

test("review comments are resolved, folded away, and reopened, from the keyboard", async ({ page }) => {
  const v = await createVideoViaApi(page, `Resolving ${Date.now().toString(36)}`);
  const other = await createVideoViaApi(page, `Elsewhere ${Date.now().toString(36)}`);
  const ids: string[] = [];
  for (const text of ["First note.", "Second note.", "Third note."]) {
    const res = await page.request.post(`/api/videos/${v.id}/comments`, { data: { text } });
    expect(res.status()).toBe(201);
    ids.push((await res.json()).comment.id);
  }
  expect((await page.request.patch(`/api/videos/${v.id}/comments/${ids[0]}`, { data: { resolved: "yes" } })).status()).toBe(400);
  expect((await page.request.patch(`/api/videos/${other.id}/comments/${ids[0]}`, { data: { resolved: true } })).status()).toBe(404);

  await page.goto(`/videos/${v.id}`);
  const comments = page.getByTestId("comments");
  const open = page.getByTestId("comment-list");
  await expect(comments).toContainText("Comments · 3");
  await expect(comments.getByRole("button", { name: /resolved$/ })).toHaveCount(0);
  // Resolving a note folds it away and hands the focus to the next open note's Resolve.
  await comments.getByRole("button", { name: "Resolve comment: Second note." }).focus();
  await page.keyboard.press("Enter");
  await expect(open).not.toContainText("Second note.");
  await expect(comments).toContainText("Comments · 2 open, 1 resolved");
  await expect(comments.getByRole("button", { name: "Resolve comment: Third note." })).toBeFocused();
  const toggle = comments.getByRole("button", { name: "Show 1 resolved" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("resolved-comment-list")).toBeHidden();
  await expect(comments.getByRole("status")).toHaveText("Comment resolved; 2 open");
  await toggle.click();
  await expect(comments.getByRole("button", { name: "Hide 1 resolved" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("resolved-comment-list")).toBeVisible();
  await expect(page.getByTestId("resolved-comment-list")).toContainText("Second note.");
  await expect(page.getByTestId("resolved-comment-list")).toContainText("Resolved by you");
  // The last note in the list hands the focus back to the one before it, and the last open one to the toggle.
  await comments.getByRole("button", { name: "Resolve comment: Third note." }).focus();
  await page.keyboard.press("Enter");
  await expect(comments.getByRole("button", { name: "Resolve comment: First note." })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(comments).toContainText("Every comment is resolved.");
  await expect(open).toHaveCount(0);
  await expect(comments.getByRole("button", { name: "Hide 3 resolved" })).toBeFocused();
  await expect(comments).toContainText("Comments · 0 open, 3 resolved");
  // The most recently resolved note is listed first; reopening one puts it back and focuses its Resolve.
  await expect(page.getByTestId("resolved-comment-list").locator("li").first()).toContainText("First note.");
  await comments.getByRole("button", { name: "Reopen comment: Second note." }).click();
  await expect(open).toContainText("Second note.");
  await expect(comments.getByRole("button", { name: "Resolve comment: Second note." })).toBeFocused();
  await expect(comments.getByRole("status")).toHaveText("Comment reopened");
  const stored = (await (await page.request.get(`/api/videos/${v.id}/comments`)).json()).comments as Array<{ text: string; resolvedAt?: string }>;
  expect(stored.map((c) => [c.text, !!c.resolvedAt])).toEqual([["First note.", true], ["Second note.", false], ["Third note.", true]]);
  // It holds across a reload, folded again, and a resolved note can still be deleted by its author.
  await page.reload();
  await expect(comments).toContainText("Comments · 1 open, 2 resolved");
  await comments.getByRole("button", { name: "Show 2 resolved" }).click();
  await page.getByTestId("resolved-comment-list").locator("li", { hasText: "Third note." }).getByRole("button", { name: "Delete comment" }).click();
  await expect(comments).toContainText("Comments · 1 open, 1 resolved");
  await expect(page.getByTestId("resolved-comment-list")).not.toContainText("Third note.");
  // Reopening the last resolved note takes the toggle away; the next one resolved starts folded again.
  await comments.getByRole("button", { name: "Reopen comment: First note." }).click();
  await expect(comments.getByRole("button", { name: /resolved$/ })).toHaveCount(0);
  await comments.getByRole("button", { name: "Resolve comment: First note." }).click();
  await expect(comments.getByRole("button", { name: "Show 1 resolved" })).toHaveAttribute("aria-expanded", "false");
  // A note deleted elsewhere drops out when resolving it fails, rather than keeping a button that always fails.
  expect((await page.request.delete(`/api/videos/${v.id}/comments/${ids[1]}`)).status()).toBe(204);
  await comments.getByRole("button", { name: "Resolve comment: Second note." }).click();
  await expect(comments).toContainText("Comment not found");
  await expect(comments.getByRole("button", { name: "Resolve comment: Second note." })).toHaveCount(0);
  await expect(comments).toContainText("Comments · 0 open, 1 resolved");
});

test("an author edits their own comment in place, from the keyboard", async ({ page }) => {
  const v = await createVideoViaApi(page, `Editing ${Date.now().toString(36)}`);
  const res = await page.request.post(`/api/videos/${v.id}/comments`, { data: { text: "Tighten the intro." } });
  const id = (await res.json()).comment.id;
  expect((await page.request.patch(`/api/videos/${v.id}/comments/${id}`, { data: { text: "  " } })).status()).toBe(400);
  expect((await page.request.patch(`/api/videos/${v.id}/comments/${id}`, { data: { text: "x", resolved: true } })).status()).toBe(400);
  const listed = (await (await page.request.get(`/api/videos/${v.id}/comments`)).json()).comments;
  expect(listed.map((c: { mine?: boolean }) => c.mine)).toEqual([true]);

  await page.goto(`/videos/${v.id}`);
  const comments = page.getByTestId("comments");
  const edit = comments.getByRole("button", { name: "Edit comment" });
  await edit.click();
  const box = comments.getByRole("textbox", { name: "Edit comment" });
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("Tighten the intro.");
  // Escape leaves the text as it was and hands the focus back to Edit.
  await box.fill("Something else");
  await box.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(page.getByTestId("comment-list")).toContainText("Tighten the intro.");
  await expect(edit).toBeFocused();
  await expect(comments.getByTestId("comment-edited")).toHaveCount(0);
  // Saving changes the note in place, marks it edited, and returns the focus to Edit.
  await page.keyboard.press("Enter");
  await expect(box).toBeFocused();
  await box.fill("Tighten the intro and the outro.");
  await comments.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("comment-list")).toContainText("Tighten the intro and the outro.");
  await expect(comments.getByTestId("comment-edited")).toHaveText("· edited");
  await expect(edit).toBeFocused();
  await expect(comments.getByRole("status")).toHaveText("Comment saved");
  await expect(comments).toContainText("Comments · 1");
  // The edit holds across a reload, and a note can still be resolved after it.
  await page.reload();
  await expect(page.getByTestId("comment-list")).toContainText("Tighten the intro and the outro.");
  await expect(comments.getByTestId("comment-edited")).toBeVisible();
  const stored = (await (await page.request.get(`/api/videos/${v.id}/comments`)).json()).comments[0];
  expect(stored.text).toBe("Tighten the intro and the outro.");
  expect(typeof stored.editedAt).toBe("string");
});

test("the library counts each video's open comments and can show only the videos that have some", async ({ page }) => {
  const tag = Date.now().toString(36);
  const noted = await createVideoViaApi(page, `Noted ${tag}`);
  const quiet = await createVideoViaApi(page, `Quiet ${tag}`);
  const ids: string[] = [];
  for (const text of ["Fix the intro.", "Shorter outro."]) ids.push((await (await page.request.post(`/api/videos/${noted.id}/comments`, { data: { text } })).json()).comment.id);
  const resolved = (await (await page.request.post(`/api/videos/${quiet.id}/comments`, { data: { text: "Done." } })).json()).comment.id;
  expect((await page.request.patch(`/api/videos/${quiet.id}/comments/${resolved}`, { data: { resolved: true } })).status()).toBe(200);
  const api = (await (await page.request.get(`/api/videos?q=${tag}`)).json()) as { openComments: Record<string, number> };
  expect(api.openComments).toEqual({ [noted.id]: 2 });
  expect((await page.request.get("/api/videos?comments=closed")).status()).toBe(400);

  await page.goto("/videos");
  await page.getByLabel("Search videos").fill(tag);
  const notedCard = page.locator(`a[href="/videos/${noted.id}"]`);
  const quietCard = page.locator(`a[href="/videos/${quiet.id}"]`);
  await expect(quietCard).toBeVisible();
  // The badge shows the count and says it whole to a screen reader, as part of the card's link.
  const badge = notedCard.getByTestId("open-comments-badge");
  await expect(badge.locator("[aria-hidden]").last()).toHaveText("2");
  await expect(badge.getByText("2 open comments", { exact: true })).toHaveClass(/sr-only/);
  await expect(notedCard).toHaveAccessibleName(/2 open comments/);
  await expect(badge).toHaveAttribute("title", "2 open comments");
  await expect(quietCard.getByTestId("open-comments-badge")).toHaveCount(0);
  // The toggle shows only the videos with a note still open.
  const toggle = page.getByTestId("open-comments-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(quietCard).toHaveCount(0);
  await expect(notedCard).toBeVisible();
  // The list layout shows the count too.
  await page.getByRole("button", { name: "List" }).click();
  await expect(notedCard).toHaveAccessibleName(/2 open comments/);
  await page.getByRole("button", { name: "Grid" }).click();
  // Resolving the last open note takes the video out of the filtered list, which then says so.
  for (const id of ids) await page.request.patch(`/api/videos/${noted.id}/comments/${id}`, { data: { resolved: true } });
  await page.goto("/videos?comments=open");
  await expect(page.getByTestId("open-comments-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Search videos").fill(tag);
  await expect(notedCard).toHaveCount(0);
  await expect(page.getByText("Try a different search, status, folder, presenter, voice, date, share link, or turn off Open comments.")).toBeVisible();
  await page.getByTestId("open-comments-toggle").click();
  await expect(notedCard).toBeVisible();
  await expect(notedCard.getByTestId("open-comments-badge")).toHaveCount(0);
});

test("the library and Home mark the videos whose comments are new since you last opened them in this browser", async ({ page }) => {
  const tag = Date.now().toString(36);
  // Only a workspace has others writing, so only there does the library say who is reading.
  const ws = (await (await page.request.post("/api/workspaces", { data: { name: `Fresh ${tag}` } })).json()).workspace as { id: string };
  expect((await page.request.post("/api/workspaces/switch", { data: { id: ws.id } })).status()).toBe(200);
  try {
    const [v, w, x] = [await createVideoViaApi(page, `Seen ${tag}`), await createVideoViaApi(page, `Fresh ${tag}`), await createVideoViaApi(page, `Unopened ${tag}`)];
    const post = (id: string, text: string) => page.request.post(`/api/videos/${id}/comments`, { data: { text } });
    for (const id of [v.id, w.id, x.id]) expect((await post(id, "First.")).status()).toBe(201);
    // Demo mode has one person, so a teammate is played by the page's data: on these videos every note is theirs, on the
    // video page and in what the library says they last wrote.
    const ours = new Set([v.id, w.id, x.id]);
    // A request the page drops while it is answered (leaving for another page) is let go. The server's own rule, others'
    // notes in open threads only, is the unit tests'; here each video's newest note stands in for it.
    // On the browser's every tab, as a video opened in another one reads them too.
    await page.context().route(/\/api\/videos\/[^/]+\/comments$/, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      try {
        const real = await (await route.fetch()).json();
        await route.fulfill({ json: { ...real, comments: (real.comments as Array<Record<string, unknown>>).map((c) => ({ ...c, authorId: "u-teammate", mine: false })) } });
      } catch {
        // Dropped by the page.
      }
    });
    await page.route(/\/api\/videos(\?|$)/, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      try {
        const real = await (await route.fetch()).json();
        const latestComment = { ...real.latestComment };
        for (const id of ours) {
          const list = (await (await page.request.get(`/api/videos/${id}/comments`)).json()).comments as Array<{ createdAt: string }>;
          latestComment[id] = list.map((c) => c.createdAt).sort().at(-1);
        }
        await route.fulfill({ json: { ...real, latestComment, latestAnyComment: latestComment } });
      } catch {
        // Dropped by the page.
      }
    });
    const open = async (id: string) => {
      await page.goto(`/videos/${id}`);
      await expect(page.getByTestId("comments")).toHaveAttribute("data-seen-read", "true");
    };
    await open(v.id);
    await open(w.id);
    expect((await post(w.id, "Second.")).status()).toBe(201);
    await page.goto("/videos");
    await page.getByLabel("Search videos").fill(tag);
    const badge = (id: string) => page.locator(`a[href="/videos/${id}"]`).getByTestId("open-comments-badge");
    // Written in since it was opened: marked, and said whole to a screen reader.
    await expect(badge(w.id)).toHaveAttribute("data-fresh", "true");
    await expect(badge(w.id)).toHaveAttribute("title", "2 open comments; new since you last opened it");
    await expect(page.locator(`a[href="/videos/${w.id}"]`)).toHaveAccessibleName(/new since you last opened it/);
    // Opened since the last note, or never opened in this browser: not marked.
    await expect(badge(v.id)).not.toHaveAttribute("data-fresh", /.*/);
    await expect(badge(x.id)).not.toHaveAttribute("data-fresh", /.*/);
    // Opening it clears the mark; a note written on another video after it was opened marks that one.
    await open(w.id);
    expect((await post(v.id, "Second.")).status()).toBe(201);
    await page.goto("/videos");
    await page.getByLabel("Search videos").fill(tag);
    await expect(badge(v.id)).toHaveAttribute("data-fresh", "true");
    await expect(badge(w.id)).not.toHaveAttribute("data-fresh", /.*/);
    // The list layout marks it too.
    await page.getByRole("button", { name: "List" }).click();
    await expect(page.getByTestId("video-row").filter({ hasText: `Seen ${tag}` }).getByTestId("open-comments-badge")).toHaveAttribute("data-fresh", "true");
    // Home names it among the things to check, linking to it; the videos opened since, or never opened here, are not named.
    await page.goto("/home");
    const notice = page.getByTestId("fresh-comments-notice");
    // Each title says, to a screen reader reading the links on their own, why it is there.
    await expect(notice).toHaveText(`New comments since you last looked, on Seen ${tag} (new comments).Mark as read`);
    await notice.getByRole("link", { name: `Seen ${tag} (new comments)` }).click();
    await expect(page).toHaveURL(new RegExp(`/videos/${v.id}$`));
    await expect(page.getByTestId("comments")).toHaveAttribute("data-seen-read", "true");
    // Opened, it is not new any more: back on Home once its videos are in (their open comments say so), it is not named.
    await page.goBack();
    await expect(page.getByTestId("open-comments-notice")).toBeVisible();
    await expect(notice).toHaveCount(0);
    // Written in again: opened in another tab, Home here drops it when it comes back to the front.
    expect((await post(v.id, "Third.")).status()).toBe(201);
    expect((await post(w.id, "Second, again.")).status()).toBe(201);
    await page.reload();
    await expect(notice).toHaveText(`New comments since you last looked, on Fresh ${tag} (new comments) and Seen ${tag} (new comments).Mark as read`);
    const other = await page.context().newPage();
    await other.goto(`/videos/${v.id}`);
    await expect(other.getByTestId("comments")).toHaveAttribute("data-seen-read", "true");
    await other.close();
    await page.bringToFront();
    // The other tab's mark reaches this one as a storage event; coming back to the front reads the marks again too.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(notice).toHaveText(`New comments since you last looked, on Fresh ${tag} (new comments).Mark as read`);
    // Mark as read clears the rest at once, says so, and hands the keyboard on to the first quick action.
    await notice.getByRole("button", { name: "Mark the new comments on these videos as read" }).click();
    await expect(notice).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^Avatar video/ })).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Marked 1 video's comments as read." })).toHaveCount(1);
    await page.reload();
    await expect(page.getByTestId("open-comments-notice")).toBeVisible();
    await expect(notice).toHaveCount(0);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.context().unrouteAll({ behavior: "ignoreErrors" });
    // The active space is the account's, so the next test starts in the personal one again.
    await page.request.post("/api/workspaces/switch", { data: { id: "local" } });
  }
});

test("a review comment is answered in a thread that is downloaded, resolved, and deleted with it", async ({ page }) => {
  const v = await createVideoViaApi(page, `Thread ${Date.now().toString(36)}`);
  const note = (await (await page.request.post(`/api/videos/${v.id}/comments`, { data: { text: "Tighten the intro." } })).json()).comment;
  await page.goto(`/videos/${v.id}`);
  const comments = page.getByTestId("comments");
  const replyButton = comments.getByRole("button", { name: "Reply to comment: Tighten the intro." });
  // Escape leaves without a reply and hands the focus back to Reply.
  await replyButton.click();
  const box = comments.getByRole("textbox", { name: "Reply to: Tighten the intro." });
  await expect(box).toBeFocused();
  await box.fill("Not this.");
  await box.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(replyButton).toBeFocused();
  // A reply posted sits under the note; the thread still counts once.
  await page.keyboard.press("Enter");
  // Ctrl+Enter posts it as Post reply does; with Shift as well it does not.
  await box.fill("On it, shorter cut tomorrow.");
  await box.press("Control+Shift+Enter");
  await page.waitForTimeout(300);
  await expect(box).toBeVisible();
  await expect(comments.getByTestId("comment-reply")).toHaveCount(0);
  expect((await (await page.request.get(`/api/videos/${v.id}/comments`)).json()).comments).toHaveLength(1);
  await box.fill("On it, shorter cut tomorrow.");
  await box.press("Control+Enter");
  const thread = comments.getByRole("list", { name: "Replies to: Tighten the intro." });
  await expect(thread.getByTestId("comment-reply")).toHaveCount(1);
  await expect(thread).toContainText("On it, shorter cut tomorrow.");
  await expect(replyButton).toBeFocused();
  await expect(comments.getByRole("status")).toHaveText("Reply posted");
  await expect(comments).toContainText("Comments · 1");
  // The thread downloads as a spreadsheet: the note, then its reply, under one thread number.
  const [download] = await Promise.all([page.waitForEvent("download"), comments.getByRole("link", { name: "Download comments as CSV" }).click()]);
  expect(download.suggestedFilename()).toBe(`comments-${v.id}.csv`);
  const sheet = parseCsv(await readFile((await download.path())!, "utf8"));
  expect(sheet.columns).toEqual(["thread", "kind", "at", "author", "written", "edited", "status", "resolved_at", "resolved_by", "text"]);
  expect(sheet.rows.map((r) => [r.thread, r.kind, r.status, r.text])).toEqual([
    ["1", "note", "open", "Tighten the intro."],
    ["1", "reply", "open", "On it, shorter cut tomorrow."],
  ]);
  const replyId = (await (await page.request.get(`/api/videos/${v.id}/comments`)).json()).comments.find((c: { parentId?: string }) => c.parentId === note.id).id;
  // One level only, and a reply is resolved with its thread, not on its own.
  expect((await page.request.post(`/api/videos/${v.id}/comments`, { data: { text: "Deeper", parentId: replyId } })).status()).toBe(400);
  expect((await page.request.patch(`/api/videos/${v.id}/comments/${replyId}`, { data: { resolved: true } })).status()).toBe(400);
  expect((await page.request.delete(`/api/videos/${v.id}/comments/${note.id}?replies=all`)).status()).toBe(400);
  // A reply can be edited by its author like any note.
  await thread.getByRole("button", { name: "Edit comment: On it, shorter cut tomorrow." }).click();
  await comments.getByRole("textbox", { name: "Edit comment" }).fill("On it, cut tomorrow.");
  await comments.getByRole("textbox", { name: "Edit comment" }).press("Control+Enter");
  await expect(thread).toContainText("On it, cut tomorrow.");
  await expect(comments.getByRole("textbox", { name: "Edit comment" })).toHaveCount(0);
  // The keyboard shortcuts list the comment box's keys.
  await page.keyboard.press("Control+/");
  const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(shortcuts.getByRole("heading", { name: "In a video's comments" })).toBeVisible();
  await expect(shortcuts).toContainText("Post a comment or reply, or save an edit");
  await page.keyboard.press("Escape");
  await expect(shortcuts).toBeHidden();
  // Resolving the note folds the whole thread away, with no Reply there.
  await comments.getByRole("button", { name: "Resolve comment: Tighten the intro." }).click();
  expect((await page.request.post(`/api/videos/${v.id}/comments`, { data: { text: "Still not fixed", parentId: note.id } })).status()).toBe(409);
  await comments.getByRole("button", { name: "Show 1 resolved" }).click();
  const resolvedList = page.getByTestId("resolved-comment-list");
  await expect(resolvedList.getByTestId("comment-reply")).toHaveText(/On it, cut tomorrow\./);
  await expect(resolvedList.getByRole("button", { name: /^Reply to comment/ })).toHaveCount(0);
  await comments.getByRole("button", { name: "Reopen comment: Tighten the intro." }).click();
  // Deleting the note asks first, as its reply goes with it.
  const asked: string[] = [];
  page.once("dialog", (d) => {
    asked.push(d.message());
    void d.dismiss();
  });
  await comments.getByRole("button", { name: "Delete comment: Tighten the intro." }).click();
  await expect.poll(() => asked).toEqual(["Delete this comment and its reply? This cannot be undone."]);
  await expect(thread.getByTestId("comment-reply")).toHaveCount(1);
  // A reply posted elsewhere since is not deleted unseen: the server refuses, and the list shows it.
  expect((await page.request.post(`/api/videos/${v.id}/comments`, { data: { text: "Late reply", parentId: note.id } })).status()).toBe(201);
  page.once("dialog", (d) => void d.accept());
  await comments.getByRole("button", { name: "Delete comment: Tighten the intro." }).click();
  await expect(comments).toContainText("a new reply since you looked");
  await expect(thread.getByTestId("comment-reply")).toHaveCount(2);
  page.once("dialog", (d) => {
    asked.push(d.message());
    void d.accept();
  });
  await comments.getByRole("button", { name: "Delete comment: Tighten the intro." }).click();
  await expect.poll(() => asked.at(-1)).toBe("Delete this comment and its 2 replies? This cannot be undone.");
  await expect(page.getByTestId("comment-list")).toHaveCount(0);
  await expect(comments.getByRole("status")).toHaveText("Comment and its 2 replies deleted");
  expect((await (await page.request.get(`/api/videos/${v.id}/comments`)).json()).comments).toEqual([]);
});

test("a comment email's link, or one copied from the thread, opens the video at its thread, marked for a moment, and says when it is gone", async ({ page }) => {
  const v = await createVideoViaApi(page, `Linked ${Date.now().toString(36)}`);
  const post = async (data: { text: string; parentId?: string }) => (await (await page.request.post(`/api/videos/${v.id}/comments`, { data })).json()).comment as { id: string };
  const notes: Array<{ id: string }> = [];
  for (let i = 1; i <= 6; i += 1) notes.push(await post({ text: `Note ${i}` }));
  const reply = await post({ text: "Answer to note 2", parentId: notes[1].id });
  expect((await page.request.patch(`/api/videos/${v.id}/comments/${notes[0].id}`, { data: { resolved: true } })).status()).toBe(200);
  // A reply email links to the thread; a link to the reply itself finds it too.
  await page.goto(`/videos/${v.id}?comment=${reply.id}`);
  const comments = page.getByTestId("comments");
  const linked = comments.locator("[data-linked]");
  await expect(linked).toHaveAttribute("data-comment-id", notes[1].id);
  await expect(linked).toContainText("Answer to note 2");
  await expect(linked).toBeFocused();
  await expect(linked).toBeInViewport();
  // The address loses the parameter so a reload does not jump again, and the mark fades.
  await expect(page).not.toHaveURL(/comment=/);
  await expect(linked).toHaveCount(0, { timeout: 10_000 });
  // The focus stays on the thread after its mark fades, so Tab goes on to the thread's own buttons.
  await expect(comments.locator(`[data-comment-id="${notes[1].id}"]`)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(comments.getByRole("button", { name: "Resolve comment: Note 2" })).toBeFocused();
  // Copy link puts the same kind of link on the clipboard, for a teammate, and says so.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const copy = comments.getByRole("button", { name: "Copy link to comment: Note 4" });
  await copy.click();
  await expect(comments.getByRole("status")).toHaveText("Link to the comment copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // A personal space's thread names no space: it opens in the one the reader is in.
  expect(copied).toMatch(new RegExp(`/videos/${v.id}\\?comment=${notes[3].id}$`));
  await expect(comments.getByRole("button", { name: "Copy link to comment: Answer to note 2" })).toHaveCount(0);
  await page.goto(copied);
  await expect(comments.locator("[data-linked]")).toHaveAttribute("data-comment-id", notes[3].id);
  // A resolved thread is unfolded to be shown.
  await page.goto(`/videos/${v.id}?comment=${notes[0].id}`);
  await expect(comments.getByTestId("resolved-comment-list")).toBeVisible();
  await expect(comments.locator("[data-linked]")).toHaveAttribute("data-comment-id", notes[0].id);
  // A thread deleted since the email was sent is said to be gone.
  await page.goto(`/videos/${v.id}?comment=cmt_gone`);
  await expect(comments.getByTestId("comment-link-gone")).toHaveText("The comment this link points to is no longer here; it may have been deleted.");
  await expect(comments.getByRole("status")).toHaveText("The comment this link points to is no longer here; it may have been deleted.");
  await expect(comments.locator("[data-linked]")).toHaveCount(0);
  await expect(comments.getByTestId("comment-list")).toContainText("Note 6");
});

test("a thread's copied link in a workspace switches a member who is elsewhere into it", async ({ page }) => {
  const tag = Date.now().toString(36);
  const ws = (await (await page.request.post("/api/workspaces", { data: { name: `Threads ${tag}` } })).json()).workspace as { id: string };
  try {
    expect((await page.request.post("/api/workspaces/switch", { data: { id: ws.id } })).status()).toBe(200);
    const v = await createVideoViaApi(page, `Team thread ${tag}`);
    const note = (await (await page.request.post(`/api/videos/${v.id}/comments`, { data: { text: "Check the logo size." } })).json()).comment as { id: string };
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`/videos/${v.id}`);
    await page.getByTestId("comments").getByRole("button", { name: "Copy link to comment: Check the logo size." }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(new RegExp(`/videos/${v.id}\\?ws=${ws.id}&comment=${note.id}$`));
    // Read from the personal space, the link switches into the workspace and opens at the thread.
    await page.request.post("/api/workspaces/switch", { data: { id: "local" } });
    await page.goto(copied);
    await expect(page.getByRole("heading", { name: `Team thread ${tag}` })).toBeVisible();
    await expect(page.getByLabel("Workspace")).toHaveValue(ws.id);
    await expect(page.getByTestId("comments").locator("[data-linked]")).toHaveAttribute("data-comment-id", note.id);
    await expect(page).not.toHaveURL(/[?&](ws|comment)=/);
  } finally {
    await page.request.post("/api/workspaces/switch", { data: { id: "local" } });
    await page.request.delete(`/api/workspaces/${ws.id}`);
  }
});

test("a review comment takes reactions from the picker, shown as pills that take yours back", async ({ page }) => {
  const v = await createVideoViaApi(page, `React ${Date.now().toString(36)}`);
  const note = (await (await page.request.post(`/api/videos/${v.id}/comments`, { data: { text: "Love the new intro." } })).json()).comment;
  await page.request.post(`/api/videos/${v.id}/comments`, { data: { text: "Agreed.", parentId: note.id } });
  await page.goto(`/videos/${v.id}`);
  const comments = page.getByTestId("comments");
  const opener = comments.getByRole("button", { name: "React to comment: Love the new intro." });
  // The picker opens on its first reaction; Escape closes it, back on the button.
  await opener.click();
  await expect(opener).toHaveAttribute("aria-expanded", "true");
  const picker = comments.getByRole("group", { name: "Reactions for: Love the new intro." });
  await expect(picker.getByRole("button", { name: "Thumbs up" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(opener).toBeFocused();
  // Picking one closes it and shows the reaction as a pill of the reader's own.
  await page.keyboard.press("Enter");
  await picker.getByRole("button", { name: "Thumbs up" }).click();
  await expect(picker).toHaveCount(0);
  const thread = comments.locator(`[data-comment-id="${note.id}"]`);
  const pills = thread.getByTestId("comment-reactions").first();
  const thumbs = pills.getByRole("button", { name: /^Thumbs up, 1, from you/ });
  await expect(thumbs).toHaveAttribute("aria-pressed", "true");
  await expect(thumbs).toHaveText("👍 1");
  await expect(opener).toBeFocused();
  await expect(comments.getByRole("status")).toHaveText("Reacted with Thumbs up");
  await opener.click();
  await picker.getByRole("button", { name: "Done" }).click();
  await expect(pills.getByRole("button")).toHaveText(["👍 1", "✅ 1"]);
  // A reply takes its own reactions.
  await comments.getByRole("button", { name: "React to comment: Agreed." }).click();
  await comments.getByRole("group", { name: "Reactions for: Agreed." }).getByRole("button", { name: "Celebrate" }).click();
  await expect(comments.getByTestId("comment-reply").getByTestId("comment-reactions")).toHaveText("🎉 1");
  const stored = (await (await page.request.get(`/api/videos/${v.id}/comments`)).json()).comments;
  // Stores may keep the emoji in any order; the page's order is the list's.
  expect(Object.keys(stored.find((c: { id: string }) => c.id === note.id).reactions).sort()).toEqual(["👍", "✅"].sort());
  // Pressing a pill of your own takes it back; the last one gone, the focus is on the note's React button.
  await thumbs.click();
  await expect(pills.getByRole("button")).toHaveText(["✅ 1"]);
  await expect(comments.getByRole("status")).toHaveText("Thumbs up taken back");
  await pills.getByRole("button", { name: /^Done, 1, from you/ }).click();
  await expect(thread.getByTestId("comment-reactions")).toHaveCount(1);
  await expect(opener).toBeFocused();
  // Only the listed reactions are taken.
  expect((await page.request.patch(`/api/videos/${v.id}/comments/${note.id}`, { data: { reaction: "🤡", on: true } })).status()).toBe(400);
});

test("every open comment on a video is resolved in one step, after asking", async ({ page }) => {
  const v = await createVideoViaApi(page, `Resolve all ${Date.now().toString(36)}`);
  const post = async (text: string, parentId?: string) => (await (await page.request.post(`/api/videos/${v.id}/comments`, { data: { text, parentId } })).json()).comment;
  const first = await post("Tighten the intro.");
  await post("On it.", first.id);
  await page.goto(`/videos/${v.id}`);
  const comments = page.getByTestId("comments");
  const resolveAll = comments.getByRole("button", { name: "Resolve all" });
  // One open note is resolved on its own.
  await expect(comments).toContainText("Comments · 1");
  await expect(resolveAll).toHaveCount(0);
  await post("Brighter end card.");
  await post("Fix the typo in the title.");
  await page.reload();
  await expect(comments).toContainText("Comments · 3");
  // Saying no leaves them open.
  const asked: string[] = [];
  page.once("dialog", (d) => {
    asked.push(d.message());
    void d.dismiss();
  });
  await resolveAll.click();
  await expect.poll(() => asked).toEqual(["Resolve all 3 open comments? Each can be reopened."]);
  await expect(comments.getByTestId("comment-list").locator("> li")).toHaveCount(3);
  // A note a teammate posts while the question is open was never seen, so it stays open.
  page.once("dialog", async (d) => {
    await post("A late note.");
    await d.accept();
  });
  await resolveAll.click();
  await expect(comments.getByRole("status")).toHaveText("3 comments resolved; 1 open");
  await expect(comments.getByTestId("comment-list")).toContainText("A late note.");
  await expect(comments.getByTestId("comment-list").locator("> li")).toHaveCount(1);
  await expect(comments.getByRole("button", { name: "Show 3 resolved" })).toBeFocused();
  await expect(resolveAll).toHaveCount(0);
  const stored = (await (await page.request.get(`/api/videos/${v.id}/comments`)).json()).comments as Array<{ id: string; text: string; parentId?: string; resolvedAt?: string }>;
  expect(stored.filter((c) => !c.parentId && c.text !== "A late note.").every((c) => c.resolvedAt)).toBe(true);
  expect(stored.find((c) => c.parentId)?.resolvedAt).toBeUndefined();
  // Threads no longer open are left as they are; naming none is a 400.
  expect(await (await page.request.post(`/api/videos/${v.id}/comments/resolve-all`, { data: { ids: [first.id] } })).json()).toEqual({ resolved: 0, failed: 0, open: 1 });
  expect((await page.request.post(`/api/videos/${v.id}/comments/resolve-all`, { data: { ids: [] } })).status()).toBe(400);
  expect((await page.request.post("/api/videos/vid_nope/comments/resolve-all", { data: { ids: [first.id] } })).status()).toBe(404);
});

test("a video's open comments list by their moment in the video, an order the browser remembers", async ({ page }) => {
  const v = await createVideoViaApi(page, `Order ${Date.now().toString(36)}`);
  // Notes are pinned to a moment once the render has finished.
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  const post = async (text: string, atSec?: number) => expect((await page.request.post(`/api/videos/${v.id}/comments`, { data: { text, atSec } })).status()).toBe(201);
  await post("About the whole video.");
  await page.goto(`/videos/${v.id}`);
  const comments = page.getByTestId("comments");
  const order = comments.getByRole("combobox", { name: "Order" });
  // With no note pinned to a moment there is nothing to order by.
  await expect(comments.getByTestId("comment-list")).toContainText("About the whole video.");
  await expect(order).toHaveCount(0);
  await post("Cut the pause here.", 8);
  await post("Brighter title card.", 2);
  await page.reload();
  const rows = comments.getByTestId("comment-list").locator("> li");
  await expect(order).toHaveValue("written");
  await expect(rows).toHaveText([/About the whole video\./, /Cut the pause here\./, /Brighter title card\./]);
  await order.selectOption("moment");
  await expect(rows).toHaveText([/0:02\s*Brighter title card\./, /0:08\s*Cut the pause here\./, /About the whole video\./]);
  // Resolving a note hands the focus to the next one shown, in this order.
  await comments.getByRole("button", { name: "Resolve comment: Brighter title card." }).click();
  await expect(comments.getByRole("button", { name: "Resolve comment: Cut the pause here." })).toBeFocused();
  await comments.getByRole("button", { name: "Show 1 resolved" }).click();
  await comments.getByRole("button", { name: "Reopen comment: Brighter title card." }).click();
  await expect(rows.first()).toContainText("Brighter title card.");
  // The browser keeps the choice for the next video page it opens.
  const w = await createVideoViaApi(page, `Order too ${Date.now().toString(36)}`);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${w.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  for (const [text, atSec] of [["Late moment.", 6], ["Early moment.", 1]] as const) {
    expect((await page.request.post(`/api/videos/${w.id}/comments`, { data: { text, atSec } })).status()).toBe(201);
  }
  await page.goto(`/videos/${w.id}`);
  await expect(order).toHaveValue("moment");
  await expect(rows).toHaveText([/Early moment\./, /Late moment\./]);
  await order.selectOption("written");
  await page.goto(`/videos/${v.id}`);
  await expect(order).toHaveValue("written");
  await expect(rows.first()).toContainText("About the whole video.");
});

test("a video's pinned comments are marked along the video, and a mark moves the player there", async ({ page }) => {
  const v = await createVideoViaApi(page, `Marks ${Date.now().toString(36)}`);
  // Notes are pinned to a moment once the render has finished.
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  const post = async (text: string, atSec?: number) => expect((await page.request.post(`/api/videos/${v.id}/comments`, { data: { text, atSec } })).status()).toBe(201);
  await post("About the whole video.");
  await page.goto(`/videos/${v.id}`);
  const comments = page.getByTestId("comments");
  const player = page.getByTestId("video-player");
  // A note on the whole video has no moment to mark, even once the player knows the video's length.
  await expect(comments.getByTestId("comment-list")).toContainText("About the whole video.");
  await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.duration)).toBeGreaterThan(8);
  await expect(comments.getByTestId("comment-markers")).toHaveCount(0);
  await post("Cut the pause here.", 8);
  await post("Brighter title card.", 2);
  await post("Louder music.", 2);
  await page.reload();
  const marks = comments.getByRole("group", { name: "Comments along the video" }).getByRole("button");
  await expect(marks).toHaveCount(2);
  // Earliest first; the notes at one moment share its mark, which names the first of them.
  await expect(marks.nth(0)).toHaveAccessibleName("0:02: 2 comments");
  await expect(marks.nth(0)).toHaveAttribute("title", "Brighter title card. · Louder music.");
  await expect(marks.nth(1)).toHaveAccessibleName("0:08: 1 comment");
  await expect(marks.nth(1)).toHaveAttribute("title", "Cut the pause here.");
  // In order, and far enough apart to press, at a phone's width too.
  const apart = async () => {
    const [a, b] = await Promise.all([marks.nth(0).boundingBox(), marks.nth(1).boundingBox()]);
    expect(a!.width).toBeGreaterThanOrEqual(24);
    expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x);
  };
  await apart();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(marks).toHaveCount(2);
  await apart();
  await page.setViewportSize({ width: 1280, height: 720 });
  // A mark moves the player to its moment, from the mouse or the keyboard.
  await marks.nth(1).click();
  await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.currentTime)).toBe(8);
  await expect(player).toBeFocused();
  // The strip is one tab stop, the mark last used, the arrow keys moving along it.
  await expect(marks.nth(1)).toHaveAttribute("tabindex", "0");
  await expect(marks.nth(0)).toHaveAttribute("tabindex", "-1");
  await marks.nth(1).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(marks.nth(0)).toBeFocused();
  await page.keyboard.press("End");
  await expect(marks.nth(1)).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.currentTime)).toBe(2);
  // Resolving the notes at a moment takes its mark away, and the last mark takes the strip with it.
  await comments.getByRole("button", { name: "Resolve comment: Cut the pause here." }).click();
  await expect(marks).toHaveCount(1);
  await comments.getByRole("button", { name: "Resolve comment: Brighter title card." }).click();
  await expect(marks.nth(0)).toHaveAccessibleName("0:02: 1 comment");
  await comments.getByRole("button", { name: "Resolve comment: Louder music." }).click();
  await expect(comments.getByTestId("comment-markers")).toHaveCount(0);
  await expect(comments.getByTestId("comment-list")).toContainText("About the whole video.");
});

test("C on a video page starts a comment pinned to the moment the player is at, pausing it there", async ({ page }) => {
  const v = await createVideoViaApi(page, `Press C ${Date.now().toString(36)}`);
  // Notes are pinned to a moment once the render has finished.
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  await page.goto(`/videos/${v.id}`);
  const player = page.getByTestId("video-player");
  const comments = page.getByTestId("comments");
  const box = page.getByLabel("New comment");
  await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.duration)).toBeGreaterThan(5);
  // Playing, from the player itself.
  await player.evaluate(async (el: HTMLVideoElement) => {
    el.muted = true;
    el.currentTime = 4;
    await el.play();
  });
  await player.focus();
  await page.keyboard.press("c");
  await expect(box).toBeFocused();
  await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
  const at = Math.floor(await player.evaluate((el: HTMLVideoElement) => el.currentTime));
  const moment = `0:${String(at).padStart(2, "0")}`;
  const pin = comments.getByRole("checkbox", { name: `Pin to ${moment} in the video` });
  await expect(pin).toBeChecked();
  // A screen reader is told the player paused, and where the note will be pinned.
  await expect(comments.getByRole("status")).toHaveText(`Paused at ${moment}; the note will be pinned there`);
  // In the box, C is a letter like any other.
  await page.keyboard.type("Cut cold open.");
  await expect(box).toHaveValue("Cut cold open.");
  await box.press("Control+Enter");
  await expect(comments.getByTestId("comment-list")).toContainText(`${moment}Cut cold open.`);
  const listed = (await (await page.request.get(`/api/videos/${v.id}/comments`)).json()).comments as Array<{ atSec?: number }>;
  expect(listed.map((c) => c.atSec)).toEqual([at]);
  // With single-key shortcuts turned off, C does nothing.
  await page.evaluate(() => localStorage.setItem("avatar-studio:single-key-shortcuts", "off"));
  await page.reload();
  await expect(comments.getByTestId("comment-list")).toContainText("Cut cold open.");
  await player.focus();
  await page.keyboard.press("c");
  await expect(player).toBeFocused();
  await expect(box).not.toBeFocused();
  // On again: from inside an open reply form, C is left to it, and the reply stays where it was.
  await page.evaluate(() => localStorage.removeItem("avatar-studio:single-key-shortcuts"));
  await page.reload();
  await comments.getByRole("button", { name: "Reply to comment: Cut cold open." }).click();
  const cancel = comments.getByRole("button", { name: "Cancel" });
  await cancel.focus();
  await page.keyboard.press("c");
  await expect(cancel).toBeFocused();
  await expect(box).not.toBeFocused();
  await cancel.click();
  // Caps Lock gives a capital C with no Shift, which still counts.
  await player.focus();
  await page.evaluate(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "C", code: "KeyC", bubbles: true, cancelable: true })));
  await expect(box).toBeFocused();
});

test("comments a teammate wrote since this browser last opened the video are marked new, for that visit", async ({ page }) => {
  const v = await createVideoViaApi(page, `New ${Date.now().toString(36)}`);
  const post = async (text: string, parentId?: string) => {
    const res = await page.request.post(`/api/videos/${v.id}/comments`, { data: { text, parentId } });
    expect(res.status()).toBe(201);
    return (await res.json()).comment as { id: string };
  };
  const first = await post("Logo is too small.");
  // Demo mode has one person, so a teammate is played by the page's data: every note but "Mine." is theirs.
  await page.route(/\/api\/videos\/[^/]+\/comments$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const real = await (await route.fetch()).json();
    const comments = (real.comments as Array<{ text: string; mine: boolean }>).map((c) => (c.text === "Mine." ? c : { ...c, authorId: "u-teammate", mine: false }));
    await route.fulfill({ json: { ...real, comments } });
  });
  const comments = page.getByTestId("comments");
  const rows = comments.getByTestId("comment-list").locator("> li");
  // A first visit has nothing to compare with, so nothing is new (once the page has read what this browser kept).
  await page.goto(`/videos/${v.id}`);
  await expect(comments).toHaveAttribute("data-seen-read", "true");
  await expect(rows).toHaveText([/Logo is too small\./]);
  await expect(comments.getByTestId("comment-new")).toHaveCount(0);
  await expect(comments.getByTestId("comments-new")).toHaveCount(0);
  // Written while away: a note, a reply under the first one, and one of the reader's own.
  await post("Music is loud.");
  await post("Agreed, bigger.", first.id);
  await post("Mine.");
  await page.reload();
  await expect(comments).toHaveAttribute("data-seen-read", "true");
  await expect(comments.getByTestId("comments-new")).toHaveText("2 new since you last opened this video");
  await expect(rows.filter({ hasText: "Music is loud." }).getByTestId("comment-new")).toHaveText("New");
  await expect(comments.getByTestId("comment-reply").filter({ hasText: "Agreed, bigger." }).getByTestId("comment-new")).toBeVisible();
  await expect(rows.filter({ hasText: "Mine." }).getByTestId("comment-new")).toHaveCount(0);
  await expect(comments.getByTestId("comment-new")).toHaveCount(2);
  // A resolved thread's news is not counted as open.
  await comments.getByRole("button", { name: "Resolve comment: Music is loud." }).click();
  await expect(comments.getByTestId("comments-new")).toHaveText("1 new since you last opened this video");
  // The next visit starts from what was shown.
  await page.reload();
  await expect(comments).toHaveAttribute("data-seen-read", "true");
  await expect(rows.first()).toContainText("Logo is too small.");
  await expect(comments.getByTestId("comment-new")).toHaveCount(0);
  await expect(comments.getByTestId("comments-new")).toHaveCount(0);
  // A video seen with no comments yet: the first one written after is new, whatever the browser's clock says.
  // The browser's clock runs an hour ahead here, as a badly set computer's might.
  const w = await createVideoViaApi(page, `New too ${Date.now().toString(36)}`);
  await page.clock.install({ time: new Date(Date.now() + 3_600_000) });
  await page.goto(`/videos/${w.id}`);
  await expect(comments).toHaveAttribute("data-seen-read", "true");
  await expect(comments.getByTestId("comment-list")).toHaveCount(0);
  expect((await page.request.post(`/api/videos/${w.id}/comments`, { data: { text: "First note." } })).status()).toBe(201);
  await page.reload();
  await expect(comments).toHaveAttribute("data-seen-read", "true");
  await expect(rows.filter({ hasText: "First note." }).getByTestId("comment-new")).toBeVisible();
  await expect(comments.getByTestId("comments-new")).toHaveText("1 new since you last opened this video");
});

test("in a workspace, a video's open comments narrow to those that mention you or that you wrote in", async ({ page }) => {
  const tag = Date.now().toString(36);
  const ws = (await (await page.request.post("/api/workspaces", { data: { name: `Filter ${tag}` } })).json()).workspace as { id: string };
  try {
    expect((await page.request.post("/api/workspaces/switch", { data: { id: ws.id } })).status()).toBe(200);
    const me = ((await (await page.request.get("/api/workspaces")).json()).workspaces as Array<{ id: string; members: Array<{ userId: string; you?: boolean }> }>)
      .find((w) => w.id === ws.id)!.members.find((m) => m.you)!.userId;
    const v = await createVideoViaApi(page, `Filter ${tag}`);
    for (const text of ["Logo is too small.", "Music is loud.", "Fix my typo."]) await page.request.post(`/api/videos/${v.id}/comments`, { data: { text } });
    // Demo mode has one person without an email, so teammates are played by the page's data: two notes are theirs, one names you.
    await page.route(`**/api/videos/${v.id}/comments`, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const real = await (await route.fetch()).json();
      const comments = (real.comments as Array<{ text: string; authorId: string; mine: boolean; mentions?: unknown }>).map((c) =>
        c.text === "Fix my typo." ? c : { ...c, authorId: "u-teammate", mine: false, ...(c.text === "Logo is too small." ? { mentions: [{ userId: me, email: "you@example.com" }] } : {}) },
      );
      await route.fulfill({ json: { ...real, comments } });
    });
    await page.goto(`/videos/${v.id}`);
    const comments = page.getByTestId("comments");
    const show = comments.getByRole("combobox", { name: "Show" });
    const rows = comments.getByTestId("comment-list").locator("> li");
    await expect(rows).toHaveCount(3);
    await show.selectOption("mentions");
    await expect(rows).toHaveText([/Logo is too small\./]);
    await expect(comments).toContainText("Comments · 3");
    await show.selectOption("mine");
    await expect(rows).toHaveText([/Fix my typo\./]);
    // Resolving the last one shown leaves none to show, with a way back to every open one.
    await comments.getByRole("button", { name: "Resolve comment: Fix my typo." }).click();
    await expect(comments.getByTestId("comment-filter-empty")).toHaveText("You have not written in any open comment. Show all 2 open");
    // The last one shown resolved, the way back to the others takes the focus, and then hands it to the select.
    await expect(comments.getByRole("button", { name: "Show all 2 open" })).toBeFocused();
    await comments.getByRole("button", { name: "Show all 2 open" }).click();
    await expect(show).toHaveValue("all");
    await expect(show).toBeFocused();
    await expect(comments.getByRole("status")).toHaveText("2 open shown");
    await expect(rows).toHaveCount(2);
    // A note reopened that the filter would hide brings every open thread back, the focus on its Resolve button.
    await show.selectOption("mentions");
    await expect(comments.getByRole("status")).toHaveText("1 of 2 open shown");
    await comments.getByRole("button", { name: "Show 1 resolved" }).click();
    await comments.getByRole("button", { name: "Reopen comment: Fix my typo." }).click();
    await expect(show).toHaveValue("all");
    await expect(rows).toHaveCount(3);
    await expect(comments.getByRole("button", { name: "Resolve comment: Fix my typo." })).toBeFocused();
    // A note posted under "Mentioning me" never names its writer, so every open thread is shown with it.
    await show.selectOption("mentions");
    await page.getByLabel("New comment").fill("One more thing.");
    await page.getByLabel("New comment").press("Control+Enter");
    await expect(show).toHaveValue("all");
    await expect(rows).toHaveCount(4);
    await expect(rows.last()).toContainText("One more thing.");
    await comments.getByRole("button", { name: "Resolve comment: One more thing." }).click();
    await expect(rows).toHaveCount(3);
    await comments.getByRole("button", { name: "Resolve comment: Fix my typo." }).click();
    await expect(rows).toHaveCount(2);
    // Resolve all, with only one thread shown, is not offered; with every open thread shown it is.
    await show.selectOption("mentions");
    await expect(rows).toHaveCount(1);
    await expect(comments.getByTestId("comments-resolve-all")).toHaveCount(0);
    await show.selectOption("all");
    await expect(comments.getByTestId("comments-resolve-all")).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.request.post("/api/workspaces/switch", { data: { id: "local" } });
    await page.request.delete(`/api/workspaces/${ws.id}`);
  }
});

test("a video's open comments are copied as text to paste into a chat, in the order shown", async ({ page }) => {
  const title = `Copy notes ${Date.now().toString(36)}`;
  const v = await createVideoViaApi(page, title);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  const post = async (data: Record<string, unknown>) => (await (await page.request.post(`/api/videos/${v.id}/comments`, { data })).json()).comment as { id: string };
  const intro = await post({ text: "Tighten the intro." });
  await post({ text: "On it.", parentId: intro.id });
  await post({ text: "Cut the pause here.", atSec: 4 });
  const done = await post({ text: "Typo in the title." });
  await page.request.patch(`/api/videos/${v.id}/comments/${done.id}`, { data: { resolved: true } });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/videos/${v.id}`);
  const comments = page.getByTestId("comments");
  await comments.getByRole("button", { name: "Copy as text" }).click();
  // Only the open threads, numbered as listed, a pinned one with its moment, replies under their note.
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    [`Comments on “${title}” (2 comments)`, "", "1. Tighten the intro. (you)", "   ↳ On it. (you)", "2. [0:04] Cut the pause here. (you)"].join("\n"),
  );
  await expect(comments.getByRole("status")).toHaveText("2 comments copied as text");
  // In the video's order, the pinned one comes first.
  await comments.getByRole("combobox", { name: "Order" }).selectOption("moment");
  await comments.getByRole("button", { name: "Copy as text" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("1. [0:04] Cut the pause here. (you)\n2. Tighten the intro. (you)");
  await comments.getByRole("combobox", { name: "Order" }).selectOption("written");
  // Without a clipboard the text is shown, selected, to copy by hand, its lines kept; Done closes it, back on the button.
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error("blocked"));
  });
  const copy = comments.getByRole("button", { name: "Copy as text" });
  await copy.click();
  const box = comments.getByRole("textbox", { name: "Comments as text, to copy" });
  await expect(box).toBeFocused();
  expect(await box.inputValue()).toBe([`Comments on “${title}” (2 comments)`, "", "1. Tighten the intro. (you)", "   ↳ On it. (you)", "2. [0:04] Cut the pause here. (you)"].join("\n"));
  expect(await box.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, (await box.inputValue()).length]);
  await expect(comments.getByRole("status")).toHaveText("Could not copy; the text is selected below to copy by hand");
  await comments.getByRole("button", { name: "Done" }).click();
  await expect(box).toHaveCount(0);
  await expect(copy).toBeFocused();
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
  // Ctrl+Enter in the box posts it, as Post comment does, and leaves the focus there for the next note.
  await page.getByLabel("New comment").fill("Cut the pause here.");
  await page.getByLabel("New comment").press("Control+Enter");
  await expect(page.getByTestId("comment-list")).toContainText("0:08Cut the pause here.");
  await expect(page.getByLabel("New comment")).toHaveValue("");
  await expect(page.getByLabel("New comment")).toBeFocused();
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
  expect(sheet.columns).toEqual(["id", "title", "status", "created", "folder", "duration_sec", "views", "views_7d", "last_viewed", "watched_25", "watched_50", "watched_75", "watched_100", "finish_rate", "cta_clicks", "share_link", "embed_views"]);
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

test("a share link can be scheduled to go live later, and is not found until then", async ({ page }) => {
  const v = await createVideoViaApi(page, `Launch ${Date.now().toString(36)}`);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  await page.goto(`/videos/${v.id}`);
  const pad = (n: number) => String(n).padStart(2, "0");
  const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const start = page.getByTestId("share-start");
  // A past time is refused; so is one at or after the link's expiry.
  await page.getByLabel("Share link go-live time").fill(local(new Date(Date.now() - 60 * 60 * 1000)));
  await start.getByRole("button", { name: "Schedule go-live" }).click();
  await expect(page.getByText("The go-live time must be in the future")).toBeVisible();
  const launch = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  launch.setHours(12, 0, 0, 0); // noon: never inside a daylight-saving transition
  await page.getByLabel("Share link go-live time").fill(local(launch));
  await start.getByRole("button", { name: "Schedule go-live" }).click();
  await expect(page.getByTestId("share-start-badge")).toContainText("Goes live");
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.shareStartsAt).toBe(launch.toISOString());
  // Until then the share page, its beacons, and oEmbed answer "not found"; the owner keeps the page.
  expect((await page.request.get(`/share/${v.id}`)).status()).toBe(404);
  expect((await page.request.post(`/api/videos/${v.id}/view`)).status()).toBe(404);
  expect((await page.request.get(`/api/oembed?url=${encodeURIComponent(`http://localhost:3100/share/${v.id}`)}`)).status()).toBe(404);
  const early = new Date(launch.getTime() - 24 * 60 * 60 * 1000);
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareExpiresAt: early.toISOString() } })).status()).toBe(400);
  // The email form waits for it.
  await expect(page.getByText(/^The link goes live .+; send it then\.$/)).toBeVisible();
  // The library card says it is scheduled.
  await page.goto("/videos");
  await expect(page.locator(`a[href="/videos/${v.id}"]`).getByTestId("share-badges")).toContainText("Scheduled");
  // "Go live now" opens it at once.
  await page.goto(`/videos/${v.id}`);
  await start.getByRole("button", { name: "Go live now" }).click();
  await expect(page.getByTestId("share-start-badge")).toHaveCount(0);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.shareStartsAt).toBeUndefined();
  await expect.poll(async () => (await page.request.get(`/share/${v.id}`)).status()).toBe(200);
  expect((await page.request.get(`/api/oembed?url=${encodeURIComponent(`http://localhost:3100/share/${v.id}`)}`)).status()).toBe(200);
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

test("the brand kit's caption style is where new videos start", async ({ page }) => {
  try {
    await page.goto("/brand");
    await page.getByPlaceholder("Acme Realty").fill("Caption Co");
    await page.getByLabel("Captions on by default").check();
    const kitStyle = page.getByTestId("brand-caption-style");
    await kitStyle.getByRole("group", { name: "Caption position" }).getByRole("button", { name: "top" }).click();
    await kitStyle.getByRole("group", { name: "Caption size" }).getByRole("button", { name: "large" }).click();
    await kitStyle.getByRole("group", { name: "Caption look" }).getByRole("button", { name: "yellow" }).click();
    await kitStyle.getByRole("group", { name: "Caption font" }).getByRole("button", { name: "serif" }).click();
    await expect(page.getByText("Captions: on, top, large, yellow, serif")).toBeVisible();
    await page.getByRole("button", { name: "Save brand kit" }).click();
    await expect(page.getByText(/^Saved /)).toBeVisible();
    expect((await (await page.request.get("/api/brand")).json()).brand.captionStyle).toEqual({ position: "top", size: "large", look: "yellow", font: "serif" });
    await page.reload();
    await expect(kitStyle.getByRole("group", { name: "Caption look" }).getByRole("button", { name: "yellow" })).toHaveAttribute("aria-pressed", "true");
    // A new video starts captioned in the kit's style, which it can change for itself.
    await page.goto("/create");
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("checkbox", { name: /Captions/ })).toBeChecked();
    const style = page.getByTestId("caption-style");
    await expect(style.getByRole("group", { name: "Caption position" }).getByRole("button", { name: "top" })).toHaveAttribute("aria-pressed", "true");
    await expect(style.getByRole("group", { name: "Caption size" }).getByRole("button", { name: "large" })).toHaveAttribute("aria-pressed", "true");
    await expect(style.getByRole("group", { name: "Caption look" }).getByRole("button", { name: "yellow" })).toHaveAttribute("aria-pressed", "true");
    await expect(style.getByRole("group", { name: "Caption font" }).getByRole("button", { name: "serif" })).toHaveAttribute("aria-pressed", "true");
    await style.getByRole("group", { name: "Caption look" }).getByRole("button", { name: "bold" }).click();
    await expect(style.getByRole("group", { name: "Caption look" }).getByRole("button", { name: "bold" })).toHaveAttribute("aria-pressed", "true");
    // Removing the kit puts its caption style back to the default with everything else.
    await page.evaluate(() => localStorage.removeItem("avatar-studio:draft"));
    await page.goto("/brand");
    await expect(kitStyle.getByRole("group", { name: "Caption look" }).getByRole("button", { name: "yellow" })).toHaveAttribute("aria-pressed", "true");
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Remove brand kit" }).click();
    await expect(kitStyle.getByRole("group", { name: "Caption look" }).getByRole("button", { name: "classic" })).toHaveAttribute("aria-pressed", "true");
    await expect(kitStyle.getByRole("group", { name: "Caption position" }).getByRole("button", { name: "bottom" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Captions: off, bottom, medium, classic, sans")).toBeVisible();
  } finally {
    await page.evaluate(() => localStorage.removeItem("avatar-studio:draft")).catch(() => {});
    expect([204, 404]).toContain((await page.request.delete("/api/brand")).status());
  }
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
  // The batch's links download in the CSV's order, each with its recipient, status, and, once ready, its share link.
  const linksDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download links (CSV)" }).click();
  const links = parseCsv(await readFile(await (await linksDownload).path(), "utf8"));
  expect(links.columns).toEqual(["row", "recipient", "title", "status", "share_link", "share_expires", "password_required", "email_required", "video_id", "created"]);
  expect(links.rows.map((r) => [r.row, r.recipient, r.title])).toEqual([["1", "Jordan", "Welcome video – Jordan"], ["2", "Priya", "Welcome video – Priya"]]);
  for (const r of links.rows) expect(r.share_link).toBe(r.status === "completed" ? `http://localhost:3100/share/${r.video_id}` : "");
  expect((await page.request.get("/api/videos/batch/batch_nosuch")).status()).toBe(404);
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
  await expect(page.getByTestId("share-player").locator('track[kind="subtitles"]')).toHaveAttribute("default", "");
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
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
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
    route.fulfill({
      json: { suggestion: { sourceUrl: "https://www.maple.example/", name: "Maple Street Realty", logoUrl: "http://localhost:3100/demo/poster.svg", primaryColor: "#0f766e", accentColor: "#f59e0b", writingStyle: "Warm and neighbourly, speaking to families." } },
    }),
  );
  await page.getByLabel("Website address").fill("maple.example");
  await page.getByLabel("Website address").press("Enter");
  await expect(page.getByTestId("brand-import-status")).toHaveText("Filled in the name, a logo, two colours and a draft writing style from www.maple.example. Check them, then save the brand kit.");
  const style = page.getByRole("textbox", { name: "Writing style" });
  await expect(style).toHaveValue("Warm and neighbourly, speaking to families.");
  // The draft says where it came from, read with the field, until it is edited.
  await expect(page.locator("#writing-style-draft")).toHaveText("Drafted by Claude from www.maple.example's text: read it, and edit anything that is not how you write, before saving.");
  await expect(style).toHaveAttribute("aria-describedby", /writing-style-draft/);
  await expect(page.getByPlaceholder("Acme Realty")).toHaveValue("Maple Street Realty");
  await expect(page.getByLabel("Primary color", { exact: true })).toHaveValue("#0f766e");
  await expect(page.getByLabel("Accent color", { exact: true })).toHaveValue("#f59e0b");
  await expect(page.getByAltText("Logo preview")).toHaveAttribute("src", "http://localhost:3100/demo/poster.svg");
  expect((await (await page.request.get("/api/brand")).json()).brand?.name ?? "").not.toBe("Maple Street Realty");
  // A second site asks before replacing what is filled in; declining keeps it.
  await page.unroute("**/api/brand/import");
  await page.route("**/api/brand/import", (route) => route.fulfill({ json: { suggestion: { sourceUrl: "https://other.example/", name: "Other Co", primaryColor: "#dc2626", writingStyle: "Bold and brief." } } }));
  // The writing style, often written by hand, is asked about on its own.
  const asked: string[] = [];
  const decline = (d: Dialog) => (asked.push(d.message()), void d.dismiss());
  page.on("dialog", decline);
  await style.fill("Plain and kind, in my own words.");
  await expect(page.locator("#writing-style-draft")).toHaveCount(0);
  await page.getByLabel("Website address").fill("other.example");
  await page.getByRole("button", { name: "Fill in" }).click();
  await expect(page.getByTestId("brand-import-status")).toHaveText("Kept what you had; other.example offered nothing for the empty fields.");
  page.off("dialog", decline);
  expect(asked).toEqual([
    "Replace your name and colours with the ones from other.example? Cancel keeps yours and fills in only what is empty.",
    "Replace your writing style with a draft from other.example's text? Cancel keeps yours.",
  ]);
  await expect(style).toHaveValue("Plain and kind, in my own words.");
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

test("the library filters by share link state", async ({ page }) => {
  const tag = Date.now().toString(36);
  const [off, later, soon, open] = [
    await createVideoViaApi(page, `Share off ${tag}`),
    await createVideoViaApi(page, `Share later ${tag}`),
    await createVideoViaApi(page, `Share soon ${tag}`),
    await createVideoViaApi(page, `Share open ${tag}`),
  ];
  const inDays = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
  expect((await page.request.patch(`/api/videos/${off.id}`, { data: { shareDisabled: true } })).ok()).toBe(true);
  expect((await page.request.patch(`/api/videos/${later.id}`, { data: { shareStartsAt: inDays(2) } })).ok()).toBe(true);
  expect((await page.request.patch(`/api/videos/${soon.id}`, { data: { shareExpiresAt: inDays(3) } })).ok()).toBe(true);
  // The server filters, so the API answers the same as the page.
  const listed = async (share: string) => ((await (await page.request.get(`/api/videos?q=${tag}&share=${share}`)).json()).videos as { id: string }[]).map((v) => v.id).sort();
  expect(await listed("off")).toEqual([off.id]);
  expect(await listed("scheduled")).toEqual([later.id]);
  expect(await listed("expiring")).toEqual([soon.id]);
  expect(await listed("live")).toEqual([soon.id, open.id].sort());
  expect((await page.request.get(`/api/videos?share=public`)).status()).toBe(400);

  await page.goto("/videos");
  await page.getByLabel("Search videos").fill(tag);
  const card = (id: string) => page.locator(`a[href="/videos/${id}"]`);
  await expect(card(open.id)).toBeVisible();
  const filter = page.getByLabel("Filter by share link");
  // Each step first waits for a card the filter drops, so the checks after it read the filtered list.
  await filter.selectOption("expiring");
  await expect(card(open.id)).toHaveCount(0);
  await expect(card(soon.id).getByTestId("share-badges")).toContainText(/Expires in [34] days/);
  await filter.selectOption("scheduled");
  await expect(card(soon.id)).toHaveCount(0);
  await expect(card(later.id).getByTestId("share-badges")).toContainText("Scheduled");
  await filter.selectOption("off");
  await expect(card(later.id)).toHaveCount(0);
  await expect(card(off.id).getByTestId("share-badges")).toContainText("Link off");
  await filter.selectOption("live");
  await expect(card(off.id)).toHaveCount(0);
  await expect(card(open.id)).toBeVisible();
  await expect(card(soon.id)).toBeVisible();
  await expect(card(later.id)).toHaveCount(0);
  await filter.selectOption("expired");
  await expect(page.getByText("No videos match")).toBeVisible();
  // The trash has no share filter (trashed links answer "not found" whatever they were set to), and leaving it starts from any.
  await page.getByTestId("trash-toggle").click();
  await expect(filter).toHaveCount(0);
  await page.getByTestId("trash-toggle").click();
  await expect(filter).toHaveValue("all");
  await expect(card(off.id)).toBeVisible();
  await expect(card(open.id)).toBeVisible();

  // The selection's links download as a CSV in the order picked: the link where it can be sent, and why the others are blank.
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${open.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  await page.reload();
  await page.getByLabel("Search videos").fill(tag);
  await expect(card(open.id)).toBeVisible();
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Share open ${tag}` }).click();
  await page.getByRole("button", { name: `Select Share off ${tag}` }).click();
  await page.getByRole("button", { name: `Select Share later ${tag}` }).click();
  const saved = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download links" }).click();
  const file = await saved;
  expect(file.suggestedFilename()).toMatch(/^links-\d{4}-\d{2}-\d{2}\.csv$/);
  const links = parseCsv(await readFile(await file.path(), "utf8"));
  expect(links.columns).toEqual(["title", "status", "share_state", "share_link", "share_goes_live", "share_expires", "password_required", "email_required", "folder", "video_id", "created"]);
  expect(links.rows.map((r) => [r.video_id, r.share_state, r.share_link])).toEqual([
    [open.id, "live", `http://localhost:3100/share/${open.id}`],
    [off.id, "off", ""],
    [later.id, "scheduled", ""],
  ]);
  expect(links.rows[2].share_goes_live).not.toBe("");
  // The selection stays, so the links can be fixed and the file downloaded again.
  await expect(page.getByTestId("bulk-bar")).toContainText("3 selected");
  expect((await page.request.post("/api/videos/links", { data: { ids: [] } })).status()).toBe(400);
  expect((await page.request.post("/api/videos/links", { data: { ids: ["vid_nosuch"] } })).status()).toBe(404);
  // Ids left out are counted, so the page can say so.
  const partial = await page.request.post("/api/videos/links", { data: { ids: [open.id, "vid_nosuch", open.id] } });
  expect(partial.headers()["x-omitted"]).toBe("1");
  expect(parseCsv(await partial.text()).rows.map((r) => r.video_id)).toEqual([open.id]);
});

test("library multi-select moves and deletes videos in bulk", async ({ page }) => {
  const tag = Date.now().toString(36);
  const a = await createVideoViaApi(page, `Bulk one ${tag}`);
  const b = await createVideoViaApi(page, `Bulk two ${tag}`);
  // Only the confirms may open a dialog: Move to folder is a field in the bar, and the share buttons ask nothing.
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.accept();
  });

  await page.goto("/videos");
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk one ${tag}` }).click();
  await page.getByRole("button", { name: `Select Bulk two ${tag}` }).click();
  await expect(page.getByTestId("bulk-bar")).toContainText("2 selected");
  await page.getByRole("button", { name: "Move to folder" }).click();
  const folderField = page.getByLabel("Folder for the selected videos");
  await expect(folderField).toBeFocused();
  await folderField.fill(`Bulk ${tag}`);
  await expect(page.getByTestId("bulk-folder")).toContainText("A new folder");
  await page.getByTestId("bulk-folder").getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  expect((await (await page.request.get(`/api/videos/${a.id}`)).json()).video.folder).toBe(`Bulk ${tag}`);
  expect((await (await page.request.get(`/api/videos/${b.id}`)).json()).video.folder).toBe(`Bulk ${tag}`);
  // A name that differs only in case and spacing joins that folder rather than starting a twin of it.
  const c = await createVideoViaApi(page, `Bulk three ${tag}`);
  await page.reload();
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk three ${tag}` }).click();
  await page.getByRole("button", { name: "Move to folder" }).click();
  await page.getByLabel("Folder for the selected videos").fill(`  BULK ${tag.toUpperCase()} `);
  await expect(page.getByTestId("bulk-folder")).toContainText(`Into the existing “Bulk ${tag}”`);
  // Enter moves them, as Move does.
  await page.getByLabel("Folder for the selected videos").press("Enter");
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  expect((await (await page.request.get(`/api/videos/${c.id}`)).json()).video.folder).toBe(`Bulk ${tag}`);
  // Unfiled takes it out again; closing the field moves nothing.
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk three ${tag}` }).click();
  await page.getByRole("button", { name: "Move to folder" }).click();
  await page.getByRole("button", { name: "Close folder" }).click();
  await expect(page.getByTestId("bulk-folder")).toHaveCount(0);
  expect((await (await page.request.get(`/api/videos/${c.id}`)).json()).video.folder).toBe(`Bulk ${tag}`);
  await page.getByRole("button", { name: "Move to folder" }).click();
  await page.getByTestId("bulk-folder").getByRole("button", { name: "Unfiled" }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  expect((await (await page.request.get(`/api/videos/${c.id}`)).json()).video.folder ?? "").toBe("");

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

  // A go-live time can be set on the selection: not found until then, "Scheduled" on the card, and live again at once.
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk one ${tag}` }).click();
  await page.getByRole("button", { name: "Schedule go-live" }).click();
  const pad = (n: number) => String(n).padStart(2, "0");
  const launch = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  launch.setHours(12, 0, 0, 0);
  await page.getByLabel("Go-live time for the selected videos").fill(`${launch.getFullYear()}-${pad(launch.getMonth() + 1)}-${pad(launch.getDate())}T12:00`);
  await page.getByTestId("bulk-schedule").getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  await expect(badgeOn(a.id)).toContainText("Scheduled");
  expect((await (await page.request.get(`/api/videos/${a.id}`)).json()).video.shareStartsAt).toBe(launch.toISOString());
  expect((await page.request.get(`/share/${a.id}`)).status()).toBe(404);
  // A video whose own expiry comes first is left as it was and stays selected, the banner says why.
  const sooner = new Date(launch.getTime() - 24 * 60 * 60 * 1000);
  expect((await page.request.patch(`/api/videos/${b.id}`, { data: { shareExpiresAt: sooner.toISOString() } })).ok()).toBe(true);
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk two ${tag}` }).click();
  await page.getByRole("button", { name: "Schedule go-live" }).click();
  await page.getByLabel("Go-live time for the selected videos").fill(`${launch.getFullYear()}-${pad(launch.getMonth() + 1)}-${pad(launch.getDate())}T12:00`);
  await page.getByTestId("bulk-schedule").getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByText("1 selected video expires at or before that time, so it was not scheduled and is still selected; set a later expiry on it first.")).toBeVisible();
  await expect(page.getByTestId("bulk-bar")).toContainText("1 selected");
  expect((await (await page.request.get(`/api/videos/${b.id}`)).json()).video.shareStartsAt).toBeUndefined();
  await page.getByRole("button", { name: "Close go-live time" }).click();
  await expect(page.getByTestId("bulk-schedule")).toHaveCount(0);
  await page.getByRole("button", { name: "Done selecting" }).click();
  expect((await page.request.patch(`/api/videos/${b.id}`, { data: { shareExpiresAt: null } })).ok()).toBe(true);
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk one ${tag}` }).click();
  await page.getByRole("button", { name: "Schedule go-live" }).click();
  await page.getByTestId("bulk-schedule").getByRole("button", { name: "Go live now" }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  await expect(badgeOn(a.id)).toHaveCount(0);
  expect((await page.request.get(`/share/${a.id}`)).status()).toBe(200);

  // An expiry can be set on the selection the same way: live until then, a video going live at or after it is left
  // as it was and stays selected, and "No expiry" clears it. The two fields open one at a time.
  const launchField = `${launch.getFullYear()}-${pad(launch.getMonth() + 1)}-${pad(launch.getDate())}T12:00`;
  expect((await page.request.patch(`/api/videos/${b.id}`, { data: { shareStartsAt: launch.toISOString() } })).ok()).toBe(true);
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk one ${tag}` }).click();
  await page.getByRole("button", { name: `Select Bulk two ${tag}` }).click();
  await page.getByRole("button", { name: "Schedule go-live" }).click();
  await page.getByRole("button", { name: "Set expiry" }).click();
  await expect(page.getByTestId("bulk-schedule")).toHaveCount(0);
  await page.getByLabel("Expiry for the selected videos").fill(launchField);
  await page.getByTestId("bulk-expiry").getByRole("button", { name: "Set expiry", exact: true }).click();
  await expect(page.getByText("1 selected video goes live at or after that time, so it was not given that expiry and is still selected; set an earlier go-live time on it first.")).toBeVisible();
  await expect(page.getByTestId("bulk-bar")).toContainText("1 selected");
  expect((await (await page.request.get(`/api/videos/${a.id}`)).json()).video.shareExpiresAt).toBe(launch.toISOString());
  expect((await (await page.request.get(`/api/videos/${b.id}`)).json()).video.shareExpiresAt).toBeUndefined();
  expect((await page.request.get(`/share/${a.id}`)).status()).toBe(200);
  await page.getByRole("button", { name: "Close expiry" }).click();
  await expect(page.getByTestId("bulk-expiry")).toHaveCount(0);
  await page.getByRole("button", { name: "Done selecting" }).click();
  // Within a week of it, the card says so (noon three days out is three or four days away, rounded up).
  await expect(badgeOn(a.id)).toContainText(/Expires in [34] days/);
  expect((await page.request.patch(`/api/videos/${b.id}`, { data: { shareStartsAt: null } })).ok()).toBe(true);
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk one ${tag}` }).click();
  await page.getByRole("button", { name: "Set expiry" }).click();
  await page.getByTestId("bulk-expiry").getByRole("button", { name: "No expiry" }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  expect((await (await page.request.get(`/api/videos/${a.id}`)).json()).video.shareExpiresAt).toBeUndefined();
  await expect(badgeOn(a.id)).toHaveCount(0);

  // One password goes on every selected link (too short is refused in the page), and comes off again in one step.
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk one ${tag}` }).click();
  await page.getByRole("button", { name: `Select Bulk two ${tag}` }).click();
  await page.getByRole("button", { name: "Password", exact: true }).click();
  await page.getByLabel("Share password for the selected videos").fill("abc");
  await page.getByTestId("bulk-password").getByRole("button", { name: "Protect" }).click();
  await expect(page.getByText("The share password needs 4 to 64 characters")).toBeVisible();
  await page.getByLabel("Share password for the selected videos").fill("open sesame");
  await page.getByTestId("bulk-password").getByRole("button", { name: "Protect" }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  await expect(badgeOn(a.id)).toContainText("Password");
  await expect(badgeOn(b.id)).toContainText("Password");
  for (const id of [a.id, b.id]) {
    const record = (await (await page.request.get(`/api/videos/${id}`)).json()).video;
    expect(record.shareLocked).toBe(true);
    expect(JSON.stringify(record)).not.toContain("sesame");
  }
  expect((await page.request.post(`/api/videos/${a.id}/unlock`, { data: { password: "open sesame" } })).ok()).toBe(true);
  // Protecting a video that already has a password asks first, and the old one stops working.
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk one ${tag}` }).click();
  await page.getByRole("button", { name: "Password", exact: true }).click();
  await page.getByLabel("Share password for the selected videos").fill("new sesame");
  await page.getByTestId("bulk-password").getByRole("button", { name: "Protect" }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  expect((await page.request.post(`/api/videos/${a.id}/unlock`, { data: { password: "open sesame" } })).status()).toBe(401);
  expect((await page.request.post(`/api/videos/${a.id}/unlock`, { data: { password: "new sesame" } })).ok()).toBe(true);
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk one ${tag}` }).click();
  await page.getByRole("button", { name: `Select Bulk two ${tag}` }).click();
  await page.getByRole("button", { name: "Password", exact: true }).click();
  await page.getByTestId("bulk-password").getByRole("button", { name: "Remove password" }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  await expect(badgeOn(a.id)).toHaveCount(0);
  expect((await (await page.request.get(`/api/videos/${b.id}`)).json()).video.shareLocked).toBeUndefined();

  // The download button and email gate go on or off for the selection; a setting left "as is" is not touched.
  const settingsOf = async (id: string) => {
    const v = (await (await page.request.get(`/api/videos/${id}`)).json()).video;
    return [v.shareDownload ?? false, v.shareGate ?? false];
  };
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk one ${tag}` }).click();
  await page.getByRole("button", { name: `Select Bulk two ${tag}` }).click();
  await page.getByRole("button", { name: "Download & email" }).click();
  await expect(page.getByTestId("bulk-settings").getByRole("button", { name: "Apply" })).toBeDisabled();
  await page.getByLabel("Download button for the selected videos").selectOption("on");
  await page.getByLabel("Ask for email for the selected videos").selectOption("on");
  await page.getByTestId("bulk-settings").getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  expect(await settingsOf(a.id)).toEqual([true, true]);
  expect(await settingsOf(b.id)).toEqual([true, true]);
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk one ${tag}` }).click();
  await page.getByRole("button", { name: "Download & email" }).click();
  await page.getByLabel("Ask for email for the selected videos").selectOption("off");
  await page.getByTestId("bulk-settings").getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  expect(await settingsOf(a.id)).toEqual([true, false]);
  expect(await settingsOf(b.id)).toEqual([true, true]);
  expect((await page.request.post("/api/videos/bulk", { data: { action: "settings", ids: [a.id] } })).status()).toBe(400);

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
  expect(dialogs).toEqual(["1 selected video already has a share password. Replace it with this one? Visitors who unlocked it must enter the new one.", "Remove the share password from 2 videos? Anyone with their links can then watch.", "Ask for an email before the 2 selected videos play? Everyone opening their links or embeds, including people you have already sent them to, sees the form first.", "Move 1 video to the trash? You can restore it for 30 days.", "Delete this video for good? Its short clips, and the cleaned and lip-synced copies made from it, go too. This cannot be undone."]);
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
  const paths = ["/", "/login", "/home", "/create", "/agent", "/videos", `/videos/${v.id}`, "/templates", "/batch", "/avatars", "/voices", "/assets", "/translate", "/cleanup", "/lipsync", "/music", "/cinematic", "/footage", "/photos", "/voice-changer", "/interactive", "/brand", "/settings", `/share/${v.id}`, `/talk/${agent.id}`, "/demo-consent"];
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
  // An interactive presenter speaking in it is named to the viewer too, who can read the presenters anyway.
  const speaker = (await (await page.request.post("/api/agents", { data: { name: `Viewer desk ${Date.now().toString(36)}`, avatarId: "stock_2", voiceId: own.id } })).json()).agent as { id: string; name: string };
  await page.goto("/voices");
  await expect(page.getByTestId("voice-cloner")).toHaveCount(0);
  await expect(page.getByTestId("view-only")).toBeVisible();
  await expect(page.getByText(own.name, { exact: true })).toBeVisible();
  await expect(page.locator(`[data-voice-others="${own.id}"]`)).toHaveText(`Used by the interactive presenter “${speaker.name}”`);
  expect((await page.request.delete(`/api/agents/${speaker.id}`)).ok()).toBe(true);
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
  expect(csv.replace(/^\uFEFF/, "").split("\r\n")[0]).toBe('"started","last_message","email","name","messages","first_question","last_reply","followed_up","note","helpful","not_helpful"');
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

test("a saved presenter is edited in place, keeping its link, and editing can be cancelled", async ({ page }) => {
  const tag = Date.now().toString(36);
  const make = async (data: Record<string, unknown>) => (await (await page.request.post("/api/agents", { data })).json()).agent as { id: string };
  const a = await make({ name: `Edit me ${tag}`, avatarId: "stock_2", instructions: "Old instructions.", greeting: "Old hello.", starters: ["Old question?"], language: "English", isPublic: false });
  const b = await make({ name: `Other ${tag}`, avatarId: "stock_1", instructions: "Other instructions.", language: "French" });
  const stored = async (id: string) => ((await (await page.request.get("/api/agents")).json()).agents as Record<string, unknown>[]).find((x) => x.id === id)!;
  const before = await stored(a.id);
  try {
    await page.goto("/interactive");
    // A draft for a new presenter, to come back to.
    await page.getByLabel("Instructions").fill("My new presenter's draft.");
    await page.getByRole("button", { name: `Edit Edit me ${tag}` }).click();
    // The form holds the saved presenter, and says that saving changes it in place.
    const heading = page.getByRole("heading", { name: `Editing Edit me ${tag}` });
    await expect(heading).toBeFocused();
    await expect(page.getByTestId("agent-editing")).toContainText("only what you change here is saved");
    await expect(page.getByLabel("Agent name")).toHaveValue(`Edit me ${tag}`);
    await expect(page.getByLabel("Instructions")).toHaveValue("Old instructions.");
    await expect(page.getByLabel("Opening line")).toHaveValue("Old hello.");
    await expect(page.getByLabel("Suggested questions")).toHaveValue("Old question?");
    // Another presenter's Edit replaces every field.
    await page.getByRole("button", { name: `Edit Other ${tag}` }).click();
    await expect(page.getByRole("heading", { name: `Editing Other ${tag}` })).toBeFocused();
    await expect(page.getByLabel("Instructions")).toHaveValue("Other instructions.");
    await expect(page.getByLabel("Opening line")).toHaveValue("");
    await expect(page.getByLabel("Reply language")).toHaveValue("French");
    // Cancelling leaves the presenter as it was and puts the draft back, focus on the form's heading.
    await page.getByRole("button", { name: "Cancel editing" }).click();
    await expect(page.getByRole("heading", { name: "Presenter setup" })).toBeFocused();
    await expect(page.getByLabel("Instructions")).toHaveValue("My new presenter's draft.");
    await expect(page.getByLabel("Agent name")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Save and get link" })).toBeVisible();

    await page.getByRole("button", { name: `Edit Edit me ${tag}` }).click();
    await page.getByLabel("Agent name").fill(`Edited ${tag}`);
    await page.getByLabel("Instructions").fill("New instructions.");
    await page.getByLabel("Opening line").fill("");
    await page.getByLabel("Suggested questions").fill("New question?\nAnother?");
    await page.getByRole("button", { name: "Save changes" }).click();
    // The same link, with the changes; a cleared opening line is gone, and what was not touched is kept.
    await expect(page.getByTestId("agent-link").locator("code")).toHaveText(new RegExp(`/talk/${a.id}$`));
    const saved = await stored(a.id);
    expect(saved).toMatchObject({ name: `Edited ${tag}`, instructions: "New instructions.", starters: ["New question?", "Another?"], isPublic: false, avatarId: "stock_2" });
    expect(saved.greeting).toBeUndefined();
    expect(saved.voiceId).toBe(before.voiceId);
    await expect(page.getByRole("heading", { name: "Presenter setup" })).toBeVisible();
    await expect(page.getByLabel("Instructions")).toHaveValue("My new presenter's draft.");
    await expect(page.getByTestId("agent-list")).toContainText(`Edited ${tag}`);

    // A switch flipped on the row while the presenter is edited shows in the form and survives the save.
    await page.getByRole("button", { name: `Edit Edited ${tag}` }).click();
    const emails = page.getByRole("checkbox", { name: /Ask visitors for an email/ });
    await expect(emails).not.toBeChecked();
    await page.getByRole("button", { name: `Collect emails for Edited ${tag}` }).click();
    await expect(emails).toBeChecked();
    await page.getByLabel("Instructions").fill("Newer instructions.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("heading", { name: "Presenter setup" })).toBeVisible();
    expect(await stored(a.id)).toMatchObject({ instructions: "Newer instructions.", collectEmail: true });

    // A presenter no longer in the library is named, and Save waits until another is picked.
    await page.route("**/api/avatars", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { avatars: { id: string }[] };
      await route.fulfill({ response: res, json: { ...body, avatars: body.avatars.filter((x) => x.id !== "stock_2") } });
    });
    await page.reload();
    await page.getByRole("button", { name: `Edit Edited ${tag}` }).click();
    await expect(page.getByTestId("agent-missing")).toContainText("is no longer in your library; pick another before saving");
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
    // The pick is saved, even of a presenter the form already showed; the voice stays as it was.
    await page.getByRole("button", { name: /^Sofia Reyes/ }).click();
    await expect(page.getByTestId("agent-missing")).toHaveCount(0);
    await expect(page.getByRole("img", { name: "Sofia Reyes" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("heading", { name: "Presenter setup" })).toBeVisible();
    const repicked = await stored(a.id);
    expect(repicked.avatarId).toBe("stock_3");
    expect(repicked.voiceId).toBe(before.voiceId);
  } finally {
    await page.unroute("**/api/avatars").catch(() => {});
    await page.request.delete(`/api/agents/${a.id}`);
    await page.request.delete(`/api/agents/${b.id}`);
  }
});


test("a saved presenter is duplicated under a new link that starts off, and the copy is its own", async ({ page }) => {
  const tag = Date.now().toString(36);
  const made: string[] = [];
  const agents = async () => (await (await page.request.get("/api/agents")).json()).agents as Array<Record<string, unknown> & { id: string; name: string }>;
  const res = await page.request.post("/api/agents", { data: { name: `Copy me ${tag}`, avatarId: "stock_2", voiceId: "stock_voice_2", instructions: "Answer as the copy source.", greeting: "Hello from the source.", starters: ["Is it copied?"], language: "Spanish", collectEmail: true } });
  const source = (await res.json()).agent as { id: string };
  made.push(source.id);
  try {
    await page.goto("/interactive");
    await page.getByRole("button", { name: `Duplicate Copy me ${tag}` }).click();
    await expect(page.getByTestId("agent-list-note")).toHaveText(`Saved a copy, "Copy me ${tag} (copy)", with its link off. Edit it, then turn its link on to share it.`);
    const copy = (await agents()).find((a) => a.name === `Copy me ${tag} (copy)`)!;
    made.push(copy.id);
    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({ avatarId: "stock_2", voiceId: "stock_voice_2", instructions: "Answer as the copy source.", greeting: "Hello from the source.", starters: ["Is it copied?"], language: "Spanish", collectEmail: true, isPublic: false, conversations: 0, messages: 0 });
    // Its row says the link is off, and its public page is not served until it is turned on; the source's still is.
    await expect(page.getByTestId("agent-list").locator("li", { hasText: `Copy me ${tag} (copy)` })).toContainText("link off");
    expect((await page.request.get(`/api/talk/${copy.id}`)).status()).toBe(404);
    expect((await page.request.get(`/api/talk/${source.id}`)).status()).toBe(200);
    // Editing the copy leaves the source as it was.
    await page.getByRole("button", { name: `Edit Copy me ${tag} (copy)` }).click();
    await expect(page.getByLabel("Instructions")).toHaveValue("Answer as the copy source.");
    await page.getByLabel("Instructions").fill("Answer as the copy.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("heading", { name: "Presenter setup" })).toBeVisible();
    const after = await agents();
    expect(after.find((a) => a.id === copy.id)!.instructions).toBe("Answer as the copy.");
    expect(after.find((a) => a.id === source.id)!.instructions).toBe("Answer as the copy source.");
    // A second copy counts on.
    await page.getByRole("button", { name: `Duplicate Copy me ${tag}`, exact: true }).click();
    await expect(page.getByTestId("agent-list-note")).toContainText(`"Copy me ${tag} (copy 2)"`);
    made.push((await agents()).find((a) => a.name === `Copy me ${tag} (copy 2)`)!.id);
  } finally {
    for (const id of made) await page.request.delete(`/api/agents/${id}`);
  }
});

test("a presenter's transcripts can be searched by words or visitor, and narrowed to visits that left an email", async ({ page }) => {
  const tag = Date.now().toString(36);
  const res = await page.request.post("/api/agents", { data: { name: `Transcripts ${tag}`, avatarId: "stock_1", collectEmail: true } });
  const { id } = (await res.json()).agent as { id: string };
  try {
    // A visitor of its own, so the per-client limits on turns and emails are this test's alone.
    const visitor = { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` };
    const talk = async (content: string) => ((await (await page.request.post(`/api/talk/${id}`, { data: { messages: [{ role: "user", content }] }, headers: visitor })).json()) as { conversationId: string }).conversationId;
    const lead = await talk(`Is the lakeside cabin ${tag} still for sale?`);
    await talk("Do you handle rentals downtown?");
    expect((await page.request.post(`/api/talk/${id}/lead`, { data: { conversationId: lead, email: `buyer-${tag}@example.com`, name: "Rowan" }, headers: visitor })).status()).toBe(200);
    await page.goto("/interactive");
    await page.getByRole("button", { name: `Transcripts for Transcripts ${tag}` }).click();
    const list = page.getByTestId("transcript-list").locator("> li");
    await expect(list).toHaveCount(2);
    // Words from any message, then the visitor's email or name.
    const box = page.getByRole("searchbox", { name: `Search conversations with Transcripts ${tag}` });
    await box.fill("LAKESIDE");
    await expect(list).toHaveCount(1);
    await expect(page.getByTestId("list-matches")).toHaveText("1 of 2 conversations");
    await expect(list.first()).toContainText(`buyer-${tag}@example.com`);
    await box.fill("rowan");
    await expect(list).toHaveCount(1);
    await box.fill("no such words");
    await expect(list).toHaveCount(0);
    await expect(page.getByText("Nothing here matches “no such words”.")).toBeVisible();
    // The download holds what the panel shows: every visit with no search, the matches with one.
    const download = page.getByTestId("transcripts").getByRole("link", { name: /^Download/ });
    const csvOf = async () => parseCsv(await (await page.request.get((await download.getAttribute("href"))!)).text()).rows;
    await box.fill("LAKESIDE");
    await expect(download).toHaveText("Download matches (CSV)");
    await expect(download).toHaveAttribute("href", /q=LAKESIDE/);
    const matched = await csvOf();
    expect(matched.map((r) => r.email)).toEqual([`buyer-${tag}@example.com`]);
    await box.fill("");
    await expect(list).toHaveCount(2);
    await expect(download).toHaveText("Download CSV");
    await expect(download).not.toHaveAttribute("href", /q=/);
    expect(await csvOf()).toHaveLength(2);
    // 200 UTF-16 units is the most a search may be.
    const csv = (q: string) => page.request.get(`/api/agents/${id}/conversations?${new URLSearchParams({ format: "csv", q })}`);
    expect((await csv("x".repeat(200))).status()).toBe(200);
    expect((await csv("x".repeat(201))).status()).toBe(400);
    // Only the visit that left an email.
    const leads = page.getByRole("checkbox", { name: "Only visits that left an email (1)" });
    await leads.check();
    await expect(list).toHaveCount(1);
    await expect(list.first()).toContainText("Rowan");
    // With it on, a search counts only what it leaves: the rentals visit left no email, so it is no match here.
    await box.fill("rentals");
    await expect(list).toHaveCount(0);
    await expect(page.getByTestId("list-matches")).toHaveText("0 of 1 visits that left an email");
    await expect(download).toHaveAttribute("href", /leads=1/);
    expect(await csvOf()).toHaveLength(0);
    // Opening the panel again starts with the whole list, the search and the box cleared.
    await page.getByTestId("transcripts").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: `Transcripts for Transcripts ${tag}` }).click();
    await expect(list).toHaveCount(2);
    await expect(box).toHaveValue("");
    await expect(page.getByRole("checkbox", { name: /^Only visits that left an email/ })).not.toBeChecked();
  } finally {
    await page.request.delete(`/api/agents/${id}`);
  }
});

test("the questions visitors most often open with are listed with their counts, and picking one lists just those visits", async ({ page }) => {
  const tag = Date.now().toString(36);
  const res = await page.request.post("/api/agents", { data: { name: `Most asked ${tag}`, avatarId: "stock_1" } });
  const { id } = (await res.json()).agent as { id: string };
  try {
    const headers = { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` };
    const ids: string[] = [];
    for (const first of [`Hours for ${tag}?`, `hours for ${tag}`, "Do you take walk-ins?", `HOURS FOR ${tag}?!`, "Only once?"]) {
      const turn = await page.request.post(`/api/talk/${id}`, { data: { messages: [{ role: "user", content: first }] }, headers });
      expect(turn.status()).toBe(200);
      ids.push((await turn.json()).conversationId);
    }
    // Only the walk-ins visit leaves an email.
    expect((await page.request.post(`/api/talk/${id}/lead`, { data: { conversationId: ids[2], email: `walkin-${tag}@example.com` }, headers })).status()).toBe(200);
    await page.goto("/interactive");
    await page.getByRole("button", { name: `Transcripts for Most asked ${tag}` }).click();
    const top = page.getByTestId("most-asked").getByRole("button");
    // Asked once is left out; the newest wording stands for each.
    await expect(top).toHaveCount(1);
    await expect(top.first()).toHaveText(`HOURS FOR ${tag}?! · 3 visits`);
    // Picking it lists exactly the visits it counts, and the download holds the same ones.
    await top.first().click();
    await expect(top.first()).toHaveAttribute("aria-pressed", "true");
    const list = page.getByTestId("transcript-list").locator("> li");
    await expect(list).toHaveCount(3);
    await expect(page.getByTestId("most-asked").getByRole("status")).toContainText(`Listing the visits that opened with “HOURS FOR ${tag}?!”`);
    const download = page.getByTestId("transcripts").getByRole("link", { name: "Download matches (CSV)" });
    await expect(download).toHaveAttribute("href", /first=/);
    expect(parseCsv(await (await page.request.get((await download.getAttribute("href"))!)).text()).rows).toHaveLength(3);
    // The email box leaves none of them: the picked question stays on show, at its count there, so it can be unpicked.
    await page.getByLabel("Only visits that left an email (1)").check();
    await expect(list).toHaveCount(0);
    await expect(top.first()).toHaveText(`HOURS FOR ${tag}?! · 0 visits`);
    await expect(page.getByTestId("most-asked").getByRole("status")).toContainText(": none here.");
    await expect(download).toHaveAttribute("href", /leads=1.*first=|first=.*leads=1/);
    expect(parseCsv(await (await page.request.get((await download.getAttribute("href"))!)).text()).rows).toHaveLength(0);
    // Showing all with the box still ticked leaves no question to list, so the focus goes to the box, not the page.
    await page.getByTestId("most-asked").getByRole("button", { name: "Show all" }).click();
    await expect(page.getByTestId("most-asked")).toHaveCount(0);
    await expect(page.getByLabel("Only visits that left an email (1)")).toBeFocused();
    await page.getByLabel("Only visits that left an email (1)").uncheck();
    await expect(list).toHaveCount(5);
    await expect(top.first()).toHaveAttribute("aria-pressed", "false");
    // Picked again and shown all, the focus goes back to the list of questions.
    await top.first().click();
    await expect(list).toHaveCount(3);
    await page.getByTestId("most-asked").getByRole("button", { name: "Show all" }).click();
    await expect(list).toHaveCount(5);
    await expect(page.getByRole("heading", { name: "Most asked first questions" })).toBeFocused();
  } finally {
    await page.request.delete(`/api/agents/${id}`);
  }
});

test("one visit's transcript can be deleted, leaving the others and the visit count", async ({ page }) => {
  const tag = Date.now().toString(36);
  const res = await page.request.post("/api/agents", { data: { name: `Delete one ${tag}`, avatarId: "stock_1" } });
  const { id } = (await res.json()).agent as { id: string };
  try {
    const headers = { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` };
    for (const content of [`Keep this ${tag}`, `Remove this ${tag}`]) {
      expect((await page.request.post(`/api/talk/${id}`, { data: { messages: [{ role: "user", content }] }, headers })).status()).toBe(200);
    }
    await page.goto("/interactive");
    await page.getByRole("button", { name: `Transcripts for Delete one ${tag}` }).click();
    const list = page.getByTestId("transcript-list").locator("> li");
    await expect(list).toHaveCount(2);
    const doomed = list.filter({ hasText: `Remove this ${tag}` });
    await doomed.locator("summary").click();
    // Asked first; dismissing keeps it.
    const button = doomed.getByRole("button", { name: /^Delete this conversation from / });
    page.once("dialog", (d) => d.dismiss());
    await button.click();
    await expect(list).toHaveCount(2);
    expect(((await (await page.request.get(`/api/agents/${id}/conversations`)).json()).conversations as unknown[]).length).toBe(2);
    page.once("dialog", (d) => d.accept());
    await button.click();
    await expect(list).toHaveCount(1);
    await expect(list.first()).toContainText(`Keep this ${tag}`);
    await expect(page.getByRole("heading", { name: `Conversations with Delete one ${tag}` })).toBeFocused();
    const kept = (await (await page.request.get(`/api/agents/${id}/conversations`)).json()).conversations as Array<{ id: string }>;
    expect(kept).toHaveLength(1);
    // A visit it does not have is not deleted; a presenter that is not there is a 404.
    expect(await (await page.request.delete(`/api/agents/${id}/conversations/conv_nope`)).json()).toEqual({ deleted: false });
    expect((await page.request.delete(`/api/agents/agent_nope/conversations/${kept[0].id}`)).status()).toBe(404);
    const agent = ((await (await page.request.get("/api/agents")).json()).agents as Array<{ id: string; conversations: number }>).find((a) => a.id === id)!;
    expect(agent.conversations).toBe(2);
  } finally {
    await page.request.delete(`/api/agents/${id}`);
  }
});

test("one visit's transcript downloads as a text file with the visitor's details and each message", async ({ page }) => {
  const tag = Date.now().toString(36);
  const res = await page.request.post("/api/agents", { data: { name: `Export ${tag}`, avatarId: "stock_1", collectEmail: true } });
  const { id } = (await res.json()).agent as { id: string };
  try {
    const headers = { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` };
    const turn = await page.request.post(`/api/talk/${id}`, { data: { messages: [{ role: "user", content: `Is the cabin ${tag} for sale?` }] }, headers });
    const { conversationId, reply } = (await turn.json()) as { conversationId: string; reply: string };
    expect((await page.request.post(`/api/talk/${id}/lead`, { data: { conversationId, email: `export-${tag}@example.com`, name: "Rowan" }, headers })).status()).toBe(200);
    await page.goto("/interactive");
    await page.getByRole("button", { name: `Transcripts for Export ${tag}` }).click();
    const visit = page.getByTestId("transcript-list").locator("> li").first();
    await visit.locator("summary").click();
    const link = visit.getByRole("link", { name: /^Download \(\.txt\)/ });
    const download = await page.request.get((await link.getAttribute("href"))!);
    expect(download.headers()["content-type"]).toContain("text/plain");
    expect(download.headers()["content-disposition"]).toMatch(new RegExp(`^attachment; filename="conversation-export-${tag}-\\d{4}-\\d{2}-\\d{2}\\.txt"; filename\\*=UTF-8''conversation-Export%20${tag}-`));
    const text = await download.text();
    expect(text.split("\n").slice(0, 5).map((l) => l.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/, "T"))).toEqual([
      `Conversation with Export ${tag}`,
      "Started: T",
      "Last message: T",
      "Visitor name: Rowan",
      `Visitor email: export-${tag}@example.com`,
    ]);
    expect(text).toContain(`] Visitor: Is the cabin ${tag} for sale?`);
    // The reply is cut into indented lines of at most 76 characters; folded back, it reads as sent.
    expect(text).toContain(`] Presenter: `);
    // Continuation lines open with four spaces and a left-to-right mark, which takes no column.
    const lines = text.split("\n").map((l) => l.replace("\u200E", ""));
    expect(lines.every((l) => Array.from(l).length <= 76)).toBe(true);
    const replyAt = lines.findIndex((l) => l.includes(`] Presenter: `));
    const folded = [lines[replyAt].split(`] Presenter: `)[1], ...lines.slice(replyAt + 1).filter((l) => l.startsWith("    ")).map((l) => l.trim())].join(" ");
    expect(folded.replace(/\s+/g, " ")).toBe(reply.replace(/\s+/g, " ").trim());
    // A name that breaks lines is refused, so it cannot pass for another line of the file.
    expect((await page.request.post(`/api/talk/${id}/lead`, { data: { conversationId, email: `export-${tag}@example.com`, name: "Rowan\nStarted: never" }, headers })).status()).toBe(400);
    // The same visit as JSON, and nothing for a visit the presenter does not have.
    const json = (await (await page.request.get(`/api/agents/${id}/conversations/${conversationId}`)).json()).conversation as { id: string };
    expect(json.id).toBe(conversationId);
    expect((await page.request.get(`/api/agents/${id}/conversations/conv_nope?format=txt`)).status()).toBe(404);
  } finally {
    await page.request.delete(`/api/agents/${id}`);
  }
});

test("a shared presenter's row shows its visits per day for the last two weeks", async ({ page }) => {
  const tag = Date.now().toString(36);
  const res = await page.request.post("/api/agents", { data: { name: `Visits ${tag}`, avatarId: "stock_1" } });
  const { id } = (await res.json()).agent as { id: string };
  try {
    const headers = { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` };
    const first = (await (await page.request.post(`/api/talk/${id}`, { data: { messages: [{ role: "user", content: "Hi" }] }, headers })).json()) as { conversationId: string };
    // A continued visit is not a new one; a second visitor is.
    await page.request.post(`/api/talk/${id}`, { data: { conversationId: first.conversationId, messages: [{ role: "user", content: "And?" }] }, headers });
    await page.request.post(`/api/talk/${id}`, { data: { messages: [{ role: "user", content: "Hello" }] }, headers });
    // Deleting a transcript keeps the visit counted.
    await page.request.delete(`/api/agents/${id}/conversations/${first.conversationId}`);
    await page.goto("/interactive");
    const row = page.getByTestId("agent-list").locator("li", { hasText: `Visits ${tag}` });
    const visits = row.getByTestId("visits-by-day");
    await expect(visits).toHaveAttribute("data-total", "2");
    await expect(visits).toContainText("2 in 14 days");
    await expect(visits.getByRole("img", { name: "Visits per day for the last 14 days, 2 in total" })).toBeVisible();
  } finally {
    await page.request.delete(`/api/agents/${id}`);
  }
});

test("a visit can be marked followed up, listed apart, and carried in the download", async ({ page }) => {
  const tag = Date.now().toString(36);
  const res = await page.request.post("/api/agents", { data: { name: `Follow up ${tag}`, avatarId: "stock_1" } });
  const { id } = (await res.json()).agent as { id: string };
  try {
    const headers = { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` };
    for (const content of [`Call me ${tag}`, `Just looking ${tag}`]) {
      expect((await page.request.post(`/api/talk/${id}`, { data: { messages: [{ role: "user", content }] }, headers })).status()).toBe(200);
    }
    await page.goto("/interactive");
    await page.getByRole("button", { name: `Transcripts for Follow up ${tag}` }).click();
    const list = page.getByTestId("transcript-list").locator("> li");
    await expect(list).toHaveCount(2);
    const call = list.filter({ hasText: `Call me ${tag}` });
    await call.locator("summary").click();
    await call.getByRole("checkbox", { name: /^Followed up/ }).check();
    await expect(call.locator("summary")).toContainText("followed up");
    // The mark does not move the visit, and the box lists the rest.
    await expect(list.nth(1)).toContainText(`Call me ${tag}`);
    await page.getByLabel("Only visits not followed up (1)").check();
    await expect(list).toHaveCount(1);
    await expect(list.first()).toContainText(`Just looking ${tag}`);
    const download = page.getByTestId("transcripts").getByRole("link", { name: "Download matches (CSV)" });
    await expect(download).toHaveAttribute("href", /pending=1/);
    const pending = parseCsv(await (await page.request.get((await download.getAttribute("href"))!)).text());
    expect(pending.rows).toHaveLength(1);
    const all = parseCsv(await (await page.request.get(`/api/agents/${id}/conversations?format=csv`)).text());
    expect(all.columns).toContain("followed_up");
    expect(all.rows.find((r) => r.first_question === `Call me ${tag}`)!.followed_up).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(all.rows.find((r) => r.first_question === `Just looking ${tag}`)!.followed_up).toBe("");
    // Marked with the box on, a visit stays in view, its box keeping the focus, until the box changes.
    const looking = list.filter({ hasText: `Just looking ${tag}` });
    await looking.locator("summary").click();
    const lookingBox = looking.getByRole("checkbox", { name: /^Followed up/ });
    await lookingBox.focus();
    await page.keyboard.press("Space");
    await expect(lookingBox).toBeChecked();
    await expect(list).toHaveCount(1);
    await expect(lookingBox).toBeFocused();
    await expect(lookingBox).toHaveAccessibleName(/, conversation from /);
    // A search's count names a visit kept in view for what it is.
    const search = page.getByLabel(`Search conversations with Follow up ${tag}`);
    await search.fill(tag);
    await expect(page.getByTestId("transcripts")).toContainText("1 of 1 visits that were not followed up when the box was ticked");
    await search.fill("");
    await expect(lookingBox).toBeChecked();
    await expect.poll(async () => parseCsv(await (await page.request.get(`/api/agents/${id}/conversations?format=csv&pending=1`)).text()).rows.length).toBe(0);
    // Cleared again; the box stays usable (and focused) with nothing left to follow up.
    const pendingBox = page.getByLabel("Only visits not followed up (0)");
    await pendingBox.focus();
    await page.keyboard.press("Space");
    await expect(pendingBox).not.toBeChecked();
    await expect(pendingBox).toBeFocused();
    // Hidden by the box and shown again, the visit opens closed.
    await expect(call.locator("details")).not.toHaveAttribute("open", /.*/);
    await call.locator("summary").click();
    await call.getByRole("checkbox", { name: /^Followed up/ }).uncheck();
    await expect(call.locator("summary")).not.toContainText("followed up");
    // A second click while the first is saving is shown at once and sent after it, so the last click wins.
    await page.route(`**/api/agents/${id}/conversations/*`, async (route) => {
      if (route.request().method() === "PATCH") await new Promise((r) => setTimeout(r, 400));
      await route.continue();
    });
    const callBox = call.getByRole("checkbox", { name: /^Followed up/ });
    await callBox.check();
    await expect(callBox).toHaveAttribute("aria-busy", "true");
    await callBox.uncheck();
    await expect(callBox).toHaveAttribute("aria-busy", "false");
    await expect(callBox).not.toBeChecked();
    const after = parseCsv(await (await page.request.get(`/api/agents/${id}/conversations?format=csv`)).text());
    expect(after.rows.find((r) => r.first_question === `Call me ${tag}`)!.followed_up).toBe("");
    expect((await page.request.patch(`/api/agents/${id}/conversations/conv_nope`, { data: { followedUp: true } })).status()).toBe(404);
    expect((await page.request.patch(`/api/agents/${id}/conversations/conv_nope`, { data: { followedUp: "yes" } })).status()).toBe(400);
  } finally {
    await page.request.delete(`/api/agents/${id}`);
  }
});

test("a presenter's daily reply limit stops visitor replies for the day and shows on its row", async ({ page }) => {
  const tag = Date.now().toString(36);
  let id = "";
  try {
    await page.goto("/interactive");
    await page.getByLabel("Agent name").fill(`Capped ${tag}`);
    // Not a whole number from 1 to 10,000: said under the field and not saved.
    await page.getByLabel("Daily reply limit").fill("0");
    await expect(page.getByText("A whole number from 1 to 10,000, or empty for no limit.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save and get link" }).click();
    await expect(page.getByText("The daily reply limit is a whole number from 1 to 10,000")).toBeVisible();
    await page.getByLabel("Daily reply limit").fill("1e3");
    await expect(page.getByText("A whole number from 1 to 10,000, or empty for no limit.", { exact: true })).toBeVisible();
    await page.getByLabel("Daily reply limit").fill("1");
    await page.getByRole("button", { name: "Save and get link" }).click();
    const link = (await page.getByTestId("agent-link").locator("code").innerText()).trim();
    id = link.split("/talk/")[1];
    const row = page.getByTestId("agent-list").locator("li", { hasText: `Capped ${tag}` });
    await expect(row.getByTestId("replies-today")).toHaveText(" · 0 of 1 replies today");
    // The visitor gets one reply, then is asked to come back tomorrow.
    await page.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` });
    await page.goto(`/talk/${id}`);
    await page.getByLabel("Your message").fill("First question");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("[data-testid=chat-log] [data-role=assistant]")).toHaveCount(1);
    await page.getByLabel("Your message").fill("Second question");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(`Capped ${tag} can't answer any more questions for now. Please try again later.`)).toBeVisible();
    expect((await page.request.post(`/api/talk/${id}`, { data: { messages: [{ role: "user", content: "Again?" }] } })).status()).toBe(429);
    // No live video session is opened for a presenter at its limit.
    expect(await (await page.request.post(`/api/talk/${id}/live`)).json()).toEqual({ available: false });
    // The owner sees the count, and the limit loads into the form; cleared, it goes.
    await page.goto("/interactive");
    await expect(row.getByTestId("replies-today")).toHaveText(" · 1 of 1 replies today");
    await page.getByRole("button", { name: `Edit Capped ${tag}` }).click();
    await expect(page.getByLabel("Daily reply limit")).toHaveValue("1");
    await page.getByLabel("Daily reply limit").fill("");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(row.getByTestId("replies-today")).toHaveCount(0);
    expect((await page.request.patch(`/api/agents/${id}`, { data: { dailyReplyLimit: 0 } })).status()).toBe(400);
  } finally {
    if (id) await page.request.delete(`/api/agents/${id}`);
  }
});

test("a presenter kept to some websites is framed and launched only on those", async ({ page }) => {
  const tag = Date.now().toString(36);
  let id = "";
  // A customer's site on its own loopback server: Chrome lets a page there load the studio's script and frames, which it
  // refuses a routed page. The same server is two sites, 127.0.0.1 (allowed) and localhost (not).
  const site = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const label = url.searchParams.get("label") ?? "Ask";
    const byHand = url.searchParams.has("frame") ? `<iframe title="By hand" src="http://localhost:3100/talk/${id}?embed=1"></iframe>` : "";
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><body><h1>Acme Realty</h1>${byHand}<script src="http://localhost:3100/embed/agent.js?id=${id}&label=${encodeURIComponent(label)}"></script></body></html>`);
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const port = (site.address() as AddressInfo).port;
  try {
    await page.goto("/interactive");
    await page.getByLabel("Agent name").fill(`Fenced ${tag}`);
    // Something that is not a site is said under the field and not saved.
    await page.getByLabel("Allowed websites").fill("acme.example\njavascript:alert(1)");
    await expect(page.getByText('"javascript:alert(1)" is not a website address, such as example.com.', { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save and get link" }).click();
    await expect(page.getByText("Allowed websites: ")).toBeVisible();
    await page.getByLabel("Allowed websites").fill(`http://127.0.0.1:${port}/listings`);
    await page.getByRole("button", { name: "Save and get link" }).click();
    const link = (await page.getByTestId("agent-link").locator("code").innerText()).trim();
    id = link.split("/talk/")[1];
    const row = page.getByTestId("agent-list").locator("li", { hasText: `Fenced ${tag}` });
    await row.getByRole("button", { name: `Embed code for Fenced ${tag}`, exact: true }).click();
    await expect(row.getByTestId("embed-sites")).toHaveText(`Shows only on http://127.0.0.1:${port}; change the allowed websites with Edit.`);
    // The talk page may be framed by the studio and that site only.
    const talk = await page.request.get(`/talk/${id}`);
    expect(talk.headers()["content-security-policy"]).toBe(`frame-ancestors 'self' http://127.0.0.1:${port}`);

    // On the allowed site the launcher appears and opens the chat.
    await page.goto(`http://127.0.0.1:${port}/?label=Ask%20Fenced`);
    await page.getByRole("button", { name: "Ask Fenced" }).click();
    await expect(page.frameLocator("iframe[title='Chat with our presenter']").getByTestId("talk-name")).toContainText(`Fenced ${tag}`);

    // Anywhere else the launcher stays away, and a frame made by hand is refused by the browser.
    const warned = page.waitForEvent("console", (m) => m.text().includes(`this presenter is not set up for http://localhost:${port}`));
    await page.goto(`http://localhost:${port}/?label=Ask%20Other&frame=1`);
    await warned;
    await expect(page.getByRole("button", { name: "Ask Other" })).toHaveCount(0);
    // The browser shows its error page in the frame instead of the talk page.
    await expect.poll(() => page.frames().map((f) => f.url())).toContain("chrome-error://chromewebdata/");
    await expect(page.frameLocator("iframe[title='By hand']").getByTestId("talk-name")).toHaveCount(0);

    // Cleared, the presenter can be embedded anywhere again.
    await page.goto("/interactive");
    await page.getByRole("button", { name: `Edit Fenced ${tag}` }).click();
    await expect(page.getByLabel("Allowed websites")).toHaveValue(`http://127.0.0.1:${port}`);
    await page.getByLabel("Allowed websites").fill("");
    await page.getByRole("button", { name: "Save changes" }).click();
    await row.getByRole("button", { name: `Embed code for Fenced ${tag}`, exact: true }).click();
    await expect(row.getByTestId("embed-sites")).toHaveText("Works on any website; set allowed websites with Edit to keep it to yours.");
    expect((await page.request.get(`/talk/${id}`)).headers()["content-security-policy"]).toBeUndefined();
    await page.goto(`http://localhost:${port}/?label=Ask%20Anywhere&frame=1`);
    await expect(page.getByRole("button", { name: "Ask Anywhere" })).toBeVisible();
    await expect(page.frameLocator("iframe[title='By hand']").getByTestId("talk-name")).toContainText(`Fenced ${tag}`);
    expect((await page.request.patch(`/api/agents/${id}`, { data: { allowedSites: ["ftp://example.com"] } })).status()).toBe(400);
  } finally {
    site.close();
    if (id) await page.request.delete(`/api/agents/${id}`);
  }
});

test("a visitor downloads their own conversation, without the owner's note or mark", async ({ page }) => {
  const tag = Date.now().toString(36);
  const res = await page.request.post("/api/agents", { data: { name: `Kept ${tag}`, avatarId: "stock_1" } });
  const { id } = (await res.json()).agent as { id: string };
  try {
    await page.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` });
    await page.goto(`/talk/${id}`);
    // Nothing to download before the first reply.
    await expect(page.getByRole("button", { name: "Download this conversation" })).toHaveCount(0);
    await page.getByLabel("Your message").fill("When are the open houses?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("[data-testid=chat-log] [data-role=assistant]")).toHaveCount(1);
    // The owner marks and notes the visit; the visitor's copy leaves both out.
    const { conversations } = (await (await page.request.get(`/api/agents/${id}/conversations`)).json()) as { conversations: { id: string }[] };
    expect((await page.request.patch(`/api/agents/${id}/conversations/${conversations[0].id}`, { data: { followedUp: true, note: `Private ${tag}` } })).ok()).toBe(true);
    const saved = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download this conversation" }).click();
    const download = await saved;
    expect(download.suggestedFilename()).toMatch(new RegExp(`^conversation-Kept ${tag}-\\d{4}-\\d{2}-\\d{2}\\.txt$`));
    const text = await readFile((await download.path())!, "utf8");
    expect(text).toContain(`Conversation with Kept ${tag}`);
    expect(text).toMatch(/\] Visitor: When are the open houses\?$/m);
    expect(text).not.toContain(`Private ${tag}`);
    expect(text).not.toMatch(/^(Followed up|Note):/m);
    // A visit that is not one, or no visit, gets nothing.
    expect((await page.request.post(`/api/talk/${id}/transcript`, { data: { conversationId: "conv_nosuch" } })).status()).toBe(404);
    expect((await page.request.post(`/api/talk/${id}/transcript`, { data: {} })).status()).toBe(400);
    // Starting over leaves nothing to download until the next reply.
    await page.getByRole("button", { name: "Start over" }).click();
    await expect(page.getByRole("button", { name: "Download this conversation" })).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/agents/${id}`);
  }
});

test("a visitor rates the presenter's replies, and the owner sees the ratings in the transcripts and downloads", async ({ page }) => {
  const tag = Date.now().toString(36);
  const res = await page.request.post("/api/agents", { data: { name: `Rated ${tag}`, avatarId: "stock_1" } });
  const { id } = (await res.json()).agent as { id: string };
  try {
    // The studio's try-it chat has nothing to rate.
    await page.goto("/interactive");
    await page.getByLabel("Your message").fill("Hi there");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("[data-testid=chat-log] [data-role=assistant]")).toHaveCount(1);
    await expect(page.getByRole("group", { name: "Rate this reply" })).toHaveCount(0);
    // On the talk page, each reply after the greeting can be rated, changed, and taken back.
    await page.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` });
    await page.goto(`/talk/${id}`);
    await page.getByLabel("Your message").fill(`Hours ${tag}`);
    await page.getByRole("button", { name: "Send" }).click();
    const ratings = page.getByRole("group", { name: "Rate this reply" });
    await expect(ratings).toHaveCount(1);
    // The first reply's thumbs; a second reply below brings its own.
    const helpful = ratings.first().getByRole("button", { name: "Helpful", exact: true });
    const unhelpful = ratings.first().getByRole("button", { name: "Not helpful" });
    await unhelpful.click();
    await expect(unhelpful).toHaveAttribute("aria-pressed", "true");
    await helpful.click();
    await expect(helpful).toHaveAttribute("aria-pressed", "true");
    await expect(unhelpful).toHaveAttribute("aria-pressed", "false");
    // A rating made while the next reply is on its way stays on the page when that reply lands.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(`**/api/talk/${id}`, async (route) => {
      if (route.request().method() === "POST") await held;
      await route.continue();
    });
    await page.getByLabel("Your message").fill(`Sundays ${tag}`);
    await page.getByRole("button", { name: "Send" }).click();
    await unhelpful.click();
    await expect(unhelpful).toHaveAttribute("aria-pressed", "true");
    release();
    await expect(ratings).toHaveCount(2);
    await expect(unhelpful).toHaveAttribute("aria-pressed", "true");
    await page.unroute(`**/api/talk/${id}`);
    await helpful.click();
    await expect(helpful).toHaveAttribute("aria-pressed", "true");
    const csv = async () => parseCsv(await (await page.request.get(`/api/agents/${id}/conversations?format=csv`)).text()).rows[0];
    await expect.poll(async () => (await csv()).helpful).toBe("1");
    expect((await csv()).not_helpful).toBe("0");
    const [visit] = (await (await page.request.get(`/api/agents/${id}/conversations`)).json()).conversations as Array<{ id: string; messages: Array<{ at: string }> }>;
    expect(await (await page.request.get(`/api/agents/${id}/conversations/${visit.id}?format=txt`)).text()).toMatch(/\] Presenter \(rated helpful\): /);
    // The owner sees it on the reply and in the panel's count.
    await page.goto("/interactive");
    await page.getByRole("button", { name: `Transcripts for Rated ${tag}` }).click();
    await expect(page.getByTestId("reply-ratings")).toHaveText("Visitors rated 1 reply helpful and 0 not helpful.");
    const row = page.getByTestId("transcript-list").locator("> li").first();
    await row.locator("summary").click();
    await expect(row.getByText("helpful", { exact: true })).toBeVisible();
    await expect(row.getByText("not helpful", { exact: true })).toHaveCount(0);
    // Taken back on the talk page; a reply not in the visit, or a visit of another presenter, is a 404.
    await page.goto(`/talk/${id}`);
    const headers = { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` };
    expect((await page.request.post(`/api/talk/${id}/rate`, { data: { conversationId: visit.id, at: visit.messages[1].at, rating: null }, headers })).status()).toBe(200);
    await expect.poll(async () => (await csv()).helpful).toBe("0");
    expect((await page.request.post(`/api/talk/${id}/rate`, { data: { conversationId: visit.id, at: "2020-01-01T00:00:00.000Z", rating: "up" }, headers })).status()).toBe(404);
    expect((await page.request.post(`/api/talk/${id}/rate`, { data: { conversationId: visit.id, at: visit.messages[1].at, rating: "meh" }, headers })).status()).toBe(400);
  } finally {
    await page.request.delete(`/api/agents/${id}`);
  }
});

test("a presenter's row says when visits came in since its transcripts were last opened in this browser", async ({ page }) => {
  const tag = Date.now().toString(36);
  const res = await page.request.post("/api/agents", { data: { name: `Fresh ${tag}`, avatarId: "stock_1" } });
  const { id } = (await res.json()).agent as { id: string };
  const headers = { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` };
  const visit = async (content: string, conversationId?: string) => {
    const turn = await page.request.post(`/api/talk/${id}`, { data: { messages: [{ role: "user", content }], ...(conversationId ? { conversationId } : {}) }, headers });
    expect(turn.status()).toBe(200);
    return ((await turn.json()) as { conversationId: string }).conversationId;
  };
  try {
    await page.goto("/interactive");
    const row = page.getByTestId("agent-list").locator("li", { hasText: `Fresh ${tag}` });
    await expect(row).toContainText("0 conversations");
    await expect(row.getByTestId("new-visits")).toHaveCount(0);
    // A visit after this browser first saw the presenter is new until its transcripts are opened.
    const first = await visit(`First ${tag}`);
    await page.reload();
    await expect(row.getByTestId("new-visits")).toHaveText("New visits");
    await page.getByRole("button", { name: `Transcripts for Fresh ${tag}` }).click();
    await expect(page.getByTestId("transcript-list").locator("> li")).toHaveCount(1);
    await expect(row.getByTestId("new-visits")).toHaveCount(0);
    // Remembered across loads; a later visit is new again, while a turn in a visit already seen is not.
    await visit(`More ${tag}`, first);
    await page.reload();
    await expect(row).toContainText("1 conversation · 2 questions");
    await expect(row.getByTestId("new-visits")).toHaveCount(0);
    await visit(`Second ${tag}`);
    await page.reload();
    await expect(row.getByTestId("new-visits")).toBeVisible();
    // With storage blocked after the page loaded, opening the transcripts still clears the badge for this load.
    await page.evaluate(() => Object.defineProperty(window, "localStorage", { get: () => { throw new Error("blocked"); } }));
    await page.getByRole("button", { name: `Transcripts for Fresh ${tag}` }).click();
    await expect(row.getByTestId("new-visits")).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/agents/${id}`);
  }
});

test("a visit keeps a private note, found by the search and carried in both downloads", async ({ page }) => {
  const tag = Date.now().toString(36);
  const res = await page.request.post("/api/agents", { data: { name: `Noted ${tag}`, avatarId: "stock_1" } });
  const { id } = (await res.json()).agent as { id: string };
  try {
    const headers = { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` };
    for (const content of [`Price please ${tag}`, `Hours please ${tag}`]) {
      expect((await page.request.post(`/api/talk/${id}`, { data: { messages: [{ role: "user", content }] }, headers })).status()).toBe(200);
    }
    await page.goto("/interactive");
    await page.getByRole("button", { name: `Transcripts for Noted ${tag}` }).click();
    const list = page.getByTestId("transcript-list").locator("> li");
    await expect(list).toHaveCount(2);
    const price = list.filter({ hasText: `Price please ${tag}` });
    await price.locator("summary").click();
    const note = price.getByRole("textbox", { name: /^Note on the conversation from / });
    const save = price.getByRole("button", { name: "Save note" });
    await expect(save).toBeDisabled();
    await note.fill(`  Called back ${tag}; wants a viewing  `);
    await expect(price).toContainText(`${`  Called back ${tag}; wants a viewing  `.length} / 1000`);
    await save.click();
    await expect(price.locator("summary")).toContainText("note");
    await expect(note).toHaveValue(`Called back ${tag}; wants a viewing`);
    await expect(save).toBeDisabled();
    await expect(note).toBeFocused();
    await expect(price.getByRole("status")).toHaveText("Note saved");
    // The search finds a visit by its note, and the CSV and the text file carry it.
    await page.getByLabel(`Search conversations with Noted ${tag}`).fill("wants a viewing");
    await expect(list).toHaveCount(1);
    await expect(list.first()).toContainText(`Price please ${tag}`);
    const csv = parseCsv(await (await page.request.get(`/api/agents/${id}/conversations?format=csv&q=${encodeURIComponent("wants a viewing")}`)).text());
    expect(csv.rows.map((r) => r.note)).toEqual([`Called back ${tag}; wants a viewing`]);
    const conversations = (await (await page.request.get(`/api/agents/${id}/conversations`)).json()).conversations as Array<{ id: string; note?: string }>;
    const noted = conversations.find((c) => c.note)!;
    expect(await (await page.request.get(`/api/agents/${id}/conversations/${noted.id}?format=txt`)).text()).toContain(`\nNote: Called back ${tag}; wants a viewing\n`);
    // The visitor's own view never shows it.
    expect(JSON.stringify(await (await page.request.get(`/api/talk/${id}`)).json())).not.toContain("Called back");
    // Saved so the search no longer finds it, the visit stays in view, open and focused, until the search changes.
    await note.fill(`Called back ${tag}`);
    await expect(price.getByRole("status")).toHaveText("");
    await save.click();
    await expect(price.getByRole("status")).toHaveText("Note saved");
    await expect(list).toHaveCount(1);
    await expect(note).toBeFocused();
    await page.getByLabel(`Search conversations with Noted ${tag}`).fill("");
    await expect(list).toHaveCount(2);
    // A note that looks like a spreadsheet formula is neutralised in the CSV.
    await note.fill("=HYPERLINK(1)");
    await save.click();
    await expect(price.getByRole("status")).toHaveText("Note saved");
    const formula = parseCsv(await (await page.request.get(`/api/agents/${id}/conversations?format=csv`)).text());
    expect(formula.rows.find((r) => r.first_question === `Price please ${tag}`)!.note).toBe("'=HYPERLINK(1)");
    // Emptied and saved, the note goes; too long or the wrong shape is a 400, and spaces around it do not count.
    await note.fill("");
    await save.click();
    await expect(price.locator("summary")).not.toContainText("note");
    await expect.poll(async () => ((await (await page.request.get(`/api/agents/${id}/conversations/${noted.id}`)).json()).conversation as { note?: string }).note).toBeUndefined();
    expect((await page.request.patch(`/api/agents/${id}/conversations/${noted.id}`, { data: { note: "x".repeat(1001) } })).status()).toBe(400);
    expect((await page.request.patch(`/api/agents/${id}/conversations/${noted.id}`, { data: {} })).status()).toBe(400);
    expect((await page.request.patch(`/api/agents/${id}/conversations/${noted.id}`, { data: { note: null } })).status()).toBe(400);
    const padded = await page.request.patch(`/api/agents/${id}/conversations/${noted.id}`, { data: { note: `  ${"y".repeat(1000)}  ` } });
    expect(padded.status()).toBe(200);
    expect(((await padded.json()).conversation as { note: string }).note).toHaveLength(1000);
  } finally {
    await page.request.delete(`/api/agents/${id}`);
  }
});

test("a presenter answers from reference notes, in the try-it chat and once shared, and they can be cleared", async ({ page }) => {
  const tag = Date.now().toString(36);
  const notes = `Showings for ${tag} run Saturdays, 10am to 2pm.\nThe lakeside cabin is listed at $450,000.`;
  let id = "";
  try {
    await page.goto("/interactive");
    await page.getByLabel("Reference notes").fill(notes);
    await expect(page.locator("#agent-notes-count")).toHaveText(`${notes.length} / 6000`);
    // The try-it chat answers from what is typed, before anything is saved.
    await page.getByLabel("Your message").fill("When are the showings?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("[data-testid=chat-log] [data-role=assistant]").first()).toHaveText(`From my notes: Showings for ${tag} run Saturdays, 10am to 2pm.`);
    await page.getByLabel("Agent name").fill(`Notes ${tag}`);
    await page.getByRole("button", { name: "Save and get link" }).click();
    const link = (await page.getByTestId("agent-link").locator("code").innerText()).trim();
    id = link.split("/talk/")[1];
    const row = page.getByTestId("agent-list").locator("li", { hasText: `Notes ${tag}` });
    await expect(row).toContainText("has notes");
    // Kept server-side: the visitor view never carries them, and a visitor's question is answered from them.
    expect(JSON.stringify(await (await page.request.get(`/api/talk/${id}`)).json())).not.toContain("lakeside");
    const turn = await page.request.post(`/api/talk/${id}`, { data: { messages: [{ role: "user", content: "What is the lakeside cabin listed at?" }] }, headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` } });
    expect((await turn.json()).reply).toBe("From my notes: The lakeside cabin is listed at $450,000.");
    // A saved presenter's notes load into the form; emptying them and saving removes them.
    await expect(page.getByLabel("Reference notes")).toHaveValue("");
    await page.getByRole("button", { name: `Edit Notes ${tag}` }).click();
    await expect(page.getByLabel("Reference notes")).toHaveValue(notes);
    await page.getByLabel("Reference notes").fill("");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("heading", { name: "Presenter setup" })).toBeVisible();
    const saved = ((await (await page.request.get("/api/agents")).json()).agents as Array<{ id: string; notes?: string }>).find((a) => a.id === id)!;
    expect(saved.notes).toBeUndefined();
    await expect(row).not.toContainText("has notes");
    expect((await page.request.post("/api/agents", { data: { name: "Long", avatarId: "stock_1", notes: "x".repeat(6001) } })).status()).toBe(400);
  } finally {
    if (id) await page.request.delete(`/api/agents/${id}`);
  }
});

test("opening questions are suggested from the instructions and notes, and replacing typed ones asks first", async ({ page }) => {
  await page.goto("/interactive");
  const questions = page.getByLabel("Suggested questions");
  const suggest = page.getByRole("button", { name: "Suggest questions" });
  // Nothing to draft from: the button waits for instructions or notes.
  await page.getByLabel("Instructions").fill("");
  await expect(suggest).toBeDisabled();
  await page.getByLabel("Instructions").fill("You represent Maple Realty. Be warm and brief.");
  await page.getByLabel("Reference notes").fill("Showings: Saturdays, 10am to 2pm");
  await suggest.click();
  await expect(questions).toHaveValue("What does Maple Realty do?\nWhat about showings?\nWhat can you help me with?");
  // Replacing questions already there asks first; declining keeps them.
  await questions.fill("My own question?");
  // The confirm holds the click until it is answered, so it is answered from a handler set before the click.
  const asked: string[] = [];
  page.once("dialog", (d) => (asked.push(d.message()), d.dismiss()));
  await suggest.click();
  expect(asked).toEqual(["Replace the suggested questions with new ones?"]);
  await expect(questions).toHaveValue("My own question?");
  page.once("dialog", (d) => (asked.push(d.message()), d.accept()));
  await suggest.click();
  expect(asked).toHaveLength(2);
  await expect(questions).toHaveValue(/^What does Maple Realty do\?/);
  expect((await page.request.post("/api/agents/starters", { data: {} })).status()).toBe(400);
});
test("a presenter can word its replies in the brand kit's writing style, switched on when saved or from its row", async ({ page }) => {
  const before = (await (await page.request.get("/api/brand")).json()).brand as Record<string, unknown> | null;
  const tag = Date.now().toString(36);
  let made: string | undefined;
  try {
    await page.request.put("/api/brand", { data: { name: "Acme", primaryColor: "#0f766e" } });
    await page.goto("/interactive");
    const box = page.getByRole("checkbox", { name: "Word replies in the brand kit's writing style", exact: true });
    await expect(box).not.toBeChecked();
    await expect(page.locator("#agent-brand-style-hint")).toHaveText("The brand kit has no writing style yet; add one on the Brand page and replies follow it.");
    await page.request.put("/api/brand", { data: { name: "Acme", primaryColor: "#0f766e", writingStyle: "Warm and plain." } });
    await page.reload();
    // The demo writer does not follow a style, and the hint says so.
    await expect(page.locator("#agent-brand-style-hint")).toHaveText("The style on the Brand page, as it is at each reply, once Claude writes the replies (the demo writer does not follow it).");
    // The page's own chat sends the switch with its question.
    await box.check();
    const asked = page.waitForRequest((r) => r.url().endsWith("/api/chat") && r.method() === "POST");
    await page.getByLabel("Your message").fill("Hello");
    await page.getByLabel("Your message").press("Enter");
    expect(JSON.parse((await asked).postData() ?? "{}").brandStyle).toBe(true);
    await page.getByLabel("Agent name").fill(`Styled ${tag}`);
    await page.getByRole("button", { name: "Save and get link" }).click();
    made = (await page.getByTestId("agent-link").locator("code").innerText()).trim().split("/talk/")[1];
    const stored = async () => ((await (await page.request.get("/api/agents")).json()).agents as { id: string; brandStyle?: boolean }[]).find((a) => a.id === made)?.brandStyle;
    expect(await stored()).toBe(true);
    // Each saved presenter has its own switch.
    const toggle = page.getByRole("button", { name: `Brand style for Styled ${tag}` });
    await expect(toggle).toHaveText("Brand style on");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(toggle).toHaveText("Brand style off");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(await stored()).toBe(false);
  } finally {
    if (made) await page.request.delete(`/api/agents/${made}`);
    const restored = before ? await page.request.put("/api/brand", { data: before }) : await page.request.delete("/api/brand");
    expect(restored.ok()).toBe(true);
  }
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

    // With `open`, the chat opens by itself after that many seconds, once per tab: not again on the next page.
    expect(await (await page.request.get(`/embed/agent.js?id=${agent.id}&open=999`)).text()).toContain("var autoOpen = 0;");
    // This tab's visitor already opened the chat, so a new tab stands in for a new visit.
    const tab = await page.context().newPage();
    await tab.route("http://localhost:3100/customer-open.html", (route) =>
      route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><h1>Acme Realty</h1><script src="/embed/agent.js?id=${agent.id}&label=Ask%20Dana&open=1"></script></body></html>` }),
    );
    await tab.goto("http://localhost:3100/customer-open.html");
    await expect(tab.getByRole("button", { name: "Close" })).toBeVisible({ timeout: 5000 });
    await expect(tab.locator("iframe[title='Chat with our presenter']")).toBeVisible();
    await expect(tab.locator("iframe[title='Chat with our presenter']")).toHaveAttribute("src", /&auto=1$/);
    await tab.reload();
    await tab.waitForTimeout(1500);
    await expect(tab.getByRole("button", { name: "Ask Dana" })).toBeVisible();
    await expect(tab.locator("iframe[title='Chat with our presenter']")).toBeHidden();
    await tab.close();
    // Where the site blocks storage, a visitor who opened and closed the chat before the timer is not reopened over.
    const blocked = await page.context().newPage();
    await blocked.addInitScript(() => Object.defineProperty(window, "sessionStorage", { get: () => { throw new Error("blocked"); } }));
    await blocked.route("http://localhost:3100/customer-open.html", (route) =>
      route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><h1>Acme Realty</h1><script src="/embed/agent.js?id=${agent.id}&label=Ask%20Dana&open=2"></script></body></html>` }),
    );
    await blocked.goto("http://localhost:3100/customer-open.html");
    await blocked.getByRole("button", { name: "Ask Dana" }).click();
    await blocked.keyboard.press("Escape");
    await blocked.waitForTimeout(2600);
    await expect(blocked.locator("iframe[title='Chat with our presenter']")).toBeHidden();
    await blocked.close();
    // A phone-sized screen never gets the chat opened over the page.
    const phone = await page.context().newPage();
    await phone.setViewportSize({ width: 390, height: 800 });
    await phone.route("http://localhost:3100/customer-open.html", (route) =>
      route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><h1>Acme Realty</h1><script src="/embed/agent.js?id=${agent.id}&label=Ask%20Dana&open=1"></script></body></html>` }),
    );
    await phone.goto("http://localhost:3100/customer-open.html");
    await phone.waitForTimeout(1500);
    await expect(phone.locator("iframe[title='Chat with our presenter']")).toBeHidden();
    await phone.close();

    // The presenter's row builds the snippet from the choices made, carrying only what differs from the defaults.
    await page.goto("/interactive");
    await page.getByRole("button", { name: "Embed code for Embed agent", exact: true }).click();
    const builder = page.getByTestId("embed-builder");
    await expect(builder.getByTestId("embed-snippet")).toHaveText(new RegExp(`/embed/agent\\.js\\?id=${agent.id}(&color=%23[0-9a-f]{6})?" async></script>$`));
    await builder.getByLabel("Side").selectOption("left");
    await builder.getByLabel("Button text").fill("Ask Dana");
    await builder.getByLabel("Opens by itself").selectOption("10");
    await expect(builder).toContainText("Once per visit");
    const snippet = await builder.getByTestId("embed-snippet").innerText();
    expect(snippet).toContain("position=left");
    expect(snippet).toContain("label=Ask+Dana");
    expect(snippet).toContain("open=10");
    await expect(builder.getByRole("button", { name: "Copy embed code for Embed agent" })).toBeVisible();
    await page.getByRole("button", { name: "Embed code for Embed agent", exact: true }).click();
    await expect(builder).toHaveCount(0);
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
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
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
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
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
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
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

test("a scene's name is shown on its tab, kept with the draft, and titles its chapter", async ({ page }) => {
  await page.reload();
  // A video of one scene has no chapters, so there is nothing to name.
  await expect(page.getByLabel(/^Scene( \d+)? name$/)).toHaveCount(0);
  await page.getByRole("textbox", { name: "Script", exact: true }).fill("Welcome to twelve Maple Street.");
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
  await page.getByRole("textbox", { name: "Scene 2 script" }).fill("The kitchen was redone last spring.");
  const name = page.getByLabel("Scene 2 name", { exact: true });
  await name.fill("  The   kitchen ");
  await expect(page.getByRole("button", { name: /^Scene 2, The kitchen, about / })).toBeVisible();
  await expect(page.getByTestId("scene-name-label")).toHaveText("The kitchen");
  // Kept with the draft as typed, and read back with its spaces collapsed.
  await expect.poll(() => page.evaluate(() => localStorage.getItem("avatar-studio:draft") ?? "")).toContain("The   kitchen");
  await page.reload();
  await page.getByRole("button", { name: /^Scene 2, The kitchen,/ }).click();
  await expect(page.getByLabel("Scene 2 name", { exact: true })).toHaveValue("The kitchen");
  await page.getByRole("button", { name: /^Scene 1,/ }).click();
  await expect(page.getByLabel("Scene 1 name", { exact: true })).toHaveValue("");
  // Down to one scene, a named one keeps its field until the name is cleared.
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Remove scene" }).click();
  await expect(page.getByLabel("Scene name", { exact: true })).toHaveValue("The kitchen");
  await page.getByLabel("Scene name", { exact: true }).fill("");
  await expect(page.getByLabel(/^Scene( \d+)? name$/)).toHaveCount(0);
  await page.evaluate(() => localStorage.removeItem("avatar-studio:draft"));

  // A name titles the scene's chapter, before its on-screen text and its words.
  const bg = { type: "color", value: "#0f172a" };
  const v = await createVideoViaApi(page, `Named scenes ${Date.now().toString(36)}`, {
    script: undefined,
    scenes: [
      { name: "Welcome", script: "Welcome to twelve Maple Street, a bright family home on a quiet road.", background: bg, overlay: { text: "12 Maple Street" } },
      { name: "The kitchen", script: "The kitchen was redone last spring with quartz counters and an island.", background: bg },
      { script: "Call Dana to book a showing this weekend.", background: bg },
    ],
  });
  await page.goto(`/videos/${v.id}`);
  const list = page.getByTestId("video-chapters");
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(list.getByRole("listitem").nth(0)).toHaveText("0:00Welcome");
  await expect(list.getByRole("listitem").nth(1)).toHaveText(/^\d+:\d\dThe kitchen$/);
  await expect(list.getByRole("listitem").nth(2)).toContainText("Call Dana to book a showing this weekend.");
});

test("a made video's chapter titles are edited on its page without rendering it again", async ({ page }) => {
  const bg = { type: "color", value: "#0f172a" };
  const v = await createVideoViaApi(page, `Retitle ${Date.now().toString(36)}`, {
    script: undefined,
    scenes: [
      { name: "Welcome", script: "Welcome to twelve Maple Street, a bright family home on a quiet road.", background: bg },
      { script: "The kitchen was redone last spring with quartz counters and an island.", background: bg },
      { script: "Call Dana to book a showing this weekend.", background: bg },
    ],
  });
  await page.goto(`/videos/${v.id}`);
  const list = page.getByTestId("video-chapters");
  await expect(list.getByRole("listitem").nth(1)).toHaveText(/^\d+:\d\dThe kitchen was redone/);
  const edit = page.getByRole("button", { name: "Edit titles" });
  await edit.click();
  const form = page.getByRole("form", { name: "Chapter titles" });
  const field = (n: number) => form.getByLabel(`Scene ${n} title`, { exact: true });
  await expect(field(1)).toBeFocused();
  await expect(field(1)).toHaveValue("Welcome");
  // A field left blank shows what its chapter falls back to, as the chapter list cuts it.
  await expect(field(1)).toHaveAttribute("placeholder", "Welcome to twelve Maple Street, a bright family home on a…");
  await expect(field(2)).toHaveAttribute("placeholder", /^The kitchen was redone/);
  // Escape and Cancel leave everything as it was, the focus back on Edit titles.
  await field(2).fill("Nope");
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  await expect(edit).toBeFocused();
  await edit.click();
  await expect(field(2)).toHaveValue("");
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(edit).toBeFocused();
  await expect(list.getByRole("listitem").nth(1)).toHaveText(/^\d+:\d\dThe kitchen was redone/);
  await edit.click();
  await field(1).fill("");
  await field(2).fill("The kitchen");
  await field(2).press("Enter");
  await expect(form).toHaveCount(0);
  await expect(edit).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "Saved 2 chapter titles." })).toHaveCount(1);
  await expect(list.getByRole("listitem").nth(0)).toHaveText(/^0:00Welcome to twelve Maple Street/);
  await expect(list.getByRole("listitem").nth(1)).toHaveText(/^\d+:\d\dThe kitchen$/);
  const stored = (await (await page.request.get(`/api/videos/${v.id}`)).json()).video as { scenes: Array<{ name?: string }> };
  expect(stored.scenes.map((sc) => sc.name ?? null)).toEqual([null, "The kitchen", null]);
  // Only the scenes named in a request change; one the video does not have is refused.
  const third = await page.request.patch(`/api/videos/${v.id}`, { data: { sceneNames: { "3": "Book a showing" } } });
  expect(third.ok()).toBe(true);
  expect(((await third.json()).video as { scenes: Array<{ name?: string }> }).scenes.map((sc) => sc.name ?? null)).toEqual([null, "The kitchen", "Book a showing"]);
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { sceneNames: { "4": "Nope" } } })).status()).toBe(400);

  // A video with no chapters yet (its second scene is silent) can get them by giving that scene a title.
  const quiet = await createVideoViaApi(page, `Quiet ${Date.now().toString(36)}`, {
    script: undefined,
    scenes: [
      { script: "Welcome to twelve Maple Street, a bright family home on a quiet road.", background: bg },
      { script: "[pause 5s]", background: bg },
    ],
  });
  await page.goto(`/videos/${quiet.id}`);
  await expect(page.getByTestId("chapters-card").getByText(/^No chapters yet/)).toBeVisible();
  await expect(page.getByTestId("video-chapters")).toHaveCount(0);
  await page.getByRole("button", { name: "Edit titles" }).click();
  await expect(field(2)).toHaveAttribute("placeholder", /^No chapter yet/);
  await field(2).fill("A look around");
  await form.getByRole("button", { name: "Save titles" }).click();
  await expect(page.getByTestId("video-chapters").getByRole("listitem")).toHaveCount(2);
  await expect(page.getByTestId("video-chapters").getByRole("listitem").nth(1)).toHaveText(/^\d+:\d\dA look around$/);
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
  // Each chapter copies a share link that starts there; the first one's is the plain link.
  await page.getByTestId("chapter-link").nth(1).click();
  const chapterLink = await page.evaluate(() => navigator.clipboard.readText());
  expect(chapterLink).toMatch(new RegExp(`/share/${v.id}\\?t=\\d+(\\.\\d+)?$`));
  await expect(page.getByText(/^Link to \d+:\d\d copied\.$/)).toBeVisible();
  await page.getByTestId("chapter-link").first().click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/share/${v.id}$`));
  // The same chapters as a WebVTT chapters file, for players and hosts that read one.
  await expect(page.getByRole("link", { name: "Chapters file" })).toHaveAttribute("href", `/api/videos/${v.id}/captions?format=chapters`);
  const file = await page.request.get(`/api/videos/${v.id}/captions?format=chapters`);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toContain("text/vtt");
  expect(file.headers()["content-disposition"]).toMatch(/\.chapters\.vtt"$/);
  const vtt = await file.text();
  expect(vtt).toMatch(/^WEBVTT\n\n1\n00:00:00\.000 --> 00:00:\d\d\.\d{3}\n12 Maple Street\n\n2\n/);
  expect(vtt.match(/ --> /g)).toHaveLength(3);
  expect((await page.request.get(`/api/videos/${v.id}/captions?format=chapters&lang=French`)).status()).toBe(400);
  const single = await createVideoViaApi(page, `One scene ${Date.now().toString(36)}`, { script: "Just the one scene here." });
  expect((await page.request.get(`/api/videos/${single.id}/captions?format=chapters`)).status()).toBe(404);

  await page.goto(`/share/${v.id}`);
  const chapters = page.getByTestId("share-chapters");
  await expect(page.getByRole("heading", { name: "Chapters", exact: true })).toBeVisible();
  // The player carries them as its chapters track too.
  await expect(page.getByTestId("share-player").locator('track[kind="chapters"]')).toHaveAttribute("src", `/api/videos/${v.id}/captions?format=chapters`);
  // It loads (a chapters track left disabled would never be fetched), and the transcript still follows the script.
  await expect
    .poll(() => page.getByTestId("share-player").evaluate((el: HTMLVideoElement) => Array.from(el.textTracks).find((t) => t.kind === "chapters")?.cues?.length ?? 0))
    .toBe(3);
  expect(await page.getByTestId("share-player").evaluate((el: HTMLVideoElement) => Array.from(el.textTracks).find((t) => t.kind === "chapters")?.mode)).not.toBe("disabled");
  await expect(page.getByRole("heading", { name: "Transcript", exact: true })).toBeVisible();
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
  // The chapter's link starts the player inside that chapter, which the list marks as the one playing; opening it
  // without pressing play counts no watch-through. A time past the end, one that is not a time, or a repeated t
  // starts at 0.
  const linkUrl = new URL(chapterLink);
  const at = Number(linkUrl.searchParams.get("t"));
  const watchBefore = (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.watch ?? {};
  await page.goto(`${linkUrl.pathname}${linkUrl.search}`);
  await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThanOrEqual(at - 0.01);
  await expect(chapters.getByRole("button").nth(1)).toHaveAttribute("aria-current", "true");
  await page.waitForTimeout(500);
  expect((await (await page.request.get(`/api/videos/${v.id}`)).json()).video.watch ?? {}).toEqual(watchBefore);
  for (const t of ["1h", "soon", "5&t=6"]) {
    await page.goto(`/share/${v.id}?t=${t}`);
    await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(1);
    expect(await player.evaluate((el: HTMLVideoElement) => el.currentTime)).toBe(0);
  }
  // On a phone the chapter titles are cut with an ellipsis rather than pushing the page sideways.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.reload();
  await expect(chapters.getByRole("button")).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("share-page viewers who play a chapter are counted under it on the video page", async ({ page }) => {
  const bg = { type: "color", value: "#0f172a" };
  const v = await createVideoViaApi(page, `Reach ${Date.now().toString(36)}`, {
    script: undefined,
    scenes: [
      { script: "Welcome to twelve Maple Street, a bright family home on a quiet road.", background: bg },
      { script: "[pause 1s]", background: bg },
      { script: "The kitchen was redone last spring.", background: bg },
      { script: "Call Dana to book a showing.", background: bg },
    ],
  });
  // Nothing is counted before the render completes, and no counts are shown.
  const beacon = (data: unknown) => page.request.post(`/api/videos/${v.id}/watch`, { data });
  expect((await (await beacon({ scene: 0 })).json()).counted).toBe(false);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  // A view with no chapter played yet shows no counts on the video page: views say nothing about chapters.
  await page.goto(`/share/${v.id}`);
  const chapters = page.getByTestId("share-chapters");
  await expect(chapters.getByRole("button")).toHaveCount(3);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.views ?? 0).toBeGreaterThan(0);
  await page.goto(`/videos/${v.id}`);
  await expect(page.getByTestId("video-chapters").getByRole("listitem")).toHaveCount(3);
  await expect(page.getByTestId("chapter-viewers")).toHaveCount(0);
  // Playing a chapter from the share page counts this viewer under the scene it opens. The last one, so the playhead
  // cannot run on into another chapter before the checks below.
  await page.goto(`/share/${v.id}`);
  await chapters.getByRole("button").nth(2).click();
  const reach = async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.chapterViews ?? {};
  await expect.poll(reach, { timeout: 15_000 }).toEqual({ "3": 1 });
  await page.getByTestId("share-player").evaluate((el: HTMLVideoElement) => el.pause());
  // The same viewer again is not counted twice; a silent scene is no chapter; a bad body is a 400; the answer says
  // only whether it counted.
  expect(await (await beacon({ scene: 3 })).json()).toEqual({ counted: false });
  expect((await (await beacon({ scene: 1 })).json()).counted).toBe(false);
  expect((await (await beacon({ scene: 2 })).json()).counted).toBe(true);
  expect((await (await beacon({ scene: 2 })).json()).counted).toBe(false);
  expect((await beacon({ scene: 20 })).status()).toBe(400);
  expect((await beacon({ scene: "x" })).status()).toBe(400);
  expect((await (await page.request.post(`/api/videos/${v.id}/watch`, { data: { scene: 0 }, headers: { "sec-fetch-site": "cross-site" } })).json()).counted).toBe(false);
  // The video page lists each chapter's viewers beside it, and a renamed chapter keeps its count.
  await page.goto(`/videos/${v.id}`);
  const viewers = page.getByTestId("video-chapters").getByTestId("chapter-viewers");
  await expect(viewers).toHaveCount(3);
  await expect(viewers.nth(0)).toHaveText("0 viewers played this chapter");
  await expect(viewers.nth(1)).toHaveText("1 viewer played this chapter");
  await expect(viewers.nth(2)).toHaveText("1 viewer played this chapter");
  await expect(page.getByTestId("chapters-card")).toContainText("Viewers are those who played each chapter on the share page or an embed, once each per 10 minutes (a muted autoplay counts once the sound is on).");
  await page.getByRole("button", { name: "Edit titles" }).click();
  await page.getByLabel("Scene 3 title", { exact: true }).fill("The kitchen");
  await page.getByRole("button", { name: "Save titles" }).click();
  await expect(page.getByTestId("video-chapters").getByRole("listitem").nth(1)).toHaveText(/The kitchen1 viewer played this chapter$/);
});

test("a share-page description is drafted from the script, edited, and saved", async ({ page }) => {
  const bg = { type: "color", value: "#0f172a" };
  const v = await createVideoViaApi(page, `Describe ${Date.now().toString(36)}`, {
    script: undefined,
    scenes: [
      { script: "Welcome to twelve Maple Street. [pause 2s] It's a bright family home.", background: bg },
      { script: "Call Dana to book a showing.", background: bg },
    ],
  });
  await page.goto(`/videos/${v.id}`);
  const field = page.getByLabel("Share page description", { exact: true });
  await expect(field).toHaveValue("");
  // Words typed and not saved are kept unless the editor agrees to replace them.
  await field.fill("My own words.");
  page.once("dialog", (d) => void d.dismiss());
  await page.getByRole("button", { name: "Write it from the script" }).click();
  await expect(field).toHaveValue("My own words.");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Write it from the script" }).click();
  // The draft fills the field, pauses left out, for the editor to read: the focus goes there and nothing is saved yet.
  await expect(field).toHaveValue("Welcome to twelve Maple Street. It's a bright family home. Call Dana to book a showing.");
  await expect(field).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "A draft from the script" })).toBeVisible();
  expect((await (await page.request.get(`/api/videos/${v.id}`)).json()).video.description).toBeUndefined();
  await field.press("End");
  await field.pressSequentially(" Open Saturday.");
  await page.getByRole("button", { name: "Save description" }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.description).toBe(
    "Welcome to twelve Maple Street. It's a bright family home. Call Dana to book a showing. Open Saturday.",
  );
  await expect(page.getByRole("status").filter({ hasText: "A draft from the script" })).toHaveCount(0);
  await page.goto(`/share/${v.id}`);
  await expect(page.getByTestId("share-description")).toHaveText("Welcome to twelve Maple Street. It's a bright family home. Call Dana to book a showing. Open Saturday.");
  // The API drafts for editors only and saves nothing; a video without words of its own is refused.
  const draft = await page.request.post(`/api/videos/${v.id}/describe`);
  expect(draft.status()).toBe(200);
  expect((await draft.json()).description).toContain("Maple Street");
  expect((await page.request.post(`/api/videos/vid_missing/describe`)).status()).toBe(404);
});

test("a video is copied into another language: every scene translated, a voice that speaks it, for the editor to review", async ({ page }) => {
  const bg = { type: "color", value: "#0f172a" };
  const original = `Languages ${Date.now().toString(36)}`;
  const v = await createVideoViaApi(page, original, {
    script: undefined,
    voiceId: "stock_voice_2",
    scenes: [
      { script: "Welcome to twelve Maple Street. [pause 2s] It's a bright home.", background: bg, name: "Welcome", overlay: { text: "Open house Saturday", position: "bottom" } },
      { script: "Call Dana to book a showing.", background: bg },
    ],
  });
  await page.goto(`/videos/${v.id}`);
  await page.getByText("In another language").click();
  const form = page.getByTestId("language-copy");
  await expect(form.getByRole("button", { name: "Open the copy" })).toBeDisabled();
  await form.getByLabel("Language").fill("Spanish");
  await form.getByRole("button", { name: "Open the copy" }).click();
  await expect(page).toHaveURL(new RegExp(`/create\\?from=${v.id}&language=Spanish$`));
  // The copy waits for its translation, then says what to do with it.
  await expect(page.getByTestId("language-copy-note")).toHaveText("Translated into Spanish, on-screen text and scene names too: read each scene before you make it.");
  await expect(page.locator("input[placeholder='Video title']")).toHaveValue(`${original} (Spanish)`);
  // What is made is the translated copy, spoken by the Spanish voice of the same gender; the original is unchanged.
  const made = page.waitForRequest((r) => r.url().endsWith("/api/videos") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate video" }).click();
  const body = (await made).postDataJSON() as { title: string; voiceId: string; scenes: Array<{ script: string; name?: string; overlay?: { text: string; position?: string } }> };
  expect(body.title).toBe(`${original} (Spanish)`);
  expect(body.voiceId).toBe("stock_voice_4");
  expect(body.scenes.map((sc) => sc.script)).toEqual(["[Spanish] Welcome to twelve Maple Street. [pause 2s] It's a bright home.", "[Spanish] Call Dana to book a showing."]);
  // The scene's name and on-screen text are translated with it, the text keeping its place on screen.
  expect(body.scenes[0].name).toBe("[Spanish] Welcome");
  expect(body.scenes[0].overlay).toEqual({ text: "[Spanish] Open house Saturday", position: "bottom" });
  expect(body.scenes[1].name).toBeUndefined();
  const kept = (await (await page.request.get(`/api/videos/${v.id}`)).json()).video;
  expect(kept.scenes[0].script).toBe("Welcome to twelve Maple Street. [pause 2s] It's a bright home.");
  // A language no voice speaks keeps the original voice and says so; one the studio does not know is refused.
  await page.goto(`/create?from=${v.id}&language=Hindi`);
  await expect(page.getByTestId("language-copy-note")).toHaveText(
    "Translated into Hindi, on-screen text and scene names too: read each scene before you make it. None of your voices speaks Hindi, so the voice is the original's; choose one that does.",
  );
  // A copy that cannot be translated is held, with nothing saved for it, and offers the translation again or a plain copy.
  await page.goto(`/create?from=${v.id}&language=Klingonese`);
  const note = page.getByTestId("language-copy-note");
  await expect(note).toContainText('Could not translate the copy into Klingonese: "Klingonese" is not a language the studio knows');
  await expect(page.getByRole("button", { name: "Generate video" })).toBeDisabled();
  // The editor itself is inert, so nothing can be typed into a copy that has not been made.
  await expect(page.locator("div[inert]").locator("input[placeholder='Video title']")).toHaveCount(1);
  await page.reload();
  await expect(note).toContainText("Could not translate the copy into Klingonese", { timeout: 10_000 });
  await note.getByRole("link", { name: "Open a plain copy" }).click();
  await expect(page).toHaveURL(new RegExp(`/create\\?from=${v.id}$`));
  await expect(page.locator("input[placeholder='Video title']")).toHaveValue(`${original} (copy)`);
  await expect(page.getByTestId("language-copy-note")).toHaveCount(0);
  await expect(page.locator("div[inert]")).toHaveCount(0);
  expect((await page.request.post(`/api/videos/${v.id}/language-copy`, { data: { language: "Spanish", extra: 1 } })).status()).toBe(400);
  expect((await page.request.post(`/api/videos/vid_missing/language-copy`, { data: { language: "Spanish" } })).status()).toBe(404);
});

test("share views count where they play: on the share page or in an embed on another site", async ({ page }) => {
  const v = await createVideoViaApi(page, `Places ${Date.now().toString(36)}`);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  const counts = async () => {
    const { video } = await (await page.request.get(`/api/videos/${v.id}`)).json();
    return [video.views ?? 0, video.embedViews ?? 0];
  };
  // Each visit comes from its own viewer, as a viewer's repeat within ten minutes is not counted.
  const viewer = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
  await page.setExtraHTTPHeaders({ "x-forwarded-for": viewer });
  // A page elsewhere embeds the player, as the Embed snippet or an oEmbed consumer does.
  await page.setContent(`<iframe src="http://localhost:3100/share/${v.id}?embed=1" width="480" height="480"></iframe>`);
  await expect(page.frameLocator("iframe").locator("video")).toBeVisible();
  await expect.poll(counts).toEqual([1, 1]);
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}` });
  await page.goto(`/share/${v.id}`);
  await expect(page.locator("video")).toBeVisible();
  await expect.poll(counts).toEqual([2, 1]);
  await page.setExtraHTTPHeaders({});
  await page.goto(`/videos/${v.id}`);
  await expect(page.getByTestId("embed-views")).toHaveText("· , of which 1 in embeds");
  await expect(page.getByTestId("embed-views").locator("[aria-hidden]")).toHaveText("· ");
  // The beacon refuses only a place that is neither; a body that is not JSON is a share-page view, as an older page sends.
  expect((await page.request.post(`/api/videos/${v.id}/view`, { data: { place: "email" } })).status()).toBe(400);
  expect((await page.request.post(`/api/videos/${v.id}/view`, { data: "not json", headers: { "content-type": "application/json" } })).status()).toBe(200);
  expect((await page.request.post(`/api/videos/${v.id}/view`)).status()).toBe(200);
  // The analytics file carries the embedded share of the views.
  const row = parseCsv(await (await page.request.get("/api/videos/analytics")).text()).rows.find((r) => r.id === v.id)!;
  expect(row.embed_views).toBe("1");
});

test("titles suggested from the script fill the title field, and one is saved as a rename", async ({ page }) => {
  const bg = { type: "color", value: "#0f172a" };
  const original = `Titles ${Date.now().toString(36)}`;
  const v = await createVideoViaApi(page, original, {
    script: undefined,
    scenes: [
      { script: "Welcome to twelve Maple Street. [pause 2s] It's a bright family home.", background: bg },
      { script: "Call Dana to book a showing.", background: bg },
    ],
  });
  await page.goto(`/videos/${v.id}`);
  const suggest = page.getByRole("button", { name: "Suggest titles" });
  // The button sits beside the page's actions, not in the heading, whose name stays the title.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(original);
  await suggest.click();
  // The demo writer offers the script's first three sentences, pauses left out; the focus goes to the first.
  const ideas = page.getByTestId("title-ideas").getByRole("listitem");
  await expect(ideas).toHaveText(["Welcome to twelve Maple Street", "It's a bright family home", "Call Dana to book a showing"]);
  await expect(ideas.first().getByRole("button")).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "3 titles suggested from the script" })).toBeAttached();
  expect((await (await page.request.get(`/api/videos/${v.id}`)).json()).video.title).toBe(original);
  // Dismiss puts the focus back on the button; asking again offers them again.
  await page.getByTestId("title-ideas").getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByTestId("title-ideas")).toHaveCount(0);
  await expect(suggest).toBeFocused();
  await suggest.click();
  await expect(ideas).toHaveCount(3);
  // A pick opens the title field with it; Escape keeps the title and brings the ideas back.
  await ideas.nth(2).getByRole("button").click();
  const field = page.getByLabel("Video title", { exact: true });
  await expect(field).toHaveValue("Call Dana to book a showing");
  await expect(field).toBeFocused();
  await expect(page.getByTestId("title-ideas")).toHaveCount(0);
  await field.press("Escape");
  await expect(page.getByRole("heading", { name: original })).toBeVisible();
  await ideas.nth(0).getByRole("button").click();
  await field.press("End");
  await field.pressSequentially(" today");
  await field.press("Enter");
  await expect(page.getByRole("heading", { name: "Welcome to twelve Maple Street today" })).toBeVisible();
  await expect(page.getByTestId("title-ideas")).toHaveCount(0);
  expect((await (await page.request.get(`/api/videos/${v.id}`)).json()).video.title).toBe("Welcome to twelve Maple Street today");
  // The API renames nothing; a missing video is a 404.
  const res = await page.request.post(`/api/videos/${v.id}/titles`);
  expect(res.status()).toBe(200);
  expect((await res.json()).titles).toEqual(["Welcome to twelve Maple Street", "It's a bright family home", "Call Dana to book a showing"]);
  expect((await (await page.request.get(`/api/videos/${v.id}`)).json()).video.title).toBe("Welcome to twelve Maple Street today");
  expect((await page.request.post(`/api/videos/vid_missing/titles`)).status()).toBe(404);
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
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
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
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
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
  await page.getByRole("button", { name: "Add scene", exact: true }).click();
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
    // The stored kit loads into the form after the page renders; typing before it would be overwritten by it.
    await expect(page.getByLabel("Never translate")).toHaveValue("Acme Cloud\nZeno");
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
  // In the list layout as well.
  await library.getByRole("group", { name: "Layout" }).getByRole("button", { name: "List" }).click();
  await expect(library.getByTestId("video-list").locator(`a[href="/videos/${id}"]`)).toContainText("Waiting for your review");
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

test("a photo shoot puts a person's face in a scene picture, with their consent, lists the photos to download, and is renamed", async ({ page }) => {
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
  // Renamed in place (and back, through the API, for the steps below).
  page.once("dialog", (d) => void d.accept(`Train window ${tag}, renamed`));
  await item.getByRole("button", { name: `Rename Train window ${tag}` }).click();
  await expect(page.locator('p[role="status"]')).toHaveText(`Renamed the photo shoot to “Train window ${tag}, renamed”.`);
  await expect(item.getByRole("button", { name: `Rename Train window ${tag}, renamed` })).toBeFocused();
  const shootId = (await item.getAttribute("data-shoot"))!;
  const back = await page.request.patch(`/api/shoots/${shootId}`, { data: { title: `Train window ${tag}` } });
  expect(((await back.json()).shoot as { title: string }).title).toBe(`Train window ${tag}`);
  expect((await page.request.patch("/api/shoots/sh_missing123", { data: { title: "Gone" } })).status()).toBe(404);
  await page.reload();
  await expect(item.getByRole("button", { name: `Rename Train window ${tag}`, exact: true })).toBeVisible();
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

test("the Assets page keeps the account's audio clips and pictures: upload, words, rename, make a video, download, sort, delete", async ({ page }) => {
  // Names unique to this run, so a run left part-way on a reused server does not match here.
  const tag = Date.now().toString(36);
  const take = `asset-take-${tag}`;
  const intro = `Open house intro ${tag}`;
  const lobby = `lobby-${tag}`;
  // Accented, so the browser has to read the name from filename* to save it as typed.
  const front = `Café lobby ${tag}`;
  await page.goto("/assets");
  await expect(page.getByRole("heading", { name: "Assets", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Assets" }).first()).toHaveAttribute("href", "/assets");
  // An uploaded clip is listed with its length and kind, and can keep the words it says.
  await page.getByLabel("Upload an audio clip").setInputFiles({ name: `${take}.wav`, mimeType: "audio/wav", buffer: toneWav(2) });
  const card = page.getByTestId("asset-clip").filter({ hasText: take });
  await expect(card).toContainText("2s · WAV");
  await expect(page.getByTestId("assets-note")).toHaveText(`Uploaded the audio clip “${take}”.`);
  await card.getByLabel("What it says").fill("Welcome to the open house.");
  await card.getByRole("button", { name: "Keep these words with the clip" }).click();
  await expect(page.getByTestId("assets-note")).toHaveText(`Kept the words with “${take}”: a scene that uses it starts with them.`);
  await expect(card.getByRole("button", { name: "Words kept with the clip" })).toBeFocused();
  const clipId = (await card.getAttribute("data-clip"))!;
  // It starts a video with its words as the script.
  await expect(card.getByRole("link", { name: `Make a video: ${take}`, exact: true })).toHaveAttribute("href", `/create?clip=${clipId}`);
  // Downloaded under its name; after a rename, under the new one (a download is never served from cache by the old name).
  const firstDownload = page.waitForEvent("download");
  await card.getByRole("link", { name: `Download ${take}`, exact: true }).click();
  expect((await firstDownload).suggestedFilename()).toBe(`${take}.wav`);
  // Renamed in place; the server keeps the words.
  page.once("dialog", (d) => d.accept(intro));
  await card.getByRole("button", { name: `Rename ${take}`, exact: true }).click();
  const renamed = page.getByTestId("asset-clip").filter({ hasText: intro });
  await expect(renamed.getByTestId("asset-clip-name")).toHaveText(intro);
  // Under its new name now, with the audio the clip plays; played in the page, it is not a download.
  const clipDownload = page.waitForEvent("download");
  await renamed.getByRole("link", { name: `Download ${intro}`, exact: true }).click();
  const savedClip = await clipDownload;
  expect(savedClip.suggestedFilename()).toBe(`${intro}.wav`);
  const played = await page.request.get(`/api/clips/${clipId}`);
  expect(played.headers()["content-disposition"]).toBeUndefined();
  expect((await readFile((await savedClip.path())!)).equals(await played.body())).toBe(true);
  const stored = ((await (await page.request.get("/api/clips")).json()) as { clips: Array<{ id: string; name: string; transcript?: string }> }).clips.find((c) => c.id === clipId);
  expect(stored).toMatchObject({ name: intro, transcript: "Welcome to the open house." });
  // Clearing the words forgets them.
  await renamed.getByLabel("What it says").fill("");
  await renamed.getByRole("button", { name: "Forget the words" }).click();
  await expect(page.getByTestId("assets-note")).toHaveText(`“${intro}” no longer has words kept with it.`);
  // A picture is uploaded, shown, renamed, and deleted.
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.getByLabel("Upload a picture").setInputFiles({ name: `${lobby}.png`, mimeType: "image/png", buffer: pixel });
  const pictures = page.getByTestId("asset-pictures");
  await expect(pictures.getByRole("img", { name: lobby, exact: true })).toBeVisible();
  page.once("dialog", (d) => d.accept(front));
  await pictures.getByRole("button", { name: `Rename ${lobby}`, exact: true }).click();
  await expect(pictures.getByRole("img", { name: front, exact: true })).toBeVisible();
  const pictureDownload = page.waitForEvent("download");
  await pictures.getByRole("link", { name: `Download ${front}`, exact: true }).click();
  const savedPicture = await pictureDownload;
  expect(savedPicture.suggestedFilename()).toBe(`${front}.png`);
  expect((await readFile((await savedPicture.path())!)).equals(pixel)).toBe(true);
  // It starts a video set against it: the first scene shows it, named after it, kept in a draft of its own.
  const pictureId = (await (await page.request.get("/api/backdrops")).json()).backdrops.find((b: { name: string }) => b.name === front).id as string;
  await expect(pictures.getByRole("link", { name: `Use in a video: ${front}`, exact: true })).toHaveAttribute("href", `/create?picture=${pictureId}`);
  const editor = await page.context().newPage();
  await editor.goto(`/create?picture=${pictureId}`);
  await expect(editor.locator("input[placeholder='Video title']")).toHaveValue(front);
  await expect(editor.getByTestId("stage")).toHaveCSS("background-image", new RegExp(`/api/backdrops/${pictureId}`));
  // Opened and left as it is, it keeps no draft.
  await editor.waitForTimeout(800);
  expect(await editor.evaluate((id) => Object.keys(localStorage).some((k) => k.endsWith(`:picture:${id}`)), pictureId)).toBe(false);
  await editor.locator("textarea").first().fill("Welcome to the lobby.");
  await expect.poll(() => editor.evaluate((id) => Object.entries(localStorage).some(([k, v]) => k.endsWith(`:picture:${id}`) && v.includes("Welcome to the lobby")), pictureId)).toBe(true);
  await editor.reload();
  await expect(editor.locator("textarea").first()).toHaveValue("Welcome to the lobby.");
  await expect(editor.getByTestId("stage")).toHaveCSS("background-image", new RegExp(`/api/backdrops/${pictureId}`));
  await editor.goto("/create?picture=bd_madeup123");
  await expect(editor.getByText("That picture is no longer available")).toBeVisible();
  await editor.close();
  // A search narrows both lists, a clip by its name or its words, and says how many match.
  const search = page.getByRole("searchbox", { name: "Search assets" });
  await search.fill(tag);
  await expect(page.getByTestId("assets-matches")).toHaveText(/^1 of \d+ clips · 1 of \d+ pictures$/);
  await expect(page.getByTestId("asset-clip").filter({ visible: true })).toHaveCount(1);
  await expect(pictures.getByRole("listitem")).toHaveCount(1);
  // By its words too: kept with the clip while the search is on, it stays in view.
  const introCard = page.getByTestId("asset-clip").filter({ hasText: intro });
  await introCard.getByLabel("What it says").fill(`Lobby tour ${tag}`);
  await introCard.getByRole("button", { name: "Keep these words with the clip" }).click();
  await expect(introCard).toBeVisible();
  await search.fill(`lobby TOUR ${tag}`);
  await expect(page.getByTestId("assets-matches")).toHaveText(/^1 of \d+ clips · 0 of \d+ pictures$/);
  await expect(introCard).toBeVisible();
  await search.fill(`Open house intro ${tag}`);
  await expect(page.getByText(`No pictures match “Open house intro ${tag}”.`)).toBeVisible();
  await expect(page.getByTestId("asset-clip").filter({ hasText: intro })).toHaveCount(1);
  await search.fill("");
  await expect(page.getByTestId("assets-matches")).toHaveText("");
  // Newest first by default, oldest first, or by name. The order is then held: a renamed picture keeps its place
  // (so the focus stays with it), and "Sort again" puts the list back in order.
  const aardvark = `aardvark-${tag}`;
  const zebra = `Zebra ${tag}`;
  const sortBy = page.getByRole("combobox", { name: "Sort assets" });
  const pictureOrder = () => pictures.getByRole("img").evaluateAll((imgs) => imgs.map((img) => img.getAttribute("alt")));
  await expect(sortBy).toHaveValue("newest");
  // The select sits beside the search box rather than taking a row of its own.
  expect(Math.abs((await sortBy.boundingBox())!.y - (await search.boundingBox())!.y)).toBeLessThan(8);
  await page.getByLabel("Upload a picture").setInputFiles({ name: `${aardvark}.png`, mimeType: "image/png", buffer: pixel });
  await expect(pictures.getByRole("img", { name: aardvark, exact: true })).toBeVisible();
  await search.fill(tag);
  await expect.poll(pictureOrder).toEqual([aardvark, front]);
  await sortBy.selectOption("oldest");
  await expect(page.getByTestId("assets-note")).toHaveText("Sorted: Oldest first.");
  await expect.poll(pictureOrder).toEqual([front, aardvark]);
  await sortBy.selectOption("name");
  await expect.poll(pictureOrder).toEqual([aardvark, front]);
  await expect(page.getByRole("button", { name: "Sort again" })).toHaveCount(0);
  // Renaming the first card to a name that sorts last leaves it, and the focus, where it was.
  page.once("dialog", (d) => d.accept(zebra));
  await pictures.getByRole("button", { name: `Rename ${aardvark}`, exact: true }).click();
  await expect(pictures.getByRole("button", { name: `Rename ${zebra}`, exact: true })).toBeFocused();
  expect(await pictureOrder()).toEqual([zebra, front]);
  await page.getByRole("button", { name: "Sort again" }).click();
  await expect.poll(pictureOrder).toEqual([front, zebra]);
  await expect(page.getByRole("button", { name: "Sort again" })).toHaveCount(0);
  await expect(page.getByTestId("assets-note")).toHaveText("Sorted: Name A–Z.");
  page.once("dialog", (d) => d.accept());
  await pictures.getByRole("button", { name: `Delete ${zebra}`, exact: true }).click();
  await expect(pictures.getByRole("img", { name: zebra, exact: true })).toHaveCount(0);
  await sortBy.selectOption("newest");
  await search.fill("");
  const pictureShown = await page.request.get(`/api/backdrops/${pictureId}`);
  expect(pictureShown.headers()["content-disposition"]).toBeUndefined();
  // On a phone-width screen every picture action stays inside its card.
  const desktop = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: 800 });
  const pictureCard = pictures.getByRole("listitem").filter({ has: page.getByRole("img", { name: front, exact: true }) });
  const cardBox = (await pictureCard.boundingBox())!;
  for (const name of [`Use in a video: ${front}`, `Download ${front}`, `Rename ${front}`, `Delete ${front}`]) {
    const box = (await pictureCard.getByRole(name.startsWith("Use") || name.startsWith("Download") ? "link" : "button", { name, exact: true }).boundingBox())!;
    expect(box.x + box.width, name).toBeLessThanOrEqual(cardBox.x + cardBox.width);
  }
  await page.setViewportSize(desktop);
  // A viewer sees both lists without changing them, and may still download.
  await page.route("**/api/workspaces", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { personalId: "demo-user", activeId: "ws_view", workspaces: [{ id: "ws_view", name: "Read only team", role: "viewer", members: [] }] } })
      : route.continue(),
  );
  await page.reload();
  await expect(renamed.getByRole("link", { name: `Download ${intro}`, exact: true })).toBeVisible();
  await expect(pictures.getByRole("link", { name: `Download ${front}`, exact: true })).toBeVisible();
  await expect(renamed.getByRole("button", { name: `Rename ${intro}`, exact: true })).toHaveCount(0);
  await expect(pictures.getByRole("button", { name: `Delete ${front}`, exact: true })).toHaveCount(0);
  await expect(pictures.getByRole("checkbox")).toHaveCount(0);
  await page.unroute("**/api/workspaces");
  await page.reload();
  await expect(renamed.getByRole("button", { name: `Rename ${intro}`, exact: true })).toBeVisible();
  expect((await page.request.patch("/api/backdrops/bd_missing123", { data: { name: "Gone" } })).status()).toBe(404);
  expect((await page.request.patch(`/api/clips/${clipId}`, { data: { name: "  " } })).status()).toBe(400);
  // Several pictures are deleted together. Only those the search shows count as selected, so one picked and then
  // hidden by the search is left alone (and stays picked); the count is read out, a picture that could not be deleted
  // stays selected to try again, and the focus goes to the list's heading.
  const bulkOne = `${tag} bulk one`;
  const bulkTwo = `${tag} bulk two`;
  for (const name of [bulkOne, bulkTwo]) {
    await page.getByLabel("Upload a picture").setInputFiles({ name: `${name}.png`, mimeType: "image/png", buffer: pixel });
    await expect(pictures.getByRole("img", { name, exact: true })).toBeVisible();
  }
  const listed = (await (await page.request.get("/api/backdrops")).json()).backdrops as Array<{ id: string; name: string }>;
  const [oneId, twoId] = [bulkOne, bulkTwo].map((n) => listed.find((b) => b.name === n)!.id);
  const selection = page.getByTestId("picture-selection");
  const selectedCount = selection.getByRole("status");
  await pictures.getByRole("checkbox", { name: `Select ${front}`, exact: true }).check();
  await search.fill(`${tag} bulk`);
  await expect(selectedCount).toHaveText("");
  await selection.getByRole("button", { name: "Select all shown" }).click();
  await expect(selectedCount).toHaveText("2 of 2 selected");
  await pictures.getByRole("checkbox", { name: `Select ${bulkTwo}`, exact: true }).uncheck();
  await expect(selectedCount).toHaveText("1 of 2 selected");
  // Clicking the name toggles the checkbox too.
  await pictures.getByText(bulkTwo, { exact: true }).click();
  await expect(selectedCount).toHaveText("2 of 2 selected");
  // The second delete fails: the first goes, the second stays selected, and the reason is shown.
  await page.route(`**/api/backdrops/${twoId}`, (route) => (route.request().method() === "DELETE" ? route.fulfill({ status: 503, json: { error: "Storage is busy" } }) : route.continue()));
  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    void d.accept();
  });
  await selection.getByRole("button", { name: "Delete 2 selected" }).click();
  await expect(page.getByRole("alert").filter({ hasText: `Deleted 1 of 2 pictures; “${bulkTwo}” was not deleted: Storage is busy` })).toHaveCount(1);
  expect(asked).toMatch(/^Delete these 2 pictures\?/);
  await expect(page.getByRole("heading", { name: /^Pictures/ })).toBeFocused();
  await expect(selectedCount).toHaveText("1 of 1 selected");
  expect((await page.request.get(`/api/backdrops/${oneId}`)).status()).toBe(404);
  await page.unroute(`**/api/backdrops/${twoId}`);
  page.once("dialog", (d) => void d.accept());
  await selection.getByRole("button", { name: "Delete 1 selected" }).click();
  await expect(page.getByTestId("assets-note")).toHaveText(`Deleted the picture “${bulkTwo}”.`);
  expect((await page.request.get(`/api/backdrops/${twoId}`)).status()).toBe(404);
  // The picture hidden by the search was neither deleted nor unpicked; Clear selection unpicks it.
  await search.fill("");
  await expect(pictures.getByRole("img", { name: front, exact: true })).toBeVisible();
  await expect(pictures.getByRole("checkbox", { name: `Select ${front}`, exact: true })).toBeChecked();
  await selection.getByRole("button", { name: "Clear selection" }).click();
  await expect(pictures.getByRole("checkbox", { name: `Select ${front}`, exact: true })).not.toBeChecked();
  page.once("dialog", (d) => d.accept());
  await pictures.getByRole("button", { name: `Delete ${front}`, exact: true }).click();
  await expect(page.getByTestId("assets-note")).toHaveText(`Deleted the picture “${front}”.`);
  await expect(page.getByRole("heading", { name: /^Pictures/ })).toBeFocused();
  // Deleting the clip leaves the list and puts the focus on its heading.
  page.once("dialog", (d) => d.accept());
  await renamed.getByRole("button", { name: `Delete ${intro}`, exact: true }).click();
  await expect(page.getByTestId("asset-clip").filter({ hasText: intro })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^Audio clips/ })).toBeFocused();
  expect((await page.request.get(`/api/clips/${clipId}`)).status()).toBe(404);
  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test("quick find opens with Ctrl+K and goes to a page, a video, or a template from the keyboard", async ({ page }) => {
  const tag = Date.now().toString(36);
  const v = await createVideoViaApi(page, `Quarterly kickoff ${tag}`);
  await page.goto("/home");
  const box = page.getByRole("combobox", { name: "Find a page, video, or template" });
  const options = page.getByRole("listbox", { name: "Results" }).getByRole("option");
  // Ctrl+K opens it over any page; with nothing typed it offers the pages, the first one highlighted.
  await page.keyboard.press("Control+k");
  await expect(box).toBeFocused();
  await expect(options.first()).toHaveText(/^Home\s*Page$/);
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await expect(box).toHaveAttribute("aria-activedescendant", (await options.first().getAttribute("id"))!);
  // The dialog meets the accessibility rules.
  const axe = await new AxeBuilder({ page }).include("dialog[aria-label='Quick find']").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations).toEqual([]);
  // A video is found by its title, ignoring case, and Enter opens it.
  await box.fill(`QUARTERLY KICKOFF ${tag}`);
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveText(new RegExp(`^Quarterly kickoff ${tag}\\s*Video$`));
  await expect(page.getByRole("status").filter({ hasText: /^1 result$/ })).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/videos/${v.id}$`));
  await expect(page.getByRole("dialog", { name: "Quick find" })).toBeHidden();
  // From the sidebar's Search button: the arrow keys move through pages and templates, wrapping round.
  const search = page.getByRole("button", { name: "Search", exact: true });
  await search.click();
  await expect(box).toBeFocused();
  // Videos are searched a moment after typing stops; the results are marked busy until their answer is in.
  const results = page.getByRole("listbox", { name: "Results" });
  await box.fill("listing walkthrough");
  await expect(results).toHaveAttribute("aria-busy", "false");
  await expect(options.filter({ hasText: /Template$/ })).toHaveText([/^Property listing walkthrough\s*Template$/]);
  await box.fill("voice");
  await expect(results).toHaveAttribute("aria-busy", "false");
  await expect(options.filter({ hasText: /Page$/ })).toHaveText([/^Voices/, /^Voice changer/]);
  await page.keyboard.press("ArrowUp");
  await expect(options.last()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/voice-changer$/);
  // Nothing found says so; Escape closes it and the focus goes back to the button that opened it.
  await search.click();
  await box.fill("zzqx nothing here");
  await expect(page.getByText("Nothing matches “zzqx nothing here”.")).toBeVisible();
  await expect(results).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include("dialog[aria-label='Quick find']").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
  // Ctrl+K again while it is open leaves it as it is.
  await page.keyboard.press("Control+k");
  await expect(box).toHaveValue("zzqx nothing here");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Quick find" })).toBeHidden();
  await expect(search).toBeFocused();
  await expect(page).toHaveURL(/\/voice-changer$/);
});

test("the keyboard shortcuts open with Ctrl+/ or the sidebar, with this computer's keys, and keep the editor's keys", async ({ page }) => {
  await page.locator("input[placeholder='Video title']").fill("Shortcut check");
  const script = page.getByRole("textbox", { name: "Script", exact: true });
  await script.fill("Welcome in.");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  const renders: string[] = [];
  page.on("request", (r) => r.url().endsWith("/api/videos") && r.method() === "POST" && renders.push(r.url()));
  await page.keyboard.press("Control+/");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "In the video editor" })).toBeVisible();
  // Off a Mac the keys read Ctrl, and Ctrl+Y is offered for redo.
  await expect(dialog).toContainText("Quick find: go to a page, a video, or a template");
  await expect(dialog.locator("kbd").first()).toHaveText("Ctrl");
  await expect(dialog).toContainText("Redo it");
  await expect(dialog.getByText("Y", { exact: true })).toBeVisible();
  const axe = await new AxeBuilder({ page }).include("dialog[aria-labelledby='shortcuts-title']").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations).toEqual([]);
  // The editor's Generate shortcut and quick find's keys do not reach the page behind it.
  await page.keyboard.press("Control+Enter");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Quick find" })).toBeHidden();
  await page.waitForTimeout(300);
  expect(renders).toEqual([]);
  await expect(page).toHaveURL(/\/create/);
  // Escape closes it, and the focus goes back to the script.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(script).toBeFocused();
  // From the sidebar's button, the same keys close it again, back on the button.
  const button = page.getByRole("button", { name: "Keyboard shortcuts" });
  await button.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Control+/");
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  // Its Close button shuts it too; Ctrl+- (zoom out on a German keyboard, the US / key's place) does not open it.
  await button.click();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  await page.keyboard.press("Control+Minus");
  await expect(dialog).toBeHidden();
  // Over quick find, the keys are left to it.
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Quick find" })).toBeVisible();
  await page.keyboard.press("Control+/");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("combobox", { name: "Find a page, video, or template" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Quick find" })).toBeHidden();
  expect(renders).toEqual([]);
  // With the dialogs shut, the same Generate shortcut does start the video, so the check above held it back.
  await page.keyboard.press("Control+Enter");
  await page.waitForURL(/\/videos\/vid_/);
});

test("the library retries the selected failed renders", async ({ page }) => {
  const tag = Date.now().toString(36);
  const [ready, other] = [await createVideoViaApi(page, `Retry ready ${tag}`), await createVideoViaApi(page, `Retry other ${tag}`)];
  // The API accounts for every id: a render that is not failed is skipped with why, an unknown one is missing.
  expect((await page.request.post("/api/videos/retry", { data: { ids: [] } })).status()).toBe(400);
  expect((await page.request.post("/api/videos/retry", { data: { ids: Array.from({ length: 51 }, (_, i) => `vid_${i}`) } })).status()).toBe(400);
  const res = await page.request.post("/api/videos/retry", { data: { ids: [ready.id, "vid_nope"] } });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ started: [], failedAgain: [], skipped: [{ id: ready.id, code: "not_failed", reason: "Not a failed render" }], missing: ["vid_nope"] });

  // The demo renderer never fails, so the library is shown one of the two as failed; the server still decides.
  await page.route("**/api/videos?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { videos: Array<{ id: string; status: string; error?: string }> };
    for (const v of body.videos) if (v.id === ready.id) Object.assign(v, { status: "failed", error: "Rendering failed" });
    await route.fulfill({ response, json: body });
  });
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.accept();
  });
  await page.goto("/videos");
  await page.getByLabel("Search videos").fill(tag);
  await expect(page.locator(`a[href="/videos/${other.id}"]`)).toBeVisible();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: `Select Retry other ${tag}` }).click();
  // Only a selection holding a failed render offers the retry, counting the failed ones.
  await expect(page.getByRole("button", { name: /Retry failed/ })).toHaveCount(0);
  await page.getByRole("button", { name: `Select Retry ready ${tag}` }).click();
  await page.getByRole("button", { name: "Retry failed (1)" }).click();
  await expect(page.getByText("1 was no longer a failed render.")).toBeVisible();
  expect(dialogs).toEqual(["Start 1 failed render again with the same settings? Each counts toward this month's renders."]);
  // What was not started stays selected, so it can be found.
  await expect(page.getByTestId("bulk-bar")).toContainText("1 selected");
  await expect(page.getByRole("button", { name: `Select Retry ready ${tag}` })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: `Select Retry other ${tag}` })).toHaveAttribute("aria-pressed", "false");
});

test("videos are starred from their page or in bulk, and the library filters by star", async ({ page }) => {
  const tag = Date.now().toString(36);
  const [one, two] = [await createVideoViaApi(page, `Star one ${tag}`), await createVideoViaApi(page, `Star two ${tag}`)];
  expect((await page.request.patch(`/api/videos/${one.id}`, { data: { starred: "yes" } })).status()).toBe(400);
  await page.goto(`/videos/${one.id}`);
  // One name for the toggle; whether it is on is its pressed state.
  const star = page.getByRole("button", { name: "Star", exact: true });
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "true");
  const a11y = (selector: string) => new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect((await a11y("main")).violations.map((v) => v.id)).toEqual([]);
  const starredIds = async () => ((await (await page.request.get(`/api/videos?q=${tag}&starred=1`)).json()).videos as { id: string }[]).map((v) => v.id).sort();
  expect(await starredIds()).toEqual([one.id]);

  await page.goto("/videos");
  await page.getByLabel("Search videos").fill(tag);
  const card = (id: string) => page.locator(`a[href="/videos/${id}"]`);
  await expect(card(two.id)).toBeVisible();
  await expect(card(one.id).getByTestId("star-badge")).toBeVisible();
  await expect(card(two.id).getByTestId("star-badge")).toHaveCount(0);
  await page.getByTestId("starred-toggle").click();
  await expect(page.getByTestId("starred-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(card(two.id)).toHaveCount(0);
  await expect(card(one.id)).toBeVisible();
  // The pressed filter and the starred card's badge are readable (the filter pill's contrast included).
  expect((await a11y("main")).violations.map((v) => v.id)).toEqual([]);
  // With a search that hides every starred video, the empty state points at the filters rather than at starring.
  await page.getByLabel("Search videos").fill(`${tag} nothing like it`);
  await expect(page.getByText("Try a different search, status, folder, presenter, voice, date, share link, or turn off Starred.")).toBeVisible();
  await page.getByLabel("Search videos").fill(tag);
  await expect(card(one.id)).toBeVisible();
  // Starring in bulk from the whole library, then taking both stars off from the filtered view.
  await page.getByTestId("starred-toggle").click();
  await expect(card(two.id)).toBeVisible();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: `Select Star two ${tag}` }).click();
  await page.getByTestId("bulk-bar").getByRole("button", { name: "Star", exact: true }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  await expect(card(two.id).getByTestId("star-badge")).toBeVisible();
  expect(await starredIds()).toEqual([one.id, two.id].sort());
  await page.getByTestId("starred-toggle").click();
  await expect(card(two.id)).toBeVisible();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "Select all shown" }).click();
  await page.getByTestId("bulk-bar").getByRole("button", { name: "Unstar" }).click();
  await expect(page.getByText("No videos match")).toBeVisible();
  expect(await starredIds()).toEqual([]);
});

test("the library filters by when videos were made", async ({ page }) => {
  const tag = Date.now().toString(36);
  const fresh = await createVideoViaApi(page, `Made lately ${tag}`);
  // The server filters, so the API answers the same as the page; an unknown window is refused.
  const listed = async (created: string) => ((await (await page.request.get(`/api/videos?q=${tag}&created=${created}`)).json()).videos as { id: string }[]).map((v) => v.id);
  expect(await listed("7d")).toEqual([fresh.id]);
  expect(await listed("90d")).toEqual([fresh.id]);
  expect((await page.request.get("/api/videos?created=1y")).status()).toBe(400);

  await page.goto("/videos");
  await page.getByLabel("Search videos").fill(tag);
  const card = page.locator(`a[href="/videos/${fresh.id}"]`);
  await expect(card).toBeVisible();
  // A selection does not survive a new window, as for the other filters.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: `Select Made lately ${tag}` }).click();
  await expect(page.getByTestId("bulk-bar")).toContainText("1 selected");
  const filter = page.getByLabel("Filter by date made");
  await expect(filter.locator("option:checked")).toHaveText("Made any time");
  await filter.selectOption("7d");
  await expect(page.getByTestId("bulk-bar").getByText(/selected$/)).toHaveText("0 selected");
  await expect(page.getByRole("button", { name: `Select Made lately ${tag}` })).toBeVisible();
  await page.getByRole("button", { name: "Done selecting" }).click();
  await filter.selectOption("30d");
  await expect(card).toBeVisible();
  await filter.selectOption("all");
  await expect(card).toBeVisible();
  const axe = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
});

test("the library shows videos as compact rows, remembered by the browser", async ({ page }) => {
  const tag = Date.now().toString(36);
  const [one, two] = [await createVideoViaApi(page, `Row one ${tag}`), await createVideoViaApi(page, `Row two ${tag}`)];
  expect((await page.request.patch(`/api/videos/${one.id}`, { data: { starred: true, shareDisabled: true, folder: `Rows ${tag}` } })).ok()).toBe(true);
  await page.goto("/videos");
  await page.getByLabel("Search videos").fill(tag);
  await expect(page.locator(`a[href="/videos/${two.id}"]`)).toBeVisible();
  const layout = page.getByRole("group", { name: "Layout" });
  await expect(layout.getByRole("button", { name: "Grid" })).toHaveAttribute("aria-pressed", "true");
  await layout.getByRole("button", { name: "List" }).click();
  await expect(layout.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  const list = page.getByTestId("video-list");
  const row = list.locator(`a[href="/videos/${one.id}"]`);
  await expect(row).toContainText(`Row one ${tag}`);
  await expect(row).toContainText(`Rows ${tag}`);
  await expect(row.getByTestId("star-badge")).toBeVisible();
  await expect(row.getByTestId("row-share")).toHaveText("Link off");
  // At phone width the row still says why it is off, without running past the screen.
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(row.getByTestId("row-share")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(list.locator(`a[href="/videos/${two.id}"]`)).toBeVisible();
  const axe = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  // Selecting works the same in rows.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: `Select Row two ${tag}` }).click();
  await expect(page.getByRole("button", { name: `Select Row two ${tag}` })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("bulk-bar").getByText(/selected$/)).toHaveText("1 selected");
  await page.getByRole("button", { name: "Done selecting" }).click();
  // The browser keeps the choice; the row opens the video.
  await page.reload();
  await page.getByLabel("Search videos").fill(tag);
  await expect(page.getByTestId("video-list").locator(`a[href="/videos/${two.id}"]`)).toBeVisible();
  await page.getByTestId("video-list").locator(`a[href="/videos/${two.id}"]`).click();
  await page.waitForURL(`**/videos/${two.id}`);
  await page.goto("/videos");
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Grid" }).click();
  await expect(page.getByTestId("video-list")).toHaveCount(0);
});

test("the library's analytics CSV holds what the library shows", async ({ page }) => {
  const tag = Date.now().toString(36);
  const [starred, plain] = [await createVideoViaApi(page, `Csv starred ${tag}`), await createVideoViaApi(page, `Csv plain ${tag}`)];
  expect((await page.request.patch(`/api/videos/${starred.id}`, { data: { starred: true } })).ok()).toBe(true);
  const idsIn = async (url: string) => {
    const res = await page.request.get(url);
    expect(res.status()).toBe(200);
    const lines = (await res.text()).replace(/^﻿/, "").trim().split(/\r?\n/).slice(1);
    return lines.map((l) => l.split(",")[0].replace(/"/g, ""));
  };
  expect(await idsIn(`/api/videos/analytics?q=${tag}&starred=1`)).toEqual([starred.id]);
  expect((await idsIn(`/api/videos/analytics?q=${tag}`)).sort()).toEqual([starred.id, plain.id].sort());
  // In the order asked for, and the library's page size is not the file's.
  expect(await idsIn(`/api/videos/analytics?q=${tag}&sort=title`)).toEqual([plain.id, starred.id]);
  expect(await idsIn(`/api/videos/analytics?q=${tag}&sort=title&limit=500`)).toEqual([plain.id, starred.id]);
  expect((await page.request.get("/api/videos/analytics?trash=true")).status()).toBe(400);
  expect((await page.request.get("/api/videos/analytics?share=public")).status()).toBe(400);

  // The library's link carries its filters, and downloads the file.
  await page.goto("/videos");
  await page.getByLabel("Search videos").fill(tag);
  await expect(page.locator(`a[href="/videos/${plain.id}"]`)).toBeVisible();
  await page.getByTestId("starred-toggle").click();
  await expect(page.locator(`a[href="/videos/${plain.id}"]`)).toHaveCount(0);
  const link = page.getByTestId("library-analytics");
  await expect(link).toHaveAttribute("href", `/api/videos/analytics?q=${tag}&starred=1`);
  await expect(link).toHaveAccessibleName("Download analytics");
  const download = page.waitForEvent("download");
  await link.click();
  expect((await download).suggestedFilename()).toMatch(/^video-analytics-\d{4}-\d{2}-\d{2}\.csv$/);
  // A folder (with characters that need encoding) carries through; with nothing matching, there is no file to offer.
  const folder = `Q&A ${tag}`;
  expect((await page.request.patch(`/api/videos/${starred.id}`, { data: { folder } })).ok()).toBe(true);
  await page.reload();
  await page.getByLabel("Search videos").fill(tag);
  await page.getByLabel("Folder").selectOption(folder);
  await expect(page.locator(`a[href="/videos/${plain.id}"]`)).toHaveCount(0);
  const href = (await link.getAttribute("href"))!;
  expect(new URL(href, "http://x").searchParams.get("folder")).toBe(folder);
  expect(await idsIn(href)).toEqual([starred.id]);
  await page.getByLabel("Search videos").fill(`${tag} nothing like it`);
  await expect(page.getByText("No videos match")).toBeVisible();
  await expect(link).toHaveCount(0);
  // The trash has no share analytics, so the link is not offered there.
  await page.getByLabel("Search videos").fill(tag);
  await page.getByTestId("trash-toggle").click();
  await expect(link).toHaveCount(0);
});

test("the library's folder picker says how many videos each folder holds", async ({ page }) => {
  const tag = Date.now().toString(36);
  const folder = `Counted ${tag}`;
  const [one, two] = [await createVideoViaApi(page, `Count one ${tag}`), await createVideoViaApi(page, `Count two ${tag}`)];
  for (const v of [one, two]) expect((await page.request.patch(`/api/videos/${v.id}`, { data: { folder } })).ok()).toBe(true);
  const counts = (await (await page.request.get(`/api/videos?folder=${encodeURIComponent(folder)}`)).json()).folderCounts as Record<string, number>;
  expect(counts[folder]).toBe(2);
  await page.goto("/videos");
  const picker = page.getByLabel("Folder", { exact: true });
  await expect(picker.locator("option", { hasText: folder })).toHaveText(`${folder} (2)`);
  const total = (await (await page.request.get("/api/videos?limit=1")).json()).total as number;
  await expect(picker.locator("option[value='all']")).toHaveText(`All folders (${total})`);
  // Whatever the other filters: a search that hides one of the two leaves the count at two.
  const searched = (await (await page.request.get(`/api/videos?q=${encodeURIComponent(`Count one ${tag}`)}`)).json()) as { matched: number; folderCounts: Record<string, number> };
  expect([searched.matched, searched.folderCounts[folder]]).toEqual([1, 2]);
  // Moving one to the trash leaves one in the library's count; the trash counts its own.
  expect((await page.request.delete(`/api/videos/${two.id}`)).ok()).toBe(true);
  await page.reload();
  await expect(page.getByLabel("Folder", { exact: true }).locator("option", { hasText: folder })).toHaveText(`${folder} (1)`);
  await page.getByTestId("trash-toggle").click();
  await expect(page.getByLabel("Folder", { exact: true }).locator("option", { hasText: folder })).toHaveText(`${folder} (1)`);
  // Picking it still filters by the folder's name.
  await page.getByLabel("Folder", { exact: true }).selectOption(folder);
  await expect(page.locator(`a[href="/videos/${two.id}"]`)).toBeVisible();
});

test("Empty trash deletes every trashed video for good and keeps the library", async ({ page }) => {
  const trashCount = async () => (await (await page.request.get("/api/videos?trash=true&limit=1")).json()).trashed as number;
  // Start from an empty trash (earlier tests leave videos there), through the API, 50 a call.
  for (let left = await trashCount(), i = 0; left > 0 && i < 20; left = await trashCount(), i++) {
    const r = await page.request.post("/api/videos/empty-trash", { data: { expected: left } });
    expect(r.ok()).toBe(true);
  }
  expect(await trashCount()).toBe(0);
  const tag = Date.now().toString(36);
  const [keep, a, b] = [await createVideoViaApi(page, `Kept ${tag}`), await createVideoViaApi(page, `Trashed A ${tag}`), await createVideoViaApi(page, `Trashed B ${tag}`)];
  for (const v of [a, b]) expect((await page.request.delete(`/api/videos/${v.id}`)).ok()).toBe(true);
  // The count the caller saw is part of the request: a different one deletes nothing.
  const stale = await page.request.post("/api/videos/empty-trash", { data: { expected: 1 } });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error).toContain("The trash now holds 2 videos, not 1");
  expect((await page.request.post("/api/videos/empty-trash", { data: {} })).status()).toBe(400);
  await page.goto("/videos");
  // Only the trash view offers it.
  await expect(page.getByRole("button", { name: "Empty trash" })).toHaveCount(0);
  await page.getByTestId("trash-toggle").click();
  // A search narrows the view, not what the button empties: the confirm counts the whole trash.
  await page.getByLabel("Search videos").fill(`Trashed A ${tag}`);
  await expect(page.locator(`a[href="/videos/${b.id}"]`)).toHaveCount(0);
  const dialogs: string[] = [];
  page.once("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.getByRole("button", { name: "Empty trash" }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toBe("Delete all 2 videos in the trash for good? Their comments, the emails their share pages collected, short clips, and the cleaned, lip-synced, and music copies made from them go too. This cannot be undone.");
  // Dismissed: nothing went, and the page is usable again.
  await expect(page.getByTestId("trash-toggle")).toBeEnabled();
  expect(await trashCount()).toBe(2);
  // A video trashed since the page loaded is counted by the confirm, not left out of it.
  const c = await createVideoViaApi(page, `Trashed C ${tag}`);
  expect((await page.request.delete(`/api/videos/${c.id}`)).ok()).toBe(true);
  page.once("dialog", (d) => {
    dialogs.push(d.message());
    void d.accept();
  });
  await page.getByRole("button", { name: "Empty trash" }).click();
  await expect(page.getByText("The trash is empty")).toBeVisible();
  expect(dialogs[1]).toContain("Delete all 3 videos in the trash for good?");
  await expect(page.getByRole("button", { name: "Empty trash" })).toHaveCount(0);
  await expect(page.getByTestId("trash-toggle")).toHaveText("Trash");
  await expect(page.getByTestId("trash-toggle")).toBeFocused();
  for (const v of [a, b, c]) expect((await page.request.get(`/api/videos/${v.id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/videos/${keep.id}`)).ok()).toBe(true);
  // The activity feed says how many went in one line.
  const events = (await (await page.request.get("/api/activity")).json()).events as Array<{ kind: string; count?: number }>;
  expect(events[0]).toMatchObject({ kind: "video.purged", count: 3 });
  // Once empty, the endpoint has nothing to do.
  expect(await (await page.request.post("/api/videos/empty-trash", { data: { expected: 0 } })).json()).toEqual({ done: 0, remaining: 0 });
});

test("Restore all brings every trashed video back to the library", async ({ page }) => {
  const trashCount = async () => (await (await page.request.get("/api/videos?trash=true&limit=1")).json()).trashed as number;
  // Start from an empty trash, so the count below is this test's own.
  for (let left = await trashCount(), i = 0; left > 0 && i < 20; left = await trashCount(), i++) {
    expect((await page.request.post("/api/videos/empty-trash", { data: { expected: left } })).ok()).toBe(true);
  }
  const tag = Date.now().toString(36);
  const folder = `Back ${tag}`;
  const [a, b] = [await createVideoViaApi(page, `Restored A ${tag}`), await createVideoViaApi(page, `Restored B ${tag}`)];
  expect((await page.request.patch(`/api/videos/${a.id}`, { data: { folder, starred: true } })).ok()).toBe(true);
  for (const v of [a, b]) expect((await page.request.delete(`/api/videos/${v.id}`)).ok()).toBe(true);
  expect(await trashCount()).toBe(2);
  await page.goto("/videos");
  await expect(page.getByRole("button", { name: "Restore all" })).toHaveCount(0);
  await page.getByTestId("trash-toggle").click();
  // A search narrows the view, not what comes back.
  await page.getByLabel("Search videos").fill(`Restored A ${tag}`);
  await expect(page.locator(`a[href="/videos/${b.id}"]`)).toHaveCount(0);
  const dialogs: string[] = [];
  page.once("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.getByRole("button", { name: "Restore all" }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toBe("Bring all 2 videos in the trash back to the library? Their share links and embeds work again as they were set.");
  // Dismissed: nothing came back.
  await expect(page.getByTestId("trash-toggle")).toBeEnabled();
  expect(await trashCount()).toBe(2);
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Restore all" }).click();
  await expect(page.getByText("The trash is empty")).toBeVisible();
  await expect(page.getByTestId("trash-toggle")).toHaveText("Trash");
  await expect(page.getByTestId("trash-toggle")).toBeFocused();
  // Both are back, the first in its folder with its star.
  const back = (await (await page.request.get(`/api/videos/${a.id}`)).json()).video as { deletedAt?: string; folder?: string; starred?: boolean };
  expect([back.deletedAt, back.folder, back.starred]).toEqual([undefined, folder, true]);
  expect((await (await page.request.get(`/api/videos/${b.id}`)).json()).video.deletedAt).toBeUndefined();
  await page.getByTestId("trash-toggle").click();
  await page.getByLabel("Search videos").fill(`Restored B ${tag}`);
  await expect(page.locator(`a[href="/videos/${b.id}"]`)).toBeVisible();
  // The activity feed counts them in one line, and a second call has nothing to do.
  const events = (await (await page.request.get("/api/activity")).json()).events as Array<{ kind: string; count?: number }>;
  expect(events[0]).toMatchObject({ kind: "video.restored", count: 2 });
  expect(await (await page.request.post("/api/videos/restore-all")).json()).toEqual({ done: 0, remaining: 0 });
});

test("Select all matching selects past the first page and hands every match to a bulk action", async ({ page }) => {
  const tag = Date.now().toString(36);
  const folder = `All of them ${tag}`;
  // One more page's worth than the library shows at first (48), in one batch.
  const rows = Array.from({ length: 50 }, (_, i) => `Guest ${String(i + 1).padStart(2, "0")}`);
  const made = await page.request.post("/api/videos/batch", {
    data: { title: `Matching ${tag}`, scriptTemplate: "Hello {name}.", csv: `name\n${rows.join("\n")}`, avatarId: "stock_1", voiceId: "stock_voice_1" },
  });
  expect(made.status()).toBe(201);
  const { batchId } = (await made.json()) as { batchId: string };
  await page.goto(`/videos?batch=${batchId}`);
  await expect(page.getByText("Showing 48 of 50")).toBeVisible();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const bar = page.getByTestId("bulk-bar");
  const count = bar.getByText(/selected$/);
  await bar.getByRole("button", { name: "Select all shown" }).click();
  await expect(count).toHaveText("48 selected");
  await bar.getByRole("button", { name: "Select all 50 matching" }).click();
  await expect(count).toHaveText("50 selected");
  // Everything selected is on the page, so there is nothing left to load, and the keyboard stays in the bar.
  await expect(page.getByTestId("load-more")).toHaveCount(0);
  await expect(bar.getByRole("button", { name: /matching/ })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Select all shown" })).toBeFocused();
  await bar.getByRole("button", { name: "Move to folder" }).click();
  await page.getByLabel("Folder for the selected videos").fill(folder);
  await page.getByTestId("bulk-folder").getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  const counts = (await (await page.request.get("/api/videos?limit=1")).json()).folderCounts as Record<string, number>;
  expect(counts[folder]).toBe(50);

  // Typing a search while the matches load cancels the select: nothing is chosen for a list no longer shown.
  await page.reload();
  await expect(page.getByText("Showing 48 of 50")).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(/\/api\/videos\?.*limit=50/, async (route) => {
    await held;
    await route.continue();
  });
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByTestId("bulk-bar").getByRole("button", { name: "Select all 50 matching" }).click();
  await expect(page.getByTestId("bulk-bar").getByRole("button", { name: "Selecting…" })).toBeVisible();
  await page.getByLabel("Search videos").fill("Guest 0");
  release();
  // In select mode the cards are toggle buttons named for their videos.
  await expect(page.getByRole("button", { name: new RegExp(`^Select Matching ${tag} – Guest`) })).toHaveCount(9);
  await expect(page.getByTestId("bulk-bar").getByText(/selected$/)).toHaveText("0 selected");
  await page.unroute(/\/api\/videos\?.*limit=50/);
});

test("Shift+click selects, or unselects, a run of videos from the one clicked last, in the grid and the list", async ({ page }) => {
  const tag = Date.now().toString(36);
  const rows = Array.from({ length: 6 }, (_, i) => `Runner ${i + 1}`);
  const made = await page.request.post("/api/videos/batch", {
    data: { title: `Range ${tag}`, scriptTemplate: "Hello {name}.", csv: `name\n${rows.join("\n")}`, avatarId: "stock_1", voiceId: "stock_voice_1" },
  });
  expect(made.status()).toBe(201);
  const { batchId } = (await made.json()) as { batchId: string };
  await page.goto(`/videos?batch=${batchId}`);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const bar = page.getByTestId("bulk-bar");
  const count = bar.getByText(/selected$/);
  // The cards in the order shown, whatever order the batch's rows were made in.
  const cards = page.locator("button[aria-pressed][aria-label^='Select ']");
  await expect(cards).toHaveCount(6);
  const pressed = async () => Promise.all((await cards.all()).map(async (c) => (await c.getAttribute("aria-pressed")) === "true"));

  await cards.nth(1).click();
  await cards.nth(3).click({ modifiers: ["Shift"] });
  await expect(count).toHaveText("3 selected");
  await expect.poll(pressed).toEqual([false, true, true, true, false, false]);
  // Back up the page from the one clicked last, keeping what was already selected.
  await cards.nth(5).click();
  await cards.nth(4).click({ modifiers: ["Shift"] });
  await expect(count).toHaveText("5 selected");
  await expect.poll(pressed).toEqual([false, true, true, true, true, true]);
  // A run from a card just unselected unselects.
  await cards.nth(2).click();
  await cards.nth(4).click({ modifiers: ["Shift"] });
  await expect(count).toHaveText("2 selected");
  await expect.poll(pressed).toEqual([false, true, false, false, false, true]);

  // The list's rows take Shift+click the same way, and the selection carries over to them.
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "List" }).click();
  const listed = page.getByTestId("video-list").locator("button[aria-pressed]");
  await expect(listed).toHaveCount(6);
  await expect(count).toHaveText("2 selected");
  await listed.nth(0).click();
  await listed.nth(2).click({ modifiers: ["Shift"] });
  await expect(count).toHaveText("4 selected");
  await expect.poll(pressed).toEqual([true, true, true, false, false, true]);

  // Done drops where the last run started, so the first Shift+click after it picks one card.
  await bar.getByRole("button", { name: "Done selecting" }).click();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await listed.nth(4).click({ modifiers: ["Shift"] });
  await expect(count).toHaveText("1 selected");
  await expect.poll(pressed).toEqual([false, false, false, false, true, false]);
  // From the keyboard, Shift+Space on a focused row picks the run too.
  await listed.nth(2).focus();
  await page.keyboard.press("Shift+Space");
  await expect(count).toHaveText("3 selected");
  await expect.poll(pressed).toEqual([false, false, true, true, true, false]);
  // Picking all shown starts afresh: the next Shift+click picks one card rather than a run from before.
  await bar.getByRole("button", { name: "Select all shown" }).click();
  await expect(count).toHaveText("6 selected");
  await listed.nth(0).click({ modifiers: ["Shift"] });
  await expect(count).toHaveText("5 selected");
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "Grid" }).click();

  // The keyboard shortcuts list it.
  await page.keyboard.press("Control+/");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog.getByRole("heading", { name: "In My videos, while selecting" })).toBeVisible();
  await expect(dialog).toContainText("Select, or unselect, a run of videos: every one from the video clicked last to the one Shift+clicked");
});

test("\"/\" jumps to the library's search box, outside a text box", async ({ page }) => {
  const tag = Date.now().toString(36);
  await createVideoViaApi(page, `Slash ${tag}`);
  await page.goto("/videos");
  const search = page.getByRole("searchbox", { name: "Search videos" });
  await expect(search).toBeVisible();
  await expect(search).toHaveAttribute("aria-keyshortcuts", "/");
  await page.getByRole("heading", { name: "My videos" }).click();
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  // The key moved focus rather than being typed.
  await expect(search).toHaveValue("");
  await page.keyboard.type(`Slash ${tag}`);
  await expect(page.locator("a[href^='/videos/vid_']")).toHaveCount(1);
  // In the box, "/" is a character like any other.
  await page.keyboard.type("/");
  await expect(search).toHaveValue(`Slash ${tag}/`);
  await page.keyboard.press("Backspace");
  // From anywhere else, it comes back with what it holds selected, so typing replaces the search.
  await page.getByRole("heading", { name: "My videos" }).click();
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  expect(await search.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, `Slash ${tag}`.length]);
  // From a focused card's link too; a held "/" moves the focus once and types nothing into the box.
  await page.locator("a[href^='/videos/vid_']").first().focus();
  await page.keyboard.down("/");
  await page.evaluate(() => {
    const el = document.activeElement!;
    for (let i = 0; i < 3; i++) el.dispatchEvent(new KeyboardEvent("keydown", { key: "/", code: "Slash", repeat: true, bubbles: true, cancelable: true }));
  });
  await page.keyboard.up("/");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue(`Slash ${tag}`);
  // Ctrl+/ is still the shortcuts list, and it shows "/"; with the dialog open, "/" stays in it.
  await page.getByRole("heading", { name: "My videos" }).click();
  await page.keyboard.press("Control+/");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog.getByRole("heading", { name: "In My videos", exact: true })).toBeVisible();
  await expect(dialog).toContainText("Search the videos (outside a text box)");
  await page.keyboard.press("/");
  await expect(dialog).toBeVisible();
  await expect(search).not.toBeFocused();
  // Single-key shortcuts can be turned off there (for speech input), and the browser remembers it.
  const singleKeys = dialog.getByRole("checkbox", { name: /Single-key shortcuts/ });
  await expect(singleKeys).toBeChecked();
  await singleKeys.uncheck();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.reload();
  await page.getByRole("heading", { name: "My videos" }).click();
  await page.keyboard.press("/");
  await expect(search).not.toBeFocused();
  await page.keyboard.press("Control+/");
  await expect(singleKeys).not.toBeChecked();
  await singleKeys.check();
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "My videos" }).click();
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem("avatar-studio:single-key-shortcuts"))).toBeNull();
});

test("while selecting, Ctrl+A selects all shown and Escape closes the bar's field, then stops selecting", async ({ page }) => {
  const tag = Date.now().toString(36);
  const made = await page.request.post("/api/videos/batch", {
    data: { title: `Keys ${tag}`, scriptTemplate: "Hello {name}.", csv: "name\nAda\nBo\nCy\nDee", avatarId: "stock_1", voiceId: "stock_voice_1" },
  });
  expect(made.status()).toBe(201);
  const { batchId } = (await made.json()) as { batchId: string };
  await page.goto(`/videos?batch=${batchId}`);
  const select = page.getByRole("button", { name: "Select", exact: true });
  await select.click();
  const bar = page.getByTestId("bulk-bar");
  const count = bar.getByText(/selected$/);
  await expect(page.locator("button[aria-pressed][aria-label^='Select ']")).toHaveCount(4);
  await page.keyboard.press("Control+a");
  await expect(count).toHaveText("4 selected");

  // In the search box the keys are the box's own: Ctrl+A selects its text, Escape leaves the bar as it is.
  const search = page.getByLabel("Search videos");
  await bar.getByRole("button", { name: "Done selecting" }).click();
  await select.click();
  await search.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Escape");
  await expect(count).toHaveText("0 selected");

  // Escape in the folder field closes it, back on Move to folder, with the selection kept.
  await page.locator("button[aria-pressed][aria-label^='Select ']").first().click();
  await page.keyboard.press("Control+a");
  await expect(count).toHaveText("4 selected");
  await bar.getByRole("button", { name: "Move to folder" }).click();
  const folderField = page.getByLabel("Folder for the selected videos");
  await expect(folderField).toBeFocused();
  await folderField.fill(`Kept out ${tag}`);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("bulk-folder")).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Move to folder" })).toBeFocused();
  await expect(count).toHaveText("4 selected");
  // Its close button goes back to the button that opened the field too.
  await bar.getByRole("button", { name: "Set expiry" }).click();
  await bar.getByRole("button", { name: "Close expiry" }).click();
  await expect(bar.getByRole("button", { name: "Set expiry" })).toBeFocused();

  // With no field open, Escape stops selecting, the keyboard landing on Select; nothing was moved.
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
  await expect(select).toBeFocused();
  const videos = (await (await page.request.get(`/api/videos?batch=${batchId}`)).json()) as { videos: Array<{ folder?: string }> };
  expect(videos.videos.map((v) => v.folder ?? "")).toEqual(["", "", "", ""]);
  // Out of select mode, Ctrl+A is the browser's again: it selects the page's text.
  await page.keyboard.press("Control+a");
  expect(await page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
  await expect(bar).toHaveCount(0);

  // Over the keyboard shortcuts dialog the keys are the dialog's: Escape closes it and leaves the bar's field open.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await select.click();
  await page.locator("button[aria-pressed][aria-label^='Select ']").first().click();
  await bar.getByRole("button", { name: "Move to folder" }).click();
  await expect(page.getByLabel("Folder for the selected videos")).toBeFocused();
  await page.keyboard.press("Control+/");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toContainText("Select every video shown (up to the 200 one action takes)");
  await expect(dialog).toContainText("Close the field open in the bar, such as the folder or a time; with none open, stop selecting");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("bulk-folder")).toHaveCount(1);
  await expect(count).toHaveText("1 selected");
  // Unselecting everything disables Move to folder, so closing the field lands on Select all shown instead.
  await page.locator("button[aria-pressed='true'][aria-label^='Select ']").click();
  await expect(count).toHaveText("0 selected");
  await bar.getByRole("button", { name: "Close folder" }).click();
  await expect(bar.getByRole("button", { name: "Select all shown" })).toBeFocused();
});

test("Call to action puts one button on the share pages of the selected videos, or takes theirs off", async ({ page }) => {
  const tag = Date.now().toString(36);
  const made = await page.request.post("/api/videos/batch", {
    data: { title: `Buttons ${tag}`, scriptTemplate: "Hello {name}.", csv: "name\nAda\nBo", avatarId: "stock_1", voiceId: "stock_voice_1" },
  });
  expect(made.status()).toBe(201);
  const { batchId } = (await made.json()) as { batchId: string };
  const listed = async () => ((await (await page.request.get(`/api/videos?batch=${batchId}`)).json()) as { videos: Array<{ id: string; status: string; shareCta?: { label: string; url: string } }> }).videos;
  // Rendered, so their share pages show.
  await expect.poll(async () => (await Promise.all((await listed()).map(async (v) => ((await (await page.request.get(`/api/videos/${v.id}`)).json()) as { video: { status: string } }).video.status))).join(","), { timeout: 30_000 }).toBe("completed,completed");
  const [first, second] = await listed();
  expect((await page.request.patch(`/api/videos/${second.id}`, { data: { shareCta: { label: "Old offer", url: "https://example.com/old" } } })).status()).toBe(200);
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.accept();
  });
  const sent: string[] = [];
  page.on("request", (r) => r.url().endsWith("/api/videos/bulk") && sent.push(r.postData() ?? ""));

  await page.goto(`/videos?batch=${batchId}`);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const bar = page.getByTestId("bulk-bar");
  await expect(page.locator("button[aria-pressed][aria-label^='Select ']")).toHaveCount(2);
  await page.keyboard.press("Control+a");
  await expect(bar.getByText(/selected$/)).toHaveText("2 selected");
  await bar.getByRole("button", { name: "Call to action" }).click();
  const label = page.getByLabel("Button text for the selected videos");
  await expect(label).toBeFocused();
  // Pasted text with spaces around it is trimmed rather than cut short.
  await label.fill(`   Book a viewing${" ".repeat(40)}`);
  // A link that is not a web address is refused before anything is sent.
  await page.getByLabel("Button link for the selected videos").fill("example.com/book");
  await page.getByTestId("bulk-cta").getByRole("button", { name: "Set button" }).click();
  await expect(page.getByText("The button's link must start with http:// or https://")).toBeVisible();
  expect(sent).toEqual([]);
  await page.getByLabel("Button link for the selected videos").fill("https://example.com/book");
  await page.getByLabel("Button link for the selected videos").press("Enter");
  await expect(bar).toHaveCount(0);
  expect(dialogs).toEqual(["1 selected video has a button already, which this replaces. Set this button?"]);
  expect((await listed()).map((v) => v.shareCta)).toEqual([
    { label: "Book a viewing", url: "https://example.com/book" },
    { label: "Book a viewing", url: "https://example.com/book" },
  ]);
  for (const v of [first, second]) {
    await page.goto(`/share/${v.id}`);
    await expect(page.getByTestId("share-cta")).toHaveText(/^Book a viewing/);
    await expect(page.getByTestId("share-cta")).toHaveAttribute("href", "https://example.com/book");
  }

  // No button takes them off, after saying what goes; Escape closes the field without a change.
  await page.goto(`/videos?batch=${batchId}`);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await expect(page.locator("button[aria-pressed][aria-label^='Select ']")).toHaveCount(2);
  await page.keyboard.press("Control+a");
  await bar.getByRole("button", { name: "Call to action" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("bulk-cta")).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Call to action" })).toBeFocused();
  await bar.getByRole("button", { name: "Call to action" }).click();
  await page.getByTestId("bulk-cta").getByRole("button", { name: "No button" }).click();
  await expect(bar).toHaveCount(0);
  expect(dialogs[1]).toBe("2 selected videos have a button on their share pages. Remove them?");
  expect((await listed()).map((v) => v.shareCta)).toEqual([undefined, undefined]);
  await page.goto(`/share/${first.id}`);
  await expect(page.getByTestId("share-player")).toBeVisible();
  await expect(page.getByTestId("share-cta")).toHaveCount(0);
});

test("a finished video's card plays its clip, muted, while a mouse rests on it or the keyboard focuses it", async ({ page, browser }) => {
  const title = `Hover ${Date.now().toString(36)}`;
  const v = await createVideoViaApi(page, title);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  const { videoUrl } = (await (await page.request.get(`/api/videos/${v.id}`)).json()).video as { videoUrl: string };
  // The page's clock, so the wait before a clip starts is measured rather than slept through.
  await page.clock.install();
  await page.goto("/videos");
  const link = page.locator(`a[href="/videos/${v.id}"]`);
  const preview = link.getByTestId("card-preview");
  const heading = page.getByRole("heading", { name: "My videos" });
  await expect(link).toBeVisible();
  await expect(preview).toHaveCount(0);
  // Held still from here, so only the time the test runs on counts: an installed clock otherwise keeps
  // flowing, and a slow step on a busy machine could carry the wait past 300 ms before it is checked.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await link.hover();
  await page.clock.runFor(250);
  await expect(preview).toHaveCount(0);
  await page.clock.runFor(100);
  await expect(preview).toHaveAttribute("src", videoUrl);
  await expect(preview).toHaveJSProperty("muted", true);
  await expect(preview).toHaveJSProperty("loop", true);
  // The status badge is drawn on top of the clip, not under it.
  const badge = link.getByText("Completed", { exact: true });
  expect(
    await badge.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !!hit && (hit === el || el.contains(hit));
    }),
  ).toBe(true);
  // Moving onto the card's copy button keeps it playing; leaving the card stops it.
  await page.getByRole("button", { name: `Copy link for ${title}` }).hover();
  await page.clock.runFor(400);
  await expect(preview).toHaveCount(1);
  await heading.hover();
  await expect(preview).toHaveCount(0);
  // A pointer passing over the card loads nothing.
  await link.hover();
  await page.clock.runFor(100);
  await heading.hover();
  await page.clock.runFor(400);
  await expect(preview).toHaveCount(0);

  // The keyboard gets it too, and Tab from the card to its copy button keeps it going.
  await page.getByRole("button", { name: "Select", exact: true }).focus();
  for (let i = 0; i < 80 && !(await link.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  await page.clock.runFor(350);
  await expect(preview).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: `Copy link for ${title}` })).toBeFocused();
  await page.clock.runFor(400);
  await expect(preview).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(preview).toHaveCount(0);

  // Ending a selection with Escape replaces the focused card's button; the clip goes with it.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const pick = page.getByRole("button", { name: `Select ${title}` });
  await pick.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(pick).toBeFocused();
  await page.clock.runFor(350);
  await expect(pick.getByTestId("card-preview")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(pick).toHaveCount(0);
  await page.clock.runFor(400);
  await expect(preview).toHaveCount(0);

  // A reader who asks for less motion is shown the poster only.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await link.hover();
  await page.clock.runFor(600);
  await expect(preview).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // A tap is not a hover: tapping the copy button on a phone starts no clip.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, baseURL: "http://localhost:3100" });
  try {
    const tab = await phone.newPage();
    await tab.goto("/videos");
    await tab.getByRole("button", { name: `Copy link for ${title}` }).tap();
    await tab.waitForTimeout(700);
    await expect(tab.locator(`a[href="/videos/${v.id}"]`).getByTestId("card-preview")).toHaveCount(0);
  } finally {
    await phone.close();
  }
});

test("Cover gives the selected videos one cover picture, or takes theirs off", async ({ page }) => {
  const tag = Date.now().toString(36);
  const made = await page.request.post("/api/videos/batch", {
    data: { title: `Covers ${tag}`, scriptTemplate: "Hello {name}.", csv: "name\nAda\nBo", avatarId: "stock_1", voiceId: "stock_voice_1" },
  });
  expect(made.status()).toBe(201);
  const { batchId } = (await made.json()) as { batchId: string };
  type Listed = { id: string; status: string; cover?: { updatedAt: string; mimeType: string } };
  const listed = async () => ((await (await page.request.get(`/api/videos?batch=${batchId}`)).json()) as { videos: Listed[] }).videos;
  await expect.poll(async () => (await Promise.all((await listed()).map(async (v) => ((await (await page.request.get(`/api/videos/${v.id}`)).json()) as { video: { status: string } }).video.status))).join(","), { timeout: 30_000 }).toBe("completed,completed");
  const [first, second] = await listed();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  expect((await page.request.patch(`/api/videos/${second.id}`, { data: { cover: `data:image/png;base64,${png.toString("base64")}` } })).status()).toBe(200);
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.accept();
  });
  const sent: string[] = [];
  page.on("request", (r) => r.url().endsWith("/api/videos/bulk") && sent.push(r.postData() ?? ""));

  await page.goto(`/videos?batch=${batchId}`);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const bar = page.getByTestId("bulk-bar");
  await expect(page.locator("button[aria-pressed][aria-label^='Select ']")).toHaveCount(2);
  await page.keyboard.press("Control+a");
  await expect(bar.getByText(/selected$/)).toHaveText("2 selected");
  await bar.getByRole("button", { name: "Cover", exact: true }).click();
  const field = page.getByTestId("bulk-cover");
  const picker = page.getByLabel(/for the selected videos' cover$/);
  await expect(picker).toBeFocused();
  await expect(field.getByRole("button", { name: "Set cover" })).toBeDisabled();
  // A file that is not a picture is refused in the browser, and nothing is sent.
  await picker.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a picture") });
  await expect(page.getByText("That file is not an image")).toBeVisible();
  await expect(field.getByRole("button", { name: "Set cover" })).toBeDisabled();
  await picker.setInputFiles({ name: "launch.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText("That file is not an image")).toHaveCount(0);
  await expect(field.getByText("launch.png")).toBeVisible();
  await expect(page.getByTestId("bulk-cover-preview")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  expect(sent).toEqual([]);
  await field.getByRole("button", { name: "Set cover" }).click();
  await expect(bar).toHaveCount(0);
  expect(dialogs).toEqual(["1 selected video has a cover already, which this replaces. Set this cover?"]);
  // Each video has its own copy, sent once as the JPEG the browser made, and the cards and share pages show it.
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0])).toMatchObject({ action: "cover", ids: expect.arrayContaining([first.id, second.id]), cover: expect.stringMatching(/^data:image\/jpeg;base64,/) });
  const covered = await listed();
  expect(covered.map((v) => v.cover?.mimeType)).toEqual(["image/jpeg", "image/jpeg"]);
  for (const v of covered) {
    await expect(page.locator(`a[href="/videos/${v.id}"] img`)).toHaveAttribute("src", `/api/videos/${v.id}/cover?v=${Date.parse(v.cover!.updatedAt)}`);
    const served = await page.request.get(`/api/videos/${v.id}/cover?v=${Date.parse(v.cover!.updatedAt)}`);
    expect(served.status()).toBe(200);
    expect(served.headers()["content-type"]).toBe("image/jpeg");
    expect(await (await page.request.get(`/share/${v.id}`)).text()).toContain(`/api/videos/${v.id}/cover?v=`);
  }

  // No cover takes them off, after saying what the share pages show instead; Escape closes the field without a change.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await expect(page.locator("button[aria-pressed][aria-label^='Select ']")).toHaveCount(2);
  await page.keyboard.press("Control+a");
  await bar.getByRole("button", { name: "Cover", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Cover", exact: true })).toBeFocused();
  await bar.getByRole("button", { name: "Cover", exact: true }).click();
  await field.getByRole("button", { name: "No cover" }).click();
  await expect(bar).toHaveCount(0);
  expect(dialogs[1]).toBe("2 selected videos have a cover; without one the share page shows the renderer's own picture of the video. Remove them?");
  expect((await listed()).map((v) => v.cover)).toEqual([undefined, undefined]);
  for (const v of [first, second]) expect((await page.request.get(`/api/videos/${v.id}/cover`)).status()).toBe(404);

  // With no cover left to remove, the bar says so and sends nothing.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await expect(page.locator("button[aria-pressed][aria-label^='Select ']")).toHaveCount(2);
  await page.keyboard.press("Control+a");
  await bar.getByRole("button", { name: "Cover", exact: true }).click();
  await field.getByRole("button", { name: "No cover" }).click();
  await expect(page.getByText("None of the selected videos has a cover to remove.")).toBeVisible();
  // One video selected, the same, in the singular.
  await page.getByRole("button", { name: "Done selecting" }).click();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.locator(`button[aria-pressed][aria-label^='Select ']`).first().click();
  await expect(bar.getByText(/selected$/)).toHaveText("1 selected");
  await bar.getByRole("button", { name: "Cover", exact: true }).click();
  await field.getByRole("button", { name: "No cover" }).click();
  await expect(page.getByText("The selected video has no cover to remove.")).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(dialogs).toHaveLength(2);
});

test("Copy links puts the selected videos' sendable share links on the clipboard, one a line", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const tag = Date.now().toString(36);
  const made = await page.request.post("/api/videos/batch", {
    data: { title: `Copy ${tag}`, scriptTemplate: "Hello {name}.", csv: "name\nAda\nBo\nCy", avatarId: "stock_1", voiceId: "stock_voice_1" },
  });
  expect(made.status()).toBe(201);
  const { batchId } = (await made.json()) as { batchId: string };
  const listed = async () => ((await (await page.request.get(`/api/videos?batch=${batchId}`)).json()) as { videos: Array<{ id: string; title: string }> }).videos;
  await expect.poll(async () => (await Promise.all((await listed()).map(async (v) => ((await (await page.request.get(`/api/videos/${v.id}`)).json()) as { video: { status: string } }).video.status))).join(","), { timeout: 30_000 }).toBe("completed,completed,completed");
  const shown = await listed();
  // One link is switched off, so it cannot be sent.
  const off = shown[1];
  expect((await page.request.patch(`/api/videos/${off.id}`, { data: { shareDisabled: true } })).status()).toBe(200);

  await page.goto(`/videos?batch=${batchId}`);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const bar = page.getByTestId("bulk-bar");
  await expect(page.locator("button[aria-pressed][aria-label^='Select ']")).toHaveCount(3);
  await page.keyboard.press("Control+a");
  await bar.getByRole("button", { name: "Copy links" }).click();
  await expect(page.getByTestId("copy-note")).toHaveText("Copied 2 links; left out: 1 has no link that can be sent yet");
  const origin = new URL(page.url()).origin;
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).split("\n");
  expect(copied).toHaveLength(2);
  expect(copied.every((l) => l.startsWith(`${origin}/share/`))).toBe(true);
  expect(copied.some((l) => l.endsWith(off.id))).toBe(false);
  expect(new Set(copied)).toEqual(new Set(shown.filter((v) => v.id !== off.id).map((v) => `${origin}/share/${v.id}`)));
  // A change of selection clears the note.
  await page.locator("button[aria-pressed='true'][aria-label^='Select ']").first().click();
  await expect(page.getByTestId("copy-note")).toHaveText("");

  // With only the switched-off video chosen, nothing is copied and the bar says why.
  await page.evaluate(() => navigator.clipboard.writeText("unchanged"));
  await bar.getByRole("button", { name: "Done selecting" }).click();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: `Select ${off.title}`, exact: true }).click();
  await expect(bar.getByText(/selected$/)).toHaveText("1 selected");
  await bar.getByRole("button", { name: "Copy links" }).click();
  const nothing = page.getByText(/^None of the selected videos has a link that can be sent yet/);
  await expect(nothing).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("unchanged");
  // Adding a video that can be sent clears that, and the copy that follows says only what it did.
  const other = shown.find((v) => v.id !== off.id)!;
  await page.getByRole("button", { name: `Select ${other.title}`, exact: true }).click();
  await expect(nothing).toHaveCount(0);
  await bar.getByRole("button", { name: "Copy links" }).click();
  await expect(page.getByTestId("copy-note")).toHaveText("Copied 1 link; left out: 1 has no link that can be sent yet");
  await expect(nothing).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/share/${other.id}`);
  // A refusal from the browser says so and points at the file instead.
  await page.evaluate(() => {
    navigator.clipboard.write = () => Promise.reject(new DOMException("Denied", "NotAllowedError"));
  });
  await bar.getByRole("button", { name: "Copy links" }).click();
  await expect(page.getByText("The browser did not let the page copy to the clipboard; Download links gives the same links as a file.")).toBeVisible();
  await expect(page.getByTestId("copy-note")).toHaveText("");
});

test("a video's share link has a QR code to print, saved as an SVG or a PNG, or copied as a picture, that scans back to the link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const v = await createVideoViaApi(page, "Open house QR");
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  await page.goto(`/videos/${v.id}`);
  const card = page.getByTestId("share-qr-card");
  const qr = card.getByRole("img", { name: "QR code for the share link" });
  await expect(qr).toBeVisible();
  const shareUrl = `${new URL(page.url()).origin}/share/${v.id}`;

  // The SVG is a file of its own, named after the video, sharp at any size.
  const svgDownload = page.waitForEvent("download");
  await card.getByRole("button", { name: "Download SVG" }).click();
  const svgFile = await svgDownload;
  expect(svgFile.suggestedFilename()).toBe("qr-Open house QR.svg");
  const svg = await readFile((await svgFile.path())!, "utf8");
  expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
  expect(svg).toContain("<title>Scan to watch “Open house QR”</title>");
  // It draws what the page shows.
  expect(svg).toContain(`d="${await qr.locator("path").getAttribute("d")}"`);

  // The PNG, read back pixel by pixel, scans to the share link.
  const pngDownload = page.waitForEvent("download");
  await card.getByRole("button", { name: "Download PNG" }).click();
  const pngFile = await pngDownload;
  expect(pngFile.suggestedFilename()).toBe("qr-Open house QR.png");
  const png = (await readFile((await pngFile.path())!)).toString("base64");
  /** The picture's width, and what a camera reads from it drawn at 256 pixels. */
  const scan = async (data: string) => {
    const read = await page.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, 256, 256);
      return { width: img.naturalWidth, pixels: Array.from(ctx.getImageData(0, 0, 256, 256).data) };
    }, data);
    return { width: read.width, text: jsQR(new Uint8ClampedArray(read.pixels), 256, 256)?.data };
  };
  expect(await scan(png)).toEqual({ width: 1024, text: shareUrl });

  // Copy image puts the same PNG on the clipboard, to paste straight into a slide.
  await card.getByRole("button", { name: "Copy image" }).click();
  await expect(card.getByTestId("qr-copy-note")).toHaveText("Copied: paste it into a slide, a flyer, or a document.");
  const pasted = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const bytes = new Uint8Array(await (await item.getType("image/png")).arrayBuffer());
    return { types: item.types, data: btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")) };
  });
  expect(pasted.types).toEqual(["image/png"]);
  expect(await scan(pasted.data)).toEqual({ width: 1024, text: shareUrl });
  // A browser that cannot copy pictures says so, and the earlier note goes.
  await page.evaluate(() => {
    const w = window as { ClipboardItem?: unknown };
    const saved = w.ClipboardItem;
    delete w.ClipboardItem;
    (window as unknown as { restoreClipboardItem: () => void }).restoreClipboardItem = () => void (w.ClipboardItem = saved);
  });
  await card.getByRole("button", { name: "Copy image" }).click();
  await expect(card.getByText("This browser cannot copy pictures; use Download PNG instead.")).toBeVisible();
  await expect(card.getByTestId("qr-copy-note")).toHaveText("");
  await page.evaluate(() => (window as unknown as { restoreClipboardItem: () => void }).restoreClipboardItem());
  // A refused write says so.
  await page.evaluate(() => {
    navigator.clipboard.write = () => Promise.reject(new DOMException("Denied", "NotAllowedError"));
  });
  await card.getByRole("button", { name: "Copy image" }).click();
  await expect(card.getByText("The browser did not let the page copy the picture; use Download PNG instead.")).toBeVisible();
  await expect(card.getByTestId("qr-copy-note")).toHaveText("");

  // A link with an expiry says when a printed code stops working.
  const expires = new Date(Date.now() + 3 * 86_400_000).toISOString();
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareExpiresAt: expires } })).status()).toBe(200);
  await page.reload();
  await expect(page.getByTestId("share-qr-card")).toContainText(/It stops working .+, when the link expires\./);
  await expect(page.getByTestId("share-qr")).toBeVisible();

  // Once the link expires, while the page is open, the share cards say so rather than to turn the link on.
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareExpiresAt: new Date(Date.now() + 10_000).toISOString() } })).status()).toBe(200);
  await page.reload();
  await expect(page.getByTestId("share-qr")).toBeVisible();
  for (const id of ["share-qr-card", "share-social-card", "share-email-card"]) {
    await expect(page.getByTestId(id)).toContainText("Link expired: set a later expiry first.", { timeout: 15_000 });
    await expect(page.getByTestId(id)).not.toContainText("Turn the share link on first.");
  }
  await expect(page.getByTestId("share-qr")).toHaveCount(0);

  // With the link switched off there is nothing to scan to.
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareDisabled: true, shareExpiresAt: null } })).status()).toBe(200);
  await page.reload();
  await expect(page.getByTestId("share-qr-card")).toContainText("Turn the share link on first.");
  await expect(page.getByTestId("share-qr")).toHaveCount(0);
});

test("a shared presenter's row has a QR code of its talk link, for a sign at an open house, that scans back to the link", async ({ page }) => {
  const name = `Open house host ${Date.now().toString(36)}`;
  const agent = (await (await page.request.post("/api/agents", { data: { name, avatarId: "stock_1", isPublic: true } })).json()).agent as { id: string };
  try {
    await page.goto("/interactive");
    const open = page.getByRole("button", { name: `QR code for ${name}`, exact: true });
    await expect(open).toHaveAttribute("aria-expanded", "false");
    await open.click();
    await expect(open).toHaveAttribute("aria-expanded", "true");
    const panel = page.getByRole("region", { name: `QR code for ${name}` });
    await expect(panel).toContainText(`visitors chat with ${name}`);
    await expect(panel.getByRole("img", { name: "QR code for the talk link" })).toBeVisible();
    const talkUrl = `${new URL(page.url()).origin}/talk/${agent.id}`;

    // The SVG is named after the presenter and says what scanning does.
    const svgDownload = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Download SVG" }).click();
    const svgFile = await svgDownload;
    expect(svgFile.suggestedFilename()).toBe(`qr-${name}.svg`);
    const svg = await readFile((await svgFile.path())!, "utf8");
    expect(svg).toContain(`<title>Scan to talk to “${name}”</title>`);
    // It draws what the page shows.
    expect(svg).toContain(`d="${await panel.getByRole("img", { name: "QR code for the talk link" }).locator("path").getAttribute("d")}"`);

    // The PNG scans to the talk page.
    const pngDownload = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Download PNG" }).click();
    const png = (await readFile((await (await pngDownload).path())!)).toString("base64");
    const read = await page.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, 256, 256);
      return Array.from(ctx.getImageData(0, 0, 256, 256).data);
    }, png);
    expect(jsQR(new Uint8ClampedArray(read), 256, 256)?.data).toBe(talkUrl);
    // The presenter it opens is there to talk to.
    expect((await page.request.get(`/api/talk/${agent.id}`)).status()).toBe(200);

    // With the link off there is nothing to scan to, and the panel says so.
    await page.getByRole("button", { name: `Turn off link for ${name}`, exact: true }).click();
    await expect(page.getByRole("button", { name: `Turn on link for ${name}`, exact: true })).toBeVisible();
    await expect(panel.getByRole("status")).toHaveText("Turn the link on first: while it is off, scanning it shows “This presenter is not available”.");
    await expect(panel.getByRole("img")).toHaveCount(0);
    expect((await page.request.get(`/api/talk/${agent.id}`)).status()).toBe(404);
    // The button closes it again.
    await open.click();
    await expect(page.getByTestId("agent-qr")).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/agents/${agent.id}`);
  }
});

test("QR codes saves a zip of a QR code of each selected video's sendable share link, named after the video", async ({ page }) => {
  const tag = Date.now().toString(36);
  const made = await page.request.post("/api/videos/batch", {
    data: { title: `Flyer ${tag}`, scriptTemplate: "Hello {name}.", csv: "name\nAda\nBo\nCy", avatarId: "stock_1", voiceId: "stock_voice_1" },
  });
  expect(made.status()).toBe(201);
  const { batchId } = (await made.json()) as { batchId: string };
  const listed = async () => ((await (await page.request.get(`/api/videos?batch=${batchId}`)).json()) as { videos: Array<{ id: string; title: string }> }).videos;
  await expect.poll(async () => (await Promise.all((await listed()).map(async (v) => ((await (await page.request.get(`/api/videos/${v.id}`)).json()) as { video: { status: string } }).video.status))).join(","), { timeout: 30_000 }).toBe("completed,completed,completed");
  const shown = await listed();
  const off = shown[1];
  expect((await page.request.patch(`/api/videos/${off.id}`, { data: { shareDisabled: true } })).status()).toBe(200);

  await page.goto(`/videos?batch=${batchId}`);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const bar = page.getByTestId("bulk-bar");
  await expect(page.locator("button[aria-pressed][aria-label^='Select ']")).toHaveCount(3);
  await page.keyboard.press("Control+a");
  const download = page.waitForEvent("download");
  await bar.getByRole("button", { name: "QR codes" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^qr-codes-\d{4}-\d{2}-\d{2}\.zip$/);
  await expect(page.getByTestId("copy-note")).toHaveText("Saved 2 QR codes; left out: 1 has no link that can be sent yet");

  // One SVG a sendable video, named after it; the switched-off one has none.
  const entries = unzipSync(new Uint8Array(await readFile((await file.path())!)));
  const sendable = shown.filter((v) => v.id !== off.id);
  expect(Object.keys(entries).sort()).toEqual(sendable.map((v) => `qr-${v.title}.svg`).sort());
  const origin = new URL(page.url()).origin;
  for (const v of sendable) {
    const svg = strFromU8(entries[`qr-${v.title}.svg`]);
    expect(svg).toContain(`<title>Scan to watch “${v.title}”</title>`);
    // Drawn in the browser and read back, it scans to that video's share link.
    const pixels = await page.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data)}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 400;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, 400, 400);
      return Array.from(ctx.getImageData(0, 0, 400, 400).data);
    }, svg);
    expect(jsQR(new Uint8ClampedArray(pixels), 400, 400)?.data).toBe(`${origin}/share/${v.id}`);
  }

  // With only the switched-off video chosen, nothing is saved and the bar says why.
  await bar.getByRole("button", { name: "Done selecting" }).click();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: `Select ${off.title}`, exact: true }).click();
  await expect(bar.getByText(/selected$/)).toHaveText("1 selected");
  let saved = false;
  page.on("download", () => (saved = true));
  await bar.getByRole("button", { name: "QR codes" }).click();
  const refused = page.getByText(/^None of the selected videos has a link that can be sent yet/);
  await expect(refused).toBeVisible();
  await expect(page.getByTestId("copy-note")).toHaveText("");
  expect(saved).toBe(false);
  // Adding a video that can be sent clears that refusal, and the file that follows says only what it holds.
  await page.getByRole("button", { name: `Select ${sendable[0].title}`, exact: true }).click();
  await expect(refused).toHaveCount(0);
  const again = page.waitForEvent("download");
  await bar.getByRole("button", { name: "QR codes" }).click();
  expect(Object.keys(unzipSync(new Uint8Array(await readFile((await (await again).path())!))))).toEqual([`qr-${sendable[0].title}.svg`]);
  await expect(page.getByTestId("copy-note")).toHaveText("Saved 1 QR code; left out: 1 has no link that can be sent yet");
  // A refusal shown again after a selection change goes once a later file is saved.
  await page.getByRole("button", { name: `Select ${sendable[0].title}`, exact: true }).click();
  await bar.getByRole("button", { name: "QR codes" }).click();
  await expect(refused).toBeVisible();
  await page.getByRole("button", { name: `Select ${sendable[1].title}`, exact: true }).click();
  await bar.getByRole("button", { name: "QR codes" }).click();
  await expect(page.getByTestId("copy-note")).toHaveText("Saved 1 QR code; left out: 1 has no link that can be sent yet");
  await expect(refused).toHaveCount(0);
});

test("a library card copies its video's share link in one click, when the link can be sent", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  // The page's clock, so a step below can move its time on without its timers firing.
  await page.clock.install();
  const tag = Date.now().toString(36);
  const made = await page.request.post("/api/videos/batch", {
    data: { title: `Card ${tag}`, scriptTemplate: "Hello {name}.", csv: "name\nAda\nBo", avatarId: "stock_1", voiceId: "stock_voice_1" },
  });
  expect(made.status()).toBe(201);
  const { batchId } = (await made.json()) as { batchId: string };
  const listed = async () => ((await (await page.request.get(`/api/videos?batch=${batchId}`)).json()) as { videos: Array<{ id: string; title: string }> }).videos;
  await expect.poll(async () => (await Promise.all((await listed()).map(async (v) => ((await (await page.request.get(`/api/videos/${v.id}`)).json()) as { video: { status: string } }).video.status))).join(","), { timeout: 30_000 }).toBe("completed,completed");
  const [live, off] = await listed();
  expect((await page.request.patch(`/api/videos/${off.id}`, { data: { shareDisabled: true } })).status()).toBe(200);

  await page.goto(`/videos?batch=${batchId}`);
  const origin = new URL(page.url()).origin;
  // Only the video whose link can be sent has the button; it sits beside the card's link, not inside it.
  const copy = page.getByRole("button", { name: `Copy link for ${live.title}`, exact: true });
  await expect(copy).toBeVisible();
  await expect(page.getByRole("button", { name: `Copy link for ${off.title}`, exact: true })).toHaveCount(0);
  expect(await copy.evaluate((el) => !!el.closest("a"))).toBe(false);
  await copy.click();
  await expect(page.getByTestId("card-copy-note")).toHaveText(`Link for ${live.title} copied`);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/share/${live.id}`);
  // Copying did not open the video.
  expect(new URL(page.url()).pathname).toBe("/videos");

  // The list's rows have it too.
  await page.evaluate(() => navigator.clipboard.writeText("unchanged"));
  await page.getByRole("group", { name: "Layout" }).getByRole("button", { name: "List" }).click();
  await expect(page.getByTestId("video-row")).toHaveCount(2);
  await page.getByRole("button", { name: `Copy link for ${live.title}`, exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/share/${live.id}`);
  await expect(page.getByRole("button", { name: `Copy link for ${off.title}`, exact: true })).toHaveCount(0);

  // Rows line up whether or not they have the button, and the page passes an accessibility check with them.
  const rowBox = async (title: string) => (await page.getByTestId("video-row").filter({ hasText: title }).getByText("Completed", { exact: true }).boundingBox())?.x;
  expect(await rowBox(off.title)).toBe(await rowBox(live.title));
  const axe = await new AxeBuilder({ page }).include("[data-testid='video-list']").analyze();
  expect(axe.violations).toEqual([]);

  // While selecting, a click picks the video, so there is nothing to copy from.
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Copy link for / })).toHaveCount(0);
  await page.getByRole("button", { name: "Done selecting" }).click();

  // A link that expires while the page stands open loses its button then, without a reload.
  const expires = Date.now() + 6000;
  expect((await page.request.patch(`/api/videos/${live.id}`, { data: { shareExpiresAt: new Date(expires).toISOString() } })).status()).toBe(200);
  await page.reload();
  const button = page.getByRole("button", { name: `Copy link for ${live.title}`, exact: true });
  await expect(button).toBeVisible();
  await expect(button).toHaveCount(0, { timeout: expires - Date.now() + 5000 });

  // A link that expired before the page could draw itself again (a tab the browser held back) is still not copied when
  // clicked: the page says so and reads the list again.
  const later = Date.now() + 10 * 60_000;
  expect((await page.request.patch(`/api/videos/${live.id}`, { data: { shareExpiresAt: new Date(later).toISOString() } })).status()).toBe(200);
  await page.reload();
  await expect(button).toBeVisible();
  await page.evaluate(() => navigator.clipboard.writeText("unchanged"));
  await page.clock.setSystemTime(later + 1000);
  await button.click();
  await expect(page.getByTestId("card-copy-note")).toHaveText(`The link for ${live.title} can no longer be sent; open the video to see why.`);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("unchanged");
});

test("the library follows a shown video's share link going live and expiring, with no reload", async ({ page }) => {
  const title = `Timed ${Date.now().toString(36)}`;
  const v = { ...(await createVideoViaApi(page, title)), title };
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  const live = Date.now() + 12_000;
  const ends = live + 10_000;
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareStartsAt: new Date(live).toISOString(), shareExpiresAt: new Date(ends).toISOString() } })).status()).toBe(200);
  // Each list read is answered as it first was, so a poll (another video still rendering) cannot change the cards:
  // only the page's own timer can.
  const answers = new Map<string, string>();
  await page.route("**/api/videos?*", async (route) => {
    const url = route.request().url();
    if (!answers.has(url)) answers.set(url, await (await route.fetch()).text());
    await route.fulfill({ status: 200, contentType: "application/json", body: answers.get(url)! });
  });
  await page.goto("/videos");
  await page.getByLabel("Search videos").fill(v.title);
  const card = page.locator(`a[href="/videos/${v.id}"]`);
  await expect(card).toContainText("Scheduled");
  const copy = page.getByRole("button", { name: `Copy link for ${v.title}`, exact: true });
  await expect(copy).toHaveCount(0);
  // Nothing reloads the page from here on: the timer alone redraws it.
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
  // It goes live: the card says so and offers its link.
  await expect(copy).toBeVisible({ timeout: live - Date.now() + 5000 });
  await expect(card).not.toContainText("Scheduled");
  await expect(card).toContainText(/Expires in 1 hour/);
  // It expires: the button goes and the card says so.
  await expect(copy).toHaveCount(0, { timeout: ends - Date.now() + 5000 });
  await expect(card).toContainText("Expired");
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
});

test("filtered to links going live later, the library drops a video once its link goes live, with no reload", async ({ page }) => {
  const title = `Soon ${Date.now().toString(36)}`;
  const v = await createVideoViaApi(page, title);
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
  const live = Date.now() + 12_000;
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareStartsAt: new Date(live).toISOString() } })).status()).toBe(200);
  await page.goto("/videos");
  await page.getByLabel("Filter by share link").selectOption("scheduled");
  await page.getByLabel("Search videos").fill(title);
  const card = page.locator(`a[href="/videos/${v.id}"]`);
  await expect(card).toContainText("Scheduled");
  // At go-live the list is read again, and the video no longer matches the filter.
  await expect(card).toHaveCount(0, { timeout: live - Date.now() + 8000 });
  await page.getByLabel("Filter by share link").selectOption("live");
  await expect(card).toBeVisible();
});

test("home points out share links expiring within a week or expired, each line opening the library filtered to them", async ({ page }) => {
  const stamp = Date.now().toString(36);
  const made: { id: string }[] = [];
  try {
    const soon = await createVideoViaApi(page, `Lapsing ${stamp}`);
    made.push(soon);
    const gone = await createVideoViaApi(page, `Lapsed ${stamp}`);
    made.push(gone);
    expect((await page.request.patch(`/api/videos/${soon.id}`, { data: { shareExpiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString() } })).status()).toBe(200);
    expect((await page.request.patch(`/api/videos/${gone.id}`, { data: { shareExpiresAt: new Date(Date.now() + 3_000).toISOString() } })).status()).toBe(200);
    const ids = async (share: string) => ((await (await page.request.get(`/api/videos?share=${share}`)).json()).videos as { id: string }[]).map((v) => v.id);
    await expect.poll(() => ids("expired"), { timeout: 15_000 }).toContain(gone.id);
    // Other tests' videos may have links in either state too: the notice counts what the library's filters list.
    const expiring = (await ids("expiring")).length;
    const expired = (await ids("expired")).length;
    await page.goto("/home");
    const notice = page.getByRole("region", { name: "Things to check" });
    await expect(notice).toContainText(expiring === 1 ? "1 share link expires within a week." : `${expiring} share links expire within a week.`);
    await expect(notice).toContainText(expired === 1 ? "1 share link has expired but is still on: visitors see that it has expired." : `${expired} share links have expired but are still on: visitors see that they have expired.`);

    await notice.getByRole("link", { name: "Show expiring links" }).click();
    await expect(page).toHaveURL(/\/videos\?share=expiring$/);
    await expect(page.getByLabel("Filter by share link")).toHaveValue("expiring");
    await expect(page.locator(`a[href="/videos/${soon.id}"]`)).toContainText(/Expires in 2 days/);
    await expect(page.locator(`a[href="/videos/${gone.id}"]`)).toHaveCount(0);

    await page.goBack();
    await page.getByRole("region", { name: "Things to check" }).getByRole("link", { name: "Show expired links" }).click();
    await expect(page).toHaveURL(/\/videos\?share=expired$/);
    await expect(page.getByLabel("Filter by share link")).toHaveValue("expired");
    await expect(page.locator(`a[href="/videos/${gone.id}"]`)).toContainText("Expired");
    await expect(page.locator(`a[href="/videos/${soon.id}"]`)).toHaveCount(0);

    // A share state the library does not know is ignored rather than filtering everything out.
    await page.goto("/videos?share=nonsense");
    await expect(page.getByLabel("Filter by share link")).toHaveValue("all");
    await expect(page.locator(`a[href="/videos/${soon.id}"]`)).toBeVisible();
    // The sidebar's My videos, from a filtered view, shows every link again.
    await page.goto("/videos?share=expired");
    await expect(page.getByLabel("Filter by share link")).toHaveValue("expired");
    await page.getByRole("link", { name: "My videos", exact: true }).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/videos$/);
    await expect(page.getByLabel("Filter by share link")).toHaveValue("all");

    // Home's own list, answered here: one link of each kind reads in the singular, and none shows no notice.
    const real = await (await page.request.get("/api/videos")).json();
    const one = (list: unknown[]) => page.route("**/api/videos", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...real, videos: list, openComments: {} }) }));
    const byId = (id: string) => (real.videos as { id: string }[]).find((v) => v.id === id)!;
    await one([byId(soon.id), byId(gone.id)]);
    await page.goto("/home");
    const single = page.getByRole("region", { name: "Things to check" }).getByRole("listitem");
    await expect(single).toHaveText(["1 share link expires within a week.Show expiring links", "1 share link has expired but is still on: visitors see that it has expired.Show expired links"]);
    await page.unroute("**/api/videos");
    await one([]);
    await page.goto("/home");
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
    await expect(page.getByTestId("home-attention")).toHaveCount(0);
  } finally {
    // Switched off, neither link is counted on home for the tests after this one.
    for (const v of made) await page.request.patch(`/api/videos/${v.id}`, { data: { shareDisabled: true } });
  }
});

test("home points out this week's failed renders, opening the library filtered to failed renders of the last 7 days", async ({ page }) => {
  const v = await createVideoViaApi(page, `Failing ${Date.now().toString(36)}`);
  try {
    const real = await (await page.request.get("/api/videos")).json();
    const mine = (real.videos as { id: string }[]).find((x) => x.id === v.id)!;
    // The demo renderer never fails, so Home is shown failed renders: one this week, one made too long ago to count, and
    // one already retried.
    const failed = (createdAt: string, id: string) => ({ ...mine, id, status: "failed", error: "The renderer gave up", createdAt, shareDisabled: true });
    const now = new Date().toISOString();
    const list = [failed(now, "vid_failed_now"), failed(new Date(Date.now() - 8 * 86_400_000).toISOString(), "vid_failed_old"), failed(now, "vid_failed_retried"), { ...mine, id: "vid_retry", retryOf: "vid_failed_retried" }];
    await page.route("**/api/videos", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...real, videos: list, openComments: {} }) }));
    await page.goto("/home");
    const notice = page.getByRole("region", { name: "Things to check" });
    await expect(notice.getByRole("listitem")).toHaveText(["1 render made in the last 7 days failed and has not been retried.Show failed renders"]);
    // The library asks the server for just those: the demo video is neither failed nor shown.
    const asked = page.waitForResponse((r) => /\/api\/videos\?/.test(r.url()) && new URL(r.url()).searchParams.get("status") === "failed" && new URL(r.url()).searchParams.get("created") === "7d");
    await notice.getByRole("link", { name: "Show failed renders" }).click();
    await expect(page).toHaveURL(/\/videos\?status=failed&created=7d$/);
    expect((await asked).ok()).toBe(true);
    await expect(page.getByRole("button", { name: "Failed", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Filter by date made")).toHaveValue("7d");
    await expect(page.getByLabel("Filter by share link")).toHaveValue("all");
    await expect(page.locator(`a[href="/videos/${v.id}"]`)).toHaveCount(0);
    // The sidebar's My videos clears what the address asked for.
    await page.getByRole("link", { name: "My videos", exact: true }).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/videos$/);
    await expect(page.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Filter by date made")).toHaveValue("all");
    await expect(page.locator(`a[href="/videos/${v.id}"]`)).toBeVisible();
    // Values the library does not know are ignored.
    await page.goto("/videos?status=queued&created=1y");
    await expect(page.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Filter by date made")).toHaveValue("all");
  } finally {
    await page.request.delete(`/api/videos/${v.id}?permanent=true`);
  }
});

test("home points out workspace videos waiting for review, opening the library filtered to them", async ({ page }) => {
  const tag = Date.now().toString(36);
  let ws: { id: string } | undefined;
  try {
    ws = (await (await page.request.post("/api/workspaces", { data: { name: `Reviews ${tag}` } })).json()).workspace as { id: string };
    expect((await page.request.post("/api/workspaces/switch", { data: { id: ws.id } })).status()).toBe(200);
    const waiting = await createVideoViaApi(page, `Waiting ${tag}`);
    const other = await createVideoViaApi(page, `Not asked ${tag}`);
    for (const v of [waiting, other]) await expect.poll(async () => (await (await page.request.get(`/api/videos/${v.id}`)).json()).video.status, { timeout: 30_000 }).toBe("completed");
    expect((await page.request.post(`/api/videos/${waiting.id}/review`, { data: { action: "request" } })).status()).toBe(200);
    await page.goto("/home");
    const notice = page.getByRole("region", { name: "Things to check" });
    // The workspace's owner is the one to decide.
    await expect(notice.getByRole("listitem")).toHaveText(["1 video is waiting for your review.Show videos in review"]);
    await notice.getByRole("link", { name: "Show videos in review" }).click();
    await expect(page).toHaveURL(/\/videos\?review=pending$/);
    await expect(page.getByLabel("Filter by review")).toHaveValue("pending");
    await expect(page.locator(`a[href="/videos/${waiting.id}"]`).getByTestId("review-badge")).toHaveText("In review");
    await expect(page.locator(`a[href="/videos/${other.id}"]`)).toHaveCount(0);
    // Once decided, it is no longer waiting, and Home says nothing.
    expect((await page.request.post(`/api/videos/${waiting.id}/review`, { data: { action: "approve" } })).status()).toBe(200);
    await page.goto("/home");
    // The list has arrived once its recent videos show; only then is a missing notice proof of nothing to check.
    await expect(page.locator(`a[href="/videos/${waiting.id}"]`)).toBeVisible();
    await expect(page.getByTestId("home-attention")).toHaveCount(0);
    // Back in the personal space, where there are no reviews, a review filter the address set still shows, to clear.
    expect((await page.request.post("/api/workspaces/switch", { data: { id: "local" } })).status()).toBe(200);
    await page.goto("/videos?review=pending");
    await expect(page.getByLabel("Filter by review")).toHaveValue("pending");
    await page.getByLabel("Filter by review").selectOption("all");
    await expect(page.getByLabel("Filter by review")).toHaveCount(0);
  } finally {
    await page.request.post("/api/workspaces/switch", { data: { id: "local" } });
    if (ws) expect((await page.request.delete(`/api/workspaces/${ws.id}`)).status()).toBe(204);
  }
});

test("home counts the comments no one has resolved, opening the library filtered to their videos", async ({ page }) => {
  const tag = Date.now().toString(36);
  let ws: { id: string } | undefined;
  try {
    // A workspace of its own, so notes other tests leave open are not counted.
    ws = (await (await page.request.post("/api/workspaces", { data: { name: `Notes ${tag}` } })).json()).workspace as { id: string };
    expect((await page.request.post("/api/workspaces/switch", { data: { id: ws.id } })).status()).toBe(200);
    const a = await createVideoViaApi(page, `First ${tag}`);
    const b = await createVideoViaApi(page, `Second ${tag}`);
    const quiet = await createVideoViaApi(page, `Quiet ${tag}`);
    const notes: Array<[string, string]> = [];
    for (const [v, text] of [[a, "Intro"], [a, "Outro"], [b, "Logo"]] as const) notes.push([v.id, (await (await page.request.post(`/api/videos/${v.id}/comments`, { data: { text } })).json()).comment.id]);
    await page.goto("/home");
    const line = page.getByTestId("open-comments-notice");
    await expect(line).toHaveText("3 comments on 2 videos are not resolved yet.Show videos with open comments");
    await line.getByRole("link", { name: "Show videos with open comments" }).click();
    await expect(page).toHaveURL(/\/videos\?comments=open$/);
    await expect(page.getByTestId("open-comments-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(`a[href="/videos/${a.id}"]`)).toBeVisible();
    await expect(page.locator(`a[href="/videos/${b.id}"]`)).toBeVisible();
    await expect(page.locator(`a[href="/videos/${quiet.id}"]`)).toHaveCount(0);
    // One left open reads in the singular; none left, and Home says nothing of it.
    for (const [videoId, id] of notes.slice(1)) await page.request.patch(`/api/videos/${videoId}/comments/${id}`, { data: { resolved: true } });
    await page.goto("/home");
    await expect(line).toHaveText("1 comment on 1 video is not resolved yet.Show videos with open comments");
    await page.request.patch(`/api/videos/${notes[0][0]}/comments/${notes[0][1]}`, { data: { resolved: true } });
    await page.goto("/home");
    await expect(page.locator(`a[href="/videos/${a.id}"]`)).toBeVisible();
    await expect(page.getByTestId("home-attention")).toHaveCount(0);
  } finally {
    await page.request.post("/api/workspaces/switch", { data: { id: "local" } });
    if (ws) await page.request.delete(`/api/workspaces/${ws.id}`);
  }
});

test("home names the open comments that mention you, opening the library filtered to them, where their cards are marked", async ({ page }) => {
  const tag = Date.now().toString(36);
  let ws: { id: string } | undefined;
  try {
    ws = (await (await page.request.post("/api/workspaces", { data: { name: `Mentions ${tag}` } })).json()).workspace as { id: string };
    expect((await page.request.post("/api/workspaces/switch", { data: { id: ws.id } })).status()).toBe(200);
    const a = await createVideoViaApi(page, `Named ${tag}`);
    // Demo mode has one user without an email, so no one can be mentioned for real: Home is told of two threads on one video.
    let mentions: Record<string, number> = { [a.id]: 2 };
    await page.route("**/api/videos", async (route) => {
      const real = await (await route.fetch()).json();
      await route.fulfill({ json: { ...real, openComments: {}, mentions } });
    });
    await page.goto("/home");
    const line = page.getByTestId("mentions-notice");
    await expect(line).toHaveText("2 open comments mention you, on 1 video.Show videos that mention you");
    mentions = { [a.id]: 1 };
    await page.reload();
    await expect(line).toHaveText("1 open comment mentions you, on 1 video.Show videos that mention you");
    await page.unroute("**/api/videos");
    await line.getByRole("link", { name: "Show videos that mention you" }).click();
    await expect(page).toHaveURL(/\/videos\?comments=mentions$/);
    // The library asks for the filter, which here matches nothing, and says so; Open comments is the other choice, not both.
    const toggle = page.getByTestId("mentions-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("open-comments-toggle")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByText("No open comment mentions you.")).toBeVisible();
    await page.getByTestId("open-comments-toggle").click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("open-comments-toggle")).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(page.getByTestId("open-comments-toggle")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByText("No open comment mentions you.")).toBeVisible();
    await toggle.click();
    await expect(page.locator(`a[href="/videos/${a.id}"]`)).toBeVisible();
    // A card whose open comments mention the reader carries an @ on its badge, and says how many mention them.
    await page.route("**/api/videos?*", async (route) => {
      const real = await (await route.fetch()).json();
      await route.fulfill({ json: { ...real, openComments: { ...real.openComments, [a.id]: 3 }, mentions: { [a.id]: 2 } } });
    });
    // The address still asks for Mentions me (Home's link), so the library is opened afresh at every video.
    await page.goto("/videos");
    const badge = page.getByTestId("open-comments-badge").and(page.locator("[data-mentions]"));
    await expect(badge).toHaveAttribute("data-mentions", "2");
    await expect(badge).toHaveAttribute("title", "3 open comments, 2 mention you");
    await expect(badge.locator(".sr-only")).toHaveText("3 open comments, 2 mention you");
    await page.unroute("**/api/videos?*");
    await page.goto("/videos");
    await expect(page.locator(`a[href="/videos/${a.id}"]`).first()).toBeVisible();
    await expect(page.locator("[data-mentions]")).toHaveCount(0);
    // Outside a workspace the toggle is not offered, unless the address set it.
    await page.request.post("/api/workspaces/switch", { data: { id: "local" } });
    await page.goto("/videos");
    await expect(page.getByTestId("open-comments-toggle")).toBeVisible();
    await expect(toggle).toHaveCount(0);
    await page.goto("/videos?comments=mentions");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect((await page.request.get("/api/videos?comments=mentions&limit=1")).status()).toBe(200);
  } finally {
    await page.request.post("/api/workspaces/switch", { data: { id: "local" } });
    if (ws) await page.request.delete(`/api/workspaces/${ws.id}`);
  }
});

test("home says when this month's renders are nearly or all used, linking to the plan and usage", async ({ page }) => {
  const real = await (await page.request.get("/api/status")).json();
  // The demo server has no allowance, so Home is shown one: first nearly used, then used up, then none.
  let usage: { limit: number | null; used: number } = { limit: 20, used: 17 };
  await page.route("**/api/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...real, renderLimitPerMonth: usage.limit, usage: { ...real.usage, rendersThisMonth: usage.used } }) }));
  const line = page.getByRole("region", { name: "Things to check" }).getByTestId("allowance-notice");
  await page.goto("/home");
  await expect(line).toHaveText("3 renders left this month (17 of 20 used).See plan and usage");
  usage = { limit: 20, used: 20 };
  await page.reload();
  // The date is written as the page writes it, in the browser's own language.
  const reopens = await page.evaluate(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toLocaleDateString(undefined, { month: "long", day: "numeric", timeZone: "UTC" });
  });
  await expect(line).toHaveText(`This month's renders are used up (20 of 20); renders can start again on ${reopens} (UTC).See plan and usage`);
  await line.getByRole("link", { name: "See plan and usage" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  // Plenty left, or no allowance at all: nothing is said.
  for (const u of [{ limit: 20, used: 15 }, { limit: null, used: 30 }]) {
    usage = u;
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/status");
    await page.goto("/home");
    await answered;
    // Home has drawn what the answer says once nothing more is loading.
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
    await expect(line).toHaveCount(0);
  }
});

test("home offers the editor's unsent draft to continue or discard", async ({ page }) => {
  const tag = Date.now().toString(36);
  await page.getByLabel("Video title").fill(`Open house ${tag}`);
  await page.locator("textarea").fill("Welcome to 12 Oak Lane. [pause 1s] Come in.");
  const stored = () => page.evaluate(() => (JSON.parse(localStorage.getItem("avatar-studio:draft") ?? "{}") as { title?: string }).title ?? null);
  await expect.poll(stored).toBe(`Open house ${tag}`);
  await page.goto("/home");
  const card = page.getByTestId("home-draft");
  await expect(card).toBeVisible();
  await expect(card.getByText(`Continue your draft: Open house ${tag}`)).toBeVisible();
  // Pause markers are not words.
  await expect(card.getByText(/^1 scene, 7 words, saved /)).toBeVisible();
  await expect(card.getByText("“Welcome to 12 Oak Lane. Come in.”")).toBeVisible();
  await card.getByRole("link", { name: "Continue editing" }).click();
  await expect(page).toHaveURL(/\/create$/);
  await expect(page.getByText("Restored your unsent draft")).toBeVisible();
  await expect(page.getByLabel("Video title")).toHaveValue(`Open house ${tag}`);

  // Discarding asks first; declined, the draft stays, and accepted, it is gone from the editor too.
  await page.goto("/home");
  const dialogs: string[] = [];
  let accept = false;
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void (accept ? d.accept() : d.dismiss());
  });
  await card.getByRole("button", { name: "Discard draft" }).click();
  expect(dialogs).toEqual([`Discard your unsent draft “Open house ${tag}”? It is kept only in this browser, so it cannot be brought back; an editor still open in another tab keeps its copy.`]);
  await expect(card).toBeVisible();
  expect(await stored()).toBe(`Open house ${tag}`);
  accept = true;
  await card.getByRole("button", { name: "Discard draft" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Draft discarded." })).toBeAttached();
  await expect(page.getByRole("link", { name: /^Avatar video/ })).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem("avatar-studio:draft"))).toBeNull();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(card).toHaveCount(0);
});

test("home offers each space's own draft, and none to a workspace's viewers", async ({ page }) => {
  const tag = Date.now().toString(36);
  const workspace = (await (await page.request.post("/api/workspaces", { data: { name: `Home drafts ${tag}` } })).json()).workspace as { id: string };
  try {
    await page.evaluate(([id, t]) => {
      localStorage.setItem("avatar-studio:draft", JSON.stringify({ title: `Personal ${t}`, scenes: [{ script: "Mine." }], savedAt: new Date().toISOString() }));
      localStorage.setItem(`avatar-studio:draft:${id}`, JSON.stringify({ title: `Team ${t}`, scenes: [{ script: "Ours." }], savedAt: new Date().toISOString() }));
    }, [workspace.id, tag] as const);
    await page.goto("/home");
    await expect(page.getByTestId("home-draft").getByText(`Continue your draft: Personal ${tag}`)).toBeVisible();
    expect((await page.request.post("/api/workspaces/switch", { data: { id: workspace.id } })).status()).toBe(200);
    await page.goto("/home");
    await expect(page.getByTestId("home-draft").getByText(`Continue your draft: Team ${tag}`)).toBeVisible();
    // A viewer makes no videos, so the space's draft is not offered to one.
    await page.route("**/api/workspaces", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { workspaces: Array<{ id: string; role: string }> };
      await route.fulfill({ response: res, json: { ...body, workspaces: body.workspaces.map((w) => (w.id === workspace.id ? { ...w, role: "viewer" } : w)) } });
    });
    // Home reads the space's draft once it knows the space; wait for that answer before checking nothing is offered.
    const spaces = page.waitForResponse((r) => r.url().endsWith("/api/workspaces") && r.request().method() === "GET");
    await page.goto("/home");
    await spaces;
    await expect(page.getByRole("link", { name: /^Avatar video/ })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByTestId("home-draft")).toHaveCount(0);
    await page.unroute("**/api/workspaces");
  } finally {
    await page.request.post("/api/workspaces/switch", { data: { id: "local" } });
    await page.request.delete(`/api/workspaces/${workspace.id}`);
    await page.evaluate((id) => {
      localStorage.removeItem(`avatar-studio:draft:${id}`);
      localStorage.removeItem("avatar-studio:draft");
    }, workspace.id);
  }
});

test("Captions saves a zip of each selected video's captions as SRT, named after the video, as its own download gives them", async ({ page }) => {
  const tag = Date.now().toString(36);
  const made = await page.request.post("/api/videos/batch", {
    data: { title: `Course ${tag}`, scriptTemplate: "Welcome to lesson {n}. Today we cover the basics.", csv: "n\n1\n2", avatarId: "stock_1", voiceId: "stock_voice_1" },
  });
  expect(made.status()).toBe(201);
  const { batchId } = (await made.json()) as { batchId: string };
  const listed = async () => ((await (await page.request.get(`/api/videos?batch=${batchId}`)).json()) as { videos: Array<{ id: string; title: string }> }).videos;
  await expect.poll(async () => (await Promise.all((await listed()).map(async (v) => ((await (await page.request.get(`/api/videos/${v.id}`)).json()) as { video: { status: string } }).video.status))).join(","), { timeout: 30_000 }).toBe("completed,completed");
  const shown = await listed();
  // One of them has corrected captions, which the file carries.
  expect((await page.request.put(`/api/videos/${shown[0].id}/captions`, { data: { cues: [{ startMs: 0, endMs: 1800, text: "Welcome, everyone." }] } })).status()).toBe(200);

  await page.goto(`/videos?batch=${batchId}`);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const bar = page.getByTestId("bulk-bar");
  await expect(page.locator("button[aria-pressed][aria-label^='Select ']")).toHaveCount(2);
  await page.keyboard.press("Control+a");
  const download = page.waitForEvent("download");
  await bar.getByRole("button", { name: "Captions", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^captions-\d{4}-\d{2}-\d{2}\.zip$/);
  await expect(page.getByTestId("copy-note")).toHaveText("Saved captions for 2 videos");
  const entries = unzipSync(new Uint8Array(await readFile((await file.path())!)));
  expect(Object.keys(entries).sort()).toEqual(shown.map((v) => `${v.title}.srt`).sort());
  // Each file is what the video's own caption download gives.
  for (const v of shown) {
    expect(strFromU8(entries[`${v.title}.srt`])).toBe(await (await page.request.get(`/api/videos/${v.id}/captions`)).text());
  }
  expect(strFromU8(entries[`${shown[0].title}.srt`])).toBe("1\n00:00:00,000 --> 00:00:01,800\nWelcome, everyone.\n");

  // WebVTT through the API, and nothing to give for a selection the library no longer has.
  const vtt = await page.request.post("/api/videos/captions?format=vtt", { data: { ids: shown.map((v) => v.id) } });
  expect(vtt.status()).toBe(200);
  expect(vtt.headers()["x-files"]).toBe("2");
  const vttEntries = unzipSync(new Uint8Array(await vtt.body()));
  expect(strFromU8(vttEntries[`${shown[1].title}.vtt`])).toBe(await (await page.request.get(`/api/videos/${shown[1].id}/captions?format=vtt`)).text());
  expect((await page.request.post("/api/videos/captions", { data: { ids: ["vid_nope"] } })).status()).toBe(404);
});

test("Scripts saves a zip of each selected video's script, which the editor's Import script reads back scene for scene", async ({ page }) => {
  const tag = Date.now().toString(36);
  const bg = { type: "color", value: "#ffffff" };
  const tour = { ...(await createVideoViaApi(page, `Tour ${tag}`, { script: undefined, scenes: [{ script: "Welcome in. [pause 1s] Come through.", background: bg }, { script: "This is the kitchen.", background: bg }] })), title: `Tour ${tag}` };
  const intro = { ...(await createVideoViaApi(page, `Intro ${tag}`)), title: `Intro ${tag}` };
  await page.goto("/videos");
  await page.getByLabel("Search videos").fill(tag);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const bar = page.getByTestId("bulk-bar");
  await expect(page.locator("button[aria-pressed][aria-label^='Select ']")).toHaveCount(2);
  await page.keyboard.press("Control+a");
  const download = page.waitForEvent("download");
  await bar.getByRole("button", { name: "Scripts", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^scripts-\d{4}-\d{2}-\d{2}\.zip$/);
  await expect(page.getByTestId("copy-note")).toHaveText("Saved 2 scripts");
  const entries = unzipSync(new Uint8Array(await readFile((await file.path())!)));
  expect(Object.keys(entries).sort()).toEqual([`${intro.title}.txt`, `${tour.title}.txt`].sort());
  // The scenes apart on --- lines, the pause kept, a byte order mark first, as the editor's Download script writes it.
  expect(Buffer.from(entries[`${tour.title}.txt`]).toString("utf8")).toBe("\uFEFFWelcome in. [pause 1s] Come through.\n\n---\n\nThis is the kitchen.\n");
  expect(Buffer.from(entries[`${intro.title}.txt`]).toString("utf8")).toBe("\uFEFFHello there. This is the first sentence. And here is the second one!\n\n---\n");

  // The editor's Import script makes the same two scenes of the file.
  await page.goto("/create");
  await page.evaluate(() => localStorage.removeItem("avatar-studio:draft"));
  await page.reload();
  await page.getByLabel("Import a script file").setInputFiles({ name: `${tour.title}.txt`, mimeType: "text/plain", buffer: Buffer.from(entries[`${tour.title}.txt`]) });
  await expect(page.getByTestId("import-note")).toContainText(`Imported 2 scenes from ${tour.title}.txt`);
  await expect(page.locator("textarea")).toHaveValue("Welcome in. [pause 1s] Come through.");

  expect((await page.request.post("/api/videos/scripts", { data: { ids: ["vid_nope"] } })).status()).toBe(404);
});

test("the bulk bar never sends more than the 200 videos one action takes", async ({ page }) => {
  test.slow();
  const tag = `Over ${Date.now().toString(36)}`;
  // 205 videos, in batches of up to 100 rows.
  for (const [from, n] of [[0, 100], [100, 100], [200, 5]] as const) {
    const rows = Array.from({ length: n }, (_, i) => `Guest ${String(from + i + 1).padStart(3, "0")}`);
    const made = await page.request.post("/api/videos/batch", {
      data: { title: tag, scriptTemplate: "Hello {name}.", csv: `name\n${rows.join("\n")}`, avatarId: "stock_1", voiceId: "stock_voice_1" },
    });
    expect(made.status()).toBe(201);
  }
  let bulkCalls = 0;
  await page.route("**/api/videos/bulk", async (route) => {
    bulkCalls += 1;
    await route.continue();
  });
  await page.goto("/videos");
  // The search applies after a pause in typing; page only once its results are in, or "Show more" pages the old list.
  const searched = page.waitForResponse((r) => r.url().includes("/api/videos?") && new URL(r.url()).searchParams.get("q") === tag);
  await page.getByLabel("Search videos").fill(tag);
  await searched;
  await expect(page.getByText("Showing 48 of 205")).toBeVisible();
  for (const shown of [96, 144, 192]) {
    await page.getByTestId("load-more").click();
    await expect(page.getByText(`Showing ${shown} of 205`)).toBeVisible();
  }
  // Past 192 the page asks for 240, which used to be refused ("Too big"); now the last 13 come in.
  await page.getByTestId("load-more").click();
  await expect(page.getByTestId("load-more")).toHaveCount(0);
  await expect(page.getByText(/Too big/)).toHaveCount(0);
  await expect(page.locator(`a[href^="/videos/vid_"]`).filter({ hasText: tag })).toHaveCount(205);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const bar = page.getByTestId("bulk-bar");
  const count = bar.getByRole("status").filter({ hasText: "selected" });
  // Select all shown stops at what one action takes, and says so.
  await bar.getByRole("button", { name: "Select all shown" }).click();
  await expect(count).toHaveText("200 selected");
  await expect(page.getByText("Selected the first 200 of the 205 shown, as one action takes up to 200.")).toBeVisible();
  // One more by hand goes over: the count says so, and an action refuses before sending anything.
  await page.locator(`button[aria-pressed="false"][aria-label^="Select ${tag}"]`).first().click();
  await expect(count).toHaveText("201 selected, over the 200 one action takes");
  let linkCalls = 0;
  await page.route("**/api/videos/links", async (route) => {
    linkCalls += 1;
    await route.continue();
  });
  const refusal = page.getByText("One action takes up to 200 videos and 201 are selected; unselect 1 first, or act on them in two goes.");
  await bar.getByRole("button", { name: "Star", exact: true }).click();
  await expect(refusal).toBeVisible();
  await bar.getByRole("button", { name: "Download links" }).click();
  await expect(refusal).toBeVisible();
  expect([bulkCalls, linkCalls]).toEqual([0, 0]);
  // Back to 200, the same action goes through.
  await page.locator(`button[aria-pressed="true"][aria-label^="Select ${tag}"]`).first().click();
  await expect(count).toHaveText("200 selected");
  // Back within the limit, the refusal goes with it.
  await expect(refusal).toHaveCount(0);
  await bar.getByRole("button", { name: "Star", exact: true }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  expect(bulkCalls).toBe(1);
  const starred = (await (await page.request.get(`/api/videos?q=${encodeURIComponent(tag)}&starred=1&limit=1`)).json()).matched as number;
  expect(starred).toBe(200);
});
