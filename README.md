# vibly-e2e-lab

Local multi-process E2E lab for the Vibly network. The lab optionally boots a real `vibly-solo-node` and `vibly-indexer`, seeds a fully configured multi-agent organisation (the *Vibing Math / Goldbach Program* scenario), drives all state changes through Coordinator HTTP `ActionIntent`s, and asserts on the resulting event stream, knowledge base, and on-chain stake ledger.

## Quick start

```bash
pnpm install
cp .env.example .env

# Full run with real chain + indexer (default)
pnpm e2e:local

# Live LLM run with multiple real vibly-client daemons.
# If VIBLY_E2E_RUN_NAME is unset, this creates a fresh timestamped run.
# This keeps Coordinator/Console/agents running after success for inspection.
pnpm e2e:live-llm

# Reset a specific named run and start it fresh
VIBLY_E2E_RUN_NAME=my-run pnpm e2e:live-llm:fresh

# CI-style live run that exits and cleans up after success
pnpm e2e:live-llm:ci

# Resume a named live LLM run
VIBLY_E2E_RUN_NAME=my-run pnpm e2e:live-llm:resume

# Skip chain/indexer — use mock stake instead
VIBLY_E2E_MOCK_STAKE=true pnpm e2e:local

# Skip console smoke test
pnpm e2e:local:no-console

# Manual Get VIB Console lab. Keeps local chains, Coordinator, and Console running
# for browser interaction; no Playwright and no agent daemons. The local claim
# root uploader is enabled by default and uploads every 2 minutes.
pnpm dev:get-vib-console

# If the lab runs on a remote server and you SSH-forward local 3002 -> remote 3001:
VIBLY_E2E_PUBLIC_CONSOLE_PORT=3002 pnpm dev:get-vib-console

# Manual Get VIB labs default to a production Console server
# (`next build && next start`) so SSH-forwarded browsers do not hit Next HMR
# WebSocket failures. Use this only when you need hot reload while editing UI.
VIBLY_E2E_CONSOLE_MODE=dev pnpm dev:get-vib-console

# Production-like Get VIB Console lab for Lumen/Paseo.
# Reads ../vibly-coordinator/cloud-run.env.yaml and
# ../vibly-coordinator/network-manifest.production.json, starts a local
# Coordinator + Console, and does not start a local payment chain.
# By default this is conversion-only: it connects to Paseo, but disables
# Vibly claim/balance features so it will not use production Lumen RPC.
pnpm dev:get-vib-console:paseo

# Same SSH-forwarding shape as above:
VIBLY_E2E_PUBLIC_CONSOLE_PORT=3002 pnpm dev:get-vib-console:paseo

# To test claim/balance against a local Vibly chain, opt in explicitly.
# A loopback RPC URL starts and initializes a local vibly-solo-node.
VIBLY_E2E_VIBLY_RPC_URLS=ws://127.0.0.1:9944 pnpm dev:get-vib-console:paseo

# To attach to an already-running local Vibly chain instead:
VIBLY_E2E_EXTERNAL_VIBLY_CHAIN=true \
VIBLY_E2E_VIBLY_RPC_URLS=ws://127.0.0.1:9944 \
pnpm dev:get-vib-console:paseo

# Cross-repo deployment planner / orchestrator
pnpm deploy:all
pnpm deploy:build
pnpm deploy:gcp:plan
pnpm deploy:npm:plan

# Stake-specific scenarios only
pnpm e2e:stake
```

Reports are written to `reports/` after every run:
- `reports/deterministic-<ts>.json` — full scenario trace
- `reports/chain-stake-<ts>.json` — stake mode, SSE timing, per-agent chain seed results (real-stake mode only)
- `reports/live-llm-<ts>.json` — persistent live LLM run summary
- `reports/live-llm-content-<ts>.md` — readable generated content: observations, proposal body, discussion, reviews, artifacts, and knowledge entries
- `data/live-runs/<runName>/state.json` — resumable live LLM checkpoint state

## Deployment orchestrator

`src/deploy.ts` gives us one shared entrypoint for release prep across all main repos. It tracks each repository's path, its default build command, and an optional deploy hook loaded from env.

Recommended production topology:

- `vibly-chain`: deploy `vibly-solo-node` to a VM or bare-metal host with `systemd`
- `vibly-indexer`: deploy on a VM with Docker Compose because it runs Postgres + SubQuery services
- `vibly-coordinator`: deploy on Cloud Run or another stateless app host, backed by external Postgres
- `vibly-console`: deploy on Cloud Run when using Auth.js proxy mode; static hosting is suitable only for direct/public mode

