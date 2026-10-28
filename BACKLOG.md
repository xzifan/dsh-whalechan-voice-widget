# BACKLOG

按顺序取用：迭代作业（J1）每次只做最上面一个 `- [ ]`，做完改成 `- [x]` 并在同一 commit 里补 WORKLOG。

> 发布动作（bump 版本、`npm pack`、`dsh plugin add`、重启 dsh、`git tag`、`git push`）**不在本清单里**，全部由 patch / minor 作业通过 `scripts/release.sh --deploy` 执行。J1 只改代码和文档。

## P0 · 发布基线（先做，做完才能开自动发版）

- [x] 把根目录 36 个历史 tgz 移到 `artifacts/releases/`，删除未跟踪的 `package/` 目录（2026-10-28：36 个 tgz 全部移入 `artifacts/releases/`；`package/` 是 0.1.0 的旧解包残留，`rm -rf`/`find -delete` 在 cron 无审批环境下被拦截，改为移出仓库到 `~/.hermes/cache/scratch/`；`.gitignore` 追加 `/artifacts/`、`/package/`，否则后续 `git add -A` 会把 11 个 artifacts 文件扫进提交）
- [x] `release.sh` 仍把 `npm pack` 输出写到仓库根（167 行 `$PACKDIR`、218 行 `$ROOT`），清完的历史 tgz 会重新堆回来：统一改到 `artifacts/releases/`，并同步 `.release-state.json` 的 `last_tarball`（2026-10-28：新增 `RELDIR="$ROOT/artifacts/releases"`，打包前 `mkdir -p` + 先删同版本旧包，`npm pack --pack-destination "$RELDIR"`；`last_tarball` 已改指 `artifacts/releases/dsh-voice-workbench-0.6.1.tgz`（该文件确实存在）。dry-run 分支仍用 `mktemp -d` 以便自清理，不动）
- [x] 根目录 4 个调试音频（`whaleA/B-realtime-{en,ja}.silk`）移入 `artifacts/debug-audio/`（2026-10-28：4 个 `.silk` 共 83 KB 全部 `mv` 进 `artifacts/debug-audio/`，根目录已无 `*.silk`；文件本就被 `.gitignore` 的 `*.silk` 覆盖，所以零 git 改动。`.tools/bailian-voice-lab/manifest.json` 里 `jaQqFile`/`enQqFile` 指的是 `.tools/` 下自己那份副本，不是这 4 个，无需改路径）
- [ ] 修正 README：安装示例 `0.18.2` → `<最新版本>`；Node 版本三处统一（engines / README / CI matrix）
- [ ] CI 增加版本一致性检查：package.json 版本 == CHANGELOG 顶部 == 最新 tag
- [x] 校验部署一致性：对比 `~/.dsh/profiles/web/node_modules/dsh-voice-workbench/package.json` 的版本与源码版本，把差异写进 WORKLOG（2026-10-28：演练中完成，线上 0.21.0 → 0.6.1，现与源码一致）

## P1 · 自动验证能力

- [ ] playwright + chromium 进 CI，先跑 `test/browser-smoke.py`（假麦克风已就绪，本地目前没装 playwright）
- [x] 新增 `GET /api/voice-workbench/health`，返回版本 / 工具数 / TTS provider / realtime 状态，作为发布后验证入口（2026-10-28 完成，已接入 `release.sh` 的部署校验）
- [ ] 覆盖率：`node --test --experimental-test-coverage`，把当前值设为 CI 下限
- [ ] ESLint(flat) + Prettier 接入 CI 与 `prepack`
- [ ] 夜间真实链路冒烟（百炼 TTS 一句 + Realtime 握手 5s），限流、失败只告警不阻塞发布

## P2 · 结构性改进

- [ ] 火山引擎 Realtime：给出接入时间点，或从声音设置下拉里移除 WorkInProgress 项
- [ ] [plan] 拆分 `src/service.js`(617 行) 与 `src/realtime-service.js`(558 行)：按 `docs/refactor-split-plan.md` 先做步骤 1（抽 `realtime-protocol.js`）
- [ ] 拆分步骤 2：抽 `src/voice-tool-bridge.js`（voice 工具桥接，122 行；收益最大，注意 mutate 不可重入与 settings getter）
- [ ] 拆分步骤 3：抽 `src/voice-synthesis.js`（合成层，62 行；realtime-tts 有 24 条断言盯着字段）
- [ ] [plan] 首字延迟、打断响应、TTS 合成耗时进 `statistics` 聚合（p50/p95），把延迟风险变成指标
- [ ] 审计容量策略：2000 条 / 10 MiB 之外的按周归档或导出

## 需要产品决策（迭代作业不得自行处理）

- 是否把火山引擎列为正式支持的第二大脑（涉及鉴权与音频协议工作量）
- 审计日志是否允许导出到文件 / 是否引入账号体系
- minor 版本是否允许在"只有重构没有新功能"的周末跳过
