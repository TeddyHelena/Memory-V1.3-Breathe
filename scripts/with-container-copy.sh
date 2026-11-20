#!/usr/bin/env bash
# with-container-copy.sh —— 在容器副本上做写入/攻击面验证，用完即清
#
# 为什么要有这个脚本：
#   2026-09-15 安全核查时我在【生产容器】上做了一次 PUT 验证，改了 l57 的 updated 字段——
#   纪律（"写入测试必须在副本上跑"）被自己破了。
#   教训：靠自觉的纪律会被破，靠"走脚本就不用想"的纪律才守得住。
#
# 用法：
#   bash scripts/with-container-copy.sh '<要执行的命令>'
#   脚本会：复制生产容器到 /tmp → 在副本里执行你的命令 → 无论成功失败都删除副本
#   环境变量 CONTAINER_COPY 指向副本目录，供你的命令使用。
#
# 示例：
#   bash scripts/with-container-copy.sh 'node test/eval.mjs --root "$CONTAINER_COPY"'
#   bash scripts/with-container-copy.sh 'node tools/memory-cli.mjs list-pending --root "$CONTAINER_COPY"'
#
# 纪律：
#   - 副本一律落在 /tmp（不落笔记库目录，防被外部工具索引、防被误当内容）
#   - trap 兜底：脚本被 Ctrl-C、被 kill、异常退出，副本都会被清
#   - 只读验证不必用本脚本（读生产容器无害）；**任何写入/删除/PUT 必须用**

set -euo pipefail

PROD="${MEMORY_CONTAINER_ROOT:-}"
if [ -z "$PROD" ]; then
  echo "用法: MEMORY_CONTAINER_ROOT=<你的记忆容器根目录> bash scripts/with-container-copy.sh '<命令>'" >&2
  exit 2
fi
STAMP="$(date +%Y%m%d-%H%M%S)"
COPY="/tmp/mc-copy-${STAMP}-$$"

if [ ! -f "$PROD/index.json" ]; then
  echo "❌ 生产容器路径无效（缺 index.json）: $PROD" >&2
  exit 2
fi

if [ "$#" -lt 1 ]; then
  echo "用法: bash scripts/with-container-copy.sh '<命令>'" >&2
  exit 2
fi

cleanup() {
  local code=$?
  if [ -d "$COPY" ]; then
    rm -rf "$COPY"
    echo "" >&2
    echo "🧹 副本已清理: $COPY" >&2
  fi
  exit $code
}
# EXIT 覆盖正常退出与异常退出；INT/TERM 覆盖中断与 kill
trap cleanup EXIT INT TERM

cp -R "$PROD" "$COPY"
echo "📋 副本就绪: $COPY" >&2
echo "   生产容器只读，本次操作不影响它" >&2
echo "" >&2

export CONTAINER_COPY="$COPY"
CONTAINER="$COPY" bash -c "$1"
