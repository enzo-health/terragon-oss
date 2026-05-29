import { useAtomValue, useSetAtom } from "jotai";
import { usePathname } from "next/navigation";
import { threadListCollapsedAtom } from "@/atoms/user-cookies";
import { usePlatform } from "@/hooks/use-platform";

export function useCollapsibleThreadList(pathnameOverride?: string) {
  const currentPathname = usePathname();
  const pathname = pathnameOverride ?? currentPathname;
  const isMobile = usePlatform() === "mobile";
  const isThreadListCollapsedCookie = useAtomValue(threadListCollapsedAtom);
  const setIsThreadListCollapsedCookie = useSetAtom(threadListCollapsedAtom);
  const canCollapseThreadList = !isMobile && pathname !== "/dashboard";
  const setThreadListCollapsed = (collapsed: boolean) => {
    if (canCollapseThreadList) {
      setIsThreadListCollapsedCookie(collapsed);
    }
  };
  return {
    canCollapseThreadList,
    isThreadListCollapsed: canCollapseThreadList && isThreadListCollapsedCookie,
    setThreadListCollapsed,
  };
}
