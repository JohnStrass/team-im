/**
 * Layout invariants that have broken in production before.
 *
 * These assert against the stylesheet text rather than a rendered DOM, which is
 * a weak test in general but the right one here: the bug was a CSS authoring
 * mistake, it survived every behavioural test we had, and it shipped twice.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../renderer/styles.css", import.meta.url), "utf8");

describe("the composer cannot be collapsed by a conditional sibling", () => {
  // History: .channel-view declares four rows, but the connection banner only
  // renders when NOT connected. With implicit placement the children shift up a
  // row whenever the app is working normally - the timeline takes the `auto`
  // row and grows to full content height, and the composer is squeezed to 0px
  // at the bottom edge. The app then has no visible way to type.
  //
  // Codex found this in packaged-window QA in July and fixed it with explicit
  // grid rows. A later stylesheet rewrite dropped the fix and it shipped again.
  const compact = css.replace(/\s+/g, " ");

  it.each([
    [".channel-header", 1],
    [".connection-banner", 2],
    [".timeline", 3],
    [".composer", 4],
  ])("%s is pinned to grid-row %i", (selector, row) => {
    expect(compact).toContain(`${selector} { grid-row: ${row}; }`);
  });

  it("declares four rows for the four children", () => {
    const match = css.match(/\.channel-view\s*\{[^}]*grid-template-rows:\s*([^;]+);/);
    expect(match).not.toBeNull();
    // header, banner, timeline, composer
    expect(match![1]!.trim().split(/\s+(?![^(]*\))/)).toHaveLength(4);
  });
});
