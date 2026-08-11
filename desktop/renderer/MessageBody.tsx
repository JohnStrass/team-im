import { Fragment, useMemo, useState } from "react";

import { parseMessage } from "../shared/rich-text";

/**
 * Render message text from tokens.
 *
 * Every branch below produces a React element from a plain string, so message
 * content is always escaped by React. Nothing here builds markup from the
 * message, which is what keeps a hostile paste in the room from becoming
 * anything more interesting than ugly text.
 */
export function MessageBody({
  text,
  knownHandles,
  onMentionClick,
}: {
  text: string;
  /**
   * Handles that may render as a live mention chip. REQUIRED, not optional:
   * an optional set defaults to "chip everything", which is the behaviour
   * being fixed, and every optional safety field on this project so far has
   * eventually been forgotten by a caller.
   */
  knownHandles: ReadonlySet<string>;
  onMentionClick?: (handle: string) => void;
}) {
  const blocks = useMemo(() => parseMessage(text), [text]);

  return (
    <div className="message-body">
      {blocks.map((block, blockIndex) => {
        if (block.kind === "code") {
          return <CodeBlock key={blockIndex} language={block.language} text={block.text} />;
        }

        return (
          <p key={blockIndex}>
            {block.spans.map((span, spanIndex) => {
              switch (span.kind) {
                case "code":
                  return <code key={spanIndex} className="inline-code">{span.text}</code>;
                case "strong":
                  return <strong key={spanIndex}>{span.text}</strong>;
                case "emphasis":
                  return <em key={spanIndex}>{span.text}</em>;
                case "link":
                  // Rendered as text on purpose: the app blocks navigation, and a
                  // clickable link inside an untrusted message is the wrong offer.
                  return <span key={spanIndex} className="link-text">{span.text}</span>;
                case "mention":
                  // An unknown handle is text, not an affordance. @everyone,
                  // @nobody and a mistyped handle all used to render in the
                  // same blue as a real mention while reaching no one.
                  if (!knownHandles.has(span.handle)) {
                    return <Fragment key={spanIndex}>{span.text}</Fragment>;
                  }
                  return onMentionClick ? (
                    <button
                      key={spanIndex}
                      type="button"
                      className="mention-chip"
                      onClick={() => onMentionClick(span.handle)}
                      title={`Mention @${span.handle}`}
                    >
                      {span.text}
                    </button>
                  ) : (
                    <span key={spanIndex} className="mention-chip">{span.text}</span>
                  );
                default:
                  return <Fragment key={spanIndex}>{span.text}</Fragment>;
              }
            })}
          </p>
        );
      })}
    </div>
  );
}

function CodeBlock({ language, text }: { language: string; text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{language || "code"}</span>
        <button type="button" onClick={() => void copy()} className="code-copy">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre><code>{text}</code></pre>
    </div>
  );
}
