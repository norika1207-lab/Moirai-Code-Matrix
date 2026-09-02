# Code-Mercury

本地 AI 指揮層 MVP。

一句話使命:讓沒錢、用舊電腦的人,離線、免費寫程式,而且不被 AI 騙。

專案狀態:【MVP / 實驗中】。這不是成品,是正在每天實際使用、同時持續重構的工作原型。前身叫 Code Duo(雙 agent 版),現已演進為四視窗指揮矩陣。

## 為什麼做這個

現況三個痛點:雲端 AI 服務要錢,而且按量計費不封頂;主流工具對舊機器不友善,跑不動就是跑不動;AI 會編造內容,說「做完了」但磁碟上什麼都沒變,使用者踩坑還付了錢。

對應三個設計目標:零成本(驅動既有 CLI 訂閱,不另叫 API)、低硬體門檻(純標準庫,無任何前後端框架)、可驗證不欺騙(宣稱與磁碟實況逐輪比對,角色互審)。

## 它是什麼,它不是什麼

它是指揮層:把使用者意圖轉成給 AI 執行端的指令,管理多視窗分工、交接、互審與共享記憶,並監督「宣稱」與「實際變更」是否一致。

它不是模型本身,不是 IDE 外掛,也不是雲端服務。它是一支跑在你自己機器上的本機程式,驅動你已登入的 CLI,不經手任何 API key,不上傳你的專案。

## 核心特性

離線執行:【規劃中】。目前執行端驅動的是 `claude` 與 `codex` 兩支 CLI,它們本身要連網,所以現階段整體並非離線可用。離線的路徑是接入本地專家模型(Mercury 50MB student 路線,訓練進行中,見共享記憶 memory.md 2026-08-04 各節),接上前這條特性不算數。

反欺騙機制:【已可用】。四個視窗角色分工(指揮 / 實作 / 稽核 / 測試),宣稱必須附證據才算數。實績:2026-08-04 Dev 視窗產出 53,801 字規格摘要後,Audit 視窗獨立抽查 32 條出處、逐項回算數字,抓出 19 個 finding,包含 Dev 漏收的兩個 S1 級規格缺口與原文自身的一處一萬筆算術矛盾(紀錄在 memory.md 第 21 至 26 節)。另有逐輪 watchdog,比對 AI 宣稱的動作數與磁碟實際變更數,抓「說了 5 個動作、0 個檔案變更」這種空轉。

低配可跑:【已可用】。後端 `app.py` 1642 行,只用 Python 標準庫,零第三方依賴(行數以 `wc -l` 實測,2026-08-26)。前端 `index.html` 1062 行 vanilla JS,無 build step,無 node_modules。跑起來就是一支 Python 程序加一個瀏覽器分頁。

多視窗並行與交接:【已可用】。同一個提示可同時發給多個執行端並排比較;一鍵把一個視窗做到一半的工作交給另一個視窗接手或稽核,全部在同一份專案檔案上。

共享記憶池:【已可用】。四個視窗共用 `memory.md`,每輪指令與產出原文照錄,寫滿自動接續 `memory-2.md`、`memory-3.md`,所有視窗都會被告知全部檔案(機制在 `app.py` 第 117 至 165 行附近)。

## 系統架構

```
使用者
  |
  v
瀏覽器 UI (index.html, vanilla JS)
  |  HTTP / NDJSON 串流
  v
app.py (純 stdlib HTTP server, 預設 port 8765)
  |         |                |
  v         v                v
claude CLI  codex CLI     memory.md 共享記憶池
(訂閱登入)   (訂閱登入)     (四視窗共讀共寫)
  |         |
  v         v
各視窗角色 (roles/: PM / Dev / Audit / QA)
  |
  v
watchdog: 宣稱 vs 磁碟實況逐輪比對 -> 回到 UI
```

各元件一行說明:

