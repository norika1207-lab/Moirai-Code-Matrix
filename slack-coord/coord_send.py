#!/usr/bin/env python3
"""Code-Duo Slack 發訊工具（協定 v1）。純 stdlib，不需 pip。

用法:
  coord_send.py --role dev --to auditor --kind deliver --topic wo-xxx --message "內容"
  coord_send.py --role dev --to all --kind fyi --topic wo-xxx --file /path/to/long.md
  echo "內容" | coord_send.py --role dev --to host --kind ack --topic wo-xxx -

env 檔 ~/.config/code-duo/slack.env:
  SLACK_BOT_TOKEN=xoxb-...
  CODE_DUO_CHANNEL=C0BGSP6UMCN
"""
import argparse
import json
import os
import sys
import urllib.request

MAX_LEN = 6000
KINDS = ("ask", "answer", "ack", "fyi", "deliver", "decision")
CONF_DIR = os.path.expanduser("~/.config/code-duo")
ENV_PATH = os.path.join(CONF_DIR, "slack.env")
TOPICS_PATH = os.path.join(CONF_DIR, "topics.json")
ROLES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "roles.json")


def load_env():
    env = {}
    if not os.path.exists(ENV_PATH):
        sys.exit(f"找不到 {ENV_PATH}，先建檔放 SLACK_BOT_TOKEN（見 README）")
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    if not env.get("SLACK_BOT_TOKEN", "").startswith("xoxb-"):
        sys.exit("slack.env 裡沒有合法的 SLACK_BOT_TOKEN（xoxb- 開頭）")
    return env


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def api(method, token, payload):
    req = urllib.request.Request(
        f"https://slack.com/api/{method}",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        out = json.loads(resp.read())
    if not out.get("ok"):
        sys.exit(f"Slack API {method} 失敗: {out.get('error')}")
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--role", required=True)
    p.add_argument("--to", required=True)
    p.add_argument("--kind", required=True, choices=KINDS)
    p.add_argument("--topic", required=True)
    p.add_argument("--message")
    p.add_argument("--file")
    p.add_argument("stdin_flag", nargs="?", help="用 - 表示從 stdin 讀內文")
    args = p.parse_args()

    roles = load_json(ROLES_PATH, None)
    if roles is None:
        sys.exit(f"讀不到 {ROLES_PATH}")
    if args.role not in roles:
        sys.exit(f"未註冊角色 {args.role}，roles.json 裡只有: {', '.join(roles)}")

    if args.message is not None:
        body = args.message
    elif args.file:
        with open(args.file) as f:
            body = f.read()
    elif args.stdin_flag == "-":
        body = sys.stdin.read()
    else:
        sys.exit("要給內文: --message / --file / -（stdin）")

    envelope = f"[{args.role}] [to: {args.to} | kind: {args.kind} | topic: {args.topic}]"
    text = f"{envelope}\n\n{body.strip()}"
    if len(text) > MAX_LEN:
        sys.exit(
            f"拒發: {len(text)} 字元 > 上限 {MAX_LEN}。"
            "寫成檔案後改發 pointer + sha256（協定 §3.4）"
        )

    env = load_env()
    token = env["SLACK_BOT_TOKEN"]
    channel = env.get("CODE_DUO_CHANNEL", "C0BGSP6UMCN")

    os.makedirs(CONF_DIR, exist_ok=True)
    topics = load_json(TOPICS_PATH, {})

    payload = {
        "channel": channel,
        "text": text,
        "username": roles[args.role].get("display_name", args.role),
        "icon_emoji": roles[args.role].get("icon_emoji", ":robot_face:"),
    }
    thread_ts = topics.get(args.topic)
    if thread_ts:
        payload["thread_ts"] = thread_ts

    out = api("chat.postMessage", token, payload)

    if not thread_ts:
        topics[args.topic] = out["ts"]
        with open(TOPICS_PATH, "w") as f:
            json.dump(topics, f, indent=2)

    print(f"sent ts={out['ts']} topic={args.topic}"
          + ("" if thread_ts is None else f" (thread {thread_ts})"))


if __name__ == "__main__":
    main()
