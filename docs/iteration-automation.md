# 迭代自动化：现状、改进项与定时发布设计

> 生成于 2026-10-28。所有结论都来自本机实测（`npm test` / `npm run test:web` / `npm run build` / `git` / `~/.dsh` 现场状态），不是根据 README 推测。

## 1. 现状快照

| 项目 | 实测结果 |
| --- | --- |
| 代码规模 | `src` 21 个文件、`web/src` 65 个文件，`src + web/src + test` 合计 13,567 行 |
| 后端测试 | 279 项全绿，3.46s |
| 前端测试 | 100 项全绿，0.11s |
| 构建 | `vite build` 通过，185ms（`dist/` 被 git 跟踪，走发布包） |
| 架构 | Qwen-Audio-Realtime 作大脑 + 可替换 TTS 声音层；打断、工具调用、音色设计、审计/统计均已落地 |
| 已装到 dsh | `~/.dsh/profiles/web` 里是 **0.21.0** 的 tgz |
| 源码声明版本 | **0.6.0**（`package.json` + `CHANGELOG.md` 顶部） |
| git | 只有 1 个 commit（`Initial commit`），**没有任何 tag**；remote `xzifan/dsh-whalechan-voice-widget` 已配置，`gh` 已登录且有 `repo` scope |
| CI | GitHub Actions 跑 node 18/20/22 的后端测试 + 前端测试 + build + pack 检查；**不含**浏览器 e2e |
| 遗留物 | 根目录 36 个 `dsh-voice-workbench-*.tgz`（0.2.0 → 0.21.0）、未跟踪的 `package/` 目录 |

最大的问题不是功能，而是**发布状态不可信**：源码说 0.6.0，dsh 里装的是 0.21.0，没有任何 tag 能说明哪个 commit 对应哪个产物。在这种状态下做自动发版，只会把混乱自动化。

## 2. 后续可改进项（按优先级）

### P0 — 发版前必须先清掉（半天内可完成）

1. **版本漂移对齐**：重建并按 `0.6.0` 安装到 `dsh web` profile，确认侧栏加载的是当前源码构建；顺手把 `cordis.patch.yml` 里 `stateDir` 指向的 `voice-workbench-preview` 是否要保留写进 README（否则审计目录名会让人误以为是预览实例）。
2. **建立基线 tag**：`git tag -a v0.6.0` 并 push。否则发布脚本的"自上次 tag 以来是否有改动"永远是"全仓库 1 个 commit"，无法判断该不该发版。
3. **清理 36 个历史 tgz 与 `package/`**：目录已经肉眼不可读，也容易让人装错包。建议 `.gitignore` 里加 `/*.tgz`（同一行已覆盖）并把历史包移到 `artifacts/releases/`。
4. **README 与元数据校正**：安装示例还写着 `0.18.2`；`engines` 写 `>=18`、README 写 Node 22+、CI 又测 18/20/22 —— 三处必须统一（建议 20/22，Node 18 已 EOL）。
5. **CI 增加一致性校验**：`package.json` 版本 == CHANGELOG 顶部版本 == 最新 tag；版本不一致直接红。自动发版的前提是这条能拦住手滑。

### P1 — 两周内把"能自动验证"补齐

6. **e2e 冒烟进 CI**：`test/browser-*.py` 已经用假麦克风 + mock API 写了成套用例，但本地没装 playwright、CI 也没跑。装 playwright + chromium 后先在 CI 跑 `browser-smoke.py`，这是唯一能覆盖"插件装进去之后页面真的能打开"的检查。
7. **健康检查端点**：加 `GET /api/voice-workbench/health`（返回版本、已加载工具数、TTS provider、realtime 连接状态）。现在发布后只能用 `curl /` 猜 bundle hash，判断不了插件是否真的挂载。
8. **覆盖率门槛**：`node --test --experimental-test-coverage`，把当前值设为下限，防止新增代码只写实现不写测试。
9. **lint / format**：ESLint flat config + Prettier，接进 CI 和 `prepack`。当前没有任何静态检查，纯靠测试兜底。
10. **真实链路夜间冒烟**（可选、限流）：每日一次对百炼 TTS 发一句 10 字文本、对 Realtime 建连 5 秒即断。mock 测不出凭据过期、协议字段变更。

