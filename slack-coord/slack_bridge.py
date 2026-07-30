#!/usr/bin/env python3
"""Code-Duo Slack Bridge — 讓 #code-duo 的訊息自動驅動本機 CLI agent 回應。

原理:
  Code-Duo 每個視窗是「一次性喚醒」的 claude session（claude -p --resume）。
  這支橋常駐輪詢 Slack，讀到點名某角色的訊息，就主動幫那個角色跑一次
  claude -p（用該角色專屬、獨立於網頁視窗的 session），拿到回應後自動
  coord_send 回 Slack。等於給睡著的視窗裝一隻耳朵。

  角色 session 獨立於 Code-Duo 網頁 pane，避免兩個 resume 撞同一 session 而 hang。

用法:
  slack_bridge.py --role architect --once      # 處理一次未讀，回完就停（實測用）
  slack_bridge.py --role dev --follow          # 常駐輪詢（每 15s）
  slack_bridge.py --role auditor --follow --model opus

env: ~/.config/code-duo/slack.env（SLACK_BOT_TOKEN / CODE_DUO_CHANNEL）
"""
import argparse, json, os, re, subprocess, sys, time
import urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONF_DIR = os.path.expanduser("~/.config/code-duo")
ENV_PATH = os.path.join(CONF_DIR, "slack.env")
TOPICS_PATH = os.path.join(CONF_DIR, "topics.json")
ROLES_PATH = os.path.join(HERE, "roles.json")
PROTOCOL_PATH = os.path.join(HERE, "coord-protocol-v1.md")
SEND_PY = os.path.join(HERE, "coord_send.py")
ENVELOPE_RE = re.compile(r"^\[([\w-]+)\]\s*\[to:\s*([^|\]]+)\|")
ROUTE_RE = re.compile(r"^@@\s+to=(\S+)\s+kind=(\S+)\s+topic=(\S+)\s*$")
HOME = os.path.expanduser("~")


def find_claude():
    import shutil
    cand = (os.environ.get("DUO_CLAUDE_BIN"), shutil.which("claude"),
            "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
            os.path.join(HOME, ".local/bin/claude"),
            os.path.join(HOME, ".npm-global/bin/claude"),
            os.path.join(HOME, ".bun/bin/claude"))
    for p in cand:
        if p and os.path.exists(p):
            return p
    sys.exit("找不到 claude CLI，設 DUO_CLAUDE_BIN 指到它")


CLAUDE_BIN = find_claude()


