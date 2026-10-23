import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

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
    await page.getByRole("button", { name: "2", exact: true }).click();
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
  await page.getByLabel("Gender").selectOption("male");
  await expect(page.getByRole("img", { name: "Marcus Hill" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Ava Chen" })).toHaveCount(0);
  await page.getByPlaceholder(/Search by name or style/).fill("tech");
  await expect(page.getByRole("img", { name: "Lucas Meyer" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Marcus Hill" })).toHaveCount(0);
  await expect(page.getByText(/^1 of \d+$/)).toBeVisible();
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
  await expect(page.getByText(/2 scenes/)).toBeVisible();
  // The second scene gets its own presenter and voice; the stage preview follows the choice.
  await page.getByLabel("Scene avatar").selectOption({ label: "Marcus Hill" });
  await page.getByLabel("Scene voice").selectOption({ label: "Olivia" });
  await expect(page.getByTestId("stage-avatar")).toHaveAttribute("alt", "Marcus Hill");
  await page.getByRole("button", { name: "1", exact: true }).click();
  await expect(page.getByTestId("stage-avatar")).not.toHaveAttribute("alt", "Marcus Hill");
  await page.getByRole("button", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Generate video" }).click();
  await page.waitForURL(/\/videos\/vid_/);
  const id = page.url().split("/").pop()!;
  const video = (await (await page.request.get(`/api/videos/${id}`)).json()).video;
  expect(video.scenes).toHaveLength(2);
  expect(video.script).toBe("Scene one says hello.\n\nScene two says goodbye.");
  expect(video.scenes[0].avatarName).toBeUndefined();
  expect(video.scenes[1]).toMatchObject({ avatarId: "stock_2", avatarName: "Marcus Hill", voiceId: "stock_voice_3", voiceName: "Olivia" });
  await expect(page.getByText("Script · 2 scenes")).toBeVisible();
  await expect(page.getByText("Marcus Hill · Olivia")).toBeVisible();
  // Edit a copy keeps the scene's presenter.
  await page.goto(`/create?from=${id}`);
  await expect(page.getByText(/2 scenes/)).toBeVisible();
  await page.getByRole("button", { name: "2", exact: true }).click();
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
  await page.getByRole("button", { name: "2", exact: true }).click();
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

  // A call-to-action button set from the video page shows under the share-page player.
  await page.goto(`/videos/${v.id}`);
  await page.getByLabel("Button label").fill("Book a showing");
  await page.getByLabel("Button link").fill("https://example.com/book");
  await page.getByRole("button", { name: "Save button" }).click();
  await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
  await page.goto(`/share/${v.id}`);
  const cta = page.getByTestId("share-cta");
  await expect(cta).toHaveText("Book a showing");
  await expect(cta).toHaveAttribute("href", "https://example.com/book");
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareCta: { label: "Go", url: "javascript:alert(1)" } } })).status()).toBe(400);
  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareCta: null } })).status()).toBe(200);
  await page.goto(`/share/${v.id}`);
  await expect(page.getByTestId("share-cta")).toHaveCount(0);

  expect((await page.request.patch(`/api/videos/${v.id}`, { data: { shareDownload: false } })).status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("link", { name: "Download video" })).toHaveCount(0);
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
  try {
    const v = await createVideoViaApi(page, "Phone width check");
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
  const v = await createVideoViaApi(page, "Caption formats", { captions: true });
  const vtt = await request.get(`/api/videos/${v.id}/captions?format=vtt`);
  expect(vtt.headers()["content-type"]).toContain("text/vtt");
  expect(await vtt.text()).toMatch(/^WEBVTT/);
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
});

test("brand kit pre-fills the editor and brands the share page", async ({ page }) => {
  try {
    await page.goto("/brand");
    await page.getByPlaceholder("Acme Realty").fill("Acme Realty");
    await page.getByLabel("Primary color", { exact: true }).fill("#0f766e");
    await page.getByLabel("Default voice").selectOption("stock_voice_3");
    await page.getByLabel("Captions on by default").check();
    await page.getByLabel("Default output quality").selectOption("720p");
    await page.getByRole("button", { name: "Save brand kit" }).click();
    await expect(page.getByText(/^Saved /)).toBeVisible();

    await page.goto("/create");
    await expect(page.getByText(/· Olivia · 16:9 · 1 scene · captions on$/)).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("button", { name: /^720p/ })).toHaveAttribute("aria-pressed", "true");

    const v = await createVideoViaApi(page, "Branded video");
    await page.goto(`/share/${v.id}`);
    await expect(page.getByTestId("share-brand")).toContainText("Acme Realty");
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
  await page.getByLabel("Folder").selectOption(folder);
  await expect(page.locator("a[href^='/videos/vid_']")).toHaveCount(1);
  await expect(page.getByText(`Filed video ${tag}`)).toBeVisible();
  await page.getByLabel("Folder").selectOption("unfiled");
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
});

test("library multi-select moves and deletes videos in bulk", async ({ page }) => {
  const tag = Date.now().toString(36);
  const a = await createVideoViaApi(page, `Bulk one ${tag}`);
  const b = await createVideoViaApi(page, `Bulk two ${tag}`);
  page.on("dialog", (d) => d.accept(`Bulk ${tag}`));

  await page.goto("/videos");
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk one ${tag}` }).click();
  await page.getByRole("button", { name: `Select Bulk two ${tag}` }).click();
  await expect(page.getByTestId("bulk-bar")).toContainText("2 selected");
  await page.getByRole("button", { name: "Move to folder" }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  expect((await (await page.request.get(`/api/videos/${a.id}`)).json()).video.folder).toBe(`Bulk ${tag}`);
  expect((await (await page.request.get(`/api/videos/${b.id}`)).json()).video.folder).toBe(`Bulk ${tag}`);

  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("button", { name: `Select Bulk two ${tag}` }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  expect((await page.request.get(`/api/videos/${b.id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/videos/${a.id}`)).status()).toBe(200);
  expect((await page.request.post("/api/videos/bulk", { data: { action: "move", ids: [] } })).status()).toBe(400);
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

    // Invite link from the members page.
    await page.goto("/workspace");
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

  await page.reload();
  await expect(page.getByTestId("agent-list")).toContainText("2 conversations");
  await page.getByRole("button", { name: `Transcripts for Dana ${tag}` }).click();
  await expect(page.getByTestId("transcripts")).toContainText("Any open houses?");
  await expect(page.getByTestId("transcripts")).toContainText(`sam-${tag}@example.com`);
  await expect(page.getByTestId("transcripts").locator("summary")).toHaveCount(2);
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
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Delete My voice" }).click();
    await expect(page.getByText("My voice")).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/voices/${voice.id}`);
  }
});
