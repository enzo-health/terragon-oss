import { getUserInfoOrNull } from "@/lib/auth-server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { publicAppUrl } from "@terragon/env/next-public";

export const maxDuration = 800;

export const metadata: Metadata = {
  title: "Terragon",
  description: "Internal Terragon access portal.",
  authors: [{ name: "Terragon Labs" }],
  creator: "Terragon Labs",
  publisher: "Terragon Labs",
  robots: { index: false, follow: false },
  openGraph: {
    title: "Terragon",
    description: "Internal Terragon access portal.",
    url: publicAppUrl(),
    siteName: "Terragon",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Terragon",
    description: "Internal Terragon access portal.",
    site: "@terragonlabs",
    creator: "@terragonlabs",
  },
  alternates: {
    canonical: `${publicAppUrl()}/`,
  },
  metadataBase: new URL(publicAppUrl()),
};

export default async function Home() {
  const userInfo = await getUserInfoOrNull();
  if (userInfo) {
    redirect("/dashboard");
  }
  redirect("/login");
}
