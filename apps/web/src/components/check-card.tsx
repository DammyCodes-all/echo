import type { AnswerConfidence, CheckAttempt, StoredCheck } from "@echo/contracts";
import { useState } from "react";
import { api } from "../api";

const CONFIDENCE_LABELS: Array<{ value: AnswerConfidence; label: string }> = [
  { value: "guessing", label: "Guessing" },
  { value: "think_so", label: "Think so" },
  { value: "certain", label: "Certain" },
];

interface CheckCardProps {
  check: StoredCheck;
  attempts: CheckAttempt[];
  onAnswered: () => void;
  onWaive: (hunkId: string) => void;
  waiving: boolean;
}

export function CheckCard({ check, attempts, onAnswered, onWaive, waiving }: CheckCardProps) {
  const [confidence, setConfidence] = useState<AnswerConfidence | null>(null);
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(attempts.length > 0);

  const latest = attempts[attempts.length - 1] ?? null;

  async function submit() {
    if (!confidence || answer.trim().length === 0 || pending) return;
    setPending(true);
    setError(null);
    try {
      await api.answerCheck(check.id, { confidence, answer: answer.trim() });
      setRevealed(true);
      onAnswered();
    } catch (unknown) {
      setError(unknown instanceof Error ? unknown.message : "Could not grade the answer.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-dusk-card bg-dusk-surface">
      <div className="border-b border-dusk-hairline px-6 py-4">
        <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
          {check.kind.replace("_", " ")} · {check.path}
        </p>
        <p className="mt-2 text-dusk-body text-dusk-ink">{check.question}</p>
      </div>
      <div className="space-y-4 px-6 py-4">
        {latest && revealed ? (
          <div className="space-y-3">
            <p
              className={`text-sm font-medium ${latest.correct ? "text-dusk-accent-soft" : "text-dusk-fail"}`}
            >
              {latest.correct ? "Correct." : "Not quite."}{" "}
              <span className="font-normal text-dusk-muted">
                You were {latest.confidence.replace("_", " ")} (brier {latest.brier.toFixed(3)}).
              </span>
            </p>
            {latest.overconfident ? (
              <p className="rounded-dusk-code bg-dusk-fail-wash px-3 py-2 text-sm text-dusk-fail">
                Wrong and certain — the key event. Review the rubric below.
              </p>
            ) : null}
            <ul className="space-y-2">
              {latest.hits.map((hit) => (
                <li
                  key={hit.point}
                  className="rounded-dusk-code bg-dusk-pill px-3 py-2 text-xs leading-5 text-dusk-muted"
                >
                  <span className={hit.hit ? "text-dusk-accent-soft" : "text-dusk-fail"}>
                    {hit.hit ? "Hit" : "Missed"}:
                  </span>{" "}
                  <span className="text-dusk-ink">{hit.point}</span>
                  {hit.excerpt ? (
                    <span className="mt-1 block font-mono text-[10px]">“{hit.excerpt}”</span>
                  ) : null}
                  {hit.why ? <span className="mt-1 block">{hit.why}</span> : null}
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setRevealed(false);
                  setConfidence(null);
                  setAnswer("");
                }}
                className="rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink"
              >
                Answer again
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <p className="text-xs text-dusk-muted">First: how confident are you?</p>
              <div className="mt-2 flex gap-2">
                {CONFIDENCE_LABELS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setConfidence(option.value)}
                    className={`rounded-dusk-code px-3 py-2 text-sm ${
                      confidence === option.value
                        ? "bg-dusk-ink text-white"
                        : "bg-dusk-pill text-dusk-ink"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            {confidence ? (
              <div className="space-y-3">
                <textarea
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  placeholder="Your answer, in your own words."
                  rows={4}
                  className="w-full rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink outline-none placeholder:text-dusk-muted"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void submit()}
                    disabled={pending || answer.trim().length === 0}
                    className="rounded-dusk-code bg-dusk-ink px-3 py-2 text-sm text-white disabled:opacity-40"
                  >
                    {pending ? "Grading…" : "Submit answer"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onWaive(check.hunkId)}
                    disabled={waiving || pending}
                    className="rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-muted disabled:opacity-40"
                  >
                    Waive this hunk
                  </button>
                </div>
              </div>
            ) : null}
            {error ? <p className="text-sm text-dusk-fail">{error}</p> : null}
          </div>
        )}
      </div>
    </div>
  );
}
