import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Provider-hosted avatar thumbnails and rendered videos come from many hosts.
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
  serverExternalPackages: ["@anthropic-ai/sdk"],
};

export default nextConfig;
