import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8");

describe("ThreadListItem render fanout", () => {
  it("keeps row selection subscribed to one thread instead of the whole set", () => {
    const itemSource = readSource("src/components/thread-list/item.tsx");
    const atomSource = readSource("src/atoms/user-cookies.ts");

    expect(atomSource).toContain("atomFamily");
    expect(atomSource).toContain("selectedThreadAtom");
    expect(itemSource).toContain("selectedThreadAtom(thread.id)");
    expect(itemSource).not.toContain("selectedThreadIdsAtom");
  });

  it("keeps heavy per-row affordances out of the default row render path", () => {
    const itemSource = readSource("src/components/thread-list/item.tsx");
    const lazyMenuSource = readSource(
      "src/components/thread-list/lazy-thread-list-menu.tsx",
    );

    expect(itemSource).toContain("LazyThreadListMenu");
    expect(itemSource).not.toContain("ThreadMenuDropdown");
    expect(lazyMenuSource).toContain("ThreadMenuDropdown");
  });
});
