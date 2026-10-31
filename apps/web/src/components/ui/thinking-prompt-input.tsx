// biome-ignore-all lint/correctness/useExhaustiveDependencies: pasted conversation
// UI with intentional DOM-coupled effect triggers (autosize on draft,
// autoscroll on content, FLIP on turn change). The flagged deps are props and
// state the effects must re-run on; promoting unstable closures into deps
// would re-fire the animations every render.
"use client";

import { ArrowUp, Check, ChevronRight, Sparkles, Square } from "lucide-react";
import * as React from "react";

export type ThinkingStatus = "idle" | "thinking" | "answering" | "done";
export type ThinkingStep = { id: string; text: string; status?: "active" | "complete" };
export type ThinkingSubmitOptions = { think: boolean };
export type ThinkingPromptInputProps = {
  status?: ThinkingStatus;
  prompt?: string;
  steps?: ThinkingStep[];
  answer?: string;
  elapsedSeconds?: number;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  think?: boolean;
  defaultThink?: boolean;
  onThinkChange?: (think: boolean) => void;
  onSubmit?: (value: string, options: ThinkingSubmitOptions) => void;
  onStop?: () => void;
  placeholder?: string;
  followUpPlaceholder?: string;
  answerNote?: string;
  disabled?: boolean;
  className?: string;
};

