import { cn } from "@/lib/utils";
import type { PlanSpecViewModel } from "@/lib/sdlc-plan-view-model";

export function SdlcPlanReviewCard({
  plan,
  className,
}: {
  plan: PlanSpecViewModel;
  className?: string;
}) {
  return (
    <section
      aria-label="SDLC plan review"
      className={cn(
        "rounded-lg border bg-card p-3 text-card-foreground",
        className,
      )}
    >
      <header className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Plan Review
        </p>
        <h3 className="text-sm font-semibold leading-tight">{plan.title}</h3>
        <p className="text-xs text-muted-foreground whitespace-pre-wrap">
          {plan.summary}
        </p>
      </header>

      <div className="mt-3 space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Tasks
        </h4>
        <ol className="space-y-2">
          {plan.tasks.map((task) => (
            <li
              key={task.stableTaskId}
              className="rounded-md border bg-muted/30 p-2"
            >
              <p className="text-xs font-semibold">{task.title}</p>
              {task.description && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {task.description}
                </p>
              )}
              {task.acceptance.length > 0 && (
                <div className="mt-1.5">
                  <p className="text-[11px] font-medium text-muted-foreground">
                    Acceptance criteria
                  </p>
                  <ul className="mt-1 list-disc pl-4 text-xs text-foreground">
                    {task.acceptance.map((criterion) => (
                      <li key={`${task.stableTaskId}-${criterion}`}>
                        {criterion}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>

      {plan.assumptions.length > 0 && (
        <div className="mt-3 space-y-1">
          <h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Assumptions / Defaults
          </h4>
          <ul className="list-disc pl-4 text-xs text-foreground">
            {plan.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
