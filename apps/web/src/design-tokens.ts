/**
 * Mirror of the canonical tokens in `styles.css` (`@theme`) for JS use
 * (canvas, d3 attempt tree, charts). CSS is the source of truth; keep the
 * values in sync. See `docs/design-direction.md`.
 *
 * Source mockup: `Downloads/Direction A, Dusk Dark with Graphite Blue
 * type-html.zip` (`Dusk.dc.html` artboard, 560x1020).
 */
export const duskDarkTokens = {
  color: {
    /** Page background, text on primary accent. */
    base: "#12121F",
    /** Card surface. */
    surface: "#1C1C30",
    /** Evidence/meta pill fill. */
    pill: "#2A2A4C",
    /** Secondary button fill. */
    secondary: "#26264A",
    /** Confidence track fill. */
    track: "#26263F",
    /** Timeline rail. */
    rail: "#2E2E4A",
    /** Uncertainty dashed border. */
    dashedBorder: "#3E3E5C",
    /** Dead-end dashed ring. */
    deadEnd: "#8A8AB0",
    /** Primary text. */
    ink: "#EEEEFA",
    /** Secondary text, captions, labels. */
    muted: "#A6A6C4",
    /** Primary accent (Meta blue): CTAs, active node, confidence fill. */
    accent: "#2D88FF",
    /** Text on secondary fills. */
    accentSoft: "#A9CFFF",
    /** Kept highlight, currently swatch-only. */
    peach: "#FFB38A",
    /** Status pass. */
    pass: "#6FD99A",
    passWash: "rgba(111, 217, 154, 0.14)",
    /** Status fail. */
    fail: "#FF8A8A",
    failWash: "rgba(255, 138, 138, 0.14)",
    /** Accent wash for active/turn chips and selection. */
    accentWash: "rgba(45, 136, 255, 0.14)",
    /** Peach wash for tool chips. */
    peachWash: "rgba(255, 179, 138, 0.14)",
    /** Card hairline on base. */
    hairline: "rgba(255, 255, 255, 0.06)",
    /** Stronger hairline for swatches and control borders. */
    hairlineStrong: "rgba(255, 255, 255, 0.12)",
  },
  font: {
    sans: "'Plus Jakarta Sans', system-ui, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, monospace",
  },
  type: {
    eyebrow: { size: 13, letterSpacing: "0.14em" },
    display: { size: 46, weight: 500, letterSpacing: "-0.02em", lineHeight: 1.1 },
    cardTitle: { size: 28, weight: 500, letterSpacing: "-0.01em" },
    body: { size: 17, lineHeight: 1.45 },
    answer: { size: 19, weight: 500, lineHeight: 1.45 },
    question: { size: 15 },
    meta: { size: 14 },
    caption: { size: 11 },
  },
  radius: {
    card: 28,
    swatch: 14,
    code: 10,
    uncertainty: 22,
    pill: 999,
  },
  border: {
    swatch: "1px solid rgba(255, 255, 255, 0.12)",
    card: "1px solid rgba(255, 255, 255, 0.06)",
    uncertainty: "1.5px dashed #3E3E5C",
    deadEnd: "1.5px dashed #8A8AB0",
  },
  shadow: {
    activeNode: "0 0 0 7px rgba(45, 136, 255, 0.24), 0 0 22px rgba(45, 136, 255, 0.5)",
    confidenceFill: "0 0 16px rgba(45, 136, 255, 0.5)",
  },
  layout: {
    artboardWidth: 560,
    pagePadding: 36,
    stackGap: 20,
    cardPadding: { primary: "26px 24px", secondary: "24px" },
    buttonPadding: "15px 22px",
  },
} as const;

export type DuskDarkTokens = typeof duskDarkTokens;
