import { BookOpen01Icon, DashboardSquare01Icon, Structure01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

export const PROJECT_SECTIONS = ["overview", "learn", "architecture"] as const;

const ITEMS = [
  { section: PROJECT_SECTIONS[0], label: "Overview", icon: DashboardSquare01Icon },
  { section: PROJECT_SECTIONS[1], label: "Learn", icon: BookOpen01Icon },
  { section: PROJECT_SECTIONS[2], label: "Architecture", icon: Structure01Icon },
] as const;

export function ProjectNavPill({ projectId, active }: { projectId: string; active: number }) {
  const navigate = useNavigate();
  const navRef = useRef<HTMLElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [frame, setFrame] = useState({ left: 0, top: 0, width: 0, height: 0 });

  const go = (index: number) => {
    const item = ITEMS[index];
    if (item) navigate(`/projects/${projectId}/${item.section}`);
  };

  // Animate-UI-style sliding indicator: measure the active tab and glide to it.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const el = itemRefs.current[active];
    if (!nav || !el) return;
    const place = () => {
      setFrame({
        left: el.offsetLeft,
        top: el.offsetTop,
        width: el.offsetWidth,
        height: el.offsetHeight,
      });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(nav);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);

  return (
    <div className="fixed right-6 bottom-6 z-50">
      <nav
        ref={navRef}
        aria-label="Project sections"
        className="relative flex items-center gap-0.5 rounded-dusk-pill border border-dusk-hairline-strong bg-dusk-surface/90 p-1 shadow-lg backdrop-blur"
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
          event.preventDefault();
          const next =
            (active + (event.key === "ArrowRight" ? 1 : -1) + ITEMS.length) % ITEMS.length;
          go(next);
        }}
      >
        <span
          aria-hidden
          className="absolute rounded-dusk-pill bg-dusk-accent transition-[left,top,width,height,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
          style={{
            left: frame.left,
            top: frame.top,
            width: frame.width,
            height: frame.height,
            opacity: active >= 0 && frame.width > 0 ? 1 : 0,
          }}
        />
        {ITEMS.map((item, index) => {
          const isActive = index === active;
          return (
            <button
              key={item.section}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              aria-label={item.label}
              aria-current={isActive ? "page" : undefined}
              onClick={() => go(index)}
              className={`group relative z-10 flex cursor-pointer items-center gap-1.5 rounded-dusk-pill px-3 py-1.5 text-[13px] transition-colors duration-200 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent ${
                isActive ? "font-semibold text-dusk-base" : "text-dusk-muted hover:text-dusk-ink"
              }`}
            >
              <span
                aria-hidden
                className={`inline-flex transition-transform duration-200 ease-out group-active:scale-90 ${
                  isActive ? "-translate-y-px scale-105" : "group-hover:-translate-y-px"
                }`}
              >
                <HugeiconsIcon icon={item.icon} size={15} strokeWidth={1.8} />
              </span>
              {item.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
