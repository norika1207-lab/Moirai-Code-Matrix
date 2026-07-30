# Code-Duo Slack 協作協定 v1

適用範圍：#code-duo 頻道（channel id `C0BGSP6UMCN`，maktar.slack.com，私人頻道）。
所有 agent 發進這個頻道的訊息一律走本協定。人類（norika）發話不受任何格式限制。

## 1. 身分

Slack 端只有一隻 bot（@Code-Duo）。每個 agent 是本機 Code-Duo 視窗裡的一個 CLI session，
發訊時透過 envelope 自報角色，bot 會用該角色的顯示名稱與頭像發出。

角色註冊表在 `roles.json`。目前三個角色：

| slug | 角色 md | 定位 |
|---|---|---|
| architect | roles/pm-architect-uiux.md | 上游：規格、介面合約、畫面規格 |
| dev | roles/developer-omni.md | 中游：照規格實作，不改規格 |
| auditor | roles/auditor-sentinel.md | 末端：只審不改，Dev 交付完才開口 |

## 2. Envelope（每則 agent 訊息第一行，強制）

```
[<role>] [to: <target> | kind: <kind> | topic: <topic-slug>]
```

- role：發話者 slug，必須是 roles.json 裡註冊過的。不准冒充別的角色。
- to：`architect` / `dev` / `auditor` / `all` / `norika`。逗號可多收件人（`to: dev,auditor`）。
- kind 六種：
  - `ask`：請求或提問，期待回覆或動工
  - `answer`：回覆某個 ask
  - `ack`：收到工單的確認回條
  - `fyi`：純告知，不期待動作
  - `deliver`：交付（附產出路徑 + sha256）
  - `decision`：拍板事項（只有 norika 授權過的裁決可以用這個 kind）
- topic：穩定的 kebab-case slug，等同 thread key，必須放最後。
  同一 topic 的第一則訊息開新 thread，之後全部回在同一 thread（coord_send 自動處理）。

沒有 envelope 的訊息 = 人類訊息，所有 agent 都要當作對自己說的來讀。

## 3. 鐵則（每個 agent 的 CLAUDE.md 都要載入）

1. 收到點名自己的 `ask` 先回 `ack`，再動工。不 ack 視同沒收到。
2. 交付一律 `deliver` + 本機絕對路徑 + sha256。沒驗過的內容標「未驗證」，親驗過的才准寫 verified:。
3. acceptance 條件到了就停，不外溢加工（goal-gate）。
4. 訊息上限 6000 字元，超過就寫檔、發 pointer + sha256，不准硬塞。
5. token（xoxb / xapp）只存在 `~/.config/code-duo/slack.env`，不准出現在訊息、log、commit 任何地方。
6. auditor 的第零條在 Slack 同樣生效：dev 的 deliver 沒落地前，auditor 不准發言。
7. 角色間有矛盾或規格有洞，退回上游或上拋給 norika，不准自己發明設計。

## 4. 收發工具

- 發：`python3 coord_send.py --role dev --to auditor --kind deliver --topic xxx --message "..."`
  （長文用 `--file <path>` 或 stdin `-`）
- 收：`python3 coord_read.py --role dev`（讀一次新訊息）
  `python3 coord_read.py --role dev --follow`（每 15 秒輪詢，掛在 session 背景）
- 兩支都吃 `~/.config/code-duo/slack.env`，state 存 `~/.config/code-duo/`。

## 5. 版本

v1（2026-07-14 起用）。改協定要 norika 拍板，改完 bump 版號並在頻道發 `decision`。
