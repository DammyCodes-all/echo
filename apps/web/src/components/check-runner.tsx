import type {
  AnswerConfidence,
  AskEvidence,
  ChecksV2Response,
  PublicCheckQuestion,
} from "@echo/contracts";
import { useState } from "react";
import { api } from "../api";

const CONFIDENCE_OPTIONS: Array<{ value: AnswerConfidence; label: string }> = [
  { value: "guessing", label: "Guessing" },
  { value: "think_so", label: "Think so" },
  { value: "certain", label: "Certain" },
];

const UNAVAILABLE_MESSAGE = "Check unavailable (model off). Your session status is untouched.";

function toMessage(error: unknown): string {
  if ((error instanceof DOMException || error instanceof Error) && error.name === "TimeoutError") {
    return "Check timed out — the model is slow or unreachable. Try again.";
  }
  const raw = error instanceof Error ? error.message : "Check failed.";
  return /unavailable/i.test(raw) ? UNAVAILABLE_MESSAGE : raw;
}

const PRIMARY =
  "rounded-dusk-pill bg-dusk-accent px-5 py-2.5 text-sm font-semibold text-dusk-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent disabled:opacity-40";

type Reveal = { summary: string; evidence: AskEvidence[] };

type CheckRunnerProps = {
  sessionId: string;
  state: ChecksV2Response;
  focusQuestionId: string | null;
  onUpdate: (state: ChecksV2Response) => void;
  /** Absent when skipping is unavailable (the read-only demo rejects it). */
  onSkip?: () => void;
  onDone: () => void;
};

function firstUnanswered(
  state: ChecksV2Response,
  focusQuestionId: string | null,
): PublicCheckQuestion | null {
  const answered = new Set(state.attempts.map((attempt) => attempt.questionId));
  const unanswered = state.questions.filter((question) => !answered.has(question.id));
  if (unanswered.length === 0) return null;
  if (focusQuestionId !== null) {
    const focused = unanswered.find((question) => question.id === focusQuestionId) ?? null;
    if (focused !== null) return focused;
  }
  const current = state.currentQuestionId
    ? (unanswered.find((question) => question.id === state.currentQuestionId) ?? null)
    : null;
  return current ?? unanswered[0] ?? null;
}

