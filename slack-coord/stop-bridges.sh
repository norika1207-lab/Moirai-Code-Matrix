#!/usr/bin/env bash
# 停掉所有 Slack bridge 常駐。
for role in architect dev auditor; do
  pidf=~/.config/code-duo/bridge-"$role".pid
  if [ -f "$pidf" ]; then
    kill "$(cat "$pidf")" 2>/dev/null && echo "停 $role"
    rm -f "$pidf"
  else
    echo "$role 沒在跑"
  fi
done
