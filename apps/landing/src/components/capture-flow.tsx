import { GitBranchIcon, ScrollTextIcon, WebhookIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { EchoMark } from "./echo-mark";
import { FlowBeams } from "./ui/flow-beams";

const SOURCES = [
  {
    id: "log",
    icon: ScrollTextIcon,
    title: "Muse Code native log",
    detail: "session.jsonl · tool calls, approvals",
  },
  {
    id: "hooks",
    icon: WebhookIcon,
    title: "Lifecycle hooks",
    detail: "PreToolUse · PostToolUse · SessionEnd",
  },
  {
    id: "snap",
    icon: GitBranchIcon,
    title: "Shadow-Git snapshots",
    detail: "baseline · around-tool · final reconciliation",
  },
] as const;

export function CaptureFlow() {
  return (
    <div className="w-full select-none">
      <div className="rounded-dusk-card border border-dusk-hairline bg-dusk-surface p-5 sm:p-6">
        <div className="flex flex-col items-center gap-5 sm:flex-row sm:justify-center sm:gap-6 md:justify-between lg:gap-8">
          <div className="flex w-full max-w-105 flex-col gap-3">
            {SOURCES.map(({ id, icon, title, detail }) => (
              <div
                key={id}
                className="flex h-18 items-center gap-3 rounded-dusk-swatch border border-dusk-hairline-strong bg-dusk-secondary px-4"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-dusk-code bg-dusk-base text-dusk-accent-soft">
                  <HugeiconsIcon icon={icon} size={16} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-dusk-ink">{title}</span>
                  <span className="block truncate font-mono text-[9.5px] leading-snug text-dusk-muted">
                    {detail}
                  </span>
                </span>
              </div>
            ))}
          </div>

          <FlowBeams />

          <div className="flex flex-row items-center gap-4 sm:flex-col sm:gap-2">
            <div className="flex h-16 w-16 items-center justify-center rounded-dusk-uncertainty border border-dusk-accent/40 bg-dusk-base shadow-dusk-fill md:h-20 md:w-20">
              <EchoMark className="h-8 w-8 md:h-10 md:w-10" />
            </div>
            <p className="font-mono text-[10px] tracking-[0.14em] text-dusk-accent-soft uppercase">
              redacted tape
            </p>
          </div>
        </div>
      </div>
      <p className="mt-3 text-center font-mono text-[10.5px] text-dusk-muted">
        every input passes the redaction gate before it touches storage — including model requests
      </p>
    </div>
  );
}