The built-in `--profile=gcp` now covers two common VM flows for `vibly-chain`:

- `GCP_VIBLY_CHAIN_DEPLOY_MODE=upload`: build locally, upload the binary, restart `systemd`
- `GCP_VIBLY_CHAIN_DEPLOY_MODE=remote-build`: ssh into the VM, clone/update the chain repo if needed, build there, then restart `systemd`

For repeatable production rollouts, local build + artifact upload is usually faster. Use remote build when the target host ABI/toolchain must exactly match the build output, such as when the local and VM `glibc` versions differ. Remote build uses `GCP_VIBLY_CHAIN_REPO_URL` when set, otherwise the local repo's `origin` URL.

When `remote-build` is selected, the deploy planner skips the local `cargo build` by default because the local binary is not used. Set `GCP_VIBLY_CHAIN_LOCAL_PREBUILD=true` if you still want a local compile check before SSH deployment.

Managed project ids:

- `concord`
- `vibly-chain`
- `vibly-client`
- `vibly-console`
- `vibly-coordinator`
- `vibly-docs`
- `vibly-e2e-lab`
- `vibly-indexer`
- `vibly-coordinator-http-contract`

`vibly-site`, `vibly-library`, and `archelabs-site` are intentionally not managed here because they are deployed through their own GitHub Pages workflows.

Examples:

```bash
# Safe default: print the plan only
pnpm deploy:all

# List project ids before selecting a subset
pnpm deploy:all -- --list

# Build every registered repo
pnpm deploy:build

# Build + deploy only selected projects
VIBLY_DEPLOY_TARGET=lumen \
VIBLY_DEPLOY_VIBLY_CONSOLE_CMD="pnpm build && gcloud run deploy vibly-console --source ." \
VIBLY_DEPLOY_VIBLY_COORDINATOR_CMD="pnpm build && gcloud run deploy vibly-coordinator --source ." \
pnpm deploy:all -- --phase=full --only=vibly-console,vibly-coordinator

# Intentionally allow uncommitted changes
pnpm deploy:all -- --phase=build --allow-dirty
```

Useful flags:

| Flag | Description |
|---|---|
| `--phase=plan` | Default. Print what would run |
| `--phase=build` | Run build/typecheck commands only |
| `--phase=deploy` | Run deploy hooks only |
| `--phase=full` | Build first, then run deploy hooks |
| `--list` | List registered project ids and build commands |
| `--only=a,b` | Restrict to specific project ids |
| `--skip=a,b` | Exclude specific project ids |
| `--allow-dirty` | Do not fail on uncommitted changes |
| `--continue-on-error` | Keep processing later projects after a failed project |
| `--require-deploy-hook` | Fail deploy/full phases if a selected project has no deploy hook |
| `--dry-run` | Print commands without executing them |
| `--target=name` | Pass a target label via `VIBLY_DEPLOY_TARGET` |

Deploy hooks are opt-in and per repo. The hook env name is:

```bash
VIBLY_DEPLOY_<PROJECT_ID>_CMD
```

For example, `vibly-console` maps to `VIBLY_DEPLOY_VIBLY_CONSOLE_CMD`.

Plan output prints each build command and resolved deploy command. Built-in profiles also show missing env vars, such as `GCP_PROJECT_ID` or `GCP_REGION`, instead of silently skipping that project.

Each run writes a JSON summary to `reports/deploy-<timestamp>.json`.

### Built-in templates

Two profiles are built in:

- `--profile=gcp` for Google Cloud deployment hooks
- `--profile=npm` for npm package publishing hooks

Template env files live here:

- [templates/deploy/gcp.env.example](/home/libingjiang47/vibly-e2e-lab/templates/deploy/gcp.env.example)
- [templates/deploy/npm-publish.env.example](/home/libingjiang47/vibly-e2e-lab/templates/deploy/npm-publish.env.example)
- [templates/deploy/bootstrap-vibly-indexer-vm.sh](/home/libingjiang47/vibly-e2e-lab/templates/deploy/bootstrap-vibly-indexer-vm.sh)

For Coordinator production deploys, also prepare the env yaml that lives in the
`vibly-coordinator` repo:

- [../vibly-coordinator/templates/cloud-run.env.yaml.example](/home/libingjiang47/vibly-coordinator/templates/cloud-run.env.yaml.example)

Examples:

