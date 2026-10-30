# 要不要把后端改成 TypeScript

结论：**现在不改写，用 JSDoc + `tsc --noEmit` 拿到 90% 的收益；发 SDK 时用 `--emitDeclarationOnly` 生成 `.d.ts`，仍然不用重写。**

## 实测数据（不是估计）

用 `typescript@5` + `@types/node` 对现有源码跑 `--allowJs --checkJs`：

| 范围 | 行数 | 类型错 |
| --- | --- | --- |
| `src/core/**` | 2,950 | **37** |
| `src/**`（含 6 个宿主适配文件） | 3,611 | **62** |
| `test/**` | 6,783 | 未测（测试不跑 checkJs） |
| `web/src/**` | 5,637 | 未测（React 部分另有构建） |

错误构成：`TS2339` 属性不存在 ×19、`TS2345` 参数类型 ×10，其余是 `TS2538/2353/2554/2365/2363/2362`。

**62 个错、3600 行**——这不是"从零上类型"，是一天到两天的量。

## 三条路的成本

| 方案 | 改动量 | 收益 | 代价 |
| --- | --- | --- | --- |
| **全量改 .ts** | ~16,000 行（src + test + web） | 完整类型、重构安全 | 加构建步骤（测试要 tsx/vitest）、`release.sh` 改、DSH 宿主 API 无类型只能 `any` |
| **JSDoc + checkJs** | ~60 处注解 | 接口契约、编辑器提示、CI 拦错 | 无构建、无运行时变化、测试不用改 |
| **不做** | 0 | 0 | 契约继续靠测试兜（已经兜住了两个真 bug） |

## 为什么 JSDoc 这条路够用

1. **类型错集中在接口边界**，而边界只有几处：`AgentCoreDeps`（10 个成员）、`EndpointStrategy`、`AuditRecord`。这三处写 `@typedef`，报错就能从 62 降到个位数。
2. **`tsc` 能把 JSDoc 变成 `.d.ts`**：`--declaration --emitDeclarationOnly` 直接产出类型声明，第三方装 SDK 就有自动补全，一行 JS 都不用改写。
3. **构建链不动**。全量 TS 会让 `node --test test/*.test.js` 失效（Node 不能直接跑 .ts，除非用 `--experimental-strip-types` 或编译），这是 `release.sh` 和 24 个 cron 班次都会踩的坑。

## 什么时候该真的上 TS

- 贡献者超过 2 人，需要靠类型约束协作者；
- SDK 发布后外部开始报"参数用错了"这类问题；
- 前端开始共享 core 的类型（那时 web 侧本来就有构建，成本最低）。

第一条没到之前，**类型不是你的瓶颈**——最近两个真 bug（`releaseToolSession` 没暴露、`PLUGIN_VERSION` 路径错）都是测试抓到的，不是类型抓到的，而且都属于"契约没锁住"，用 4 条契约测试就解决了。

## 如果现在就要动手，顺序是

1. 给 `src/core/index.js` 的公共面写 `@typedef`（`AgentCoreDeps`、`EndpointStrategy`、`AuditRecord`）；
2. `package.json` 加 `"typecheck": "tsc --noEmit --allowJs --checkJs"` + `tsconfig.json`（`checkJs: true`、`strict: false` 起步）；
3. 修 62 个错，把 `typecheck` 加进 CI（不阻塞发布，先观察两周）；
4. 发 SDK 时打开 `--declaration --emitDeclarationOnly`。

第 4 步是关键：它让"给外部用"这件事不需要以重写为代价。
