import type { ArchitecturePatch } from "@echo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
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
  const [failure, setFailure] = useState<string | null>(null);
  const keyCounter = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastMessageKey = messages.length > 0 ? messages[messages.length - 1]?.key : null;

  useEffect(() => {
    if (lastMessageKey === null) return;
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lastMessageKey]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["architecture", projectId] });
  };

  const send = useMutation({
    mutationFn: (text: string) =>
      api.chatArchitecture(projectId, { message: text, pinnedNodeId: pinned?.id ?? null }),
    onMutate: (text) => {
      setFailure(null);
      onHighlight([]);
      keyCounter.current += 1;
      const key = keyCounter.current;
      setMessages((current) => [
        ...current,
        { key, role: "user", text, patch: null, applied: false },
      ]);
      setInput("");
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
      onHighlight(response.relatedNodeIds);
      if (response.patch && response.applied) {
        onPatched(response.patch);
        refresh();
      }
    },
    onError: (error) => {
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

  const submit = () => {
    const text = input.trim();
    if (text.length === 0 || send.isPending) return;
    send.mutate(text);
  };

  return (
    <div className="flex h-[520px] flex-col overflow-hidden rounded-dusk-card bg-dusk-surface">
      <div className="border-b border-dusk-hairline px-4 py-3">
        <h3 className="text-sm font-semibold text-dusk-ink">Diagram chat</h3>
        <p className="text-xs text-dusk-muted">Ask about the system, or describe a change.</p>
      </div>
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <p className="text-sm leading-6 text-dusk-muted">
            Try “add a retry queue between ingest and storage”, or ask what a part does.
          </p>
        ) : null}
        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.key} className="flex justify-end">
              <p className="max-w-[85%] rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink">
                {message.text}
              </p>
            </div>
          ) : (
            <div key={message.key} className="space-y-2 rounded-dusk-card bg-dusk-pill px-4 py-3">
              <p className="text-sm leading-6 text-dusk-ink">{message.text}</p>
              {message.patch && !message.applied ? (
                <button
                  type="button"
                  disabled={apply.isPending}
                  onClick={() => apply.mutate(message.patch as ArchitecturePatch)}
                  className="rounded-dusk-pill bg-dusk-accent px-4 py-2 text-sm font-semibold text-dusk-base transition-opacity disabled:opacity-50"
                >
                  {apply.isPending ? "Applying…" : "Apply to diagram"}
                </button>
              ) : null}
              {message.patch && message.applied ? (
                <p className="font-mono text-[11px] uppercase tracking-widest text-dusk-pass">
                  Applied
                </p>
              ) : null}
            </div>
          ),
        )}
        {send.isPending ? (
          <p role="status" className="text-sm text-dusk-muted">
            Thinking…
          </p>
        ) : null}
        {failure ? <p className="text-sm text-dusk-fail">{failure}</p> : null}
      </div>
      <div className="space-y-2 border-t border-dusk-hairline px-4 py-3">
        {pinned ? (
          <div className="flex">
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
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Describe a change…"
            aria-label="Chat about the architecture"
            className="min-w-0 flex-1 rounded-dusk-code border border-dusk-hairline-strong bg-dusk-base px-3 py-2 text-sm text-dusk-ink placeholder:text-dusk-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-dusk-accent"
          />
          <button
            type="button"
            onClick={submit}
            disabled={send.isPending || input.trim().length === 0}
            className="shrink-0 rounded-dusk-pill bg-dusk-accent px-4 py-2 text-sm font-semibold text-dusk-base transition-opacity disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
