import { describe, expect, it } from "vitest";
import { buildDaytonaBaseImage } from "./snapshot-builder";

describe("buildDaytonaBaseImage", () => {
  it("constructs the Daytona base image without local context helpers", () => {
    const image = buildDaytonaBaseImage();

    expect(image.dockerfile).toContain("FROM ubuntu:24.04");
    expect(image.contextList).toEqual([]);
    expect(image.dockerfile).not.toContain("COPY supervisord.conf");
    expect(image.dockerfile).not.toContain("RUN RUN ");
    expect(image.dockerfile).toContain(
      "/etc/supervisor/conf.d/supervisord.conf",
    );
  });
});
