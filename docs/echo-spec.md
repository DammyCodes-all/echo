# Echo: Product Spec

One minute after opening a session, say what shipped, where it deviates from what you asked, and what could bite you.

Built for the Meta Global AI Developer Hackathon 2026 (Oct 26 to Nov 4). Solo entry, Indie Developer track, Build for Your World theme.

Status: draft v4, updated Oct 28, 2026. Story-first redesign. The forensic replay UI (timeline / file-state / alphabetical diff / hunks) is deleted for now; a session/evidence viewer may return later. This spec replaces all replay/check/report-page language in earlier drafts. Where old text conflicts with the decisions below, the decisions below win — no compatibility hedges.

---

## 1. Problem

Developers now ship code written by agents they can't fully verify or reproduce alone. You come back after lunch and the agent has touched 40 files. Reading all of it would take longer than writing it, so you approve. Generation stopped being the bottleneck a while ago. Trust is.

Two things are missing at that moment. A diff shows what changed, but nothing shows what shipped versus what you asked, in plain terms, in a minute. And nothing checks whether you actually understood the risky parts, which matters because people who lean on AI tend to feel they learned things they didn't.

I know both from my own work. I build by driving coding agents most days, and I approve diffs I haven't fully read. So does every developer I know.

The evidence on trust and review:

- The 2025 Stack Overflow survey (33,662 responses) found 46% of developers distrust AI accuracy against 33% who trust it. 66% say the output is "almost right, but not quite," and 45% say debugging it takes longer.
- DORA's 2025 report (about 5,000 respondents) found 90% adoption and 30% with little or no trust, with higher throughput alongside higher delivery instability.
- METR's 2025 randomized trial had 16 experienced open-source developers take 19% longer with AI on 246 real issues, while believing they were 20% faster.
- Perry et al. (ACM CCS 2023, 47 participants, five tasks) found the AI-assisted group wrote insecure code more often on four of five tasks and was more likely to believe the code was secure.
- Cisco's 2,500-review study found defect detection falls sharply above 200 to 250 lines of code. Agent diffs routinely exceed that.
- Bacchelli and Bird (ICSE 2013, 17 teams at Microsoft) found that understanding the change and its context is the central challenge in code review, and that tools don't meet it.

The evidence on understanding:

- A 2025 Wharton and Penn field experiment in PNAS gave nearly a thousand high-school students GPT-4 during math practice. Practice grades rose 48% with plain chat and 127% with a version built with learning safeguards. On the later exam without AI, the plain group scored 17% worse than students who never had AI. The safeguarded group only matched them. The plain group believed they had learned as much as everyone else.
- A 2026 randomized trial with 52 mostly-junior developers learning the Trio library found the AI-assisted group scored about 17% lower on a retention quiz. I read secondary coverage of that study, not the paper.

None of this measures Echo directly. METR studied experienced developers in familiar repositories with early-2025 tools. Perry is a 2023 lab study. Cisco is a 2006 single-company case study, and Bacchelli is 2013 and Microsoft-specific. The learning results come from students and juniors, and the PNAS study is about math. The submission should say all of this plainly.

Existing tools cover pieces. Agent observability tools (LangSmith, Langfuse, Grafana agent tracing) trace API calls for teams. Atrophy runs generic drills, and coding agents now ship Study Mode and explanatory modes. The Oct 26 documentation check also confirms that Muse Code already supplies session logs and an audit/export workflow; Claude Code, OpenCode and Codex expose related capture paths. Third-party tools already read Muse Code's session history too: SpecStory saves Muse sessions as Markdown, and ranwhat audits what coding agents ran. Recording actions is not Echo's novelty. As of the product searches behind the earlier specs (Oct 25), I found nothing combining a post-session comprehension story for one diff with evidence-backed questions about it. That is not an exhaustive or current market claim.

## 2. Who it is for, and who pays

The reader is a developer reviewing their OWN session, same day preferred, and it must still work cold days later. This is not an approval gate and not team review in v1. No proof for others, no shared grades, no manager view.

The first users are solo developers, students and juniors who drive CLI coding agents daily (Muse Code, OpenCode). They feel this already and need no convincing. I'm the first user, so the first sessions to record are mine.

Later buyers are engineering teams and regulated shops that must audit agent-written changes ("who approved this line, and on what basis?" is already a compliance question), and universities and bootcamps that need to know whether AI-assisted coursework teaches anything. Team views would be opt-in aggregates. The individual sees their own data first. None of that is v1.

## 3. Core idea

Echo turns a finished coding-agent session into a short comprehension story, then checks calibration on the risky parts — never as a gate or a grade.

It is one loop in two halves. The story half says what shipped and what could bite. The check half shows the developer where their confidence doesn't match reality. The story without the check leaves nodding along; the check without the story has nothing real to ask about.

### Core promise

One minute after opening a session, the developer can state three things: what shipped, where it deviates from what they asked, and what could bite them.

### What it is not

- Not forensic replay. No timeline scrubbing, no file-state-at-a-moment, no alphabetical diff, no hunk list. That UI is deleted for now.
- Not an approval gate. Nothing blocks merging, shipping, or closing the session.
- Not team review. No shared reports, no export, no proof for others in v1.
- Not a tutor. It explains only this session, only from its tape.

