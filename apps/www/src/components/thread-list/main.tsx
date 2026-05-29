"use client";

import { usePathname, useRouter } from "next/navigation";
import { ThreadListFilters } from "@/queries/thread-queries";
import { ThreadListContentsClient } from "./thread-list-contents-client";
import { ThreadListHeader } from "./header";

type ThreadListMainProps = {
  viewFilter: "all" | "active" | "archived";
  queryFilters: ThreadListFilters;
  allowGroupBy: boolean;
  showSuggestedTasks?: boolean;
  setPromptText: (promptText: string) => void;
};

export function ThreadListMain({
  viewFilter,
  queryFilters,
  allowGroupBy,
  showSuggestedTasks = true,
  setPromptText,
}: ThreadListMainProps) {
  const { push } = useRouter();
  const pathname = usePathname();
  const setViewFilter = (value: "active" | "archived") => {
    const params = new URLSearchParams(window.location.search);
    params.delete("archived");
    if (value === "archived") {
      params.set("archived", "true");
    }
    const query = params.toString();
    push(query ? `${pathname}?${query}` : pathname);
  };
  return (
    <div className="flex-1 pb-2 flex flex-col animate-in fade-in duration-500">
      <ThreadListHeader
        className="sticky top-0 bg-sidebar z-20 px-0 "
        viewFilter={viewFilter}
        setViewFilter={setViewFilter}
        allowGroupBy={allowGroupBy}
      />
      <ThreadListContentsClient
        viewFilter={viewFilter}
        queryFilters={queryFilters}
        showSuggestedTasks={showSuggestedTasks}
        setPromptText={setPromptText}
        allowGroupBy={allowGroupBy}
        isSidebar={false}
      />
    </div>
  );
}
