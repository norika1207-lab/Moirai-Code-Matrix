#!/usr/bin/env python3
# Code Duo — one window driving Claude and Codex; resume past sessions, hand off, audit.
# No API: drives the claude / codex CLIs, authenticated with your subscriptions.
import json, subprocess, threading, time, os, glob, re, shutil, platform, difflib, shlex
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser("~")
SYS = platform.system()


# ---------- auto-detect CLIs and session locations (cross-platform, env-overridable) ----------
def _first_dir(paths):
    for p in paths:
        if p and os.path.isdir(p):
            return p
    return None


def _which(name, extra):
    return shutil.which(name) or next((p for p in extra if p and os.path.exists(p)), None)


def discover():
    # CLI binaries
    claude_bin = os.environ.get("DUO_CLAUDE_BIN") or _which("claude", [
        "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
        os.path.join(HOME, ".local/bin/claude"), os.path.join(HOME, ".npm-global/bin/claude"),
        os.path.join(HOME, ".bun/bin/claude")])
    codex_bin = os.environ.get("DUO_CODEX_BIN") or _which("codex", [
        "/Applications/ChatGPT.app/Contents/Resources/codex",   # desktop app renamed Codex.app -> ChatGPT.app (2026-07)
        "/Applications/Codex.app/Contents/Resources/codex",
        "/opt/homebrew/bin/codex", "/usr/local/bin/codex",
        os.path.join(HOME, ".local/bin/codex")])

    # Claude CLI config dir (override with CLAUDE_CONFIG_DIR) -> projects/
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")
    claude_proj = os.path.join(cfg, "projects")

    # Claude desktop app session index (clean titles; optional, None if not installed -> fall back to jsonl)
    if SYS == "Darwin":
        sess_cands = [os.path.join(HOME, "Library/Application Support/Claude/claude-code-sessions")]
    elif SYS == "Windows":
        sess_cands = [os.path.join(os.environ.get("APPDATA", ""), "Claude", "claude-code-sessions")]
    else:
        xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config")
        sess_cands = [os.path.join(xdg, "Claude", "claude-code-sessions")]
    claude_sess = _first_dir(sess_cands)

    # Codex home (override with CODEX_HOME)
    cx = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
    codex_dirs = [os.path.join(cx, "sessions"), os.path.join(cx, "archived_sessions")]

    return {
        "claude_bin": claude_bin, "codex_bin": codex_bin,
        "claude_proj": claude_proj, "claude_sess": claude_sess,
        "codex_home": cx, "codex_dirs": codex_dirs,
        "codex_index": os.path.join(cx, "session_index.jsonl"),
        "codex_state": os.path.join(cx, ".codex-global-state.json"),
    }


CFG = discover()
CLAUDE_BIN = CFG["claude_bin"]
CODEX_BIN = CFG["codex_bin"]
CLAUDE_PROJ = CFG["claude_proj"]
CLAUDE_SESS = CFG["claude_sess"]
CODEX_DIRS = CFG["codex_dirs"]

# each window (pane) has a switchable engine (claude|codex) + its own session + cwd.
# pane ids stay "claude"/"codex" for back-compat; only the engine attribute varies.
STATE = {"w1": {"engine": "claude", "id": None, "cwd": HERE, "remote": None},
         "w2": {"engine": "codex", "id": None, "cwd": HERE, "remote": None},
         "w3": {"engine": "claude", "id": None, "cwd": HERE, "remote": None},
         "w4": {"engine": "codex", "id": None, "cwd": HERE, "remote": None}}
# shared setting: the real project directory both agents work in
SETTINGS = {"project": None}
# per-window (pane) model / mode / effort, defaulted from each pane's engine
_CLAUDE_DEF = {"model": "", "mode": "default", "effort": "", "fast": False}
_CODEX_DEF = {"model": "", "mode": "read-only", "effort": ""}
def _default_cfg(engine):
    return dict(_CLAUDE_DEF) if engine == "claude" else dict(_CODEX_DEF)
AGENT_CFG = {p: _default_cfg(STATE[p]["engine"]) for p in STATE}
# which modes can write files (used by the watchdog to decide whether to diff the disk)
_WRITABLE = {"acceptEdits", "bypassPermissions", "auto", "dontAsk", "workspace-write", "danger-full-access"}
LOCK = threading.Lock()

# ---- shared content: all windows read one common pool. always on, not a toggle. ----
# every completed exchange (the command you sent + what that window produced) is appended
# to SHARED. before a window runs, it is fed everything the OTHER windows have said that it
# has not been shown yet. delta only, so nothing is ever resent twice, and nothing is cut.
SHARED = []                            # [{"seq":int, "pane":str, "role":"user"|"bot", "text":str}]
SHARED_SEEN = {p: 0 for p in STATE}    # highest seq each pane has already been fed
NAMES = {}                             # pane -> display name (the browser tells us)
_SEQ = [0]

# persist pane state (engine/session/cwd), per-pane cfg and project across server restarts,
# so a page refresh / server restart drops the user back into exactly the work they left
PERSIST_PATH = os.path.join(HERE, "duo_state.json")


def _save_state():
    # call OUTSIDE of LOCK (non-reentrant); a slightly stale snapshot is fine here
    try:
        json.dump({"state": STATE, "agent_cfg": AGENT_CFG, "project": SETTINGS["project"],
                   "shared": SHARED, "shared_seen": SHARED_SEEN, "seq": _SEQ[0], "names": NAMES},
                  open(PERSIST_PATH, "w"), ensure_ascii=False, indent=0)
    except Exception:
        pass


def _pname(p):
    return NAMES.get(p) or p


def read_ssh_hosts():
    """parse ~/.ssh/config and return list of Host names (skip wildcard *)"""
    cfg_path = os.path.join(HOME, ".ssh", "config")
    hosts = []
    try:
        for line in open(cfg_path):
            line = line.strip()
            if line.lower().startswith("host "):
                for h in line[5:].split():
                    if h and "*" not in h and "?" not in h and h not in hosts:
                        hosts.append(h)
    except Exception:
        pass
    return hosts


# ---- memory.md: the shared pool, mirrored to a plain markdown file the four windows read ----
# text only, so one file stays small for a long time. when it does fill up we roll over to
# memory-2.md, memory-3.md ... and every window is told about ALL of them, not just the newest.
MEM_MAX = 1_000_000        # bytes; roll to the next file past this


def _mem_dir():
    return SETTINGS.get("project") or HERE


def _mem_files():
    """every memory file that exists, oldest first."""
    d = _mem_dir()
    out, i = [], 2
    first = os.path.join(d, "memory.md")
    if os.path.exists(first):
        out.append(first)
    while True:
        p = os.path.join(d, "memory-%d.md" % i)
        if not os.path.exists(p):
            break
        out.append(p); i += 1
    return out


def _mem_target():
    """the file to append to right now, rolling over when the current one is full."""
    d = _mem_dir()
    files = _mem_files()
    if not files:
        return os.path.join(d, "memory.md")
    last = files[-1]
    try:
        if os.path.getsize(last) >= MEM_MAX:
            return os.path.join(d, "memory-%d.md" % (len(files) + 1))
    except OSError:
        pass
    return last


def _mem_append(e):
    path = _mem_target()
    try:
        fresh = not os.path.exists(path)
        with open(path, "a", encoding="utf-8") as f:
            if fresh:
                f.write("# Code-Duo 共享記憶\n\n"
                        "四個視窗共用這一份。每一輪的指令與產出都自動寫進來,原文照錄,不摘要、不截斷。\n"
                        "檔案寫滿會自動接到 memory-2.md、memory-3.md;四個視窗都會被告知全部檔案。\n\n")
            f.write("## [%d] %s · %s · %s\n\n%s\n\n" % (
                e["seq"], _pname(e["pane"]),
                "指令" if e["role"] == "user" else "產出",
                time.strftime("%Y-%m-%d %H:%M:%S"), e["text"]))
    except Exception:
        pass


def _shared_add(pane, role, text):
    """record one exchange into the common pool every window reads."""
    text = (text or "").strip()
    if not text:
        return
    with LOCK:
        _SEQ[0] += 1
        e = {"seq": _SEQ[0], "pane": pane, "role": role, "text": text}
        SHARED.append(e)
    _mem_append(e)
    _save_state()


