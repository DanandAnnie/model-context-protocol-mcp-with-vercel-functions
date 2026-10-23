// Central place to read environment configuration.

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export const config = {
  avatarProvider: (env("AVATAR_PROVIDER") ?? "mock").toLowerCase(),
  ttsProvider: (env("TTS_PROVIDER") ?? "mock").toLowerCase(),
  scriptProvider: (env("SCRIPT_PROVIDER") ?? "mock").toLowerCase(),
  heygenApiKey: env("HEYGEN_API_KEY"),
  didApiKey: env("DID_API_KEY"),
  elevenLabsApiKey: env("ELEVENLABS_API_KEY"),
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  supabaseUrl: env("SUPABASE_URL"),
  supabaseServiceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY"),
  appUrl: env("APP_URL") ?? env("VERCEL_URL")?.replace(/^(?!https?:\/\/)/, "https://") ?? "http://localhost:3000",
  webhookSecret: env("WEBHOOK_SECRET"),
  /** "resend" sends workspace invites by email; anything else only produces links. */
  emailProvider: (env("EMAIL_PROVIDER") ?? "mock").toLowerCase(),
  resendApiKey: env("RESEND_API_KEY"),
  emailFrom: env("EMAIL_FROM") ?? "Avatar Studio <onboarding@resend.dev>",
  /** Optional cap on renders per owner per calendar month (UTC). Unset = unlimited. */
  renderLimitPerMonth: parsePositiveInt(env("RENDER_LIMIT_PER_MONTH")),
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
