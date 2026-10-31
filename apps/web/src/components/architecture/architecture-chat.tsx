import type { ArchitecturePatch } from "@echo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { ThinkingPromptInput } from "../ui/thinking-prompt-input";
import type { PinnedNode } from "./architecture-diagram";

interface ChatMessage {
  key: number;
  role: "user" | "assistant";
  text: string;
  patch: ArchitecturePatch | null;
  applied: boolean;
}

interface ArchitectureChatProps {
  projectId: string;
  pinned: PinnedNode | null;
  onClearPin: () => void;
  onHighlight: (ids: string[]) => void;
  onPatched: (patch: ArchitecturePatch) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Chat failed.";
}

function HistoryMessage({
  message,
  applying,
  onApply,
}: {
  message: ChatMessage;
  applying: boolean;
  onApply: (patch: ArchitecturePatch) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink">
          {message.text}
        </p>
      </div>
    );
  }
  const patch = message.patch;
  return (
    <div className="space-y-1 rounded-dusk-code bg-dusk-pill px-3 py-2">
      <p className="text-sm leading-6 text-dusk-ink">{message.text}</p>
      {patch && !message.applied ? (
        <button
          type="button"
          disabled={applying}
          onClick={() => onApply(patch)}
          className="rounded-dusk-pill bg-dusk-accent px-3 py-1 text-xs font-semibold text-dusk-base transition-opacity disabled:opacity-50"
        >
          {applying ? "Applying…" : "Apply to diagram"}
        </button>
      ) : null}
      {patch && message.applied ? (
        <p className="text-[11px] uppercase tracking-widest text-dusk-pass">Applied</p>
      ) : null}
    </div>
  );
}

