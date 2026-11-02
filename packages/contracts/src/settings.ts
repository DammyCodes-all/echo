import { z } from "zod";

/** Capture-hook presence per Muse settings file; `installed` is true only when every event carries an Echo entry. */
export const HooksStatusSchema = z.object({
  settingsPath: z.string(),
  totalEvents: z.number().int().min(0),
  eventsInstalled: z.array(z.string()),
  installed: z.boolean(),
});
export type HooksStatus = z.infer<typeof HooksStatusSchema>;

/** Everything the settings page needs in one round trip: enabled repo paths plus hook presence. */
export const SettingsGetResponseSchema = z.object({
  projects: z.array(z.string()),
  hooks: HooksStatusSchema,
});
export type SettingsGetResponse = z.infer<typeof SettingsGetResponseSchema>;

export const HooksInstallResponseSchema = z.object({
  settingsPath: z.string(),
  changed: z.boolean(),
  backupPath: z.string().nullable(),
  eventsInstalled: z.array(z.string()),
});
export type HooksInstallResponse = z.infer<typeof HooksInstallResponseSchema>;

export const ProjectEnableRequestSchema = z.object({
  path: z.string().trim().min(1).max(1024),
});
export type ProjectEnableRequest = z.infer<typeof ProjectEnableRequestSchema>;

export const ProjectEnableResponseSchema = z.object({
  path: z.string(),
  projectId: z.string(),
});
export type ProjectEnableResponse = z.infer<typeof ProjectEnableResponseSchema>;

export const ProjectDisableRequestSchema = z.object({
  path: z.string().trim().min(1).max(1024),
});
export type ProjectDisableRequest = z.infer<typeof ProjectDisableRequestSchema>;

export const ProjectDisableResponseSchema = z.object({
  path: z.string(),
  removed: z.boolean(),
});
export type ProjectDisableResponse = z.infer<typeof ProjectDisableResponseSchema>;

export const FolderResolveQuerySchema = z.object({
  /** Folder name from the native picker — a single segment, never a path. */
  name: z.string().trim().min(1).max(256),
});
export type FolderResolveQuery = z.infer<typeof FolderResolveQuerySchema>;

export const FolderResolveResponseSchema = z.object({
  name: z.string(),
  matches: z.array(z.string()),
  truncated: z.boolean(),
});
export type FolderResolveResponse = z.infer<typeof FolderResolveResponseSchema>;
