import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  allowedDevOrigins: ["devbox.tail5bb70e.ts.net"],
  env: { NEXT_PUBLIC_APP_BUILD: process.env.VERCEL_GIT_COMMIT_SHA ?? "local" },
};
export default nextConfig;