def _shared_preamble(pane):
    """the OTHER windows' PRODUCED OUTPUTS this window has not been shown yet.

    We carry forward only what other windows *produced* (their 產出), never the raw
    上游指令 / 跟人對話的逐字 (their "user" turns). Handing a downstream window the other
    window's raw chat is exactly the "把整段對話原文倒進去" problem — a hand-off should be a
    clean task built from results, not a transcript. Instructions still get recorded into the
    shared pool / memory.md; they are just not injected into another window's prompt."""
    with LOCK:
        seen = SHARED_SEEN.get(pane, 0)
        new = [e for e in SHARED if e["seq"] > seen and e["pane"] != pane]
        SHARED_SEEN[pane] = SHARED[-1]["seq"] if SHARED else seen
    # only other windows' OUTPUTS travel between windows, not their raw instructions/chat
    new = [e for e in new if e.get("role") == "bot"]
    if not new:
        return "", 0, []
    files = _mem_files()
    hint = ""
    if files:
        hint = ("完整的共享記憶存在這些檔案,需要更早的內容就自己讀它們(全部都要讀,不是只讀第一個):\n"
                + "\n".join("  " + f for f in files) + "\n\n")
    blocks = []
    for e in new:
        blocks.append("[%s · 產出]\n%s" % (_pname(e["pane"]), e["text"]))
    body = ("=== 共享內容 ===\n"
            "以下是其他視窗到目前為止『產出的結果』(不是它們跟人對話的逐字)。四個視窗讀的是同一份共享內容,"
            "這段是自動帶入的,不是使用者手打的。你可以直接引用它,不需要重複別人已經做完的事。\n\n"
            + hint
            + "以下是你還沒看過的部分:\n\n"
            + "\n\n".join(blocks)
            + "\n\n=== 共享內容結束,以下才是這次要給你的指令 ===\n\n")
    return body, len(new), sorted({_pname(e["pane"]) for e in new})


def _load_state():
    try:
        d = json.load(open(PERSIST_PATH))
    except Exception:
        return
    for p, v in (d.get("state") or {}).items():
        if p in STATE and isinstance(v, dict):
            for k in ("engine", "id", "cwd", "remote"):
                if v.get(k) is not None:
                    STATE[p][k] = v[k]
            if STATE[p]["engine"] not in ("claude", "codex"):
                STATE[p]["engine"] = "claude"
            if not (STATE[p]["cwd"] and os.path.isdir(STATE[p]["cwd"])):
                STATE[p]["cwd"] = HERE
    for p, v in (d.get("agent_cfg") or {}).items():
        if p in AGENT_CFG and isinstance(v, dict):
            AGENT_CFG[p] = {**_default_cfg(STATE[p]["engine"]), **v}
    proj = d.get("project")
    if proj and os.path.isdir(proj):
        SETTINGS["project"] = proj
    # shared pool survives restarts, otherwise the windows would silently lose their common view
    sh = d.get("shared")
    if isinstance(sh, list):
        SHARED.extend([e for e in sh if isinstance(e, dict) and e.get("text")])
    ss = d.get("shared_seen")
    if isinstance(ss, dict):
        for p, v in ss.items():
            if p in SHARED_SEEN:
                try:
                    SHARED_SEEN[p] = int(v or 0)
                except Exception:
                    pass
    nm = d.get("names")
    if isinstance(nm, dict):
        NAMES.update({k: v for k, v in nm.items() if k in STATE and isinstance(v, str)})
    try:
        _SEQ[0] = int(d.get("seq") or 0) or (SHARED[-1]["seq"] if SHARED else 0)
    except Exception:
        _SEQ[0] = SHARED[-1]["seq"] if SHARED else 0


# --- child-process tracking: so a server restart doesn't orphan the claude/codex CLI children it spawned ---
# (each restart used to leave the in-flight `claude -p` running detached; two of them resuming the same
#  session id would then collide and hang. we record spawned PIDs and reap leftovers on the next startup.)
_CHILDREN_PATH = os.path.join(HERE, "duo_children.json")
_CHILD_LOCK = threading.Lock()


def _child_pids():
    try:
        return set(json.load(open(_CHILDREN_PATH)))
    except Exception:
        return set()


def _reg_child(pid):
    with _CHILD_LOCK:
        pids = _child_pids(); pids.add(pid)
        try:
            json.dump(list(pids), open(_CHILDREN_PATH, "w"))
        except Exception:
            pass


def _unreg_child(pid):
    with _CHILD_LOCK:
        pids = _child_pids(); pids.discard(pid)
        try:
            json.dump(list(pids), open(_CHILDREN_PATH, "w"))
        except Exception:
            pass


def _reap_orphans():
    killed = []
    for pid in _child_pids():
        try:
            out = subprocess.run(["ps", "-o", "command=", "-p", str(pid)],
                                 capture_output=True, text=True).stdout
            # only kill if it still looks like our CLI child (guard against PID reuse)
            if out and ("claude" in out or "codex" in out) and ("-p " in out or "exec" in out):
                os.kill(pid, 9); killed.append(pid)
        except Exception:
            pass
    with _CHILD_LOCK:
        try:
            json.dump([], open(_CHILDREN_PATH, "w"))
        except Exception:
            pass
    if killed:
        print("  reaped orphaned CLI children from a previous run:", killed)


_load_state()
_reap_orphans()

# USD price per million tokens (from mercury-cache-panel)
PRICING = {
    "claude": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75},
    "codex":  {"input": 2.50, "output": 10.00, "cache_read": 0.25, "cache_write": 0.0},
}
# watchdog: recent claim-vs-evidence checks (newest first)
BEHAVIOR = []
# loop detection: per-agent count of consecutive 'claimed actions but 0 disk change' turns
STREAK = {"claude": 0, "codex": 0}
RUNNING = {}  # pane -> live subprocess.Popen, so a pane's run can be interrupted (Stop button / ESC)
_TOK_CACHE = {"ts": 0, "data": None, "computing": False}
_TOK_LOCK = threading.Lock()
_SESS_CACHE = {}       # (engine, hidden) -> (ts, rows)
_SESS_COMPUTING = set()  # keys currently being recomputed, so overlapping polls don't pile up


def _zero_tokens():
    return {v: {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0,
                "cost": 0.0, "sessions": 0, "cache_pct": 0.0, "total_tokens": 0}
            for v in ("claude", "codex")}


def _maybe_refresh_tokens():
    # token_stats reads the whole (huge) session history and can take ~60s; never do it
    # on the request thread. Kick a background refresh if stale; callers return the last value.
    now = time.time()
    with _TOK_LOCK:
        if _TOK_CACHE["computing"]:
            return
        if _TOK_CACHE["data"] is not None and now - _TOK_CACHE["ts"] < 300:
            return
        _TOK_CACHE["computing"] = True

    def work():
        try:
            d = token_stats()
        except Exception:
            d = _TOK_CACHE["data"]
        _TOK_CACHE.update(ts=time.time(), data=d, computing=False)
    threading.Thread(target=work, daemon=True).start()


def _sessions_cached(engine, hidden):
    # Never block the request thread: hand back the last known list, refresh in the background.
    # The cache holds RAW rows; renames/pins/archives are applied on the way out, so editing a
    # session title shows up on the very next poll instead of waiting for a rescan.
    key = engine
    now = time.time()
    hit = _SESS_CACHE.get(key)
    fresh = hit and now - hit[0] < 20
    if not fresh and key not in _SESS_COMPUTING:
        _SESS_COMPUTING.add(key)

        def work():
            try:
                _SESS_CACHE[key] = (time.time(), list_sessions(engine))
                _meta_save()      # persist whatever new files we had to parse this round
            except Exception:
                pass
            finally:
                _SESS_COMPUTING.discard(key)
        threading.Thread(target=work, daemon=True).start()
    return _apply_overrides(engine, hit[1], hidden) if hit else []

# Code Duo's own overrides (rename/pin/archive/delete); never touches the official apps' data
OV_PATH = os.path.join(HERE, "duo_overrides.json")


def _load_overrides():
    try:
        return json.load(open(OV_PATH))
    except Exception:
        return {}


def _save_overrides(d):
    json.dump(d, open(OV_PATH, "w"), ensure_ascii=False, indent=0)


