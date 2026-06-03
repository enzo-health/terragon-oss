import path from "node:path";
import { fileURLToPath } from "node:url";
import bundleAnalyzer from "@next/bundle-analyzer";
import { config as loadDotenv } from "dotenv";
import type { NextConfig } from "next";

// Turbopack can mis-handle inherited NODE_PATH values from shell wrappers and
// treat a delimiter-joined list as one lookup directory. This app does not rely
// on NODE_PATH, so strip it at the boundary.
delete process.env.NODE_PATH;

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(configDir, "..", "..");

function loadLocalEnvFiles() {
  const localEnvFiles = [
    path.join(configDir, ".env.local"),
    path.join(configDir, ".env.development.local"),
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, ".env.development.local"),
  ];

  for (const envPath of localEnvFiles) {
    loadDotenv({
      path: envPath,
      override: false,
    });
  }
}

loadLocalEnvFiles();

// @daytonaio/sdk uses `createRequire(import.meta.url)` and a dynamic
// `requireMap` for runtime-only deps (busboy, tar, form-data, ...). Vercel's
// NFT can't see those requires, and the SDK also hides ObjectStorage.js (which
// statically imports @aws-sdk/*) behind a variable-string dynamic import.
// Pull the relevant physical pnpm trees into every server bundle so they exist
// on disk. Do not include the SDK's dependency symlink paths here: tracing
// files through those links makes Vercel reject the serverless package.
const daytonaTracingIncludes: Record<string, string[]> = {
  "/*": [
    "../../node_modules/.pnpm/busboy@*/node_modules/busboy/**/*",
    "../../node_modules/.pnpm/streamsearch@*/node_modules/streamsearch/**/*",
    "../../node_modules/.pnpm/tar@*/node_modules/tar/**/*",
    "../../node_modules/.pnpm/form-data@*/node_modules/form-data/**/*",
    "../../node_modules/.pnpm/fast-glob@*/node_modules/fast-glob/**/*",
    "../../node_modules/.pnpm/expand-tilde@*/node_modules/expand-tilde/**/*",
    "../../node_modules/.pnpm/@iarna+toml@*/node_modules/@iarna/toml/**/*",
    "../../node_modules/.pnpm/@daytonaio+sdk@*/node_modules/@daytonaio/sdk/esm/ObjectStorage.{js,js.map}",
    "../../node_modules/.pnpm/@daytonaio+sdk@*/node_modules/@daytonaio/sdk/cjs/ObjectStorage.{js,js.map}",
    "../../node_modules/.pnpm/@aws-sdk+client-s3@*/node_modules/@aws-sdk/client-s3/**/*",
    "../../node_modules/.pnpm/@aws-sdk+lib-storage@*/node_modules/@aws-sdk/lib-storage/**/*",
  ],
};

const nextConfig = {
  reactCompiler: true,
  // The Daytona SDK lazy-loads form-data/tar/fast-glob/@iarna/toml/expand-tilde
  // via a createRequire shim that webpack can't statically trace. Keeping the
  // package external preserves Node's real require resolution at runtime so
  // Vercel NFT picks up those transitive deps.
  serverExternalPackages: ["@daytonaio/sdk"],
  // Skip Next build-time type checking in dev; tsc-check still owns type safety.
  typescript: {
    ignoreBuildErrors: process.env.NODE_ENV === "development",
  },
  // @ts-ignore - eslint option is valid but not in type definitions
  eslint: {
    ignoreDuringBuilds: process.env.NODE_ENV === "development",
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "cdn.terragonlabs.com",
        pathname: "/**",
      },
    ],
  },
  turbopack: {
    root: repoRoot,
  },
  experimental: {
    // Reduce unnecessary re-renders during HMR
    optimizeCss: false, // CSS optimization can slow down HMR
    optimizePackageImports: [
      "lucide-react",
      "@base-ui/react",
      "@radix-ui/react-scroll-area",
      "@radix-ui/react-slot",
      "@tiptap/react",
      "@tiptap/starter-kit",
      "@assistant-ui/react",
      "@ag-ui/client",
      "@ag-ui/core",
      "@anthropic-ai/sdk",
      "@aws-sdk/client-s3",
      "@tanstack/react-table",
      "ai",
      "date-fns",
      "recharts",
      "zod",
    ],
    staleTimes: {
      // Keep active task pages fresh on client navigation while preserving a
      // small router-cache window for back/forward responsiveness.
      dynamic: process.env.NODE_ENV === "development" ? 30 : 60,
      static: process.env.NODE_ENV === "development" ? 30 : 300,
    },
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
  async headers() {
    return [
      {
        // The service worker must never be cached by the browser/CDN or
        // clients get stuck on a stale worker. It also needs root scope.
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.json",
        headers: [{ key: "Content-Type", value: "application/manifest+json" }],
      },
    ];
  },
  async rewrites() {
    return [];
  },
  async redirects() {
    // Backward compatibility: redirect /chat/:id to /task/:id
    return [
      {
        source: "/chat/:id",
        destination: "/task/:id",
        permanent: false,
      },
    ];
  },
  // Webpack configuration for faster HMR
  webpack: (config: any, { dev }: { dev: boolean }) => {
    if (dev) {
      // Exclude test and story files from webpack watch in dev
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          "**/node_modules/**",
          "**/.git/**",
          "**/*.test.ts",
          "**/*.test.tsx",
          "**/*.stories.ts",
          "**/*.stories.tsx",
          "**/*.spec.ts",
          "**/*.spec.tsx",
        ],
      };
    }
    return config;
  },
};

// Assigned outside the literal because CI's tsc flagged the inline form as
// TS1117 even though the literal had no duplicate keys; this also keeps
// @daytonaio/sdk resolved from node_modules at runtime (its
// `createRequire(import.meta.url)` shim needs node_modules layout).
const nextConfigTyped = nextConfig as NextConfig;
nextConfigTyped.serverExternalPackages = ["@daytonaio/sdk"];
// Pin the file-tracing root to the monorepo root so the `../../node_modules`
// include globs resolve inside the trace root instead of being dropped.
nextConfigTyped.outputFileTracingRoot = repoRoot;
nextConfigTyped.outputFileTracingIncludes = daytonaTracingIncludes;

// bundle-analyzer still peer-types against Next 15, so widen here at the edge.
export default withBundleAnalyzer(nextConfig as NextConfig as any);