export function CheckRunner({
  sessionId,
  state,
  focusQuestionId,
  onUpdate,
  onSkip,
  onDone,
}: CheckRunnerProps) {
  const [currentId, setCurrentId] = useState<string | null>(
    () => firstUnanswered(state, focusQuestionId)?.id ?? null,
  );
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [reveals, setReveals] = useState<Record<string, Reveal>>({});
  const [confidence, setConfidence] = useState<AnswerConfidence | null>(null);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);

  const answered = new Set(state.attempts.map((attempt) => attempt.questionId));
  const unanswered = state.questions.filter((question) => !answered.has(question.id));
  const current =
    state.questions.find((question) => question.id === currentId && !answered.has(question.id)) ??
    unanswered.find((question) => question.id === focusQuestionId) ??
    unanswered[0] ??
    null;

  const resetForm = () => {
    setConfidence(null);
    setSelectedOptionId(null);
    setAnswerText("");
    setError(null);
  };

  async function submitAs(payload: { confidence: AnswerConfidence; answer: string }) {
    if (current === null || pending) return;
    setPending(true);
    setError(null);
    try {
      const input =
        current.format === "mcq"
          ? {
              questionId: current.id,
              confidence: payload.confidence,
              selectedOptionId: payload.answer,
              answerText: null,
            }
          : {
              questionId: current.id,
              confidence: payload.confidence,
              selectedOptionId: null,
              answerText: payload.answer,
            };
      const result = await api.answerCheckV2(sessionId, input);
      setReveals((previous) => ({ ...previous, [current.id]: result.reveal }));
      // Server is the source of truth: refresh the full state after answering.
      const fresh = await api.checksV2State(sessionId);
      onUpdate(fresh);
      setRevealedId(current.id);
      const freshAnswered = new Set(fresh.attempts.map((attempt) => attempt.questionId));
      const next = fresh.questions.find((question) => !freshAnswered.has(question.id)) ?? null;
      setCurrentId(next?.id ?? null);
      resetForm();
    } catch (unknown) {
      setError(toMessage(unknown));
    } finally {
      setPending(false);
    }
  }

  function submit() {
    if (current === null || confidence === null) return;
    if (current.format === "mcq") {
      if (selectedOptionId === null) return;
      void submitAs({ confidence, answer: selectedOptionId });
    } else {
      const trimmed = answerText.trim();
      if (trimmed.length === 0) return;
      void submitAs({ confidence, answer: trimmed });
    }
  }

  function submitIDontKnow() {
    if (current === null || current.format !== "free_text" || pending) return;
    void submitAs({ confidence: "guessing", answer: "I don't know" });
  }

  async function handleSkip() {
    if (skipping || !onSkip) return;
    setSkipping(true);
    try {
      onSkip();
    } finally {
      setSkipping(false);
    }
  }

  // A reveal is showing for the just-answered question: Correct/Not quite plus
  // the server's summary and evidence chips, then move on.
  if (revealedId !== null) {
    const attempt = state.attempts.find((attempted) => attempted.questionId === revealedId) ?? null;
    const reveal = reveals[revealedId] ?? null;
    return (
      <div className="space-y-3 rounded-dusk-card bg-dusk-surface px-6 py-5">
        <p
          className={`text-sm font-medium ${attempt?.correct ? "text-dusk-accent-soft" : "text-dusk-fail"}`}
        >
          {attempt === null ? "Answer recorded." : attempt.correct ? "Correct." : "Not quite."}
        </p>
        {reveal !== null ? (
          <div className="space-y-2">
            <p className="text-sm text-dusk-ink">{reveal.summary}</p>
            {reveal.evidence.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {reveal.evidence.map((item) => (
                  <span
                    key={item.evidenceId}
                    title={`${item.kind} · ${item.ts} — ${item.text}`}
                    className="rounded-dusk-code bg-dusk-track px-1.5 py-0.5 font-mono text-[10px] text-dusk-accent-soft"
                  >
                    {item.evidenceId}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {error !== null ? <p className="text-sm text-dusk-fail">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setRevealedId(null)} className={PRIMARY}>
            {unanswered.length > 0 ? "Next" : "See your picture"}
          </button>
          {onSkip ? (
            <button
              type="button"
              onClick={() => void handleSkip()}
              disabled={skipping}
              className="rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-muted disabled:opacity-40"
            >
              Skip — no pressure
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  // Nothing left to answer: the picture is ready.
  if (current === null) {
    return (
      <div className="space-y-3 rounded-dusk-card bg-dusk-surface px-6 py-5">
        <p className="text-sm text-dusk-ink">Check complete — your picture is ready.</p>
        <button type="button" onClick={onDone} className={PRIMARY}>
          See your picture
        </button>
      </div>
    );
  }

  const remaining = unanswered.length;
  const canSubmit =
    confidence !== null &&
    !pending &&
    (current.format === "mcq" ? selectedOptionId !== null : answerText.trim().length > 0);

  return (
    <div className="space-y-4 rounded-dusk-card bg-dusk-surface px-6 py-5">
      <div className="flex items-start justify-between gap-3">
        <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
          Understanding check{remaining > 1 ? ` · ${remaining} left` : ""}
        </p>
        <button
          type="button"
          onClick={() => void handleSkip()}
          disabled={skipping}
          className="shrink-0 text-sm text-dusk-muted underline underline-offset-4 disabled:opacity-40"
        >
          Skip — no pressure
        </button>
      </div>
      <p className="text-dusk-body text-dusk-ink">{current.question}</p>

      <div>
        <p className="text-xs text-dusk-muted">First: how confident are you?</p>
        <div className="mt-2 flex gap-2">
          {CONFIDENCE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                setConfidence(option.value);
                setError(null);
              }}
              disabled={pending}
              className={`rounded-dusk-code px-3 py-2 text-sm disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent ${
                confidence === option.value
                  ? "bg-dusk-accent-wash text-dusk-ink"
                  : "bg-dusk-pill text-dusk-ink"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {confidence !== null ? (
        current.format === "mcq" ? (
          <div className="space-y-2" role="radiogroup" aria-label="Answer options">
            {current.options.map((option) => (
              <label
                key={option.id}
                className={`flex cursor-pointer items-start gap-2 rounded-dusk-code px-3 py-2 text-sm ${
                  selectedOptionId === option.id
                    ? "bg-dusk-accent-wash text-dusk-ink"
                    : "bg-dusk-pill text-dusk-ink"
                }`}
              >
                <input
                  type="radio"
                  name={`check-${current.id}`}
                  checked={selectedOptionId === option.id}
                  onChange={() => setSelectedOptionId(option.id)}
                  disabled={pending}
                  className="mt-1"
                />
                <span>{option.text}</span>
              </label>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <textarea
              value={answerText}
              onChange={(event) => setAnswerText(event.target.value)}
              placeholder="Your answer, in your own words."
              rows={4}
              disabled={pending}
              className="w-full rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink outline-none placeholder:text-dusk-muted disabled:opacity-40"
            />
            <button
              type="button"
              onClick={submitIDontKnow}
              disabled={pending}
              className="rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-muted disabled:opacity-40"
            >
              I don&apos;t know
            </button>
          </div>
        )
      ) : null}

      {confidence !== null ? (
        <div className="flex gap-2">
          <button type="button" onClick={submit} disabled={!canSubmit} className={PRIMARY}>
            {pending ? "Checking…" : "Submit answer"}
          </button>
        </div>
      ) : null}

      {error !== null ? (
        <div className="space-y-2">
          <p className="text-sm text-dusk-fail">{error}</p>
          {error === UNAVAILABLE_MESSAGE ? (
            <button
              type="button"
              onClick={() => setError(null)}
              className="rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink"
            >
              Back
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
