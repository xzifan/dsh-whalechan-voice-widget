#!/usr/bin/env bash
# dsh-voice-workbench 发布流水线
# 用法: scripts/release.sh [--slot patch|minor] [--deploy] [--dry-run] [--force]
#   --slot     patch(默认) | minor
#   --deploy   打包后安装到 dsh web profile 并重启验证
#   --dry-run  只跑测试/构建/打包检查，不改版本、不提交、不推送
#   --force    忽略“今天已发布”“仓库不干净”等幂等守卫
# 退出码: 0 成功或无需发布 | 2 测试失败 | 3 dsh 忙(稍后重试) | 4 已有实例在跑 | 5 前置条件不满足
set -uo pipefail

export PATH="/Users/mac/.nvm/versions/node/v26.8.1/bin:/opt/homebrew/bin:/Users/mac/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 5

SLOT="patch"
DEPLOY=0
DRY=0
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --slot) SLOT="${2:-}"; shift 2 ;;
    --slot=*) SLOT="${1#*=}"; shift ;;
    --deploy) DEPLOY=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 5 ;;
  esac
done
case "$SLOT" in patch|minor) ;; *) echo "--slot must be patch|minor" >&2; exit 5 ;; esac

TODAY="$(date +%Y-%m-%d)"
DOW="$(date +%u)"          # 1=Mon .. 7=Sun
STAMP="$(date +%Y%m%dT%H%M%S)"
STATE="$ROOT/.release-state.json"
LOGDIR="$ROOT/.release-logs"
LOG="$LOGDIR/${STAMP}-${SLOT}.log"
mkdir -p "$LOGDIR"

say() { printf '%s\n' "$*" | tee -a "$LOG"; }
step() { say ""; say "== $* =="; }
die() { say "FAILED: $*"; say "{\"ok\":false,\"slot\":\"$SLOT\",\"reason\":\"$*\"}"; exit "${2:-5}"; }

# ---- 迭代作业正在改代码时不要发版（工作区会脏、语义会混） ----
if [ -f "$ROOT/.work.lock" ]; then
  say "iteration job is running (.work.lock) — deferring release"
  echo "{\"ok\":true,\"skipped\":\"iteration-running\"}"
  exit 3
fi

# ---- 单实例锁（macOS 没有 flock，用 mkdir 原子性） ----
LOCK="$ROOT/.release.lock"
if [ -d "$LOCK" ]; then
  age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  if [ "$age" -gt 5400 ]; then
    say "removing stale lock (${age}s old)"; rmdir "$LOCK" 2>/dev/null || true
  fi
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  say "another release is running (lock: $LOCK)"; exit 4
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# ---- 0.5 上次已提交但推送失败：只补推送，不重复发版 ----
PENDING_PUSH=""
if [ -f "$STATE" ]; then
  PENDING_PUSH="$(python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("pending_push_version") or "")
except Exception: print("")' "$STATE" 2>/dev/null)"
fi
if [ -n "$PENDING_PUSH" ] && [ "$FORCE" -eq 0 ]; then
  step "retry pending push v$PENDING_PUSH"
  if git push origin main >>"$LOG" 2>&1 && git push origin --tags >>"$LOG" 2>&1; then
    python3 -c 'import json,sys,datetime
p=sys.argv[1]; st=json.load(open(p)); st.pop("pending_push_version",None)
st["pushed"]=True; st["updated_at"]=datetime.datetime.now().astimezone().isoformat(timespec="seconds")
json.dump(st,open(p,"w"),ensure_ascii=False,indent=1)' "$STATE"
    say "push ok for v$PENDING_PUSH"
    echo "{\"ok\":true,\"version\":\"$PENDING_PUSH\",\"pushed\":1,\"retried_push\":true}"
    exit 0
  fi
  # 推送不通不应该挡住当天的发布：继续走正常流程，把新版本记成新的 pending
  say "push still failing (network or credentials) — 继续本班次发版，推送保持排队"
fi

