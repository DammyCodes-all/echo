import type { AskResponse } from "@echo/contracts";
import { useState } from "react";
import { api } from "../api";

interface AskPanelProps {
  sessionId: string;
  selectedPath: string | null;
  onCite: (eventTs: string) => void;
}

export function AskPanel({ sessionId, selectedPath, onCite }: AskPanelProps) {
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResponse | null>(null);

  async function submit() {
    const trimmed = question.trim();
    if (trimmed.length === 0 || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await api.ask(sessionId, {
        question: trimmed,
        filePath: selectedPath,
        symbols: [],
        cardId: null,
      });
      setResult(response);
    } catch (unknown) {
      setError(unknown instanceof Error ? unknown.message : "Ask failed.");
      setResult(null);
    } finally {
      setPending(false);
    }
  }

  const evidenceById = new Map((result?.evidence ?? []).map((item) => [item.evidenceId, item]));

  return (
    <div className="rounded-dusk-card bg-dusk-surface">
      <div className="border-b border-dusk-hairline px-6 py-4">
        <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">Ask</p>
        <p className="mt-1 text-xs text-dusk-muted">
          Answers come only from this tape, with citations — or Echo refuses.
          {selectedPath ? ` Scoped to ${selectedPath}.` : ""}
        </p>
      </div>
      <div className="space-y-3 px-6 py-4">
        <div className="flex gap-2">
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            placeholder="Why did the agent change this? What did it try first?"
            className="min-w-0 flex-1 rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink outline-none placeholder:text-dusk-muted"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={pending || question.trim().length === 0}
            className="shrink-0 rounded-dusk-code bg-dusk-ink px-3 py-2 text-sm text-white disabled:opacity-40"
          >
            {pending ? "Asking…" : "Ask"}
          </button>
        </div>
        {error ? <p className="text-sm text-dusk-fail">{error}</p> : null}
        {result?.status === "refused" ? (
          <div className="rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-muted">
            <span className="font-medium text-dusk-ink">Not on the tape.</span> Searched{" "}
            {result.searchedScope.eventCount} events
            {result.searchedScope.filePath ? ` for ${result.searchedScope.filePath}` : ""} and found
            nothing relevant.
          </div>
        ) : null}
        {result && result.status !== "refused" ? (
          <div className="space-y-3">
            <p className="text-sm leading-6 text-dusk-ink">{result.answer}</p>
            {result.status === "partial" ? (
              <p className="text-xs text-dusk-muted">
                Partial answer: some claims failed citation validation and were dropped.
              </p>
            ) : null}
            <ul className="space-y-2">
              {result.claims.map((claim) => (
                <li
                  key={`${claim.text}-${claim.evidenceIds.join(",")}`}
                  className="rounded-dusk-code bg-dusk-pill px-3 py-2 text-xs leading-5 text-dusk-muted"
                >
                  <span className="text-dusk-ink">{claim.text}</span>
                  {claim.weak ? <span> (weak: no direct quote)</span> : null}
                  <span className="mt-1 flex flex-wrap gap-1">
                    {claim.evidenceIds.map((id) => {
                      const cited = evidenceById.get(id);
                      return cited ? (
                        <button
                          key={id}
                          type="button"
                          title={`${cited.kind} · ${cited.ts} — scrub to this moment`}
                          onClick={() => onCite(cited.ts)}
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
                  {claim.quote ? (
                    <span className="mt-1 block font-mono text-[10px]">“{claim.quote}”</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="font-mono text-[10px] text-dusk-muted">
              uncertainty: {result.uncertainty}
              {result.cached ? " · cached" : ""}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