```bash
# GCP plan / deploy
set -a
source templates/deploy/gcp.env.example
set +a
pnpm deploy:gcp:plan
pnpm deploy:gcp -- --only=vibly-chain,vibly-indexer,vibly-coordinator,vibly-console

# npm plan / publish
set -a
source templates/deploy/npm-publish.env.example
set +a
pnpm deploy:npm:plan
pnpm deploy:npm
```

The built-in GCP coordinator deploy now requires these explicit inputs:

- `GCP_VIBLY_COORDINATOR_ENV_FILE`
- `GCP_VIBLY_COORDINATOR_CLOUDSQL_INSTANCE`

That means production DB settings such as `STORAGE_MODE=postgres` and `DATABASE_URL`
must live in the Coordinator env yaml, while the Cloud SQL attachment is passed as a
first-class deploy variable instead of being hidden inside `GCP_VIBLY_COORDINATOR_FLAGS`.

For a stricter production run, combine `--phase=full --require-deploy-hook` so every selected project must have either a built-in profile command or an explicit `VIBLY_DEPLOY_<PROJECT_ID>_CMD`.

### Production notes

- `vibly-indexer` is included in the deploy planner, but it is not a serverless service. A correct hosted deployment must still run its Docker Compose stack or an equivalent Postgres + SubQuery topology.
- `vibly-coordinator` is also not fully serverless in practice. The app process can run on Cloud Run, but `STORAGE_MODE=postgres` and an external Postgres database are mandatory in production. Coordinator startup runs migrations against that database.
- The built-in GCP deploy profile now enforces that requirement explicitly: it will fail unless `GCP_VIBLY_COORDINATOR_ENV_FILE` points at an existing Coordinator env yaml and `GCP_VIBLY_COORDINATOR_CLOUDSQL_INSTANCE` is set.
- Public `Lumen` and `Monolith` environments do not need a separately deployed local payment chain. `Lumen` uses Paseo RPCs for relay-side transfers; `Monolith` uses Polkadot mainnet RPCs. The extra payment chain only exists in local E2E / manual Get VIB labs.
- `pnpm deploy:npm` now defaults to the actual npm-publishable projects only: `concord`, `vibly-client`, and `vibly-coordinator-http-contract`. Pass `--only=...` if you want to override that default selection.
- The built-in npm profile is now Access Token-first. Set `NPM_TOKEN` or `NODE_AUTH_TOKEN`; the deploy script maps `NPM_TOKEN` into `NODE_AUTH_TOKEN`, generates a temporary `.npmrc`, and no longer expects an OTP field.
- The npm profile now fails earlier with clearer messages: it checks `npm whoami` first, and for single-package publishes it also rejects already-published versions before running `pnpm publish`.

### Bootstrap a fresh indexer VM

Use the bootstrap script once on a new Debian/Ubuntu VM before the normal deploy flow:

```bash
gcloud compute scp templates/deploy/bootstrap-vibly-indexer-vm.sh \
  vibly-indexer-vm:/tmp/bootstrap-vibly-indexer-vm.sh \
  --zone asia-east1-b

gcloud compute ssh vibly-indexer-vm --zone asia-east1-b --command "
  sudo REPO_URL=git@github.com:your-org/vibly-indexer.git \
       REPO_BRANCH=main \
       CHAIN_ENDPOINT=ws://127.0.0.1:9944 \
       bash /tmp/bootstrap-vibly-indexer-vm.sh
"
```

After that, `pnpm deploy:gcp -- --only=vibly-indexer` can reuse the prepared remote directory and only refresh repo/build/compose state.

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

### Live LLM mode (`src/live-vibing-math.ts`)

Starts multiple real `vibly-client daemon start` processes with `daemon.llmE2E=true`. Each daemon reads its own inbox, calls the configured OpenAI-compatible LLM endpoint, and submits normal Coordinator `ActionIntent`s for observations, discussions, proposals, reviews, artifacts, and reward claims. The runner only seeds/resumes the scenario and waits for milestones.

### Lumen VibMath live agent bootstrap

Use this command to bootstrap the VibMath / Goldbach Program live-agent scenario against the Lumen testnet:

```bash
pnpm e2e:vibmath:lumen
```

This mode reuses `scenarios/vibing-math` and assumes external Lumen services:

* external Coordinator
* external Vibly chain RPC
* external Indexer GraphQL
* local `vibly-client` agent daemons

Required environment variables:

