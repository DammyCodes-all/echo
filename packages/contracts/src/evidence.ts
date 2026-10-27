import { z } from "zod";

export const EvidenceLabelSchema = z.enum(["observed", "agent_stated", "uncertain"]);
export type EvidenceLabel = z.infer<typeof EvidenceLabelSchema>;

export const EvidenceSourceKindSchema = z.enum([
  "observed",
  "agent_stated",
  "snapshot",
  "diagnostic",
]);
export type EvidenceSourceKind = z.infer<typeof EvidenceSourceKindSchema>;
