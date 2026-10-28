#!/usr/bin/env bash
# 发布中途失败的文件回滚：把 package.json / package-lock.json / CHANGELOG.md 还原到快照，
# 并把它们从暂存区撤下来（release.sh 在 commit 之前已经 git add 过）。
# 用法: scripts/release-rollback.sh <backup-dir> [repo-root]
#   backup-dir 必须含 package.json 与 CHANGELOG.md，package-lock.json 可选。
# 退出码: 0 已回滚或无需回滚 | 5 快照目录不可用（不做任何写入）
set -uo pipefail

BACKUP="${1:-}"
ROOT="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

if [ -z "$BACKUP" ] || [ ! -d "$BACKUP" ]; then
  echo "rollback: backup dir missing: ${BACKUP:-<empty>}"
  exit 5
fi
for required in package.json CHANGELOG.md; do
  if [ ! -f "$BACKUP/$required" ]; then
    echo "rollback: snapshot is incomplete (no $required)"
    exit 5
  fi
done

restored=""
for f in package.json package-lock.json CHANGELOG.md; do
  [ -f "$BACKUP/$f" ] || continue
  # 内容相同就别动，避免无意义地改 mtime 让 git 重新统计
  if cmp -s "$BACKUP/$f" "$ROOT/$f"; then continue; fi
  cp -p "$BACKUP/$f" "$ROOT/$f" || { echo "rollback: failed to restore $f"; exit 5; }
  restored="$restored $f"
done

# 版本号/CHANGELOG 曾被 git add 过（step 9 的反向顺序：先 add 再 commit 失败），
# 只还原工作区会把改动留在暂存区，下一次发版的「工作区必须干净」前置检查仍会拦下来。
if [ -d "$ROOT/.git" ]; then
  git -C "$ROOT" reset -q -- package.json package-lock.json CHANGELOG.md 2>/dev/null || true
fi

if [ -z "$restored" ]; then
  echo "rollback: nothing to restore (files already match the snapshot)"
else
  echo "rollback: restored${restored}; index unstaged (dist/ 不回滚，构建产物下次发布会重建)"
fi
exit 0
