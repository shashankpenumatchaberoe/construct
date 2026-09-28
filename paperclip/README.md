# Paperclip — Construct company

Setup for a [Paperclip](https://github.com/paperclipai/paperclip) company staffed to work
on the Trace project (`../trace/`, formerly `line-matcher/`) inside this repo.

Paperclip is a *meta-harness*: it doesn't replace Claude Code / Codex / Hermes, it employs
them. Agents are employees, they talk through tasks rather than open chat, and work lands
through approvals. This mirrors the existing `~/Repositories/paperclip/` company (max-ai-ui
frontend team) — that one is untouched; this is a separate company for this repo.

## Status

- [ ] Paperclip installed — not yet done, needs to be run by hand (see "Install" below)
- [x] Company charter written — [01-company-charter.md](01-company-charter.md)
- [x] Job descriptions written — [team/](team/)
- [ ] No engineering work has moved into Paperclip yet. Onboarding is structural only: the
      company, its charter, and its team exist so the Delivery Manager and Leads can start
      routing work, but Trace's existing builder/reviewer subagent workflow
      (`trace/CLAUDE.md`) keeps doing the actual code changes for now.

## Install

Same installer as the max-ai-ui company — one Paperclip service can run multiple companies.
If that service is already running (check with `paperclipai service status`), skip straight
to "Then build the company."

```bash
cd /Users/shashank/Repositories/paperclip && curl -fsSLO https://paperclip.ing/install.sh && curl -fsSLO https://paperclip.ing/install.sh.sha256 && shasum -a 256 -c install.sh.sha256 && bash install.sh
```

The checksum check must print `install.sh: OK` before the last step runs — the `&&` chain
already enforces that. Then:

```bash
paperclipai onboard --yes && paperclipai service status
```

Onboarding asks for an AI account for the employees. Either export `ANTHROPIC_API_KEY`
first or point it at the Claude subscription when asked. The API comes up on
`http://localhost:3100`.

## Then build the company

1. Create the company ("Construct") and hire the Delivery Manager first (harness
   `claude_local`, Opus).
2. Paste [01-company-charter.md](01-company-charter.md) in as the company rules.
3. Hire the four project Leads, pasting each file in [team/](team/) as the job
   description. Adapter types are `claude_local`, `codex_local`, `opencode_local`.
4. Give every employee the repo path `/Users/shashank/Repositories/construct`.

`npx paperclipai openapi` prints the real payload schema if you'd rather create them from
the CLI than the UI — the exact field list isn't in the public docs.

## Reference

- [paperclipai/paperclip](https://github.com/paperclipai/paperclip) — the project
- [theNetworkChuck/paperclip-guide](https://github.com/theNetworkChuck/paperclip-guide) — companion guide, 11 chapters
- [doc/CLI.md](https://github.com/paperclipai/paperclip/blob/master/doc/CLI.md) — CLI reference
- `~/Repositories/paperclip/` — the max-ai-ui company, set up first; this one follows its shape
