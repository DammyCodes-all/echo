# Echo Design Direction — Direction A, Dusk Dark

Status: confirmed direction for the replay/review UI. Source is a reference
mockup, not production code: `Direction A, Dusk Dark with Graphite Blue
type-html.zip` (`Dusk.dc.html`, artboard 560x1020). Values below replicate the
mockup's inline styles; implementation re-expresses them in Echo components.

## 1. Feel

Echo reads like a thoughtful teammate who watched your agent work and is now
explaining it patiently. Soft and attentive, never stiff. The product is about
understanding, so the design lowers your shoulders.

How Direction A carries this:

- Deep indigo page (`#12121F`) with a lifted card surface (`#1C1C30`) and
  low-contrast hairlines (`rgba(255,255,255,0.06)`). Calm before chrome.
- Large patient headings (28px card title, 46px display, both weight 500 with
  tight negative tracking) over small muted explainers (`17px/1.45 #A6A6C4`).
- Everything important is a rounded, breathing shape: cards `28px`, code pill
  `10px`, uncertainty `22px`, actions/confidence `999px`. No sharp tables.
- Glow is reserved for "where you are" and "how sure": the active timeline
  node and the 75% confidence fill share the `#8C9BFF` glow. Nothing else
  glows.

## 2. Voice

Copy sounds like it is on your side. `I could not find evidence for that, so I
will not guess` beats `No results`. Refusals, empty states and errors are where
the friendly feeling is won or lost.

Rules:

- Refusal is first-class and friendly: full sentence, states the limit,
  no blame. Mockup line is canonical:
  `I could not find evidence for that, so I will not guess.`
- `Fairly sure` + `3 of 4 checks passed`, not a hard percentage headline.
- Dead ends are narrated gently: `Session timeline. The dashed circle was a
  dead end.`
- Uncertainty is dashed, never red: `1.5px dashed #3E3E5C` container.

## 3. Echo-specific pieces → Direction A components

| Echo piece | Direction A component | Tokens / behavior |
| --- | --- | --- |
| Session timeline | Flowing rail `2px #2E2E4A` with nodes, not a table of rows | Nodes: `12px #EEEEFA` landed, `14px` dashed `1.5px #8A8AB0` on `#12121F` dead end, `20px #8C9BFF` active with `0 0 0 7px rgba(140,155,255,0.24), 0 0 22px rgba(140,155,255,0.5)` |
| Dead-end tree | Dashed abandoned node beside the path that shipped | Pencil-sketch language: dashed ring, muted caption `13px #A6A6C4`; node counts as dead end only if the recorded sequence or agent-stated text supports it (spec §2) |
| Confidence calibration | Soft glow band, not a hard percentage bar | Track `10px 999px #26263F`, fill `75% #8C9BFF` with `0 0 16px rgba(140,155,255,0.5)`; label `Fairly sure`, sub `3 of 4 checks passed` |
| Evidence chips | Visible links back to exact session moments under every why | `6px 12px 999px #2A2A4C / #C9CEFF 14px`: `turn 14`, `auth.ts`; file chip pairs with `src/auth.ts +24 #6FD99A / -3 #FF8A8A` in `JetBrains Mono 14px` on `#2A2A4C radius 10px` |
| Understanding checks | Conversational cards, never quiz-show | `Here is what happened` card: `bg #1C1C30, 1px rgba(255,255,255,0.06), 28px, 26px 24px, gap 10px`; status pills `rgba(111,217,154,0.14)/#6FD99A 3 passed`, `rgba(255,138,138,0.14)/#FF8A8A 1 failed`, 8px dot |
| Refusal state | Friendly dashed container | `1.5px dashed #3E3E5C, 22px, 20px 22px, 17px/1.4 #EEEEFA` |

Actions: primary `bg #8C9BFF color #12121F`, secondary `bg #26264A color
#C9CEFF`, both `15px 22px, 999px, 16px 600`. Primary moves forward
(`Show me why`); secondary replays (`Replay session`).

## 4. Tokens

Code source: `apps/web/src/design-tokens.ts` (`duskDarkTokens`). CSS
variables in `apps/web/src/styles.css` under `@theme` (`--color-dusk-*`,
`--font-sans`, `--font-mono`).

Palette: `#12121F` base · `#1C1C30` surface · `#2A2A4C` pill ·
`#26264A` secondary · `#26263F` track · `#EEEEFA` ink · `#A6A6C4` muted ·
`#8C9BFF` accent · `#C9CEFF` accent-soft text · `#FFB38A` peach (swatch-only
for now) · `#6FD99A` pass · `#FF8A8A` fail · `#8A8AB0` dead end ·
`#2E2E4A` rail · `#3E3E5C` dashed border.

Type: `Plus Jakarta Sans 400/500/600` UI, `JetBrains Mono 400/500` code.
Eyebrow `13px ls 0.14em #A6A6C4`; display `46/1.1 500 ls -0.02em`; card title
`28 500 ls -0.01em`; body `17/1.45`; answer `19/1.45 500`; question `15px`;
meta `14px`; caption `11px` (palette labels).

Shape: card `28`, swatch `46px h / 14`, code `10`, uncertainty `22`, pill
`999`. Page `36` padding, stack `20` gap.

Do not invent new accent colors. Peach stays reserved until a real highlight
use lands. Status colors never carry body copy.

## 5. Application notes

- Replay, hunk inspector, Q&A, checks and report all sit on base/surface with
  muted secondary text. Accent glow appears at most twice per viewport
  (position + confidence).
- `agent_stated` vs `observed` labels (spec §3) inherit the evidence-chip
  style; `uncertain` links use the dashed treatment.
- Import direction holds: `web` consumes `@echo/contracts` types only;
  tokens live in `web` and never leak into `packages/*`.
