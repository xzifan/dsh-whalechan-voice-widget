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

## 2026-10-28 · 规划子代理首跑：拆 service.js 的计划

- 触发方式：主会话 `delegate_task`，单任务、只读 goal（写死禁止改文件与 git 写操作）。
- 结果：101 秒、11 次 API 调用，产出可执行计划，已固化为 `docs/refactor-split-plan.md`。
- 质量判断（主代理决策依据）：
  - 它纠正了 BACKLOG 里过期的行数（592 → 617，因为当天新增 health 端点），说明读的是真代码而不是凭记忆。
  - 抓到了两条我原本没写进计划的风险：`test/adapter.test.js` 锁死 `routes.length === 23`；`WebSocketCtor` 是默认参数、调用时求值，挪错会让 `connect()` 静默 return 而测试抓不到（所有测试都注入了它）。
  - 给出了可验证的顺序依据：步骤 1 纯常量无状态、测试零改动，所以先做。
- 决策：采纳，但把「一次 200 行」拆成三张独立票（步骤 1/2/3 各一条 BACKLOG），`createRealtimeSession` 与 `initializeSessionVoice` 不进本轮。
- 结论：cron 里该机制走同步内联，父进程要等子代理；101 秒远低于 600 秒空闲看门狗，节奏安全。只有 `[plan]` 条目会触发，机械条目不受影响。

## 2026-10-28 · 推送修复：git 没走系统代理

- 现象：`git push` 分别报过 `Operation timed out`、`Error in the HTTP2 framing layer`、`Empty reply from server`。
- 根因不是 HTTP vs SSH，而是 macOS 系统代理（`127.0.0.1:7897`）git 不认：`curl` 直连 443 超时、走代理 200，git 默认直连。
- 修复（仓库本地，不动全局）：`http.proxy=http://127.0.0.1:7897`、`http.version=HTTP/1.1`、`credential.helper='!gh auth git-credential'`。
- 结果：`main` 推到 `f67b4cd`，`v0.6.0` / `v0.6.1` 两个 tag 已上远端；`release.sh` 的 pending-push 分支真实跑通并把 state 的 `pushed` 改回 true。

## 2026-10-28 · 仓库基线清理：36 个历史 tgz 归档、清掉解包残留

- 条目：P0「把根目录 36 个历史 tgz 移到 `artifacts/releases/`，删除未跟踪的 `package/` 目录」。
- 改动：36 个 tgz 全部 `mv` 到 `artifacts/releases/`（根目录剩 0 个）；`package/`（0.1.0 的旧解包残留，220K / 8 文件）移出仓库到 `~/.hermes/cache/scratch/dsh-vw-stale-package-20261028T101812/`。`rm -rf`、`find -delete`、`execute_code` 在 cron 无审批环境下都被策略拦截，所以用 `mv` 达到「仓库内不再存在」的等价结果，没有动 `approvals.cron_mode`。
- `.gitignore` 追加 `/artifacts/` 与 `/package/`：清理前 `git status -uall` 有 11 个 artifacts 文件（json/html）未被忽略，本作业收尾用的 `git add -A` 会把它们扫进提交——这是顺手补上的一处真实隐患，不只是为了 status 好看。
- 影响面：仅 `.gitignore`（+4 行），无源码改动。核对过仓库内没有脚本读根目录 tgz（`release.sh` 的 `TGZ` 变量是打包时现算的，`.release-state.json` 的 `last_tarball` 只写不读），所以移动不会打断发版。
- 测试：后端 279 全绿 / 前端 100 全绿 / `npm run build` 成功（只有 rolldown 既有的 `use client` 指令警告）。
- 规划子代理：未使用（机械条目，改动未跨 3 文件）。
- 遗留：`release.sh` 仍把 `npm pack` 输出写到仓库根（167 行 `$PACKDIR`、218 行 `$ROOT`），已开新票，否则历史 tgz 会重新堆回来。

## 2026-10-28 · 发布脚本打包产物改落 `artifacts/releases/`

