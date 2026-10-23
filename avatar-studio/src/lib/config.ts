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
};

/** Public callback URL a provider should POST to when a job finishes. */
export function webhookUrl(provider: string): string {
  const base = config.appUrl.replace(/\/$/, "");
  const secret = config.webhookSecret ? `?secret=${encodeURIComponent(config.webhookSecret)}` : "";
  return `${base}/api/webhooks/${provider}${secret}`;
}