def load_env():
    env = {}
    if not os.path.exists(ENV_PATH):
        sys.exit(f"找不到 {ENV_PATH}")
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
    req = urllib.request.Request(f"https://slack.com/api/{method}?{qs}",
                                 headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        out = json.loads(resp.read())
    if not out.get("ok"):
        sys.exit(f"Slack API {method} 失敗: {out.get('error')}")
    return out


def fetch_new(token, channel, oldest):
    msgs = []
    out = api_get("conversations.history", token,
                  {"channel": channel, "oldest": oldest, "limit": 100})
    msgs.extend(out.get("messages", []))
    for thread_ts in load_json(TOPICS_PATH, {}).values():
        out = api_get("conversations.replies", token,
                      {"channel": channel, "ts": thread_ts,
                       "oldest": oldest, "limit": 100})
        msgs.extend(m for m in out.get("messages", [])
                    if float(m.get("ts", 0)) > float(oldest))
    seen, uniq = set(), []
    for m in sorted(msgs, key=lambda m: float(m.get("ts", 0))):
        if (m["ts"] not in seen and m.get("type") == "message"
                and m.get("subtype") not in ("channel_join", "channel_leave")):
            seen.add(m["ts"])
            uniq.append(m)
    return uniq


def for_me(text, my_role):
    """回傳 (要不要處理, 這則的 topic)。自己發的不處理。"""
    m = ENVELOPE_RE.match(text or "")
    if not m:
        return True, None                      # 無 envelope = 人類，處理
    sender, to = m.group(1), m.group(2)
    if sender == my_role:
        return False, None
    targets = [t.strip() for t in to.split(",")]
    return ("all" in targets or my_role in targets), None


def topic_of(text):
    m = re.search(r"topic:\s*([\w-]+)", text or "")
    return m.group(1) if m else None


def build_prompt(role, disp, msgs, first_time):
    lines = []
    for m in msgs:
        who = m.get("username") or m.get("user") or "?"
        lines.append(f"[{who}] {m.get('text','')}")
    inbox = "\n\n".join(lines)
    head = ""
    if first_time:
        role_md = open(os.path.join(HERE, "..", "roles",
                       ROLE_FILES[role])).read() if role in ROLE_FILES else ""
        try:
            protocol = open(PROTOCOL_PATH).read()
        except OSError:
            protocol = ""
        head = (f"你是 Code-Duo 多 agent 系統的「{role}」（Slack 顯示名 {disp}）。\n\n"
                f"=== 你的角色定義（載入並內化）===\n{role_md}\n\n"
                f"=== 協作協定 ===\n{protocol}\n\n")
    return (head +
            f"=== 你在 Slack #code-duo 剛收到這些新訊息 ===\n{inbox}\n\n"
            "請依你的角色與協定判斷要不要回應、以及要不要動手做事。硬規則:\n"
            "1. 你可以也應該動用工具把事情做實:讀檔 Read、抓網頁 WebFetch、搜尋 Grep/Glob、"
            "跑指令 Bash、寫檔 Write/Edit 都可以。先把該讀的讀完、該做的做完,再回報,不要空談。\n"
            "2. 大產出(盤點、報告、程式碼)寫成檔案(開發檔放 /Volumes/ADATA),Slack 只發"
            " pointer 路徑 + sha256 + 幾句摘要,不要把長內容塞進 Slack。\n"
            "3. 沒親自驗證的不准當事實講,沒讀到就說沒讀到,結論要附讀到的出處(檔:行 或 URL)。\n"
            "4. 你把工作做完後,最終這則回覆的第一行必須是路由行,格式固定:\n"
            "   @@ to=<architect|dev|auditor|all|norika> kind=<answer|ack|fyi|ask|deliver> topic=<kebab-slug>\n"
            "   第二行起才是要發到 Slack 的正文,不要自己加 [role][to:...] 那種 envelope。\n"
            "5. 若此刻判斷不需回應(訊息不是找你、或該等別的角色先動),整個輸出只給一個字: PASS\n"
            "6. Slack 正文精簡在 1500 字內,細節寫檔。")


ROLE_FILES = {"architect": "pm-architect-uiux.md",
              "dev": "developer-omni.md",
              "auditor": "auditor-sentinel.md"}


def call_claude(prompt, role, model, mode):
    sess_path = os.path.join(CONF_DIR, f"bridge-sess-{role}.json")
    sid = load_json(sess_path, {}).get("id")
    cmd = [CLAUDE_BIN, "-p", prompt, "--output-format", "json",
           "--permission-mode", mode]
    if sid:
        cmd += ["--resume", sid]
    if model:
        cmd += ["--model", model]
    p = subprocess.run(cmd, cwd=HERE, stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, timeout=1800)
    try:
        d = json.loads(p.stdout)
    except Exception:
        return None, f"[claude 輸出無法解析] {p.stderr[:300] or p.stdout[:300]}"
    new_sid = d.get("session_id")
    if new_sid:
        os.makedirs(CONF_DIR, exist_ok=True)
        with open(sess_path, "w") as f:
            json.dump({"id": new_sid}, f)
    return d.get("result", ""), None


def parse_reply(raw, fallback_topic):
    raw = (raw or "").strip()
    if raw.upper() == "PASS" or raw.upper().startswith("PASS\n"):
        return None
    first, _, rest = raw.partition("\n")
    m = ROUTE_RE.match(first.strip())
    if m:
        return {"to": m.group(1), "kind": m.group(2),
                "topic": m.group(3), "body": rest.strip()}
    return {"to": "norika", "kind": "answer",
            "topic": fallback_topic or "norika-chat", "body": raw}


def send(role, r):
    subprocess.run([sys.executable, SEND_PY, "--role", role,
                    "--to", r["to"], "--kind", r["kind"],
                    "--topic", r["topic"], "--message", r["body"]],
                   check=True)


def run_once(env, role, disp, model, mode="default"):
    token = env["SLACK_BOT_TOKEN"]
    channel = env.get("CODE_DUO_CHANNEL", "C0BGSP6UMCN")
    state_path = os.path.join(CONF_DIR, f"bridge-state-{role}.json")
    st = load_json(state_path, {"last_ts": "0"})
    first_time = not os.path.exists(os.path.join(CONF_DIR, f"bridge-sess-{role}.json"))

    mine, new_last = [], st["last_ts"]
    for m in fetch_new(token, channel, st["last_ts"]):
        new_last = max(new_last, m["ts"], key=float)
        ok, _ = for_me(m.get("text", ""), role)
        if ok:
            mine.append(m)

    handled = 0
    if mine:
        fb_topic = topic_of(mine[-1].get("text", ""))
        raw, err = call_claude(build_prompt(role, disp, mine, first_time), role, model, mode)
        if err:
            print(f"[{role}] {err}", file=sys.stderr)
        else:
            r = parse_reply(raw, fb_topic)
            if r is None:
                print(f"[{role}] agent 判斷 PASS,不回應", file=sys.stderr)
            else:
                send(role, r)
                handled = 1
                print(f"[{role}] 已回應 → to={r['to']} topic={r['topic']}", file=sys.stderr)

    os.makedirs(CONF_DIR, exist_ok=True)
    with open(state_path, "w") as f:
        json.dump({"last_ts": new_last}, f)
    return handled, len(mine)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--role", required=True, choices=list(ROLE_FILES))
    p.add_argument("--once", action="store_true", help="處理一次未讀就停（預設行為，寫明用）")
    p.add_argument("--follow", action="store_true")
    p.add_argument("--interval", type=int, default=15)
    p.add_argument("--model", default=None)
    p.add_argument("--mode", default="default",
                   help="claude --permission-mode。預設 default（安全，工具要批准）。"
                        "norika 2026-07-14 授權全自主時啟動帶 --mode bypassPermissions。")
    args = p.parse_args()

    env = load_env()
    roles = load_json(ROLES_PATH, {})
    disp = roles.get(args.role, {}).get("display_name", args.role)

    if args.follow:
        print(f"[{args.role}] bridge 常駐輪詢 #code-duo（每 {args.interval}s，"
              f"model={args.model or 'CLI 預設'}）...", file=sys.stderr)
        while True:
            try:
                run_once(env, args.role, disp, args.model, args.mode)
            except Exception as e:
                print(f"[{args.role}] 這輪出錯,繼續: {e}", file=sys.stderr)
            time.sleep(args.interval)
    else:
        h, n = run_once(env, args.role, disp, args.model, args.mode)
        print(f"[{args.role}] 掃到 {n} 則點名我的訊息,回應 {h} 則", file=sys.stderr)


if __name__ == "__main__":
    main()
