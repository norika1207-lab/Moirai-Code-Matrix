#!/usr/bin/env python3
"""Code-Duo Slack 收訊工具（協定 v1）。純 stdlib，輪詢制。

用法:
  coord_read.py --role dev            # 抓一次上次讀取點之後的新訊息
  coord_read.py --role dev --follow   # 每 15 秒輪詢一次，Ctrl-C 停
  coord_read.py --role dev --all      # 忽略路由，頻道所有新訊息都印（debug 用）

給我看的訊息 = envelope 的 to: 含我的角色或 all，或沒有 envelope 的人類訊息。
自己發的訊息不會印。讀取點存 ~/.config/code-duo/state-<role>.json。
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

CONF_DIR = os.path.expanduser("~/.config/code-duo")
ENV_PATH = os.path.join(CONF_DIR, "slack.env")
TOPICS_PATH = os.path.join(CONF_DIR, "topics.json")
ENVELOPE_RE = re.compile(r"^\[([\w-]+)\]\s*\[to:\s*([^|\]]+)\|")


def load_env():
    env = {}
    if not os.path.exists(ENV_PATH):
        sys.exit(f"找不到 {ENV_PATH}（見 README）")
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def api_get(method, token, params):
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(
        f"https://slack.com/api/{method}?{qs}",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        out = json.loads(resp.read())
    if not out.get("ok"):
        sys.exit(f"Slack API {method} 失敗: {out.get('error')}")
    return out


def fetch_new(token, channel, oldest):
    """頻道主線 + 所有已知 topic thread 的新訊息，依 ts 排序回傳。"""
    msgs = []
    out = api_get("conversations.history", token,
                  {"channel": channel, "oldest": oldest, "limit": 100})
    msgs.extend(out.get("messages", []))
    for thread_ts in load_json(TOPICS_PATH, {}).values():
        out = api_get("conversations.replies", token,
                      {"channel": channel, "ts": thread_ts,
                       "oldest": oldest, "limit": 100})
        # replies 會把 thread 首則也回來，靠 oldest 過濾重複
        msgs.extend(m for m in out.get("messages", [])
                    if float(m.get("ts", 0)) > float(oldest))
    seen, uniq = set(), []
    for m in sorted(msgs, key=lambda m: float(m.get("ts", 0))):
        if (m["ts"] not in seen and m.get("type") == "message"
                and m.get("subtype") not in ("channel_join", "channel_leave")):
            seen.add(m["ts"])
            uniq.append(m)
    return uniq


def addressed_to_me(text, my_role):
    m = ENVELOPE_RE.match(text or "")
    if not m:
        return True, "human"          # 無 envelope = 人類訊息，全員收
    sender, to = m.group(1), m.group(2)
    if sender == my_role:
        return False, sender          # 自己發的不收
    targets = [t.strip() for t in to.split(",")]
    return ("all" in targets or my_role in targets), sender


def run_once(env, my_role, show_all):
    token = env["SLACK_BOT_TOKEN"]
    channel = env.get("CODE_DUO_CHANNEL", "C0BGSP6UMCN")
    state_path = os.path.join(CONF_DIR, f"state-{my_role}.json")
    state = load_json(state_path, {"last_ts": "0"})

    new_last = state["last_ts"]
    count = 0
    for m in fetch_new(token, channel, state["last_ts"]):
        new_last = max(new_last, m["ts"], key=float)
        text = m.get("text", "")
        ok, sender = addressed_to_me(text, my_role)
        if not (ok or show_all):
            continue
        count += 1
        who = m.get("username") or m.get("user") or "?"
        stamp = time.strftime("%m-%d %H:%M", time.localtime(float(m["ts"])))
        print(f"───── [{stamp}] {who} (ts={m['ts']}) ─────")
        print(text)
        print()

    os.makedirs(CONF_DIR, exist_ok=True)
    with open(state_path, "w") as f:
        json.dump({"last_ts": new_last}, f)
    return count


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--role", required=True)
    p.add_argument("--follow", action="store_true")
    p.add_argument("--interval", type=int, default=15)
    p.add_argument("--all", action="store_true", help="忽略路由全印")
    args = p.parse_args()

    env = load_env()
    if args.follow:
        print(f"[{args.role}] 開始輪詢 #code-duo（每 {args.interval}s）...",
              file=sys.stderr)
        while True:
            run_once(env, args.role, args.all)
            time.sleep(args.interval)
    else:
        n = run_once(env, args.role, args.all)
        if n == 0:
            print("(沒有新訊息)", file=sys.stderr)


if __name__ == "__main__":
    main()
