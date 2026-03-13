// Client-side Web Vitals instrumentation
// Next.js automatically calls this file on the client

export function onWebVitalsReport(metric: {
  name: string;
  value: number;
  id: string;
  rating: "good" | "needs-improvement" | "poor";
}) {
  // Log to console in development for visibility
  if (process.env.NODE_ENV === "development") {
    const color =
      metric.rating === "good"
        ? "green"
        : metric.rating === "needs-improvement"
          ? "orange"
          : "red";
    console.log(
      `%c[Web Vital] ${metric.name}: ${Math.round(metric.value)}ms (${metric.rating})`,
      `color: ${color}; font-weight: bold`,
    );
  }
}