const EMPTY_STEPS: ThinkingStep[] = [];
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/** Controlled conversation UI. Supply public progress summaries and your own response stream. */
export function ThinkingPromptInput({
  status = "idle",
  prompt = "",
  steps = EMPTY_STEPS,
  answer = "",
  elapsedSeconds = 0,
  value,
  defaultValue = "",
  onValueChange,
  think,
  defaultThink = true,
  onThinkChange,
  onSubmit,
  onStop,
  placeholder = "Ask anything",
  followUpPlaceholder = "Ask a follow-up",
  answerNote,
  disabled = false,
  className = "",
}: ThinkingPromptInputProps) {
  const [draft, setDraft] = React.useState(defaultValue);
  const [localThink, setLocalThink] = React.useState(defaultThink);
  const [expanded, setExpanded] = React.useState(false);
  const [reduced, setReduced] = React.useState(true);
  const transcript = React.useRef<HTMLDivElement | null>(null);
  const transcriptBody = React.useRef<HTMLDivElement | null>(null);
  const textarea = React.useRef<HTMLTextAreaElement | null>(null);
  const question = React.useRef<HTMLDivElement | null>(null);
  const shimmer = React.useRef<HTMLSpanElement | null>(null);
  const inputRect = React.useRef<DOMRect | null>(null);
  const previousTurn = React.useRef({ status, prompt });
  const regionId = React.useId();
  const inputValue = value ?? draft;
  const thinkingEnabled = think ?? localThink;
  const busy = status === "thinking" || status === "answering";
  const open = status === "thinking" || expanded;
  const seconds = Number.isFinite(elapsedSeconds) ? Math.max(0, Math.round(elapsedSeconds)) : 0;
  const inputPlaceholder = status === "idle" ? placeholder : followUpPlaceholder;
  const paragraphs = answer.split("\n").filter(Boolean);
  const lastBoundary = [...answer.matchAll(/[.!?。！？](?=\s|$)|\n/g)].at(-1);
  const completeAnswer =
    status === "done" ? answer : answer.slice(0, lastBoundary ? lastBoundary.index + 1 : 0).trim();

  function scrollToLatest() {
    const panel = transcript.current;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }

  React.useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  React.useEffect(() => {
    if (status === "thinking" || status === "idle") setExpanded(false);
  }, [status]);

  // Capture the previous input rectangle before resizing the now-empty composer.
  React.useLayoutEffect(() => {
    const previous = previousTurn.current;
    previousTurn.current = { status, prompt };
    const newTurn =
      status !== "idle" &&
      (previous.status === "idle" ||
        previous.prompt !== prompt ||
        (previous.status === "done" && busy));
    const from = inputRect.current;
    const bubble = question.current;
    const panel = transcript.current;
    if (!newTurn || !from || !bubble || !panel || reduced) return;
    let disposed = false;
    let animation: Animation | null = null;
    queueMicrotask(() => {
      if (disposed || typeof bubble.animate !== "function") return;
      const to = bubble.getBoundingClientRect();
      if (!to.width || !to.height) return;
      // Let the bubble cross the gap from the composer, then restore scrolling.
      panel.style.overflow = "visible";
      animation = bubble.animate(
        [
          {
            transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`,
          },
          { transform: "translate(0px, 0px) scale(1, 1)" },
        ],
        { duration: 560, easing: EASE },
      );
      animation.onfinish = () => {
        panel.style.overflow = "";
        scrollToLatest();
      };
    });
    return () => {
      disposed = true;
      animation?.cancel();
      panel.style.overflow = "";
    };
  }, [status, prompt, busy, reduced]);

  // Only the composer grows for multiline drafts; the transcript remains above it.
  React.useLayoutEffect(() => {
    const input = textarea.current;
    if (!input) return;
    let disposed = false;
    let animation: Animation | null = null;
    queueMicrotask(() => {
      if (disposed) return;
      const before = input.getBoundingClientRect().height;
      input.style.height = "auto";
      const height = Math.max(64, Math.min(input.scrollHeight, 120));
      input.style.height = `${height}px`;
      if (!reduced && Math.abs(before - height) > 1 && typeof input.animate === "function") {
        animation = input.animate([{ height: `${before}px` }, { height: `${height}px` }], {
          duration: 200,
          easing: EASE,
        });
      }
      const rect = input.getBoundingClientRect();
      const style = getComputedStyle(input);
      const left = Number.parseFloat(style.paddingLeft);
      const top = Number.parseFloat(style.paddingTop);
      inputRect.current = new DOMRect(
        rect.left + left,
        rect.top + top,
        rect.width - left - Number.parseFloat(style.paddingRight),
        height - top - Number.parseFloat(style.paddingBottom),
      );
    });
    return () => {
      disposed = true;
      animation?.cancel();
    };
  }, [inputValue, reduced]);

  React.useLayoutEffect(() => {
    const panel = transcript.current;
    const body = transcriptBody.current;
    if (!panel || !body) return;
    let disposed = false;
    const scrollToBottom = () => {
      if (!disposed) scrollToLatest();
    };
    queueMicrotask(scrollToBottom);
    const observer = new ResizeObserver(scrollToBottom);
    observer.observe(body);
    observer.observe(panel);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [status, prompt, steps, answer, answerNote, open]);

  React.useEffect(() => {
    const element = shimmer.current;
    if (status !== "thinking" || reduced || !element) return;
    let disposed = false;
    let animation: Animation | null = null;
    queueMicrotask(() => {
      if (disposed || typeof element.animate !== "function") return;
      animation = element.animate(
        [{ backgroundPosition: "100% 0" }, { backgroundPosition: "0% 0" }],
        {
          duration: 1800,
          iterations: Infinity,
          easing: "linear",
        },
      );
    });
    return () => {
      disposed = true;
      animation?.cancel();
    };
  }, [status, reduced]);

  React.useLayoutEffect(() => {
    const body = transcriptBody.current;
    if (!body || !open || reduced) return;
    let disposed = false;
    const animations: Animation[] = [];
    queueMicrotask(() => {
      if (disposed) return;
      body.querySelectorAll("[data-step]").forEach((row, index) => {
        if (
          !(row instanceof HTMLElement) ||
          row.dataset.entered ||
          typeof row.animate !== "function"
        )
          return;
        row.dataset.entered = "true";
        animations.push(
          row.animate(
            [
              { opacity: 0, transform: "translateY(10px)" },
              { opacity: 1, transform: "translateY(0px)" },
            ],
            { duration: 420, delay: index * 45, easing: EASE, fill: "backwards" },
          ),
        );
      });
    });
    return () => {
      disposed = true;
      animations.forEach((animation) => {
        animation.cancel();
      });
    };
  }, [status, steps, open, reduced]);

  function changeValue(next: string) {
    if (value === undefined) setDraft(next);
    onValueChange?.(next);
  }

  function submit() {
    const message = inputValue.trim();
    if (!message || busy || disabled || !onSubmit) return;
    onSubmit(message, { think: thinkingEnabled });
    changeValue("");
  }

  return (
    <div
      data-slot="thinking-prompt-input"
      data-state={status}
      className={`flex h-full min-h-0 w-full max-w-[480px] flex-col text-dusk-ink ${className}`}
    >
      {status !== "idle" && (
        <section
          ref={transcript}
          data-transcript
          aria-label="Conversation"
          // Scrollable transcript: keyboard users need Tab access to scroll it.
          // biome-ignore lint/a11y/noNoninteractiveTabindex: focus is the scroll mechanism here.
          tabIndex={0}
          className="mb-4 min-h-0 flex-1 overflow-y-auto rounded-lg outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-dusk-accent"
        >
          <div ref={transcriptBody} className="space-y-5 px-1 py-1">
            <div
              ref={question}
              data-question
              className="ml-auto w-fit max-w-[94%] origin-top-left rounded-2xl rounded-br-sm bg-dusk-pill px-3.5 py-2.5 text-[13px] leading-5 text-dusk-ink"
            >
              <p className="break-words">{prompt}</p>
            </div>
            <div data-assistant className="min-w-0">
              {(steps.length > 0 || status === "thinking") && (
                <>
                  <button
                    type="button"
                    data-thought-toggle
                    aria-expanded={open}
                    aria-controls={regionId}
                    disabled={status === "thinking"}
                    onClick={() => setExpanded(!expanded)}
                    className={`flex max-w-full items-center gap-2 rounded-full text-xs outline-none transition-colors motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-dusk-accent ${status === "thinking" ? "h-7 w-full text-dusk-muted" : "border border-dusk-hairline bg-dusk-pill/60 px-2.5 py-1.5 text-dusk-muted hover:bg-dusk-pill hover:text-dusk-ink"}`}
                  >
                    <Sparkles className="size-3.5 shrink-0 text-dusk-muted" aria-hidden="true" />
                    {status === "thinking" ? (
                      <span
                        ref={shimmer}
                        data-shimmer
                        className={
                          reduced
                            ? "text-dusk-muted"
                            : "bg-[linear-gradient(90deg,var(--color-dusk-muted)_0%,var(--color-dusk-muted)_42%,var(--color-dusk-ink)_50%,var(--color-dusk-muted)_58%,var(--color-dusk-muted)_100%)] bg-[length:250%_100%] bg-clip-text text-transparent"
                        }
                      >
                        Thinking it through
                      </span>
                    ) : (
                      <span>Thought for {seconds}s</span>
                    )}
                    {status === "thinking" ? (
                      <span className="ml-auto font-mono text-[11px] tabular-nums text-dusk-muted">
                        {seconds}s
                      </span>
                    ) : (
                      <ChevronRight
                        className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                  <div id={regionId} data-reasoning hidden={!open} className="pt-3">
                    <ol className="relative ml-[7px] border-l border-dusk-hairline pl-5">
                      {steps.map((step) => (
                        <li
                          key={step.id}
                          data-step={step.id}
                          className="relative flex min-h-9 items-center gap-3 py-2 text-xs leading-5"
                        >
                          <span className="absolute -left-[26px] flex size-[11px] items-center justify-center rounded-full bg-dusk-base ring-4 ring-dusk-base">
                            {step.status === "complete" ? (
                              <Check
                                className="size-3 text-dusk-ink"
                                role="img"
                                aria-label="Complete"
                              />
                            ) : (
                              <span
                                className="size-1.5 rounded-full bg-dusk-accent motion-safe:animate-pulse"
                                role="img"
                                aria-label="In progress"
                              />
                            )}
                          </span>
                          <span
                            className={
                              step.status === "active" ? "text-dusk-ink" : "text-dusk-muted"
                            }
                          >
                            {step.text}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                </>
              )}
              {(status === "answering" || status === "done") && (
                <section
                  data-answer
                  aria-label="Response"
                  aria-live="off"
                  className="mt-4 space-y-2.5 break-words text-sm leading-6 text-dusk-ink"
                >
                  {paragraphs.map((paragraph, index) => (
                    // Paragraphs come from a newline split: order is append-only
                    // and duplicates are legal, so the index is the stable key.
                    // biome-ignore lint/suspicious/noArrayIndexKey: split order never reorders.
                    <p key={`${index}-${paragraph.slice(0, 24)}`}>
                      {paragraph}
                      {status === "answering" && index === paragraphs.length - 1 && (
                        <span
                          data-cursor
                          aria-hidden="true"
                          className="ml-1 inline-block h-3.5 w-1 translate-y-0.5 rounded-full bg-dusk-accent motion-safe:animate-pulse"
                        />
                      )}
                    </p>
                  ))}
                  {status === "answering" && paragraphs.length === 0 && (
                    <span
                      data-cursor
                      aria-hidden="true"
                      className="inline-block h-3.5 w-1 rounded-full bg-dusk-accent motion-safe:animate-pulse"
                    />
                  )}
                  {answerNote && status === "done" && (
                    <p className="text-[11px] leading-4 text-dusk-muted">{answerNote}</p>
                  )}
                </section>
              )}
            </div>
          </div>
        </section>
      )}
      <form
        data-composer
        className="relative mt-auto shrink-0 rounded-3xl border border-dusk-hairline bg-dusk-surface p-4 shadow-xl shadow-dusk-accent/5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={textarea}
          aria-label={inputPlaceholder}
          placeholder={inputPlaceholder}
          value={inputValue}
          disabled={disabled}
          rows={2}
          onChange={(event) => changeValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="block h-16 min-h-16 w-full resize-none rounded-lg bg-transparent p-1 text-[17px] leading-7 tracking-tight text-dusk-ink outline-none placeholder:text-dusk-muted focus-visible:ring-2 focus-visible:ring-dusk-accent disabled:opacity-50"
        />
        <div className="mt-3 flex items-center justify-between">
          <button
            type="button"
            aria-pressed={thinkingEnabled}
            disabled={disabled || busy}
            onClick={() => {
              if (think === undefined) setLocalThink(!thinkingEnabled);
              onThinkChange?.(!thinkingEnabled);
            }}
            className={`inline-flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-medium outline-none transition-colors motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-dusk-accent disabled:opacity-50 ${thinkingEnabled ? "border-dusk-accent/15 bg-dusk-accent-wash text-dusk-ink" : "border-dusk-hairline bg-dusk-surface text-dusk-muted"}`}
          >
            <Sparkles className="size-3.5" aria-hidden="true" />
            Think
            {thinkingEnabled && <Check className="size-3" aria-hidden="true" />}
          </button>
          <button
            type={busy ? "button" : "submit"}
            data-stop={busy ? "" : undefined}
            aria-label={busy ? "Stop" : "Send prompt"}
            onClick={
              busy
                ? (event) => {
                    event.preventDefault();
                    onStop?.();
                  }
                : undefined
            }
            disabled={disabled || (busy ? !onStop : !inputValue.trim() || !onSubmit)}
            className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-dusk-accent text-dusk-base outline-none focus-visible:ring-2 focus-visible:ring-dusk-accent focus-visible:ring-offset-2 focus-visible:ring-offset-dusk-surface disabled:opacity-30"
          >
            <span
              data-action-icon="send"
              aria-hidden="true"
              className={`absolute inset-0 flex items-center justify-center transition-[opacity,scale] duration-200 motion-reduce:transition-none ${busy ? "scale-75 opacity-0" : "scale-100 opacity-100"}`}
            >
              <ArrowUp className="size-4" strokeWidth={2} />
            </span>
            <span
              data-action-icon="stop"
              aria-hidden="true"
              className={`absolute inset-0 flex items-center justify-center transition-[opacity,scale] duration-200 motion-reduce:transition-none ${busy ? "scale-100 opacity-100" : "scale-75 opacity-0"}`}
            >
              <Square className="size-3 fill-current" />
            </span>
          </button>
        </div>
      </form>
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-announcement
      >
        {status === "thinking" ? `Thinking. ${steps.at(-1)?.text ?? ""}` : completeAnswer}
      </div>
    </div>
  );
}
