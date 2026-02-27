import {
  updateSelectedModel,
  updateSelectedModels,
  updateMultiAgentMode,
  updateSelectedRepo,
  updateSelectedBranch,
  updateReleaseNotesLastSeen,
  getUserFlagsAction,
} from "@/server-actions/user-flags";
import type { UserFlags } from "@terragon/shared";
import type { AIModel, SelectedAIModels } from "@terragon/agent/types";
import { atom, Getter, Setter } from "jotai";
import { RELEASE_NOTES_VERSION } from "@/lib/constants";
import { userCredentialsAtom } from "./user-credentials";
import { getDefaultModel } from "@/lib/default-ai-model";
import { ServerActionResult, unwrapResult } from "@/lib/server-actions";

export const userFlagsAtom = atom<UserFlags | null>(null);

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
  callback: () => Promise<ServerActionResult<void>>,
): Promise<void> {
  const userFlags = get(userFlagsOrThrowAtom);
  const previousValues = Object.fromEntries(
    Object.entries(userFlags).filter(
      ([key]) => updates[key as keyof UserFlags],
    ),
  );
  set(userFlagsAtom, { ...userFlags, ...updates });
  try {
    unwrapResult(await callback());
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

export const lastSeenReleaseNotesVersionAtom = atom<number | null, [], void>(
  (get) => {
    const userFlags = get(userFlagsAtom);
    return userFlags?.lastSeenReleaseNotesVersion ?? null;
  },
  async (get, set) => {
    await optimisticUpdateUserFlags(
      get,
      set,
      { lastSeenReleaseNotesVersion: RELEASE_NOTES_VERSION },
      async () => updateReleaseNotesLastSeen(),
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
