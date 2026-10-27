import { z } from "zod";

const GIT_OID = /^[0-9a-f]{40}$/;

export const SnapshotRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("shadow"),
    snapshot_id: z.string().min(1),
  }),
  z.object({
    kind: z.literal("git_oids"),
    start_oid: z.string().regex(GIT_OID),
    end_oid: z.string().regex(GIT_OID).nullable(),
  }),
]);
export type SnapshotRef = z.infer<typeof SnapshotRefSchema>;
