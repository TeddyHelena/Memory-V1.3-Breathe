#!/usr/bin/env bash
# 改完 client bundle 之后，让壳里的浏览器**真的去拉新的那份**。
#
# 为什么要这一步：宿主按**固定路径**取 bundle（node_modules/<pkg>/lib/client.js），
# URL 里没有版本 / 内容指纹 ⇒ WKWebView 的**落盘缓存**会一直命中旧文件，
# **退出重开也照样是旧的**（缓存持久化，不随进程退出消失）。
# 2026-10-10 实测：宿主侧构建 hash 已一致、stale=false、apply 13:36，界面仍是旧版 —— 就是这个。
#
# 用法：bash scripts/client-refresh.sh
#       然后 **Cmd+Q 完全退出 DSH 再打开**（关窗口不算）
set -euo pipefail
W="$HOME/Library/WebKit/com.deepseek-ai.harness-desktop"
if [ ! -d "$W" ]; then
  echo "（没找到 WKWebView 缓存目录：$W —— 可能已经清过了）"
  exit 0
fi
TS="$(date +%Y%m%d-%H%M%S)"
mv "$W" "$W.pre-client-refresh-$TS"
echo "OK 已挪开 WKWebView 缓存 -> $W.pre-client-refresh-$TS"
echo "   要还原：mv 回去即可"
echo
echo "下一步：Cmd+Q 完全退出 DSH，然后重新打开（关窗口不算）"
