import type { AskEvidence, AskThreadMessage } from "@echo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";

export type AskCardRef = { id: string; headline: string } | null;

type AskThreadPanelProps = {
  sessionId: string;
  card: AskCardRef;
  onClearCard: () => void;
  // Second arg carries the thread message's cardId so the host can resolve
  // the citation target; callers that only need the citation can ignore it.
  onCitationClick: (citation: AskEvidence, messageCardId?: string | null) => void;
  onClose: () => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Ask failed.";
}

function ThreadMessageView({
  message,
  onCitationClick,
}: {
  message: AskThreadMessage;
  onCitationClick: (citation: AskEvidence, messageCardId?: string | null) => void;
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

  const response = message.response;
  const evidenceById = new Map((response?.evidence ?? []).map((item) => [item.evidenceId, item]));
  return (
    <div className="space-y-2 rounded-dusk-card bg-dusk-pill px-4 py-3">
      <p className="text-sm leading-6 text-dusk-ink">{response?.answer ?? message.text}</p>
      {response?.status === "refused" ? (
        <p className="text-sm text-dusk-muted">
          <span className="font-medium text-dusk-ink">Not on the tape.</span> Searched{" "}
          {response.searchedScope.eventCount} events and found nothing relevant.
        </p>
      ) : null}
      {response?.status === "partial" ? (
        <p className="text-xs text-dusk-muted">
          Partial answer: some claims failed citation validation and were dropped.
        </p>
      ) : null}
      {(response?.claims.length ?? 0) > 0 ? (
        <ul className="space-y-2">
          {(response?.claims ?? []).map((claim) => (
            <li
              key={`${claim.text}-${claim.evidenceIds.join(",")}`}
              className="text-xs leading-5 text-dusk-muted"
            >
              <span className="text-dusk-ink">{claim.text}</span>
              {claim.weak ? <span> (weak: no direct quote)</span> : null}
              {claim.evidenceIds.length > 0 ? (
                <span className="mt-1 flex flex-wrap gap-1">
                  {claim.evidenceIds.map((id) => {
                    const cited = evidenceById.get(id);
                    return cited ? (
                      <button
                        key={id}
                        type="button"
                        title={`${cited.kind} · ${cited.ts} — jump to the card this cites`}
                        onClick={() => onCitationClick(cited, message.cardId)}
                        className="rounded-dusk-code bg-dusk-track px-1.5 py-0.5 font-mono text-[10px] text-dusk-accent-soft"
                      >
                        {id}
                      </button>
                    ) : (
                      <span
                        key={id}
                        className="rounded-dusk-code bg-dusk-track px-1.5 py-0.5 font-mono text-[10px]"
                      >
                        {id}
                      </span>
                    );
                  })}
                </span>
              ) : null}
              {claim.quote ? (
                <span className="mt-1 block font-mono text-[10px]">“{claim.quote}”</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function AskThreadPanel({
  sessionId,
  card,
  onClearCard,
  onCitationClick,
  onClose,
}: AskThreadPanelProps) {
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState("");

  const threadQuery = useQuery({
    queryKey: ["ask-thread", sessionId],
    queryFn: () => api.askThread(sessionId),
  });

  const askMutation = useMutation({
    mutationFn: (text: string) =>
      // Server is the source of truth: send, then refetch the thread rather
      // than hand-appending the response locally.
      api.ask(sessionId, {
        question: text,
        filePath: null,
        symbols: [],
        cardId: card?.id ?? null,
      }),
    onSuccess: () => {
      setQuestion("");
      void queryClient.invalidateQueries({ queryKey: ["ask-thread", sessionId] });
    },
  });

  const submit = () => {
    const trimmed = question.trim();
    if (trimmed.length === 0 || askMutation.isPending) return;
    askMutation.mutate(trimmed);
  };

  const messages = threadQuery.data?.messages ?? [];

  return (
    // Slide-over, not an overlay modal: the story stays visible and citable on
    // the left while the thread pins to the right edge.
    <aside
      aria-label="Ask why thread"
      className="fixed right-0 top-0 bottom-0 z-40 flex w-full max-w-md flex-col border-l border-dusk-hairline bg-dusk-surface"
    >
      <div className="flex items-start justify-between gap-3 border-b border-dusk-hairline px-6 py-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">Ask why</p>
          <p className="mt-1 text-xs text-dusk-muted">
            Answers cite the tape — or say not on the tape.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close ask panel"
          className="rounded-dusk-code bg-dusk-pill px-2 py-1 text-sm text-dusk-muted"
        >
          ×
        </button>
      </div>

      {card ? (
        <div className="flex items-center justify-between gap-2 border-b border-dusk-hairline px-6 py-2">
          <p className="truncate text-xs text-dusk-muted">
            Asking about: <span className="text-dusk-ink">{card.headline}</span>
          </p>
          <button
            type="button"
            onClick={onClearCard}
            aria-label="Clear selected card"
            className="shrink-0 rounded-dusk-code bg-dusk-pill px-2 py-0.5 text-sm text-dusk-muted"
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
        {threadQuery.isPending ? (
          <div role="status" aria-label="Loading thread" className="space-y-3">
            <span className="sr-only">Loading thread…</span>
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                aria-hidden
                className="space-y-2 rounded-dusk-card bg-dusk-pill px-4 py-3 motion-safe:animate-pulse"
              >
                <div className="h-4 w-11/12 rounded-dusk-code bg-dusk-track" />
                <div className="h-4 w-full rounded-dusk-code bg-dusk-track" />
                {index === 1 ? null : <div className="h-4 w-2/3 rounded-dusk-code bg-dusk-track" />}
              </div>
            ))}
          </div>
        ) : threadQuery.isError ? (
          <p className="text-sm text-dusk-fail">{errorMessage(threadQuery.error)}</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-dusk-muted">
            Ask about this session. Answers cite the tape — or say not on the tape.
          </p>
        ) : (
          messages.map((message) => (
            <ThreadMessageView
              key={message.id}
              message={message}
              onCitationClick={onCitationClick}
            />
          ))
        )}
        {askMutation.isError ? (
          <p className="text-sm text-dusk-fail">{errorMessage(askMutation.error)}</p>
        ) : null}
      </div>

      <div className="border-t border-dusk-hairline px-6 py-4">
        <div className="flex gap-2">
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            placeholder={card ? `Ask about “${card.headline}”…` : "Why did the agent do that?"}
            disabled={askMutation.isPending}
            className="min-w-0 flex-1 rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink outline-none placeholder:text-dusk-muted disabled:opacity-40"
          />
          <button
            type="button"
            onClick={submit}
            disabled={askMutation.isPending || question.trim().length === 0}
            className="shrink-0 rounded-dusk-code bg-dusk-accent px-3 py-2 text-sm font-semibold text-dusk-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent disabled:opacity-40"
          >
            {askMutation.isPending ? "Asking…" : "Ask"}
          </button>
        </div>
      </div>
    </aside>
  );
}
