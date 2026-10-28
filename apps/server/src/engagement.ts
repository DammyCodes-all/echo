import { EngagementStateSchema, RecordEngagementRequestSchema } from "@echo/contracts";
import {
  deriveEngagementTiers,
  type EchoDb,
  type EngagementEventInput,
  getSession,
  listEngagementEvents,
  recordEngagementEvents,
} from "@echo/db";

export interface EngagementOutcome {
  status: number;
  body: unknown;
}

export interface EngagementService {
  record(sessionId: string, body: unknown): EngagementOutcome;
  state(sessionId: string, cardIds?: string[]): EngagementOutcome;
}

// No redaction gate: engagement payloads carry only ids, kinds, and
// timestamps — no free text, excerpts, or tool output.

export function createEngagementService(db: EchoDb): EngagementService {
  return {
    record(sessionId: string, body: unknown): EngagementOutcome {
      const parsed = RecordEngagementRequestSchema.safeParse(body);
      if (!parsed.success) {
        return {
          status: 400,
          body: {
            error: {
              code: "invalid_request",
              message: "events must be a non-empty array of at most 100 engagement events",
            },
          },
        };
      }
      if (!getSession(db, sessionId)) {
        return {
          status: 404,
          body: { error: { code: "not_found", message: "unknown session" } },
        };
      }
      const inputs: EngagementEventInput[] = parsed.data.events.map((event) => ({
        id: event.id,
        cardId: event.cardId ?? null,
        kind: event.kind,
        occurredAt: event.occurredAt,
      }));
      const inserted = recordEngagementEvents(db, sessionId, inputs);
      return { status: 200, body: { sessionId, inserted } };
    },

    state(sessionId: string, cardIds?: string[]): EngagementOutcome {
      if (!getSession(db, sessionId)) {
        return {
          status: 404,
          body: { error: { code: "not_found", message: "unknown session" } },
        };
      }
      let resolved: string[];
      if (cardIds !== undefined) {
        const seen = new Set<string>();
        resolved = [];
        for (const id of cardIds) {
          if (id === "") continue;
          if (seen.has(id)) continue;
          seen.add(id);
          resolved.push(id);
          if (resolved.length >= 500) break;
        }
      } else {
        const seen = new Set<string>();
        for (const row of listEngagementEvents(db, sessionId)) {
          if (row.cardId === null || row.cardId === "" || seen.has(row.cardId)) continue;
          seen.add(row.cardId);
        }
        resolved = [...seen];
      }
      const tiers = deriveEngagementTiers(db, sessionId, resolved);
      const body = { sessionId, tiers };
      // Fail fast if the contract ever drifts from the db derivation.
      EngagementStateSchema.parse(body);
      return { status: 200, body };
    },
  };
}
