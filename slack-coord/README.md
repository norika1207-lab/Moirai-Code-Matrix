# Code-Duo Slack 協作包

讓 Code-Duo 各視窗的 CLI agent 用同一隻 @Code-Duo bot 在 #code-duo 互相派工。
一隻 bot、多個角色，靠訊息 envelope 區分（同老闆 qubii-air-coord 那套的精神）。

## 檔案

- `coord-protocol-v1.md` 協定全文（envelope 格式、六種 kind、鐵則）
- `roles.json` 角色註冊表（slug → 顯示名 / 頭像 emoji / 角色 md 路徑）
- `coord_send.py` 發訊（自動處理 topic → thread、6000 字上限、角色頭像）
- `coord_read.py` 收訊（輪詢，只印點名自己的 + 人類訊息）
- `claude-md-snippet.md` 貼進各視窗 CLAUDE.md 的段落模板

## 首次設定（一次就好）

1. 建 env 檔（token 依規則留本機，不放 ADATA）:

```bash
mkdir -p ~/.config/code-duo
cat > ~/.config/code-duo/slack.env <<'EOF'
SLACK_BOT_TOKEN=xoxb-把你的貼這
SLACK_APP_TOKEN=xapp-把你的貼這
CODE_DUO_CHANNEL=C0BGSP6UMCN
EOF
chmod 600 ~/.config/code-duo/slack.env
```

2. 冒煙測試:

```bash
python3 /Volumes/ADATA/dev/duo/slack-coord/coord_send.py \
  --role architect --to all --kind fyi --topic bootstrap \
  --message "coord v1 上線測試"
python3 /Volumes/ADATA/dev/duo/slack-coord/coord_read.py --role dev
```

第一條會以 Architect-PM 的名字出現在 #code-duo，第二條會把它讀回來。

3. 把 `claude-md-snippet.md` 的段落各貼一份進三個視窗的 CLAUDE.md，
   {ROLE} 分別換成 architect / dev / auditor。

## 日常使用

- agent 發話: `coord_send.py --role dev --to auditor --kind deliver --topic wo-xxx --message "..."`
- agent 收訊: `coord_read.py --role dev`（或 `--follow` 掛著輪詢）
- 你本人直接在頻道打字即可，不用格式，所有 agent 都會當最高優先收。

## 備註

- SLACK_APP_TOKEN（xapp）目前的輪詢版用不到，先存著；之後升級 Socket Mode
  即時推播（Bolt）會用，manifest 已開好 socket_mode。
- 新增角色 = roles/ 加一份角色 md + roles.json 加一筆 + 貼一份 snippet，Slack 端零改動。
- state（讀取進度、topic thread 對照）在 ~/.config/code-duo/，砍掉重來不影響頻道內容。
