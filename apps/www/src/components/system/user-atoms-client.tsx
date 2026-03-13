"use client";

import { useEffect } from "react";
import { UserCookies } from "@/lib/cookies";
import {
  bearerTokenAtom,
  userAtom,
  userSettingsAtom,
  userSettingsRefetchAtom,
  impersonationAtom,
  ImpersonationInfo,
  userFeatureFlagsAtom,
} from "@/atoms/user";
import { userCookiesInitAtom, timeZoneAtom } from "@/atoms/user-cookies";
import { userFlagsAtom, userFlagsRefetchAtom } from "@/atoms/user-flags";
import { useHydrateAtoms } from "jotai/utils";
import {
  User,
  UserSettings,
  UserFlags,
  UserCredentials,
} from "@terragon/shared";
import { useRealtimeUser } from "@/hooks/useRealtime";
import { useAtom, useSetAtom } from "jotai";
// Lazy-load posthog-js to reduce initial bundle (~45KB gzipped)
const getPostHog = () => import("posthog-js").then((m) => m.default);
import {
  userCredentialsAtom,
  userCredentialsRefetchAtom,
} from "@/atoms/user-credentials";

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
    onMessage: () => refetchUserFlags(),
  });
  useRealtimeUser({
    matches: (message) => !!message.data.userCredentials,
    onMessage: () => refetchUserCredentials(),
  });
  useEffect(() => {
    if (user) {
      getPostHog().then((posthog) => {
        posthog.identify(user.id, {
          name: user.name,
          email: user.email,
        });
      });
    }
  }, [user]);
  return children;
}
