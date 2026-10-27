# Echo: Product Spec

Replay what your coding agent did and why. Then prove you understood it before you approve.

Built for the Meta Global AI Developer Hackathon 2026 (Oct 26 to Nov 4). Solo entry, Indie Developer track, Build for Your World theme.

Status: draft v3, updated Oct 26, 2026. Echo is a working name. This merges two earlier specs: Agent Tape (the recording and replay half) and Owned (the proof half). RepoReel is dropped. Two sets of changes are folded in here: the native-first capture path (revised after checking first-party Muse Code documentation) and the rubric, rules and deadline from the Participant Guide. Native-first capture has not been tested on a real session yet. The "how" is still rough in several places, so section 11 lists open implementation decisions and their draft defaults.

---

## 1. Problem

Developers now ship code written by agents they can't fully verify or reproduce alone. You come back after lunch and the agent has touched 40 files. Reading all of it would take longer than writing it, so you approve. Generation stopped being the bottleneck a while ago. Trust is.

Two things are missing at that moment. A diff shows what changed, but nothing shows why, what the agent tried first, or what it quietly gave up on. And nothing checks whether you understood any of it, which matters because people who lean on AI tend to feel they learned things they didn't.

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

Existing tools cover pieces. Agent observability tools (LangSmith, Langfuse, Grafana agent tracing) trace API calls for teams. Atrophy runs generic drills, and coding agents now ship Study Mode and explanatory modes. The Oct 26 documentation check also confirms that Muse Code already supplies session logs and an audit/export workflow; Claude Code, OpenCode and Codex expose related capture paths. Third-party tools already read Muse Code's session history too: SpecStory saves Muse sessions as Markdown, and ranwhat audits what coding agents ran. Recording actions is not Echo's novelty. As of the product searches behind the earlier specs (Oct 25), I found nothing combining evidence-backed questions about one diff with execution-verified understanding checks. That is not an exhaustive or current market claim.

## 2. Who it is for, and who pays

The first users are solo developers, students and juniors who drive CLI coding agents daily (Muse Code, Claude Code, Qoder). They feel this already and need no convincing. I'm the first user, so the first sessions to record are mine.

Later buyers are engineering teams and regulated shops that must audit agent-written changes ("who approved this line, and on what basis?" is already a compliance question), and universities and bootcamps that need to know whether AI-assisted coursework teaches anything. Team views would be opt-in aggregates. The individual sees their own data first.

## 3. Core idea

Echo records a coding-agent session, lets you replay it and question any change with answers tied to evidence on the tape, then checks that you understood the risky changes by running code instead of trusting your own sense of it.

It is one loop in two halves. The tape half explains what the agent did. The proof half checks what you took in. Each covers a gap in the other. A tape alone leaves you nodding along to a convincing explanation. Checks alone have nothing real to ask about.

### Evidence, not intent

An action history is not a guaranteed record of reasoning. Echo distinguishes the explanation the agent actually wrote from the actions and results the recorder observed. "The test failed, then the agent edited this function" is evidence of a sequence, not proof of why it made that edit. Inference is never presented as the agent's reasoning. When the tape has nothing relevant, the answer is "not on the tape."

Muse Code documents an optional `show_reasoning` setting that puts reasoning text into the transcript, off by default. Echo does not depend on it. If readable explanation or reasoning text is actually captured, Echo can quote it as **agent-stated**, not as a complete or faithful account of private reasoning. Whether that text survives export in a usable form still needs a real-session test. Opaque or encrypted reasoning payloads are not usable explanation evidence and are excluded from Echo's tape.

### Capture/input path

Echo records the normal interactive Muse Code session. It does not need to replace Muse's interface or run tasks through a headless SDK. The primary input is Muse's structured activity record, not text scraped from the terminal.

There are three complementary inputs:

