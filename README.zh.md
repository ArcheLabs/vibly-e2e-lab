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
```

每次运行结束后，JSON 报告会写入 `reports/deterministic-<timestamp>.json`。
Live LLM 状态会写入 `data/live-runs/<runName>/state.json`，通过 `VIBLY_E2E_RUN_NAME` 继续同一任务。
Live LLM 成功后还会写入 `reports/live-llm-content-<timestamp>.md`，其中包含观察、提案正文、讨论贡献、审核、成果和知识库更新的可读内容。

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

Live LLM 模式要求设置 `OPENAI_API_KEY`。常用命令：

```bash
# 本地快速 smoke，使用 mock stake
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
测试网默认使用已存在 / 预先质押的 agent 身份；如需显式提供链上绑定，可设置 `VIBLY_E2E_AGENT_CHAIN_MAP` JSON。
`pnpm e2e:live-llm`、`pnpm e2e:live-llm:resume` 和 `pnpm e2e:live-llm:testnet` 默认会在成功后保留 Coordinator、Console 和 agent daemon 进程，并打印 Console URL。agent daemon 会继续运行并监听新的任务/义务；查看结束后按 Ctrl+C，会执行清理。需要自动退出时使用 `pnpm e2e:live-llm:ci`。

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
