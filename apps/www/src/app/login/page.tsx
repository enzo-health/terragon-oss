import { getUserIdOrNull } from "@/lib/auth-server";
import { redirect } from "next/navigation";
import Login from "./login";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in | Terragon",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnUrl?: string }>;
}) {
  const userId = await getUserIdOrNull();
  const { returnUrl = "/dashboard" } = await searchParams;
  if (userId) {
    redirect(returnUrl);
  }

  return <Login returnUrl={returnUrl} />;
}
