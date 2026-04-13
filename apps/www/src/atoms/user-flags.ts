import type { AIModel, SelectedAIModels } from "@terragon/agent/types";
import type { UserFlags } from "@terragon/shared";
import { atom, Getter, Setter } from "jotai";
import { getDefaultModel } from "@/lib/default-ai-model";
import { ServerActionResult, unwrapResult } from "@/lib/server-actions";
import {
  getUserFlagsAction,
  updateMultiAgentMode,
  updatePromptPreferences,
  updateSelectedBranch,
  updateSelectedModel,
  updateSelectedModels,
  updateSelectedRepo,
} from "@/server-actions/user-flags";
import { userCredentialsAtom } from "./user-credentials";

export const userFlagsAtom = atom<UserFlags | null>(null);

const USER_FLAGS_LOCAL_ECHO_WINDOW_MS = 1_500;
let latestLocalUserFlagsWriteAt = 0;

function markLocalUserFlagsWrite(): void {
  latestLocalUserFlagsWriteAt = Date.now();
}

export function shouldSkipUserFlagsBroadcastRefetch(): boolean {
  return (
    Date.now() - latestLocalUserFlagsWriteAt < USER_FLAGS_LOCAL_ECHO_WINDOW_MS
  );
}

export const userFlagsRefetchAtom = atom(null, async (get, set) => {
  const userFlagsResult = await getUserFlagsAction();
  if (!userFlagsResult.success) {
    console.error(userFlagsResult.errorMessage);
    return;
  }
  set(userFlagsAtom, userFlagsResult.data);
});

const userFlagsOrThrowAtom = atom<UserFlags>((get) => {
  const userFlags = get(userFlagsAtom);
  if (!userFlags) {
    throw new Error("User flags not loaded");
  }
  return userFlags;
});

async function optimisticUpdateUserFlags(
  get: Getter,
  set: Setter,
  updates: Partial<UserFlags>,
  callback: (
    changedUpdates: Partial<UserFlags>,
  ) => Promise<ServerActionResult<void>>,
): Promise<void> {
  const userFlags = get(userFlagsOrThrowAtom);
  const changedUpdates = Object.fromEntries(
    Object.entries(updates).filter(
      ([key, value]) => userFlags[key as keyof UserFlags] !== value,
    ),
  );
  if (Object.keys(changedUpdates).length === 0) {
    return;
  }

  const previousValues = Object.fromEntries(
    Object.keys(changedUpdates).map((key) => [
      key,
      userFlags[key as keyof UserFlags],
    ]),
  );
  set(userFlagsAtom, { ...userFlags, ...changedUpdates });
  markLocalUserFlagsWrite();
  try {
    unwrapResult(await callback(changedUpdates));
  } catch (error) {
    set(userFlagsAtom, { ...userFlags, ...previousValues });
    throw error;
  }
}

const selectedModalLocalAtom = atom<AIModel | null>(null);

export const selectedModelAtom = atom<AIModel, [AIModel], void>(
  (get) => {
    const selectedModalLocal = get(selectedModalLocalAtom);
    if (selectedModalLocal) {
      return selectedModalLocal;
    }
    const userFlags = get(userFlagsAtom);
    const userCredentials = get(userCredentialsAtom);
    return getDefaultModel({ userCredentials, userFlags });
  },
  (_get, set, model) => {
    set(selectedModalLocalAtom, model);
  },
);

export const selectedModelPersistedAtom = atom<null, [AIModel], void>(
  null,
  async (get, set, model) => {
    await optimisticUpdateUserFlags(
      get,
      set,
      { selectedModel: model },
      async () => updateSelectedModel(model),
    );
  },
);

export const promptPreferencesPersistedAtom = atom<
  null,
  [
    Partial<
      Pick<
        UserFlags,
        | "selectedModel"
        | "selectedModels"
        | "multiAgentMode"
        | "selectedRepo"
        | "selectedBranch"
      >
    >,
  ],
  void
>(null, async (get, set, updates) => {
  await optimisticUpdateUserFlags(get, set, updates, async (changedUpdates) =>
    updatePromptPreferences(changedUpdates),
  );
});

// Derived atom for selected repo
export const selectedRepoAtom = atom<string | null, [string | null], void>(
  (get) => {
    const userFlags = get(userFlagsAtom);
    if (userFlags?.selectedRepo) {
      return userFlags.selectedRepo;
    }
    return null;
  },
  async (get, set, repo) => {
    await optimisticUpdateUserFlags(
      get,
      set,
      { selectedRepo: repo },
      async () => updateSelectedRepo(repo),
    );
  },
);

// Derived atom for selected branch
export const selectedBranchAtom = atom<string | null, [string | null], void>(
  (get) => {
    const userFlags = get(userFlagsAtom);
    if (userFlags?.selectedBranch) {
      return userFlags.selectedBranch;
    }
    return null;
  },
  async (get, set, branch) => {
    await optimisticUpdateUserFlags(
      get,
      set,
      { selectedBranch: branch },
      async () => updateSelectedBranch(branch),
    );
  },
);

export const selectedModelsPersistedAtom = atom<
  SelectedAIModels,
  [SelectedAIModels],
  void
>(
  (get) => {
    const userFlags = get(userFlagsAtom);
    if (userFlags?.selectedModels) {
      return userFlags.selectedModels;
    }
    const selectedModel = get(selectedModelAtom);
    return { [selectedModel]: 1 };
  },
  async (get, set, selectedModels) => {
    await optimisticUpdateUserFlags(get, set, { selectedModels }, async () =>
      updateSelectedModels(selectedModels),
    );
  },
);

export const multiAgentModePersistedAtom = atom<boolean, [boolean], void>(
  (get) => {
    const userFlags = get(userFlagsAtom);
    return !!userFlags?.multiAgentMode;
  },
  async (get, set, mode) => {
    await optimisticUpdateUserFlags(
      get,
      set,
      { multiAgentMode: mode },
      async () => updateMultiAgentMode(mode),
    );
  },
);
