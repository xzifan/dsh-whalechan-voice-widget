import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'

// 只查正确性、不接管格式：ESLint 的 recommended 里没有格式类规则，
// 因此不需要 eslint-config-prettier，Prettier 与 ESLint 互不重叠。
export default [
  {
    ignores: ['**/node_modules/**', 'dist/**', 'web/dist/**', 'artifacts/**', '.tools/**', 'coverage/**'],
  },
  {
    // .jsx 也纳入：ESLint 10 的核心 no-unused-vars 已把 JSX 元素标签算作引用
    // （实测 `<Probe/>` 不报未使用，只有真正没引用的 import 才报），因此不需要
    // eslint-plugin-react 的 jsx-uses-vars —— 它的最新版 peer 只到 eslint ^9.7，
    // 为它降级 ESLint 或加 --legacy-peer-deps 都不划算。
    files: ['**/*.js', '**/*.mjs', '**/*.jsx'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    // 只开 hooks 的两条核心规则，不用插件的 `configs.flat.recommended`：
    // 那份预设还带 React Compiler 规则，实测会在本仓库新增 13 条 error
    // （set-state-in-effect ×11、refs ×1、purity ×1），属于 effect 结构重构，
    // 不是「补门禁」能顺手销掉的量。等重构落地再逐条打开。
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // 仓库用 `try { … } catch {}` 表达「尽力而为、失败即忽略」，空 catch 是有意为之
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
        },
      ],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
    },
  },
  {
    // 浏览器侧：宿主页脚本和 web/src 的纯 .js 逻辑与 .jsx 组件
    files: ['lib/client.js', 'web/src/**/*.js', 'web/src/**/*.jsx'],
    languageOptions: { globals: { ...globals.browser } },
  },
]
