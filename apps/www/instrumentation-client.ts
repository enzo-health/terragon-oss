// Client-side Web Vitals instrumentation
// Next.js automatically calls this file on the client

export function onWebVitalsReport(metric: {
  name: string;
  value: number;
  id: string;
  rating: "good" | "needs-improvement" | "poor";
}) {
  if (process.env.NODE_ENV === "development") {
    const color =
      metric.rating === "good"
        ? "green"
        : metric.rating === "needs-improvement"
          ? "orange"
          : "red";
    // CLS is unitless (small decimal); other metrics are in ms
    const formatted =
      metric.name === "CLS"
        ? metric.value.toFixed(3)
        : `${Math.round(metric.value)}ms`;
    console.log(
      `%c[Web Vital] ${metric.name}: ${formatted} (${metric.rating})`,
      `color: ${color}; font-weight: bold`,
    );
  }
}
