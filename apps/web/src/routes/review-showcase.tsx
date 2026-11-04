import type {
  Change,
  ChangeCodeResponse,
  CheckAttemptV2,
  ChecksV2Response,
  ProgressState,
  PublicCheckQuestion,
} from "@echo/contracts";
import { CaughtUp } from "../components/caught-up";
import { ChangeCard } from "../components/change-card";
import { CheckRunner } from "../components/check-runner";
import { ProgressTape } from "../components/progress-tape";
import { ReaderRail } from "../components/reader-rail";
import { ScaffoldPage } from "../components/scaffold-page";

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-dusk-ink">{title}</h2>
        <p className="mt-1 text-sm text-dusk-muted">{hint}</p>
      </div>
      <div className="border-t border-dusk-hairline pt-4">{children}</div>
    </section>
  );
}

const changeFull: Change = {
  id: "c_a1b2c3d4e5f60718",
  version: 1,
  snapshotPair: { prevOid: "47b5256abc", nextOid: "60c4f81def" },
  title: "Add retry to billing webhook",
  summary:
    "Failed webhook posts now retry once with backoff. The handler was dropping them silently before.",
  before: ["Failed posts were dropped with no retry."],
  now: ["Failed posts retry once after a short backoff."],
  howItWorks: [
    "Catch the post failure in the webhook handler.",
    "Wait with exponential backoff before retrying.",
    "Record the retry outcome in the delivery log.",
  ],
  headsUp: [
    { type: "watch_out", text: "Retries can double-charge if the receiver is not idempotent." },
    {
      type: "not_asked",
      text: "Nobody asked for a dead-letter queue; failures still drop after one retry.",
    },
    { type: "unfinished", text: "Metrics for retry counts are still TODO." },
  ],
  moment: "warnings that are easier to spot",
  verify: [
    "Trigger a failed webhook post and confirm it retries once.",
    "Open the billing status panel and confirm the retry state shows.",
  ],
  files: [
    { path: "apps/server/src/billing/retry.ts", note: "Adds the one-shot retry wrapper." },
    { path: "apps/server/src/billing/handler.ts", note: "Calls retry around the post." },
    { path: "apps/web/src/components/billing/status.tsx", note: "Shows the retry state." },
    {
      path: "apps/web/src/components/billing/history/architecture.ts",
      note: "Groups history under the new area.",
    },
  ],
  digest:
    "Failed webhook posts now retry once with backoff instead of dropping silently apps/server/src/billing/retry.ts apps/server/src/billing/handler.ts apps/web/src/components/billing/status.tsx changed delivery behavior with one retry and logged outcomes for review",
  createdFrom: { kind: "tape_range", startSeq: 12, endSeq: 34 },
  origin: "model",
};

const changeMinimal: Change = {
  id: "c_1928374656abcdef",
  version: 1,
  snapshotPair: { prevOid: "1111111aaa", nextOid: "2222222bbb" },
  title: "Fix typo in empty state",
  summary:
    "The empty inbox line had a typo. It now reads correctly and nothing else changed in this pass.",
  before: ["The empty state read 'No sesssions yet'."],
  now: ["It reads 'No sessions yet'."],
  howItWorks: [],
  headsUp: [],
  files: [{ path: "apps/web/src/routes/projects.tsx", note: "Fixes the empty-state copy." }],
  digest:
    "The empty inbox line had a typo and now reads correctly apps/web/src/routes/projects.tsx copy fix only with no behavior change and nothing else touched in this pass today",
  createdFrom: { kind: "snapshot_pair", prevOid: "1111111aaa", nextOid: "2222222bbb" },
  origin: "skeleton",
};

