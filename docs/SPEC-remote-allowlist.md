# SPEC: remote 參數白名單

規格版本 1.0 · 2026-09-07
出規格者 session: `fced45b5-c15e-4665-847a-9982d960e8f9`
實作者: 下一棒（Dev）
狀態: 待實作

---

## 1. 這是什麼問題

`remote` 這個字串會從 HTTP 請求一路流到 `spawn('ssh', [...])` 的 argv，中間沒有任何驗證。

ssh 的參數解析規則是 `ssh [options] destination [command]`。放在 destination 位置的值若以 `-` 開頭，ssh 會把它當成選項而不是主機名。因此 `-oProxyCommand=<任意指令>` 會讓 ssh 在連線時執行那個指令，等於本機任意指令執行。

用的是 argv 陣列不是 shell 字串，所以這不是 shell injection。攻擊面在 ssh 自己的參數解析，不在 shell。

## 2. 兩個入口（都要修，不能只修一個）

### 入口 A：`/api/remote-login`
位置 `src/server.js:242`

```
const remote = q.get('remote') || '';
if (!remote) return send(res, 400, 'bad remote', 'text/plain');
spawn('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=10',
              '-o','StrictHostKeyChecking=accept-new', remote, 'claude', 'login'], ...)
```

特性：GET、單次執行、不落磁碟。
CSRF：極低門檻。一個 `<img src="http://localhost:8765/api/remote-login?remote=-oProxyCommand=...">` 就能觸發。

### 入口 B：`/api/pane-remote`
位置 `src/server.js:498`

```
const pane = reqBody.pane, remote = reqBody.remote || null;
if (!ctx.STATE[pane]) return sendJson(res, 400, { error: 'bad pane' });
ctx.STATE[pane].remote = remote; ctx.STATE[pane].id = null;
ctx.saveState();
```

特性：POST、會 `saveState()` 落磁碟到 `duo_state.json`、重啟後仍在、之後那個 pane 的每一輪都會用到它（流向 `src/cli-driver.js:37` 的 ssh argv）。

比入口 A 嚴重，因為它是持久的。

CSRF 門檻的驗證結果（這一項先前被標為未驗證，本規格已驗）：
`src/server.js:368` 解析 body 的寫法是

```
let reqBody = {}; try { reqBody = JSON.parse(buf.toString() || '{}'); } catch {}
```

完全不檢查 `Content-Type`。因此 HTML form 用 `enctype="text/plain"` 送出的 POST（屬於 CORS simple request，不觸發 preflight）只要 body 拼成合法 JSON 就會被接受。結論是入口 B 的 CSRF 門檻同樣低，不是原先猜測的「因為是 POST 所以較難」。

### 不在本規格範圍但屬於同一條資料流
`src/cli-driver.js:37` 是 remote 的最終消費點。本規格採取「入口驗證」策略，不在消費點再驗一次。理由見第 6 節。

## 3. 目標

任何進入 ssh argv 的 `remote` 值，必須是使用者 `~/.ssh/config` 裡實際存在的 Host 名稱。其餘一律拒絕。

## 4. 實作規格

### 4.1 新增共用驗證函式

位置：`src/discover.js`（與 `readSshHosts()` 同檔，因為白名單來源就是它）

```
export function isKnownHost(remote)
```

行為：
- `remote` 為 falsy（null / 空字串 / undefined）時回傳 `true`。理由：那代表「本機執行」，是合法狀態，不是遠端。
- 其餘情況，回傳 `readSshHosts().includes(remote)`。

不要做的事：
- 不要用黑名單（例如「拒絕以 `-` 開頭」）。黑名單會漏，而白名單來源是現成的。
- 不要在這個函式裡做正規化、trim、大小寫轉換。ssh config 的 Host 是大小寫敏感的字面比對，多做轉換會製造繞過空間。
- 不要快取 `readSshHosts()` 的結果。使用者可能在 App 執行期間編輯 `~/.ssh/config`，每次讀成本極低（一個小檔案）。

`readSshHosts()` 現有行為已確認：讀 `~/.ssh/config`，取 `Host` 行的名稱，排除含 `*` 或 `?` 的萬用字元條目。萬用字元被排除這點很重要，不要改動它。

### 4.2 入口 A 套用

`src/server.js` `/api/remote-login` 路由，在既有的空值檢查之後、`spawn` 之前插入：

```
if (!isKnownHost(remote)) return send(res, 400, 'unknown host', 'text/plain');
```

注意這裡與 4.1 的空值規則有落差：入口 A 原本就要求 remote 非空（它的用途是遠端登入，本機登入不走這條）。所以既有的 `if (!remote) return 400` 保留，白名單檢查加在它後面。

### 4.3 入口 B 套用

`src/server.js` `/api/pane-remote` 路由，在 pane 檢查之後、寫入 STATE 之前插入：

