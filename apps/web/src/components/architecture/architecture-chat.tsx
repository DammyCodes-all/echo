import type { ArchitectureFocus, ArchitecturePatch } from "@echo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { queryKeys } from "../../query";
import { ModelMarkdown } from "../model-markdown";
import { ThinkingPromptInput } from "../ui/thinking-prompt-input";
import type { PinnedNode } from "./architecture-diagram";

interface ChatMessage {
  key: number;
  role: "user" | "assistant";
  text: string;
  patch: ArchitecturePatch | null;
  applied: boolean;
  at: number;
}

function shortTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

interface ArchitectureChatProps {
  projectId: string;
  pinned: PinnedNode | null;
  onClearPin: () => void;
  onHighlight: (ids: string[]) => void;
  onPatched: (patch: ArchitecturePatch) => void;
  focus: ArchitectureFocus | null;
  onFocusChange: (focus: ArchitectureFocus | null) => void;
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
      <div>
        <div className="flex justify-end">
          <p className="max-w-[85%] rounded-2xl rounded-br-md bg-dusk-accent px-3.5 py-2 text-sm leading-5 text-dusk-base">
            {message.text}
          </p>
        </div>
        <p className="mt-1 text-right text-[11px] text-dusk-muted/70">{shortTime(message.at)}</p>
      </div>
    );
  }
  const patch = message.patch;
  return (
    <div className="space-y-2 px-1 py-1">
      <ModelMarkdown text={message.text} />
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
  focus,
  onFocusChange,
}: ArchitectureChatProps) {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const keyCounter = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.architecture(projectId) });
  };

  const send = useMutation({
    mutationFn: ({ text, signal }: { text: string; signal: AbortSignal }) =>
      api.chatArchitecture(
        projectId,
        {
          message: text,
          // Pins point at full-model nodes; while focused they may name
          // ephemeral focus ids the server would reject.
          pinnedNodeId: focus ? null : (pinned?.id ?? null),
          focusedNodeIds: focus?.nodeIds ?? [],
        },
        { signal },
      ),
    onMutate: ({ text }) => {
      setFailure(null);
      onHighlight([]);
      keyCounter.current += 1;
      const key = keyCounter.current;
      setMessages((current) => [
        ...current,
        { key, role: "user", text, patch: null, applied: false, at: Date.now() },
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
          at: Date.now(),
        },
      ]);
      onHighlight(response.relatedNodeIds);
      if (response.focus) onFocusChange(response.focus);
      else if (response.clearFocus) onFocusChange(null);
      if (response.patch && response.applied) {
        onPatched(response.patch);
        refresh();
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
          { key, role: "assistant", text: answerText, patch: null, applied: false, at: Date.now() },
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

  // One continuous thread, like the ask panel: earlier turns render above
  // the latest inside the same scroll area, so nothing is ever clipped into
  // a slit or duplicated.
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
        ? "Patch ready. Apply below."
        : undefined;

  return (
    <div className="flex h-[520px] flex-col overflow-hidden rounded-dusk-card bg-dusk-surface">
      <div className="px-4 pb-3 pt-4">
        <div className="flex items-center">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold tracking-tight text-dusk-ink">Diagram chat</h3>
              {!send.isPending && latestPatch ? (
                <span className="inline-flex items-center gap-1.5 rounded-dusk-pill bg-dusk-secondary px-2 py-0.5 text-[11px] font-medium leading-4 text-dusk-accent-soft">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-dusk-accent" />
                  Patch ready
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 truncate text-xs leading-5 text-dusk-muted">
              Ask about the system, or describe a change.
            </p>
          </div>
        </div>
      </div>
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
      {messages.length === 0 && !send.isPending ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4">
          {["What does ingest do?", "Add a retry queue between ingest and storage"].map((text) => (
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
      ) : null}
      <div
        className={
          messages.length === 0 && !send.isPending
            ? "shrink-0 px-4 py-3"
            : "flex min-h-0 flex-1 flex-col px-4 py-3"
        }
      >
        <ThinkingPromptInput
          status={status}
          prompt={prompt}
          steps={[]}
          answer={answer}
          elapsedSeconds={elapsed}
          value={input}
          onValueChange={setInput}
          onSubmit={submit}
          onStop={stop}
          placeholder="Ask about the system…"
          followUpPlaceholder="Ask a follow-up about the diagram…"
          answerNote={answerNote}
          history={history.map((message) => (
            <HistoryMessage
              key={message.key}
              message={message}
              applying={apply.isPending}
              onApply={(patch) => apply.mutate(patch)}
            />
          ))}
        />
      </div>
      {donePair && latestPatch ? (
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
