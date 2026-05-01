"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--card)",
          "--normal-text": "var(--card-foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "color-mix(in srgb, var(--success) 10%, var(--card))",
          "--success-text": "var(--success)",
          "--success-border":
            "color-mix(in srgb, var(--success) 30%, transparent)",
          "--error-bg": "color-mix(in srgb, var(--error) 10%, var(--card))",
          "--error-text": "var(--error)",
          "--error-border": "color-mix(in srgb, var(--error) 30%, transparent)",
          "--warning-bg": "color-mix(in srgb, var(--warning) 10%, var(--card))",
          "--warning-text": "var(--warning)",
          "--warning-border":
            "color-mix(in srgb, var(--warning) 30%, transparent)",
          "--info-bg": "color-mix(in srgb, var(--info) 10%, var(--card))",
          "--info-text": "var(--info)",
          "--info-border": "color-mix(in srgb, var(--info) 30%, transparent)",
          "--border-radius": "var(--radius)",
          "--shadow": "var(--shadow-card)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
