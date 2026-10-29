import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

export type ExpandDirection = "left" | "right";

interface ExpandableSearchProps {
  expandDirection?: ExpandDirection;
  placeholder?: string;
  onSearch?: (query: string) => void;
  className?: string;
  defaultOpen?: boolean;
  width?: number;
}

const COLLAPSED = 40;

/**
 * Expandable search, adapted from 21st's `arunachalam/expandable-search-bar`
 * (framer-motion + lucide + shadcn tokens replaced with a CSS width
 * transition, HugeIcons, and Dusk tokens — no new dependencies).
 * Collapsed it is a bare icon like the settings gear; expanding left keeps
 * the header cluster's right edge fixed. Enter submits, Escape closes and
 * clears, an outside press collapses an empty bar.
 */
export function ExpandableSearch({
  expandDirection = "left",
  placeholder = "Search by name, path, or remote…",
  onSearch,
  className,
  defaultOpen = false,
  width = 200,
}: ExpandableSearchProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [value, setValue] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const left = expandDirection === "left";

  // An outside press collapses an empty bar; a typed query keeps it open.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node) && value === "") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, value]);

  // Autofocus on expand; clear on collapse.
  useEffect(() => {
    if (!open) {
      setValue("");
      return;
    }
    const id = window.setTimeout(() => inputRef.current?.focus(), 120);
    return () => window.clearTimeout(id);
  }, [open]);

  // Escape closes and clears from anywhere while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setValue("");
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSearch?.(value);
  }

  return (
    <div
      ref={containerRef}
      className={["es-root", className].filter(Boolean).join(" ")}
      data-open={open || undefined}
      data-dir={expandDirection}
      style={{ width: open ? width : COLLAPSED }}
    >
      <style>{SEARCH_CSS}</style>
      <form
        className="es-bar"
        data-open={open || undefined}
        onSubmit={onSubmit}
        aria-label="Site search"
      >
        <span className="es-lead" aria-hidden="true">
          <HugeiconsIcon icon={Search01Icon} size={16} strokeWidth={1.8} />
        </span>
        <div className="es-field">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            aria-label="Search projects"
            autoComplete="off"
            tabIndex={open ? 0 : -1}
            className="es-input"
          />
          <span className="es-hint" aria-hidden="true" data-empty={value === "" || undefined}>
            {placeholder}
          </span>
        </div>
        <button
          type="submit"
          aria-label="Search"
          tabIndex={open ? 0 : -1}
          className="es-go"
          data-open={open || undefined}
        >
          <HugeiconsIcon icon={Search01Icon} size={16} strokeWidth={1.8} />
        </button>
      </form>
      <button
        type="button"
        aria-label={open ? "Close search" : "Open search"}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={["es-toggle", left ? "es-toggle-right" : "es-toggle-left"].join(" ")}
      >
        <HugeiconsIcon icon={open ? Cancel01Icon : Search01Icon} size={18} strokeWidth={1.8} />
      </button>
    </div>
  );
}

/**
 * Header wiring: the submitted query becomes the `?q=` filter on the home
 * page (navigating there when elsewhere); Escape on the home page also clears
 * the filter, elsewhere it only closes the bar.
 */
export function HeaderSearch({ className }: { className?: string }) {
  const [, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [seed, setSeed] = useState(0);

  function applySearch(query: string): void {
    const trimmed = query.trim();
    if (location.pathname === "/") {
      setSearchParams(trimmed === "" ? {} : { q: trimmed }, { replace: true });
    } else if (trimmed !== "") {
      navigate(`/?q=${encodeURIComponent(trimmed)}`);
    }
  }

  return (
    <ExpandableSearch
      key={seed}
      expandDirection="left"
      width={200}
      className={className}
      onSearch={(query) => {
        applySearch(query);
        setSeed((n) => n + 1);
      }}
    />
  );
}

const SEARCH_CSS = `
.es-root {
  --es-ease: cubic-bezier(.32,.72,0,1);
  position: relative;
  display: inline-block;
  flex: none;
  height: 40px;
  transition: width .28s var(--es-ease);
}
.es-bar {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  overflow: hidden;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-dusk-ink);
  transition:
    width .28s var(--es-ease),
    background-color .2s ease-out,
    border-color .2s ease-out;
}
.es-root[data-open] .es-bar {
  background: rgba(38, 38, 74, 0.85);
  border-color: rgba(255, 255, 255, 0.1);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
}
.es-lead {
  flex: none;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  color: var(--color-dusk-muted);
  opacity: 0;
  transition: opacity .18s ease-out;
}
.es-root[data-open] .es-lead { opacity: 1; }
.es-root[data-dir="left"] .es-lead { order: 0; }
.es-field {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  opacity: 0;
  transition: opacity .18s ease-out .04s;
}
.es-root[data-open] .es-field { opacity: 1; }
.es-input {
  width: 100%;
  background: transparent;
  font-size: 14px;
  color: var(--color-dusk-ink);
  outline: none;
}
.es-input::placeholder { color: transparent; }
.es-hint {
  pointer-events: none;
  user-select: none;
  position: absolute;
  left: 0;
  right: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 14px;
  color: var(--color-dusk-muted);
  opacity: 0;
  transform: translateX(8px);
  transition: opacity .2s ease-out, transform .2s ease-out;
}
.es-hint[data-empty] { opacity: .9; transform: none; }
.es-go {
  flex: none;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  color: var(--color-dusk-muted);
  cursor: pointer;
  opacity: 0;
  transform: scale(.8);
  transition: opacity .15s ease-out, transform .15s ease-out, color .15s ease-out;
}
.es-go[data-open] { opacity: 1; transform: none; }
.es-go:hover { color: var(--color-dusk-ink); }
.es-toggle {
  position: absolute;
  top: 0;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 999px;
  color: var(--color-dusk-muted);
  cursor: pointer;
  transition: color .15s ease-out, transform .15s ease-out;
}
.es-toggle:hover { color: var(--color-dusk-ink); }
.es-toggle-right { right: 0; }
.es-toggle-left { left: 0; }
@media (prefers-reduced-motion: reduce) {
  .es-root, .es-root *, .es-bar, .es-bar * { transition-duration: 0s !important; }
}
html[data-echo-motion="reduced"] .es-root,
html[data-echo-motion="reduced"] .es-root * {
  transition-duration: 0s !important;
}
`;
