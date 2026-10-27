# Spike: Muse 1.4.13 providers, credentials and external-model access

Date: 2026-10-27. Related Phase 0 items: model/API access, capture prerequisites.

**Result: Muse Code cannot be pointed at an arbitrary OpenAI-compatible router.** Confirmed by probe, not assumption. Also resolved the "not full access" symptom: the stored Meta credential is gone.

## Probe matrix (Muse Code 1.4.13, scratch repo `~/dev/echo-spike-scratch`)

| Attempt | Command shape | Result |
| --- | --- | --- |
| Local provider, arbitrary model | `muse --provider local --model <router-model>` | Hard refusal: "The Local provider supports only glimmer." |
| Local provider, no model | `muse --provider local` | Same refusal. |
| Local provider, `--model glimmer` | `muse --trust-workspace --provider local --model glimmer` | Boots into TUI without any credential. Interactive only (`muse exec` accepts `echo\|meta`). Serving unverified. |
| Meta provider + external base URL | `muse exec --provider meta --base-url <router>/v1 --model <router-model>` | Clean error: "missing meta credential in ~/.config/muse/auth.json: run `muse login` or set META_API_KEY". Even with a credential, the Meta provider speaks Meta's wire format; OpenAI-compatible routers do not. |
| Credential storage | `muse auth set --help` | `--provider` accepts only `meta`. |
| Headless provider choice | `muse exec --help` | `--provider echo\|meta` only. |

Conclusion: three provider modes only — `echo`, `meta`, `local`(=glimmer). External routers are unreachable through the CLI surface. If a non-Meta model is ever needed for capture, the vehicle is OpenCode V2 (the documented second path), not Muse.

## Access state observed

- `~/.config/muse/auth.json`: `providers: []` (empty).
- `muse usage`: "not logged in: run `muse login` first".
- `muse exec`: "missing meta credential".
- Oct 26 sessions worked with `credential_backend: "file"`, `keychain_fallback_reason: "none"` (`session.opened.observed` record) — so a file-stored credential existed yesterday and is gone today. Cause unknown (logout, trial expiry, or manual clearing).
- User `settings.json`: `{"provider": "meta", "model": "muse-spark-1.3-contributor"}` — the contributor-mode model, likely relevant to the user's quota/features.

## Unblock paths for the tool-using-session spike, in order

1. `muse login` (browser OAuth) — restores Meta access interactively.
2. `META_API_KEY` env or `muse auth set --provider meta --api-key-stdin` — from the event's API credits (requires card on account; also a Phase 0 checklist item).
3. `muse --provider local --model glimmer` in a real terminal — no credential needed; if Glimmer serves tools, the spike proceeds at zero Meta quota. Session schema is provider-independent, so spike data from Glimmer is valid for the reader; demo tapes stay on Meta models for the rubric.
4. OpenCode V2 + the user's AgentRouter config (already serves `gpt-6.1-sol` et al.) — cut-line item 7; capture data only, does not advance the Muse reader.

## Other CLI facts recorded in passing

- Trust is per exact project root (`~/.config/muse/trust.json`); `--trust-workspace` covers a single non-interactive run.
- `muse exec` exists for headless runs (valid tool-session vehicle once a credential exists).
- `muse schema generate-json-schema|generate-ts --out DIR` exports the full MSP wire schema offline (380 definitions) — adapter type source, pending reconciliation spike.
- `muse model-profile`, `muse sandbox`, `muse skills`, `muse plugins` subcommands exist; not yet exercised.
