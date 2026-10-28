# Prettier 全仓迁移计划（S0–S8）

来源：2026-10-28 J1 班次的只读规划子代理实测（整树复制到 scratch 后 `--ignore-path /dev/null --write` + `git diff --numstat` 取增删行）。本文只记录**实测数字与顺序**，每轮的执行记录见 `WORKLOG.md`。

## 为什么不能一次做完

`.prettierrc` 的 `printWidth 120 / semi false / singleQuote` 与现存代码差一整代，全仓 `--write` 是 **124 文件 / 21612 行 churn**（+16013 / −5599）。J1 的硬上限是单轮 ≤200 行，所以只能按「账本逐行删 + `npm run format`」增量迁移，**每个 commit 都是纯格式化 commit**。

## 账本语义的坑（必须先归一）

账本段是 gitignore 语义，不带前导斜杠的目录行匹配**任意层级**同名目录：

| 删掉这行         | 实际解禁                            | 文件 | churn |
| ---------------- | ----------------------------------- | ---- | ----- |
| `src/`（未锚定） | `src/` **+ `web/src/` 非 lib 部分** | 61   | 12177 |
| `lib/`（未锚定） | `lib/` **+ `web/src/lib/`**         | 26   | 3102  |
| `test/`          | `test/`                             | 30   | 6181  |
| `*.md`           | 根 2 + `web/README.md` + `docs/` 3  | 6    | 139   |
| `scripts/`       | 无（只有 .sh/.py，无 parser）       | 0    | 0     |
| `docs/`          | 无（只有 md，已被 `*.md` 覆盖）     | 0    | 0     |

所以目录行一律锚定成 `/src/` `/lib/` `/web/src/` `/test/`，并删掉三条 0 文件空操作（S1 已完成）。

## 剩余量与分批

| 树              | 未格式化文件          | churn | 处理                    |
| --------------- | --------------------- | ----- | ----------------------- |
| md + docs       | 6                     | 139   | S2，一轮可完            |
| `lib/client.js` | 1                     | 189   | S3，一轮可完（依赖 S0） |
| `test/`         | 30（9 个 .py 不参与） | 6181  | S4，23 批               |
| `web/src/lib/`  | 25                    | 2913  | S5，13 批               |
| `web/src/` 其余 | 40                    | 7908  | S6，20 批               |
| `src/`          | 21                    | 4269  | S7，13 批               |

同目录内按 churn 降序 first-fit 装批，上限 200 行/批。**37 个文件单文件就超 200 行**（top：`web/src/style.css` 1163、`src/service.js` 822、`web/src/companion.css` 761、`web/src/audit-view.jsx` 698、`test/realtime-tts.test.js` 640），其中 12 个连**单个 hunk** 都 >200 行，无法切分：

- `prettier --range-start/--range-end` 分块无效：CSS 完全不生效，JS 会整文件重排。
- 按 hunk 手工分堆对 12 个文件物理不可行。

结论：大目录迁移需要「每轮 1 个文件、该 commit 只含该文件 + 1 行账本 + WORKLOG」这类豁免，属**流程决策**，已挂在 BACKLOG「需要产品决策」。

## 必须先做的预修（S0）

不修就红：

- `test/adapter.test.js:41,44,50-52`：对 `lib/client.js` 源码做空格敏感断言（`'...':['POST']`），Prettier 会加空格 → 读取处改成 `.replace(/\s+/g,'')` 再匹配。
- `test/bridge-interruption-regression.test.js:16`：`[^\n]+` 死咬单行守卫块，格式化后变多行 → 改跨行容错正则（要吞掉 `return` 后的 `}`）。
- `src/service.js:471`、`src/tts-config.js:84`：`eslint-disable-next-line` 与真正的正则行隔了 3 行，格式化后报 `no-control-regex` + 未使用 disable → 改块级 disable/enable。
- `src/conversation-filler.js:65-67`：`call.stream({…})[Symbol.asyncIterator]()` 会被折成 `[` 起行，`semi:false` 下触发 `no-unexpected-multiline` → 拆成两句。

实测：不修 → 格式化 `lib/` 后 291/293、格式化 `src/` 后 lint 3 errors + 2 warnings；修完 → 293/293、lint 0。

## 覆盖率门槛会被重排单向拉动

同一套 293 条测试，格式化前后：后端行覆盖 **97.79 → 95.27**（V8 按行归因，一行摊多行后续行记未覆盖；`tts-config.js` 100→89.46、`tts-http.js` 99.42→96.91），直接击穿 `--test-coverage-lines=96`；分支 85.69→85.51、函数 93.25 不变。前端 91.37→90.99，仍过 90 但只剩 0.99 点余量。

处理：S7 中第一个跌破的批次同 commit 把后端行阈值下调到 **93.5**（沿「实测 −1.5~2」口径）并同步 README 里的覆盖率表；前端若报 89.x 同口径下调到 89.5。**不要**为了凑覆盖率去写无意义测试。

## `.git-blame-ignore-revs`

纯文本，`#` 注释，其余每行一个**完整 40 位 sha**。不能在同一个 commit 里写自己的 sha（不动点），所以 S8 单独一个 commit 一次性写入全部格式化 sha，并顺带勾 BACKLOG / 补 WORKLOG。`git config blame.ignoreRevsFile` 是本地配置、无法随仓库下发，需在 README 开发小节写明。`.gitignore` 与 `.prettierignore` 都不用动（无扩展名，Prettier 不处理）。

## 每步验收

`npm test` ≥293、`npm run test:web` ≥100、`npm run lint` 0 问题、`npm run format:check` 通过、`npm run build` 成功；S5–S7 各批加跑对应的 `test:coverage*`。**build 会改 `dist/`（4 个跟踪文件 + 新 hash），`dist/` 只在 `.prettierignore` 不在 `.gitignore`**——每轮 `npm run build` 后必须 `git checkout -- dist/` 并删掉新产出的 `dist/web/assets/index-*.js`，否则纯格式化 commit 会被构建产物污染。
