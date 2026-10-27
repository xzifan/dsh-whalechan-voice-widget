#!/usr/bin/env bash
# 可选的小时级发布闸门（给 Hermes cron 的 monitor 用）
# 输出只依赖时钟：idle | patch | minor —— 同一小时内重复调用输出一致，
# 只有跨过 16:00 / 午夜 / 周末边界时才会变化，避免 monitor 每 tick 都唤醒 agent。
# 注意：Hermes 原生 cron 已支持漏跑补偿（cron.catch_up_missed），
# 单用 `0 16 * * 1-5` 这两个作业即可；本脚本只在需要“任意整点补发”时使用。
set -uo pipefail
DOW="$(date +%u)"   # 1=Mon .. 7=Sun
HOUR="$(date +%-H)"
if [ "$HOUR" -lt 16 ]; then
  echo "idle"
elif [ "$DOW" -le 5 ]; then
  echo "patch"
elif [ "$DOW" -eq 6 ]; then
  echo "minor"
else
  echo "idle"        # 周日不发版
fi
