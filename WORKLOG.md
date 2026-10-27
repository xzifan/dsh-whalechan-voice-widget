# WORKLOG

本轮工作的技术记录：做了什么、怎么验证的、还欠什么。发布记录由 `scripts/release.sh` 自动追加。

## 2026-10-28 · 迭代自动化落地（分析 + 发布流水线）

**结论**：项目功能层已经完整（Realtime 大脑 + 可换 TTS + 音色设计 + 审计/统计），短板在发布工程：源码 0.6.0、dsh 里装 0.21.0、仓库 0 个 tag、36 个历史 tgz。自动发版前必须先建立可追溯基线。

**实测基线**

- `npm test` 279 项全绿（3.46s）；`npm run test:web` 100 项全绿（0.11s）；`npm run build` 185ms。
- `git log` 只有 1 个 commit，`git tag` 为空；`origin` 指向 `xzifan/dsh-whalechan-voice-widget`，`gh` 已授权（repo scope）。
- `~/.dsh/profiles/web/node_modules/dsh-voice-workbench/package.json` → 0.21.0；`cordis.patch.yml` 的 stateDir 是 `~/.dsh/storages/voice-workbench-preview`（与实际审计文件路径一致）。
- CI（`.github/workflows/ci.yml`）只跑单测 + build + pack，浏览器脚本 `test/browser-*.py` 无人执行；本机未装 playwright。

**做了什么**

1. `docs/iteration-automation.md`：现状、P0-P2 改进项、三层发布架构（J1 迭代 / J2 patch / J3 minor）、幂等与失败策略、成本与落地顺序。
2. `scripts/release.sh`：确定性发布流水线。测试红即退出（码 2）；`--dry-run` 只验证不落地；`.release.lock` + `.release-state.json` 防并发与重复发版；无改动跳过；通话中（审计文件 10 分钟内被写）推迟重启；安装后校验已装版本与页面引用的 bundle；提交 + tag + push + 记账。
3. `scripts/iteration-gate.sh`：可选的小时级闸门（输出只依赖时钟，适合 cron `monitor`，避免每小时唤醒模型）。默认不用——Hermes 原生 cron 有漏跑补偿。
4. `BACKLOG.md`：把改进项写成可被迭代作业取用的复选框清单。

**验证**

- `release.sh --dry-run`：279/100 测试通过、build 通过、pack 到临时目录，未改版本未提交。
- 端到端：`git clone --bare` 造本地 bare origin，克隆一份工作区，跑真实 `release.sh --slot patch`（不含 `--deploy`），成功产出 0.6.1：CHANGELOG 自动补段落、package.json/package-lock 版本同步、提交、`v0.6.1` tag、push 到 bare origin。第二次运行输出 `already-released` 并退出 0（幂等生效）。
- 未验证：`--deploy` 分支（安装 tgz + 重启 dsh web + 健康检查）没有在真机跑过，避免中断当前 dsh 会话；上线前需要人工跑一次 `--deploy`。

**还欠什么**

- P0 五项（见 BACKLOG），其中"对齐 0.6.0 + 打 v0.6.0 tag"是开自动发版的前置。
- 部署后验证目前只能 curl 首页比对 bundle 文件名，`/health` 端点还没做。
- cron 作业尚未注册，等确认 cadence（J1 先 4 小时还是直接每小时）。
