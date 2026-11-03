import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import PierreDiffWorker from "@pierre/diffs/worker/worker.js?worker";
import type { ReactNode } from "react";

/**
 * Off-thread Shiki highlighting for every diff surface below it. Mount once
 * high in the tree: the pool is a module-wide singleton shared by nested
 * providers, and the last unmount terminates it — so a single app-lifetime
 * instance keeps workers and highlight caches alive across navigation.
 *
 * With a pool present, diffs paint as plain text immediately and highlighted
 * output streams in from workers (the sanctioned pattern per Pierre's
 * "On Rendering Diffs"), so no loading placeholder is needed.
 */
const HIGHLIGHT_LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "jsonc",
  "markdown",
  "css",
  "html",
  "bash",
  "yaml",
  "toml",
  "diff",
  "python",
] as const;

export function DiffWorkerProvider({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider
      poolOptions={{
        poolSize: 4,
        workerFactory: () => new PierreDiffWorker(),
      }}
      highlighterOptions={{
        langs: [...HIGHLIGHT_LANGS],
        theme: { light: "pierre-light", dark: "pierre-dark" },
      }}
    >
      {children}
    </WorkerPoolContextProvider>
  );
}
