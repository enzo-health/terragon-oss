import { getUserInfoOrNull } from "@/lib/auth-server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { publicAppUrl } from "@leo/env/next-public";

export const maxDuration = 800;

export const metadata: Metadata = {
  title: "Leo",
  description: "Internal Leo access portal.",
  authors: [{ name: "Leo Labs" }],
  creator: "Leo Labs",
  publisher: "Leo Labs",
  robots: { index: false, follow: false },
  openGraph: {
    title: "Leo",
    description: "Internal Leo access portal.",
    url: publicAppUrl(),
    siteName: "Leo",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Leo",
    description: "Internal Leo access portal.",
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
