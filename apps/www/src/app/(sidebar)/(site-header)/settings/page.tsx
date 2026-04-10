import { GeneralSettings } from "@/components/settings/tab/general";
import { getUserIdOrRedirect } from "@/lib/auth-server";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Settings | Leo",
};

export default async function SettingsPage() {
  await getUserIdOrRedirect();
  return <GeneralSettings />;
}
