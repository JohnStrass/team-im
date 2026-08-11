import { describe, expect, it } from "vitest";

import { hasCodeBlock, parseInline, parseMessage } from "../shared/rich-text";

describe("parseInline", () => {
  it("keeps plain text as a single span", () => {
    expect(parseInline("just words")).toEqual([{ kind: "text", text: "just words" }]);
  });

  it("recognises inline code, bold and italic", () => {
    expect(parseInline("run `npm test` when **done** or *later*")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "npm test" },
      { kind: "text", text: " when " },
      { kind: "strong", text: "done" },
      { kind: "text", text: " or " },
      { kind: "emphasis", text: "later" },
    ]);
  });

  it("treats emphasis inside inline code as literal", () => {
    // Precedence matters: agents paste globs and pointers that look like markup.
    expect(parseInline("`**not bold**`")).toEqual([{ kind: "code", text: "**not bold**" }]);
  });

  it("extracts mentions and lower-cases the handle while keeping the display text", () => {
    expect(parseInline("ping @client-author now")).toEqual([
      { kind: "text", text: "ping " },
      { kind: "mention", handle: "client-author", text: "@client-author" },
      { kind: "text", text: " now" },
    ]);
  });

  it("does not treat an email address as a mention", () => {
    const spans = parseInline("mail someone@example.com please");
    expect(spans.some((span) => span.kind === "mention")).toBe(false);
  });

  it("tokenizes bare URLs so they can be styled without becoming links", () => {
    expect(parseInline("see http://203.0.113.113:8765/messages ok")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "http://203.0.113.113:8765/messages" },
      { kind: "text", text: " ok" },
    ]);
  });
});

describe("parseMessage", () => {
  it("splits a fenced code block out of surrounding prose", () => {
    expect(parseMessage("before\n\n```py\nprint(1)\n```\n\nafter")).toEqual([
      { kind: "paragraph", spans: [{ kind: "text", text: "before" }] },
      { kind: "code", language: "py", text: "print(1)" },
      { kind: "paragraph", spans: [{ kind: "text", text: "after" }] },
    ]);
  });

  it("handles a fence with no language", () => {
    const [block] = parseMessage("```\nraw\n```");
    expect(block).toEqual({ kind: "code", language: "", text: "raw" });
  });

  it("preserves blank-line paragraph breaks", () => {
    expect(parseMessage("one\n\ntwo")).toHaveLength(2);
  });

  it("keeps single newlines inside one paragraph", () => {
    // The timeline renders with white-space: pre-wrap, so a soft break stays a
    // soft break instead of becoming a new block.
    expect(parseMessage("one\ntwo")).toHaveLength(1);
  });

  it("leaves an unterminated fence as readable text instead of swallowing the rest", () => {
    const blocks = parseMessage("look\n\n```py\nprint(1)");
    expect(blocks.every((block) => block.kind === "paragraph")).toBe(true);
  });

  it("reports whether a message carries code", () => {
    expect(hasCodeBlock("```\nx\n```")).toBe(true);
    expect(hasCodeBlock("no code here")).toBe(false);
  });
});
