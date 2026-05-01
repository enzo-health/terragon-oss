import Link from "next/link";
import {
  Users,
  Settings,
  Monitor,
  FolderOpen,
  Wrench,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";

interface AdminSection {
  title: string;
  href: string;
}

interface AdminCategory {
  name: string;
  icon: LucideIcon;
  sections: AdminSection[];
}

const adminCategories: AdminCategory[] = [
  {
    name: "User Management",
    icon: Users,
    sections: [
      { title: "Me", href: "/internal/admin/me" },
      { title: "Users", href: "/internal/admin/user" },
    ],
  },
  {
    name: "Security & Abuse",
    icon: ShieldAlert,
    sections: [
      { title: "Abuse Detection", href: "/internal/admin/abuse-detection" },
    ],
  },
  {
    name: "Configuration",
    icon: Settings,
    sections: [
      { title: "Feature Flags", href: "/internal/admin/feature-flags" },
      { title: "Top Banner", href: "/internal/admin/banner" },
    ],
  },
  {
    name: "Operations & Monitoring",
    icon: Monitor,
    sections: [
      { title: "Threads", href: "/internal/admin/thread" },
      { title: "Environments", href: "/internal/admin/environment" },
      { title: "Active Sandboxes", href: "/internal/admin/sandboxes" },
      { title: "Sandbox Logs", href: "/internal/admin/sandbox" },
      { title: "Automations", href: "/internal/admin/automations" },
    ],
  },
  {
    name: "Content Management",
    icon: FolderOpen,
    sections: [
      { title: "Image Upload", href: "/internal/admin/images" },
      { title: "CDN Objects", href: "/internal/admin/cdn-objects" },
    ],
  },
  {
    name: "Development Tools",
    icon: Wrench,
    sections: [
      { title: "Github PRs", href: "/internal/admin/github/pr" },
      {
        title: "Github App Tester",
        href: "/internal/admin/github/app-tester",
      },
      {
        title: "Slack Message Debugger",
        href: "/internal/admin/slack-message-debugger",
      },
      {
        title: "Slack Installations",
        href: "/internal/admin/slack-installations",
      },
    ],
  },
];

export function AdminMain() {
  return (
    <div className="flex h-full w-full flex-col justify-start">
      <div className="flex w-full flex-col gap-6">
        {adminCategories.map((category) => (
          <div key={category.name} className="flex flex-col gap-2">
            <h2 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              <category.icon className="h-3.5 w-3.5" />
              <span>{category.name}</span>
            </h2>
            <div className="flex flex-col pl-6">
              {category.sections.map((section) => (
                <Link
                  key={section.href}
                  href={section.href}
                  className="rounded-md px-2 py-1 text-sm text-foreground transition-colors hover:bg-sunken hover:text-coral-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/50"
                >
                  {section.title}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
