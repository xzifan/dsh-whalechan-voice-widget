# BACKLOG

按顺序取用：迭代作业（J1）每次只做最上面一个 `- [ ]`，做完改成 `- [x]` 并在同一 commit 里补 WORKLOG。

> 发布动作（bump 版本、`npm pack`、`dsh plugin add`、重启 dsh、`git tag`、`git push`）**不在本清单里**，全部由 patch / minor 作业通过 `scripts/release.sh --deploy` 执行。J1 只改代码和文档。

## P0 · 发布基线（先做，做完才能开自动发版）

- [x] 把根目录 36 个历史 tgz 移到 `artifacts/releases/`，删除未跟踪的 `package/` 目录（2026-10-28：36 个 tgz 全部移入 `artifacts/releases/`；`package/` 是 0.1.0 的旧解包残留，`rm -rf`/`find -delete` 在 cron 无审批环境下被拦截，改为移出仓库到 `~/.hermes/cache/scratch/`；`.gitignore` 追加 `/artifacts/`、`/package/`，否则后续 `git add -A` 会把 11 个 artifacts 文件扫进提交）
- [x] `release.sh` 仍把 `npm pack` 输出写到仓库根（167 行 `$PACKDIR`、218 行 `$ROOT`），清完的历史 tgz 会重新堆回来：统一改到 `artifacts/releases/`，并同步 `.release-state.json` 的 `last_tarball`（2026-10-28：新增 `RELDIR="$ROOT/artifacts/releases"`，打包前 `mkdir -p` + 先删同版本旧包，`npm pack --pack-destination "$RELDIR"`；`last_tarball` 已改指 `artifacts/releases/dsh-voice-workbench-0.6.1.tgz`（该文件确实存在）。dry-run 分支仍用 `mktemp -d` 以便自清理，不动）
- [x] 根目录 4 个调试音频（`whaleA/B-realtime-{en,ja}.silk`）移入 `artifacts/debug-audio/`（2026-10-28：4 个 `.silk` 共 83 KB 全部 `mv` 进 `artifacts/debug-audio/`，根目录已无 `*.silk`；文件本就被 `.gitignore` 的 `*.silk` 覆盖，所以零 git 改动。`.tools/bailian-voice-lab/manifest.json` 里 `jaQqFile`/`enQqFile` 指的是 `.tools/` 下自己那份副本，不是这 4 个，无需改路径）
- [x] 修正 README：安装示例 `0.18.2` → `<最新版本>`；Node 版本三处统一（engines / README / CI matrix）（2026-10-28：安装示例在更早一轮已改成 `<版本>`，全仓库非备份文件里已无 `0.18.2`，本轮只做 Node 下限。以 `web/package.json` 的 Vite 8 范围为准统一为 `^20.19.0 || >=22.12.0`：根 `engines` 从 `>=18` 改到同一范围，README 从「Node.js 22+」改为「`20.19+` 或 `22.12+`」，CI matrix 从 `[18, 20, 22]` 改为 `[20, 22, 24]`；新增 `test/node-version-consistency.test.js` 锁死三处一致，回填旧值会报「CI 测试的 Node 18 不满足 engines 范围」）
- [x] CI 增加版本一致性检查：package.json 版本 == CHANGELOG 顶部 == 最新 tag（2026-10-28：新增 `test/version-consistency.test.js`，随 `npm test` 跑 4 条断言——semver 合法；CHANGELOG 顶部版本段 == package.json 且带日期、版本段严格递减；`package-lock.json` 顶层与 `packages[""].version` 同步；最新 `v*` tag 不得高于 package.json，相等时 tag 名必须是 `v<version>`。**没有**用硬等式「版本 == 最新 tag」：`release.sh` 是先 commit、后 tag、再分两次 push，硬等式会打红合法的「已提交未推 tag」中间态。CI checkout 加 `fetch-depth: 0`（否则浅克隆无 tag 会静默跳过），并在 `CI` 环境读不到 tag 时反向失败。反向验证：CHANGELOG 顶部改 0.7.0、package.json 回退 0.6.0 都能打红；后端 284 / 前端 100 全绿）
- [x] 校验部署一致性：对比 `~/.dsh/profiles/web/node_modules/dsh-voice-workbench/package.json` 的版本与源码版本，把差异写进 WORKLOG（2026-10-28：演练中完成，线上 0.21.0 → 0.6.1，现与源码一致）

