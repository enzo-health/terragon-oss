import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Offline · Terragon",
  robots: { index: false, follow: false },
};

export default function OfflinePage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="font-serif text-2xl">You&apos;re offline</h1>
      <p className="text-muted-foreground max-w-sm text-sm">
        Terragon needs a connection for live tasks and chat. Reconnect and this
        page will pick back up.
      </p>
    </main>
  );
}
