import { SiteHeader } from "@/components/system/site-header";

export function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <div className="flex-1 w-full px-4 overflow-auto">{children}</div>
    </>
  );
}
