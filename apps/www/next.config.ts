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

const nextConfig: NextConfig = {
  reactCompiler: true,
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
      "@radix-ui/react-avatar",
      "@radix-ui/react-checkbox",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-label",
      "@radix-ui/react-popover",
      "@radix-ui/react-portal",
      "@radix-ui/react-progress",
      "@radix-ui/react-radio-group",
      "@radix-ui/react-scroll-area",
      "@radix-ui/react-select",
      "@radix-ui/react-separator",
      "@radix-ui/react-slot",
      "@radix-ui/react-switch",
      "@radix-ui/react-tabs",
      "@radix-ui/react-tooltip",
      "@radix-ui/react-visually-hidden",
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
  webpack: (config, { dev }) => {
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

// bundle-analyzer still peer-types against Next 15, so widen here at the edge.
export default withBundleAnalyzer(nextConfig as any);
