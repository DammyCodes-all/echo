import { type AnswerBlock, type AnswerSpan, parseAnswer } from "./ask-answer";
import { RichText } from "./rich-text";

function Span({ span }: { span: AnswerSpan }) {
  // Source spans cannot occur here: with no evidence ids every token stays
  // literal text inside the parser.
  if (span.kind === "source") return null;
  return <RichText text={span.text} />;
}

function Spans({ spans }: { spans: AnswerSpan[] }) {
  return (
    <>
      {spans.map((span, spanIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: span order never reorders.
        <Span key={`span-${spanIndex}`} span={span} />
      ))}
    </>
  );
}

function Block({ block }: { block: AnswerBlock }) {
  if (block.kind === "list") {
    const List = block.ordered ? "ol" : "ul";
    return (
      <List
        className={`space-y-1 pl-5 text-sm leading-6 text-dusk-ink ${
          block.ordered ? "list-decimal" : "list-disc"
        }`}
      >
        {block.items.map((item, itemIndex) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: item order never reorders.
          <li key={`item-${itemIndex}`}>
            <Spans spans={item} />
          </li>
        ))}
      </List>
    );
  }
  return (
    <p className="text-sm leading-6 text-dusk-ink">
      <Spans spans={block.spans} />
    </p>
  );
}

/**
 * Model prose renderer: paragraphs, `*`/`1.` lists, **bold** and `code`.
 * Shared by every surface that shows model-written answers. Never emits raw
 * HTML; unknown markup stays literal text rather than vanishing.
 */
export function ModelMarkdown({ text }: { text: string }) {
  const blocks = parseAnswer(text, []);
  return (
    <>
      {blocks.map((block, blockIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: block order never reorders.
        <Block key={`block-${blockIndex}`} block={block} />
      ))}
    </>
  );
}
