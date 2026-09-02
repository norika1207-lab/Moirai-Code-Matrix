# realcard 316 張第二版備料報告

日期:2026-08-27。分身:真名片原料建置(316 張)。
結論先講:本輪 pipeline 五步「一步都沒能執行」,權限牆全面攔截,連 199 張新圖的存在都無法親驗。本檔記錄權限實測證據、已親驗的 117 張沿用基礎、以及給權限通視窗的完整接手指令包。指定落點 ~/Documents/card-ops/realcard_manifest316.md 寫不進,本檔落在工作目錄,請有權限的視窗代跑一行:

```
cp /Users/norikaoda/code-matrix-rebuild/realcard_manifest316.md ~/Documents/card-ops/realcard_manifest316.md
```

## 第 0 節:權限實測(本 session + 子代理,共十一路,全部原文)

主 session 實測:

1. Read ~/Documents/card-ops/realcard_manifest.md → 擋(requested permissions ... but you haven't granted it yet)
2. ls NewDrive 來源目錄 → 擋(may only list files in the allowed working directories: '/Users/norikaoda/code-matrix-rebuild')
3. python3 -c 讀來源目錄 → 擋(This command requires approval)
4. python3 crop_lines_real.py(完整參數,limit 1)→ 擋(requires approval)
5. python3 crop_lines_real.py --help(單句、絕對路徑、無外部路徑參數)→ 擋(requires approval)
6. python3 -c "print('ok')" → 擋(requires approval)
7. Write ~/Documents/card-ops/realcard_manifest316.md → 擋(requested permissions ... not granted)
8. sort -o 到 scratchpad、grep -Ff 兩個工作目錄內檔案、process substitution → 全擋

子代理(developer agent)實測,四項全 BLOCKED,原文由子代理帶回:

9. python3 crop_lines_real.py --help → BLOCKED(This command requires approval)
10. ls NewDrive 來源目錄 → BLOCKED(requires approval)
11. ls 與 touch ~/Documents/card-ops/ → BLOCKED(requires approval),測試檔未產生、無副作用

可用的白名單實測:工作目錄內的 ls、wc、head、tail、Read 檔案可以;python3 --version 可以;任何 python 腳本執行、任何 -c、任何工作目錄外讀寫全部要批准,本 session 非互動、無人可批。這與段 83 Command 窗「權限牆沒重演」的 session 相反,與 debug 窗連四輪稽核分身被擋的情況相同。權限通不通是 session 相依,不是路徑修好了。

## 步驟 1~5 執行狀態:全部未執行

- 步驟 1 切行:未執行。來源目錄讀不到,「現 316 張」這個數字我零親驗,只是指令方說法。
- 步驟 2 標註:未執行(依賴步驟 1)。
- 步驟 3 品質閘:未執行。
- 步驟 4 vocabclean+strict:未執行。
- 步驟 5 manifest 路徑與比較:無新 manifest 可回報。本輪沒有產生任何新數字,以下所有數字都是前輪產物的親驗盤點,不是本輪 pipeline 產出。

## 已親驗的沿用基礎(本輪工作目錄內逐項驗過)

前 117 張的中間產物完整,增量接手的基礎成立:

- run117/crops:1350 張 crop 圖(ls | wc -l 親數)
- run117/crops_index.jsonl:1350 行,首行 doc_id g_0001、末行 g_0117,page 欄指向 NewDrive 來源目錄(head/tail 親看)
- vision_all_117.jsonl:1350 行(wc 親數),與「Vision 全量 1350/1350 成功」帳面一致
- manifest117_vocabclean.jsonl:425 行;manifest117_vocabclean_strict.jsonl:407 行(wc 親數)
- 四支腳本全文親讀:crop_lines_real.py(最小切行器)、vision_ocr.py(fast+rev3,參數見下)、build_manifest117.py(品質閘:Vision 空 lines 剔除、多行 y 中心極差>0.25 剔 blob、水平分段 hmerge 合併、doc_id 排序後每 5 張取 1 做 valid,名片級不跨 split)、vocab_clean117.py(字表 /Users/norikaoda/iseeu-newdrive-mirror/text-lines/synth-lines-big-20260818/artifacts/vocab.json,1714 字)

未親驗、只能轉述的:strict 版的產生規則(上輪觀測記為「Vision bb 行高 maxh < 0.5 crop 高即判 blob 漏網,剔 18 行」,425-407=18 算術相符,但產生它的程式碼本輪找不到獨立腳本檔,可能是上輪 inline 跑的);兩版差集我試了 comm 與 grep -Ff 都被權限攔,沒能重算。

## 接手指令包(給權限通的視窗,照抄可跑)

前提確認:先 ls 來源目錄確認 g_*.jpg 排除 ._ 後的實際張數,回報真實數字,不要沿用「316」直到親數。

步驟 1 切行(建議全 316 張重跑,不做增量:117 張實測 49.6 秒,316 張估 2~3 分鐘,比對齊兩批中間產物便宜;上輪已證 88→117 全重跑對舊圖逐筆重現):

```
cd /Users/norikaoda/code-matrix-rebuild/realcard && python3 crop_lines_real.py \
  --src-dir "/Volumes/NewDrive/AI Project/Mercury/Neuron-Mecury-主力/data/real-namecards-japan" \
  --detector "<上輪 unet16 detector 路徑,在 iseeu-newdrive-mirror 底下,本輪讀不到 mirror 無法給確切路徑,realcard_run.md 有記>" \
  --out-dir run316 --long-side 640 --hclose 35 --pad-factor 0.1 --device mps
```

回報:總 crop、有行頁、零行頁(上輪零行頁是 g_0020、g_0075,新批預期也會有)。

步驟 2 標註(Vision fast+rev3、關 language correction,對 run316 全量重跑,1350 張實測 100.6 秒,3600 張級估 5 分鐘內;跑完與 vision_all_117.jsonl 逐筆比對舊 crop 應完全相同):

```
python3 vision_ocr.py run316/crops vision_all_316.jsonl 0 3 0
```

(參數序:level 0=fast、revision 3、langcorr 0=off。)qwen2.5vl 交叉依上輪定案只對低信心子集跑,且 macmini GPU 被 qwen2.5:14b 常駐佔用的問題未解,非本步驟阻塞項。

步驟 3+4 品質閘與 vocabclean:

```
sed 's/run117/run316/g; s/manifest117/manifest316/g; s/vision_all_117/vision_all_316/g' build_manifest117.py > build_manifest316.py
python3 build_manifest316.py
sed 's/run117/run316/g; s/manifest117/manifest316/g' vocab_clean117.py > vocab_clean316.py
python3 vocab_clean316.py
```

回報:剔除數(drop_empty/drop_blob/drop_blank_text)、OOV 行率與字元率、最終行數、train/valid 行數與名片數、跨 split 名片數必須為 0。strict 版:對 vocabclean 結果再剔「該 crop 在 vision_all_316.jsonl 的 lines 中 max(bb 高) < 0.5」的列,先拿 117 舊資料驗證此規則重現 425→407 再套用到 316。

步驟 5 落點:manifest316_vocabclean.jsonl 與 manifest316_vocabclean_strict.jsonl 於 /Users/norikaoda/code-matrix-rebuild/realcard/,並 append 數字進 card-ops 的 realcard_manifest316.md。

量的預估(標明是推算不是實測):117 張淨產出 425 行,線性外推 316 張約 1100 行上下;實際會受新 199 張的拍攝品質(傾斜實拍比例)影響,上輪傾斜照 detector 頁級失敗率約兩成。1100 行對 23771 行的合成集仍是 4.6%,定位仍是領域適應微調原料,不是獨立訓練集;比 425 行版多一倍以上的 valid 名片數,CER 抖動會明顯改善。

## 總結

本輪 0 個新數字、0 步 pipeline 執行,原因是 session 權限牆,十一路實測全記錄在第 0 節。117 張基礎產物完整性親驗過,接手包已備妥,權限通的視窗照抄約 10 分鐘機器時間可跑完。detector 確切路徑在 mirror 底下,本輪讀不到,接手者從 realcard_run.md 取。
