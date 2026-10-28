# BACKLOG

按顺序取用：迭代作业（J1）每次只做最上面一个 `- [ ]`，做完改成 `- [x]` 并在同一 commit 里补 WORKLOG。

> 发布动作（bump 版本、`npm pack`、`dsh plugin add`、重启 dsh、`git tag`、`git push`）**不在本清单里**，全部由 patch / minor 作业通过 `scripts/release.sh --deploy` 执行。J1 只改代码和文档。

## P0 · 发布基线（先做，做完才能开自动发版）

- [ ] 把根目录 36 个历史 tgz 移到 `artifacts/releases/`，删除未跟踪的 `package/` 目录
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
- [ ] 拆分 `src/service.js`(592 行) 与 `src/realtime-service.js`(558 行)：会话生命周期 / 工具桥接 / 配置读写分层
- [ ] 首字延迟、打断响应、TTS 合成耗时进 `statistics` 聚合（p50/p95），把延迟风险变成指标
- [ ] 审计容量策略：2000 条 / 10 MiB 之外的按周归档或导出

## 需要产品决策（迭代作业不得自行处理）

- 是否把火山引擎列为正式支持的第二大脑（涉及鉴权与音频协议工作量）
- 审计日志是否允许导出到文件 / 是否引入账号体系
- minor 版本是否允许在"只有重构没有新功能"的周末跳过
