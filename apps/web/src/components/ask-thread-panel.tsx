import type { AskEvidence, AskRequest, AskThreadMessage } from "@echo/contracts";
import { Cancel01Icon, SentIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { type AnswerBlock, type AnswerSpan, parseAnswer } from "./ask-answer";
import { RichText } from "./rich-text";

/** Reader anchor: the change the question is scoped to, captured at open time. */
export type AskChangeRef = { id: string; title: string } | null;

type AskThreadProps = {
  sessionId: string;
  /** Anchored change; null asks the whole session. */
  change?: AskChangeRef;
  onClearScope: () => void;
};

/** Evidence labels in user words. Every backing carries one. */
const LABEL_WORDS: Record<AskEvidence["label"], string> = {
  observed: "Seen in the session",
  agent_stated: "The agent said",
  uncertain: "Uncertain",
};

function shortTime(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

function UserBubble({ text, at }: { text: string; at: string | null }) {
  return (
    <div>
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-dusk-accent px-3.5 py-2 text-sm leading-5 text-dusk-base">
          {text}
        </p>
      </div>
      {at !== null ? <p className="mt-1 text-right text-[11px] text-dusk-muted/70">{at}</p> : null}
    </div>
  );
}

function BackingPreview({ item, quote }: { item: AskEvidence; quote: string | null }) {
  const source = [
    LABEL_WORDS[item.label],
    shortTime(item.ts),
    item.filePath === null ? null : baseName(item.filePath),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <div className="rounded-dusk-code border border-dusk-hairline bg-dusk-base/60 px-3 py-2.5">
      {quote !== null ? (
        <p className="text-sm leading-6 text-dusk-ink">“{quote}”</p>
      ) : (
        <p className="text-sm leading-6 text-dusk-muted">
          No direct quote for this one. It is my best read of what happened.
        </p>
      )}
      <p className="mt-1.5 text-xs text-dusk-muted">{source}</p>
    </div>
  );
}

function SourceRef({
  position,
  open,
  onToggle,
}: {
  position: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`Show source ${position}`}
      onClick={onToggle}
      className={`mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 align-baseline text-[11px] tabular-nums transition-colors ${
        open
          ? "bg-dusk-accent font-semibold text-dusk-base"
          : "bg-dusk-track text-dusk-accent-soft hover:bg-dusk-pill"
      }`}
    >
      {position}
    </button>
  );
}

function AnswerBody({
  answer,
  evidenceIds,
  openPosition,
  onTogglePosition,
}: {
  answer: string;
  evidenceIds: string[];
  /** Position (1-based) whose preview is open, if any. */
  openPosition: number | null;
  onTogglePosition: (position: number) => void;
}) {
  const blocks = parseAnswer(answer, evidenceIds);
  const renderSpan = (span: AnswerSpan, key: string) => {
    if (span.kind === "source") {
      return (
        <SourceRef
          key={key}
          position={span.position}
          open={span.position === openPosition}
          onToggle={() => onTogglePosition(span.position)}
        />
      );
    }
    return <RichText key={key} text={span.text} />;
  };
  return (
    <>
      {blocks.map((block: AnswerBlock, blockIndex: number) => {
        const blockKey = `block-${blockIndex}`;
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List
              key={blockKey}
              className={`space-y-1 pl-5 text-sm leading-6 text-dusk-ink ${
                block.ordered ? "list-decimal" : "list-disc"
              }`}
            >
              {block.items.map((item, itemIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: item order never reorders.
                <li key={`item-${itemIndex}`}>
                  {item.map((span, spanIndex) => renderSpan(span, `span-${spanIndex}`))}
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={blockKey} className="text-sm leading-6 text-dusk-ink">
            {block.spans.map((span, spanIndex) => renderSpan(span, `span-${spanIndex}`))}
          </p>
        );
      })}
    </>
  );
}

function AssistantMessage({ message }: { message: AskThreadMessage }) {
  const response = message.response;
  const [openId, setOpenId] = useState<string | null>(null);

  if (response === null) {
    return (
      <div className="rounded-xl border border-dusk-hairline bg-dusk-surface px-3.5 py-3">
        <AnswerBody
          answer={message.text}
          evidenceIds={[]}
          openPosition={null}
          onTogglePosition={() => {}}
        />
      </div>
    );
  }

  if (response.status === "refused") {
    return (
      <div className="space-y-1.5 rounded-xl border border-dusk-hairline bg-dusk-surface px-3.5 py-3">
        <p className="text-sm font-medium text-dusk-ink">Not in this session.</p>
        <p className="text-sm leading-6 text-dusk-muted">
          I looked through it and could not find anything on that.
        </p>
      </div>
    );
  }

  const evidence = response.evidence;
  const open = evidence.find((item) => item.evidenceId === openId) ?? null;
  const openQuote =
    open === null
      ? null
      : (response.claims.find((claim) => claim.evidenceIds.includes(open.evidenceId))?.quote ??
        null);
  const togglePosition = (position: number) => {
    const target = evidence[position - 1]?.evidenceId ?? null;
    setOpenId((current) => (current === target ? null : target));
  };

  return (
    <div className="space-y-2 rounded-xl border border-dusk-hairline bg-dusk-surface px-3.5 py-3">
      <AnswerBody
        answer={response.answer}
        evidenceIds={evidence.map((item) => item.evidenceId)}
        openPosition={open === null ? null : evidence.indexOf(open) + 1}
        onTogglePosition={togglePosition}
      />
      {response.status === "partial" ? (
        <p className="text-xs leading-5 text-dusk-muted">
          I could only answer part of that. The rest is not in this session.
        </p>
      ) : null}
      {response.uncertainty === "high" ? (
        <p className="text-xs leading-5 text-dusk-muted">
          I am not sure about this one. The session barely covers it.
        </p>
      ) : null}
      {open !== null ? <BackingPreview item={open} quote={openQuote} /> : null}
    </div>
  );
}

function PendingAnswer() {
  return (
    <div
      role="status"
      aria-label="Reading through the session"
      className="rounded-xl border border-dusk-hairline bg-dusk-surface px-3.5 py-3"
    >
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="flex gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-dusk-muted motion-safe:animate-pulse" />
          <span
            style={{ animationDelay: "150ms" }}
            className="h-1.5 w-1.5 rounded-full bg-dusk-muted motion-safe:animate-pulse"
          />
          <span
            style={{ animationDelay: "300ms" }}
            className="h-1.5 w-1.5 rounded-full bg-dusk-muted motion-safe:animate-pulse"
          />
        </span>
        <p className="text-sm text-dusk-muted">Reading through the session…</p>
      </div>
    </div>
  );
}

/**
 * The thread itself, laid out inline. The host owns positioning and height.
 * Rendered in the reader rail's Ask tab.
 */
export function AskThread({ sessionId, change = null, onClearScope }: AskThreadProps) {
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const lastSentRef = useRef("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const threadQuery = useQuery({
    queryKey: ["ask-thread", sessionId],
    queryFn: () => api.askThread(sessionId),
  });

  const askMutation = useMutation({
    mutationFn: (text: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      lastSentRef.current = text;
      // A change anchor travels as changeId with cardId null: the thread
      // schema only accepts h_ ids.
      const changeId = change?.id ?? null;
      return api.ask(
        sessionId,
        {
          question: text,
          filePath: null,
          symbols: [],
          cardId: null,
          ...(changeId !== null ? { changeId } : {}),
        } as AskRequest,
        { signal: controller.signal },
      );
    },
    onSuccess: () => {
      setQuestion("");
      void queryClient.invalidateQueries({ queryKey: ["ask-thread", sessionId] });
    },
    onError: () => {
      // A cancel or a failure both restore the sent text to the input.
      // Only failures surface a message; cancels stay silent.
      setQuestion(lastSentRef.current);
    },
  });
  const failed = askMutation.isError && askMutation.error?.name !== "AbortError";

  const submit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || askMutation.isPending) return;
    askMutation.mutate(trimmed);
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  const messages = threadQuery.data?.messages ?? [];
  const pendingText = askMutation.isPending ? (askMutation.variables ?? null) : null;

  // A chat that does not follow itself is broken: trail the bottom as turns
  // land. Instant, so reduced-motion users get the same position for free.
  // The deps are triggers only; the effect reads no reactive value besides the node.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only deps by design.
  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [messages.length, askMutation.isPending]);

  const starters = ["Why this approach?", "What could break?", "What was tried before?"];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {change !== null ? (
        <div className="flex items-center justify-between gap-2 rounded-full border border-dusk-hairline bg-dusk-pill px-3 py-1.5">
          <p className="truncate text-xs text-dusk-muted">
            About this change: <span className="font-medium text-dusk-ink">{change.title}</span>
          </p>
          <button
            type="button"
            onClick={onClearScope}
            aria-label="Ask the whole session instead"
            className="shrink-0 rounded-full bg-dusk-track px-2 py-0.5 text-xs text-dusk-muted transition-colors hover:text-dusk-ink"
          >
            ×
          </button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        role="log"
        aria-label="Questions and answers"
        className="mt-3 min-h-[180px] flex-1 space-y-3 overflow-y-auto pr-0.5"
      >
        {threadQuery.isPending ? (
          <div role="status" aria-label="Loading thread" className="space-y-2.5">
            <span className="sr-only">Loading thread…</span>
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                aria-hidden
                className="space-y-2 rounded-xl border border-dusk-hairline bg-dusk-surface px-3.5 py-3 motion-safe:animate-pulse"
              >
                <div className="h-2.5 w-3/4 rounded-full bg-dusk-pill" />
                <div className="h-2.5 w-full rounded-full bg-dusk-pill" />
                <div className="h-2.5 w-5/6 rounded-full bg-dusk-pill opacity-60" />
              </div>
            ))}
          </div>
        ) : threadQuery.isError ? (
          <div className="space-y-2 rounded-xl border border-dusk-hairline bg-dusk-surface px-4 py-5 text-center">
            <p className="text-sm text-dusk-muted">I could not load this thread.</p>
            <button
              type="button"
              onClick={() => void threadQuery.refetch()}
              className="rounded-dusk-pill border border-dusk-hairline-strong px-4 py-1.5 text-sm text-dusk-ink"
            >
              Try again
            </button>
          </div>
        ) : messages.length === 0 && pendingText === null ? (
          <div className="rounded-xl border border-dashed border-dusk-hairline bg-dusk-surface/40 px-4 py-6 text-center">
            <p className="text-sm font-medium text-dusk-ink">What do you want to know?</p>
            <p className="mt-1 text-sm leading-5 text-dusk-muted">
              Ask anything about this session. If it is not here, you will hear that instead of a
              guess.
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {starters.map((text) => (
                <button
                  key={text}
                  type="button"
                  onClick={() => submit(text)}
                  className="rounded-full border border-dusk-hairline bg-dusk-pill px-3 py-1 text-xs text-dusk-ink transition-colors hover:border-dusk-muted hover:bg-dusk-track"
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) =>
            message.role === "user" ? (
              <UserBubble key={message.id} text={message.text} at={shortTime(message.createdAt)} />
            ) : (
              <AssistantMessage key={message.id} message={message} />
            ),
          )
        )}
        {pendingText !== null ? (
          <>
            <UserBubble text={pendingText} at={null} />
            <PendingAnswer />
          </>
        ) : null}
        {failed ? (
          <div className="space-y-2 rounded-xl border border-dusk-hairline bg-dusk-surface px-4 py-4 text-center">
            <p className="text-sm text-dusk-muted">
              That did not send. Your question is still below if you want to retry.
            </p>
            <button
              type="button"
              onClick={() => submit(question)}
              className="rounded-dusk-pill border border-dusk-hairline-strong px-4 py-1.5 text-sm text-dusk-ink"
            >
              Try again
            </button>
          </div>
        ) : null}
      </div>

      <div className="pt-3">
        <div className="flex items-center gap-2 rounded-full border border-dusk-hairline bg-dusk-surface px-1.5 py-1.5 shadow-sm focus-within:border-dusk-accent/50 focus-within:ring-1 focus-within:ring-dusk-accent/20">
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit(question);
            }}
            placeholder={
              change !== null ? `Ask about “${change.title}”…` : "Ask about this session…"
            }
            disabled={askMutation.isPending}
            aria-label="Ask a question"
            className="min-w-0 flex-1 bg-transparent px-3 py-1 text-sm text-dusk-ink outline-none placeholder:text-dusk-muted disabled:opacity-40"
          />
          {askMutation.isPending ? (
            <button
              type="button"
              onClick={cancel}
              aria-label="Stop waiting for the answer"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-dusk-pill text-dusk-muted transition-colors hover:text-dusk-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.9} aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => submit(question)}
              disabled={question.trim().length === 0}
              aria-label="Ask"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-dusk-accent text-dusk-base transition-colors hover:bg-dusk-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent disabled:opacity-40"
            >
              <HugeiconsIcon icon={SentIcon} size={16} strokeWidth={1.9} aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