### P2 — 月度改进

11. **火山引擎 Realtime**：下拉框现在挂着 `WorkInProgress` 且禁用。要么给出接入时间点，要么先移除入口，避免用户以为"配了凭据就能用"。
12. **拆分 `src/service.js`（592 行）与 `src/realtime-service.js`（558 行）**：会话生命周期、工具桥接、配置读写可以分层，这俩文件是目前回归风险最集中的地方。
13. **延迟指标化**：首字延迟、打断响应、TTS 合成耗时目前只在审计里看得到原始记录。加一条 `statistics` 聚合（p50/p95），把"首字变慢"从风险描述变成可观测指标。
14. **审计容量策略**：2000 条 / 10 MiB 在重度使用下会滚动覆盖。加按周归档或导出，避免历史被静默丢弃。

## 3. 定时发布：先纠正一个前提

需求是"每工作日 16:00 发 patch，每周六 16:00 发 minor"，并希望"按小时触发"。

**每小时轮询不是必需的**。查过本机 Hermes 的 cron 实现（`cron/jobs.py`）：

- 支持标准 5 段 cron，recurring 作业有**漏跑补偿**：宽限期 = 周期的一半，夹在 `[120s, 2h]`；超过宽限期按 `cron.catch_up_missed`（默认 true）**补跑一次**，而不是补跑 N 次。
- 每次运行的看门狗是**空闲超时**（默认 600s，`HERMES_CRON_TIMEOUT` 可调，0 = 不限），不是总时长上限。只要工具调用间隔不超过 10 分钟，一次跑 40 分钟的发布流程不会被砍。
- 因此 `0 16 * * 1-5` 这种一天一次的作业，即使 16:00 时 Mac 在睡眠，醒来后也会补跑一次。

结论：

- **发版用原生 cron 的一天一次 + 幂等脚本**，比每小时轮询更省、更可靠。
- **"每小时"只应该用在真正需要每小时推进的地方**，也就是迭代循环（每小时做一个改进项），而不是用它去"发现 16:00 到了"。

如果你确实想要"任意整点都能补发"，`scripts/iteration-gate.sh` 已经写好（输出只依赖时钟，同一小时内恒定，适合挂在 cron 的 `monitor` 上，避免每小时都唤醒模型）；但默认不启用。

### 3.1 三层结构

```
J1 迭代循环（每小时/每 4 小时）       J2 patch 发布（工作日 16:00, 18:00 重试）
  从 BACKLOG 取 1 项 → 实现 → 测试       agent 写 CHANGELOG[Unreleased]
  → 提交（不 bump、不部署）      ──►     → scripts/release.sh --slot patch --deploy
                                        → 测试/构建/打包/安装/重启/验证/tag/push
                              J3 minor 发布（周六 16:00, 18:00 重试）
                                        同上，--slot minor，额外全量回归 + GitHub Release
```

关键分工：**agent 只做需要判断力的事**（挑改进项、写发布说明、解释失败）；**版本号、测试门禁、安装、重启、打 tag、推送全部交给确定性脚本**。脚本红了就不发版，模型状态再差也不会把坏包推上线。

### 3.2 为什么发版作业要写两个时间点

`release.sh` 里有幂等记账（`.release-state.json`：日期 + slot）。所以：

- 16:00 正常发完并登记，18:00 再触发一次时脚本直接 `already-released` 退出（成本是一次很短的 agent turn）。
- 16:00 因为"正在通话 / 一次性网络失败 / 测试临时红"没发成，18:00 会自动补。

这比在脚本里 sleep 重试干净：不占进程，也不会和下一次 tick 打架。

### 3.3 幂等与并发

