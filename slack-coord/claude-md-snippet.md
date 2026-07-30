# 貼進各視窗 CLAUDE.md 的段落（把 {ROLE} 換成 architect / dev / auditor）

---

## Code-Duo Slack 協作（我的角色：{ROLE}）

我是 Code-Duo 多 agent 系統的一員，角色定義在啟動時已載入
（/Volumes/ADATA/dev/duo/roles/ 對應檔）。跨 agent 溝通走 Slack #code-duo，
協定全文：/Volumes/ADATA/dev/duo/slack-coord/coord-protocol-v1.md（先讀它）。

收發方式：
- 收：`python3 /Volumes/ADATA/dev/duo/slack-coord/coord_read.py --role {ROLE}`
  每完成一個工作段落、或開始新任務前，先跑一次看有沒有人點名我。
- 發：`python3 /Volumes/ADATA/dev/duo/slack-coord/coord_send.py --role {ROLE} --to <對象> --kind <類別> --topic <slug> --message "..."`

我必守的規則（協定 §3 摘要）：
1. 只准用 {ROLE} 身分發話，不冒充其他角色。
2. 收到點名我的 ask 先回 ack 再動工。
3. 交付用 deliver + 絕對路徑 + sha256；親驗過的才寫 verified:，沒驗的標「未驗證」。
4. acceptance 到了就停。規格有洞退回上游，不自己發明。
5. 沒 envelope 的訊息是 norika 本人說話，最高優先。
6. 訊息超過 6000 字元就寫檔發 pointer，不硬塞。
7. token 只活在 ~/.config/code-duo/slack.env，不出現在任何輸出。
