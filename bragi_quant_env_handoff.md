# Bragi 量化環境接手指令包(macmini)

日期:2026-08-27。狀態:本視窗(Dev)ssh 全面被權限攔,四步「一步都沒能執行」,零遠端輸出。此檔是給權限通視窗的照抄指令包。

## 權限實測(主 session + developer 子代理)

- 主 session:`ssh norika-macminim4pro@100.121.29.3 'tail -20 /tmp/llama_build.log'` → This command requires approval
- 子代理:同指令 + `ssh -o BatchMode=yes ... 'echo SSH_OK'` → 兩者皆 This command requires approval,連線未發起
- 本 session 非互動、無人可批。與上一棒(realcard 316)同一面權限牆:任何 python 執行、任何工作目錄外讀寫、ssh 全要批准。macmini 連不連得上「未驗證」,被攔在本機端。

## 接手指令(逐條照抄,每條 ssh 內都自帶 PATH export,已知坑:不帶會 cmake 找不到)

步驟 1,看 build 進度,等 BUILD_DONE_EXIT=0:

```
ssh norika-macminim4pro@100.121.29.3 'tail -20 /tmp/llama_build.log'
```

若 build 停了沒成功,重跑(長任務,建議 nohup 丟背景再輪詢 log):

```
ssh norika-macminim4pro@100.121.29.3 'export PATH=/opt/homebrew/bin:$PATH && cd ~/llama.cpp && nohup cmake --build build --config Release -j > /tmp/llama_build.log 2>&1; echo BUILD_DONE_EXIT=$? >> /tmp/llama_build.log'
```

步驟 2,找量化器並驗證可執行:

```
ssh norika-macminim4pro@100.121.29.3 'find ~/llama.cpp/build -iname llama-quantize'
ssh norika-macminim4pro@100.121.29.3 '<上一條找到的路徑> --help | head -20'
```

步驟 3,建 venv 裝六套件(arm64 CPU 版,torch 下載大,逐一裝、哪個失敗記下繼續):

```
ssh norika-macminim4pro@100.121.29.3 'python3 -m venv ~/llama-quant-venv && ~/llama-quant-venv/bin/pip install -U pip'
ssh norika-macminim4pro@100.121.29.3 '~/llama-quant-venv/bin/pip install torch'
ssh norika-macminim4pro@100.121.29.3 '~/llama-quant-venv/bin/pip install transformers gguf numpy sentencepiece safetensors'
```

(用 venv 內 pip 絕對路徑,免 source、免互動 shell 差異。)

步驟 4,驗轉檔腳本:

```
ssh norika-macminim4pro@100.121.29.3 '~/llama-quant-venv/bin/python ~/llama.cpp/convert_hf_to_gguf.py --help | head -5'
```

出得來 usage 即環境完全可用。完成定義:llama-quantize --help 正常 + convert usage 正常 + 六套件裝況逐一列出。

## 回報格式(接手者照填)

每步結果、llama-quantize 能跑沒、convert 能跑沒、六套件哪些成功、卡在哪。
