import type { NextConfig } from "next";
import { HTML_LIMITED_BOT_UA_RE } from "next/dist/shared/lib/router/utils/html-bots";

const nextConfig: NextConfig = {
  // The repo root carries its own lockfile; this app is its own workspace.
  outputFileTracingRoot: __dirname,
  turbopack: { root: __dirname },
  images: {
    // Provider-hosted avatar thumbnails and rendered videos come from many hosts.
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
  serverExternalPackages: ["@anthropic-ai/sdk", "undici"],
  // Next's own list of readers that need the metadata in the head, plus the oEmbed consumers that stop reading at
  // </head> to find a share page's oEmbed link (WordPress among them), so it never streams in later for them.
  htmlLimitedBots: new RegExp(`${HTML_LIMITED_BOT_UA_RE.source}|WordPress|Iframely|Embedly|Notion|Discourse|Ghost|Mastodon|TelegramBot`, "i"),
  async headers() {
    const common = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      // Camera for photo-avatar capture, microphone for voice-clone recording; nothing needs geolocation.
      { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
    ];
    return [
      // Share pages and shared folder pages may be embedded anywhere (their "Embed" snippets rely on it); neither
      // carries an action a framing site could trick a visitor into.
      { source: "/share/:path*", headers: common },
      { source: "/collection/:path*", headers: common },
      // Everything else refuses to be framed.
      { source: "/((?!share/|talk/|collection/).*)", headers: [...common, { key: "X-Frame-Options", value: "DENY" }] },
    ];
  },
};

export default nextConfig;