```bash
LUMEN_COORDINATOR_URL=
LUMEN_CHAIN_RPC_URL=
LUMEN_INDEXER_GRAPHQL_URL=
COORDINATOR_API_TOKEN=
VIBLY_E2E_ROOT_SIGNER_URI=
VIBLY_E2E_CHAIN_ID=substrate:lumen
VIBLY_E2E_TESTNET_SEED=true
```

Optional shared identity mode:

```bash
VIBLY_E2E_SHARED_IDENTITY_ID=<identity-id>
```

When `VIBLY_E2E_SHARED_IDENTITY_ID` is set, all agents reuse the same chain identity, while each agent still registers its own chain agent and bonds independently.

Pause and resume agents:

```bash
VIBLY_E2E_RUN_NAME=my-lumen-run pnpm e2e:vibmath:lumen:pause-agents
VIBLY_E2E_RUN_NAME=my-lumen-run pnpm e2e:vibmath:lumen:resume-agents
```

To start from scratch:

```bash
VIBLY_E2E_RUN_NAME=my-lumen-run pnpm e2e:vibmath:lumen:fresh
```

To resume a checkpointed run:

```bash
VIBLY_E2E_RUN_NAME=my-lumen-run pnpm e2e:vibmath:lumen:resume
```

## Real-chain pipeline

E2E commands boot or verify the whole network profile: Coordinator, Console, Vibly chain, and a separate payment chain. Local runs fail fast if `vibly-solo-node` cannot be started; use `VIBLY_E2E_BUILD_CHAIN=true` to build it automatically.

The public remote profiles exposed by the lab follow the current naming:

- `substrate:vibly-testnet` -> `Lumen`
- `substrate:vibly-incentivized-testnet` -> `Monolith`

When `VIBLY_E2E_MOCK_STAKE` is unset, the runner also enables the real stake path:

1. Starts the `vibly-indexer` docker-compose stack (or connects via `VIBLY_E2E_EXTERNAL_INDEXER=true`).
2. For each agent: registers an on-chain identity, registers the agent, bonds stake, and waits for the indexer and coordinator to reflect an `active` stake ledger.
3. Runs coordinator with `SUBSTRATE_INDEXER_URL`, `AGENT_STAKE_SYNC_INTERVAL_MS=500`, and `SUBSTRATE_STAKE_TX_MODE=fixture`.

## Environment variables

### Chain & indexer lifecycle

| Variable | Default | Description |
|---|---|---|
| `VIBLY_E2E_MOCK_STAKE` | `false` | Set `true` to force mock stake and skip chain/indexer boot |
| `VIBLY_E2E_USE_REAL_STAKE` | `false` | Set `true` to require the real chain path instead of auto-falling back to mock stake |
| `VIBLY_E2E_EXTERNAL_CHAIN` | `false` | Set `true` to connect to an already-running chain (skips spawn) |
| `VIBLY_E2E_EXTERNAL_INDEXER` | `false` | Set `true` to connect to an already-running indexer |
| `VIBLY_E2E_BUILD_CHAIN` | `false` | Set `true` to auto-run `cargo build -p vibly-solo-node` |
| `VIBLY_E2E_CHAIN_RPC_PORT` | `9944` | Chain RPC port |
| `VIBLY_E2E_PAYMENT_CHAIN_RPC_PORT` | `9945` | Payment-chain RPC port used by Get VIB balance reads/transfers |
| `VIBLY_E2E_INDEXER_URL` | *(from docker-compose)* | Override indexer GraphQL URL when using external indexer |
| `VIBLY_SOLO_NODE_BIN` | *(auto-detected)* | Override path to the `vibly-solo-node` binary |
| `VIBLY_E2E_CHAIN_ID` | `substrate:vibly-solo` | Logical chain identifier |
| `VIBLY_E2E_ROOT_SIGNER_URI` | `//Alice` | Dev key URI for chain transactions |
| `VIBLY_E2E_PASEO_RPC_URLS` | built in | Comma-separated Paseo payment RPC fallback list |
| `VIBLY_E2E_POLKADOT_RPC_URLS` | built in | Comma-separated Polkadot payment RPC fallback list |

### Coordinator

| Variable | Default | Description |
|---|---|---|
| `VIBLY_E2E_EXTERNAL_COORDINATOR` | `false` | Connect to an already-running coordinator |
| `VIBLY_E2E_COORDINATOR_PORT` | `8787` | Coordinator port |
| `COORDINATOR_API_TOKEN` | `dev-token` | API token |

### Console & SSE

