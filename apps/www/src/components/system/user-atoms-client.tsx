"use client";

import {
  User,
  UserCredentials,
  UserFlags,
  UserSettings,
} from "@terragon/shared";
import { useAtom, useSetAtom } from "jotai";
import { useHydrateAtoms } from "jotai/utils";
import { useEffect } from "react";
import {
  bearerTokenAtom,
  ImpersonationInfo,
  impersonationAtom,
  userAtom,
  userFeatureFlagsAtom,
  userSettingsAtom,
  userSettingsRefetchAtom,
} from "@/atoms/user";
import { timeZoneAtom, userCookiesInitAtom } from "@/atoms/user-cookies";
import {
  userCredentialsAtom,
  userCredentialsRefetchAtom,
} from "@/atoms/user-credentials";
import {
  shouldSkipUserFlagsBroadcastRefetch,
  userFlagsAtom,
  userFlagsRefetchAtom,
} from "@/atoms/user-flags";
import { useRealtimeUser } from "@/hooks/useRealtime";
import { UserCookies } from "@/lib/cookies";

export function UserAtomsHydrator({
  user,
  userSettings,
  userFlags,
  userCredentials,
  bearerToken,
  impersonation,
  userFeatureFlags,
  userCookies,
  children,
}: {
  user: User | null;
  userSettings: UserSettings | null;
  userFlags: UserFlags | null;
  userCredentials: UserCredentials | null;
  bearerToken: string | null;
  userFeatureFlags: Record<string, boolean>;
  userCookies: UserCookies;
  impersonation?: ImpersonationInfo;
  children: React.ReactNode;
}) {
  useHydrateAtoms([
    [userAtom, user],
    [userSettingsAtom, userSettings],
    [userFlagsAtom, userFlags],
    [userCredentialsAtom, userCredentials],
    [bearerTokenAtom, bearerToken],
    [impersonationAtom, impersonation || { isImpersonating: false }],
    [userFeatureFlagsAtom, userFeatureFlags],
    [userCookiesInitAtom, userCookies],
  ]);

  const [timeZone, setTimeZone] = useAtom(timeZoneAtom);
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const currentTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timeZone !== currentTimeZone) {
      setTimeZone(currentTimeZone);
    }
  }, [timeZone, setTimeZone]);

  const refetchUserSettings = useSetAtom(userSettingsRefetchAtom);
  const refetchUserFlags = useSetAtom(userFlagsRefetchAtom);
  const refetchUserCredentials = useSetAtom(userCredentialsRefetchAtom);
  useRealtimeUser({
    matches: (message) => !!message.data.userSettings,
    onMessage: () => refetchUserSettings(),
  });
  useRealtimeUser({
    matches: (message) => !!message.data.userFlags,
    onMessage: () => {
      if (shouldSkipUserFlagsBroadcastRefetch()) {
        return;
      }
      refetchUserFlags();
    },
  });
  useRealtimeUser({
    matches: (message) => !!message.data.userCredentials,
    onMessage: () => refetchUserCredentials(),
  });
  return children;
}
