import { MotionConfig } from "motion/react";

import { Close } from "./components/close";
import { Hero } from "./components/hero";
import { Loop } from "./components/loop";
import { SiteFooter } from "./components/site-footer";
import { SiteNav } from "./components/site-nav";

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen bg-dusk-base text-dusk-ink antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-dusk-pill focus:bg-dusk-accent focus:px-4 focus:py-2 focus:text-dusk-base"
        >
          Skip to content
        </a>
        <div className="mesh" aria-hidden="true" />

        <SiteNav />

        <main id="main">
          <Hero />
          <Loop />
          <Close />
        </main>

        <SiteFooter />
      </div>
    </MotionConfig>
  );
}
