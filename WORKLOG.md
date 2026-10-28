# WORKLOG

本轮工作的技术记录：做了什么、怎么验证的、还欠什么。发布记录由 `scripts/release.sh` 自动追加。

## 2026-10-28 · 今日优化：健康检查端点 `/api/voice-workbench/health`

**为什么是它**：发布流水线现在只能靠"config 接口返回 200"判断插件挂载，这既不能确认版本，也看不到 TTS 就绪状态和进行中的实时会话。加一个只读自检端点，把"部署成功"从主观判断变成可断言的事实，同时给运维留一个标准探针。

**实现**（`src/service.js` + `src/index.js`）

- 新增 `GET /api/health`，返回 `ok / version / uptimeMs / tts{provider,model,voice,ready} / realtime.activeSessions / tools.enabled / credentials{bailian,breeze} / capabilities`。
- 只读本地状态：不发起任何上游请求，不返回凭据值；`version` 从 `package.json` 读取，避免和实际安装版本漂移。
- 走宿主的 `connection.fetch.register`，与其它接口同一套鉴权和 no-store 缓存策略；POST 到该路径仍按既有约定返回 404（不新增语义）。
- `release.sh` 的部署校验换成调用 `/health` 并断言 `ok === true` 且 `version === 新版本`，失败即视为部署失败（此前只看 200）。

**验证**

- 后端 279 项全绿（新增 10 条断言：方法、状态码、版本一致性、字段类型、无密钥泄露、清理计数 23→24）。
- 前端 100 项全绿；`vite build` 通过。
- 真实端点尚未在运行实例上调用——它随下一个补丁版本部署。

**还欠什么**

- 该端点在线上实例可用要等下一次发布（今天已有 0.6.1，按"每工作日一个 patch"的策略顺延到明天 16:00，除非用 `--force` 提前发一次）。
- 推送仍排队：`pending_push_version=0.6.1`，网络恢复后自动补推 main + 所有 tag。

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
- 当时未验证：`--deploy` 分支（安装 tgz + 重启 + 挂载校验）——已在下一节真机补测并通过。

## 2026-10-28 · 真机部署演练 + 第一个正式版本 0.6.1

**演练步骤（全部在真机执行）**

1. `npm pack` → 安装 0.6.0 到 `dsh web` profile（覆盖原来的 0.21.0）→ 重启 → `config` 接口 200、QQ bot 重连。
2. 抽出 `scripts/restart-dsh.sh` 单独验证：父 shell 退出后进程存活、cwd 保持 `$HOME`、`application` 可用。
3. 写 `[Unreleased]` 段落后跑真实 `./scripts/release.sh --slot patch --deploy` → 0.6.1：279+100 测试、build、打包、安装、重启、校验、commit、tag；仅 push 失败。

**演练暴露并修掉的两个真实缺陷**

- **挂起 420s**：`restart-dsh.sh` 最初在 release.sh 里用 `OUT=$(bash ...)` 捕获输出，后台启动的 dsh 继承了管道写端，命令替换一直等 EOF。真机第一次跑就卡死在"重启"这一步，还把 dsh 停在了半路。改为写临时文件 + `restart-dsh.sh` 内部用 `subprocess.Popen(start_new_session=True, close_fds=True)`，实测 1.9s 返回。
- **推送失败仍算发版成功**：原逻辑只打 WARN，state 仍记当天已发布，导致后续班次直接跳过、永远不会补推。改为记 `pending_push_version` 并退出 6，下一班次只补推送不重复 bump。

**当前线上状态**：dsh web pid 28814，插件 0.6.1，config 接口 200，QQ bot ready，tag `v0.6.0` / `v0.6.1`，本地领先 origin 7 个提交。

**已注册的定时作业**（2026-10-28，Hermes cron）

| 作业 | ID | 计划 |
| --- | --- | --- |
| voice-workbench · 迭代循环 | `44914f72f670` | `17 */4 * * *`（每 4 小时） |
| voice-workbench · patch 发布 | `a29ae4b46645` | `0 16,18 * * 1-5` |
| voice-workbench · minor 发布 | `14db9e4ea4c6` | `0 16,18 * * 6` |

同时补了基线 tag `v0.6.0`（指向 `97a0845 Initial commit`，仅本地，未 push）。补 tag 后 `release.sh --dry-run` 显示"自 v0.6.0 以来 2 个 commit → 0.6.1"，改动区间判断恢复正常。

**还欠什么**

- P0 剩余三项在 BACKLOG 顶部，由 J1 下一轮开始做。
- `/health` 已实现并接入发布校验，但要等下一个补丁版本（明天 16:00 的 0.6.2）才在运行实例上生效。

## 2026-10-28 · 推送修复：git 没走系统代理

- 现象：`git push` 分别报过 `Operation timed out`、`Error in the HTTP2 framing layer`、`Empty reply from server`。
- 根因不是 HTTP vs SSH，而是 macOS 系统代理（`127.0.0.1:7897`）git 不认：`curl` 直连 443 超时、走代理 200，git 默认直连。
- 修复（仓库本地，不动全局）：`http.proxy=http://127.0.0.1:7897`、`http.version=HTTP/1.1`、`credential.helper='!gh auth git-credential'`。
- 结果：`main` 推到 `f67b4cd`，`v0.6.0` / `v0.6.1` 两个 tag 已上远端；`release.sh` 的 pending-push 分支真实跑通并把 state 的 `pushed` 改回 true。
