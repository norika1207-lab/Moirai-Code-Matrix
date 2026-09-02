# 任務: 名片 detector 現況盤點與下一步方案 (v2)
狀態: 部分完成(磁碟層仍受權限鎖,本輪以共享記憶新事實更新方案,詳見第 0 節)
產出者: 名片 detector 方案分身(第二輪,補做+更新)
時間: 2026-08-26 深夜

## 0. 證據等級與本輪權限實測

本 session 檔案存取仍鎖在 /Users/norikaoda/code-matrix-rebuild 白名單。我本輪親測被擋的操作(不是沿用別的分身轉述):

1. ls /Users/norikaoda/iseeu-newdrive-mirror/learned-ocr/receipt-textline-center500-v1/artifacts/ 被擋,錯誤訊息:「Claude Code may only list files in the allowed working directories for this session: '/Users/norikaoda/code-matrix-rebuild'」。
2. ls /Users/norikaoda/Documents/card-ops/ 被擋,錯誤訊息同時揭露該路徑實際解析到 /Users/norikaoda/Dropbox/Mac (2)/Documents/card-ops(Documents 是 Dropbox symlink)。
3. claude-mem 的 get_observations 跳權限請求,非互動 session 無人能批,觀測詳文撈不到。
4. Write 到指定落點 /Users/norikaoda/Documents/card-ops/detector_plan.md 跳權限請求,寫不進去,所以本檔落在工作目錄,搬運指令見文末。

所以任務 1 要求的「原文附行號」在磁碟層仍做不到,原因是權限,不是沒去做。本報告來源分四種,逐條標明:
- 【memory.md:行號】= 我親讀的 /Users/norikaoda/code-matrix-rebuild/memory.md(本輪已長到 1000 行,含前一輪之後新增的 [66]-[75] 段)。這證明「某分身如此回報」,不直接證明磁碟現況。
- 【前輪報告】= 前一輪 detector 分身留在 scratchpad 的 detector_plan.md 初版(88 行),我親自全文讀過,路徑 /private/tmp/claude-501/-Users-norikaoda-code-matrix-rebuild/b2f5f21f-9638-4f70-acb4-da5955987057/scratchpad/detector_plan.md。
- 【觀測#ID 標題】= session 啟動帶入的觀測標題一行字,詳文未撈到,未驗證。
- 【本次指令】= 派工文字所給資訊,未親驗。
查不到的一律寫「查無」,沒有編任何數字。

## 1. detector / textline 相關檔案盤點(任務1)

磁碟級盤點仍無法執行(第 0 節)。可及來源內的現況線索,含前一輪之後的新事實:

1. 收據 detector 存在:/Users/norikaoda/iseeu-newdrive-mirror/learned-ocr/receipt-textline-center500-v1/artifacts/,型號 unet16。來源:【本次指令】+ 前輪指令【memory.md:881】。artifacts 內實際檔名與大小,查無,我列不了目錄。
2. 名片專用 detector:狀態文件寫「未建立」。來源:指令方陳述【memory.md:801】+【觀測#7782 標題】ISEEU Business Card OCR Lacks Trained Detector/Recognizer。名片 textline 的訓練腳本、行框標註檔、狀態文件,在可及來源內查無任何具體檔名。
3. 新事實(前輪報告沒有的):recognizer 這條線 2026-08-26 23:14 已開訓,但訓練分身親驗後宣告 real-crops-qwen-20260819 不是名片資料(25681 行裡含 @ 只 53 行、含 TEL/FAX 只 42 行),checkpoint 改名 iseeu-textline-realft-h128.pt,定位是「真實場景通用文字行 recognizer」【memory.md:997-999】。teacher 品質抽檢分身用全量統計佐證同一件事:1934 個來源 doc 有 86.71%(1677 個)無任何名片欄位特徵,親看 40 張圖零張名片【memory.md:961】。
4. 新事實:真名片資料目前只找到 /Users/norikaoda/iseeu-llm-git/data-real-namecards-verified/sources.txt,只有來源清單,沒有圖也沒有標註;NewDrive 上有沒有,該分身 ls 被擋未驗證【memory.md:997】。名片原始影像的已知主倉是 /Volumes/NewDrive/AI Project/Mercury/Neuron-Mecury-主力/data/real-namecards-japan/(g_*.jpg、jp_*.png、jp_*.jpg、jpr_*.jpg 四類主線)【memory.md:433,500,527】。
5. 稽核分身親驗(ps + lsof 兩次取樣):recognizer 訓練真的在跑,PID 2402,吃的是 manifest_vocabclean.jsonl【memory.md:939-941】。這條與 detector 無直接關係,列出是因為它影響第 4 節的方案排程。
6. Audit 曾回報「已寫入 iseeu_recon.md」【memory.md:816】,該檔應含名片現況行號級證據,我仍讀不到;【觀測#7611 標題】有「回報寫入但檔案找不到」前例,請有權限視窗開檔抽查。

