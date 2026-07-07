"use client";

import Image from "next/image";
import plantLight from "./plant-light.png";
import plantDark from "./plant-dark.png";
import { cn } from "@/lib/utils";
import Link from "next/link";

type IconSize = "sm" | "md" | "lg";

const logoPixelSize: Record<IconSize, number> = {
  sm: 18,
  md: 24,
  lg: 32,
};

export function Wordmark({
  showLogo = true,
  showText = true,
  href = "/",
  size = "md",
}: {
  showLogo?: boolean;
  showText?: boolean;
  href?: string;
  size?: IconSize;
}) {
  return (
    <Link href={href} className="group flex items-center gap-1.5 select-none">
      {showLogo && (
        <span className="transition-opacity motion-safe:duration-[var(--duration-quick)] motion-safe:ease-[var(--ease-emphasis)] group-hover:opacity-80">
          <WordmarkLogo size={size} />
        </span>
      )}
      {showText && (
        <span
          className={cn(
            "font-display font-[350] leading-none tracking-[-0.01em] text-foreground antialiased transition-colors motion-safe:duration-[var(--duration-quick)] motion-safe:ease-[var(--ease-emphasis)] group-hover:text-foreground/80",
            size === "sm"
              ? "text-lg"
              : size === "md"
                ? "text-xl"
                : "text-[28px]",
          )}
        >
          Terragon
        </span>
      )}
    </Link>
  );
}

export function WordmarkLogo({ size = "sm" }: { size?: IconSize }) {
  const dimension = logoPixelSize[size];
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center"
      style={{ width: dimension, height: dimension }}
    >
      <Image
        className="block dark:hidden"
        src={plantLight}
        alt="Plant"
        width={dimension}
        height={dimension}
      />
      <Image
        className="hidden dark:block"
        src={plantDark}
        alt="Plant"
        width={dimension}
        height={dimension}
      />
    </span>
  );
}
