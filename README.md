# vibly-e2e-lab

> 中文文档：[README.zh.md](README.zh.md)

Local multi-agent social simulation E2E lab for Vibly. The lab spins up a real `vibly-coordinator` process, seeds a fully configured multi-agent organization (the *Vibing Math / Goldbach Program* scenario), drives all state changes through Coordinator HTTP `ActionIntent`s, and asserts on the resulting event stream and knowledge base.

## Quick start

```bash
pnpm install
pnpm e2e:local            # full run including semi-autonomous LLM mode (requires .env)
VIBLY_E2E_SKIP_CONSOLE=true pnpm e2e:local   # skip console smoke, faster CI
```

A JSON report is written to `reports/deterministic-<timestamp>.json` after every run.

## What runs

| Phase | Description | Key source |
|-------|-------------|------------|
| **Deterministic scenario** | Seeds org + project + 8 agents + knowledge base; drives the full collaboration loop (Observation → Discussion → Proposal → Task → Artifact → Reward → Reputation → next Observation) | `src/runner.ts` |
| **Failure scenarios FC1–FC5** | Isolated failure paths: assignment timeout (FC1), low-quality observation (FC2), proposal rejected (FC3), artifact rejected (FC4), knowledge-sync detection (FC5) | `src/failure-scenarios.ts` |
| **Semi-autonomous mode** | LLM-driven observer using an OpenAI-compatible API (DeepSeek by default); 8 steps, 5 assertions | `src/semi-autonomous.ts` |

## Semi-autonomous / LLM mode

Copy `.env.example` to `.env` and fill in your API key:

```bash
cp .env.example .env
# edit .env — set OPENAI_API_KEY (and optionally OPENAI_BASE_URL / OPENAI_MODEL)
```

The default config targets [DeepSeek](https://platform.deepseek.com):

```env
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-chat
```

Any OpenAI-compatible endpoint works (OpenAI, Anthropic proxy, local Ollama, etc.). Semi-autonomous mode is skipped gracefully when `OPENAI_API_KEY` is not set.

## Scenario: Vibing Math

The test scenario lives in `scenarios/vibing-math/`:

```
agents.yaml        — 8 agent principals with role hints and skills
mechanisms.yaml    — ObservationAssignment mechanism config (timeout, assignee count)
handbooks/         — Organization and project handbooks (fed to LLM in SA mode)
knowledge/         — Seed knowledge entries (literature index, Goldbach background, …)
```

## Architecture notes

- The runner manages the full coordinator lifecycle (spawn → health-check → seed → assert → teardown). The SQLite database and WAL journal are deleted on every run for a clean state.
- All coordination uses `ActionIntent` HTTP calls — no direct state mutation.
- Events are queried with `?type=<EventType>` to bypass the server-side `max=200` pagination cap for busy runs.
- The lab has no dependency on `vibly-chain` or `vibly-indexer`; those are out of scope for local E2E.
