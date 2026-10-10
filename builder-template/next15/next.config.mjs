import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * LevantDeploy Builder: when NEXT_PUBLIC_LEVANT_EDITOR=1 (the live preview's `next dev`, webpack mode) a pre-loader adds
 * `data-lv-src="relpath:line:col"` to JSX elements so the visual editor can map clicks back to source. Production builds
 * (`next build`, editor flag unset) never load it.
 */
const editor = process.env.NEXT_PUBLIC_LEVANT_EDITOR === "1";
const previewHost = process.env.LEVANT_PREVIEW_HOST;

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dev "N" badge would show inside the builder preview.
  devIndicators: false,
  reactStrictMode: true,
  output: "standalone",
  // the preview's `run_check build` writes to .levant/build-check so it doesn't clobber the running dev server's .next
  ...(process.env.LEVANT_DIST_DIR ? { distDir: process.env.LEVANT_DIST_DIR } : {}),
  // always inlined (also when unset) so production bundles drop the editor bridge entirely (dead-code eliminated)
  env: { NEXT_PUBLIC_LEVANT_EDITOR: editor ? "1" : "0" },
  images: { remotePatterns: [{ protocol: "https", hostname: "**" }] },
  ...(previewHost ? { allowedDevOrigins: [previewHost] } : {}),
  webpack(config, { dev }) {
    if (editor && dev) {
      config.module.rules.unshift({
        test: /\.(jsx|tsx)$/,
        enforce: "pre",
        exclude: /node_modules|[\\/]levant[\\/]/,
        use: [{ loader: path.join(root, "levant", "lv-src-loader.cjs"), options: { root } }],
      });
    }
    return config;
  },
};

export default nextConfig;
