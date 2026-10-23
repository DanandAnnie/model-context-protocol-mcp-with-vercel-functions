import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repo root carries its own lockfile; this app is its own workspace.
  outputFileTracingRoot: __dirname,
  turbopack: { root: __dirname },
  images: {
    // Provider-hosted avatar thumbnails and rendered videos come from many hosts.
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
  serverExternalPackages: ["@anthropic-ai/sdk"],
  async headers() {
    const common = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      // Camera for photo-avatar capture, microphone for voice-clone recording; nothing needs geolocation.
      { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
    ];
    return [
      // Share pages may be embedded anywhere (the "Embed" snippet relies on it).
      { source: "/share/:path*", headers: common },
      // Everything else refuses to be framed.
      { source: "/((?!share/|talk/).*)", headers: [...common, { key: "X-Frame-Options", value: "DENY" }] },
    ];
  },
};

export default nextConfig;