- `app.py`:純標準庫 HTTP server,以串流模式驅動兩支 CLI(`claude --output-format stream-json`、`codex exec --json`),解析事件後以 NDJSON 推給瀏覽器。
- `index.html`:整個 UI,vanilla JS,無 build step。
- `roles/`:四個角色卡(PM.md、Dev.md、Audit.md、QA.md),定義各視窗的職責與界線。
- `memory.md`:共享記憶池,所有視窗的指令與產出原文照錄。
- `duo_state.json`、`duo_meta_cache.json` 等:視窗狀態與 session 中繼資料,落在專案根目錄。

資料落地位置:所有狀態檔與共享記憶都寫在專案資料夾內;session 標題與分組讀自 Claude / Codex 各自的本地資料,唯讀,不回寫官方 app。

## 硬體與環境需求

實測環境(2026-08-26,norika 的開發機):macOS(Darwin 25.4.0)、Python 3.11.5。此機實際同時跑五個 CLI 視窗與本服務。CPU 型號與記憶體大小:TODO(待實測,本輪指令權限未放行)。

最低配置:TODO(待實測,尚未在低階機器上實跑過,不填猜測數字)。

作業系統:macOS 實測過。Linux 與 Windows 的路徑偵測邏輯已寫在 `app.py` 的 `discover()`(含 `APPDATA`、`XDG_CONFIG_HOME` 分支),但未實測,不保證。

依賴:

- Python 3(標準庫即可,零第三方套件;實測版本 3.11.5)
- Claude Code CLI(`claude`),以訂閱登入
- Codex(`codex`,桌面 app 內建或獨立安裝),以 ChatGPT 訂閱登入
- 環境變數可覆寫偵測結果:`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`DUO_CLAUDE_BIN`、`DUO_CODEX_BIN`、`DUO_PORT`

## 安裝

前提:上面兩支 CLI 已各自登入。

1. 取得專案資料夾(目前尚未發佈公開 repo,取得方式:TODO(待 Command 定,現況為本機資料夾 `code-matrix-rebuild`))。
2. 進入資料夾,執行 `./start.sh`(內容就是 `python3 app.py`,無其他步驟)。
3. 開瀏覽器到 `http://localhost:8765`。

乾淨環境重裝驗證:TODO(待實測,本輪未在乾淨機器上重跑過安裝流程)。

常見安裝失敗(真的遇過的):

- CLI 偵測不到:啟動 banner 會印出偵測結果;裝在非標準路徑時用 `DUO_CLAUDE_BIN` / `DUO_CODEX_BIN` 指定。
- OAuth 過期:某個視窗整輪只回「Failed to authenticate: OAuth session expired and could not be refreshed」(memory.md 第 2、6、34 節都發生過)。解法是回該 CLI 重新登入,Code-Mercury 本身無法代辦。

## 快速開始

```bash
./start.sh
```

開 `http://localhost:8765`,啟動 banner 會列出偵測到的 CLI。

真實輸出範例:TODO(待實測。本輪撰寫時服務正在承載使用中的視窗,不重啟、不另起實例,banner 原文之後補貼)。

最小可驗證的一步:對任一視窗送出一句指令,該視窗以純文字回覆。2026-08-26 實測紀錄:Command 視窗收到「請只回覆一句話」指令後回覆「Code-Mercury 驅動測試成功。」(memory.md 第 50 至 51 節),五個視窗的回應鏈路同日逐一驗通。

看完這節,下一步看「使用方式」。

## 使用方式

主要操作:

- `Tab`:切換提示的目標(單一視窗或 Both)。
- Both:同一提示並行發給多個執行端,並排比較。
- 交接:一鍵把某視窗的工作連同上下文交給另一視窗接手或稽核。
- 環境變數參數見「硬體與環境需求」一節,port 用 `DUO_PORT` 改,預設 8765。

典型情境:

