import { z } from "zod";

export const EchoConfigSchema = z.object({
  projects: z.array(z.string()).default([]),
  opencode_db: z.string().nullable().default(null),
  poll_interval_ms: z.number().int().min(250).default(3_000),
});
export type EchoConfig = z.infer<typeof EchoConfigSchema>;