| Variable | Default | Description |
|---|---|---|
| `VIBLY_E2E_SKIP_CONSOLE` | `false` | Skip the console smoke test |
| `VIBLY_E2E_SKIP_SSE_TIMING` | `false` | Skip the SSE timing probe |
| `VIBLY_E2E_PUBLIC_CONSOLE_PORT` | `VIBLY_E2E_CONSOLE_PORT` | Browser-facing forwarded port for manual Console labs, e.g. local `3002` forwarding remote `3001` |
| `VIBLY_E2E_PUBLIC_CONSOLE_URL` | derived from port | Full browser-facing Console URL for SSH/proxy setups; overrides `VIBLY_E2E_PUBLIC_CONSOLE_PORT` |
| `VIBLY_E2E_CONSOLE_MODE` | `production` for manual Get VIB labs, `dev` elsewhere | Use `production` to avoid Next dev HMR WebSocket traffic over SSH forwards; use `dev` for hot reload |
| `GET_VIB_ROOT_UPLOAD_INTERVAL_MS` | `120000` in Get VIB local labs | Local Get VIB claim-root upload cadence. Set to `0` to disable automatic uploads. |
| `VIBLY_E2E_COORDINATOR_ENV_FILE` | `../vibly-coordinator/cloud-run.env.yaml` | Production-like Coordinator env yaml used by `dev:get-vib-console:paseo` |
| `VIBLY_E2E_NETWORK_MANIFEST_FILE` | `../vibly-coordinator/network-manifest.production.json` | Network manifest source used by `dev:get-vib-console:paseo`; the lab rewrites `coordinatorUrls` to the local Coordinator |
| `VIBLY_E2E_VIBLY_RPC_URLS` | empty | Optional comma-separated Vibly chain RPC URLs for `dev:get-vib-console:paseo`; when empty, the lab is conversion-only and disables Vibly claim/balance features instead of using production Lumen RPC. A loopback URL starts a local Vibly chain unless `VIBLY_E2E_EXTERNAL_VIBLY_CHAIN=true` |
| `VIBLY_E2E_EXTERNAL_VIBLY_CHAIN` | `false` | Attach to an already-running local Vibly chain instead of starting one when `VIBLY_E2E_VIBLY_RPC_URLS` points at loopback |
| `VIBLY_E2E_PASEO_START_BLOCK` | finalized head minus lookback | Explicit relay watcher start block for `dev:get-vib-console:paseo` |
| `VIBLY_E2E_PASEO_LOOKBACK_BLOCKS` | `20` | Number of finalized Paseo blocks to scan backwards on startup when no explicit start block is provided |
| `VIBLY_E2E_PASEO_WATCHER` | `true` | Set to `false` to disable the Paseo deposit watcher loop |

### LLM (semi-autonomous mode)

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | *(required to enable)* | API key for any OpenAI-compatible provider |
| `OPENAI_BASE_URL` | `https://api.deepseek.com/v1` | API base URL |
| `OPENAI_MODEL` | `deepseek-chat` | Model name |

### Live LLM mode

| Variable | Default | Description |
|---|---|---|
| `VIBLY_E2E_RUN_NAME` | timestamped run | Durable run name used for `data/live-runs/<runName>/`; set it for resume |
| `VIBLY_E2E_COORDINATOR_START_TIMEOUT_MS` | `120000` | Coordinator `/health` startup timeout for local runs |
| `VIBLY_E2E_RESET_RUN` | `false` | Delete existing state for the named run before starting |
| `VIBLY_E2E_PAUSE_AT` | *(unset)* | Pause boundary: `after-seed`, `after-first-observation`, `after-proposal`, `after-artifacts`, `after-knowledge-sync`, `before-second-observation` |
| `VIBLY_E2E_AGENT_CHAIN_MAP` | *(unset)* | JSON map for external/testnet preseeded stake bindings, keyed by agent id or principal id |
| `VIBLY_E2E_TESTNET_SEED` | `false` | If `true`, seed testnet chain identities/stake using `vibly-client` CLI instead of using preseeded bindings |
| `VIBLY_E2E_CHAIN_RPC_URL` | *(unset)* | External/testnet chain RPC URL when seeding testnet |
| `VIBLY_E2E_TESTNET_BOND_AMOUNT` | `100` | Bond amount for testnet seed mode |
| `VIBLY_E2E_ENABLE_GET_VIB_LOCAL` | `false` | Enable local Get VIB relay watcher wiring for live LLM runs |
| `VIBLY_E2E_GET_VIB_RELAY_RPC` | local chain ws URL | Override relay RPC for local Get VIB wiring |
| `VIBLY_E2E_GET_VIB_DEPOSIT_ADDRESS` | Alice dev address | Override local Get VIB deposit address |
| `VIBLY_E2E_SKIP_CONSOLE` | `false` | Skip starting Console during live LLM runs |
| `VIBLY_E2E_CONSOLE_START_TIMEOUT_MS` | `240000` | Console dev server startup timeout; e2e starts Console with polling watchers by default |
| `VIBLY_E2E_KEEP_ALIVE_ON_SUCCESS` | script-dependent | Keep services running after success; enabled by `pnpm e2e:live-llm` |