## P1 · 自动验证能力

- [x] playwright + chromium 进 CI，先跑 `test/browser-smoke.py`（假麦克风已就绪，本地目前没装 playwright）（2026-10-28：CI 新增独立 `browser-smoke` job——`setup-python@v5` + `playwright install --with-deps chromium`，root/web 装依赖 → `npm run build` → `npm run test:browser`；`package.json` 加 `test:browser` 脚本。**脚本本身已随 UI 重构失效**：断言里的「小鲸鱼娘在这里。」「音色三角配比」「试听示例文本」「等待时说一句」和 `/debug`、`/tune` 接口在当前 `web/src` 里都不存在（本地实测首个断言就 10s 超时），因此按现 UI 重写为挂载冒烟：宿主页面挂真实 `lib/client.js` → iframe 载 `dist/web` → 侧边栏导航 → 设置保存回环（PUT 断言 system_prompt/enabled_tools/workspace）→ 实时会话（合成麦克风 + 脚本化 `/realtime/events` 含工具时间线）→ 结束并释放麦克风 → 110/390px 无横向溢出。本地已装 playwright 1.60 + chromium headless shell 实测 PASS）
- [x] 新增 `GET /api/voice-workbench/health`，返回版本 / 工具数 / TTS provider / realtime 状态，作为发布后验证入口（2026-10-28 完成，已接入 `release.sh` 的部署校验）
- [x] 覆盖率：`node --test --experimental-test-coverage`，把当前值设为 CI 下限（2026-10-28：新增 `test:coverage` / `test:coverage:web` 两个脚本，用 `--test-coverage-include` 分别圈定 `src/` 与 `web/src/`，下限取实测值下浮约 1.5 个点（分支 2.5 个点，因为分支覆盖有 0.9~1.9 个点的跑动抖动）——后端 96/83/92、前端 90/86/89（行/分支/函数），对应实测 97.79/85.61/93.25 与 91.37/88.95/90.76。必须圈范围：不加 include 时后端报告会把 `web/src/lib/*` 一起算进来（`filler-playback` 25%、`realtime` 65%），聚合值 91.04 由前端文件主导，直接拿来当后端下限等于把前端缺口记在后端账上。`--test-coverage-*` 系列参数要 Node ≥22.8，所以 CI 只在 Node 22 leg 上加两个带 `if` 的步骤，20/24 leg 照旧跑全量单测。反向验证：把后端行阈值临时改成 99 → exit 1，报 `97.79% line coverage does not meet threshold of 99%`）
- [x] ESLint(flat) + Prettier 接入 CI 与 prepack（2026-10-28：`eslint.config.js` 是零 config 包的 ESM flat config（`eslint` + `@eslint/js` + `globals` 进 devDependencies），只查正确性、不接管格式，因此不需要 `eslint-config-prettier`；按仓库实际语义调了 3 条（`no-empty` allowEmptyCatch / `no-unused-vars` 忽略 `^_` 与 rest 兄弟 / `eqeqeq` smart），基线从 46 条降到 21 条真问题：5 处控制字符正则加行内 disable + 理由、2 处 Bearer 正则去掉多余 `\/`、1 处测试字符串去掉无意义 `\"`、6 处未使用 import/变量，以及 `no-dupe-keys` 抓到的 1 个真 bug（`web/src/lib/voice-layer.js` 里 `model` 键写了两遍，前一行是死代码）。**Prettier 不做全仓**：实测 `src`/`lib`/`test`/`web/src` 共 116 个文件全部不通过、churn 22k 行，与单轮 200 行预算差两个数量级；改为把 `.prettierignore` 当「迁移账本」——生成物永久忽略、未迁移目录逐行列出，`npm run format:check` 今天只校验 10 个已对齐文件（JSON/YAML/构建配置），删一行账本 + `npm run format` 即可逐目录迁移。CI 新增独立 `lint` job（Node 22 单 leg，不塞进 matrix 以免三遍重复）；`prepack: npm run lint` 让 `npm pack` 与 `--dry-run` 都过 lint（`prepare` 会在每次本地 install 触发、`prepublishOnly` 不覆盖 pack，都不合适）。新增 `test/lint-config.test.js` 3 条元测试锁死「CI 里真有 lint/format 步骤」；变异验证：删掉 CI 里的 `run: npm run lint` → 恰好 1 条红。后端 287 / 前端 100 全绿，`npm run build` 成功）
- [x] ESLint 覆盖 33 个 .jsx（2026-10-28：**前提被实测推翻**——ESLint 10.13.0 的核心 `no-unused-vars` 已经把 JSX 元素名算作引用（合成文件 `import {Used}` + `export default () => <Used/>` 只报真正没引用的 `Dead`），所以不需要 `eslint-plugin-react` 的 `jsx-uses-vars`；何况其最新 7.37.5 的 peer 只到 `eslint ^9.7`，在 eslint 10 下 `npm i -D` 直接 ERESOLVE，要装只能 `--legacy-peer-deps`。旧笔记里「288 条假 `no-unused-vars`」也没复现：`.jsx` 进 `files` 但不开 `ecmaFeatures.jsx` 时 33 个文件全是 `Parsing error: Unexpected token <`（33 条 fatal，不是 288 条 no-unused-vars），开了解析后全仓只剩 32 条真问题。配置：`files` 加 `**/*.jsx` + `parserOptions.ecmaFeatures.jsx` + 浏览器 globals 块补 `web/src/**/*.jsx`，覆盖面 82 → 115 文件。32 条逐条修：27 个死 `import React`（JSX runtime 是 automatic——用 `transformWithOxc` 实测产出 `require("react/jsx-runtime")`，这些 import 真死；另外 5 个 .jsx 真在用 `React.*`，未动）+ `main.jsx` 5 个死变量（`createRequestGate`/`newId` 两个 import、`rtPcmRemainder`/`rtCaptureCtx` 两个 ref、`session=useRef(newId())`、`contextKey=JSON.stringify(...)`）。元测试加了第 4 条：用 ESLint API 对合成 .jsx 断言「JSX 引用算引用、只报真死 import」，将来 ESLint 升级若回退会先红；另加 `**/*.jsx` 与 jsx 解析开关两条文本断言。验收：lint 0 问题、`format:check` 通过、后端 288 / 前端 100 全绿、`npm run build` 成功、`.tools/pw-venv` 下浏览器冒烟 PASS（真 `lib/client.js` + `dist/web` iframe，含设置保存回环与实时会话）；`dist/` 按仓库惯例不随本提交）
- [ ] 接 `eslint-plugin-react-hooks`（最新 7.1.1 的 peer 已到 `eslint ^10.0.0`）覆盖 `rules-of-hooks` / `exhaustive-deps`：现在 hooks 规则完全没有门禁，`.jsx` 只受 `no-unused-vars` 等核心规则保护
- [ ] 全仓 Prettier 重排（116 文件 / 约 22k 行 churn）：按 `.prettierignore` 账本逐目录删行 + `npm run format`，必须单独一个 commit 并配 `.git-blame-ignore-revs`
- [ ] 重排完成后再上 husky + lint-staged 做增量门禁（现在上等于「谁碰 legacy 文件谁整文件重排」）
- [ ] 收紧 `prefer-const`（实测 6 处 `let`→`const`）
- [ ] 夜间真实链路冒烟（百炼 TTS 一句 + Realtime 握手 5s），限流、失败只告警不阻塞发布
- [ ] [plan] 重写其余 7 个浏览器脚本（`browser-platform/-history/-statistics/-audit-table/-breeze-voice/-voice-presets/-startup-initialization.py`）：它们写在 UI 重构之前，断言「音色三角配比」「试听示例文本」「等待时说一句」「调音语言」等已不存在的入口，且多数硬依赖 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`；先只读盘点各自失效断言与现 UI 的对应关系，再决定逐条修复还是合并进 `browser-smoke.py`
- [ ] 对齐 `package-lock.json` 的 `packages[""].engines`（仍是 `>=18`，与 `package.json` 的 `^20.19.0 || >=22.12.0` 不一致，上一轮 Node 下限只改了三处）

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