補盤指令(給有權限視窗照跑,唯讀,與前輪相同,仍未有人執行的跡象):

    ls -la ~/iseeu-newdrive-mirror/learned-ocr/
    ls -la ~/iseeu-newdrive-mirror/learned-ocr/receipt-textline-center500-v1/artifacts/
    grep -ril "namecard\|meishi\|名片" ~/iseeu-newdrive-mirror/learned-ocr/ | head -50
    find ~/iseeu-newdrive-mirror -iname "*JUNK_FILTER*"
    find "/Volumes/NewDrive/AI Project/Mercury/Neuron-Mecury-主力" -iname "*JUNK_FILTER*" -o -iname "*detector*" 2>/dev/null | head -30
    cat ~/Documents/card-ops/iseeu_recon.md

## 2. 收據 detector 借切名片,實測紀錄(任務2)

結論:查無。ISEEU_CARD_JUNK_FILTER_VALIDATION.md 這個檔我 find 不了(權限),在 memory.md 全文 1000 行與觀測標題裡也沒有任何「收據 detector 對名片影像實測切行」的紀錄或數字。借用效果目前沒有證據,是未知,不是好也不是壞。

要分清楚的一條:【觀測#7784 標題】Receipt OCR Cannot Transfer to Cards Due to Vocabulary and Architecture Mismatch,打的是 recognizer 的字彙表與架構;detector 是幾何任務不吃字彙,這條不能當「detector 也不能借」的證據。反向的「可以借」也沒有實測證據。此段是推理,以第 4 節第二步實測為準。

## 3. 訓名片專用 detector 需要什麼、缺什麼(任務3)

需要三樣,現況如下:

1. 名片原始影像:有主倉 real-namecards-japan(NewDrive)【memory.md:433,500】,但確數我讀不到;已知品質問題四類(空檔 jpr_0013.jpg、md5 重複、副檔名與檔頭不符、AppleDouble ._* 垃圾)已由 cleanup_plan 派工單列出【memory.md:526-545 段】,【觀測#7613 標題】同向。verified 資料夾另有 79 vs 158 張數矛盾未裁【memory.md:474-475 段】。
2. 行級框標註(detector 訓練標籤):查無任何名片行框標註存在的紀錄,判定為最大缺口。收據那顆命名 receipt-textline-center500-v1,推測是 500 張量級 center 標註(推測,未開檔驗證)。【觀測#7783 標題】Card Dataset Collection and Labeling Bottleneck Identified 同向。
3. 訓練管線:收據 detector 訓練腳本理論上同任務可重用,但腳本路徑與可跑性查無,待補盤。

本輪新增的關鍵判讀:recognizer 那條線現在也確認缺名片資料(real-crops-qwen 不是名片,見第 1 節第 3 條)。所以「名片行標註」這個缺口是兩顆模型共同的,不是 detector 獨有。這直接改變投報比計算,見第 4 節。

## 4. detector 下一步方案(任務4)

建議維持前輪結論:先借收據 unet16 湊合,同步開名片行標註,實測數字出來再決定要不要專訓。但依本輪新事實升級成「一魚兩吃」版,分五步。

第一步,補盤(半天)。有權限視窗跑第 1 節那串唯讀指令,坐實三件事:unet16 實際檔案、JUNK_FILTER_VALIDATION 有無、iseeu_recon.md 內容。前輪就開出這步,至今查無執行紀錄,它仍是一切的前置。

