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

  const listed = (await (await request.get("/api/keys")).json()) as { keys: Array<{ id: string; lastUsedAt?: string }> };
  expect(listed.keys.find((k) => k.id === key.id)?.lastUsedAt).toBeTruthy();
  expect((await request.delete(`/api/keys/${key.id}`)).status()).toBe(204);
  expect((await script.get("/api/videos", { headers: auth })).status()).toBe(401);
  await script.dispose();
});
