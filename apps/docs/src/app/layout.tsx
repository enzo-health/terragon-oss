import "./global.css";
import { RootProvider } from "fumadocs-ui/provider";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";

const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Leo Documentation",
    template: "%s | Leo Docs",
  },
  description:
    "Comprehensive documentation for Leo - AI-powered coding assistant platform. Learn how to use Leo to run coding agents in parallel inside remote sandboxes.",
  keywords: [
    "Leo",
    "AI coding assistant",
    "documentation",
    "coding agents",
    "developer tools",
    "AI development",
  ],
  authors: [{ name: "Leo Labs" }],
  creator: "Leo Labs",
  publisher: "Leo Labs",
  metadataBase: new URL("https://docs.terragonlabs.com"),
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://docs.terragonlabs.com",
    siteName: "Leo Documentation",
    title: "Leo Documentation",
    description: "Documentation for Leo - AI-powered coding assistant platform",
    images: [
      {
        url: "https://cdn.terragonlabs.com/og-img-2-_W6t.png",
        width: 1200,
        height: 630,
        alt: "Leo Documentation",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Leo Documentation",
    description: "Documentation for Leo - AI-powered coding assistant platform",
    images: ["https://cdn.terragonlabs.com/og-img-2-_W6t.png"],
    creator: "@terragonlabs",
    site: "@terragonlabs",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  alternates: {
    canonical: "https://docs.terragonlabs.com",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function Layout({ children }: { children: ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    publisher: {
      "@type": "Organization",
      name: "Leo Labs",
      url: "https://www.terragonlabs.com",
    },
    inLanguage: "en-US",
  };

  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <head>
        {process.env.NODE_ENV === "development" ? (
          <link rel="icon" href="/favicon-dev.png" />
        ) : (
          <link rel="icon" href="/favicon.png" />
        )}
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
