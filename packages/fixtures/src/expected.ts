import type { ChangeCard, Detour, LooseEnd } from "@echo/contracts";
import type { FixtureStorySession } from "./sessions";

/**
 * Hand-labelled acceptance expectations for the six fixture sessions.
 *
 * SCOPE (per quick-council verdict C): these are labels for the future
 * story validator, written against the OBSERVED locked contracts
 * (ChangeCard/Detour/LooseEnd schemas, verification badges). They assert
 * what the tape supports — never invented history. Card IDs reuse the
 * canonical hunk IDs from the session; claim factIds reuse tape event IDs,
 * the only stable evidence handles available pre-pipeline (the story
 * pipeline may remap them to F… fact IDs).
 *
 * Verification discipline (ARCHITECTURE §12/§13): a badge covers the card's
 * KEY behaviour. `observed` only when recorded evidence covers all of it;
 * `partly_observed` when part is covered; `agent_stated` for quoted text;
 * `nothing` when nothing supports it. Only `observed` counts as verified.
 */
export interface SeededContradiction {
  claimId: string;
  claimText: string;
  assertedNumber: number;
  observedNumber: number;
  evidenceRunId: string;
  disposition: "must-drop";
  reason: string;
}

export interface FoldedDeadEnd {
  headline: string;
  foldReason: string;
  toolCallId: string | null;
}

export interface SessionExpectedFacts {
  slug: string;
  sessionId: string;
  cards: ChangeCard[];
  detoursIn: Detour[];
  detoursOut: FoldedDeadEnd[];
  looseEnds: LooseEnd[];
  blindSpots: string[];
  suppressChecksFor: string[];
  routineLine: string | null;
  noCheckNeeded: boolean;
  seededContradictions: SeededContradiction[];
}

function eventTs(session: FixtureStorySession, eventId: string): string {
  const event = session.tape.find((entry) => entry.event_id === eventId);
  if (!event) throw new Error(`event ${eventId} missing in session ${session.slug}`);
  return event.ts;
}

function hunkOrThrow(session: FixtureStorySession, path: string, index: number) {
  const hunks = session.hunks.filter((hunk) => hunk.path === path);
  const hunk = hunks[index];
  if (!hunk) throw new Error(`hunk ${index} missing for ${path} in ${session.slug}`);
  return hunk;
}

function attemptOrThrow(session: FixtureStorySession, path: string, status: string) {
  const attempt = session.attempts.find((entry) => entry.path === path && entry.status === status);
  if (!attempt) throw new Error(`${status} attempt missing for ${path} in ${session.slug}`);
  return attempt;
}

function paymentRetry(session: FixtureStorySession): SessionExpectedFacts {
  const hunk = hunkOrThrow(session, "src/payments/retry.ts", 0);
  const promptId = `fixture-${session.slug}-2`;
  const editId = `fixture-${session.slug}-4`;
  const failId = `fixture-${session.slug}-6`;
  const card: ChangeCard = {
    id: hunk.id,
    headline: "Retry failed payments with exponential backoff",
    constituentHunkIds: [hunk.id],
    constituentActionIds: ["call_edit_retry", "call_test_pay"],
    rank: 1,
    sessionOrder: 0,
    highRisk: true,
    riskReasons: [
      "payments: touches src/payments/retry.ts — payment boundary",
      "unverified: no passing run covers the retry behaviour",
    ],
    // Edit landed (observed) but the behaviour only ever ran to failure:
    // the success path is unobserved, so this is partial, not verified.
    verification: "partly_observed",
    why: [
      {
        text: "Prompt asked for exponential backoff on failed payments",
        label: "observed",
        factIds: [promptId],
      },
    ],
    before: [{ text: "charge() ran once with no retry", label: "observed", factIds: [] }],
    now: [
      {
        text: "charge() retries up to 5 times with doubling delay",
        label: "observed",
        factIds: [editId],
      },
    ],
    checkedBy: [
      {
        text: "npm test -- payments failed after 2 attempts; no passing run observed",
        label: "observed",
        factIds: [`fixture-${session.slug}-5`, failId],
      },
    ],
    touches: ["src/payments/retry.ts"],
    moment: {
      eventId: failId,
      toolCallId: "call_test_pay",
      ts: eventTs(session, failId),
      excerpt: "FAILED after 2 attempts",
      label: "observed",
    },
    history: { priorSessionIds: [], previousPicture: null, note: null },
  };
  return {
    slug: session.slug,
    sessionId: session.sessionId,
    cards: [card],
    detoursIn: [],
    detoursOut: [],
    looseEnds: [
      {
        id: "le-payment-success-path",
        kind: "untested",
        claims: [
          {
            text: "Retry success path has no passing run",
            label: "observed",
            factIds: [failId],
          },
        ],
        cardId: card.id,
      },
    ],
    blindSpots: [],
    suppressChecksFor: [],
    routineLine: null,
    noCheckNeeded: false,
    seededContradictions: [
      {
        claimId: "seeded-retry-count",
        claimText: "The retry loop attempts the charge 3 times",
        assertedNumber: 3,
        observedNumber: 2,
        evidenceRunId: "run-payments-test",
        disposition: "must-drop",
        reason:
          "tape run output shows 2 attempts before failure; the claim asserts 3 with no supporting record",
      },
    ],
  };
}

