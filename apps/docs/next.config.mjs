import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,

  images: {
    domains: ["cdn.terragonlabs.com"],
  },

  redirects: async () => {
    return [
      {
        source: "/",
        destination: "/docs",
        permanent: true,
      },
      {
        source: "/docs/tasks/automations",
        destination: "/docs/automations",
        permanent: true,
      },
      {
        source: "/docs/troubleshooting/common-issues",
        destination: "/docs/resources/common-issues",
        permanent: true,
      },
      {
        source: "/docs/troubleshooting/claude-rate-limits",
        destination:
          "/docs/agent-providers/claude-code#automatic-rate-limit-handling",
        permanent: true,
      },
      {
        source: "/docs/getting-started/mobile",
        destination: "/docs/mobile",
        permanent: true,
      },
      {
        source: "/docs/getting-started/quick-start",
        destination: "/docs/quick-start",
        permanent: true,
      },
    ];
  },
};

export default withMDX(config);
