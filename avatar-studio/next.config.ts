import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Provider-hosted avatar thumbnails and rendered videos come from many hosts.
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
  serverExternalPackages: ["@anthropic-ai/sdk"],
  async headers() {
    const common = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      // Camera is used for photo-avatar capture; nothing needs mic or geolocation.
      { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
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