export function ArchitectureChat({
  projectId,
  pinned,
  onClearPin,
  onHighlight,
  onPatched,
}: ArchitectureChatProps) {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  // Think = diagram-aware mode. When on, answers highlight related nodes and
  // patches offer an Apply button. When off, the same request is sent but the
  // response renders as plain text (no highlight, no apply affordance).
  const [think, setThink] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const keyCounter = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const messageCount = messages.length;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["architecture", projectId] });
  };

  const send = useMutation({
    mutationFn: ({ text, signal }: { text: string; signal: AbortSignal }) =>
      api.chatArchitecture(
        projectId,
        { message: text, pinnedNodeId: pinned?.id ?? null },
        { signal },
      ),
    onMutate: ({ text }) => {
      setFailure(null);
      onHighlight([]);
      keyCounter.current += 1;
      const key = keyCounter.current;
      setMessages((current) => [
        ...current,
        { key, role: "user", text, patch: null, applied: false },
      ]);
      setInput("");
      setElapsed(0);
    },
    onSuccess: (response) => {
      keyCounter.current += 1;
      const key = keyCounter.current;
      setMessages((current) => [
        ...current,
        {
          key,
          role: "assistant",
          text: response.answer,
          patch: response.patch,
          applied: response.applied,
        },
      ]);
      if (think) {
        onHighlight(response.relatedNodeIds);
        if (response.patch && response.applied) {
          onPatched(response.patch);
          refresh();
        }
      }
    },
    onError: (error, variables) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        // Stopped by the user: drop the optimistic question, hand its text
        // back to the composer, and leave no failure behind.
        setMessages((current) => {
          const last = current.at(-1);
          return last && last.role === "user" && last.text === variables.text
            ? current.slice(0, -1)
            : current;
        });
        setInput(variables.text);
        setFailure(null);
        return;
      }
      // An invalid patch still carries the model's answer: show both.
      const details = (error as Error & { details?: { answer?: unknown } }).details;
      const answerText = details && typeof details.answer === "string" ? details.answer : null;
      if (answerText) {
        keyCounter.current += 1;
        const key = keyCounter.current;
        setMessages((current) => [
          ...current,
          { key, role: "assistant", text: answerText, patch: null, applied: false },
        ]);
      }
      setFailure(errorText(error));
    },
  });

  const apply = useMutation({
    mutationFn: (patch: ArchitecturePatch) => api.applyArchitecturePatch(projectId, patch),
    onSuccess: (_result, patch) => {
      setMessages((current) =>
        current.map((message) =>
          message.patch === patch ? { ...message, applied: true } : message,
        ),
      );
      onPatched(patch);
      refresh();
    },
    onError: (error) => {
      setFailure(errorText(error));
    },
  });

  function submit(text: string) {
    const message = text.trim();
    if (message.length === 0 || send.isPending) return;
    const controller = new AbortController();
    abortRef.current = controller;
    send.mutate({ text: message, signal: controller.signal });
  }

  function stop() {
    abortRef.current?.abort();
  }

  useEffect(() => {
    if (!send.isPending) return;
    setElapsed(0);
    const id = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [send.isPending]);

  // Scroll the history strip only when the turn count changes; the effect
  // reads a ref Biome cannot see, so the dep looks unnecessary to the rule.
  // biome-ignore lint/correctness/useExhaustiveDependencies: history autoscroll on new turns.
  useEffect(() => {
    const box = historyRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messageCount]);

  // The thinking input shows only the latest turn; earlier turns render above
  // in matching bubbles so no transcript is ever duplicated or lost.
  const last = messages.at(-1) ?? null;
  const secondLast = messages.at(-2) ?? null;
  const pendingUser = send.isPending && last && last.role === "user" ? last : null;
  const donePair =
    !send.isPending && last && last.role === "assistant" && secondLast && secondLast.role === "user"
      ? { prompt: secondLast, answer: last }
      : null;
  const status = send.isPending ? "thinking" : donePair ? "done" : "idle";
  const prompt = pendingUser ? pendingUser.text : (donePair?.prompt.text ?? "");
  const answer = donePair?.answer.text ?? "";
  const history = send.isPending
    ? messages.slice(0, -1)
    : donePair
      ? messages.slice(0, -2)
      : messages;
  const latestPatch =
    donePair && !donePair.answer.applied && donePair.answer.patch ? donePair.answer.patch : null;
  const answerNote = !donePair
    ? undefined
    : donePair.answer.applied
      ? "Applied to diagram"
      : donePair.answer.patch
        ? think
          ? "Patch ready — apply below"
          : "Diagram edits off — enable Think to apply"
        : undefined;

  return (
    <div className="flex h-[520px] flex-col overflow-hidden rounded-dusk-card bg-dusk-surface">
      <div className="border-b border-dusk-hairline px-4 py-3">
        <h3 className="text-sm font-semibold text-dusk-ink">Diagram chat</h3>
        <p className="text-xs text-dusk-muted">Ask about the system, or describe a change.</p>
      </div>
      {history.length > 0 ? (
        <div
          ref={historyRef}
          className="max-h-36 space-y-2 overflow-y-auto border-b border-dusk-hairline px-4 py-2"
        >
          {history.map((message) => (
            <HistoryMessage
              key={message.key}
              message={message}
              applying={apply.isPending}
              onApply={(patch) => apply.mutate(patch)}
            />
          ))}
        </div>
      ) : null}
      {messages.length === 0 && !send.isPending ? (
        <p className="px-4 pt-3 text-sm leading-6 text-dusk-muted">
          Try “add a retry queue between ingest and storage”, or ask what a part does.
        </p>
      ) : null}
      {pinned ? (
        <div className="flex px-4 pt-2">
          <span className="inline-flex items-center gap-2 rounded-dusk-pill bg-dusk-accent-wash px-3 py-1 text-xs text-dusk-accent-soft">
            {pinned.label}
            <button
              type="button"
              onClick={onClearPin}
              aria-label={`Unpin ${pinned.label}`}
              className="font-semibold hover:text-dusk-ink"
            >
              ×
            </button>
          </span>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
        <ThinkingPromptInput
          status={status}
          prompt={prompt}
          steps={[]}
          answer={answer}
          elapsedSeconds={elapsed}
          value={input}
          onValueChange={setInput}
          think={think}
          onThinkChange={setThink}
          onSubmit={submit}
          onStop={stop}
          placeholder="Describe a change…"
          followUpPlaceholder="Ask a follow-up"
          answerNote={answerNote}
        />
      </div>
      {donePair && latestPatch && think ? (
        <div className="border-t border-dusk-hairline px-4 py-2">
          <button
            type="button"
            disabled={apply.isPending}
            onClick={() => apply.mutate(latestPatch)}
            className="rounded-dusk-pill bg-dusk-accent px-4 py-2 text-sm font-semibold text-dusk-base transition-opacity disabled:opacity-50"
          >
            {apply.isPending ? "Applying…" : "Apply to diagram"}
          </button>
        </div>
      ) : null}
      {failure ? <p className="px-4 pb-3 text-sm text-dusk-fail">{failure}</p> : null}
    </div>
  );
}