def _apply_overrides(engine, rows, include_hidden=False):
    # applied fresh on every request against the CACHED raw rows, so a rename shows up on the next
    # poll instead of waiting for a rescan. never mutates the cached rows: each one is copied first.
    ov = _load_overrides().get(engine, {})
    out = []
    for src in rows:
        o = ov.get(src["id"], {})
        if (o.get("deleted") or o.get("archived")) and not include_hidden:
            continue
        r = dict(src)
        if o.get("title"):
            r["title"] = o["title"]
        r["pinned"] = bool(o.get("pinned"))
        r["archived"] = bool(o.get("archived"))
        r["deleted"] = bool(o.get("deleted"))
        out.append(r)
    out.sort(key=lambda r: (not r["pinned"], -r["ts"]))
    return out
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def run(cmd, cwd, timeout=600):
    p = subprocess.run(cmd, cwd=cwd or HERE, stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


# ---------- drive the two engines ----------
def ask_claude(text):
    t0 = time.time()
    if not CLAUDE_BIN:
        return {"ok": False, "text": "[claude CLI not found] Install Claude Code, or set DUO_CLAUDE_BIN to its path",
                "ms": 0, "meta": {}}
    with LOCK:
        sid, cwd = STATE["claude"]["id"], STATE["claude"]["cwd"]
        cfg = dict(AGENT_CFG["claude"])
    cmd = [CLAUDE_BIN, "-p", text, "--output-format", "json"]
    if sid:
        cmd += ["--resume", sid]
    cmd += ["--permission-mode", cfg["mode"] or "default"]
    if cfg["model"]:
        cmd += ["--model", cfg["model"]]
    if cfg["effort"]:
        cmd += ["--effort", cfg["effort"]]
    cmd += ["--settings", json.dumps({"fastMode": bool(cfg.get("fast"))})]
    rc, out, err = run(cmd, cwd)
    try:
        d = json.loads(out)
        new_sid = d.get("session_id")
        if new_sid:
            with LOCK:
                STATE["claude"]["id"] = new_sid
        return {"ok": not d.get("is_error"), "text": d.get("result", ""),
                "ms": int((time.time()-t0)*1000), "meta": {"session": new_sid}}
    except Exception as e:
        return {"ok": False, "text": f"[claude parse failed] {e}\n{err or out[:400]}",
                "ms": int((time.time()-t0)*1000), "meta": {}}


def ask_codex(text):
    t0 = time.time()
    if not CODEX_BIN:
        return {"ok": False, "text": "[codex CLI not found] Install Codex, or set DUO_CODEX_BIN to its path",
                "ms": 0, "meta": {}}
    with LOCK:
        tid, cwd = STATE["codex"]["id"], STATE["codex"]["cwd"]
        cfg = dict(AGENT_CFG["codex"])
    mode = cfg["mode"] or "read-only"
    flags = ["--json", "--skip-git-repo-check", "-c", f"sandbox_mode={mode}"]
    if mode in _WRITABLE:
        flags += ["-c", "approval_policy=never"]
    if cfg["model"]:
        flags += ["-m", cfg["model"]]
    if cfg["effort"]:
        flags += ["-c", f"model_reasoning_effort={cfg['effort']}"]
    if tid:
        cmd = [CODEX_BIN, "exec", "resume", tid] + flags + [text]
    else:
        cmd = [CODEX_BIN, "exec"] + flags + [text]
    rc, out, err = run(cmd, cwd)
    msg, new_tid = "", None
    for ln in out.splitlines():
        try:
            d = json.loads(ln.strip())
        except Exception:
            continue
        if d.get("type") == "thread.started":
            new_tid = d.get("thread_id")
        it = d.get("item", {})
        if isinstance(it, dict) and it.get("type") == "agent_message":
            msg = it.get("text", msg)
    if new_tid:
        with LOCK:
            STATE["codex"]["id"] = new_tid
    return {"ok": bool(msg), "text": msg or f"[codex no response]\n{err[:400]}",
            "ms": int((time.time()-t0)*1000), "meta": {"thread": new_tid or tid}}


def _fmt_tool(name, inp):
    # Claude Code terminal style: ToolName(key arg). NOTHING here is truncated:
    # the UI must be a byte-faithful view of what the CLI reported, so it can be
    # diffed against the CLI's own session jsonl without discrepancies.
    inp = inp or {}
    if name == "Bash":
        return "Bash(" + str(inp.get("command", "")) + ")"
    if name in ("Edit", "Write", "NotebookEdit", "Read"):
        fp = str(inp.get("file_path", ""))
        base = os.path.basename(fp) or fp
        if name == "Edit":
            old = str(inp.get("old_string", "")).splitlines()
            new = str(inp.get("new_string", "")).splitlines()
            add = sum(1 for l in difflib.ndiff(old, new) if l[:2] == "+ ")
            rem = sum(1 for l in difflib.ndiff(old, new) if l[:2] == "- ")
            return "Edit(%s) +%d -%d" % (base, add, rem)
        if name == "Write":
            n = len(str(inp.get("content", "")).splitlines())
            return "Write(%s) +%d" % (base, n)
        return name + "(" + base + ")"
    if name in ("Grep", "Glob"):
        return name + "(" + str(inp.get("pattern", "")) + ")"
    if name in ("WebFetch", "WebSearch"):
        return name + "(" + str(inp.get("url") or inp.get("query", "")) + ")"
    if name == "TodoWrite":
        return "TodoWrite"
    if name == "Workflow":
        return "Workflow(" + str(inp.get("name") or inp.get("description", "")) + ")"
    return name + "(" + json.dumps(inp, ensure_ascii=False) + ")"


def _session_name(text, pane=None):
    """從 prompt 提取有意義的 session 標題，格式：任務前30字 [pane名]。"""
    marker = "=== 共享內容結束,以下才是這次要給你的指令 ===\n\n"
    if marker in text:
        text = text.split(marker, 1)[-1]
    base = text.strip().replace("\n", " ")[:35] or "session"
    label = NAMES.get(pane) or pane or ""
    return f"{base} [{label}]" if label else base


def run_stream_claude(pane, text, emit):
    with LOCK:
        sid, cwd, remote = STATE[pane]["id"], STATE[pane]["cwd"], STATE[pane].get("remote")
        cfg = dict(AGENT_CFG[pane])
    sname = _session_name(text, pane)
    if remote:
        # run claude on the remote machine via SSH; BatchMode=yes so it fails fast if auth is broken
        claude_args = ["claude", "-p", text, "--output-format", "stream-json", "--verbose",
                       "--include-partial-messages"]
        if sid:
            claude_args += ["--resume", sid]
        else:
            claude_args += ["--name", sname]
        claude_args += ["--permission-mode", cfg["mode"] or "default"]
        if cfg["model"]:
            claude_args += ["--model", cfg["model"]]
        if cfg["effort"]:
            claude_args += ["--effort", cfg["effort"]]
        claude_args += ["--settings", json.dumps({"fastMode": bool(cfg.get("fast"))})]
        cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
               "-o", "StrictHostKeyChecking=accept-new", remote,
               " ".join(shlex.quote(a) for a in claude_args)]
        popen_cwd = None
    else:
        if not CLAUDE_BIN:
            emit({"engine": pane, "k": "text", "t": "[claude CLI not found]"}); return ""
        # --include-partial-messages: gives us content_block_delta events, so the answer types out live
        # instead of landing in one lump, and thinking_delta carries a live token estimate while the
        # model is still thinking (its `thinking` text is always redacted to "" in headless, so there is
        # no reasoning text to show, only the running count).
        cmd = [CLAUDE_BIN, "-p", text, "--output-format", "stream-json", "--verbose",
               "--include-partial-messages"]
        if sid:
            cmd += ["--resume", sid]
        else:
            cmd += ["--name", sname]
        cmd += ["--permission-mode", cfg["mode"] or "default"]
        if cfg["model"]:
            cmd += ["--model", cfg["model"]]
        if cfg["effort"]:
            cmd += ["--effort", cfg["effort"]]
        cmd += ["--settings", json.dumps({"fastMode": bool(cfg.get("fast"))})]
        popen_cwd = cwd or HERE
    final, newsid = "", None
    run_out = 0           # cumulative output tokens streamed so far (for the live "· N tokens" line)
    streamed = False      # did this message's text arrive as deltas? if not, fall back to the block
    agent_tuids = set()   # tool_use ids of dispatched sub-agents, so their raw results aren't double-shown
    try:
        p = subprocess.Popen(cmd, cwd=popen_cwd, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        with LOCK:
            RUNNING[pane] = p
        _reg_child(p.pid)
        for line in p.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = d.get("type")
            if t == "stream_event":
                # live deltas: text types out as it is produced; thinking reports a running estimate
                e = d.get("event") or {}
                et = e.get("type")
                if et == "message_start":
                    streamed = False          # per message: did we get text via deltas?
                elif et == "content_block_start" and (e.get("content_block") or {}).get("type") == "text":
                    emit({"engine": pane, "k": "textstart"})
                elif et == "content_block_delta":
                    dl = e.get("delta") or {}
                    dt = dl.get("type")
                    if dt == "text_delta" and dl.get("text"):
                        streamed = True
                        emit({"engine": pane, "k": "textdelta", "t": dl["text"]})
                    elif dt == "thinking_delta":
                        # `thinking` is always redacted to "" here; the token estimate is the signal
                        emit({"engine": pane, "k": "think", "est": dl.get("estimated_tokens") or 0})
                elif et == "message_delta":
                    ot = ((e.get("usage") or {}).get("output_tokens")) or 0
                    if ot:
                        run_out += ot
                        emit({"engine": pane, "k": "usage", "tot": run_out})
            elif t == "assistant":
                for b in d.get("message", {}).get("content", []):
                    bt = b.get("type")
                    if bt == "text" and b.get("text"):
                        if not streamed:      # fallback: no deltas arrived, so show the whole block
                            emit({"engine": pane, "k": "text", "t": b["text"]})
                    elif bt == "tool_use":
                        nm = b.get("name", "")
                        if nm in ("Task", "Agent"):
                            agent_tuids.add(b.get("id"))   # rendered live via system/task_* events
                        else:
                            emit({"engine": pane, "k": "tool", "t": _fmt_tool(nm, b.get("input"))})
            elif t == "user":
                for b in (d.get("message", {}).get("content") or []):
                    if not isinstance(b, dict) or b.get("type") != "tool_result":
                        continue
                    if b.get("tool_use_id") in agent_tuids:
                        continue   # subagent result — the agent panel already shows its summary
                    con = b.get("content", "")
                    if isinstance(con, list):
                        con = " ".join(x.get("text", "") for x in con if isinstance(x, dict))
                    con = str(con).strip()
                    if con:
                        emit({"engine": pane, "k": "toolout", "t": con})   # full tool output, never truncated
            elif t == "system":
                st = d.get("subtype", "")
                if st in ("task_started", "task_progress", "task_updated", "task_notification"):
                    emit({"engine": pane, "k": "agent", "id": d.get("task_id", ""), "st": st,
                          "name": d.get("subagent_type", ""), "desc": d.get("description", ""),
                          "status": d.get("status") or (d.get("patch") or {}).get("status", ""),
                          "sum": str(d.get("summary", "")), "usage": d.get("usage", {})})
                elif st == "compact_boundary":
                    meta = d.get("compactMetadata") or {}
                    emit({"engine": pane, "k": "compact",
                          "pre": meta.get("preTokens", 0),
                          "trigger": meta.get("trigger", "auto")})
                elif d.get("content") and st not in ("task_started", "task_progress", "task_updated", "task_notification"):
                    emit({"engine": pane, "k": "sysnote", "t": str(d["content"])})
            elif t == "result":
                final = d.get("result", "") or final
                newsid = d.get("session_id")
                rot = (d.get("usage") or {}).get("output_tokens") or 0
                if rot:                       # authoritative final total (claude -p only gives the real count here)
                    emit({"engine": pane, "k": "usage", "tot": rot})
        p.wait()
        # detect "not logged in" on remote: no valid JSON result and process failed
        if remote and not newsid and not final and p.returncode != 0:
            emit({"engine": pane, "k": "need_login", "remote": remote})
    except Exception as e:
        emit({"engine": pane, "k": "text", "t": f"[error] {e}"})
    finally:
        with LOCK:
            RUNNING.pop(pane, None)
        try:
            _unreg_child(p.pid)
        except Exception:
            pass
    if newsid:
        with LOCK:
            STATE[pane]["id"] = newsid
        _save_state()
    return final


def run_stream_codex(pane, text, emit):
    if not CODEX_BIN:
        emit({"engine": pane, "k": "text", "t": "[codex CLI not found]"}); return ""
    with LOCK:
        tid, cwd = STATE[pane]["id"], STATE[pane]["cwd"]
        cfg = dict(AGENT_CFG[pane])
    mode = cfg["mode"] or "read-only"
    flags = ["--json", "--skip-git-repo-check", "-c", f"sandbox_mode={mode}"]
    if mode in _WRITABLE:
        flags += ["-c", "approval_policy=never"]
    if cfg["model"]:
        flags += ["-m", cfg["model"]]
    if cfg["effort"]:
        flags += ["-c", f"model_reasoning_effort={cfg['effort']}"]
    cmd = ([CODEX_BIN, "exec", "resume", tid] + flags + [text]) if tid else ([CODEX_BIN, "exec"] + flags + [text])
    final, newtid = "", None
    run_out = 0           # cumulative output+reasoning tokens (codex reports usage in turn.completed)
    try:
        p = subprocess.Popen(cmd, cwd=cwd or HERE, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        with LOCK:
            RUNNING[pane] = p
        _reg_child(p.pid)
        for line in p.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("type") == "thread.started":
                newtid = d.get("thread_id")
            if d.get("type") == "turn.completed":
                u = d.get("usage") or {}
                run_out += (u.get("output_tokens") or 0) + (u.get("reasoning_output_tokens") or 0)
                emit({"engine": pane, "k": "usage", "tot": run_out})
            if d.get("type") == "item.completed":
                it = d.get("item", {}) if isinstance(d.get("item"), dict) else {}
                ty = it.get("type")
                if ty == "agent_message":
                    final = it.get("text", "") or final
                    emit({"engine": pane, "k": "text", "t": it.get("text", "")})
                elif ty == "command_execution":
                    emit({"engine": pane, "k": "tool", "t": "⌘ " + str(it.get("command", ""))[:120]})
                elif ty == "file_change":
                    emit({"engine": pane, "k": "tool", "t": "✎ " + str(it.get("path") or it.get("changes") or "")[:120]})
        p.wait()
    except Exception as e:
        emit({"engine": pane, "k": "text", "t": f"[error] {e}"})
    finally:
        with LOCK:
            RUNNING.pop(pane, None)
        try:
            _unreg_child(p.pid)
        except Exception:
            pass
    if newtid:
        with LOCK:
            STATE[pane]["id"] = newtid
        _save_state()
    return final


def handle_stream(target, text, emit):
    with LOCK:
        proj = SETTINGS["project"]
        writable = {p: (AGENT_CFG[p]["mode"] in _WRITABLE) for p in STATE}
    before = _snapshot(proj) if proj else {}
    if target in STATE:
        panes = [target]
    else:  # "all" / "both" / anything else -> every window
        panes = list(STATE)
    results = {}

    def work(pane):
        t0 = time.time()
        eng = STATE[pane]["engine"]
        fn = run_stream_claude if eng == "claude" else run_stream_codex
        # shared content: feed this window whatever the other windows have done since it last ran
        pre, n, froms = _shared_preamble(pane)
        if n:
            emit({"engine": pane, "k": "shared", "n": n, "from": froms})
        final = fn(pane, (pre + text) if pre else text, emit)
        results[pane] = {"text": final, "ms": int((time.time() - t0) * 1000)}
        # this window's own exchange now joins the pool the others read
        _shared_add(pane, "user", text)
        _shared_add(pane, "bot", final)
        with LOCK:
            cur_sid = STATE[pane].get("id")
        emit({"engine": pane, "k": "done", "ms": results[pane]["ms"], "sid": cur_sid})

    threads = [threading.Thread(target=work, args=(p,)) for p in panes]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    changed = _diff(before, _snapshot(proj)) if proj else []
    for pane in panes:
        if results.get(pane, {}).get("text"):
            record_behavior(pane, results[pane]["text"], proj, changed, writable.get(pane, False))


def handle_send(target, text):
    out, threads = {}, []
    with LOCK:
        proj = SETTINGS["project"]
        writable = {e: (AGENT_CFG[e]["mode"] in _WRITABLE) for e in AGENT_CFG}
    before = _snapshot(proj) if proj else {}
    jobs = [j for j in (("claude", ask_claude), ("codex", ask_codex))
            if target in (j[0], "both")]
    for name, fn in jobs:
        def work(n=name, f=fn):
            out[n] = f(text)
        th = threading.Thread(target=work); th.start(); threads.append(th)
    for th in threads:
        th.join()
    changed = _diff(before, _snapshot(proj)) if proj else []
    for name, res in out.items():
        if res and res.get("ok"):
            record_behavior(name, res.get("text", ""), proj, changed, writable.get(name, False))
    return out


# ---------- list / read past sessions ----------
# ---- session metadata scanning ----
# A session file can be enormous (measured: one codex session is 1.9 GB; ~/.codex/sessions is 5.9 GB
# across 226 files). The sidebar only needs cwd / first message / title, and those live in the HEAD of
# the file. So: never read past _SCAN_HEAD bytes, and cache what we parsed on DISK keyed by
# (mtime, size) so a server restart does not re-scan anything that has not changed.
_SCAN_HEAD = 262144           # bytes of each session file we are ever willing to read
_META_PATH = os.path.join(HERE, "duo_meta_cache.json")
_META = {}                    # path -> {"mt":float, "sz":int, ...parsed fields}
_META_LOCK = threading.Lock()
_META_DIRTY = [False]


def _meta_load():
    try:
        d = json.load(open(_META_PATH))
        if isinstance(d, dict):
            _META.update(d)
    except Exception:
        pass


def _meta_save():
    if not _META_DIRTY[0]:
        return
    with _META_LOCK:
        _META_DIRTY[0] = False
        try:
            json.dump(_META, open(_META_PATH, "w"), ensure_ascii=False)
        except Exception:
            pass


def _meta_cached(path, parse):
    """parse(path) -> dict, but only when the file is new or actually changed since last time."""
    try:
        st = os.stat(path)
    except OSError:
        return {}
    hit = _META.get(path)
    if hit and hit.get("mt") == st.st_mtime and hit.get("sz") == st.st_size:
        return hit
    res = dict(parse(path) or {})
    res["mt"], res["sz"] = st.st_mtime, st.st_size
    with _META_LOCK:
        _META[path] = res
        _META_DIRTY[0] = True
    return res


def _head_lines(path):
    """the first _SCAN_HEAD bytes of a file, as whole lines. bounded: a 1.9 GB file costs 256 KB."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            data = f.read(_SCAN_HEAD)
    except Exception:
        return []
    lines = data.split("\n")
    if len(lines) > 1:
        lines = lines[:-1]        # the last one may be cut mid-line
    return lines


_meta_load()   # warm start: everything parsed in previous runs is still valid unless the file changed


def _first_user_and_cwd_claude(path):
    cwd, first, title = None, "", ""
    try:
        for ln in _head_lines(path):
            if not ln.strip():
                continue
            d = json.loads(ln)
            cwd = cwd or d.get("cwd")
            if d.get("type") == "ai-title" and not title:
                title = d.get("aiTitle", "") or d.get("title", "") or ""
            if not first and d.get("type") == "user":
                c = d.get("message", {}).get("content")
                if isinstance(c, str):
                    first = c
                elif isinstance(c, list):
                    for b in c:
                        if b.get("type") == "text":
                            first = b.get("text", ""); break
            if cwd and first and title:
                break
    except Exception:
        pass
    return cwd, title.replace("\n", " "), first.replace("\n", " ")


def _first_user_and_cwd_codex(path):
    cwd, first = None, ""
    try:
        for ln in _head_lines(path):
            if not ln.strip():
                continue
            d = json.loads(ln)
            t = d.get("type")
            pl = d.get("payload", {}) if isinstance(d.get("payload"), dict) else {}
            if t == "session_meta":
                cwd = cwd or pl.get("cwd")
            if t == "event_msg" and pl.get("type") == "user_message" and not first:
                first = pl.get("message", "")
            if cwd and first:
                break
    except Exception:
        pass
    return cwd, first.replace("\n", " ")


def _codex_project_labels():
    # Codex 'cwd path -> project display name' map (matches the Codex app UI)
    p = CFG["codex_state"]
    try:
        d = json.load(open(p))
        return d.get("electron-workspace-root-labels", {}) or {}
    except Exception:
        return {}


def _proj_name(cwd, labels=None):
    if labels and cwd in labels:
        return labels[cwd]
    if cwd == HOME:
        return "ungrouped (home)"
    base = os.path.basename((cwd or "").rstrip("/"))
    return base or cwd or "(unknown)"


def _codex_meta_cached(path):
    m = _meta_cached(path, lambda p: dict(zip(("cwd", "first"), _first_user_and_cwd_codex(p))))
    return m.get("cwd"), m.get("first", "")


def _claude_meta_cached(path):
    m = _meta_cached(path, lambda p: dict(zip(("cwd", "title", "first"),
                                              _first_user_and_cwd_claude(p))))
    return m.get("cwd"), m.get("title", ""), m.get("first", "")


# ---- decode Chrome Local Storage leveldb (snappy + table format) to read Claude custom groups ----
import struct
_CG_CACHE = {"mtime": 0, "groups": {}, "assign": {}}
_CG_PERSIST = os.path.join(HERE, "duo_claude_groups.json")


def _uvarint(b, p):
    r = s = 0
    while True:
        c = b[p]; p += 1
        r |= (c & 0x7f) << s
        if not (c & 0x80):
            return r, p
        s += 7


def _snappy(data):
    p, ln, s = 0, 0, 0
    while True:
        c = data[p]; p += 1; ln |= (c & 0x7f) << s
        if not (c & 0x80):
            break
        s += 7
    out = bytearray()
    while p < len(data):
        tag = data[p]; p += 1; t = tag & 3
        if t == 0:
            v = tag >> 2
            if v < 60:
                l = v + 1
            else:
                nb = v - 59
                l = int.from_bytes(data[p:p + nb], "little") + 1; p += nb
            out += data[p:p + l]; p += l
        else:
            if t == 1:
                l = ((tag >> 2) & 7) + 4
                off = ((tag >> 5) << 8) | data[p]; p += 1
            elif t == 2:
                l = (tag >> 2) + 1
                off = int.from_bytes(data[p:p + 2], "little"); p += 2
            else:
                l = (tag >> 2) + 1
                off = int.from_bytes(data[p:p + 4], "little"); p += 4
            st = len(out) - off
            for i in range(l):
                out.append(out[st + i])
    return bytes(out)


def _ldb_blocks(b):
    blocks = []
    if len(b) < 48:
        return blocks
    foot = b[-48:]
    p = 0
    _o, p = _uvarint(foot, p); _s, p = _uvarint(foot, p)   # metaindex handle (unused)
    ioff, p = _uvarint(foot, p); isz, p = _uvarint(foot, p)  # index handle

    def rd(o, s):
        raw = b[o:o + s]
        return _snappy(raw) if b[o + s] == 1 else raw
    idx = rd(ioff, isz)
    num = struct.unpack("<I", idx[-4:])[0]
    end = len(idx) - 4 - num * 4
    p, prev = 0, b""
    while p < end:
        sh, p = _uvarint(idx, p); ns, p = _uvarint(idx, p); vl, p = _uvarint(idx, p)
        key = prev[:sh] + idx[p:p + ns]; p += ns
        val = idx[p:p + vl]; p += vl; prev = key
        o, q = _uvarint(val, 0); s, q = _uvarint(val, q)
        try:
            blocks.append(rd(o, s))
        except Exception:
            pass
    return blocks


def _scan_groups(text, groups, assign):
    for m in re.finditer(r'"id":"(cg-[a-f0-9-]+)","name":"([^"]{1,80})"', text):
        groups.setdefault(m.group(1), m.group(2))
    for m in re.finditer(r'"code:local_([a-f0-9-]+)":"(cg-[a-f0-9-]+)"', text):
        assign.setdefault(m.group(1), m.group(2))


def _claude_groups():
    ls = os.path.join(HOME, "Library", "Application Support", "Claude", "Local Storage", "leveldb")
    try:
        files = sorted(glob.glob(os.path.join(ls, "*")), key=os.path.getmtime, reverse=True)
    except Exception:
        files = []
    newest = os.path.getmtime(files[0]) if files else 0
    if _CG_CACHE["mtime"] == newest and _CG_CACHE["groups"]:
        return _CG_CACHE["groups"], _CG_CACHE["assign"]
    groups, assign = {}, {}
    for f in files:
        try:
            raw = open(f, "rb").read()
        except Exception:
            continue
        _scan_groups(raw.replace(b"\x00", b"").decode("latin-1", "ignore"), groups, assign)  # plaintext (.log)
        if f.endswith(".ldb"):
            try:
                for blk in _ldb_blocks(raw):  # decompress snappy blocks
                    _scan_groups(blk.replace(b"\x00", b"").decode("latin-1", "ignore"), groups, assign)
            except Exception:
                pass
    if groups:  # read ok -> persist, so we still have the last groups after leveldb compacts
        try:
            json.dump({"groups": groups, "assign": assign}, open(_CG_PERSIST, "w"))
        except Exception:
            pass
    else:  # can't read -> fall back to last good cache
        try:
            d = json.load(open(_CG_PERSIST))
            groups, assign = d.get("groups", {}), d.get("assign", {})
        except Exception:
            pass
    _CG_CACHE.update(mtime=newest, groups=groups, assign=assign)
    return groups, assign


def _codex_title_map():
    # Codex official title index: id -> thread_name (chronological; later wins, last-wins)
    m = {}
    p = CFG["codex_index"]
    try:
        for ln in open(p):
            d = json.loads(ln)
            i, nm = d.get("id"), d.get("thread_name")
            if i and nm:
                m[i] = nm
    except Exception:
        pass
    return m


def list_sessions(engine, limit=300, include_hidden=False):
    rows = []
    if engine == "claude":
        # merge two sources so Code-Duo's own CLI sessions also show up:
        # (1) Claude desktop app index (clean titles), (2) ~/.claude/projects jsonl (what Code-Duo creates)
        seen = set()
        if CLAUDE_SESS:
            groups, assign = _claude_groups()
            for f in glob.glob(os.path.join(CLAUDE_SESS, "**", "local_*.json"), recursive=True):
                try:
                    d = json.load(open(f))
                except Exception:
                    continue
                cid = d.get("cliSessionId")
                if not cid:
                    continue
                cwd = d.get("cwd") or d.get("originCwd") or HERE
                sid = (d.get("sessionId") or "").replace("local_", "")
                grp = groups.get(assign.get(sid))  # custom group name (if any)
                seen.add(cid)
                rows.append({"id": cid, "cwd": cwd, "project": grp or _proj_name(cwd),
                             "title": d.get("title", ""), "first": "",
                             "archived": bool(d.get("isArchived")),
                             "ts": int((d.get("lastActivityAt") or d.get("createdAt") or 0) / 1000)})
        # also include CLI sessions the desktop index lacks, but ONLY those under Code-Duo's own
        # working directories — otherwise the whole ~/.claude/projects history (claude-mem observer
        # sessions, other Claude Code sessions, etc.) floods the sidebar.
        duo_cwds = {STATE[p]["cwd"] for p in STATE}
        if SETTINGS.get("project"):
            duo_cwds.add(SETTINGS["project"])
        for cwd in duo_cwds:
            pdir = os.path.join(CLAUDE_PROJ, cwd.replace("/", "-"))  # Claude projects dir encoding
            for f in glob.glob(os.path.join(pdir, "*.jsonl")):
                sid = os.path.basename(f)[:-6]
                if sid in seen:
                    continue
                seen.add(sid)
                c2, title, first = _claude_meta_cached(f)
                rows.append({"id": sid, "cwd": c2 or cwd, "project": _proj_name(c2 or cwd),
                             "title": title, "first": first,
                             "ts": int(os.path.getmtime(f))})
        rows.sort(key=lambda r: r["ts"], reverse=True)
        return rows[:limit]           # RAW: overrides are applied per-request in _sessions_cached
    else:
        titles = _codex_title_map()
        labels = _codex_project_labels()
        files = []
        for dd in CODEX_DIRS:
            files += glob.glob(os.path.join(dd, "**", "*.jsonl"), recursive=True)
        files.sort(key=os.path.getmtime, reverse=True)
        for f in files[:limit]:
            cwd, first = _codex_meta_cached(f)
            cwd = cwd or HERE
            m = UUID_RE.search(os.path.basename(f))
            sid = m.group(0) if m else None
            if sid:
                rows.append({"id": sid, "cwd": cwd, "project": _proj_name(cwd, labels),
                             "title": titles.get(sid, ""), "first": first,
                             "ts": int(os.path.getmtime(f))})
    return rows                       # RAW: overrides are applied per-request in _sessions_cached


def _find_file(engine, sid):
    if engine == "claude":
        hits = glob.glob(os.path.join(CLAUDE_PROJ, "*", sid + ".jsonl"))
    else:
        hits = []
        for d in CODEX_DIRS:
            hits += glob.glob(os.path.join(d, "**", f"*{sid}*.jsonl"), recursive=True)
    return hits[0] if hits else None


def read_transcript(engine, sid):
    f = _find_file(engine, sid)
    if not f:
        return []
    msgs = []
    for ln in open(f):
        try:
            d = json.loads(ln)
        except Exception:
            continue
        if engine == "claude":
            t = d.get("type")
            if t in ("user", "assistant"):
                c = d.get("message", {}).get("content")
                txt = ""
                if isinstance(c, str):
                    txt = c
                elif isinstance(c, list):
                    txt = "".join(b.get("text", "") for b in c if b.get("type") == "text")
                if txt.strip():
                    msgs.append({"role": "user" if t == "user" else "bot", "text": txt})
        else:
            pl = d.get("payload", {}) if isinstance(d.get("payload"), dict) else {}
            if d.get("type") == "event_msg":
                if pl.get("type") == "user_message":
                    msgs.append({"role": "user", "text": pl.get("message", "")})
                elif pl.get("type") == "agent_message":
                    msgs.append({"role": "bot", "text": pl.get("message", "")})
    return msgs   # full transcript, never truncated: the window must match the CLI's jsonl exactly


# ---------- token usage panel (parse local jsonl, inspired by mercury-cache-panel) ----------
from datetime import datetime


def _iso_epoch(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def token_stats(window_sec=86400):
    cutoff = time.time() - window_sec
    out = {v: {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0,
               "cost": 0.0, "sessions": 0} for v in ("claude", "codex")}
    # Claude: sum each assistant message by its own timestamp (only within the window); input and cache_read are separate
    for f in glob.glob(os.path.join(CLAUDE_PROJ, "*", "*.jsonl")):
        try:
            if os.path.getmtime(f) < cutoff:
                continue
        except OSError:
            continue
        hit = False
        try:
            for ln in open(f):
                d = json.loads(ln)
                u = d.get("message", {}).get("usage")
                if not u:
                    continue
                ep = _iso_epoch(d.get("timestamp"))
                if ep is not None and ep < cutoff:
                    continue
                hit = True
                a = out["claude"]
                a["input"] += u.get("input_tokens", 0)
                a["output"] += u.get("output_tokens", 0)
                a["cache_read"] += u.get("cache_read_input_tokens", 0)
                a["cache_write"] += u.get("cache_creation_input_tokens", 0)
        except Exception:
            pass
        if hit:
            out["claude"]["sessions"] += 1
    # Codex: token_count is cumulative; window delta = last-in-window minus last-before-window
    for dd in CODEX_DIRS:
        for f in glob.glob(os.path.join(dd, "**", "*.jsonl"), recursive=True):
            try:
                if os.path.getmtime(f) < cutoff:
                    continue
            except OSError:
                continue
            base, latest = None, None
            try:
                for ln in open(f):
                    d = json.loads(ln)
                    pl = d.get("payload", {}) if isinstance(d.get("payload"), dict) else {}
                    if pl.get("type") != "token_count":
                        continue
                    tu = pl.get("info", {}).get("total_token_usage")
                    if not tu:
                        continue
                    ep = _iso_epoch(d.get("timestamp"))
                    if ep is not None and ep < cutoff:
                        base = tu
                    else:
                        latest = tu
            except Exception:
                pass
            if latest:
                b = base or {}
                a = out["codex"]
                a["input"] += max(latest.get("input_tokens", 0) - b.get("input_tokens", 0), 0)
                a["output"] += max(latest.get("output_tokens", 0) - b.get("output_tokens", 0), 0)
                a["cache_read"] += max(latest.get("cached_input_tokens", 0) - b.get("cached_input_tokens", 0), 0)
                a["sessions"] += 1
    for v in ("claude", "codex"):
        a = out[v]
        p = PRICING[v]
        # Claude: input excludes cache_read; Codex: input includes cache_read, subtract it
        billable_in = a["input"] - a["cache_read"] if v == "codex" else a["input"]
        billable_in = max(billable_in, 0)
        a["cost"] = round(billable_in / 1e6 * p["input"] + a["output"] / 1e6 * p["output"]
                          + a["cache_read"] / 1e6 * p["cache_read"]
                          + a["cache_write"] / 1e6 * p["cache_write"], 2)
        denom = billable_in + a["cache_read"] + a["cache_write"]
        a["cache_pct"] = round(100 * a["cache_read"] / denom, 1) if denom else 0.0
        a["total_tokens"] = billable_in + a["output"] + a["cache_read"] + a["cache_write"]
    return out


# ---------- watchdog: did the AI actually change the disk, or just talk? ----------
_BACKTICK = re.compile(r"`([^`\n]{1,120}?)`")
_EXT = re.compile(r"\.[A-Za-z0-9]{1,8}$")
# claim verbs ('I did X') in English + Chinese
_CLAIM = re.compile(
    r"(建立|新增|建好|寫入|寫好|修改|改好|更新|刪除|刪掉|執行|跑了|跑完|測試過|部署|安裝|"
    r"已完成|完成了|做好了|搞定|加上了|加好|實作|implemented|created|added|wrote|updated|"
    r"modified|deleted|ran\b|executed|tested|deployed|installed|fixed|done\b|finished|set up)",
    re.I)
_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".next",
              "dist", "build", ".cache", "target"}


def _snapshot(cwd):
    snap = {}
    if not cwd or not os.path.isdir(cwd):
        return snap
    n = 0
    for root, dirs, files in os.walk(cwd):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS and not d.startswith(".")]
        for f in files:
            p = os.path.join(root, f)
            try:
                snap[p] = (os.path.getmtime(p), os.path.getsize(p))
            except OSError:
                pass
            n += 1
            if n > 30000:
                return snap
    return snap


def _diff(before, after):
    return [p for p, v in after.items() if before.get(p) != v]  # created or modified


def check_honesty(engine, text, cwd, changed, write):
    text = text or ""
    actions = len(_CLAIM.findall(text))
    changed = changed or []
    changed_names = set()
    for p in changed:
        changed_names.add(os.path.basename(p))
        try:
            changed_names.add(os.path.relpath(p, cwd))
        except Exception:
            pass
    claims, seen = [], set()
    for tok in _BACKTICK.findall(text):
        tok = tok.strip()
        if not tok or " " in tok or tok in seen:
            continue
        if not (_EXT.search(tok) or "/" in tok):
            continue
        seen.add(tok)
        p = tok if os.path.isabs(tok) else os.path.join(cwd or HERE, tok)
        st = "missing"
        try:
            if os.path.isfile(p):
                sz = os.path.getsize(p)
                age = time.time() - os.path.getmtime(p)
                if sz == 0:
                    st = "empty"
                elif tok in changed_names or os.path.basename(tok) in changed_names or age < 300:
                    st = "verified"   # actually changed this turn
                else:
                    st = "exists"     # exists but not touched this turn (just mentioned)
        except Exception:
            pass
        claims.append({"path": tok, "status": st})
        if len(claims) >= 12:
            break
    bad = [c for c in claims if c["status"] in ("missing", "empty")]
    verified = [c for c in claims if c["status"] == "verified"]
    # the core call-out: in a writable mode, many claimed actions but 0 disk change and no verified file = busywork
    bluff = write and actions >= 2 and not changed and not verified
    if bad:
        verdict, reason = "warn", "claimed files have no evidence (missing/empty)"
    elif bluff:
        verdict, reason = "warn", f"{actions} actions claimed, 0 files changed on disk (looks like busywork)"
    elif actions or claims or changed:
        verdict, reason = "ok", f"{len(changed)} files changed · {len(verified)} claims verified"
    else:
        verdict, reason = "none", ""
    return {"ts": int(time.time()), "engine": engine, "claims": claims,
            "actions": actions, "changed": len(changed),
            "bad": len(bad), "verdict": verdict, "reason": reason}


def record_behavior(engine, text, cwd, changed, write):
    rec = check_honesty(engine, text, cwd, changed, write)
    # looping: accumulate consecutive 'claimed actions but 0 change'; reset on real change or a no-claim turn
    if write:
        if rec["actions"] >= 1 and rec["changed"] == 0:
            STREAK[engine] = STREAK.get(engine, 0) + 1
        else:
            STREAK[engine] = 0
    rec["streak"] = STREAK.get(engine, 0)
    rec["circling"] = rec["streak"] >= 3
    if rec["circling"]:
        rec["verdict"] = "warn"
        rec["reason"] = f"{rec['streak']} turns in a row claiming progress with 0 disk changes (looping)"
    if rec["verdict"] == "none":
        return
    with LOCK:
        BEHAVIOR.insert(0, rec)
        del BEHAVIOR[30:]


# ---------- HTTP ----------
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
        elif u.path == "/logo.svg":
            try:
                with open(os.path.join(HERE, "logo.svg"), "rb") as f:
                    self._send(200, f.read(), "image/svg+xml")
            except Exception:
                self._send(404, "no logo", "text/plain")
        elif u.path == "/api/sessions":
            eng = q.get("engine", ["claude"])[0]
            hidden = q.get("hidden", ["0"])[0] == "1"
            self._send(200, json.dumps(_sessions_cached(eng, hidden)))
        elif u.path == "/api/transcript":
            eng = q.get("engine", ["claude"])[0]
            sid = q.get("id", [""])[0]
            self._send(200, json.dumps(read_transcript(eng, sid)))
        elif u.path == "/api/state":
            # include whether each pane's CLI process is live, so the UI can tell "alive" from "dead"
            with LOCK:
                out = {p: dict(STATE[p], running=(p in RUNNING and RUNNING[p].poll() is None)) for p in STATE}
            self._send(200, json.dumps(out))
        elif u.path == "/api/project":
            self._send(200, json.dumps({"project": SETTINGS["project"]}))
        elif u.path == "/api/agent-config":
            self._send(200, json.dumps(AGENT_CFG))
        elif u.path == "/api/ssh-hosts":
            self._send(200, json.dumps({"hosts": read_ssh_hosts()}))
        elif u.path == "/api/remote-login":
            # SSE: SSH into remote and run `claude login`, stream stdout so the auth URL shows up live
            remote = q.get("remote", [""])[0]
            if not remote:
                self._send(400, "bad remote", "text/plain"); return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            try:
                proc = subprocess.Popen(
                    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                     "-o", "StrictHostKeyChecking=accept-new", remote, "claude", "login"],
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, bufsize=1)
                for line in proc.stdout:
                    payload = json.dumps({"line": line.rstrip("\n")})
                    self.wfile.write(f"data: {payload}\n\n".encode())
                    self.wfile.flush()
                proc.wait()
                rc = proc.returncode
                self.wfile.write(f"data: {json.dumps({'done': True, 'rc': rc})}\n\n".encode())
                self.wfile.flush()
            except Exception as e:
                try:
                    self.wfile.write(f"data: {json.dumps({'error': str(e)})}\n\n".encode())
                    self.wfile.flush()
                except Exception:
                    pass
            return
        elif u.path == "/api/projects":
            # attachable projects: the shared project + distinct cwds seen across sessions
            seen, out = set(), []
            if SETTINGS["project"]:
                out.append({"path": SETTINGS["project"], "label": os.path.basename(SETTINGS["project"]) + " (shared)"})
                seen.add(SETTINGS["project"])
            for eng in ("claude", "codex"):
                for r in list_sessions(eng, limit=300):
                    c = r.get("cwd")
                    if c and c not in seen and os.path.isdir(c):
                        seen.add(c)
                        out.append({"path": c, "label": r.get("project") or os.path.basename(c)})
            self._send(200, json.dumps(out[:40]))
        elif u.path == "/api/files":
            base = SETTINGS["project"] or HERE
            rel = q.get("dir", [""])[0]
            d = os.path.normpath(os.path.join(base, rel))
            if not d.startswith(os.path.normpath(base)):  # don't escape the project directory
                d, rel = base, ""
            entries = []
            try:
                for name in sorted(os.listdir(d), key=lambda x: (not os.path.isdir(os.path.join(d, x)), x.lower())):
                    if name.startswith("."):
                        continue
                    entries.append({"name": name, "dir": os.path.isdir(os.path.join(d, name))})
            except Exception:
                pass
            self._send(200, json.dumps({"base": base, "rel": os.path.relpath(d, base) if d != base else "",
                                        "entries": entries[:400]}))
        elif u.path == "/api/tokens":
            _maybe_refresh_tokens()   # background; never blocks this request
            self._send(200, json.dumps(_TOK_CACHE["data"] or _zero_tokens()))
        elif u.path == "/api/behavior":
            self._send(200, json.dumps({"records": BEHAVIOR, "streak": STREAK}))
        elif u.path == "/api/memory":
            # the markdown files the shared memory is mirrored into, and how big each is
            fs = [{"path": f, "bytes": (os.path.getsize(f) if os.path.exists(f) else 0)}
                  for f in _mem_files()]
            self._send(200, json.dumps({"dir": _mem_dir(), "max_bytes": MEM_MAX,
                                        "files": fs}, ensure_ascii=False))
        elif u.path == "/api/shared":
            # the common pool every window reads, plus how far each window has been fed
            with LOCK:
                self._send(200, json.dumps({"shared": SHARED, "seen": SHARED_SEEN,
                                            "names": NAMES}, ensure_ascii=False))
        elif u.path == "/api/engines":
            self._send(200, json.dumps({
                "claude": {"available": bool(CLAUDE_BIN), "bin": CLAUDE_BIN,
                           "title_source": "desktop" if CLAUDE_SESS else "cli-jsonl"},
                "codex": {"available": bool(CODEX_BIN), "bin": CODEX_BIN},
            }))
        else:
            self._send(404, "not found", "text/plain")

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n) if n else b""
        if self.path == "/api/upload":
            if n > 60 * 1024 * 1024:
                self._send(413, json.dumps({"error": "file too large (>60MB)"})); return
            fname = os.path.basename(unquote(self.headers.get("X-Filename", "file"))) or "file"
            fname = fname.replace("\x00", "")
            base = SETTINGS["project"] or HERE
            updir = os.path.join(base, ".duo_uploads")
            try:
                os.makedirs(updir, exist_ok=True)
                stem, ext = os.path.splitext(fname)
                dest, i = os.path.join(updir, fname), 1
                while os.path.exists(dest):
                    dest = os.path.join(updir, f"{stem}_{i}{ext}"); i += 1
                with open(dest, "wb") as f:
                    f.write(body)
                self._send(200, json.dumps({"ok": True, "rel": os.path.relpath(dest, base),
                                            "name": os.path.basename(dest)}))
            except Exception as e:
                self._send(500, json.dumps({"error": str(e)}))
            return
        if self.path == "/api/stream":
            req = json.loads(body or b"{}")
            target = req.get("target", "both")
            text = (req.get("text") or "").strip()
            nm = req.get("names")            # window display names, so the shared block reads naturally
            if isinstance(nm, dict):
                with LOCK:
                    NAMES.update({k: v for k, v in nm.items() if k in STATE and isinstance(v, str)})
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            wlock = threading.Lock()

            def emit(ev):
                try:
                    with wlock:
                        self.wfile.write((json.dumps(ev, ensure_ascii=False) + "\n").encode())
                        self.wfile.flush()
                except Exception:
                    pass
            try:
                if text:
                    handle_stream(target, text, emit)
            except Exception as e:
                emit({"k": "error", "t": str(e)})
            return
        req = json.loads(body or b"{}")
        if self.path == "/api/load":
            pane = req.get("pane") or req.get("engine")   # back-compat: older callers sent engine=pane id
            sid = req.get("id"); cwd = req.get("cwd") or HERE
            if pane in STATE:
                # transcript format depends on the REAL engine, not the pane id
                real_engine = req.get("engine") if req.get("engine") in ("claude", "codex") else STATE[pane]["engine"]
                with LOCK:
                    STATE[pane]["id"] = sid; STATE[pane]["cwd"] = cwd
                _save_state()
                self._send(200, json.dumps({"ok": True, "transcript": read_transcript(real_engine, sid)}))
            else:
                self._send(400, json.dumps({"error": "bad pane"}))
        elif self.path == "/api/session/patch":
            eng = req.get("engine"); sid = req.get("id"); patch = req.get("patch", {})
            if eng not in ("claude", "codex") or not sid:
                self._send(400, json.dumps({"error": "bad args"})); return
            with LOCK:
                ov = _load_overrides()
                ov.setdefault(eng, {}).setdefault(sid, {})
                for k, v in patch.items():
                    if v is None:
                        ov[eng][sid].pop(k, None)
                    else:
                        ov[eng][sid][k] = v
                if not ov[eng][sid]:
                    ov[eng].pop(sid, None)
                _save_overrides(ov)
            self._send(200, json.dumps({"ok": True}))
        elif self.path == "/api/project":
            path = (req.get("path") or "").strip()
            if path and not os.path.isdir(os.path.expanduser(path)):
                self._send(400, json.dumps({"error": f"directory not found: {path}"})); return
            path = os.path.expanduser(path) if path else None
            with LOCK:
                changed = path is not None and path != SETTINGS["project"]
                SETTINGS["project"] = path
                if changed:  # only a project change restarts both agents in the new directory
                    for e in STATE:
                        STATE[e]["cwd"] = path
                        STATE[e]["id"] = None
            _save_state()
            self._send(200, json.dumps({"ok": True, "project": path}))
        elif self.path == "/api/agent-config":
            pane = req.get("engine")   # front-end sends the pane id here
            if pane not in AGENT_CFG:
                self._send(400, json.dumps({"error": "bad pane"})); return
            eng = STATE[pane]["engine"]
            with LOCK:
                for k in ("model", "mode", "effort"):
                    if k in req:
                        AGENT_CFG[pane][k] = req[k] or ("default" if k == "mode" and eng == "claude" else ("read-only" if k == "mode" else ""))
                if "fast" in req and "fast" in AGENT_CFG[pane]:
                    AGENT_CFG[pane]["fast"] = bool(req["fast"])
            _save_state()
            self._send(200, json.dumps({"ok": True, "cfg": AGENT_CFG[pane]}))
        elif self.path == "/api/clear-context":
            # clear cache = reset this agent's session; the next message starts fresh,
            # no longer re-caching the accumulated context (equivalent to /clear in Claude Code)
            eng = req.get("engine")
            engines = list(STATE) if eng in (None, "both", "all") else [eng]
            with LOCK:
                for e in engines:
                    if e in STATE:
                        STATE[e]["id"] = None
                        STREAK[e] = 0
            _save_state()
            self._send(200, json.dumps({"ok": True, "cleared": engines}))
        elif self.path == "/api/agent-cwd":
            eng = req.get("engine")
            cwd = (req.get("cwd") or "").strip()
            if eng not in STATE:
                self._send(400, json.dumps({"error": "bad engine"})); return
            if cwd and not os.path.isdir(os.path.expanduser(cwd)):
                self._send(400, json.dumps({"error": f"directory not found: {cwd}"})); return
            cwd = os.path.expanduser(cwd) if cwd else (SETTINGS["project"] or HERE)
            with LOCK:
                STATE[eng]["cwd"] = cwd
                STATE[eng]["id"] = None
                STREAK[eng] = 0
            _save_state()
            self._send(200, json.dumps({"ok": True, "cwd": cwd}))
        elif self.path == "/api/stop":
            # interrupt: terminate the live CLI process(es) for a pane (or all if "both"/none)
            pane = req.get("pane")
            targets = list(STATE) if pane in (None, "", "both", "all") else [pane]
            stopped = []
            with LOCK:
                procs = [(pp, RUNNING.get(pp)) for pp in targets]
            for pp, proc in procs:
                if proc and proc.poll() is None:
                    try:
                        proc.terminate()
                        stopped.append(pp)
                    except Exception:
                        pass
            self._send(200, json.dumps({"ok": True, "stopped": stopped}))
        elif self.path == "/api/pane-engine":
            # switch which engine (claude|codex) a pane drives; reset its session
            # (a claude session id is not a valid codex thread id, and vice versa)
            pane = req.get("pane"); eng = req.get("engine")
            if pane not in STATE or eng not in ("claude", "codex"):
                self._send(400, json.dumps({"error": "bad pane/engine"})); return
            with LOCK:
                STATE[pane]["engine"] = eng
                STATE[pane]["id"] = None
                STREAK[pane] = 0
                AGENT_CFG[pane] = _default_cfg(eng)   # reset settings to the new engine's defaults
            _save_state()
            self._send(200, json.dumps({"ok": True, "pane": pane, "engine": eng}))
        elif self.path == "/api/pane-remote":
            # set (or clear) the SSH remote for a pane; pass remote=null/"" to go back to local
            pane = req.get("pane"); remote = req.get("remote") or None
            if pane not in STATE:
                self._send(400, json.dumps({"error": "bad pane"})); return
            with LOCK:
                STATE[pane]["remote"] = remote
                STATE[pane]["id"] = None   # reset session; remote sessions aren't resumable locally
            _save_state()
            self._send(200, json.dumps({"ok": True, "pane": pane, "remote": remote}))
        elif self.path == "/api/reset":
            with LOCK:
                for e in STATE:
                    STATE[e]["id"] = None; STATE[e]["cwd"] = HERE; STREAK[e] = 0
            _save_state()
            self._send(200, json.dumps({"ok": True}))
        elif self.path == "/api/open-file":
            # reveal a file path from the chat in Finder (open -R). relative paths resolve against the pane cwd / project.
            raw = (req.get("path") or "").strip()
            pane = req.get("pane")
            if not raw:
                self._send(400, json.dumps({"error": "no path"})); return
            raw = os.path.expanduser(raw)
            if os.path.isabs(raw):
                cands = [raw]
            else:
                bases = [STATE.get(pane, {}).get("cwd"), SETTINGS.get("project"), HERE]
                cands = [os.path.join(b, raw) for b in bases if b]
            resolved = next((c for c in cands if os.path.exists(c)), None)
            if not resolved:
                self._send(404, json.dumps({"error": "not found", "tried": cands})); return
            try:
                if platform.system() == "Darwin":
                    args = ["open", resolved] if os.path.isdir(resolved) else ["open", "-R", resolved]
                else:
                    args = ["xdg-open", resolved if os.path.isdir(resolved) else os.path.dirname(resolved)]
                subprocess.Popen(args)
                self._send(200, json.dumps({"ok": True, "resolved": resolved}))
            except Exception as e:
                self._send(500, json.dumps({"error": str(e)}))
        else:
            self._send(404, json.dumps({"error": "not found"}))


if __name__ == "__main__":
    port = int(os.environ.get("DUO_PORT", "8765"))
    banner = [
        f"Code Matrix running  ->  http://localhost:{port}",
        f"  platform : {SYS}",
        f"  Claude CLI : {CLAUDE_BIN or 'not found (set DUO_CLAUDE_BIN or install Claude Code)'}",
        f"  Claude titles : {'desktop app index' if CLAUDE_SESS else 'CLI projects jsonl (aiTitle)'}",
        f"  Codex CLI  : {CODEX_BIN or 'not found (set DUO_CODEX_BIN or install Codex)'}",
        f"  Codex home : {CFG['codex_home']}",
    ]
    print("\n".join(banner), flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
