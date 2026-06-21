# vibly-e2e-lab

> English README: [README.md](README.md)

Vibly 本地多智能体社会仿真 E2E 测试实验室。测试框架会启动真实的 `vibly-coordinator` 进程，初始化一个完整配置的多智能体组织（*Vibing Math / Goldbach Program* 场景），通过 Coordinator HTTP `ActionIntent` 接口驱动所有状态变更，并对生成的事件流和知识库进行断言。

## 快速开始

```bash
pnpm install
pnpm e2e:local            # 完整运行，含半自主 LLM 模式（需配置 .env）
pnpm e2e:live-llm         # 多个真实 client daemon 使用 LLM 实际运行 Vibing Math；未指定 runName 时每次新建；成功后保活供查看
pnpm e2e:live-llm:ci      # CI/自动化用：成功后清理并退出
VIBLY_E2E_RUN_NAME=my-run pnpm e2e:live-llm:resume  # 断点继续
VIBLY_E2E_SKIP_CONSOLE=true pnpm e2e:local   # 跳过 Console 冒烟测试，适合 CI
pnpm deploy:all            # 跨仓库部署计划预览
pnpm deploy:build          # 跨仓库统一构建
pnpm deploy:gcp:plan       # GCP 模板预览
pnpm deploy:npm:plan       # npm 发布模板预览
```

每次运行结束后，JSON 报告会写入 `reports/deterministic-<timestamp>.json`。
Live LLM 状态会写入 `data/live-runs/<runName>/state.json`，通过 `VIBLY_E2E_RUN_NAME` 继续同一任务。
Live LLM 成功后还会写入 `reports/live-llm-content-<timestamp>.md`，其中包含观察、提案正文、讨论贡献、审核、成果和知识库更新的可读内容。

## 部署编排脚本

`src/deploy.ts` 提供了一个统一的跨仓库部署编排入口。它会：

- 读取每个仓库的 git 分支、commit 和 dirty 状态
- 执行该仓库预设的 build/typecheck 命令
- 按环境变量执行真实部署 hook，例如 `VIBLY_DEPLOY_VIBLY_CONSOLE_CMD`

建议的生产拓扑：

- `vibly-chain`：部署 `vibly-solo-node` 到 VM / 裸机，并由 `systemd` 托管
- `vibly-indexer`：部署到带 Docker Compose 的 VM，因为它需要同时运行 Postgres + SubQuery
- `vibly-coordinator`：部署到 Cloud Run 或其他无状态应用宿主，但后端必须接外部 Postgres
- `vibly-console`：如果使用 Auth.js 代理模式，建议部署到 Cloud Run；只有 direct/public 模式才适合纯静态托管

内建的 `--profile=gcp` 现在对 `vibly-chain` 支持两种常见 VM 发布方式：

- `GCP_VIBLY_CHAIN_DEPLOY_MODE=upload`：本地编译后上传二进制，再重启 `systemd`
- `GCP_VIBLY_CHAIN_DEPLOY_MODE=remote-build`：SSH 到远端机器编译，再重启 `systemd`

对可重复的生产发布来说，本地构建 + 制品上传通常更合适，因为更快、也更容易校验版本。远端构建则更适合首次开荒，或目标主机 ABI / toolchain 必须与构建产物完全一致的场景。

当前纳管的项目 id：

- `concord`
- `vibly-chain`
- `vibly-client`
- `vibly-console`
- `vibly-coordinator`
- `vibly-docs`
- `vibly-e2e-lab`
- `vibly-indexer`
- `vibly-coordinator-http-contract`

`vibly-site`、`vibly-library` 和 `archelabs-site` 已由各自 GitHub Pages workflow 部署，因此不再纳入这里的跨仓库部署脚本。

常见用法：