const changeWatchOnly: Change = {
  id: "c_deadbeef01234567",
  version: 2,
  snapshotPair: { prevOid: "3333333ccc", nextOid: "4444444ddd" },
  title: "Widen session token scope",
  summary:
    "The session token now covers the sync endpoint too. The old scope was too narrow and sync kept failing.",
  before: ["Sync calls failed with the old token scope."],
  now: ["The token covers sync as well as read."],
  howItWorks: ["Add the sync scope to the token request."],
  headsUp: [{ type: "watch_out", text: "A leaked token now reaches further than before." }],
  verify: ["Revoke a token and confirm sync calls fail closed."],
  files: [{ path: "apps/server/src/auth/scope.ts", note: "Widens the requested scope." }],
  digest:
    "The session token now covers the sync endpoint too apps/server/src/auth/scope.ts broader scope fixes sync failures with a wider blast radius worth a careful look",
  createdFrom: { kind: "tape_range", startSeq: 40, endSeq: 51 },
  origin: "model",
};

const tapeChanges: Change[] = [
  changeFull,
  changeMinimal,
  changeWatchOnly,
  { ...changeMinimal, id: "c_aaaaaaaaaaaaaaaa", title: "Rename helper for clarity" },
  { ...changeMinimal, id: "c_bbbbbbbbbbbbbbbb", title: "Bump lockfile after install" },
];

const tapeStates: Record<string, { state: ProgressState; updatedAt: string }> = {
  "c_a1b2c3d4e5f60718@v1": { state: "understood", updatedAt: "2026-11-02T10:00:00Z" },
  "c_1928374656abcdef@v1": { state: "skipped", updatedAt: "2026-11-02T10:01:00Z" },
  "c_deadbeef01234567@v2": { state: "viewed", updatedAt: "2026-11-02T10:02:00Z" },
};

function tapeStateOf(change: Pick<Change, "id" | "version">): ProgressState | undefined {
  return tapeStates[`${change.id}@v${change.version}`]?.state;
}

const codeLoaded: ChangeCodeResponse = {
  changeId: changeFull.id,
  version: 1,
  files: [
    {
      path: "apps/server/src/billing/retry.ts",
      added: 316,
      removed: 12,
      truncated: false,
      hunks: [
        {
          prevStart: 10,
          prevLines: 3,
          nextStart: 10,
          nextLines: 5,
          lines: [
            { kind: "context", prevNo: 10, nextNo: 10, text: "export async function post(url) {" },
            { kind: "del", prevNo: 11, nextNo: null, text: "  return fetch(url);" },
            {
              kind: "add",
              prevNo: null,
              nextNo: 11,
              text: "  return withRetry(() => fetch(url));",
            },
            { kind: "context", prevNo: 12, nextNo: 12, text: "}" },
          ],
        },
      ],
    },
    {
      path: "apps/server/src/billing/handler.ts",
      added: 355,
      removed: 26,
      truncated: false,
      hunks: [],
    },
  ],
};

const mcq: PublicCheckQuestion = {
  id: "q_mcq_1",
  cardId: changeFull.id,
  kind: "consequence",
  question: "What happens when the webhook post fails the first time?",
  evidenceFactIds: [],
  evidencePaths: [],
  format: "mcq",
  options: [
    { id: "o_a", text: "It retries once after a short backoff." },
    { id: "o_b", text: "It drops the post and logs an error." },
    { id: "o_c", text: "It blocks until the receiver acks." },
  ],
};

const freeText: PublicCheckQuestion = {
  id: "q_free_1",
  cardId: changeWatchOnly.id,
  kind: "teach_back",
  question: "In your own words, why does the wider token scope matter?",
  evidenceFactIds: [],
  evidencePaths: [],
  format: "free_text",
};

function checksState(
  questions: PublicCheckQuestion[],
  attempts: CheckAttemptV2[],
  status: ChecksV2Response["status"],
): ChecksV2Response {
  return {
    schemaVersion: 1,
    sessionId: "ses_showcase",
    status,
    generatedAt: "2026-11-02T10:00:00Z",
    tapeWatermark: { eventCount: 42, sha256: "abc" },
    questions,
    attempts,
    picture: [],
    currentQuestionId: null,
  };
}

