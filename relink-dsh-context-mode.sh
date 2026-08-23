#!/usr/bin/env bash
# relink-dsh-context-mode.sh — 自愈：把 context-mode 的 node_modules symlink 重指到当前 DSH 安装
# 用途：DSH 更新后（npx 哈希可能变化）context-mode 解析不到 @deepseek-ai/*，跑一次本脚本即可。
# 本脚本随插件目录走，DST 用脚本自身所在目录推导，插件搬到哪都能用。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST="$SCRIPT_DIR/node_modules"
DSH_NM=""

D="$(command -v dsh 2>/dev/null || true)"
if [[ -n "$D" ]]; then
  DSH_NM="$(dirname "$(dirname "$D")")"
fi

if [[ -z "$DSH_NM" ]]; then
  DSH_NM="$(ps aux 2>/dev/null | grep -oE '/[^[:space:]]*node_modules/\.bin/dsh' | head -1 | sed 's|/\.bin/dsh$||')"
fi

if [[ -z "$DSH_NM" ]]; then
  for d in $(ls -dt "$HOME/.npm/_npx/"*/node_modules 2>/dev/null); do
    if [[ -d "$d/@deepseek-ai/dsh" ]]; then DSH_NM="$d"; break; fi
  done
fi

if [[ -z "$DSH_NM" ]]; then
  echo "✗ 找不到 DSH 安装（检查 dsh 是否在 PATH / npx 缓存）"
  exit 1
fi
if [[ ! -d "$DSH_NM/@deepseek-ai/dsh-tools" ]]; then
  echo "✗ 候选路径缺 @deepseek-ai/dsh-tools: $DSH_NM"
  exit 1
fi

ln -sfn "$DSH_NM" "$DST"
echo "✓ 已重指 context-mode node_modules → $DSH_NM"

for pkg in @deepseek-ai/dsh-tools @deepseek-ai/schemastery turndown; do
  if [[ -d "$DST/$pkg" ]]; then
    echo "  ✓ $pkg"
  else
    echo "  ✗ $pkg 缺失"
  fi
done
echo "  完成。若仍有问题，检查 dsh 是否更新到新位置后重跑本脚本。"