```bash
# 默认最安全：只输出计划，不执行 build/deploy
pnpm deploy:all

# 先列出可选择的项目 id
pnpm deploy:all -- --list

# 对所有注册仓库执行 build/typecheck
pnpm deploy:build

# 只部署选中的项目
VIBLY_DEPLOY_TARGET=lumen \
VIBLY_DEPLOY_VIBLY_CONSOLE_CMD="pnpm build && gcloud run deploy vibly-console --source ." \
VIBLY_DEPLOY_VIBLY_COORDINATOR_CMD="pnpm build && gcloud run deploy vibly-coordinator --source ." \
pnpm deploy:all -- --phase=full --only=vibly-console,vibly-coordinator

# 明确允许 dirty working tree
pnpm deploy:all -- --phase=build --allow-dirty
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--phase=plan` | 默认值，只展示将要执行的计划 |
| `--phase=build` | 只执行 build/typecheck |
| `--phase=deploy` | 只执行 deploy hook |
| `--phase=full` | 先 build，再执行 deploy hook |
| `--list` | 列出已注册 project id 和 build 命令 |
| `--only=a,b` | 只包含指定 project id |
| `--skip=a,b` | 排除指定 project id |
| `--allow-dirty` | 不因未提交改动而失败 |
| `--continue-on-error` | 某个项目失败后继续处理后续项目 |
| `--require-deploy-hook` | deploy/full 阶段要求每个选中项目都必须有部署 hook |
| `--dry-run` | 打印命令但不真正执行 |
| `--target=name` | 通过 `VIBLY_DEPLOY_TARGET` 传递目标环境标签 |

deploy hook 的环境变量命名规则：

```bash
VIBLY_DEPLOY_<PROJECT_ID>_CMD
```

例如 `vibly-console` 对应 `VIBLY_DEPLOY_VIBLY_CONSOLE_CMD`。

plan 输出会展示每个项目的 build 命令和解析后的 deploy 命令。内建 profile 如果缺少环境变量，也会直接提示具体变量名，例如 `GCP_PROJECT_ID` 或 `GCP_REGION`，不会静默跳过。

每次运行都会生成 `reports/deploy-<timestamp>.json` 报告。

### 内建模板

目前内建了两类 profile：

- `--profile=gcp`：Google Cloud 部署模板
- `--profile=npm`：npm 包发布模板

模板环境变量文件：

- [templates/deploy/gcp.env.example](/home/libingjiang47/vibly-e2e-lab/templates/deploy/gcp.env.example)
- [templates/deploy/npm-publish.env.example](/home/libingjiang47/vibly-e2e-lab/templates/deploy/npm-publish.env.example)
- [templates/deploy/bootstrap-vibly-indexer-vm.sh](/home/libingjiang47/vibly-e2e-lab/templates/deploy/bootstrap-vibly-indexer-vm.sh)

如果要部署生产 Coordinator，还需要准备 `vibly-coordinator` 仓库里的 env yaml：

- [../vibly-coordinator/templates/cloud-run.env.yaml.example](/home/libingjiang47/vibly-coordinator/templates/cloud-run.env.yaml.example)

示例：

```bash
# GCP 预览 / 部署
set -a
source .gcp.env
set +a
pnpm deploy:gcp:plan
pnpm deploy:gcp -- --only=vibly-chain,vibly-indexer,vibly-coordinator,vibly-console

# npm 预览 / 发布
set -a
source templates/deploy/npm-publish.env.example
set +a
pnpm deploy:npm:plan
pnpm deploy:npm
```

内建 GCP 的 Coordinator 部署现在强制要求这两个显式输入：

- `GCP_VIBLY_COORDINATOR_ENV_FILE`
- `GCP_VIBLY_COORDINATOR_CLOUDSQL_INSTANCE`

这意味着 `STORAGE_MODE=postgres`、`DATABASE_URL` 等生产数据库配置必须放进
Coordinator 的 env yaml，而 Cloud SQL 挂载也会作为一等部署变量传入，不再藏在
`GCP_VIBLY_COORDINATOR_FLAGS` 里。

生产发布时建议组合使用 `--phase=full --require-deploy-hook`，确保每个选中项目都有内建模板命令或显式的 `VIBLY_DEPLOY_<PROJECT_ID>_CMD`。

