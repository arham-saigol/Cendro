import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  allowedDevOrigins: ["devbox.tail5bb70e.ts.net"],
  env: {
    NEXT_PUBLIC_APP_BUILD: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    // The upgrade API requires Vercel's runtime (vc dev locally).
    NEXT_PUBLIC_CONVEX_RELAY: process.env.VERCEL === "1" ? "true" : "false",
  },
};
export default nextConfig;
