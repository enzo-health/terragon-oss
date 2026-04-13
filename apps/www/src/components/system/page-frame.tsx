import { SiteHeader } from "@/components/system/site-header";

export function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-0 md:py-4 md:pr-4 md:pl-2">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card transition-[border-radius,box-shadow] duration-200 md:rounded-[10px] md:border md:border-border md:shadow-sm">
        <SiteHeader />
        <div className="min-h-0 w-full flex-1 overflow-auto px-4">
          {children}
        </div>
      </div>
    </div>
  );
}