### Evidence, not intent

An action history is not a guaranteed record of reasoning. Echo distinguishes the explanation the agent actually wrote from the actions and results the recorder observed. "The test failed, then the agent edited this function" is evidence of a sequence, not proof of why it made that edit. Inference is never presented as the agent's reasoning. When the tape has nothing relevant, the answer is "not on the tape."

Muse Code documents an optional `show_reasoning` setting that puts reasoning text into the transcript, off by default. Echo does not depend on it. If readable explanation or reasoning text is actually captured, Echo can quote it as **agent-stated**, not as a complete or faithful account of private reasoning. Whether that text survives export in a usable form still needs a real-session test. Opaque or encrypted reasoning payloads are not usable explanation evidence and are excluded from Echo's tape.

Non-observed content is labeled **agent-stated** or **uncertain** everywhere it appears — in the story and on the cards. Observed content is unmarked. Verification and risk are never model-asserted (see the trust model below).

### Capture/input path

Echo records the normal interactive agent session. It does not need to replace the agent's interface or run tasks through a headless SDK. The primary input is the agent's native structured activity record, not text scraped from the terminal.

Ingestion is automatic. There is no import button and no manual step. An in-progress session shows as still-recording; the story generates at finalization.

Honest support status for v1 (no agnosticism claims yet):

- **Muse Code:** reader verified on real saved logs, not on a live run. Live-run capture, checkpoint trimming behaviour, and recovery still need testing before promising complete history.
- **OpenCode:** capture exists but is partial (live event stream has no replay of missed events and no automatic reconnection; recording needs its own recovery path).
- Agent-agnostic readers come later. V1 claims Muse Code + OpenCode only.

There are three complementary inputs:

1. **Native session records: what was requested and what came back.** Muse Code documents an event log containing model calls, tool calls and results, and approval decisions, plus a structured trajectory export. Echo reads those records for attributable conversation and action evidence. It preserves source sequence numbers, session and tool IDs, build/schema metadata, and reported gaps or unknown outcomes. Parent/child identifiers stay attached when present.
2. **Lifecycle hooks: when to capture file state.** Muse Code exposes hooks such as `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `SessionStart` and `SessionEnd` for ordinary interactive use. Echo uses them to trigger before/after snapshots around relevant tools or committed batches. Hooks observe the run rather than block actions or rewrite tool inputs/results. They are not a complete transcript: payload limits and preview-only fields mean they must be combined with native records.
3. **Independent file versions: what actually changed.** Capture a baseline, action-aware snapshots, filesystem changes outside the obvious edit-tool path, and a final reconciliation. Store sanitized versions in a shadow git repo without changing the developer's Git history or index. A recorded tool request is not proof that its intended edit landed; a failed tool may have written part of a file, and a shell command may change many files.

Muse's documented default log path is `~/.local/share/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl`, with child logs under `subagent/<child-id>/`. Each line has an envelope containing `sequence`, `recorded_at`, `record_type`, `durability`, `payload_type` and `payload`. The envelope fields, hooks and settings described here still rest on the Oct 26 documentation check plus later real-log reads, not a live run.

The agent reader converts these inputs into Echo's common tape format: JSONL events plus snapshot references and capture diagnostics. Link records and snapshots through supported identifiers where possible. A nearby timestamp alone is not proof that one event caused another, and concurrent streams do not acquire a reliable global order just by sorting their clocks.

Terminal recording through a PTY is not part of the product. Native records and file snapshots also do not guarantee every intermediate state. A rapid edit-and-revert inside one shell command can escape snapshots, and background writes can have uncertain attribution. The story shows what was captured and names known gaps; it never invents a continuous history.

**Redaction covers Echo's storage, not every file on the machine.** Scrub inputs locally before writing Echo's tape, snapshot Git objects/index, caches or spool files, and again before model requests. Do not write a raw export as an intermediate Echo artifact. Muse's own native logs can already contain raw secrets; its `--redacted` export cleans the exported copy after native logging, not the original log. Disclose that separate storage surface and show a masked redaction preview. A stronger mode that suppresses native logging needs a separate capture/privacy test and is not assumed here.

### Projects and sessions

Each repository is a project with its own workspace. Echo identifies a project by its repo root (and its Git remote, if there is one) and stores every recorded session for that repo under it. Tapes never mix between projects.

There is exactly one story per session, even for multi-topic sessions.

### Landing: the triage inbox

The landing page is the most recently active project, shown as a triage inbox. Strict newest-first ordering. Each row carries a one-line plain summary, a status, and a high-risk flag or count.

Status semantics:

- **Not checked** — never finished a check. Abandoning a check mid-way leaves Not checked; resuming picks up where it left off.
- **Checked** — finished a check, regardless of outcome. There is no pass/fail.
- **Skipped** — explicitly skipped, by the Skip control at the offer or mid-check. The display label is "Skipped", never "unchecked".

Checked and Skipped both clear the inbox. No-change sessions (research or answers only, nothing consequential shipped) get an adapted story with no check needed, and clear when opened. If a session resumes after finalization, the story regenerates and check status resets to Not checked.

## 4. The session home: a five-section story

The session home is the story. Closed form reads in about a minute, in this fixed order:

1. **Short version.** What you asked, what shipped, how much is verified. Plain sentences, no scores.
2. **Ask vs result.** What you asked versus what happened, measured against ALL prompts in the session, grouped by prompt cluster. The model's grouping is convenience, not authority. Extras the agent did that were never asked for, and asks that never landed, are labeled **uncertain**.
3. **What changed.** Behaviour cards (below). This is the heart of the story.
4. **Detours.** Only abandoned attempts that touched files and were then reverted, failed with side effects, or took 2+ attempts at the same target. Everything else folds to one line. The full dead-end tree is expandable inline.
5. **Loose ends.** Agent assumptions, TODOs and unfinished work, paths nothing tested. Tape blind spots appear as a separate "Echo couldn't see" line — never merged into the loose ends.

### Change cards

The model extracts and groups behaviour changes from the tape, including consequential non-file actions (migrations run, pushes, deletes). Each card is one behaviour, not one diff hunk.

- **Top 7 by risk; the rest fold** under "N more changes". Only purely mechanical changes (formatting, imports, generated files, lockfiles, internal renames with no API effect) fold into one routine line.
- **Order toggle:** risk order or session order.
- **Risk = blast radius × chance the developer's mental model is wrong.** Auth, payments, stored data, destructive actions, secrets, and production behaviour raise blast radius; unverified changes boost risk. A card's risk is its highest-risk constituent. Every card states its rank reasons in plain words — never a bare score.

Closed card shows: behaviour headline, verification badge, one why-line, one rank-reason line.

Open card shows: before vs now in plain terms; why (marked **agent-stated** where applicable) with a link to the session moment shown INLINE in the card as a session slice; what checked it; what it touches; the developer's own history — prior sessions touching the same code plus the past check picture on that area.

Bottom actions on every card: "Ask why about this", "Check me on this", "Show the code" (inline before/after diff).

No developer editing of grouping in v1.

### Verification badges

Four levels: **observed** / **partly observed** / **agent-stated** / **nothing**. "Verified" counts observed only — agent claims never count. Card badges are strict: the weakest level covering the key behaviour. The Short version's "how much is verified" rolls up from the same deterministic computation.

### Story trust model

The model writes narrative, summary, and grouping freely, BUT a deterministic fact-check layer validates claims (numbers, files, names, verification, risk) against tape facts. Verification and risk are computed deterministically, never model-asserted. A failing claim gets one regeneration; if it still fails it is dropped and replaced by an "Echo couldn't verify this" gap line. Gaps are data, never fabricated.

### Engagement (Echo-side only)

Engagement exists only to target the check and to compute never-looked. It is never shown as a grade.

- **unseen** — card never in view.
- **seen** — closed card in viewport ~1s.
- **engaged** — expanded, Show the code, or Ask why.

Only engaged counts as handled. These signals only nudge check ranking.

## 5. Ask why

One saved thread per session, in a side panel. Opening Ask why from a card attaches that card as context; follow-ups and cross-card questions stay in the same thread. Answers are evidence-grounded with citations to tape moments. When the tape cannot support an answer, it refuses: "not on the tape."

## 6. The understanding check

The check is calibration only. It is never a gate, never a grade, never proof for others. No retakes, no contesting grades in v1. "Waive" is abolished; the only explicit out is Skip.

- **Offered inline** at the end of the story, once What changed has been reached. Full prompt only if the session has ≥1 high-blast change; otherwise a quiet chip. Never modal.
- **Generation:** questions are generated at check start from risk + engagement. 3–5 questions or fewer, never padded to fill a count. If the model is unavailable, the check is unavailable and status is untouched.
- **Selection:** the riskiest changes whether touched or not; unseen/seen high-risk boosted; 1–2 engaged cards as spot checks. Per-card "Check me on this" asks 1 question now; it feeds the session set but alone never changes status.
- **Format chosen per target:** MCQ (key-scored) for consequence/decision; free text (rubric-scored against evidence) for why/teach-back. At least 1 free-text question whenever a high-risk change is in the set.
- **Flow per question:** question shown → confidence locked first (Guessing / Think so / Certain) → options/answer reveal → answer → evidence reveal of what actually happened.
- **End: a picture, not a grade.** Every change card maps to one of: solid (right + confident) / right-but-unsure / confident-but-wrong / wrong-and-knew-it / never-looked. No numeric score is displayed. Gaps in the picture link back to the card, the evidence, and Ask why. Done returns to the inbox.
- **Skip semantics:** explicit Skip (at the offer or mid-check) = Skipped status. Closing or abandoning without Skip leaves Not checked and resumes where left. A per-question "I don't know" counts as an answer, not a skip.

## 7. What makes it different

- The refusal is the trust story. A tool that says "not on the tape" is more believable than a chatbot bolted onto a log viewer.
- It keeps what a final diff can't show: captured attempts the agent made and reverted, folded into Detours rather than a forensic tree.
- Verification is computed, not asserted. The model never stamps its own claims verified; the deterministic layer and the observed-only rule do that job.
- It targets what was skipped. Engagement signals (unseen/seen/engaged) push the check toward the risky cards the developer never opened.
- Muse Code is the subject of the product, not just a tool it calls. Recording a Muse Code session and comprehending it in a minute in front of Meta engineers is the pitch.

A log is raw material, and agent CLIs already provide one. Echo adds a one-minute story, evidence-backed answers with refusals, and calibration checks on the risky changes for one developer questioning one session. That is the answer to "isn't this just the agent's action log?"

## 8. Meta tooling used (rubric: 25%)

Muse Code is the recorded agent in the primary demo tapes. It is a terminal agent in beta for macOS and Linux, which fits my machine. Its native session records and interactive lifecycle hooks are also Echo's primary capture inputs. Meta's audit/export cookbook confirms the documented route; installation, access and capture fidelity on my machine remain partially tested (real logs read; live run not yet).

Muse Spark is the engine: story drafting, behaviour grouping, evidence-grounded answers with citations, and check generation. Muse Spark 1.3 came out on Sept 2, 2026. I need to confirm which version the API exposes to this event and how reliable its structured output is. The deterministic fact-check layer around it (verification/risk computation, claim validation with one-regeneration-then-gap-line) is Echo's own work and does not depend on model self-judgment.

This is a two-model story, and on paper it is the thinner side of the tooling axis. The bet is depth over breadth: Muse Code sits inside the product as its subject, and every claim that matters is either cited to the tape or computed from it. If a third integration fits without feeling bolted on, I'll add it. I won't force one.

The Participant Guide lists more than I had assumed: the Muse Spark series, Muse Wonder, Muse Image, Muse Voice Transcribe and SAM 3.1 through the Meta Model API, the open-weight Muse Glimmer and Muse Spark Open, and Muse Code. The Tooling criterion asks whether I went beyond a basic integration and surfaced capabilities the Meta team didn't expect. One thing would help Echo here: a separate explanation path on Muse Spark Open, served through Baseten (model id `meta-models/muse-spark-open-1026`), would make Echo eligible for the $10,000 open-weights bonus and could keep the tape off Meta's hosted API. That is an open decision in section 12.

Credits: each participant gets $150 in Meta Model API credits, claimed individually by Nov 4, 9 PM ET, and a credit card must be on the account to make calls. Modal ($100, first 1,000 requests), Baseten ($100, reviewed) and Fireworks ($25, shortlisted teams) credits are separate and need their own requests.

Two privacy points I'll state in the submission. Echo is local-first, but local stops at the model call: the retrieved tape segments, which contain source code, go to Meta's API. A review of Muse Spark 1.3 cautions against using it for confidential client code. Echo redacts its own stored evidence, but native agent logs may already hold raw source and secrets; redacting an export does not sanitize those originals. The demo uses only my own repos and a synthetic secret for the redaction example.

## 9. Rubric and event rules

This section comes from the Participant Guide. The 30/25/25/20 weights in my earlier specs were wrong. The real rubric is equal weights.

### How it is judged

Stage 1 is pass/fail: the project reasonably fits a problem statement and reasonably uses the Meta Model API or Meta's open-weight models. Stage 2 scores four equally weighted criteria from 0 to 10 (25% each). The top 5 projects per track go to a live final round, where judges watch the demo videos and rank them on the same rubric. Judging runs Nov 5 to 8, and the closing ceremony is Nov 9. The Indie Developer track pays $400,000 in total, with $150,000 for first place.

- Impact. The real-world potential: who benefits, how much it matters, whether people could actually use it, and whether it fits a problem statement. Every developer using coding agents approves code they can't fully explain, and agent-written code is becoming the default. Echo fits Build for Your World. The continuation path is in section 13.
- Use of Meta AI tooling. How creatively I used Meta's tooling, whether I went beyond a basic integration, and whether I surfaced capabilities the Meta team didn't expect. Muse Code is the product's subject and Muse Spark is its engine. This is the axis to push hardest (see section 8).
- Technical depth and execution. Whether the engineering is sound and shows real craft: native event correlation, action-aware snapshots in a shadow repo, capture-gap handling, grounded generation with refusal, deterministic verification/risk with a fact-check layer, calibration checks. Native journaling is Muse's capability. Echo's work is joining that evidence to the one-minute story and the calibration loop.
- Demo. Whether it is a working, impressive demo that holds up live, and whether the video is genuinely cool to watch. Judges use the video, the code and the live product. The plan is three minutes on screen: open the inbox, read the story, ask with a cited answer, miss a check while certain, then watch it refuse.

### Event rules that shape the build

- New work only. Everything I present must be built during the event, and the submission must make clear what was newly developed.
- The demo may only highlight features, code and functionality built during the hackathon. Judges must be able to clearly identify my original contributions. Failing that means immediate disqualification at the judges' sole discretion.
- The building period is Oct 27 to Nov 4. Kickoff is Oct 26 at 12:00 PM ET (5 PM Lagos). Whether work on Oct 26 counts is unconfirmed, so no Echo code before Oct 27.
- Repositories must be public.
- No code, data or assets I don't have rights to, and nothing that violates legal, ethical or platform policies.
- The submission needs an accessible public repo, an accessible three-minute demo video, and everyone who worked on it listed. Solo entrants submit once. It is due Nov 4 at 9 PM ET (Nov 5, 3 AM Lagos), and late submissions aren't considered.
- The anti-project list includes basic RAG applications and simple "AI for Education" chatbots. Echo has to read as a recorder, a storyteller and a calibration checker, not as a retrieval chatbot or a quiz bot.

### Bonus prizes worth designing for

- Most Viral, $20,000. Post the demo on X and submit the post link on the platform. The winner is picked on total engagement (likes, reposts, comments) through Nov 8, end of day.
- Best Build on Meta Open Weight Models, $10,000. Built on Muse Glimmer or Muse Spark Open, served on my own hardware or through partner inference. Projects are flagged in the first judging round.
- Community Vote, $10,000. Most votes in the public gallery, one vote per verified account. Announced Nov 16.

Best Agentic Use-Case ($5,000) and Best Creative Build ($5,000, for Muse Image or Muse Wonder) don't fit Echo well.

## 10. Scope

In (core path), the things I'm building:

1. Projects and sessions. A workspace per repository, each keeping its own history of recorded agent sessions. Automatic ingestion; no import step.
2. Session triage inbox. Most-recently-active project, strict newest-first, one-line summaries, Not checked / Checked / Skipped semantics, no-change handling, regenerate-and-reset on post-finalization resume.
3. The five-section story. Short version, Ask vs result (all prompts, extras/omissions uncertain), What changed (behaviour cards), Detours (strict inclusion rule + inline tree), Loose ends with a separate "Echo couldn't see" line. One story per session.
4. Change cards. Model grouping of behaviour changes incl. consequential non-file actions; top 7 by deterministic risk with plain-words rank reasons; risk/session-order toggle; strict observed-only verification badges; inline session slices; card history display; Ask why / Check me / Show code actions.
5. Deterministic trust layer. Fact-check validation of model claims with one-regeneration-then-gap-line; verification and risk computed, never model-asserted; agent-stated/uncertain labeling.
6. Evidence-based "why" with refusal. One saved thread per session in a side panel, card context attachment, citations, "not on the tape" refusal.
7. Calibration check. Inline offer (full prompt vs quiet chip), 3–5 questions max from risk + engagement, MCQ vs free-text per target with at least 1 free-text when high-risk is in the set, confidence-first flow with evidence reveal, picture-not-grade ending (solid / right-but-unsure / confident-but-wrong / wrong-and-knew-it / never-looked), Skip semantics, no retakes.
8. Engagement tracking. Unseen / seen / engaged for check targeting and never-looked only.
9. Local secret redaction. Secrets scrubbed before Echo stores anything and before any model request, with a masked preview and a disclosure about native-agent storage.

Delivery items:

- Demo tapes from Muse Code (real logs) and OpenCode (partial capture, stated as such).
- A hosted read-only demo with a baked tape, so judges can read a story, open cards, ask, and try a check live without installing anything.
- A public repo with a clear commit history from Oct 27, a three-minute demo video, and a README that states what was built during the event.

Cut line (drop in this order if time shrinks):

1. Screenshot stream and optional terminal playback. Already out — structured activity records plus file snapshots carry the demo.
2. Session/evidence viewer beyond the inline slices and diffs. The inline card slices and Show-the-code diffs stay; a full viewer returns later.
3. Cross-session history display on cards. Keep current-session story and checks.
4. "N more changes" unfolding polish. Keep top-7 cards and the routine line.
5. Citation click-to-scroll beyond inline slices. Keep inline citations as text with card slices.
6. Second-agent hardening (OpenCode recovery/reconciliation). Keep Muse Code as the primary tape; state OpenCode limits honestly.
7. Open-weight explanation path. Keep the Meta API path first.

Stretch (only after the core path works end to end) — none of this is v1:

- Cross-session gap carryover and targeting.
- System notifications.
- Export, sharing, and task creation.
- Retakes and grade contesting.
- Grouping edits by the developer.
- Spaced repetition (1, 3, 7, 14 days) and the learner model.
- The research question Owned raised: can an AI workflow beat no AI on retention?
- A badge on pull requests showing a change was reviewed and understood.
- Team views, as opt-in aggregates.
- More agent-specific readers into the common tape.

Not in scope: AI-use detection, a general tutor or chat product, an IDE plugin, multi-agent comparison, cloud sync, login, Windows support, installer packaging.

Out of v1 (explicit): replay UI, forensic timeline/file-state/hunk views, check/report pages, numeric scores, cross-session gap carryover/targeting (card history display stays), system notifications, export/sharing/task creation, grouping edits, retakes.

## 11. Demo path (exactly three minutes, fully on screen)

The video is one of the main things judges use, alongside the code and the live product. It must show only what I built during the event, and make that obvious.

1. 0:00 to 0:20. The problem in one breath, with one line on screen: developers took 19% longer with AI and believed they were 20% faster. A caption says Echo was built Oct 27 to Nov 4, and that Muse Code is Meta's agent, not mine.
2. 0:20 to 0:45. A real interactive agent session runs against a real repo with native capture and file snapshots on, time-compressed. The redaction preview shows a stripped synthetic API key, without implying that the agent's original logs were sanitized. In-progress shows as still-recording.
3. 0:45 to 1:30. Open the inbox, pick the newest session, read the story in order: short version, ask vs result, the top behaviour cards with verification badges and rank reasons. Open one card: before vs now, inline session slice, what it touches, history. Show the code inline.
4. 1:30 to 2:15. The inline check at the end of the story. Answer with confidence locked first, get one wrong while certain, watch the evidence reveal. End on the picture (solid / right-but-unsure / confident-but-wrong / wrong-and-knew-it / never-looked) — no score.
5. 2:15 to 2:40. Ask something the tape can't answer. It refuses.
6. 2:40 to 3:00. Done returns to the inbox; the repo link; and the line: Echo explains only what it can point to, and checks only calibration.

Rules for the video:

- Say what is new. Name the parts I built (readers and capture, story + deterministic trust layer, cards, evidence Q&A, calibration check) and show the repo and its commit history from Oct 27. The agent's own logging is Meta's, and the caption should say so.
- Don't present anything from before the event as new. The repo the agent works on is a vehicle, not part of Echo. If any of its code existed before Oct 27, say so on screen. A repo made for the demo is safer.
- The hosted demo carries the same tape, so judges who try it see what the video shows.
- Stay at three minutes.

I need a real session where the agent reverts an attempt and makes a questionable change. Staged demos look staged, so I'll start looking for that repo and task now.

## 12. Evaluation (targets, not claims)

| Measure | How | Target |
| --- | --- | --- |
| Capture integrity | Compare known fixture actions, tool outcomes and file versions with the tape; inspect Echo-owned artifacts for a synthetic secret | Report capture coverage and missed states; no fabricated records or raw fixture secret in Echo storage |
| Story faithfulness | Hand-check story claims (numbers, files, names, verification, risk) against tape facts across 3 tapes | No model-asserted verification/risk; every failure caught by the fact-check layer or reported |
| Citation support | Hand-label 20 "why" answers across 3 tapes as supported or not by their cited moments | 80% or better |
| Refusal | 10 questions the tape can't answer | Refuses at least 8 |
| Check quality | Fraction of generated checks that are answerable from evidence with a clean rubric | 80% or better |
| Time to comprehension | Session opened to story readable | Under 60 seconds for the baked tape |
| Card selection | On 3 tapes, do the top-7 risk picks match the changes I'd worry about? | Report as measured |
| Detours precision | On 3 tapes, check every listed detour against the recorded sequence | No fabricated detours; report any missed |

Before the Q&A gate, test a controlled fixture with a file read, a successful edit, a failed tool, an edit reverted in a later action, a shell-driven file change, and an interrupted tool whose outcome may be unknown. Also test a rapid edit-and-revert inside one command to measure the snapshot limit, and a synthetic secret to check Echo's tape, snapshots, caches and spool files. Capture tests establish what was observed or missed; they do not turn an unobserved intermediate state into evidence. This fixture is an instrumentation test, not a substitute for the real demo session.

There is no user pilot in the core plan. If I get three to five developers to run it on their own sessions before Nov 4, I'll report that with the sample size and limits. If not, the numbers above come from my own tapes and I'll say so.

## 13. Build plan

The day-by-day schedule lives outside this spec and is maintained separately. The fixed dates (building period, deadline, judging) are in section 9.

Two decision rules from this spec apply to whatever schedule gets used.

The first is the capture gate. Once the Muse reader and file snapshots work on a real session, ask whether the tape can support a useful story. If it can't support useful explanations, Echo doesn't get scrapped. The story half is described honestly as "captured actions, results and file changes," and more weight moves to the calibration half. If the installed agent build cannot support native capture, revisit that input decision explicitly; a terminal-only fallback does not silently meet the same contract.

The second is the cut line in section 10. When time shrinks, drop things in that order.

## 14. Decisions still open

Native-first capture of normal interactive sessions is the direction. These implementation defaults are still subject to the real-session spike, not claims that the recorder already works.

| Decision | Draft default | How it gets settled |
| --- | --- | --- |
| Native-record ingestion | Agent-specific live readers plus hooks, with trajectory export for reconciliation; pin the source build/schema and retain diagnostics | Hand inspection of a throwaway session, then the first recorder build: verify readable records, child-log coverage, checkpoint behaviour and recovery |
| File-capture timing | Baseline, snapshots around relevant tools/batches, filesystem watching and final reconciliation; no lossless transient-state claim | Capture fixture, including shell writes and rapid edit/revert |
| Behaviour grouping | Model proposes behaviour cards from tape facts; deterministic layer validates files/names/counts; no dev editing in v1 | Story review on 3 tapes |
| Verification computation | Deterministic observed / partly observed / agent-stated / nothing from tape evidence; weakest-level covering key behaviour wins | Story review on 3 tapes |
| Risk computation | Deterministic blast radius × mental-model-wrong chance; unverified boosts; plain-words rank reasons on every card | Hand-check top-7 picks on 3 tapes |
| Where "why" comes from | Quote readable agent-stated text when present; otherwise describe observed evidence without inventing intent. Do not require reasoning capture | Capture gate: three "why" questions on a real tape; inspect optional reasoning text separately |
| Redaction/privacy mode | Redact before all Echo storage and requests; disclose raw native-agent logs. Do not assume `--redacted` export prevents native persistence | Synthetic-secret fixture and inspection of documented native-storage behaviour |
| Story generation trigger | Finalization generates the story; in-progress shows still-recording; post-finalization resume regenerates and resets check status | When finalization wiring is built |
| Story skeleton without model | Deterministic skeleton story when the model is unavailable | When the story path is built |
| Check generation | Questions generated at check start from risk + engagement; MCQ key-scored for consequence/decision, free-text rubric-scored against evidence for why/teach-back | When the check path is built |
| Language scope | JavaScript and TypeScript only | Matches my stack and the demo repo |
| Engagement thresholds | Seen = closed card in viewport ~1s; engaged = expand / Show code / Ask why | When the story UI is built |
| Project identity | Repo root path plus the Git remote if there is one, so moving a folder doesn't split a project | When the project and session list is built |
| Hosted demo | Read-only page with one or two baked tapes and a spending cap + rate limit | When a baked tape is ready |
| Open-weight path | Try Muse Spark Open through Baseten for the explanation path next to the Meta API. Keep it only if answer quality holds | After the first working Q&A path, by comparing answer quality |
| CLI binary name | `echo-cli`: the shell builtin shadows any binary named `echo` | Settled |
| Second agent | Muse Code primary (real logs read, live run untested); OpenCode partial (no replay/reconnect, needs recovery path). No universal capture guarantee | Cut-line item 6; harden only after the core loop works |
| Product name | Echo. Domains and handles are unchecked, and the bare name is crowded (Amazon Echo, a popular Go web framework) | Any time |

## 15. After Nov 4

- Session/evidence viewer returning (inline slices stay; the fuller viewer is a later decision).
- Spaced repetition and the learner model, so Echo tracks whether understanding holds over days.
- A longer retention study with a proper control, which is the question Owned set out to answer.
- Cross-session gap carryover and targeting.
- System notifications; export, sharing, and task creation.
- A badge on pull requests that says a change was comprehended by the person who approved it.
- Opt-in team views and the audit angle for regulated shops.
- More languages and hardened agent-specific readers for Claude Code, OpenCode and Codex; investigate Qoder's capture path before claiming support.

## 16. Risks

- The tape may hold actions without a readable explanation. Mitigation: never require private reasoning; label every answer as agent-stated or observed, refuse unsupported intent claims, and use the capture gate to decide how the product is described.
- Native records or hook payloads may be incomplete, too large, or changed by a release. Mitigation: pin the tested agent build, preserve source/diagnostic metadata, reconcile inputs and show known gaps rather than silently fabricating a complete session.
- File capture may miss rapid edit/revert sequences or misattribute concurrent/background writes. Mitigation: combine action-aware snapshots with independent filesystem capture, keep uncertain associations labeled, and report the measured limits instead of promising every intermediate state.
- Recorder hooks execute outside the agent's tool sandbox. Mitigation: review the hook commands, keep their filesystem scope narrow, and observe rather than modify or approve agent actions.
- Echo gets read as a log viewer. Mitigation: the one-minute story, the refusal, the detours, and the calibration picture are the answer. The demo shows all four.
- Story or cards assert what the tape doesn't support. Mitigation: deterministic fact-check layer with one-regeneration-then-gap-line; verification/risk computed, never model-asserted.
- Checks don't measure understanding, or generated questions are ambiguous. Mitigation: hand checks, evidence reveals, and a stated limit in the submission. The check claims calibration only.
- People skip the checks because they add friction. Mitigation: check only the risky changes (3–5 max), quiet chip when nothing is high-blast, Skipped status without shame.
- Secrets leak into Echo artifacts or remain in native-agent logs. Mitigation: redact before all Echo-owned persistence, including snapshot Git objects/index and intermediate files, and before model calls; test with a synthetic secret, show a masked preview, disclose the native-log limit, and use only my own repos for demos.
- Claims outrun evidence. Mitigation: every number in the submission comes from section 12 or a cited study, with its sample size and limits.
- Echo is read as a basic RAG app or a quiz bot, both on the anti-project list. Mitigation: the pitch and the demo lead with automatic capture, the minute-long story, detours, and calibration checks.
- The demo or repo blurs what was built during the event, which risks disqualification. Mitigation: a fresh repo on Oct 27, an on-screen statement of what is new and what is Meta's, and a demo repo clearly separate from Echo.
- No working card or credits for the Meta API. Mitigation: sort a dollar card before the first API call, request partner credits, cache model calls, and keep the model layer swappable.
- The live-product check fails because Echo only runs locally. Mitigation: the hosted read-only demo.
- Time runs short. Mitigation: the cut-line order in section 10.

## 17. Assumptions and things I haven't verified

The Oct 26 first-party documentation check confirms Muse Code's native session log, structured trajectory export, interactive lifecycle hooks, optional transcript reasoning setting, and programmatic JSON/SDK paths. It also confirms related paths for Claude Code, OpenCode V2 and Codex. These are documented capabilities, not tested installations or evidence that any capture path is lossless. Qoder was not verified. Later real-log reads confirmed the Muse log shape; a live run is still untested. OpenCode capture is partial as noted above.

Still unverified:

- The Participant Guide covers the rules, rubric and deadline. I haven't read any longer Official Rules or terms behind it.
- Whether work on Oct 26, including hand inspection of Muse Code's logs, counts toward the building period.
- Whether the Meta Model API works from Nigeria, its rate limits and structured-output reliability, and whether a Nigerian-issued card works for billing. The credit link isn't published yet.
- The installed Muse build's live ingestion and recovery behaviour, child-log coverage, and what remains after checkpointing or compaction.
- Which full messages and tool results are available beyond hook previews or skipped payloads, and whether optional reasoning text is readable in the captured/exported records.
- How reliably hooks and file capture preserve useful intermediate versions, including shell writes, failures, interruptions and concurrent/background changes.
- Whether a stronger privacy mode can preserve enough evidence, and what other native diagnostic or temporary storage may remain.
- Which Muse Spark version the event API exposes, and how long a session fits in its context.
- Whether Muse Spark Open on Baseten is good enough for the explanation path.
- The Trio developer study: I read secondary coverage only.
- The risk computation: a guess until checked against hand labels.
- Whether Echo is free as a name, domain and handle.
- That no equivalent story-plus-calibration loop exists. This rests on product searches from Oct 25; native agent logging and audit/export tools are already known to exist.

## Sources

- METR, "Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity," 2025: https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/
- Stack Overflow, 2025 Developer Survey, AI: https://survey.stackoverflow.co/2025/ai
- DORA, State of AI-assisted Software Development 2025: https://dora.dev/dora-report-2025/
- Perry et al., "Do Users Write More Insecure Code with AI Assistants?", ACM CCS 2023: https://arxiv.org/abs/2211.03622
- SmartBear, "Code Review at Cisco Systems": https://static0.smartbear.co/support/media/resources/cc/book/code-review-cisco-case-study.pdf
- Bacchelli and Bird, "Expectations, Outcomes, and Challenges of Modern Code Review," ICSE 2013: https://sback.it/publications/icse2013.pdf
- Bastani et al., PNAS 122(26), 2025: https://papers.ssrn.com/abstract=4895486
- Wharton summary of the PNAS study: https://knowledge.wharton.upenn.edu/article/without-guardrails-generative-ai-can-harm-education/
- InfoWorld on the developer trial: https://www.infoworld.com/article/4125231/ai-use-may-speed-code-generation-but-developers-skills-suffer.html
- DataNorth, Muse Code and Muse Spark 1.2 launch: https://datanorth.ai/news/meta-releases-muse-spark-1-2-and-muse-code
- Deccan Chronicle, Muse Code launch (action log and crash recovery): https://www.deccanchronicle.com/technology/meta-launches-new-ai-coding-tool-muse-code-powered-by-muse-spark-12-1977049
- Build Fast with AI, Muse Spark 1.3 review: https://www.buildfastwithai.com/blogs/meta-muse-spark-1-3-review
- Event: https://cerebralvalley.ai/e/meta-ai-developer-hackathon
- Meta Global AI Developer Hackathon Participant Guide, Cerebral Valley (rules, rubric, schedule, credits and prizes)

Capture/input-path sources checked Oct 26, 2026 (first-party documentation, not local runtime tests):

- Meta, Muse Code session model and optional reasoning display/transcript setting: https://dev.meta.ai/docs/muse-code/interactive
- Meta, Muse Code interactive lifecycle hooks and headless JSON output: https://dev.meta.ai/docs/muse-code/extending
- Meta, detailed Muse Code hook-event reference (payload contents and limits): https://meta-models.github.io/muse-code-sdk/1.4/guides/plugins/reference/hook-events/
- Meta, audit and resume agent sessions (native log format, trajectory export, diagnostics and post-storage export redaction): https://dev.meta.ai/docs/cookbook/audit-agent-sessions
- Meta, Muse Code changelog (checkpoint trimming and recovery changes): https://dev.meta.ai/docs/muse-code/changelog
- Meta, Muse Code TypeScript SDK (programmatic session execution, item replay/live deltas and version compatibility): https://github.com/meta-models/muse-code-sdk/blob/main/clients/sdk-ts/README.md
- Anthropic, Claude Code sessions (local transcripts, tools/results, hooks and script interfaces): https://code.claude.com/docs/en/sessions
- OpenCode V2, plugins (session access and before/after tool hooks): https://opencode.ai/v2/docs/build/plugins
- OpenCode V2, client event streams (live-only subscriptions, no replay or automatic reconnection): https://opencode.ai/v2/docs/build/client
- OpenAI, Codex non-interactive mode (session rollout persistence and `codex exec --json` events): https://developers.openai.com/codex/noninteractive/

Third-party tools that read Muse Code's session history from `~/.local/share/muse/sessions/` (corroborating the log location and format):

- SpecStory, Muse Code integration: https://docs.specstory.com/integrations/muse-code
- ranwhat, agent audit tool: https://pypi.org/project/ranwhat/0.5.0/
- session-migrate, session migration between agents: https://pypi.org/project/session-migrate/0.8.0/

The Cisco and Bacchelli studies predate AI coding agents, so they establish review capacity and understanding needs, not AI-specific effects. The learning studies cover students and junior developers. Echo is a new combination and none of these sources tests it.
