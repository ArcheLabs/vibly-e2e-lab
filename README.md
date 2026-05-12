# vibly-e2e-lab

Local multi-agent social simulation E2E lab for Vibly.

## Phase 1

The stable baseline is deterministic:

```bash
pnpm install
VIBLY_E2E_SKIP_CONSOLE=true pnpm e2e:local
```

The runner starts `vibly-coordinator`, seeds the Vibing Math / Goldbach Program scenario, simulates eight configured agent principals, drives all state changes through Coordinator HTTP `ActionIntent`s, and writes a JSON report under `reports/`.

Console smoke can be enabled by omitting `VIBLY_E2E_SKIP_CONSOLE=true`. Real chain/indexer and semi-autonomous LLM mode are intentionally out of the blocking Phase 1 path.
