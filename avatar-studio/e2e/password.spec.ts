import { expect, test } from "@playwright/test";

// Shared-password mode (STUDIO_PASSWORD=hunter2 on this server).

test("pages redirect, API rejects, public paths stay open", async ({ request }) => {
  const home = await request.get("/home", { maxRedirects: 0 });
  expect(home.status()).toBe(307);
  expect(home.headers()["location"]).toContain("/login?next=%2Fhome");
  expect((await request.get("/api/videos")).status()).toBe(401);
  expect((await request.get("/")).status()).toBe(200);
  expect((await request.get("/login")).status()).toBe(200);
});

test("wrong password is rejected, right password signs in, sign out works", async ({ page }) => {
  await page.goto("/videos");
  await expect(page).toHaveURL(/\/login\?next=%2Fvideos/);
  await page.locator("input[type=password]").fill("wrong");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Incorrect password")).toBeVisible();
  await page.locator("input[type=password]").fill("hunter2");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/videos$/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  expect((await page.request.get("/api/videos")).status()).toBe(401);
});

test("repeated wrong passwords are rate limited", async ({ request }) => {
  const attempt = () => request.post("/api/auth/login", { data: { password: "nope" }, headers: { "x-forwarded-for": "203.0.113.9" } });
  for (let i = 0; i < 5; i++) expect((await attempt()).status()).toBe(401);
  const blocked = await attempt();
  expect(blocked.status()).toBe(429);
  expect(blocked.headers()["retry-after"]).toBeTruthy();
  // Other clients are unaffected.
  const other = await request.post("/api/auth/login", { data: { password: "nope" }, headers: { "x-forwarded-for": "203.0.113.10" } });
  expect(other.status()).toBe(401);
});