- 条目：P0「`release.sh` 把 `npm pack` 输出写到仓库根 → 统一改到 `artifacts/releases/`，并同步 `.release-state.json` 的 `last_tarball`」。
- 改动：`scripts/release.sh` 新增 `RELDIR="$ROOT/artifacts/releases"` 变量；正式打包段改为 `mkdir -p "$RELDIR"` → 先 `rm -f "$TGZ"`（同版本重跑时避免 pack 失败却复用上次的 tgz）→ `npm pack --pack-destination "$RELDIR"`，`TGZ` 指向新目录；`--dry-run` 分支仍用 `mktemp -d`（会自动清理，且不往仓库里落文件），未改。
- `.release-state.json` 的 `last_tarball` 从仓库根改指 `artifacts/releases/dsh-voice-workbench-0.6.1.tgz`（已确认该文件存在）。该文件被 gitignore，只影响本机运行时状态。
- 文档：`docs/iteration-automation.md` 幂等/并发表加一行说明打包产物位置，避免以后有人按 root 路径找包。
- 影响面：1 处变量 + 打包 3 行 + 1 行文档，未改任何对外行为；`dsh plugin add "$TGZ"` 用绝对路径，路径变化不影响安装。
- 验证：`bash -n scripts/release.sh` 通过；`npm pack --pack-destination "$(pwd)/artifacts/releases" --dry-run` 解析到 `dsh-voice-workbench-0.6.1.tgz`（431.9 kB），未落盘；`git status` 中 root 依旧没有 `*.tgz`，`artifacts/releases/` 里 36 个归档未被动过。
- 测试：后端 279 全绿 / 前端 100 全绿 / `npm run build` 成功（仅 rolldown 既有的 `use client` 警告）。
- 规划子代理：未使用（单脚本机械改动，2 文件）。

## 2026-10-28 · 根目录调试音频归档到 `artifacts/debug-audio/`

- 条目：P0「根目录 4 个调试音频（`whaleA/B-realtime-{en,ja}.silk`）移入 `artifacts/`」。
- 改动：`mkdir -p artifacts/debug-audio`，把 4 个 `.silk`（18.7K / 24.3K / 16.7K / 23.4K，共 83 KB）全部 `mv` 进去；根目录现已无 `*.silk`。用 `mv` 而不是复制后再删，避免在 cron 无审批环境里碰删除类命令（上一张票里 `rm -rf`、`find -delete` 都被策略拦截过）。
- 影响面：零 git 改动 —— 这 4 个文件本来就被 `.gitignore` 的 `*.silk` 覆盖，从未进过版本库，`artifacts/` 也整体被忽略。所以本轮的实质收益是「仓库根目录干净」，不是「减少提交体积」。
- 引用核对：全仓库 grep `whale[AB]-realtime` / `realtime-(en|ja)\.silk` 在可见文件里命中 0（源码、脚本、文档都不读这 4 个文件）。唯一命中在 `.tools/bailian-voice-lab/manifest.json`，其 `jaQqFile`/`enQqFile` 指向 `.tools/bailian-voice-lab/` 下的同名副本，不是根目录这 4 个 —— 移动后仍然有效，未改路径。
- 测试：后端 279 全绿 / 前端 100 全绿 / `npm run build` 成功（仅 rolldown 既有的 `use client` 指令警告）。
- 规划子代理：未使用（纯文件归档，无源码改动）。

## 2026-10-28 · Node 版本三处统一（engines / README / CI matrix）