```
if (!isKnownHost(remote)) return sendJson(res, 400, { error: 'unknown host' });
```

這裡 remote 可以是 null（代表切回本機），4.1 的空值規則已涵蓋。

### 4.4 順手修一個相鄰的實錘 bug

`src/server.js:248`（在入口 A 的 spawn argv 裡）目前寫的是 `'claude', 'login'`。

`claude login` 這個子指令不存在。實測 `claude auth --help` 列出的子指令是 `login` / `logout` / `status`，所以正確寫法是 `'claude', 'auth', 'login'`。

全庫 grep 確認只有這一處，不是三處。不要因為別處的轉述說三處就去改三處。

## 5. 驗收條件

實作者必須自己跑完以下每一項並附輸出，不得以「已實作」代替證據。

| 編號 | 測試 | 預期 |
|---|---|---|
| V1 | `curl 'localhost:8765/api/remote-login?remote=-oProxyCommand=touch%20/tmp/pwned'` | 回 400 unknown host，且 `/tmp/pwned` 不存在 |
| V2 | `curl -X POST localhost:8765/api/pane-remote -d '{"pane":"w1","remote":"-oProxyCommand=touch /tmp/pwned2"}'` | 回 400，`duo_state.json` 裡 w1.remote 未被改寫，`/tmp/pwned2` 不存在 |
| V3 | 用 `~/.ssh/config` 裡真實存在的一台（例如 `gx10`）打 `/api/pane-remote` | 回 200，`duo_state.json` 正確寫入 |
| V4 | `curl -X POST localhost:8765/api/pane-remote -d '{"pane":"w1","remote":null}'` | 回 200，切回本機，這是合法路徑不可被擋 |
| V5 | 對 `/api/remote-login` 帶合法主機名 | 不回 400（能不能連上不在本規格範圍，只驗沒被白名單誤擋） |
| V6 | `grep -n "'claude', 'login'" src/server.js` | 無結果；`grep -n "'auth', 'login'"` 有一處 |

V1 與 V2 的 `/tmp/pwned` 檢查是這份規格的核心，不可省略。沒有那一步就只驗到「回了 400」，沒驗到「指令真的沒被執行」。

## 6. 消費點也要驗（v1.1 修訂，原本寫「不做」，已推翻）

規格 v1.0 寫的是「不在消費點再驗，入口守住就夠」。那個判斷被推翻了，理由如下，這一節記錄推翻的過程而不是直接改掉，因為理由本身要被後人看到。

推翻的論證：入口是會增生的，消費點只有一個。今天有兩個入口，明天新增第三個時，沒有任何機制強迫新入口的作者記得套白名單。而 `src/cli-driver.js:36-37` 是所有 remote 的必經之路，在那裡設防，未來的入口自動被保護。

一個很強的旁證：`cli-driver.js:37` 同一行裡，`claudeArgs` 有經過 `shquote` 處理，`remote` 沒有。防護就在隔壁一個變數，卻漏掉了它。這說明「靠作者記得」不可靠。

所以改成兩層，職責不同，不是重複：

第一層（入口，`server.js` 兩處）：白名單 `isKnownHost()`，不通過就回 400 加清楚訊息。這一層的職責是「給使用者正確的回饋」。

第二層（消費點，`cli-driver.js:36` 遠端分支）：斷言。這一層的職責是「攔截不該發生的情況」，若在這裡被擋下，代表有入口漏了檢查，屬於程式錯誤，必須記錄而不是靜默失敗。

第二層的具體要求：

```
遠端分支執行前，若 remote 為 truthy：
  1. remote 不得以 '-' 開頭        → 違反則拒絕執行
  2. isKnownHost(remote) 必須為真   → 違反則拒絕執行
違反時：不 spawn，emit 一則錯誤訊息給該 pane，並在 server log 記下
        「入口驗證漏失」與當下的 remote 值。
```

第 1 條是黑名單，這是本規格唯一允許黑名單的地方，理由是它針對的不是「所有壞值」，而是 ssh 參數解析這一個具體機制：ssh 把 destination 位置上以 `-` 開頭的值當成選項。它是白名單的補強，不是替代品，兩條都要有。

## 6b. 明確不做的事

不加 CSRF token 或 Origin 檢查。那是另一個更大的題目（會影響所有 API），不該夾帶在資安修補裡做。本規格只解 remote 這條資料流。CSRF 這件事應該單獨開規格。

不改 `readSshHosts()` 的既有行為。

## 7. 部署注意

這兩個檔案都是後端，改完必須重啟 Electron 才生效，而重啟會關閉使用者當前正在對話的視窗（`duo_state.json` 顯示 w1 接的 session 就是使用者本人正在講話的那一個）。

實作完成後不要自行重啟。把「已完成、待重啟」的狀態回報，由擁有者決定重啟時機。
