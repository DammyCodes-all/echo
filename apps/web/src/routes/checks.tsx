import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { CheckCard } from "../components/check-card";
import { ScaffoldPage } from "../components/scaffold-page";
import { getOpenedHunks } from "../opened-hunks";

export function ChecksPage() {
  const { sessionId = "" } = useParams();
  const queryClient = useQueryClient();
  const [generating, setGenerating] = useState(false);
  const [waiving, setWaiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropped, setDropped] = useState<Array<{ hunkId: string; reason: string }>>([]);

  const state = useQuery({
    queryKey: ["sessionChecks", sessionId],
    queryFn: () => api.sessionChecks(sessionId),
  });

  async function generate(waived: string[]) {
    setGenerating(true);
    setError(null);
    try {
      const response = await api.generateChecks(sessionId, {
        limit: 3,
        opened: getOpenedHunks(sessionId),
        waived,
      });
      setDropped(response.dropped);
      await queryClient.invalidateQueries({ queryKey: ["sessionChecks", sessionId] });
    } catch (unknown) {
      setError(unknown instanceof Error ? unknown.message : "Could not generate checks.");
    } finally {
      setGenerating(false);
    }
  }

  async function waive(hunkId: string) {
    setWaiving(true);
    setError(null);
    try {
      const waived = [...(state.data?.waived ?? []), hunkId];
      const response = await api.generateChecks(sessionId, {
        limit: 3,
        opened: getOpenedHunks(sessionId),
        waived,
      });
      setDropped(response.dropped);
      await queryClient.invalidateQueries({ queryKey: ["sessionChecks", sessionId] });
    } catch (unknown) {
      setError(unknown instanceof Error ? unknown.message : "Could not waive this hunk.");
    } finally {
      setWaiving(false);
    }
  }

  const checks = state.data?.checks ?? [];
  const attempts = state.data?.attempts ?? {};

  return (
    <ScaffoldPage
      eyebrow="Understanding checks"
      title="Prove what you took in"
      description="Echo selects a few risky hunks, asks short questions about them, and grades every answer against a rubric. Confidence comes before the answer."
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void generate(state.data?.waived ?? [])}
          disabled={generating}
          className="rounded-dusk-code bg-dusk-ink px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          {generating ? "Selecting…" : checks.length === 0 ? "Generate checks" : "Regenerate"}
        </button>
        <Link
          to={`/sessions/${sessionId}/report`}
          className="rounded-dusk-code bg-dusk-pill px-4 py-2 text-sm text-dusk-ink"
        >
          View report
        </Link>
        <Link
          to={`/sessions/${sessionId}/replay`}
          className="text-sm text-dusk-muted underline underline-offset-4"
        >
          Back to replay
        </Link>
      </div>

      {state.isPending ? (
        <div className="rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
          Loading checks…
        </div>
      ) : null}
      {state.isError ? (
        <div className="rounded-dusk-card border border-dusk-fail/40 bg-dusk-fail-wash p-8 text-sm text-dusk-fail">
          Could not load checks.
        </div>
      ) : null}
      {error ? (
        <div className="mb-4 rounded-dusk-card border border-dusk-fail/40 bg-dusk-fail-wash p-4 text-sm text-dusk-fail">
          {error}
        </div>
      ) : null}
      {state.data && checks.length === 0 ? (
        <div className="rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
          No checks yet. Generate a set from the riskiest hunks you never opened — or the session
          has no captured hunks to ask about.
        </div>
      ) : null}
      {dropped.length > 0 ? (
        <p className="mb-4 font-mono text-[11px] text-dusk-muted">
          Dropped:{" "}
          {dropped.map((entry) => `${entry.hunkId.slice(0, 12)} (${entry.reason})`).join(", ")}
        </p>
      ) : null}

      <div className="space-y-4">
        {checks.map((check) => (
          <CheckCard
            key={check.id}
            check={check}
            attempts={attempts[check.id] ?? []}
            onAnswered={() =>
              void queryClient.invalidateQueries({ queryKey: ["sessionChecks", sessionId] })
            }
            onWaive={(hunkId) => void waive(hunkId)}
            waiving={waiving}
          />
        ))}
      </div>
    </ScaffoldPage>
  );
}