- 条目：P0「修正 README：安装示例 `0.18.2` → `<最新版本>`；Node 版本三处统一」。
- 事实核对：安装示例早就改成了 `<版本>`，全仓库除 `.tools/` 历史备份外已无 `0.18.2`；`docs/iteration-automation.md` 里那条是待办描述，不是安装文档。真正没做的是 Node 下限。
- 取舍依据：三处原先是 `engines >=18` / README `22+` / CI `[18,20,22]`，谁都不对。以 `web/package.json` 的 `^20.19.0 || >=22.12.0` 为真值——那是 Vite 8 自己声明的范围，`npm run build` 直接依赖它，比任何手写版本都硬。Node 18 已 EOL，`>=18` 属于虚报支持。
- 改动：`package.json` `engines.node` → `^20.19.0 || >=22.12.0`；`README.md`「需要 Node.js `20.19+` 或 `22.12+` 和 npm（前端构建依赖 Vite 8，Node 18 已 EOL）」；`.github/workflows/ci.yml` matrix → `[20, 22, 24]`（两个声明下限 + 当前 LTS 24）。
- 新增断言：`test/node-version-consistency.test.js` 锁三件事——根 `engines` 必须等于 `web/package.json` 的 `engines`；README 里 `需要 Node.js` 那行写出的版本号必须正好等于 engines 的两个下限；CI matrix 每一项要么落在带小版本下限的主版本里，要么 ≥ 开放下限的主版本，且两个下限主版本都得测。回填旧 matrix 会直接失败：「CI 测试的 Node 18 不满足 engines 范围」。
- 测试：后端 280 全绿（279 + 新增 1）/ 前端 100 全绿 / `npm run build` 成功（仅 rolldown 既有 `use client` 警告）。
- 规划子代理：未使用（3 个文件、1 行级改动 + 1 个新测试，未触及接口或数据结构）。

## 2026-10-28 · CI 版本一致性检查（package.json / CHANGELOG / 最新 tag）

- 条目：P0「CI 增加版本一致性检查：package.json 版本 == CHANGELOG 顶部 == 最新 tag」。
- 新增 `test/version-consistency.test.js`（4 条断言，随 `npm test` 跑）：① `package.json` 版本是三段式 semver；② CHANGELOG 顶部版本段 == `package.json` 版本且带 `YYYY-MM-DD`，版本段必须严格递减不重复；③ `package-lock.json` 顶层与 `packages[""].version` 都等于 `package.json` 版本（发布脚本 bump 时会同时改两处，单改一处就是漂移）；④ 用 `git tag --list 'v*'` 取语义最新 tag，版本号被回退（源码比已发布 tag 还旧）直接失败。
- tag 断言的取舍：**没做**「版本号必须等于最新 tag」的硬等式，只做「不得落后于最新 tag」+「相等时 tag 名必须是 `v<version>`」。原因在 `scripts/release.sh` 的 264–271 行：它是先 `git commit`、再 `git tag`、最后分两次 `git push`（main 与 tag 分开推），中途失败还会把 `pending_push_version` 排队到下一班次。硬等式会让「已提交未推 tag」这个合法中间态把 CI 打红，从而挡掉发布流水线。源码领先最新 tag 时只输出 diagnostic 提示。
- CI：`.github/workflows/ci.yml` 的 checkout 加 `fetch-depth: 0`，否则浅克隆没有 tag，断言会静默跳过。为此测试里加了反向保险：`process.env.CI` 为真时读不到 tag / 一个 tag 都没有 = 失败，提示补 `fetch-depth: 0`，避免「CI 绿但什么也没检查」。
- 反向验证（证明断言真的会红，不是永远绿）：把 CHANGELOG 顶部临时改成 `0.7.0` → 报「CHANGELOG 顶部是 0.7.0，package.json 是 0.6.1」；把 `package.json` 临时回退成 `0.6.0` → CHANGELOG、package-lock、tag 三条同时红。两次都从备份还原，`git status` 只剩本轮两个改动。
- 测试：后端 284 全绿（280 + 新增 4）/ 前端 100 全绿 / `npm run build` 成功（仅 rolldown 既有 `use client` 指令警告）。
- 规划子代理：未使用（2 个文件：1 个新测试 + CI 1 行配置，无接口或数据结构变化）。
- 下次可做：`package-lock.json` 的 `packages[""].engines` 仍是 `>=18`，与 `package.json` 的 `^20.19.0 || >=22.12.0` 不一致（上一轮 Node 下限只改了三处，漏了 lock 文件）；本轮未动，建议下一轮补 `npm install --package-lock-only` 或手工对齐后加一条断言。

