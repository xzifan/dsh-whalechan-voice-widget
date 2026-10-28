#!/usr/bin/env bash
# 重启 dsh web 并等待就绪；被 release.sh 调用，也可单独执行做演练。
#
# 两个必须成立的条件：
# 1. 从 $HOME 启动 —— qqbot_send_file 的路径白名单包含进程 cwd。
# 2. 子进程不能继承调用方的 stdout/管道 —— 否则调用方（cron 的 terminal 工具、
#    $(...) 命令替换）会一直等 EOF 直到超时。用 setsid + close_fds 彻底脱钩。
set -uo pipefail
export PATH="/Users/mac/.nvm/versions/node/v26.8.1/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
HOME_DIR="${HOME:?}"
LOGDIR="$HOME_DIR/.dsh/logs"
LOG="$LOGDIR/web-$(date +%Y%m%dT%H%M%S).log"
mkdir -p "$LOGDIR"

OLD="$(pgrep -f 'dsh web' | head -1 || true)"
if [ -n "$OLD" ]; then
  echo "stopping dsh web (pid $OLD)"
  kill "$OLD" 2>/dev/null || true
  for _ in $(seq 1 20); do pgrep -f 'dsh web' >/dev/null 2>&1 || break; sleep 0.5; done
  pgrep -f 'dsh web' >/dev/null 2>&1 && { pkill -f 'dsh web' || true; sleep 2; }
else
  echo "dsh web not running, starting fresh"
fi

python3 - "$LOG" <<'PY'
import os, subprocess, sys
log_path = sys.argv[1]
log = open(log_path, "ab", buffering=0)
subprocess.Popen(
    ["dsh", "web", "--no-open"],
    cwd=os.path.expanduser("~"),
    stdin=subprocess.DEVNULL,
    stdout=log,
    stderr=log,
    start_new_session=True,   # setsid：脱离调用方的进程组
    close_fds=True,
)
print("spawned dsh web (detached)")
PY

for _ in $(seq 1 60); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3080/" 2>/dev/null || echo 000)"
  case "$CODE" in 200|303|401) break ;; esac
  sleep 1
done
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3080/" 2>/dev/null || echo 000)"
if [ "$CODE" != "401" ] && [ "$CODE" != "303" ] && [ "$CODE" != "200" ]; then
  echo "FAILED: dsh web did not come up (http=$CODE, log=$LOG)"
  tail -20 "$LOG" 2>/dev/null
  exit 1
fi

PID="$(pgrep -f 'dsh web' | head -1 || true)"
TOKEN="$(grep -ao 'token=[A-Za-z0-9_-]*' "$LOG" | head -1 || true)"
echo "dsh web up: pid=$PID http=$CODE log=$LOG"
[ -n "$TOKEN" ] && echo "url: http://127.0.0.1:3080/?$TOKEN"
grep -aq "Bot ready" "$LOG" && echo "qqbot: reconnected"
lsof -a -p "${PID:-0}" -d cwd -Fn 2>/dev/null | tail -1 | sed 's/^n/cwd: /'
exit 0
