// biome-ignore-all lint/correctness/useExhaustiveDependencies: pasted conversation
// UI with intentional DOM-coupled effect triggers (autosize on draft,
// autoscroll on content). The flagged deps are props and state the effects
// must re-run on; promoting unstable closures into deps would re-fire the
// animations every render.
"use client";

import { SentIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Check, ChevronRight, Square } from "lucide-react";
import * as React from "react";
import { ModelMarkdown } from "../model-markdown";

export type ThinkingStatus = "idle" | "thinking" | "answering" | "done";
export type ThinkingStep = { id: string; text: string; status?: "active" | "complete" };
export type ThinkingPromptInputProps = {
  status?: ThinkingStatus;
  prompt?: string;
  steps?: ThinkingStep[];
  answer?: string;
  elapsedSeconds?: number;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  onStop?: () => void;
  placeholder?: string;
  followUpPlaceholder?: string;
  answerNote?: string;
  disabled?: boolean;
  className?: string;
  /** Earlier turns, rendered above the latest inside the same scroll area. */
  history?: React.ReactNode;
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
  onSubmit,
  onStop,
  placeholder = "Ask anything",
  followUpPlaceholder = "Ask a follow-up",
  answerNote,
  disabled = false,
  className = "",
  history = null,
}: ThinkingPromptInputProps) {
  const [draft, setDraft] = React.useState(defaultValue);
  const [expanded, setExpanded] = React.useState(false);
  const [reduced, setReduced] = React.useState(true);
  const transcript = React.useRef<HTMLDivElement | null>(null);
  const transcriptBody = React.useRef<HTMLDivElement | null>(null);
  const textarea = React.useRef<HTMLTextAreaElement | null>(null);
  const shimmer = React.useRef<HTMLSpanElement | null>(null);
  const regionId = React.useId();
  const inputValue = value ?? draft;
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

  // The question bubble appears in place with no entrance motion; the
  // transcript autoscroll below already carries the eye to the latest turn.
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
      const height = Math.max(32, Math.min(input.scrollHeight, 96));
      input.style.height = `${height}px`;
      if (!reduced && Math.abs(before - height) > 1 && typeof input.animate === "function") {
        animation = input.animate([{ height: `${before}px` }, { height: `${height}px` }], {
          duration: 200,
          easing: EASE,
        });
      }
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
    onSubmit(message);
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
          <div ref={transcriptBody} className="space-y-3 px-1 py-1">
            {history}
            <div
              data-question
              className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-dusk-accent px-3.5 py-2 text-sm leading-5 text-dusk-base"
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
                  className="mt-4 space-y-2 break-words px-1 py-1 text-sm leading-6 text-dusk-ink"
                >
                  <ModelMarkdown text={answer} />
                  {status === "answering" && (
                    <span
                      data-cursor
                      aria-hidden="true"
                      className="ml-1 inline-block h-3.5 w-1 translate-y-0.5 rounded-full bg-dusk-accent motion-safe:animate-pulse"
                    />
                  )}
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
        className="relative mt-auto flex shrink-0 items-center gap-2 rounded-full border border-dusk-hairline bg-dusk-surface px-1.5 py-1.5 shadow-sm focus-within:border-dusk-accent/50 focus-within:ring-1 focus-within:ring-dusk-accent/20"
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
          rows={1}
          onChange={(event) => changeValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="block h-8 max-h-24 min-h-8 min-w-0 flex-1 resize-none bg-transparent px-3 py-1 text-sm leading-6 text-dusk-ink outline-none placeholder:text-dusk-muted disabled:opacity-50"
        />
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
          className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-dusk-accent text-dusk-base outline-none transition-colors hover:bg-dusk-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent disabled:opacity-40"
        >
          <span
            data-action-icon="send"
            aria-hidden="true"
            className={`absolute inset-0 flex items-center justify-center transition-[opacity,scale] duration-200 motion-reduce:transition-none ${busy ? "scale-75 opacity-0" : "scale-100 opacity-100"}`}
          >
            <HugeiconsIcon icon={SentIcon} size={16} strokeWidth={1.9} aria-hidden />
          </span>
          <span
            data-action-icon="stop"
            aria-hidden="true"
            className={`absolute inset-0 flex items-center justify-center transition-[opacity,scale] duration-200 motion-reduce:transition-none ${busy ? "scale-100 opacity-100" : "scale-75 opacity-0"}`}
          >
            <Square className="size-3 fill-current" />
          </span>
        </button>
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
