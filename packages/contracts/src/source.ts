import { z } from "zod";

export const AgentIdSchema = z.enum(["muse", "opencode"]);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const EventOriginSchema = z.enum(["live", "export", "import"]);
export type EventOrigin = z.infer<typeof EventOriginSchema>;

export const TapeSourceSchema = z.object({
  agent: AgentIdSchema,
  adapter: z.string().min(1),
  adapter_version: z.string().min(1),
  build: z.string().nullable(),
  schema: z.string().nullable(),
  record_type: z.string().nullable(),
  payload_type: z.string().nullable(),
  sequence: z.number().int().nullable(),
  durability: z.string().nullable(),
  origin: EventOriginSchema,
});
export type TapeSource = z.infer<typeof TapeSourceSchema>;
