import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { UserAtomsHydratorServer } from "@/components/system/user-atoms-server";
import { Geist, Geist_Mono, Cormorant_Garamond } from "next/font/google";
import { ServerProviders } from "@/components/system/server-providers";
import { KonamiVideo } from "@/components/konami-video";

export const metadata: Metadata = {
  title: "Terragon",
  description: "AI-powered coding assistant platform",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Terragon",
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    type: "website",
    siteName: "Terragon",
    title: "Terragon",
    description: "AI-powered coding assistant platform",
  },
  twitter: {
    card: "summary",
    title: "Terragon",
    description: "AI-powered coding assistant platform",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist",
  preload: true,
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist-mono",
  preload: false, // Only used for code, less critical
});

// Brand serif — open-source approximation of Anthropic's licensed
// Copernicus / Tiempos Headline. Used for display headings (h1–h3) where
// the editorial voice matters; UI labels stay sans.
const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-cormorant",
  preload: false,
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {process.env.NODE_ENV === "development" ? (
          <link rel="icon" href="/favicon-dev.png" />
        ) : (
          <link rel="icon" href="/favicon.png" />
        )}
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="mobile-web-app-capable" content="yes" />
        {/* Brand canvas — #faf9f5 cream in light, #181715 navy in dark */}
        <meta
          name="theme-color"
          content="#faf9f5"
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="theme-color"
          content="#181715"
          media="(prefers-color-scheme: dark)"
        />
      </head>
      <body
        className={`${geist.variable} ${geistMono.variable} ${cormorant.variable} font-sans antialiased`}
      >
        <ServerProviders>
          <UserAtomsHydratorServer>
            <>{children}</>
            <Toaster
              position="top-center"
              toastOptions={{
                duration: 3000,
              }}
            />
            {/* Persistent across routes */}
            <KonamiVideo startSeconds={155} />
          </UserAtomsHydratorServer>
        </ServerProviders>
      </body>
    </html>
  );
}