1. **Native session records: what was requested and what came back.** Muse Code documents an event log containing model calls, tool calls and results, and approval decisions, plus a structured trajectory export. Echo reads those records for attributable conversation and action evidence. It preserves source sequence numbers, session and tool IDs, build/schema metadata, and reported gaps or unknown outcomes. Parent/child identifiers stay attached when present; the spike must establish which child logs are included.
2. **Lifecycle hooks: when to capture file state.** Muse Code exposes hooks such as `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `SessionStart` and `SessionEnd` for ordinary interactive use. Echo uses them to trigger before/after snapshots around relevant tools or committed batches. Hooks observe the run rather than block actions or rewrite tool inputs/results. They are not a complete transcript: payload limits and preview-only fields mean they must be combined with native records.
3. **Independent file versions: what actually changed.** Capture a baseline, action-aware snapshots, filesystem changes outside the obvious edit-tool path, and a final reconciliation. Store sanitized versions in a shadow git repo without changing my repo's Git history or index. A recorded tool request is not proof that its intended edit landed; a failed tool may have written part of a file, and a shell command may change many files.

Muse's documented default log path is `~/.local/share/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl`, with child logs under `subagent/<child-id>/`. Each line has an envelope containing `sequence`, `recorded_at`, `record_type`, `durability`, `payload_type` and `payload`. This gives the spike a concrete source to inspect; the reader still has to resolve the actual session, configured storage and build rather than assume that path or schema never changes. Three third-party tools (ranwhat, SpecStory, session-migrate) read Muse sessions from that same location, which corroborates the path and the JSONL format. The envelope fields, hooks and settings described here still rest on the Oct 26 documentation check and need a real-session test.

The Muse reader converts these inputs into Echo's common tape format: JSONL events plus snapshot references and capture diagnostics. Link records and snapshots through supported identifiers where possible. A nearby timestamp alone is not proof that one event caused another, and concurrent streams do not acquire a reliable global order just by sorting their clocks.

Ingest during the session where the installed version permits, then reconcile with trajectory export. Do not rely only on a late export: Muse's changelog describes trimming covered records at checkpoints in long sessions. The live-reader and recovery behaviour need testing before promising complete history.

Terminal recording through a PTY is optional visual playback, labeled as rendered output rather than the authoritative action record. A terminal-only tape would be a degraded mode, not silently equivalent to native capture; building that fallback is not core. Native records and file snapshots also do not guarantee every intermediate state. A rapid edit-and-revert inside one shell command can escape snapshots, and background writes can have uncertain attribution. Replay shows captured states and known gaps, not an invented continuous history.

**Redaction covers Echo's storage, not every file on the machine.** Scrub inputs locally before writing Echo's tape, snapshot Git objects/index, caches or spool files, and again before model requests. Do not write a raw export as an intermediate Echo artifact. Muse's own native logs can already contain raw secrets; its `--redacted` export cleans the exported copy after native logging, not the original log. Disclose that separate storage surface and show a masked redaction preview. A stronger mode that suppresses native logging needs a separate capture/privacy test and is not assumed here.

### Other agents

These are documented extension paths, not implemented compatibility or equivalent capture guarantees. Muse Code remains the only core reader.

| Agent | Available input path | Important limit |
| --- | --- | --- |
| Claude Code | Local transcripts contain messages, tool calls and results; hooks can drive live capture; programmatic runs offer structured output | The local transcript entry format is internal and can change between releases. Programmatic output is not passive capture of an unrelated interactive session |
| OpenCode V2 | Session history, before/after tool hooks, and a live event stream | Live event subscriptions do not replay missed events or reconnect automatically; recording needs its own recovery/reconciliation path |
| Codex | Saved session rollout files and `codex exec --json` output covering messages, commands, file changes and exposed reasoning items | The JSON stream is an automated-run interface, not a guaranteed way to attach to an arbitrary interactive session |
| Qoder | No capture path verified in this documentation check | Do not claim support until its records or supported extension interface have been inspected |

Each future agent needs its own reader into the same Echo tape. Available reasoning text depends on the agent, model and settings; none of these paths is a promise of complete private reasoning or complete filesystem history.

### Projects and sessions

Each repository is a project with its own workspace. Echo identifies a project by its repo root (and its Git remote, if there is one) and stores every recorded session for that repo under it. The replay UI opens on a project list, then that project's sessions. Tapes never mix between projects.

### Project view and visualizations

The project view is built from stored tapes, not from model memory (cross-session memory is a stretch goal). It shows how the files in the project connect (an import graph for JavaScript and TypeScript) and overlays what the agent changed across sessions: which files it touched, how often, and in which session. Its job is to show where agent work sits in the codebase. It does not try to teach the codebase.

There are three visualizations. The activity timeline is interactive and covers one session. The file dependency map covers the project. The attempt tree covers one session and separates dead ends from the path that landed code. A node counts as a dead end only if the recorded sequence or agent-stated text supports it, such as an edit that was later reverted or replaced. Uncertain links are labeled as uncertain, which follows the same "evidence, not intent" rule as the answers.

### Pipeline

1. Record. `echo-cli record -- muse` starts the normal interactive agent with Echo's Muse reader and capture hooks active (binary name is a placeholder, see section 11). Recording does not require a custom agent interface or PTY parsing.
2. Capture. Ingest native session records, observe tool lifecycle events, and capture independent file versions. Preserve source identifiers, ordering and diagnostics, then reconcile with the exported trajectory and final working tree. Terminal playback is optional.
3. Redact. Scrub secrets before any Echo-owned storage, including shadow-repo snapshots, and before any model call. Show a masked preview and disclose that Muse's own logs are separate and may remain raw.
4. Replay. `echo-cli replay <tape>` serves a local web UI with an activity timeline, the latest captured file state at a selected moment, and the final diff. Missing states and reported capture gaps are visible.
5. Inspect. Click any hunk and Echo lists captured actions and file versions that can be linked to it, including captured attempts the agent later reverted. Requested edits, observed effects and uncertain mappings are distinguished.
6. Ask. Ask why a change happened or what was tried first. Retrieval pulls the relevant tape segments, Muse Spark answers using only those, with citations, or refuses.
7. Select. Echo ranks hunks by risk and by how little I engaged with them, and picks a few (draft: 3 to 5).
8. Check. For each, a short question (predict the output, or spot the bug). I pick my confidence first (guessing, think so, certain), then answer. The code runs in a sandbox and I see the reference behaviour plus a calibration reading.
9. Summarize. A report of what I reviewed, what I proved, and what I waived.

## 4. What makes it different

- The refusal is the trust story. A tool that says "not on the tape" is more believable than a chatbot bolted onto a log viewer.
- It keeps what a final diff can't show: captured attempts the agent made and reverted. It can show that an approach was abandoned when the recorded sequence or agent-stated text supports that, not merely because an edit disappeared.
- Execution decides what's true in the proof half. The model writes the question, and the sandbox establishes the answer. A wrong-and-certain answer is treated as the key event instead of being averaged away.
- It targets what I skipped. The replay UI knows which hunks I opened, so the checks go where I didn't look.
- Muse Code is the subject of the product, not just a tool it calls. Recording a Muse Code session and replaying it in front of Meta engineers is the pitch.

A log is raw material, and Muse Code already provides one. Echo adds file-linked history, evidence-backed questions and refusals, review tracking, and execution-verified checks for one developer questioning one diff. That is the answer to "isn't this just Muse Code's action log?"

## 5. Meta tooling used (rubric: 25%)

Muse Code is the recorded agent in the primary demo tapes. It is a terminal agent in beta for macOS and Linux, which fits my machine. Its native session records and interactive lifecycle hooks are also Echo's primary capture inputs. Meta's audit/export cookbook confirms the documented route; installation, access and capture fidelity on my machine remain untested.

Muse Spark is the engine: evidence-grounded answers with citations, hunk analysis, and check generation. Muse Spark 1.3 came out on Sept 2, 2026. I need to confirm which version the API exposes to this event and how reliable its structured output is.

This is a two-model story, and on paper it is the thinner side of the tooling axis. The bet is depth over breadth: Muse Code sits inside the product as its subject, and every claim that matters is either cited to the tape or verified by execution. If a third integration fits without feeling bolted on, I'll add it. I won't force one.

The Participant Guide lists more than I had assumed: the Muse Spark series, Muse Wonder, Muse Image, Muse Voice Transcribe and SAM 3.1 through the Meta Model API, the open-weight Muse Glimmer and Muse Spark Open, and Muse Code. The Tooling criterion asks whether I went beyond a basic integration and surfaced capabilities the Meta team didn't expect. One thing would help Echo here: a separate explanation path on Muse Spark Open, served through Baseten (model id `meta-models/muse-spark-open-1026`), would make Echo eligible for the $10,000 open-weights bonus and could keep the tape off Meta's hosted API. That is an open decision in section 11.

Credits: each participant gets $150 in Meta Model API credits, claimed individually by Nov 4, 9 PM ET, and a credit card must be on the account to make calls. Modal ($100, first 1,000 requests), Baseten ($100, reviewed) and Fireworks ($25, shortlisted teams) credits are separate and need their own requests.

Two privacy points I'll state in the submission. Echo is local-first, but local stops at the model call: the retrieved tape segments, which contain source code, go to Meta's API. A review of Muse Spark 1.3 cautions against using it for confidential client code. Echo redacts its own stored evidence, but Muse's native logs may already hold raw source and secrets; redacting an export does not sanitize those originals. The demo uses only my own repos and a synthetic secret for the redaction example.

## 6. Rubric and event rules

This section comes from the Participant Guide. The 30/25/25/20 weights in my earlier specs were wrong. The real rubric is equal weights.

### How it is judged

Stage 1 is pass/fail: the project reasonably fits a problem statement and reasonably uses the Meta Model API or Meta's open-weight models. Stage 2 scores four equally weighted criteria from 0 to 10 (25% each). The top 5 projects per track go to a live final round, where judges watch the demo videos and rank them on the same rubric. Judging runs Nov 5 to 8, and the closing ceremony is Nov 9. The Indie Developer track pays $400,000 in total, with $150,000 for first place.

- Impact. The real-world potential: who benefits, how much it matters, whether people could actually use it, and whether it fits a problem statement. Every developer using coding agents approves code they can't fully explain, and agent-written code is becoming the default. Echo fits Build for Your World. The continuation path is in section 12.
- Use of Meta AI tooling. How creatively I used Meta's tooling, whether I went beyond a basic integration, and whether I surfaced capabilities the Meta team didn't expect. Muse Code is the product's subject and Muse Spark is its engine. This is the axis to push hardest (see section 5).
- Technical depth and execution. Whether the engineering is sound and shows real craft: native event correlation, action-aware snapshots in a shadow repo, capture-gap handling, grounded generation with refusal, execution-verified checks, calibration. Native journaling is Muse's capability. Echo's work is joining that evidence to file history and the review and proof loop.
- Demo. Whether it is a working, impressive demo that holds up live, and whether the video is genuinely cool to watch. Judges use the video, the code and the live product. The plan is three minutes on screen: record, replay, ask, get a cited answer, miss a check while certain, then watch it refuse.

### Event rules that shape the build

- New work only. Everything I present must be built during the event, and the submission must make clear what was newly developed.
- The demo may only highlight features, code and functionality built during the hackathon. Judges must be able to clearly identify my original contributions. Failing that means immediate disqualification at the judges' sole discretion.
- The building period is Oct 27 to Nov 4. Kickoff is Oct 26 at 12:00 PM ET (5 PM Lagos). Whether work on Oct 26 counts is unconfirmed, so no Echo code before Oct 27.
- Repositories must be public.
- No code, data or assets I don't have rights to, and nothing that violates legal, ethical or platform policies.
- The submission needs an accessible public repo, an accessible three-minute demo video, and everyone who worked on it listed. Solo entrants submit once. It is due Nov 4 at 9 PM ET (Nov 5, 3 AM Lagos), and late submissions aren't considered.
- The anti-project list includes basic RAG applications and simple "AI for Education" chatbots. Echo has to read as a recorder, a replayer and an execution-verified checker, not as a retrieval chatbot or a quiz bot.

### Bonus prizes worth designing for

- Most Viral, $20,000. Post the demo on X and submit the post link on the platform. The winner is picked on total engagement (likes, reposts, comments) through Nov 8, end of day.
- Best Build on Meta Open Weight Models, $10,000. Built on Muse Glimmer or Muse Spark Open, served on my own hardware or through partner inference. Projects are flagged in the first judging round.
- Community Vote, $10,000. Most votes in the public gallery, one vote per verified account. Announced Nov 16.

Best Agentic Use-Case ($5,000) and Best Creative Build ($5,000, for Muse Image or Muse Wonder) don't fit Echo well.

## 7. Scope

In (core path), the nine things I'm building:

1. Projects and sessions. A workspace per repository, each keeping its own history of recorded agent sessions.
2. Session understanding. A Muse-native reader and lifecycle hooks feed a common tape format with shadow-repo file snapshots. The replay UI has a step-by-step timeline, a diff, and a hunk inspector that shows captured attempts the agent later reverted, with known gaps visible.
3. Project-level learning. A project view built from stored tapes: how files connect, and what the agent changed across sessions.
4. Visualizations. The interactive timeline, the file dependency map, and the attempt tree that separates dead ends from landed code.
5. Evidence-based "why" with refusal. One Q&A path with retrieval, Muse Spark, citations, and a "not on the tape" refusal.
6. Execution checks. Echo picks 3 to 5 changes and asks short questions (predict the output, spot the bug) on JavaScript and TypeScript hunks, graded in a sandbox.
7. Confidence calibration. I pick guessing, think so, or certain before answering. Catching a wrong-and-certain answer is the main job of the check half.
8. Targeting what I skipped. The replay UI records which hunks I opened, and the checks go to the risky ones I didn't.
9. Local secret redaction. Secrets are scrubbed before Echo stores anything and before any model request, with a masked preview and a disclosure about native-agent storage.

Delivery items:

- Demo tapes from Muse Code.
- A hosted read-only demo with a baked tape, so judges can replay, ask and try a check live without installing anything.
- A public repo with a clear commit history from Oct 27, a three-minute demo video, and a README that states what was built during the event.

Cut line (drop in this order if time shrinks):

1. Screenshot stream and optional terminal playback. Structured activity records plus file snapshots carry the demo.
2. The file dependency map and the cross-session overlay on it. Keep the project and session lists and the per-session views.
3. Reverse-motion polish in the replay UI. Keep scrub and diff.
4. Spot-the-bug checks. Keep predict-the-output.
5. Citation click-to-scrub. Keep inline citations as text.
6. Mutation testing in the check gate. Keep "the reference answer passes twice."
7. Second-agent fallback tapes/readers. Keep Muse Code only; documented paths for other agents are not core implementations.

If the attempt tree runs long, a flat list of attempts per file is the fallback. It is the demo's best visual, so it goes last among the visualizations.

Stretch (only after the core path works end to end):

- Spaced repetition: missed concepts come back after 1, 3, 7 and 14 days.
- The learner model that tracks calibration and retention over time.
- The research question Owned raised: can an AI workflow beat no AI on retention?
- Rewrite-from-spec checks.
- A badge on pull requests showing a change was reviewed and understood.
- Team views, as opt-in aggregates.
- Cross-session memory: Echo remembers what it has seen in earlier sessions of a project, such as files the agent keeps rewriting or approaches it keeps abandoning, and uses that in later answers and checks.
- More agent-specific readers into the common tape, starting from the documented paths above rather than a universal terminal parser.

Not in scope: AI-use detection, a general tutor or chat product, an IDE plugin, multi-agent comparison, cloud sync, login, Windows support, installer packaging.

## 8. Demo path (exactly three minutes, fully on screen)

The video is one of the main things judges use, alongside the code and the live product. It must show only what I built during the event, and make that obvious.

1. 0:00 to 0:20. The problem in one breath, with one line on screen: developers took 19% longer with AI and believed they were 20% faster. A caption says Echo was built Oct 27 to Nov 4, and that Muse Code is Meta's agent, not mine.
2. 0:20 to 0:50. A real interactive Muse Code session runs against a real repo with native capture and file snapshots on, time-compressed. The redaction preview shows a stripped synthetic API key, without implying that Muse's original logs were sanitized.
3. 0:50 to 1:30. Open the project, pick the session, and scrub the timeline. The attempt tree shows where the agent hit a dead end and what it landed. Click a suspicious hunk (say, deleted error handling) and the cited answer jumps to the moment. Ask what it tried before, and the abandoned approach appears.
4. 1:30 to 2:15. Echo picks that hunk for a check. I answer "pretty sure," get it wrong, the sandbox runs it, and the calibration meter flags the overconfidence.
5. 2:15 to 2:40. Ask something the tape can't answer. It refuses.
6. 2:40 to 3:00. The report, the repo link, and the line: Echo explains only what it can point to, and checks only what it can run.

Rules for the video:

- Say what is new. Name the parts I built (Muse reader and capture, replay, evidence Q&A, check engine) and show the repo and its commit history from Oct 27. Muse Code's own logging is Meta's, and the caption should say so.
- Don't present anything from before the event as new. The repo the agent works on is a vehicle, not part of Echo. If any of its code existed before Oct 27, say so on screen. A repo made for the demo is safer.
- The hosted demo carries the same tape, so judges who try it see what the video shows.
- Stay at three minutes.

I need a real session where the agent reverts an attempt and makes a questionable change. Staged demos look staged, so I'll start looking for that repo and task now.

## 9. Evaluation (targets, not claims)

| Measure | How | Target |
| --- | --- | --- |
| Capture integrity | Compare known fixture actions, tool outcomes and file versions with the tape; inspect Echo-owned artifacts for a synthetic secret | Report capture coverage and missed states; no fabricated records or raw fixture secret in Echo storage |
| Citation support | Hand-label 20 "why" answers across 3 tapes as supported or not by their cited moments | 80% or better |
| Refusal | 10 questions the tape can't answer | Refuses at least 8 |
| Check pass rate | Fraction of generated checks that clear the gate | 80% or better |
| Time to first check | Tape loaded to first verified check | Under 90 seconds |
| Hunk selection | On 3 tapes, do the top picks match the changes I'd worry about? | Report as measured |
| Attempt tree | On 3 tapes, check every dead end and landed node against the recorded sequence | No fabricated dead ends; report any missed |

Before the Q&A gate, test a controlled fixture with a file read, a successful edit, a failed tool, an edit reverted in a later action, a shell-driven file change, and an interrupted tool whose outcome may be unknown. Also test a rapid edit-and-revert inside one command to measure the snapshot limit, and a synthetic secret to check Echo's tape, snapshots, caches and spool files. Capture tests establish what was observed or missed; they do not turn an unobserved intermediate state into evidence. This fixture is an instrumentation test, not a substitute for the real demo session.

There is no user pilot in the core plan. If I get three to five developers to run it on their own sessions before Nov 4, I'll report that with the sample size and limits. If not, the numbers above come from my own tapes and I'll say so.

## 10. Build plan

The day-by-day schedule lives outside this spec and is maintained separately. The fixed dates (building period, deadline, judging) are in section 6.

Two decision rules from this spec apply to whatever schedule gets used.

The first is the capture gate. Once the Muse reader and file snapshots work on a real session, ask whether the tape can support useful answers. If it can't support useful explanations, Echo doesn't get scrapped. The tape half is described honestly as "captured actions, results and file changes," and more weight moves to the check half. If the installed Muse build cannot support native capture, revisit that input decision explicitly; a terminal-only fallback does not silently meet the same contract.

The second is the cut line in section 7. When time shrinks, drop things in that order.

## 11. Decisions still open

Native-first capture of normal interactive Muse Code is the direction. These implementation defaults are still subject to the real-session spike, not claims that the recorder already works.

| Decision | Draft default | How it gets settled |
| --- | --- | --- |
| Native-record ingestion | Muse-specific live reader plus hooks, with trajectory export for reconciliation; pin the source build/schema and retain diagnostics | Hand inspection of a throwaway session, then the first recorder build: verify readable records, child-log coverage, checkpoint behaviour and recovery |
| File-capture timing | Baseline, snapshots around relevant tools/batches, filesystem watching and final reconciliation; no lossless transient-state claim | Capture fixture, including shell writes and rapid edit/revert |
| Hunk-history mapping | Link native actions and observed file versions through supported IDs and file evidence; distinguish requested edits from effects and uncertain matches | Inspector tested on real edits and reverted attempts |
| Where "why" comes from | Quote readable agent-stated text when present; otherwise describe observed evidence without inventing intent. Do not require reasoning capture | Capture gate: three "why" questions on a real tape; inspect optional reasoning text separately |
| Redaction/privacy mode | Redact before all Echo storage and requests; disclose raw native-agent logs. Do not assume `--redacted` export prevents native persistence | Synthetic-secret fixture and inspection of documented native-storage behaviour |
| Optional terminal capture | Visual playback only, not the action authority; a terminal-only fallback is degraded and not core | Add only if the native-first path works and time permits |
| Which hunks get a check | Score from size, error-handling or security-pattern changes, repeated rewrites by the agent, and never opened in replay. Top 3 to 5 | Hand-check on 3 tapes |
| How checks are generated | Muse Spark proposes a snippet-level question and a reference answer from the hunk, then the code runs to confirm it | When the check engine is built |
| Sandbox | Throwaway process or container, no network, hard timeout, snippet scope instead of the whole repo. Build the simple fallback runner first | When the check engine is built |
| Language scope | JavaScript and TypeScript only | Matches my stack and the demo repo |
| What counts as skipped | A hunk never opened in replay. Dwell time is a later refinement | When the replay UI is built |
| Project identity | Repo root path plus the Git remote if there is one, so moving a folder doesn't split a project | When the project and session list is built |
| Attempt tree | One node per captured action or batch, linked by file and sequence. A node is a dead end only if it was later reverted or replaced and is not in the final tree. Uncertain links are labeled | When the attempt tree is built, checked against the recorded sequence on 3 tapes |
| Dependency map | Static import graph for JavaScript and TypeScript only, built from the final tree and the per-session snapshots. No model-written summaries | When the project view is built |
| Hosted demo | Read-only page with one or two baked tapes. The server calls the model with a spending cap and a rate limit | When a baked tape is ready |
| Open-weight path | Try Muse Spark Open through Baseten for the explanation path next to the Meta API. Keep it only if answer quality holds | After the first working Q&A path, by comparing answer quality |
| CLI binary name | Not `echo`: the shell builtin shadows any binary with that name | Before the first commit |
| Second agent | Muse Code only. Future agent-specific readers translate into the common tape; no universal capture guarantee and no other agent's reader in core | Cut-line item 7; add readers only after the core loop works |
| Product name | Echo. Domains and handles are unchecked, and the bare name is crowded (Amazon Echo, a popular Go web framework) | Any time |

## 12. After Nov 4

- Spaced repetition and the learner model, so Echo tracks whether understanding holds over days.
- A longer retention study with a proper control, which is the question Owned set out to answer.
- A badge on pull requests that says a change has a tape and was checked by the person who approved it.
- Opt-in team views and the audit angle for regulated shops.
- More languages and agent-specific readers for Claude Code, OpenCode and Codex; investigate Qoder's capture path before claiming support.

## 13. Risks

- The tape may hold actions without a readable explanation. Mitigation: never require private reasoning; label every answer as agent-stated or observed, refuse unsupported intent claims, and use the capture gate to decide how the product is described.
- Native records or hook payloads may be incomplete, too large, or changed by a release. Mitigation: pin the tested Muse build, preserve source/diagnostic metadata, reconcile inputs and show known gaps rather than silently fabricating a complete session.
- File capture may miss rapid edit/revert sequences or misattribute concurrent/background writes. Mitigation: combine action-aware snapshots with independent filesystem capture, keep uncertain associations labeled, and report the measured limits instead of promising every intermediate state.
- Recorder hooks execute outside Muse's tool sandbox. Mitigation: review the hook commands, keep their filesystem scope narrow, and observe rather than modify or approve agent actions.
- Echo gets read as a log viewer. Mitigation: the refusal, the reverted attempts, and the checks are the answer. The demo shows all three.
- Checks don't measure understanding, or generated questions are ambiguous. Mitigation: execution-verified answers, hand checks, and a stated limit in the submission.
- The sandbox eats days. Mitigation: snippet scope, the simple runner first, and the cut line.
- Muse Code is in beta and behaves unpredictably, or Meta API access, rate limits or structured output fail from Nigeria. Mitigation: test on day one, keep prompts model-agnostic, cache calls by content hash.
- People turn the checks off because they add friction. Mitigation: check only a few risky hunks per session, never everything.
- Secrets leak into Echo artifacts or remain in native-agent logs. Mitigation: redact before all Echo-owned persistence, including snapshot Git objects/index and intermediate files, and before model calls; test with a synthetic secret, show a masked preview, disclose the native-log limit, and use only my own repos for demos.
- Time runs short. Mitigation: the cut-line order in section 7.
- Claims outrun evidence. Mitigation: every number in the submission comes from section 9 or a cited study, with its sample size and limits.
- Echo is read as a basic RAG app or a quiz bot, both on the anti-project list. Mitigation: the pitch and the demo lead with capture, replay, reverted attempts and execution-verified checks.
- The demo or repo blurs what was built during the event, which risks disqualification. Mitigation: a fresh repo on Oct 27, an on-screen statement of what is new and what is Meta's, and a demo repo clearly separate from Echo.
- No working card or credits for the Meta API. Mitigation: sort a dollar card before the first API call, request partner credits, cache model calls, and keep the model layer swappable.
- The live-product check fails because Echo only runs locally. Mitigation: the hosted read-only demo.
- Project-level learning and the visualizations add work to a plan with little slack. Mitigation: bound the project view to an import graph plus an overlay of agent-touched files, and follow the cut-line order.

## 14. Assumptions and things I haven't verified

The Oct 26 first-party documentation check confirms Muse Code's native session log, structured trajectory export, interactive lifecycle hooks, optional transcript reasoning setting, and programmatic JSON/SDK paths. It also confirms related paths for Claude Code, OpenCode V2 and Codex. These are documented capabilities, not tested installations or evidence that any capture path is lossless. Qoder was not verified.

Still unverified:

- The Participant Guide covers the rules, rubric and deadline. I haven't read any longer Official Rules or terms behind it.
- Whether work on Oct 26, including hand inspection of Muse Code's logs, counts toward the building period.
- Whether the Meta Model API works from Nigeria, its rate limits and structured-output reliability, and whether a Nigerian-issued card works for billing. The credit link isn't published yet.
- The installed Muse build's log/export schemas, live ingestion and recovery behaviour, child-log coverage, and what remains after checkpointing or compaction.
- Which full messages and tool results are available beyond hook previews or skipped payloads, and whether optional reasoning text is readable in the captured/exported records.
- How reliably hooks and file capture preserve useful intermediate versions, including shell writes, failures, interruptions and concurrent/background changes.
- Whether a stronger privacy mode using `--no-session-log` can preserve enough evidence, and what other native diagnostic or temporary storage may remain. The documented flag forfeits retained-session features; this is not the default.
- Whether optional PTY playback is worth adding; it is no longer on the core capture path.
- Which Muse Spark version the event API exposes, and how long a session fits in its context.
- Whether Muse Spark Open on Baseten is good enough for the explanation path.
- The Trio developer study: I read secondary coverage only.
- The hunk-risk scoring: a guess until checked against hand labels.
- Whether Echo is free as a name, domain and handle.
- That no equivalent full review/proof loop exists. This rests on product searches from Oct 25; native agent logging and audit/export tools are already known to exist.

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