# ---- 0. 幂等：今天同一 slot 已发布过就不再重复 ----
if [ -f "$STATE" ] && [ "$FORCE" -eq 0 ]; then
  LAST_DATE="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("last_release_date",""))' "$STATE" 2>/dev/null)"
  LAST_SLOT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("last_slot",""))' "$STATE" 2>/dev/null)"
  if [ "$LAST_DATE" = "$TODAY" ] && [ "$LAST_SLOT" = "$SLOT" ]; then
    say "already released $SLOT today ($LAST_DATE) — nothing to do"
    echo "{\"ok\":true,\"skipped\":\"already-released\",\"slot\":\"$SLOT\"}"
    exit 0
  fi
fi

# ---- 1. 前置条件 ----
step "preconditions"
[ -d .git ] || die "not a git repo"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "branch is $BRANCH, expected main"
if [ "$SLOT" = "minor" ] && [ "$DOW" != "6" ] && [ "$FORCE" -eq 0 ]; then
  die "minor releases are scheduled for Saturday (today is dow=$DOW); use --force to override"
fi
# CHANGELOG.md 允许由调用方（发布作业）先写入 [Unreleased] 段落后再调脚本，所以不算脏改动
DIRTY="$(git status --porcelain --untracked-files=no | grep -vE '^.. CHANGELOG\.md$' | head -20 || true)"
if [ -n "$DIRTY" ] && [ "$FORCE" -eq 0 ]; then
  say "$DIRTY"
  die "working tree has uncommitted changes; commit or clean first"
fi
command -v node >/dev/null || die "node not found"
CUR_VERSION="$(node -p "require('./package.json').version")"
say "current version: $CUR_VERSION | slot: $SLOT | dry-run: $DRY | deploy: $DEPLOY"

# ---- 2. 自上次 tag 以来是否有内容（无内容则不出空版本） ----
LAST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
if [ -n "$LAST_TAG" ]; then
  CHANGED="$(git rev-list --count "$LAST_TAG"..HEAD)"
else
  CHANGED="$(git rev-list --count HEAD)"
fi
say "commits since ${LAST_TAG:-repo start}: $CHANGED"
if [ "$CHANGED" -eq 0 ] && [ "$FORCE" -eq 0 ]; then
  say "no commits since $LAST_TAG — skipping empty release"
  echo "{\"ok\":true,\"skipped\":\"no-changes\",\"slot\":\"$SLOT\"}"
  exit 0
fi

# ---- 3. dsh 忙则不重启（正在通话时打断代价高，留给下一小时） ----
AUDIT="$HOME/.dsh/storages/voice-workbench-preview/voice-audit.jsonl"
if [ "$DEPLOY" -eq 1 ] && [ "$DRY" -eq 0 ] && [ -f "$AUDIT" ]; then
  IDLE=$(( $(date +%s) - $(stat -f %m "$AUDIT") ))
  DSH_PID="$(pgrep -f 'dsh web' | head -1 || true)"
  if [ -n "$DSH_PID" ] && [ "$IDLE" -lt 600 ]; then
    say "dsh activity ${IDLE}s ago (voice session likely live) — postponing restart"
    echo "{\"ok\":true,\"skipped\":\"dsh-busy\",\"retry_after_minutes\":15}"
    exit 3
  fi
fi

# ---- 4. 测试与构建（红则不发版） ----
step "backend tests"
npm test >>"$LOG" 2>&1 || die "backend tests failed" 2
say "  $(grep -E '^ℹ (tests|pass|fail) ' "$LOG" | tail -3 | tr '\n' ' ')"

step "frontend tests"
npm run test:web >>"$LOG" 2>&1 || die "frontend tests failed" 2
say "  $(grep -E '^ℹ (tests|pass|fail) ' "$LOG" | tail -3 | tr '\n' ' ')"

step "build"
npm run build >>"$LOG" 2>&1 || die "web build failed" 2
if [ -n "$(git status --porcelain dist 2>/dev/null)" ]; then
  say "note: dist/ changed during build (will be committed with the release)"
fi

# ---- 5. 计算下一个版本 ----
NEXT_VERSION="$(node -e '
const [a,b,c] = require("./package.json").version.split(".").map(Number);
console.log(process.argv[1] === "minor" ? `${a}.${b+1}.0` : `${a}.${b}.${c+1}`);
' "$SLOT")"
say "next version: $CUR_VERSION -> $NEXT_VERSION"

