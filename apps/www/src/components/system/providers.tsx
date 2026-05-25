"use client";

import { Provider } from "jotai";
import { getOrCreateStore } from "@/lib/jotai";
import { QueryClientProvider } from "@tanstack/react-query";
import { getOrCreateQueryClient } from "@/lib/query-client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "next-themes";
import { ThemeColorMeta } from "./theme-color-meta";
import { AutoRefresh } from "./auto-refresh";
import { InstallPrompt } from "./install-prompt";
import { ServiceWorkerRegister } from "./service-worker-register";
import { KeyboardInset } from "./keyboard-inset";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={getOrCreateQueryClient()}>
      <Provider store={getOrCreateStore()}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider>
            <ThemeColorMeta />
            <AutoRefresh />
            <ServiceWorkerRegister />
            <InstallPrompt />
            <KeyboardInset />
            {children}
          </TooltipProvider>
        </ThemeProvider>
      </Provider>
    </QueryClientProvider>
  );
}