1. 修 bug:Command 派工給 Dev,Dev 附證據交付,Audit 唯讀複核,QA 實跑驗收。
2. 寫規格與實作:PM 出零歧義規格,Dev 照規格實作,規格模糊時 Dev 提 blocking question 而不是自己猜。
3. 稽核既有宣稱:把「別人說做完了」的東西丟給 Audit,產出逐條附出處的 finding。

怎麼看懂判定結果:Audit 視窗的判定只有六種,CONFIRMED(宣稱屬實)、PARTIAL(部分屬實)、MISMATCH(與規格不符)、UNWIRED(寫了但沒接上,典型是函式存在卻沒被呼叫就回報完成)、FABRICATED(捏造)、UNVERIFIED(構不到證據,附原因)。gate 決定為 PASS / PASS-WITH-CONDITIONS / REJECT。

## 已知限制

- 離線還沒實現。現階段執行端是雲端 CLI,斷網就不能用。這與使命直接矛盾,是最大的未完成項,靠本地模型路線補。
- 執行端要訂閱。零成本指的是不另付 API 費,不是完全免費;沒有 Claude / ChatGPT 訂閱就沒有執行端。
- OAuth 過期會讓一個視窗整輪報廢,而且是回覆時才發現,目前沒有事前偵測。
- 四視窗共寫同一份索引與記憶檔有並發覆寫風險,已實際發生過一次疑似索引行被蓋掉(memory.md 第 16 節 QA 的回報),尚未根治。
- watchdog 只能比對「宣稱的動作」與「磁碟變更」的數量與範圍,抓得到空轉與畫大餅,抓不到「改了檔案但改錯」這種語意錯誤,後者要靠 Audit 與 QA 流程。
- macOS 以外平台未實測。

## 藍圖

短期:

- 把 README 與文件定稿,補齊本檔所有 TODO(待實測)欄位。
- 50MB 本地 student 模型完成訓練與 eval,拿到真實 field accuracy 數字(進行中,memory.md 第 31 至 32 節)。
- 共享記憶並發寫入的護欄。

中期:

- 執行端接入本地專家模型,兌現離線與零訂閱。
- Linux 實測。

不寫時程,沒把握的不承諾。

## 貢獻方式

回報問題請附:重現步驟、`app.py` 啟動 banner 原文、瀏覽器 console 錯誤原文、作業系統與 Python 版本。只收原文,不收轉述。

送修改前:`python3 -m py_compile app.py` 要過;UI 改動附改動前後的實際截圖;任何「功能可用」的宣稱附實跑證據,無證據的宣稱一律視為未完成。

## 授權與作者

授權條款:TODO(待定,專案資料夾內目前無 LICENSE 檔,以 ls 實測確認,2026-08-26)。

作者:Chen, Ho Yiing (norika), Independent Researcher, Taiwan。ORCID: 0009-0006-6816-9891。GitHub: https://github.com/norika1207-lab

## 附錄

名詞表:

- 指揮層:本專案的定位,不產生程式碼本身,負責把意圖轉成指令並管理多 agent 流程與驗證。
- 視窗:一個獨立的 CLI 對話實例,綁一個角色卡。
- Command / 總指揮:派工與裁決的視窗,不動手實作。
- Dev:照規格實作並附證據交付的視窗。
- Audit:唯讀靜態稽核視窗,產出六種判定。
- QA:動態實跑驗收視窗,沒跑過不報 pass。
- 判定等級:見「使用方式」一節的六種判定與三種 gate 決定。
- watchdog:逐輪比對宣稱與磁碟實況的監督機制。

相關檔案位置索引:

- 程式本體:`app.py`、`index.html`、`start.sh`
- 角色卡:`roles/PM.md`、`roles/Dev.md`、`roles/Audit.md`、`roles/QA.md`
- 共享記憶:`memory.md`(滿了接 `memory-2.md`、`memory-3.md`)
- 視窗狀態:`duo_state.json`、`duo_meta_cache.json`、`duo_claude_groups.json`
- 上傳暫存:`.duo_uploads/`