function routineCleanup(session: FixtureStorySession): SessionExpectedFacts {
  return {
    slug: session.slug,
    sessionId: session.sessionId,
    cards: [],
    detoursIn: [],
    detoursOut: [],
    looseEnds: [],
    blindSpots: [],
    suppressChecksFor: [],
    routineLine:
      "Formatting, import order and an internal rename in src/util/format.ts — no behaviour change.",
    noCheckNeeded: false,
    seededContradictions: [],
  };
}

function researchOnly(session: FixtureStorySession): SessionExpectedFacts {
  return {
    slug: session.slug,
    sessionId: session.sessionId,
    cards: [],
    detoursIn: [],
    detoursOut: [],
    looseEnds: [],
    blindSpots: [],
    suppressChecksFor: [],
    routineLine: null,
    noCheckNeeded: true,
    seededContradictions: [],
  };
}

function failedDeploy(session: FixtureStorySession): SessionExpectedFacts {
  const hunk = hunkOrThrow(session, "dist/preview.txt", 0);
  const promptId = `fixture-${session.slug}-2`;
  const failId = `fixture-${session.slug}-4`;
  const attempt = attemptOrThrow(session, "dist/preview.txt", "failed_with_side_effect");
  const card: ChangeCard = {
    id: hunk.id,
    headline: "Attempted preview deploy (failed, left a partial artifact)",
    constituentHunkIds: [hunk.id],
    constituentActionIds: ["call_deploy"],
    rank: 1,
    sessionOrder: 0,
    highRisk: true,
    riskReasons: [
      "production: deploy to the preview environment",
      "failed_with_side_effect: tool failed after writing dist/preview.txt",
    ],
    // The key behaviour (a deployed preview) never happened: no evidence
    // supports it, even though the attempt and its side effect are observed.
    verification: "nothing",
    why: [
      {
        text: "Prompt asked to deploy the preview build",
        label: "observed",
        factIds: [promptId],
      },
    ],
    before: [],
    now: [
      {
        text: "dist/preview.txt exists partially; deploy exited 1",
        label: "observed",
        factIds: [failId],
      },
    ],
    checkedBy: [
      {
        text: "./scripts/deploy-preview.sh failed at chunk 3/9",
        label: "observed",
        factIds: [`fixture-${session.slug}-3`, failId],
      },
    ],
    touches: ["dist/preview.txt"],
    moment: {
      eventId: failId,
      toolCallId: "call_deploy",
      ts: eventTs(session, failId),
      excerpt: "upload failed at chunk 3/9 (dist/preview.txt partial)",
      label: "observed",
    },
    history: { priorSessionIds: [], previousPicture: null, note: null },
  };
  return {
    slug: session.slug,
    sessionId: session.sessionId,
    cards: [card],
    detoursIn: [
      {
        id: "detour-deploy",
        headline: "Preview deploy failed with a partial side effect",
        claims: [
          {
            text: "Deploy tool failed after writing a partial artifact",
            label: "observed",
            factIds: [failId],
          },
        ],
        attemptIds: [attempt.id],
        costReason: "side_effect",
      },
    ],
    detoursOut: [],
    looseEnds: [
      {
        id: "le-deploy-retry",
        kind: "todo",
        claims: [
          {
            text: "Preview deploy never completed",
            label: "observed",
            factIds: [failId],
          },
        ],
        cardId: card.id,
      },
    ],
    blindSpots: [],
    suppressChecksFor: [],
    routineLine: null,
    noCheckNeeded: false,
    seededContradictions: [],
  };
}

function partialGap(session: FixtureStorySession): SessionExpectedFacts {
  const hunk = hunkOrThrow(session, "src/db/store.ts", 0);
  const promptId = `fixture-${session.slug}-2`;
  const editId = `fixture-${session.slug}-5`;
  const card: ChangeCard = {
    id: hunk.id,
    headline: "Migrate the session store to SQLite",
    constituentHunkIds: [hunk.id],
    constituentActionIds: ["call_migrate_1"],
    rank: 1,
    sessionOrder: 0,
    highRisk: true,
    riskReasons: [
      "stored_data: touches src/db/store.ts — stored data boundary",
      "capture gap over the edit region: source sequences 5-8 unobserved",
    ],
    // The final file and the completing edit are observed, but the gap over
    // the edit region leaves intermediate states unknown: partial, not verified.
    verification: "partly_observed",
    why: [
      {
        text: "Prompt asked to migrate the session store to SQLite",
        label: "observed",
        factIds: [promptId],
      },
    ],
    before: [{ text: "store was an in-memory Map", label: "observed", factIds: [] }],
    now: [
      {
        text: "store is a SQLite-backed Database",
        label: "observed",
        factIds: [editId],
      },
    ],
    checkedBy: [],
    touches: ["src/db/store.ts"],
    moment: {
      eventId: editId,
      toolCallId: "call_migrate_1",
      ts: eventTs(session, editId),
      excerpt: "write src/db/store.ts ok",
      label: "observed",
    },
    history: { priorSessionIds: [], previousPicture: null, note: null },
  };
  return {
    slug: session.slug,
    sessionId: session.sessionId,
    cards: [card],
    detoursIn: [],
    detoursOut: [],
    looseEnds: [],
    blindSpots: ["capture gap: source sequences 5-8 unobserved (sequence_jump 4→9)"],
    suppressChecksFor: [card.id],
    routineLine: null,
    noCheckNeeded: false,
    seededContradictions: [],
  };
}