test("API keys grant script access without a session; minting needs a session", async ({ request, playwright }) => {
  const login = await request.post("/api/auth/login", { data: { password: "hunter2" } });
  expect(login.status()).toBe(200);
  const created = await request.post("/api/keys", { data: { name: "CI script" } });
  expect(created.status()).toBe(201);
  const { key, secret } = (await created.json()) as { key: { id: string }; secret: string };

  const script = await playwright.request.newContext({ baseURL: "http://localhost:3102" });
  const auth = { Authorization: `Bearer ${secret}` };
  expect((await script.get("/api/videos")).status()).toBe(401);
  expect((await script.get("/api/videos", { headers: auth })).status()).toBe(200);
  expect((await script.get("/api/videos", { headers: { Authorization: "Bearer as_live_wrong" } })).status()).toBe(401);
  expect((await script.post("/api/keys", { headers: auth, data: { name: "escalation" } })).status()).toBe(403);
  expect((await script.delete(`/api/keys/${key.id}`, { headers: auth })).status()).toBe(403);
  const made = await script.post("/api/videos", { headers: auth, data: { title: "From a script", script: "Hi.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "16:9" } });
  expect(made.status()).toBe(201);
  // The key reaches the per-video routes too: sharing settings and retry (409: the render is not failed).
  const madeId = ((await made.json()) as { video: { id: string } }).video.id;
  expect((await script.patch(`/api/videos/${madeId}`, { headers: auth, data: { shareDownload: true } })).status()).toBe(200);
  expect((await script.post(`/api/videos/${madeId}/retry`, { headers: auth })).status()).toBe(409);
  expect((await script.post(`/api/videos/${madeId}/retry`)).status()).toBe(401);

  const listed = (await (await request.get("/api/keys")).json()) as { keys: Array<{ id: string; lastUsedAt?: string }> };
  expect(listed.keys.find((k) => k.id === key.id)?.lastUsedAt).toBeTruthy();
  expect((await request.delete(`/api/keys/${key.id}`)).status()).toBe(204);
  expect((await script.get("/api/videos", { headers: auth })).status()).toBe(401);
  await script.dispose();
});

test("an offline share link is hidden from the public but not from the owner", async ({ request, playwright }) => {
  expect((await request.post("/api/auth/login", { data: { password: "hunter2" } })).status()).toBe(200);
  const made = await request.post("/api/videos", { data: { title: "Private for now", script: "Hi there.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "16:9" } });
  expect(made.status()).toBe(201);
  const id = ((await made.json()) as { video: { id: string } }).video.id;
  const anon = await playwright.request.newContext({ baseURL: "http://localhost:3102" });
  expect((await anon.get(`/share/${id}`)).status()).toBe(200);
  expect((await anon.get(`/api/videos/${id}/captions`)).status()).toBe(200);

  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  expect((await request.patch(`/api/videos/${id}`, { data: { cover: png } })).status()).toBe(200);
  expect((await anon.get(`/api/videos/${id}/cover`)).status()).toBe(200);

  expect((await request.patch(`/api/videos/${id}`, { data: { shareDisabled: true } })).status()).toBe(200);
  expect((await anon.get(`/share/${id}`)).status()).toBe(404);
  expect((await anon.get(`/api/videos/${id}/captions`)).status()).toBe(404);
  // The cover goes offline with the link for everyone but the owner.
  expect((await anon.get(`/api/videos/${id}/cover`)).status()).toBe(404);
  const ownerCover = await request.get(`/api/videos/${id}/cover?v=1`);
  expect(ownerCover.status()).toBe(200);
  expect(ownerCover.headers()["cache-control"]).toContain("private");
  expect((await request.get(`/api/videos/${id}/captions`)).status()).toBe(200);
  expect((await request.get(`/api/videos/${id}`)).status()).toBe(200);

  expect((await request.patch(`/api/videos/${id}`, { data: { shareDisabled: false } })).status()).toBe(200);
  expect((await anon.get(`/share/${id}`)).status()).toBe(200);
  await anon.dispose();
});

test("a password-protected share link opens only with the password or for the owner", async ({ request, playwright }) => {
  expect((await request.post("/api/auth/login", { data: { password: "hunter2" } })).status()).toBe(200);
  const made = await request.post("/api/videos", { data: { title: "Members only", script: "Hi there.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "16:9" } });
  expect(made.status()).toBe(201);
  const id = ((await made.json()) as { video: { id: string } }).video.id;
  const locked = await request.patch(`/api/videos/${id}`, { data: { sharePassword: "letmein1" } });
  expect(locked.status()).toBe(200);
  expect(((await locked.json()) as { video: { shareLocked?: boolean } }).video.shareLocked).toBe(true);

  const anon = await playwright.request.newContext({ baseURL: "http://localhost:3102" });
  expect(await (await anon.get(`/share/${id}`)).text()).toContain('data-testid="share-unlock"');
  expect((await anon.get(`/api/videos/${id}/captions`)).status()).toBe(401);
  expect((await anon.post(`/api/videos/${id}/unlock`, { data: { password: "wrong" } })).status()).toBe(401);
  expect((await anon.post(`/api/videos/${id}/unlock`, { data: { password: "letmein1" } })).status()).toBe(200);
  // The anonymous context now carries the unlock cookie.
  expect((await anon.get(`/api/videos/${id}/captions`)).status()).toBe(200);
  expect(await (await anon.get(`/share/${id}`)).text()).not.toContain('data-testid="share-unlock"');
  // The owner never needs it.
  expect((await request.get(`/api/videos/${id}/captions`)).status()).toBe(200);
  // A cover follows the same rule: the unlocked visitor and the owner get it, a stranger does not.
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  expect((await request.patch(`/api/videos/${id}`, { data: { cover: png } })).status()).toBe(200);
  const cover = await anon.get(`/api/videos/${id}/cover?v=1`);
  expect(cover.status()).toBe(200);
  // Served per viewer: a CDN must not hand the cached image to the next visitor.
  expect(cover.headers()["cache-control"]).toContain("private");
  expect(cover.headers()["cache-control"]).not.toContain("public");
  const stranger = await playwright.request.newContext({ baseURL: "http://localhost:3102" });
  expect((await stranger.get(`/api/videos/${id}/cover`)).status()).toBe(404);
  await stranger.dispose();
  // Changing the password signs the visitor out again.
  expect((await request.patch(`/api/videos/${id}`, { data: { sharePassword: "another-1" } })).status()).toBe(200);
  expect((await anon.get(`/api/videos/${id}/captions`)).status()).toBe(401);
  expect((await anon.get(`/api/videos/${id}/cover`)).status()).toBe(404);
  expect((await request.get(`/api/videos/${id}/cover`)).status()).toBe(200);
  await anon.dispose();
});

test("a made-up bearer token is not a session", async ({ request }) => {
  // The proxy only lets real API keys past the session check; everything else needs the cookie.
  const bogus = { Authorization: "Bearer x" };
  expect((await request.post("/api/script", { headers: bogus, data: { topic: "Anything", lengthSec: 30 } })).status()).toBe(401);
  expect((await request.post("/api/voices/preview", { headers: bogus, data: { voiceId: "stock_voice_1", text: "Hi" } })).status()).toBe(401);
  expect((await request.get("/api/workspaces", { headers: bogus })).status()).toBe(401);
  expect((await request.get("/api/videos", { headers: bogus })).status()).toBe(401);
  // A key-shaped but unknown token reaches the route and is rejected there.
  expect((await request.post("/api/script", { headers: { Authorization: "Bearer as_live_nope" }, data: { topic: "Anything", lengthSec: 30 } })).status()).toBe(401);
  await request.post("/api/auth/login", { data: { password: "hunter2" } });
  expect((await request.post("/api/script", { data: { topic: "Anything", lengthSec: 30 } })).status()).toBe(200);
});

test("post-login redirects never leave the site", async ({ request }) => {
  for (const next of ["/%09/evil.com", "/%09//evil.com", "/%0A/evil.com", "//evil.com"]) {
    const res = await request.get(`/auth/callback?next=${next}`, { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toBe("http://localhost:3102/home");
  }
  const ok = await request.get("/auth/callback?next=%2Fvideos", { maxRedirects: 0 });
  expect(ok.headers()["location"]).toBe("http://localhost:3102/videos");
});

test("data export and deletion need a session and a typed confirmation", async ({ request, playwright }) => {
  await request.post("/api/auth/login", { data: { password: "hunter2" } });
  const made = await request.post("/api/videos", { data: { title: "Export me", script: "Hi.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "16:9" } });
  expect(made.status()).toBe(201);
  const exported = await request.get("/api/account/export");
  expect(exported.status()).toBe(200);
  expect(exported.headers()["content-disposition"]).toContain("avatar-studio-export-");
  const body = (await exported.json()) as { video: Array<{ title: string }> };
  expect(body.video.some((v) => v.title === "Export me")).toBe(true);

  const key = (await (await request.post("/api/keys", { data: { name: "k" } })).json()) as { secret: string };
  const script = await playwright.request.newContext({ baseURL: "http://localhost:3102" });
  expect((await script.get("/api/account/export", { headers: { Authorization: `Bearer ${key.secret}` } })).status()).toBe(403);
  expect((await script.delete("/api/account", { headers: { Authorization: `Bearer ${key.secret}` }, data: { confirm: "DELETE" } })).status()).toBe(403);
  await script.dispose();

  expect((await request.delete("/api/account", { data: { confirm: "nope" } })).status()).toBe(400);
  const wiped = await request.delete("/api/account", { data: { confirm: "DELETE" } });
  expect(wiped.status()).toBe(200);
  expect(((await wiped.json()).deleted as Record<string, number>).video).toBeGreaterThanOrEqual(1);
  expect(((await (await request.get("/api/videos")).json()).videos as unknown[]).length).toBe(0);
});