### 生产说明

- `vibly-indexer` 虽然已纳入 deploy planner，但它并不是 serverless 服务。正确的线上部署仍然需要拉起它的 Docker Compose 栈，或者等价的 Postgres + SubQuery 拓扑。
- `vibly-coordinator` 实际上也不是“纯无服务”。应用进程可以跑在 Cloud Run 上，但生产环境必须使用 `STORAGE_MODE=postgres` 并连接外部 Postgres；Coordinator 启动时会自行跑迁移。
- 内建 GCP deploy profile 现在会显式校验这件事：如果 `GCP_VIBLY_COORDINATOR_ENV_FILE` 没有指向存在的 Coordinator env yaml，或者 `GCP_VIBLY_COORDINATOR_CLOUDSQL_INSTANCE` 未设置，就会直接失败。
- `pnpm deploy:npm` 现在默认只处理真正会发布到 npm 的项目：`concord`、`vibly-client`、`vibly-coordinator-http-contract`。如果你要覆盖这个默认集合，再显式传 `--only=...`。
- 内建 npm profile 现在优先使用 Access Token。设置 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN` 即可；脚本会自动把 `NPM_TOKEN` 映射成 `NODE_AUTH_TOKEN`，并临时生成 `.npmrc`，不再默认设计 OTP 流程。
- npm profile 现在也会更早失败并给出明确提示：先检查 `npm whoami`，对于单包发布还会先检查该版本是否已经存在，再决定是否执行 `pnpm publish`。

### 初始化一台新的 indexer VM

新开的 Debian/Ubuntu VM，建议先执行一次 bootstrap 脚本，再进入常规 deploy 流程：

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

初始化完成后，后续就可以直接用 `pnpm deploy:gcp -- --only=vibly-indexer` 复用远端目录，只做 repo/build/compose 的刷新。

## 测试内容

| 阶段 | 说明 | 关键源文件 |
|------|------|-----------|
| **确定性场景** | 初始化组织 + 项目 + 8 个智能体 + 知识库；驱动完整协作闭环（观察 → 讨论 → 提案 → 任务 → 产物 → 奖励 → 声誉 → 下一轮观察） | `src/runner.ts` |
| **故障场景 FC1–FC5** | 独立故障路径：分配超时（FC1）、低质量观察（FC2）、提案被拒（FC3）、产物被拒（FC4）、知识同步冲突检测（FC5） | `src/failure-scenarios.ts` |
| **半自主模式** | 由 OpenAI 兼容 API（默认 DeepSeek）驱动的 LLM 观察者；共 8 个步骤、5 项断言 | `src/semi-autonomous.ts` |
| **Live LLM 模式** | 启动多个真实 `vibly-client` daemon；每个 agent 自己读取 inbox、调用 LLM、提交 `ActionIntent`；支持命名暂停和继续 | `src/live-vibing-math.ts` |

## 半自主 / LLM 模式

将 `.env.example` 复制为 `.env` 并填入 API Key：

```bash
cp .env.example .env
# 编辑 .env，设置 OPENAI_API_KEY（可选 OPENAI_BASE_URL / OPENAI_MODEL）
```

默认配置指向 [DeepSeek](https://platform.deepseek.com)：

```env
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-chat
```

任何 OpenAI 兼容的端点均可使用（OpenAI、Anthropic 代理、本地 Ollama 等）。未设置 `OPENAI_API_KEY` 时，半自主模式会被静默跳过。

所有本地 E2E 命令都会启动完整网络 profile：Coordinator、Console、Vibly 链和独立支付链。默认端口为 Vibly 链 `9944`、支付链 `9945`；如果本地无法启动 `vibly-solo-node` 会直接报错，可用 `VIBLY_E2E_BUILD_CHAIN=true` 自动构建。

实验室当前对外暴露的远程网络命名口径为：

- `substrate:vibly-testnet` -> `Lumen`
- `substrate:vibly-incentivized-testnet` -> `Monolith`

Live LLM 模式要求设置 `OPENAI_API_KEY`。常用命令：

```bash
# 本地 smoke；mock stake 只跳过 indexer stake sync，仍会启动 Vibly/支付链
VIBLY_E2E_MOCK_STAKE=true VIBLY_E2E_RUN_NAME=local-live pnpm e2e:live-llm

