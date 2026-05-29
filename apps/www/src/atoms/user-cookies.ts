import { atom } from "jotai";
import {
  atomFamily,
  atomWithStorage,
  createJSONStorage,
  selectAtom,
} from "jotai/utils";
import {
  CollapsedSections,
  createNewBranchKey,
  defaultCollapsedSections,
  defaultThreadListGroupBy,
  defaultTimeZone,
  disableGitCheckpointingKey,
  secondaryPaneClosedKey,
  skipSetupKey,
  ThreadListGroupBy,
  threadListCollapsedKey,
  threadListCollapsedSectionsKey,
  threadListGroupByKey,
  timeZoneKey,
  UserCookies,
} from "@/lib/cookies";
import { getCookieOrNull, setCookie } from "@/lib/cookies-client";

export const userCookiesInitAtom = atom<null, [UserCookies], void>(
  null,
  (get, set, userCookies) => {
    for (const key of Object.keys(userCookies) as (keyof UserCookies)[]) {
      switch (key) {
        case threadListCollapsedSectionsKey: {
          if (userCookies[key]) {
            set(threadListCollapsedSectionsAtom, userCookies[key]);
          }
          break;
        }
        case timeZoneKey: {
          if (userCookies[key]) {
            set(timeZoneAtom, userCookies[key]);
          }
          break;
        }
        case disableGitCheckpointingKey: {
          if (typeof userCookies[key] === "boolean") {
            set(disableGitCheckpointingCookieAtom, userCookies[key] as boolean);
          }
          break;
        }
        case skipSetupKey: {
          if (typeof userCookies[key] === "boolean") {
            set(skipSetupCookieAtom, userCookies[key] as boolean);
          }
          break;
        }
        case createNewBranchKey: {
          if (typeof userCookies[key] === "boolean") {
            set(createNewBranchCookieAtom, userCookies[key] as boolean);
          }
          break;
        }
        case threadListGroupByKey: {
          if (userCookies[key]) {
            set(threadListGroupByAtom, userCookies[key]);
          }
          break;
        }
        case threadListCollapsedKey: {
          if (typeof userCookies[key] === "boolean") {
            set(threadListCollapsedAtom, userCookies[key] as boolean);
          }
          break;
        }
        case secondaryPaneClosedKey: {
          if (typeof userCookies[key] === "boolean") {
            set(secondaryPaneClosedAtom, userCookies[key] as boolean);
          }
          break;
        }
        default:
          const _exhaustiveCheck: never = key;
          console.error("Unhandled user cookie key:", _exhaustiveCheck);
      }
    }
  },
);

// Create a custom cookie storage for Jotai
const cookieStorage = createJSONStorage<any>(() => ({
  getItem: (key: string) => {
    const value = getCookieOrNull(key);
    return value ? JSON.stringify(value) : null;
  },
  setItem: (key: string, value: string) => {
    if (typeof document === "undefined") {
      return;
    }
    try {
      const parsed = JSON.parse(value);
      setCookie({
        key,
        value: JSON.stringify(parsed),
        maxAgeSecs: 365 * 24 * 60 * 60, // 1 year
      });
    } catch (e) {
      console.error("Failed to set cookie:", e);
    }
  },
  removeItem: (key: string) => {
    setCookie({
      key,
      value: "",
      maxAgeSecs: 0, // Expire immediately
    });
  },
}));

// Create an atom with cookie storage
export const threadListCollapsedSectionsAtom =
  atomWithStorage<CollapsedSections>(
    threadListCollapsedSectionsKey,
    defaultCollapsedSections,
    cookieStorage,
    { getOnInit: true },
  );

// Helper atom for updating individual sections
export const toggleThreadListCollapsedSectionAtom = atom(
  null,
  (get, set, section: keyof CollapsedSections) => {
    const current = get(threadListCollapsedSectionsAtom);
    set(threadListCollapsedSectionsAtom, {
      ...current,
      [section]: !current[section],
    });
  },
);

export const timeZoneAtom = atomWithStorage<string>(
  timeZoneKey,
  defaultTimeZone,
  cookieStorage,
  { getOnInit: true },
);

export const threadListGroupByAtom = atomWithStorage<ThreadListGroupBy>(
  threadListGroupByKey,
  defaultThreadListGroupBy,
  cookieStorage,
  { getOnInit: true },
);

// Atom for dismissing recommended tasks
const DISMISSED_RECOMMENDED_TASKS_KEY = "dismissed-recommended-tasks";

// Create a separate cookie storage for boolean values
const booleanCookieStorage = createJSONStorage<boolean>(() => ({
  getItem: (key: string) => {
    const value = getCookieOrNull(key);
    // getCookieOrNull returns the parsed JSON value, which could be boolean true/false or string "true"/"false"
    return value !== null
      ? JSON.stringify(value === true || value === "true")
      : null;
  },
  setItem: (key: string, value: string) => {
    if (typeof document === "undefined") {
      return;
    }
    try {
      const parsed = JSON.parse(value);
      setCookie({
        key,
        value: String(parsed),
        maxAgeSecs: 365 * 24 * 60 * 60, // 1 year
      });
    } catch (e) {
      console.error("Failed to set cookie:", e);
    }
  },
  removeItem: (key: string) => {
    setCookie({
      key,
      value: "",
      maxAgeSecs: 0, // Expire immediately
    });
  },
}));