| 机制 | 位置 | 作用 |
| --- | --- | --- |
| `.release.lock`（mkdir 原子锁，>90 分钟视为陈旧） | `release.sh` | 两个 tick 同时到不会并发跑 |
| `.release-state.json`（日期/slot/版本） | `release.sh` | 当天同 slot 只发一次 |
| 无 tag 或 `tag..HEAD` 为 0 → 跳过 | `release.sh` | 不出空版本 |
| 审计文件 10 分钟内被写过 → 推迟重启 | `release.sh` | 不在用户通话中途重启 dsh |
| 测试红 → 退出码 2，不 bump 不提交 | `release.sh` | 坏的不会进 main |
| `.release-logs/<ts>-<slot>.log` | `release.sh` | 每次运行的完整输出 |
| `npm pack` 产物落 `artifacts/releases/`（不是仓库根） | `release.sh` | root 不再每发一版多一个 400KB tgz；`.gitignore` 已忽略 `/artifacts/` |
| 推送失败 → 记 `pending_push_version`，退出码 6 | `release.sh` | 下一班次只补推送，不会重复 bump |
| dsh 子进程 setsid 脱离 | `restart-dsh.sh` | 调用方（cron 工具）不会因继承管道而挂死 |

### 3.3.1 推送：系统代理要让 git 知道

本机系统代理是 `127.0.0.1:7897`（HTTP / HTTPS / SOCKS 都启用了）。实测：`curl` 直连 `github.com:443` 超时，走代理返回 200。而 **git 不会自动读取 macOS 的系统代理设置**，默认直连，于是表现为 `Operation timed out` / `Error in the HTTP2 framing layer` / `Empty reply from server` 三种不同报错。

仓库内已配置（只影响本仓库，不动全局）：

```sh
git config --local http.proxy http://127.0.0.1:7897
git config --local http.version HTTP/1.1        # 代理链路上 HTTP/2 容易 framing 报错
git config --local credential.helper '!gh auth git-credential'   # 复用 gh 的 token，不弹密码
```

- 想让所有仓库生效，把 `--local` 换成 `--global`。
- 前提是代理客户端在运行；没开时推送会失败，脚本记 `pending_push_version` 并在后续班次重试，不会卡住发版。
- 代理软件换端口（现在 7897）时要同步改这条 config。

### 3.4 注册作业（Hermes cron）

```bash
# 说明：job 的 prompt 必须自包含（cron 会话没有当前聊天上下文）
```

用 `cronjob_manage` 建三个作业，参数如下（**尚未创建，等你确认**）：

**J2 · 工作日 patch**

- schedule: `0 16,18 * * 1-5`
- workdir: `/Users/mac/workspace/dsh-voice-workbench`
- skills: `["dsh-deepseek-harness"]`
- enabled_toolsets: `["terminal", "files"]`
- deliver: `feishu`
- prompt:

```
你在 dsh-voice-workbench 仓库里执行工作日 patch 发布。步骤：
1. 读 `git log --oneline $(git describe --tags --abbrev=0)..HEAD` 与 `git status`。
2. 若 `bash -c 'test -f .release-state.json && cat .release-state.json'` 显示今天已发过 patch，直接回复"今日已发布，跳过"并结束。
3. 在 CHANGELOG.md 顶部插入 `## [Unreleased]` 段落，用面向用户的中文写 2-5 条实际变化（只写用户能感知的行为，不写内部重构）；若无用户可感知变化，写一行"维护性发布：内部重构与测试补强"。
4. 运行 `./scripts/release.sh --slot patch --deploy`，用足够长的 timeout（建议 600s）。
5. 脚本退出码 0 → 汇报：新版本号、测试数、是否部署成功、是否推送成功、tarball 名。
   退出码 2 → 测试红：把失败用例名贴出来，不要修代码，不要重跑，结束。
   退出码 3 → dsh 忙：说明已推迟到 18:00 重试。
   退出码 4/5 → 说明锁或前置条件问题，贴脚本输出最后 20 行。
