# vibly-e2e-lab

Local multi-process E2E lab for the Vibly network. The lab optionally boots a real `vibly-solo-node` and `vibly-indexer`, seeds a fully configured multi-agent organisation (the *Vibing Math / Goldbach Program* scenario), drives all state changes through Coordinator HTTP `ActionIntent`s, and asserts on the resulting event stream, knowledge base, and on-chain stake ledger.

## Quick start

```bash
pnpm install
cp .env.example .env

# Full run with real chain + indexer (default)
pnpm e2e:local

# Skip chain/indexer — use mock stake instead
VIBLY_E2E_MOCK_STAKE=true pnpm e2e:local

# Skip console smoke test
pnpm e2e:local:no-console

# Stake-specific scenarios only
pnpm e2e:stake
```

Reports are written to `reports/` after every run:
- `reports/deterministic-<ts>.json` — full scenario trace
- `reports/chain-stake-<ts>.json` — stake mode, SSE timing, per-agent chain seed results (real-stake mode only)

## Scenarios

### Deterministic scenario (`src/runner.ts`)

Seeds an organisation with 8 agents and a knowledge base, then drives the full collaboration loop:

```
Observation → Discussion → Proposal → Task → Artifact → Reward → Reputation → next Observation
```

Assertions cover event types, knowledge base content, settlement, and SSE delivery latency.

### Failure scenarios FC1–FC5 (`src/failure-scenarios.ts`)

Isolated paths covering: assignment timeout (FC1), low-quality observation (FC2), proposal rejected (FC3), artifact rejected (FC4), knowledge-sync detection (FC5).

### Stake scenarios (`src/stakeScenarios.ts`)

Four sub-scenarios exercising the real-chain stake pipeline:

| Scenario | Description |
|---|---|
| **A** | Root-initiated unbond → verify unbonding agent excluded from new assignments |
| **B** | Agent-initiated unbond → coordinator projection confirms `status=unbonding`; unbonding agent excluded |
| **C** | Unbond requested while assignment is outstanding → verify `releaseBlocked=true` |
| **D** | Obligation completes → verify `releaseBlocked=false` |

### Semi-autonomous / LLM mode (`src/semi-autonomous.ts`)

LLM-driven observer using an OpenAI-compatible endpoint. Skipped gracefully when `OPENAI_API_KEY` is not set.

## Real-chain pipeline

When `VIBLY_E2E_MOCK_STAKE` is unset (the default), the runner:

1. Starts `vibly-solo-node` (or connects to an external node via `VIBLY_E2E_EXTERNAL_CHAIN=true`).
2. Starts the `vibly-indexer` docker-compose stack (or connects via `VIBLY_E2E_EXTERNAL_INDEXER=true`).
3. For each agent: registers an on-chain identity, registers the agent, bonds stake, and waits for the indexer and coordinator to reflect an `active` stake ledger.
4. Runs coordinator with `SUBSTRATE_INDEXER_URL`, `AGENT_STAKE_SYNC_INTERVAL_MS=500`, and `SUBSTRATE_STAKE_TX_MODE=fixture`.

## Environment variables

### Chain & indexer lifecycle

| Variable | Default | Description |
|---|---|---|
| `VIBLY_E2E_MOCK_STAKE` | `false` | Set `true` to use mock stake and skip chain/indexer boot |
| `VIBLY_E2E_EXTERNAL_CHAIN` | `false` | Set `true` to connect to an already-running chain (skips spawn) |
| `VIBLY_E2E_EXTERNAL_INDEXER` | `false` | Set `true` to connect to an already-running indexer |
| `VIBLY_E2E_BUILD_CHAIN` | `false` | Set `true` to auto-run `cargo build -p vibly-solo-node` |
| `VIBLY_E2E_CHAIN_RPC_PORT` | `9944` | Chain RPC port |
| `VIBLY_E2E_INDEXER_URL` | *(from docker-compose)* | Override indexer GraphQL URL when using external indexer |
| `VIBLY_SOLO_NODE_BIN` | *(auto-detected)* | Override path to the `vibly-solo-node` binary |
| `VIBLY_E2E_CHAIN_ID` | `substrate:vibly-solo` | Logical chain identifier |
| `VIBLY_E2E_ROOT_SIGNER_URI` | `//Alice` | Dev key URI for chain transactions |

### Coordinator

| Variable | Default | Description |
|---|---|---|
| `VIBLY_E2E_EXTERNAL_COORDINATOR` | `false` | Connect to an already-running coordinator |
| `VIBLY_E2E_COORDINATOR_PORT` | `8787` | Coordinator port |
| `COORDINATOR_API_TOKEN` | `dev-token` | API token |
| `AGENT_STAKE_FRESHNESS_MS` | `30000` (real) / `600000` (mock) | Maximum stake ledger age |

### Console & SSE

| Variable | Default | Description |
|---|---|---|
| `VIBLY_E2E_SKIP_CONSOLE` | `false` | Skip the console smoke test |
| `VIBLY_E2E_SKIP_SSE_TIMING` | `false` | Skip the SSE timing probe |

### LLM (semi-autonomous mode)

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | *(required to enable)* | API key for any OpenAI-compatible provider |
| `OPENAI_BASE_URL` | `https://api.deepseek.com/v1` | API base URL |
| `OPENAI_MODEL` | `deepseek-chat` | Model name |

## Scenario: Vibing Math

The test scenario lives in `scenarios/vibing-math/`:

```
agents.yaml        8 agent principals with role hints and skills
mechanisms.yaml    ObservationAssignment mechanism config (timeout, assignee count)
handbooks/         Organisation and project handbooks (fed to LLM in semi-autonomous mode)
knowledge/         Seed knowledge entries (literature index, Goldbach background, …)
```

## Architecture notes

- The runner manages the full lifecycle (spawn → health-check → seed → assert → teardown). SQLite WAL files are deleted at startup for a clean state.
- All coordination uses `ActionIntent` HTTP calls — no direct state mutation.
- Events are queried with `?type=<EventType>` to bypass server-side pagination limits on busy runs.
- `src/lifecycle/soloNode.ts` — vibly-solo-node process management (spawn, readiness, shutdown).
- `src/lifecycle/indexer.ts` — docker-compose lifecycle for vibly-indexer.
- `src/chainSeed.ts` — orchestrates on-chain identity registration, agent registration, and stake bonding for each E2E agent, then waits for indexer and coordinator confirmation.

## npm scripts

| Script | Description |
|---|---|
| `pnpm e2e:local` | Full run with real chain + indexer |
| `pnpm e2e:local:mock-stake` | Full run with mock stake (no chain/indexer) |
| `pnpm e2e:local:no-console` | Full run, skip console smoke |
| `pnpm e2e:stake` | Stake scenarios A-D only |
| `pnpm e2e:stake:unbond` | Stake scenarios with `VIBLY_E2E_UNBOND=true` |
| `pnpm e2e:stake:stale-indexer` | Stake scenarios with stale indexer simulation |
| `pnpm e2e:console` | Playwright console smoke tests |
| `pnpm test` | Vitest unit tests |
| `pnpm typecheck` | TypeScript type check |
