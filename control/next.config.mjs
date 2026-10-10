import { contentSecurityPolicy } from "./security-headers.mjs";

/** @type {import('next').NextConfig} */

const securityHeaders = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Content-Security-Policy", value: contentSecurityPolicy() },
];

const nextConfig = {
  // NEXT_DIST_DIR lets several dev servers run from the same checkout (wave-B agents) without sharing .next
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // native / node-only deps used by API routes (dockerode → ssh2 / cpu-features)
  serverExternalPackages: ["dockerode", "ssh2", "cpu-features", "bullmq", "ioredis", "prettier", "recast", "@babel/parser"],
  experimental: {
    serverActions: { bodySizeLimit: "4mb" },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
