#!/usr/bin/env bash
# 起三個角色的 Slack bridge 常駐（--follow），跟 Code-Duo 一起開著。
# 想指定模型: DUO_BRIDGE_MODEL=opus ./start-bridges.sh
cd "$(dirname "$0")" || exit 1
mkdir -p ~/.config/code-duo
MODEL_FLAG=""
[ -n "$DUO_BRIDGE_MODEL" ] && MODEL_FLAG="--model $DUO_BRIDGE_MODEL"
# norika 2026-07-14 經 AskUserQuestion 明確授權全自主 bypassPermissions
# （agent 可不經逐次批准讀寫檔、跑指令）。臨時改回安全：DUO_BRIDGE_MODE=default ./start-bridges.sh
MODE="${DUO_BRIDGE_MODE:-bypassPermissions}"
for role in architect dev auditor; do
  pidf=~/.config/code-duo/bridge-"$role".pid
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
    echo "跳過 $role（已在跑 pid=$(cat "$pidf")）"; continue
  fi
  nohup python3 slack_bridge.py --role "$role" --follow --mode "$MODE" $MODEL_FLAG \
    >> ~/.config/code-duo/bridge-"$role".log 2>&1 &
  echo $! > "$pidf"
  echo "起 $role pid=$!"
done
echo "log 在 ~/.config/code-duo/bridge-<role>.log"
