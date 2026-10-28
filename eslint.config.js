import js from '@eslint/js'
import globals from 'globals'

// 只查正确性、不接管格式：ESLint 的 recommended 里没有格式类规则，
// 因此不需要 eslint-config-prettier，Prettier 与 ESLint 互不重叠。
export default [
  {
    ignores: ['**/node_modules/**', 'dist/**', 'web/dist/**', 'artifacts/**', '.tools/**', 'coverage/**'],
  },
  {
    // .jsx 暂不纳入：espree 不把 JSX 里的标识符算作引用，会把每个组件当作未使用变量。
    files: ['**/*.js', '**/*.mjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    rules: {
      ...js.configs.recommended.rules,
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
    // 浏览器侧：宿主页脚本和 web/src 的纯 .js 逻辑
    files: ['lib/client.js', 'web/src/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
]
