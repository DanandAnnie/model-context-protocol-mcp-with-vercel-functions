// Central place to read environment configuration.

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

// A preview may have credentials provisioned before live operations are approved.
// Hide every paid-provider credential while locked, including implicit HeyGen translation.
const demoLocked = (env("STUDIO_DEMO_MODE") ?? "false").toLowerCase() === "true";
function providerSecret(name: string): string | undefined {
  return demoLocked ? undefined : env(name);
}

export const config = {
  demoLocked,
  avatarProvider: (env("AVATAR_PROVIDER") ?? "mock").toLowerCase(),
  ttsProvider: (env("TTS_PROVIDER") ?? "mock").toLowerCase(),
  scriptProvider: (env("SCRIPT_PROVIDER") ?? "mock").toLowerCase(),
  heygenApiKey: providerSecret("HEYGEN_API_KEY"),
  didApiKey: providerSecret("DID_API_KEY"),
  elevenLabsApiKey: providerSecret("ELEVENLABS_API_KEY"),
  anthropicApiKey: providerSecret("ANTHROPIC_API_KEY"),
  supabaseUrl: env("SUPABASE_URL"),
  supabaseServiceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY"),
  appUrl: env("APP_URL") ?? env("VERCEL_URL")?.replace(/^(?!https?:\/\/)/, "https://") ?? "http://localhost:3000",
  /** The app's public address as configured; links an outside service must open (proofread lines) need it. */
  publicAppUrl: env("APP_URL")?.replace(/\/$/, ""),
  webhookSecret: env("WEBHOOK_SECRET"),
  /** Live video for the interactive avatar (HeyGen Streaming) when the HeyGen key is set. */
  streamingEnabled: (env("STREAMING_AVATAR") ?? "true").toLowerCase() !== "false",
  /** "resend" sends workspace invites by email; anything else only produces links. */
  emailProvider: (env("EMAIL_PROVIDER") ?? "mock").toLowerCase(),
  resendApiKey: providerSecret("RESEND_API_KEY"),
  emailFrom: env("EMAIL_FROM") ?? "Avatar Studio <onboarding@resend.dev>",
  /** Free-plan cap on renders per owner per calendar month (UTC). Unset = unlimited. */
  renderLimitPerMonth: parsePositiveInt(env("RENDER_LIMIT_PER_MONTH")),
  /** Pro-plan cap; unset = unlimited. Only meaningful with a billing provider or in demo mode. */
  proRendersPerMonth: parsePositiveInt(env("PLAN_PRO_RENDERS")),
  proPriceLabel: env("PLAN_PRO_PRICE_LABEL") ?? "$29 / month",
  /** "stripe" with the keys below, otherwise a mock that upgrades instantly (demo). */
  billingProvider: (env("BILLING_PROVIDER") ?? "mock").toLowerCase(),
  stripeSecretKey: providerSecret("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: providerSecret("STRIPE_WEBHOOK_SECRET"),
  stripePricePro: env("STRIPE_PRICE_PRO"),
};

function parsePositiveInt(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Public callback URL a provider should POST to when a job finishes.
 * Returns undefined when no WEBHOOK_SECRET is configured: an unauthenticated
 * callback endpoint could be used to overwrite any video, and polling covers
 * status updates without it.
 */
export function webhookUrl(provider: string): string | undefined {
  if (!config.webhookSecret) return undefined;
  const base = config.appUrl.replace(/\/$/, "");
  return `${base}/api/webhooks/${provider}?secret=${encodeURIComponent(config.webhookSecret)}`;
}

/**
 * The origin public links (share pages, emails, CSV rows) are built on: `APP_URL` when it is set, so a
 * preview deployment, a `www.` alias, or a forged Host header cannot change where a posted link points,
 * else the request's own origin.
 */
export function publicOrigin(req: Request): string {
  return env("APP_URL")?.replace(/\/$/, "") ?? new URL(req.url).origin;
}

/** Keep demo media on the deployment being tested, including protected previews. */
export function demoAssetUrl(path: string): string {
  const deployment = env("VERCEL_URL");
  const origin = deployment ? `https://${deployment}` : config.appUrl;
  return new URL(path, origin).href;
}