第二步,借用實測(一天)。拿收據 unet16 對 20 到 30 張真名片照片(從 real-namecards-japan 主線抽,避開 _rejected 與已知壞檔)跑切行,人工逐張記錄漏切與誤切。驗收先講死:目測行框 recall 八成以上算可湊合,低於不硬借。

第三步,依實測分岔。可湊合:端到端管線先用借的 detector 跑通;失敗案例照片進標註優先清單。不可湊合:失敗案例就是名片與收據版面差異的實證,直接變成專訓的第一批標註素材,不算白做。

第四步,名片行標註,一次餵兩顆(與二三步並行)。前置:先做 cleanup_plan 的衛生清理,不然工時浪費在重複與壞檔。然後對清理後主線影像做行級標註,每行同時記「框座標」(detector 標籤)與「行內文字」(recognizer 標籤),首期對齊收據的 500 張量級,框格式沿用收據 center 格式以重用訓練腳本(格式細節第一步補盤後確認)。行文字若用 teacher 自動預標再人工校,teacher 選 qwen 不選 apple:抽檢 qwen 20 筆對 18(90%)、apple 20 筆只對 11(55%),apple 還有 28.22% 標註短到 1-2 字元【memory.md:963】;且 qwen 錯誤是幻覺型(補框外字),校對時要特別盯「標了圖上沒有的字」【memory.md:965】。
   為什麼這步投報比本輪變高:recognizer 現在那顆是通用 realft 不是名片專用【memory.md:997】,之後要名片化一樣需要真名片行資料。同一次標註,detector 拿框、recognizer 拿行文字,一份工時餵兩顆模型的名片化,這是全案目前最划算的一筆人力投資。

第五步,專訓與對比。500 張標完,用收據既有管線訓 namecard-textline v1,和借用的 unet16 在同一批留出集對比行框品質,贏了才換。同批資料的行文字則餵給 realft 那顆做名片方向續訓(排程上等 PID 2402 這輪跑完再說,避免搶 mps)。

為什麼先借再訓,三個理由(前輪成立,本輪仍成立):

1. 資料面:名片行框標註查無,專訓原料不存在,直接訓等於卡死在標註,端到端繼續空轉;借用能立刻讓真實照片跑通全鏈。
2. 技術面:detector 不吃字彙,觀測 7784 的不可轉移證據打的是 recognizer;名片版面(行稀疏、多向、logo 干擾)的風險用 20-30 張實測便宜地量出來,不用先賭幾週標註。這是工程推理,以第二步實測為準。
3. 流程面:借用實測的失敗案例自動變成標註優先清單,湊合與專訓共用工作量,零浪費。

## 5. 給指揮方的建議

1. 權限(前輪提過,本輪複現,升級措辭):detector 這條線的下一步全部卡在「有權限的執行環境」。分身任務要碰 iseeu-newdrive-mirror、card-ops、NewDrive,啟 session 請加 --add-dir 或派互動視窗,否則第三輪分身還是只能寫方案不能動手。
2. 回報稽核:card-ops 底下「已寫入」回報請抽查落地(觀測 7611 前例)。本輪稽核分身也因權限讀不到 card-ops 的四份結果檔,檔內宣稱 vs 磁碟的比對至今沒人做成【memory.md:942】。
3. 排程:第四步標註不依賴 GPU/MPS,可以現在就啟動,跟 PID 2402 的訓練完全並行。

## 搬運指令(本檔落點受權限限制,在工作目錄)

指定落點 Write 被權限擋(第 0 節第 4 條),本檔實際位置 /Users/norikaoda/code-matrix-rebuild/detector_plan.md。請在有權限的視窗跑:

    cp /Users/norikaoda/code-matrix-rebuild/detector_plan.md ~/Documents/card-ops/detector_plan.md

## 證據出處清單

- /Users/norikaoda/code-matrix-rebuild/memory.md(1000 行,本輪親讀,行號如文中所標)
- 前輪 detector_plan.md 初版(88 行,親讀,路徑見第 0 節)
- claude-mem 觀測標題:#7611、#7613、#7782、#7783、#7784(僅標題,詳文權限擋,未驗證)
- 本次與前輪派工指令文字(unet16 路徑出處)
- 本輪親測被擋的操作紀錄(第 0 節)