6. 把本次结果追加一行到 WORKLOG.md（日期、版本、结果、失败原因）。
不要手动 git tag / push / dsh plugin add —— 这些都在 release.sh 里，重复执行会破坏幂等。
```

**J3 · 周六 minor**

- schedule: `0 16,18 * * 6`
- 其余同上，prompt 差异：`--slot minor`；发版前额外全量跑一次 `npm ci && npm --prefix web ci && npm test && npm run test:web && npm run build`（验证锁文件可用，而不只是增量环境可跑）；发完在 GitHub 建 Release（`gh release create vX.Y.Z --notes-file <changelog 段落>`）。

**J1 · 迭代循环**

- schedule: `17 * * * *`（每小时；:17 是为了避开整点的发布作业）
- 并发保护：开工先建 `.work.lock`，结束必删；`release.sh` 看到它就推迟发布（退出码 3），避免迭代改到一半时发版。
- prompt 要点：

```
0. 有 .release.lock 就跳过本班次；否则建 .work.lock，结束时（含失败）删除。
1. 从 BACKLOG.md 取最上面一个未完成项（形如 `- [ ]`），跳过「需要产品决策」小节。
2. 分级：
   - `[plan]` 开头，或跨 3+ 文件 / 涉及接口与数据结构变化 → 先派一个只读规划子代理
     （输出：文件清单、分步做法、每步行数、回归风险、应补断言），再由主代理决策：
     采纳 / 只做第一步 / 判定需要人拍板。
   - 其余条目直接实现，不派子代理。
3. 只做这一项，改动 ~200 行内；发现其实需要产品决策就停手，回复「需要决策：<条目>」。
4. 必须 `npm test`(≥279) 与 `npm run test:web`(≥100) 全绿、`npm run build` 成功，否则 `git checkout -- .` 回滚。
5. 全绿则提交，把该条改为 `- [x]`，追加 WORKLOG.md 一行（含是否用了规划子代理）。
6. 不 bump 版本、不打包、不部署、不 push —— 这些只由 J2/J3 做。
7. BACKLOG 清空时：派只读子代理从证据（TODO/测试缺口/审计失败类型）提 3 个候选，主代理选 1 个入队。
```

### 3.4.1 子代理规划、主代理决策（已验证可行）

- **可行性**：cron 子代理拿到的工具集是默认工具集减去 `cronjob / messaging / clarify`，所以 `delegate_task` 可用；调度器对 cron 强制 `async_delivery=False`，子代理结果**在本回合内同步返回**，不会飘到无关会话（`cron/scheduler.py` 里明确为此写了注释）。
- **为什么不全交给子代理**：子代理看不到主会话的取舍上下文，也没有发布权限；让它"规划"而不是"实现"，既拿到结构化的拆解，又不引入并发写冲突。
- **约束**：规划子代理必须只读（goal 里写死"禁止修改/创建/删除文件与 git 写操作"），否则两个进程会同时改同一棵工作区。
- **成本**：只有 `[plan]` 条目会多花一次子代理调用；机械条目仍是一条直线。
- **风险**：父进程在等子代理时会占着一次工具调用，子代理跑太久会撞上 cron 的 600s 空闲看门狗。规划任务的 goal 要写"紧凑输出、不要贴源码"，实测这类规划在 1-3 分钟内返回。

### 3.5 成本

J1 现在是每小时一次（24 次/天）；`[plan]` 条目会额外多一次规划子代理调用（机械条目没有）。按 flash 级模型估算，每天几元人民币量级；子代理的开销集中出现在 P2 重构类条目上。如果观察几天后发现在烧钱但 BACKLOG 推进不快，优先降频到每 2-3 小时，而不是砍掉规划环节。

### 3.6 失败与回滚

- 发版失败不进 main（脚本在 bump 之前就跑完测试），因此没有"坏 tag 需要撤销"的常态路径。
- 万一部署后发现插件加载失败：`dsh plugin --profile web add <上一个 tgz> --ignore-scripts` + 重启，tag 保留但打一个 `vX.Y.Z-hotfix1`。这就是保留历史 tgz 的唯一正当理由——所以清理历史包要挪到 `artifacts/releases/` 而不是删掉。
- 每次运行都有日志 + state + WORKLOG 三条记录，出问题能定位到哪一步。

### 3.7 落地顺序

1. **已完成**：P0 的版本对齐与基线 tag、发布流水线、三个作业、真机部署演练（0.6.1）。
2. **进行中**：J1 每小时跑 BACKLOG；`[plan]` 条目先规划后实施。
3. **下一个周末**：J3 minor 首跑；同时把 e2e 冒烟接进发布门禁。
4. **观察项**：每小时频率下的成本与"空跑"比例——若多数班次因无条目或需决策而空转，降频到 2-3 小时。