# 如果同名 run 已有旧数据，重置后重新开始
VIBLY_E2E_MOCK_STAKE=true VIBLY_E2E_RUN_NAME=local-live pnpm e2e:live-llm:fresh

# 在 Proposal 后暂停，并稍后继续
VIBLY_E2E_MOCK_STAKE=true VIBLY_E2E_RUN_NAME=local-live VIBLY_E2E_PAUSE_AT=after-proposal pnpm e2e:live-llm
VIBLY_E2E_MOCK_STAKE=true VIBLY_E2E_RUN_NAME=local-live pnpm e2e:live-llm:resume

# 连接测试网 / 外部 coordinator
COORDINATOR_URL=https://coordinator.example \
COORDINATOR_API_TOKEN=... \
VIBLY_E2E_RUN_NAME=testnet-live \
pnpm e2e:live-llm:testnet

```

`VIBLY_E2E_PAUSE_AT` 可取：`after-seed`、`after-first-observation`、`after-proposal`、`after-artifacts`、`after-knowledge-sync`、`before-second-observation`。
`VIBLY_E2E_COORDINATOR_START_TIMEOUT_MS` 可用于放宽本地 coordinator 启动等待时间（默认 120000ms）。
测试网支付链内置 Paseo RPC 兜底地址，激励测试网支付链内置 Polkadot 主网 RPC 兜底地址；可分别用 `VIBLY_E2E_PASEO_RPC_URLS` 与 `VIBLY_E2E_POLKADOT_RPC_URLS` 追加覆盖。
远程服务器手动验 Console 时，如果本地端口和远程端口不同，可设置 `VIBLY_E2E_PUBLIC_CONSOLE_PORT=3002`；如果需要完整地址，可设置 `VIBLY_E2E_PUBLIC_CONSOLE_URL=http://127.0.0.1:3002`。
测试网默认使用已存在 / 预先质押的 agent 身份；如需显式提供链上绑定，可设置 `VIBLY_E2E_AGENT_CHAIN_MAP` JSON。
`pnpm e2e:live-llm`、`pnpm e2e:live-llm:resume` 和 `pnpm e2e:live-llm:testnet` 默认会在成功后保留 Coordinator、Console 和 agent daemon 进程，并打印 Console URL。agent daemon 会继续运行并监听新的任务/义务；查看结束后按 Ctrl+C，会执行清理。需要自动退出时使用 `pnpm e2e:live-llm:ci`。

### Lumen identity-first 启动流程

Lumen VibMath 使用 identity-first 启动流程。脚本不会直接启动 agents，而是先确认本地身份缓存存在，并且链上资金充足。

初始化链上身份：

```bash
pnpm e2e:vibmath:lumen:identity:init
```

该命令会输出充值地址：

```text
Funding address: 5...
Identity ID: ...
```

由真人向该地址转入足够 VIB 后，执行：

```bash
pnpm e2e:vibmath:lumen:preflight
```

补齐本地 agent key/cache：

```bash
pnpm e2e:vibmath:lumen:agents:prepare
```

启动完整 Lumen VibMath 流程：

```bash
VIBLY_E2E_ORGANIZATION_ID=<guardian-created-org-id> \
VIBLY_E2E_PROJECT_ID=<guardian-created-project-id> \
pnpm e2e:vibmath:lumen
```

启动前脚本会自动：

1. 加载本地 identity cache；
2. 从链上 / indexer 同步 identity 和 agent 状态；
3. 对比本地 cache 与链上状态；
4. 如果存在差异，输出 diff 并保存到 `last-diff.json`；
5. 如果本地 agent 数量不足，生成缺失 agent；
6. 注册缺失的 chain agent；
7. bond 缺失的 stake；
8. 将 E2E run attach 到传入的 organization/project；
9. 启动 VibMath agent daemons。

