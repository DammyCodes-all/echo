import { cn } from "../lib/utils";

const base =
  "inline-flex items-center gap-2 rounded-dusk-pill whitespace-nowrap px-5 py-2.5 text-[15px] font-semibold transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.97]";

function SoonPill({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "rounded-dusk-pill px-1.5 py-0.5 font-mono text-[9.5px] tracking-[0.14em] uppercase",
        className,
      )}
    >
      soon
    </span>
  );
}

// TODO(demo-link): replace href with the 3-minute demo video URL when the cut lands.
export function DemoVideoLink({ className }: { className?: string }) {
  return (
    <a
      href="#close"
      title="TODO(demo-link): demo video URL lands with the cut"
      className={cn(base, "bg-dusk-accent text-dusk-base hover:bg-[#4A97FF]", className)}
    >
      Watch the 3-minute demo
      <SoonPill className="bg-dusk-base/25 text-dusk-base" />
    </a>
  );
}

// TODO(demo-link): replace href with the hosted read-only demo URL when it deploys.
export function HostedDemoLink({ className }: { className?: string }) {
  return (
    <a
      href="#close"
      title="TODO(demo-link): hosted demo URL lands with the deploy"
      className={cn(
        base,
        "border border-dusk-hairline-strong bg-dusk-secondary text-dusk-accent-soft hover:border-dusk-accent",
        className,
      )}
    >
      Try the hosted demo
      <SoonPill className="bg-dusk-pill text-dusk-accent-soft" />
    </a>
  );
}
