# Surface: apps/landing

Visitor: developers driving CLI coding agents daily, cold from a hackathon link.
Mode: Persuade. Action: click to the demo (placeholder until the cut) or GitHub.

## Direction contract (revision 3 — final, app-consistent)

THESIS: The landing is a static window into the product's own world, not a separate
identity. Echo's design system (Dusk Dark, apps/web/src/styles.css @theme) is copied
verbatim, never reinvented: no landing-only palette, no landing-only radii, no glow
beyond the app's reserved accent glow.

OWN-WORLD: dusk-base #12121F ground, dusk-surface #1C1C30 cards, dusk-pill #2A2A4C and
dusk-secondary #26264A fills, dusk-rail #2E2E4A rails, dusk-faint #3E3E5C dashed
uncertainty, dusk-deadend #8A8AB0 dashed dead-ends, dusk-ink #EEEEFA, dusk-muted #A6A6C4,
Meta blue dusk-accent #2D88FF (accent-soft #A9CFFF), pass #6FD99A / fail #FF8A8A washes,
hairlines rgba(255,255,255,.06/.12). Plus Jakarta Sans 400/500/600, JetBrains Mono for
code/data. Radii: card 28, swatch 14, uncertainty 22, code 10, pill 999. Glow reserved
for the accent beam on the story card (one per viewport).

STORY: visitor sees the product doing its job in the hero (the wide behaviour card with
code/why/check panels), believes verification is computed, and clicks to the repo/demo.

STRUCTURE (three sections max, one continuous tape): Hero — full-width poster headline,
lede + CTAs inline beneath, the behaviour card stretched wide below the fold line.
"The loop." — a vertical rail threads Record → Story → Check → Refusal (dashed node),
capture-beam diagram inside Record, evidence footnote at the end of the rail.
"Built in six days." — off-axis split: giant left statement, CTA stack right.

FORM: static Vite + React + Tailwind v4, zero @echo/* imports, output dist/ for any
static host. FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, and every shipping raster carrying its provenance.