Lumen run 不再由脚本自动创建 organization 或 project。请先在 Console 中用链上 Guardian 或组织管理员钱包完成：

1. Guardian 创建 organization。
2. Guardian 或 org admin 在 organization detail 页面创建 project。
3. 将创建得到的 ID 填入 `VIBLY_E2E_ORGANIZATION_ID` 和 `VIBLY_E2E_PROJECT_ID`。
4. 启动或恢复 E2E run；agents 会 attach 到该 org/project，并继续提交正常的 `ActionIntent`。

脚本不会输出私钥、mnemonic、seed phrase、API token 或 root signer。

必需环境变量：

```bash
LUMEN_COORDINATOR_URL=
LUMEN_CHAIN_RPC_URL=
LUMEN_INDEXER_GRAPHQL_URL=
COORDINATOR_API_TOKEN=
VIBLY_E2E_ROOT_SIGNER_URI=
VIBLY_E2E_CHAIN_ID=substrate:vibly-testnet
VIBLY_E2E_TESTNET_SEED=true
VIBLY_E2E_ORGANIZATION_ID=
VIBLY_E2E_PROJECT_ID=
```

共享 identity 模式：

```bash
VIBLY_E2E_SHARED_IDENTITY_ID=<identity-id>
```

设置 `VIBLY_E2E_SHARED_IDENTITY_ID` 后，多个 agents 会复用同一个链上 identity，但每个 agent 仍会独立注册 chain agent，并独立 bond stake。

暂停 agents：

```bash
VIBLY_E2E_RUN_NAME=my-lumen-run pnpm e2e:vibmath:lumen:pause-agents
```

恢复 agents：

```bash
VIBLY_E2E_RUN_NAME=my-lumen-run pnpm e2e:vibmath:lumen:resume-agents
```

重置并重新启动：

```bash
VIBLY_E2E_RUN_NAME=my-lumen-run pnpm e2e:vibmath:lumen:fresh
```

恢复 checkpoint run：

```bash
VIBLY_E2E_RUN_NAME=my-lumen-run pnpm e2e:vibmath:lumen:resume
```

## 场景：Vibing Math

测试场景位于 `scenarios/vibing-math/`：

```
agents.yaml        — 8 个智能体主体，含角色提示和技能配置
mechanisms.yaml    — ObservationAssignment 机制配置（超时时长、分配人数）
handbooks/         — 组织和项目手册（半自主模式下作为 LLM 上下文输入）
knowledge/         — 初始知识条目（文献索引、哥德巴赫背景、已知问题等）
```

## 架构说明

- Runner 管理 coordinator 的完整生命周期（启动 → 健康检查 → 数据初始化 → 断言 → 清理）。每次运行时 SQLite 数据库及 WAL 日志文件会被删除，确保从干净状态开始。
- 所有协调操作均通过 `ActionIntent` HTTP 调用完成，不直接修改状态。
- 事件查询时传入 `?type=<EventType>` 过滤参数，绕过服务端 `max=200` 分页上限，避免高负载运行时事件被截断。
- 本测试实验室不依赖 `vibly-chain` 或 `vibly-indexer`，这两者不在本地 E2E 范围内。

## npm scripts（补充）

| 命令 | 说明 |
|---|---|
| `pnpm deploy:all` | 跨仓库部署计划 / 编排入口，默认 phase 为 `plan` |
| `pnpm deploy:build` | 跨仓库统一 build/typecheck |
| `pnpm deploy:gcp:plan` | 预览内建的 Google Cloud 部署模板 |
| `pnpm deploy:gcp` | 执行内建的 Google Cloud 部署模板 |
| `pnpm deploy:npm:plan` | 预览内建的 npm 发布模板 |
| `pnpm deploy:npm` | 执行内建的 npm 发布模板 |
| `pnpm e2e:console` | 启动本地网络 profile 后运行 Console Playwright 冒烟测试 |