export const dismissedRecommendedTasksAtom = atomWithStorage<boolean>(
  DISMISSED_RECOMMENDED_TASKS_KEY,
  false,
  booleanCookieStorage,
  { getOnInit: true },
);

// Persist the last-selected value for disabling git checkpointing when creating a thread
export const disableGitCheckpointingCookieAtom = atomWithStorage<boolean>(
  disableGitCheckpointingKey,
  false,
  booleanCookieStorage,
  { getOnInit: true },
);

// Persist the last-selected value for skipping setup script when creating a thread
export const skipSetupCookieAtom = atomWithStorage<boolean>(
  skipSetupKey,
  false,
  booleanCookieStorage,
  { getOnInit: true },
);

// Persist the last-selected value for creating a new branch when creating a thread
export const createNewBranchCookieAtom = atomWithStorage<boolean>(
  createNewBranchKey,
  true,
  booleanCookieStorage,
  { getOnInit: true },
);

// Persist the collapsed state of the thread list sidebar
export const threadListCollapsedAtom = atomWithStorage<boolean>(
  threadListCollapsedKey,
  false,
  booleanCookieStorage,
  { getOnInit: true },
);

// Persist the open/closed state of the secondary panel (desktop only)
export const secondaryPaneClosedAtom = atomWithStorage<boolean>(
  secondaryPaneClosedKey,
  false,
  booleanCookieStorage,
  { getOnInit: true },
);

// Thread selection state for bulk operations (not persisted)
export const threadSelectionAtom = atom<{
  selectedIds: Set<string>;
  isSelectionMode: boolean;
  lastSelectedId: string | null;
}>({
  selectedIds: new Set<string>(),
  isSelectionMode: false,
  lastSelectedId: null,
});

export const isThreadSelectionModeAtom = selectAtom(
  threadSelectionAtom,
  (selection) => selection.isSelectionMode,
);

export const lastSelectedThreadIdAtom = selectAtom(
  threadSelectionAtom,
  (selection) => selection.lastSelectedId,
);

export const threadListSectionCollapsedAtom = atomFamily((sectionId: string) =>
  selectAtom(
    threadListCollapsedSectionsAtom,
    (collapsedSections) => !!collapsedSections[sectionId],
  ),
);

export const selectedThreadAtom = atomFamily((threadId: string) =>
  atom((get) => get(threadSelectionAtom).selectedIds.has(threadId)),
);

// Helper atom to toggle selection mode
export const toggleSelectionModeAtom = atom(null, (get, set) => {
  const current = get(threadSelectionAtom);
  set(threadSelectionAtom, {
    ...current,
    isSelectionMode: !current.isSelectionMode,
    selectedIds: !current.isSelectionMode
      ? current.selectedIds
      : new Set<string>(),
    lastSelectedId: !current.isSelectionMode ? current.lastSelectedId : null,
  });
});

// Helper atom to enter selection mode with an initial selection
export const enterSelectionModeAtom = atom(
  null,
  (get, set, threadId: string) => {
    set(threadSelectionAtom, {
      selectedIds: new Set<string>([threadId]),
      isSelectionMode: true,
      lastSelectedId: threadId,
    });
  },
);

// Helper atom to exit selection mode
export const exitSelectionModeAtom = atom(null, (get, set) => {
  set(threadSelectionAtom, {
    selectedIds: new Set<string>(),
    isSelectionMode: false,
    lastSelectedId: null,
  });
});

// Helper atom to toggle a thread's selection
export const toggleThreadSelectionAtom = atom(
  null,
  (get, set, { threadId, range }: { threadId: string; range?: string[] }) => {
    const current = get(threadSelectionAtom);
    const newSelectedIds = new Set<string>(current.selectedIds);

    if (range && range.length > 0 && current.lastSelectedId) {
      // Range selection (Shift+click)
      const lastIndex = range.indexOf(current.lastSelectedId);
      const currentIndex = range.indexOf(threadId);

      if (lastIndex !== -1 && currentIndex !== -1) {
        const [start, end] =
          lastIndex < currentIndex
            ? [lastIndex, currentIndex]
            : [currentIndex, lastIndex];

        for (let i = start; i <= end; i++) {
          const id = range[i];
          if (id) {
            newSelectedIds.add(id);
          }
        }
      } else {
        newSelectedIds.add(threadId);
      }
    } else {
      // Toggle single selection
      if (newSelectedIds.has(threadId)) {
        newSelectedIds.delete(threadId);
      } else {
        newSelectedIds.add(threadId);
      }
    }

    set(threadSelectionAtom, {
      ...current,
      selectedIds: newSelectedIds,
      lastSelectedId: threadId,
    });
  },
);

// Helper atom to select all visible threads
export const selectAllThreadsAtom = atom(
  null,
  (get, set, threadIds: string[]) => {
    const current = get(threadSelectionAtom);
    set(threadSelectionAtom, {
      ...current,
      selectedIds: new Set<string>(threadIds),
      lastSelectedId: threadIds[threadIds.length - 1] || null,
    });
  },
);

// Helper atom to deselect all threads
export const deselectAllThreadsAtom = atom(null, (get, set) => {
  const current = get(threadSelectionAtom);
  set(threadSelectionAtom, {
    ...current,
    selectedIds: new Set<string>(),
    lastSelectedId: null,
  });
});