Live LLM examples:

```bash
# Local live run. Requires a local solo-node binary, or set VIBLY_E2E_BUILD_CHAIN=true.
VIBLY_E2E_RUN_NAME=local-live pnpm e2e:live-llm

# Local live run. Mock stake still boots Vibly/payment chains, but skips indexer stake sync.
VIBLY_E2E_MOCK_STAKE=true VIBLY_E2E_RUN_NAME=local-live pnpm e2e:live-llm

# Local live run with Get VIB local relay wiring enabled (for Console Get VIB page smoke).
VIBLY_E2E_MOCK_STAKE=true VIBLY_E2E_RUN_NAME=local-live pnpm e2e:live-llm:get-vib-local

# Pause at a named boundary, then resume later.
VIBLY_E2E_MOCK_STAKE=true VIBLY_E2E_RUN_NAME=local-live VIBLY_E2E_PAUSE_AT=after-proposal pnpm e2e:live-llm
VIBLY_E2E_MOCK_STAKE=true VIBLY_E2E_RUN_NAME=local-live pnpm e2e:live-llm:resume

# Attach to an existing testnet coordinator. Preseeded agent bindings can be supplied as JSON.
COORDINATOR_URL=https://coordinator.example \
COORDINATOR_API_TOKEN=... \
VIBLY_E2E_RUN_NAME=testnet-live \
VIBLY_E2E_AGENT_CHAIN_MAP='{"observer-agent-1":{"identityId":"...","chainAgentId":"..."}}' \
pnpm e2e:live-llm:testnet
```

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
| `pnpm e2e:live-llm` | Persistent live LLM multi-agent Vibing Math run |
| `pnpm e2e:live-llm:ci` | Live LLM run that exits and cleans up after success |
| `pnpm e2e:live-llm:fresh` | Reset a named live LLM run and start it fresh |
| `pnpm e2e:live-llm:resume` | Resume a named live LLM run |
| `pnpm e2e:live-llm:get-vib-local` | Live LLM run with local Get VIB relay wiring enabled |
| `pnpm e2e:live-llm:resume:get-vib-local` | Resume live LLM run with local Get VIB relay wiring enabled |
| `pnpm e2e:live-llm:testnet` | Attach live LLM run to external/testnet coordinator |
| `pnpm e2e:get-vib` | Get VIB flow smoke: quote/order/finalize/manifest/summary/proof/records, with optional chain claim when chain RPC is configured |
| `pnpm e2e:get-vib:polkadot-local` | Local Polkadot relay + local chain Get VIB flow: relay deposit observation/finalize + on-chain claim verification |
| `pnpm dev:get-vib-console` | Manual Get VIB Console lab: starts local Vibly/payment chains, Coordinator, and Console; keeps them alive for browser testing; does not run Playwright or agents |
| `pnpm dev:get-vib-console:paseo` | Production-like Manual Get VIB Console lab: starts local Coordinator/Console with a Paseo-backed manifest and no local payment chain |
| `pnpm deploy:all` | Cross-repo deployment planner/orchestrator. Default phase is `plan` |
| `pnpm deploy:build` | Cross-repo build orchestration across all registered repos |
| `pnpm deploy:gcp:plan` | Preview built-in Google Cloud deploy hooks |
| `pnpm deploy:gcp` | Execute built-in Google Cloud deploy hooks |
| `pnpm deploy:npm:plan` | Preview built-in npm publish hooks |
| `pnpm deploy:npm` | Execute built-in npm publish hooks |
| `pnpm e2e:stake` | Stake scenarios A-D only |
| `pnpm e2e:stake:unbond` | Stake scenarios with `VIBLY_E2E_UNBOND=true` |
| `pnpm e2e:stake:stale-indexer` | Stake scenarios with stale indexer simulation |
| `pnpm e2e:console` | Starts the local network profile and runs Playwright console smoke tests |
| `pnpm test` | Vitest unit tests |
| `pnpm typecheck` | TypeScript type check |
