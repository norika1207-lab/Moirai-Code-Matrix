# 稽核報告(照妖鏡)2026-08-26 深夜

(原定寫入 /Users/norikaoda/Documents/card-ops/audit_report.md,但本稽核 session 對該路徑的寫入與讀取全被權限層擋下,只好落在 code-matrix-rebuild/audit_report.md。)

稽核方式聲明:本稽核 session 的檔案系統權限被鎖在 /Users/norikaoda/code-matrix-rebuild,對 ~/Documents/card-ops/ 與 ~/iseeu-newdrive-mirror/ 的所有檔案讀取指令(ls、cat、head、stat、grep、wc、find、Read 工具、Dropbox 連接器)全部被權限層擋下,非互動模式無法取得授權。放行的只有進程類指令(ps、lsof)。因此本報告只有「進程層實證」是我親眼查到的;凡讀不到的一律誠實標「無法驗證」,絕不假裝驗過。

## 1) 訓練是否真的在跑

宣稱:train_card_recog.md 宣稱「訓練已啟動」(結果檔本身我讀不到,宣稱內容轉引自派工 prompt 的要求格式)。

實查(親自跑 ps aux 兩次取樣 + lsof -p):
- 進程存在:PID 2402,/Users/norikaoda/anaconda3/bin/python3 train_iseeu_line_ctc.py,狀態 RN(running),啟動時間 11:05PM。
- 真的在算:第一次取樣 CPU 94.6%、累計 CPU 時間 0:40.34;約幾分鐘後第二次取樣 CPU 226.1%(多核)、累計 3:57.23。CPU 時間大幅成長 = 不是殭屍進程。
- 記憶體 RSS 約 164-176 MB。
- 訓練參數(ps 原文):--manifest .../real-crops-qwen-20260819/manifest_vocabclean.jsonl --vocab .../synth-lines-big-20260818/artifacts/vocab.json --out .../real-crops-qwen-20260819/artifacts/iseeu-textline-realft-h128.pt --init-from .../iseeu-textline-general-big-h128.pt --epochs 10 --batch-size 48 --learning-rate 2e-4 --device mps --log-every 50
- log 真的在長:lsof 顯示 PID 2402 的 fd 1w/2w 都指向 /Users/norikaoda/Dropbox/Mac (2)/Documents/card-ops/train_run.log(即 ~/Documents/card-ops/train_run.log 的實體路徑),兩次取樣大小 377 bytes → 486 bytes,持續成長。
- log「內容」我讀不到(權限擋),所以最後幾行是 loss 還是警告無法親驗。但進程以高 CPU 持續運算且未退出,不像 crash。

判定:相符(訓練進程真實存在且在動,log 在長)。log 內文未驗,這一小點存疑。

## 2) 資料洩漏檢查(train 與 real-holdout 的 doc_id 交集 = 0)

宣稱:train_card_recog.md 宣稱重疊 = 0(結果檔我讀不到,無法確認它實際寫了什麼)。

實查:我無法讀 manifest_vocabclean.jsonl / manifest.jsonl / real_holdout.jsonl(全被權限層擋),doc_id 交集「無法重算」。

判定:存疑(不是說它錯,是我這個稽核環境無法獨立重算,等於未經第三方驗證)。

## 3) 資料真實存在且沒被動(manifest 25681 行、images 在、無近期改動)

宣稱:real-crops-qwen-20260819/manifest.jsonl 有 25681 筆。

實查:
- 行數:無法數(讀取被擋)。
- images 是否在、find -mmin 近一小時變動:無法查(被擋)。
- 間接佐證:訓練進程用這個資料夾的 manifest_vocabclean.jsonl 已高速運算數分鐘未報錯退出,表示該 manifest 與其指向的影像至少可被讀取載入。
- 附帶發現:訓練實際吃的是 manifest_vocabclean.jsonl,不是派工單寫的 manifest.jsonl。推測是 OOV 清洗後的衍生檔(合理做法),但清洗後剩幾筆、是否寫進結果檔,我無法驗證。另外訓練會寫出 artifacts/iseeu-textline-realft-h128.pt,屬新增產物,不算改動原始資料。

判定:存疑(存在性有間接佐證,行數與未被改動無法親驗;訓練用檔名與派工單不同這點請對照 train_card_recog.md 有無交代)。

## 4) 起點模型與字表(synth-lines-big 的 .pt 與 1714 字 vocab)

宣稱:vocab.json(1714 字)與 iseeu-textline-general-big-h128.pt 存在且被用作起點。

實查:
- stat 直接查大小被擋,無法親驗檔案大小與 1714 字數。
- 間接佐證:ps 原文顯示訓練指令的 --vocab 與 --init-from 正是這兩個路徑,且進程已正常運算數分鐘;若 .pt 或 vocab 不存在或載不進去,CTC 訓練腳本應早就報錯退出,log 也不會持續成長。

判定:相符(間接):兩檔確實被真實訓練進程引用且載入成功;大小與字數未親驗。

## 5) 宣稱做了但磁碟無佐證的項目

- train_card_recog.md、teacher_quality.md、detector_plan.md、eval_harness.md:我連這些結果檔本身都讀不到,無法逐條核對文字宣稱,也無法確認 teacher_quality / detector_plan / eval_harness 是否存在。
- 環境確認(torch/mps 版本)、OOV 率統計:結果檔讀不到,無法核對;mps 可用性有間接佐證(訓練指令 --device mps 且在跑)。
- 派工端曾執行 rm -f train_card_recog.md 與 rm -f audit_report.md(ps 可見派工 shell 原文),所以 train_card_recog.md 是本輪新寫的,舊版已被刪。

## 總判定

發現 3 處存疑,列出:
1. 資料洩漏 doc_id 交集 = 0 無法獨立重算(稽核環境權限被鎖)。
2. manifest 行數 25681、images 完整性、近期無改動,無法親驗(僅間接佐證存在性)。
3. 訓練 log 內文(loss/epoch vs 錯誤)無法親驗;且實際訓練 manifest 為 manifest_vocabclean.jsonl,與派工單的 manifest.jsonl 不同名,需對照結果檔是否有交代。

無「不符」:凡我能親驗的(進程存在、CPU 在動、log 在長、訓練參數指向宣稱的資產)全部相符。存疑各項是稽核環境權限所致,建議下次稽核分身以能讀 ~/Documents 與 ~/iseeu-newdrive-mirror 的工作目錄啟動(或 --add-dir 加掛這兩個目錄),即可補驗。
