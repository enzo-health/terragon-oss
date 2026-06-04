import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

interface SettingsCheckboxProps {
  label: string;
  description?: string | React.ReactNode;
  value: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export function SettingsCheckbox({
  label,
  description,
  value,
  onCheckedChange,
}: SettingsCheckboxProps) {
  return (
    <Label className="flex min-h-10 cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 -mx-2 transition-colors duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] hover:bg-canvas/70">
      <Checkbox
        checked={value}
        onCheckedChange={onCheckedChange}
        className="mt-0.5 shrink-0"
      />
      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
        <span className="text-sm font-medium text-strong text-balance">
          {label}
        </span>
        {description && (
          <span className="text-xs text-mid text-pretty leading-relaxed">
            {description}
          </span>
        )}
      </div>
    </Label>
  );
}

export function SettingsWithCTA({
  label,
  description,
  children,
  direction = "row",
}: {
  label: string;
  description?: string | React.ReactNode;
  children: React.ReactNode;
  direction?: "row" | "col";
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 rounded-lg px-2 py-1.5 -mx-2",
        {
          "flex-col gap-2": direction === "col",
          "flex-col sm:flex-row gap-4": direction === "row",
        },
      )}
    >
      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
        <Label className="text-sm font-medium text-strong text-balance">
          {label}
        </Label>
        {description && (
          <span className="text-xs text-mid text-pretty leading-relaxed">
            {description}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

export function SettingsSection({
  label,
  description,
  children,
  cta,
}: {
  label: string;
  description?: string | React.ReactNode;
  children: React.ReactNode;
  cta?: React.ReactNode;
}) {
  return (
    <section className="bg-card rounded-[1.25rem] p-6 space-y-6 border border-hairline shadow-inset-edge animate-in fade-in slide-in-from-bottom-1 duration-[var(--duration-base)] ease-[var(--ease-emphasis)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold tracking-[-0.01em] text-strong text-balance">
            {label}
          </h3>
          {description && (
            <p className="text-sm text-mid mt-1 text-pretty">{description}</p>
          )}
        </div>
        {cta && <div className="flex-shrink-0">{cta}</div>}
      </div>
      <div className="space-y-6">{children}</div>
    </section>
  );
}

export function SettingsWithExternalLink({
  label,
  description,
  href,
}: {
  label: string;
  description?: string | React.ReactNode;
  href: string;
}) {
  const { push } = useRouter();
  return (
    <SettingsWithCTA label={label} description={description}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          if (href.startsWith("/")) {
            push(href);
          } else {
            window.open(href, "_blank");
          }
        }}
        className="flex items-center gap-2 transition-[transform,background-color,border-color] duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] active:scale-[0.96]"
      >
        Manage
        <ExternalLink className="size-3" />
      </Button>
    </SettingsWithCTA>
  );
}
