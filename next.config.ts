import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // NEXT_DIST_DIR lets verification builds use their own output folder so a
  // running `next dev` (which uses .next) is never disturbed.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