const doneAttempt: CheckAttemptV2 = {
  id: "a_1",
  questionId: "q_mcq_1",
  confidence: "certain",
  selectedOptionId: "o_a",
  answerText: null,
  correct: true,
  bucket: "solid",
  rubricHits: [],
  evidence: [],
  createdAt: "2026-11-02T10:05:00Z",
};

const noop = () => {};

export function ReviewShowcasePage() {
  return (
    <ScaffoldPage
      eyebrow="Showcase"
      title="Session review states"
      description="Every state the review UI can be in, on one page. Dev only."
    >
      <div className="space-y-12">
        <Section
          title="Progress tape"
          hint="Mixed progress, all done, and a live session still recording."
        >
          <div className="space-y-6">
            <ProgressTape
              changes={tapeChanges}
              currentIndex={2}
              getState={tapeStateOf}
              isLive={false}
              onJump={noop}
            />
            <ProgressTape
              changes={tapeChanges}
              currentIndex={5}
              getState={() => "understood"}
              isLive={false}
              onJump={noop}
            />
            <ProgressTape
              changes={tapeChanges}
              currentIndex={5}
              getState={tapeStateOf}
              isLive
              onJump={noop}
            />
          </div>
        </Section>

        <Section
          title="Change card"
          hint="Full card, minimal card (no How it works, nothing to flag, diff still loading), and a failed diff with a Verify list but no moment."
        >
          <div className="max-w-[700px] space-y-12">
            <ChangeCard
              change={changeFull}
              code={codeLoaded}
              connections={[
                { id: changeMinimal.id, title: changeMinimal.title, direction: "earlier" },
              ]}
              onJumpToChange={noop}
            />
            <ChangeCard change={changeMinimal} code={null} />
            <ChangeCard change={changeWatchOnly} codeFailed />
          </div>
        </Section>

        <Section
          title="Files rail"
          hint="Nested groups with stats, a single file, and the loading state with no stats yet."
        >
          <div className="max-w-[360px] space-y-8">
            <ReaderRail
              changes={tapeChanges}
              currentIndex={0}
              getState={tapeStateOf}
              onJump={noop}
              files={changeFull.files}
              codeFiles={codeLoaded.files}
            />
            <ReaderRail
              changes={tapeChanges}
              currentIndex={1}
              getState={tapeStateOf}
              onJump={noop}
              files={changeMinimal.files}
              codeFiles={null}
            />
          </div>
        </Section>

        <Section title="Caught up" hint="With skipped changes to revisit, and the clean state.">
          <div className="max-w-[700px] space-y-8">
            <CaughtUp
              summary="Five small changes, mostly polish plus one billing retry worth a look."
              skipped={[changeMinimal, changeWatchOnly]}
              total={5}
              neverOpened={1}
              onDone={noop}
              onRevisit={noop}
            />
            <CaughtUp
              summary="One typo fix. Nothing else shipped."
              skipped={[]}
              total={1}
              neverOpened={0}
              onDone={noop}
              onRevisit={noop}
            />
          </div>
        </Section>

        <Section
          title="Check runner"
          hint="MCQ waiting for confidence, free text, and the finished picture. Submitting hits the API, so these are look-only."
        >
          <div className="max-w-[700px] space-y-8">
            <CheckRunner
              sessionId="ses_showcase"
              state={checksState([mcq, freeText], [], "in_progress")}
              focusQuestionId={mcq.id}
              onUpdate={noop}
              onSkip={noop}
              onDone={noop}
            />
            <CheckRunner
              sessionId="ses_showcase"
              state={checksState([freeText], [], "in_progress")}
              focusQuestionId={freeText.id}
              onUpdate={noop}
              onSkip={noop}
              onDone={noop}
            />
            <CheckRunner
              sessionId="ses_showcase"
              state={checksState([mcq], [doneAttempt], "completed")}
              focusQuestionId={null}
              onUpdate={noop}
              onSkip={noop}
              onDone={noop}
            />
          </div>
        </Section>
      </div>
    </ScaffoldPage>
  );
}
