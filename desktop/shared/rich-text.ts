/**
 * A deliberately small message formatter for the chat timeline.
 *
 * This produces TOKENS, never HTML. The renderer turns tokens into React
 * elements, so message text can never introduce markup - which is why there is
 * no markdown library here and no dangerouslySetInnerHTML anywhere in the app.
 *
 * Scope is what agents actually paste into this room: fenced code blocks, inline
 * code, bold, italic, @mentions and bare URLs. Links are tokenized so they can be
 * styled, but the renderer keeps them as text - this app blocks navigation, and a
 * clickable link in an untrusted message is exactly the wrong affordance.
 */

export interface CodeBlock {
  kind: "code";
  language: string;
  text: string;
}

export interface ParagraphBlock {
  kind: "paragraph";
  spans: Span[];
}

export type Block = CodeBlock | ParagraphBlock;

export type Span =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "emphasis"; text: string }
  | { kind: "mention"; handle: string; text: string }
  | { kind: "link"; text: string };

const FENCE = /```([A-Za-z0-9+#._-]*)\r?\n?([\s\S]*?)```/g;

/**
 * Hard ceiling on blocks produced by one message.
 *
 * Input length is NOT an adequate bound. A single legal 8,000-character message
 * of nothing but backticks parses into 1,334 adjacent empty fences, and every
 * code block renders as a stateful widget (header, language, copy button, pre,
 * code). At the 500-message retention limit that is ~667,000 widgets and over
 * 3.3M DOM elements from senders on an unauthenticated LAN - an availability
 * bug, not a parsing one, and worse at render time than at parse time.
 *
 * Measured by reviewer-a against the committed tokenizer: 1.225 ms and 1,334
 * blocks for one message; 94.3 ms, 667,000 blocks and 38.3 MiB for 500, before
 * React allocated anything.
 */
export const MAX_BLOCKS_PER_MESSAGE = 24;

/**
 * Hard ceiling on inline spans in one paragraph.
 *
 * Capping blocks alone was NOT enough, and this is the second time the same
 * cost has moved rather than disappeared. A legal 8,000-character message of
 * "@a " repeated is a SINGLE block containing 5,332 spans, and every mention
 * span renders as a real interactive button - so 500 retained messages is
 * ~2.67M DOM elements, worse than the block-level bomb this file already
 * guards against.
 *
 * Predicted before it was found, by second-impl (review), who hit the
 * identical explosion in a completely different toolkit: they bounded GTK
 * widgets and the cost reappeared in Pango attribute lists at 5,332 spans -
 * the same number, on the same input, in a different language. Their framing
 * is the durable part: bounding a container does not bound its contents, and
 * you should expect the cost to surface again one layer down.
 *
 * 400 matches their cap deliberately, so two implementations degrade at the
 * same point. For scale, the busiest real message in this room measured 32.
 */
export const MAX_SPANS_PER_PARAGRAPH = 400;

// Order matters: inline code wins over emphasis so `**not bold**` stays literal.
const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\bhttps?:\/\/[^\s<>"')]+)|((?:^|[^A-Za-z0-9_])@[A-Za-z0-9][A-Za-z0-9_-]{0,39})/g;

function pushText(spans: Span[], text: string): void {
  if (!text) return;
  const previous = spans[spans.length - 1];
  if (previous?.kind === "text") previous.text += text;
  else spans.push({ kind: "text", text });
}

/** Split one paragraph's text into inline spans. */
export function parseInline(input: string): Span[] {
  const spans: Span[] = [];
  let index = 0;

  for (const match of input.matchAll(INLINE)) {
    // Past the cap, stop styling and emit the entire remainder as one plain
    // text span. The message stays reproduced IN FULL - only its formatting
    // degrades - so a hostile paste can cost us rendering fidelity but never
    // the record of what was actually said.
    if (spans.length >= MAX_SPANS_PER_PARAGRAPH - 1) break;

    const start = match.index ?? 0;
    pushText(spans, input.slice(index, start));

    const [raw, code, strong, emphasis, link, mention] = match;

    if (code) {
      spans.push({ kind: "code", text: code.slice(1, -1) });
    } else if (strong) {
      spans.push({ kind: "strong", text: strong.slice(2, -2) });
    } else if (emphasis) {
      spans.push({ kind: "emphasis", text: emphasis.slice(1, -1) });
    } else if (link) {
      spans.push({ kind: "link", text: link });
    } else if (mention) {
      // The mention pattern eats one leading boundary character so it cannot
      // match inside an email address. Put that character back as plain text.
      const at = mention.indexOf("@");
      pushText(spans, mention.slice(0, at));
      const handle = mention.slice(at + 1);
      spans.push({ kind: "mention", handle: handle.toLowerCase(), text: `@${handle}` });
    }

    index = start + raw.length;
  }

  pushText(spans, input.slice(index));
  return spans;
}

/**
 * Split a message into code blocks and paragraphs.
 *
 * An unterminated fence is treated as literal text rather than swallowing the
 * rest of the message - a half-pasted snippet should still be readable.
 */
export function parseMessage(input: string): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  let truncatedAt: number | null = null;

  // Reserve one slot for the overflow paragraph so the TOTAL is bounded by
  // MAX_BLOCKS_PER_MESSAGE, not MAX + 1. An off-by-one in a limit is still an
  // unbounded-ish limit as far as a reviewer is concerned.
  const full = (): boolean => blocks.length >= MAX_BLOCKS_PER_MESSAGE - 1;

  const addParagraphs = (text: string): void => {
    for (const chunk of text.split(/\n{2,}/)) {
      const trimmed = chunk.replace(/^\n+|\n+$/g, "");
      if (!trimmed) continue;
      if (full()) { truncatedAt ??= index; return; }
      blocks.push({ kind: "paragraph", spans: parseInline(trimmed) });
    }
  };

  for (const match of input.matchAll(FENCE)) {
    const start = match.index ?? 0;
    addParagraphs(input.slice(index, start));
    const text = (match[2] ?? "").replace(/\n+$/, "");
    const language = (match[1] ?? "").toLowerCase();

    index = start + match[0].length;

    // A fence with no language AND no content carries no information, and a run
    // of them is the cheapest way to manufacture widgets. Render it as text.
    if (!text && !language) {
      addParagraphs(match[0]);
      continue;
    }
    if (full()) { truncatedAt ??= start; break; }
    blocks.push({ kind: "code", language, text });
  }

  if (truncatedAt === null) addParagraphs(input.slice(index));

  // Never silently swallow content: whatever did not fit becomes ONE plain
  // paragraph. The message stays fully readable; it just stops being able to
  // spend unbounded DOM to say it.
  if (truncatedAt !== null) {
    const rest = input.slice(truncatedAt).replace(/^\n+|\n+$/g, "");
    if (rest) blocks.push({ kind: "paragraph", spans: [{ kind: "text", text: rest }] });
  }

  return blocks;
}

/** True when the message is worth offering a "copy code" affordance for. */
export function hasCodeBlock(input: string): boolean {
  return parseMessage(input).some((block) => block.kind === "code");
}