if [ "$DRY" -eq 1 ]; then
  step "dry run: package check"
  PACKDIR="$(mktemp -d)"
  npm pack --pack-destination "$PACKDIR" >>"$LOG" 2>&1 || die "npm pack failed" 2
  say "would publish: $(ls "$PACKDIR")"
  rm -rf "$PACKDIR"
  say ""
  say "DRY RUN OK — would: changelog [Unreleased]->[$NEXT_VERSION], npm version, pack, commit, tag v$NEXT_VERSION"
  [ "$DEPLOY" -eq 1 ] && say "             then: dsh plugin add + restart dsh web + verify"
  echo "{\"ok\":true,\"dry_run\":true,\"current\":\"$CUR_VERSION\",\"next\":\"$NEXT_VERSION\",\"slot\":\"$SLOT\"}"
  exit 0
fi

# ---- 6. CHANGELOG: [Unreleased] -> 版本段落 ----
step "changelog"
python3 - "$NEXT_VERSION" "$TODAY" <<'PY' >>"$LOG" 2>&1 || die "changelog update failed"
import re, sys
ver, day = sys.argv[1], sys.argv[2]
text = open("CHANGELOG.md", encoding="utf-8").read()
if re.search(r"^## \[" + re.escape(ver) + r"\]", text, re.M):
    print("version section already present")
    sys.exit(0)
if "## [Unreleased]" in text:
    text = text.replace("## [Unreleased]", f"## [{ver}] - {day}", 1)
else:
    # 没有 Unreleased 段落：从 git 提交生成，至少保证版本段落存在
    import subprocess
    last = subprocess.run(["git", "describe", "--tags", "--abbrev=0"], capture_output=True, text=True).stdout.strip()
    rng = f"{last}..HEAD" if last else "HEAD"
    log = subprocess.run(["git", "log", "--no-merges", "--pretty=- %s", rng], capture_output=True, text=True).stdout.strip()
    block = f"## [{ver}] - {day}\n\n{log or '- 维护性发布'}\n\n"
    text = text.replace("\n## [", "\n" + block + "## [", 1) if "\n## [" in text else text.rstrip() + "\n\n" + block
open("CHANGELOG.md", "w", encoding="utf-8").write(text)
print("changelog section written")
PY

# ---- 7. 版本号 + 打包 ----
step "bump version"
python3 - "$NEXT_VERSION" <<'PY' >>"$LOG" 2>&1 || die "version bump failed"
import json, sys
ver = sys.argv[1]
for path, keys in (("package.json", None), ("package-lock.json", ("packages", ""))):
    try:
        data = json.load(open(path, encoding="utf-8"))
    except FileNotFoundError:
        continue
    data["version"] = ver
    if keys and isinstance(data.get("packages"), dict) and "" in data["packages"]:
        data["packages"][""]["version"] = ver
    json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    open(path, "a", encoding="utf-8").write("\n")
print("version ->", ver)
PY
TGZ="$ROOT/dsh-voice-workbench-${NEXT_VERSION}.tgz"
npm pack --pack-destination "$ROOT" >>"$LOG" 2>&1 || die "npm pack failed"
[ -f "$TGZ" ] || die "expected tarball missing: $TGZ"
say "packed: $(basename "$TGZ") ($(du -h "$TGZ" | cut -f1))"

