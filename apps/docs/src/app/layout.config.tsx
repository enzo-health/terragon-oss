import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import Image from "next/image";
import { House, ChevronLeft } from "lucide-react";
import icon from "./icon.png";

/**
 * Shared layout configurations
 *
 * you can customise layouts individually from:
 * Home Layout: app/(home)/layout.tsx
 * Docs Layout: app/docs/layout.tsx
 */
export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <div className="flex items-center gap-2 py-2">
        <Image src={icon} alt="Leo" width={24} height={24} />
        Leo Docs
      </div>
    ),
  },
};
