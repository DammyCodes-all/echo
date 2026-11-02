import { Fragment, type ReactNode } from "react";

const TOKEN = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;

/**
 * Minimal inline markdown for model-drafted copy: **bold** and `code`
 * only. Built as React nodes (never raw HTML), so model text stays
 * inert. Single asterisks and underscores are left alone — paths and
 * arithmetic must never render as emphasis.
 */
export function RichText({ text }: { text: string }): ReactNode {
  const parts = text.split(TOKEN);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: split order never reorders.
            <strong key={index} className="font-semibold text-dusk-ink">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return (
            <code
              // biome-ignore lint/suspicious/noArrayIndexKey: split order never reorders.
              key={index}
              className="rounded bg-dusk-pill px-1 font-mono text-[0.9em] text-dusk-ink"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        // biome-ignore lint/suspicious/noArrayIndexKey: split order never reorders.
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}
