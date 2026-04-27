"use client";

import { useAtomValue } from "jotai";
import { userAtom } from "@/atoms/user";

interface SidebarAuthWrapperProps {
  children: React.ReactNode;
}

export function SidebarAuthWrapper({ children }: SidebarAuthWrapperProps) {
  const user = useAtomValue(userAtom);

  // Only render sidebar components if user is logged in
  if (!user) return null;

  return <>{children}</>;
}