function multiTopic(session: FixtureStorySession): SessionExpectedFacts {
  const homeHunk = hunkOrThrow(session, "src/home.ts", 0);
  const readmeHunk = hunkOrThrow(session, "README.md", 0);
  const replaced = attemptOrThrow(session, "src/home.ts", "replaced");
  const homeCard: ChangeCard = {
    id: homeHunk.id,
    headline: "Add a loud greeting, then tone it down before landing",
    constituentHunkIds: [homeHunk.id],
    constituentActionIds: ["call_home_1", "call_home_2", "call_test_home"],
    rank: 1,
    sessionOrder: 0,
    highRisk: false,
    riskReasons: ["reverted attempt: first greeting replaced before landing"],
    verification: "observed",
    why: [
      {
        text: "Prompt asked for a greeting on the homepage",
        label: "observed",
        factIds: [`fixture-${session.slug}-2`],
      },
    ],
    before: [{ text: 'greeting was "hi"', label: "observed", factIds: [] }],
    now: [
      {
        text: 'greeting is "hello" with a loud variant committed then toned down',
        label: "observed",
        factIds: [`fixture-${session.slug}-9`],
      },
    ],
    checkedBy: [
      {
        text: "npm test -- homepage passed",
        label: "observed",
        factIds: [`fixture-${session.slug}-10`, `fixture-${session.slug}-11`],
      },
    ],
    touches: ["src/home.ts"],
    moment: {
      eventId: `fixture-${session.slug}-9`,
      toolCallId: "call_home_2",
      ts: eventTs(session, `fixture-${session.slug}-9`),
      excerpt: 'write src/home.ts: greeting "hello"',
      label: "observed",
    },
    history: { priorSessionIds: [], previousPicture: null, note: null },
  };
  const readmeCard: ChangeCard = {
    id: readmeHunk.id,
    headline: "Fix README typo",
    constituentHunkIds: [readmeHunk.id],
    constituentActionIds: ["call_readme"],
    rank: 2,
    sessionOrder: 1,
    highRisk: false,
    riskReasons: [],
    verification: "observed",
    why: [
      {
        text: "Prompt asked to fix the typo in the README",
        label: "observed",
        factIds: [`fixture-${session.slug}-5`],
      },
    ],
    before: [{ text: 'README read "awsome"', label: "observed", factIds: [] }],
    now: [
      {
        text: 'README reads "awesome"',
        label: "observed",
        factIds: [`fixture-${session.slug}-7`],
      },
    ],
    checkedBy: [],
    touches: ["README.md"],
    moment: {
      eventId: `fixture-${session.slug}-7`,
      toolCallId: "call_readme",
      ts: eventTs(session, `fixture-${session.slug}-7`),
      excerpt: "edit README.md: awsome → awesome",
      label: "observed",
    },
    history: { priorSessionIds: [], previousPicture: null, note: null },
  };
  return {
    slug: session.slug,
    sessionId: session.sessionId,
    cards: [homeCard, readmeCard],
    detoursIn: [
      {
        id: "detour-home-revert",
        headline: "First greeting attempt replaced before landing",
        claims: [
          {
            text: "Loud greeting committed then toned down by the second attempt at the same target",
            label: "observed",
            factIds: [`fixture-${session.slug}-4`, `fixture-${session.slug}-9`],
          },
        ],
        attemptIds: [replaced.id],
        costReason: "reverted",
      },
    ],
    detoursOut: [
      {
        headline: "Lint run failed on a missing config without touching files",
        foldReason: "single failed tool with no file change and no repeat — not a detour",
        toolCallId: "call_lint_triv",
      },
    ],
    looseEnds: [],
    blindSpots: [],
    suppressChecksFor: [],
    routineLine: null,
    noCheckNeeded: false,
    seededContradictions: [],
  };
}

export function expectedFactsFor(session: FixtureStorySession): SessionExpectedFacts {
  switch (session.slug) {
    case "payment-retry":
      return paymentRetry(session);
    case "routine":
      return routineCleanup(session);
    case "research":
      return researchOnly(session);
    case "failed-deploy":
      return failedDeploy(session);
    case "partial-gap":
      return partialGap(session);
    case "multi-topic":
      return multiTopic(session);
    default:
      throw new Error(`no expected facts for session ${session.slug}`);
  }
}