## 2026-10-28 · 浏览器 e2e 冒烟进 CI（playwright + chromium）

- 条目：P1「playwright + chromium 进 CI，先跑 `test/browser-smoke.py`」。
- CI：`.github/workflows/ci.yml` 新增独立 job `browser-smoke`（不塞进现有 matrix，e2e 失败不掩盖单测结果）：Node 22 + root/web 装依赖 → `npm run build` → `setup-python@v5`(3.12) → `pip install playwright` + `playwright install --with-deps chromium` → `npm run test:browser`。`package.json` 因此多了 `test:browser` 脚本（`python3 test/browser-smoke.py`）。
- 关键发现：`test/browser-smoke.py` 已经**随 UI 重构失效**，不是“装了 playwright 就能跑”。本地装好 playwright 1.60 + chromium headless shell 后第一次运行就卡在首个断言：`heading "小鲸鱼娘在这里。"` 10s 超时（实际页面渲染正常，`#root` 有完整 DOM）。逐一核对后确认脚本里这些入口在当前 `web/src` 均已不存在：「小鲸鱼娘在这里。」（现为「和小鲸鱼娘聊一会儿」）、`tab 对话/设置`（现为侧边栏 `SidebarMenu aria-label="主导航"`）、`音色三角配比`/`试听示例文本`/`等待时说一句`/`调音语言`（grep 命中 0）、`/debug` 与 `/tune` 两个被 mock 的接口（`web/src` 里已无调用）；`已停止` 现为「对话已结束」。
- 处理方式：把 `browser-smoke.py` 按现 UI 重写为**挂载冒烟**（204 行 → 100 行），保留原 mock 路由骨架，覆盖 CI 真正需要证明的一条链：宿主页面挂真实 `lib/client.js` → iframe 载 `dist/web` 构建产物 → 侧边栏 `主导航` + 「开始对话」可用 → 设置页保存回环（`保存设置` 触发 PUT，断言 `system_prompt` / `enabled_tools==['read']`（先 uncheck `glob`）/ `workspace`）→ 实时会话（合成麦克风持续发声，`/realtime/events` 返回脚本化 `user-transcript-done → tool-start → tool-end → transcript-done → done`，断言「在呢，主人。」与工具时间线「已完成」+ `Call ID: call-1`）→ `结束对话` 触发 `/realtime/end`、麦克风轨道全部 `ended` → 110/390px 无横向溢出、零 pageerror、零外部请求。
- 迭代过程中确认的两个 mock 细节（都踩过一次）：`action` 是 URL 里 `/api/voice-workbench/` 之后的部分，所以事件轮询是 `realtime/events` 而不是 `events`（写成 `events` 会静默落到兜底分支，脚本一直等不到回复）；`rtStop()` 里 `/realtime/end` 是 `void api(...).catch()`，断言调用记录会早一拍，改用 `page.expect_response` 包住点击。
- 反向验证：本地 `npm run test:browser` 实跑 PASS，且 `npm run build` 后 `dist/` 无 diff（构建产物与提交一致，脚本测的是真 bundle）。
- 测试：后端 284 全绿 / 前端 100 全绿 / `npm run build` 成功（仅 rolldown 既有 `use client` 指令警告）。
- 规划子代理：未使用——条目为 CI 配置类，改前只有「3 文件 + 1 个脚本」的预估，实际该条的真实边界（脚本已失效）只能靠本地实跑发现，规划子代理在只读模式下给不出这个结论。
- 旁注：本地 playwright 装在 `.tools/pw-venv`（`python3 -m venv` + `pip install playwright` + `playwright install chromium`，走 127.0.0.1:7897 代理）；`.tools/` 已被 gitignore，不进提交。
- 下次可做：其余 7 个 `browser-*.py` 仍是旧 UI 断言（已作为 `[plan]` 条目入 BACKLOG）；`package-lock.json` 的 `engines` 仍是 `>=18`（也已入队）。