# ---- 8. 部署到 dsh web（可选） ----
if [ "$DEPLOY" -eq 1 ]; then
  step "install into dsh web profile"
  dsh plugin --profile web add "$TGZ" --ignore-scripts >>"$LOG" 2>&1 || die "dsh plugin add failed"

  step "restart dsh web"
  # 不能用 $(...) 捕获：后台启动的 dsh 会继承管道写端，命令替换会一直等到超时。
  # 改为写临时文件，父进程立即返回。
  ROUT="$(mktemp)"
  bash "$ROOT/scripts/restart-dsh.sh" >"$ROUT" 2>&1; RC=$?
  while IFS= read -r line; do say "$line"; done <"$ROUT"
  [ "$RC" -eq 0 ] || { rm -f "$ROUT"; die "dsh web restart failed (see log above)"; }
  WEBLOG="$(grep -o '/[^ ]*web-[0-9T]*\.log' "$ROUT" | head -1)"
  TOKEN="$(grep -o 'token=[A-Za-z0-9_-]*' "$ROUT" | head -1)"
  rm -f "$ROUT"

  step "verify installed build"
  INST="$(node -p "require('$HOME/.dsh/profiles/web/node_modules/dsh-voice-workbench/package.json').version" 2>/dev/null || echo missing)"
  [ "$INST" = "$NEXT_VERSION" ] || die "installed version $INST != $NEXT_VERSION"
  JAR="$(mktemp)"; rm -f "$JAR"
  curl -s -c "$JAR" -b "$JAR" -o /dev/null "http://127.0.0.1:3080/?$TOKEN"
  API_CODE="$(curl -s -b "$JAR" -o "$LOGDIR/health-check.json" -w '%{http_code}' "http://127.0.0.1:3080/api/voice-workbench/health")"
  rm -f "$JAR"
  [ "$API_CODE" = "200" ] || die "health API returned $API_CODE (plugin not mounted?)"
  HEALTH="$(python3 - "$LOGDIR/health-check.json" "$NEXT_VERSION" <<'PY'
import json, sys
try: d = json.load(open(sys.argv[1]))
except Exception: print("unreadable"); sys.exit(1)
if d.get("ok") is not True: print("ok!=true"); sys.exit(1)
if d.get("version") != sys.argv[2]: print(f"version {d.get('version')}"); sys.exit(1)
tts = d.get("tts") or {}
print(f"version={d['version']} tts={tts.get('provider')} ready={tts.get('ready')} sessions={d.get('realtime',{}).get('activeSessions')} tools={d.get('tools',{}).get('enabled')}")
PY
)" || die "health check failed: $HEALTH"
  say "installed version: $INST | health: $HEALTH"
fi

# ---- 9. 提交 + tag + push ----
step "commit and tag"
git add package.json package-lock.json CHANGELOG.md dist
git commit -m "chore(release): v${NEXT_VERSION} (${SLOT})" >>"$LOG" 2>&1 || die "git commit failed"
git tag -a "v${NEXT_VERSION}" -m "v${NEXT_VERSION} (${SLOT})" || die "git tag failed"
PUSHED=0
if git push origin main >>"$LOG" 2>&1 && git push origin "v${NEXT_VERSION}" >>"$LOG" 2>&1; then
  PUSHED=1; say "pushed main + v${NEXT_VERSION}"
else
  say "WARN: push failed — 版本已提交并部署，但未推送；下一班次只补推送"
fi

# ---- 10. 记账 ----
python3 - "$STATE" "$TODAY" "$SLOT" "$NEXT_VERSION" "$TGZ" "$PUSHED" <<'PY'
import json, sys, datetime
path, day, slot, ver, tgz, pushed = sys.argv[1:7]
try:
    st = json.load(open(path))
except Exception:
    st = {}
st.update({"last_release_date": day, "last_slot": slot, "last_version": ver,
           "last_tarball": tgz, "pushed": pushed == "1",
           "updated_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds")})
if pushed == "1":
    st.pop("pending_push_version", None)
else:
    st["pending_push_version"] = ver
json.dump(st, open(path, "w"), ensure_ascii=False, indent=1)
print("state updated" + ("" if pushed == "1" else " (pending push)"))
PY

if [ "${PUSHED}" -eq 0 ]; then
  say "版本 v${NEXT_VERSION} 已在本地完成并部署，推送待重试（网络或凭据问题）"
  echo "{\"ok\":false,\"version\":\"$NEXT_VERSION\",\"slot\":\"$SLOT\",\"deployed\":$DEPLOY,\"pushed\":0,\"pending_push\":true}"
  exit 6
fi

step "done"
echo "{\"ok\":true,\"version\":\"$NEXT_VERSION\",\"slot\":\"$SLOT\",\"deployed\":$DEPLOY,\"pushed\":$PUSHED,\"log\":\"$LOG\"}"
