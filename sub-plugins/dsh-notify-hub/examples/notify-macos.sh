#!/usr/bin/env bash
# dsh-notify-hub 示例：macOS 本地提醒（提示音 + 原生桌面通知）
#
# 契约（插件传给你的东西，别额外假设）：
#   stdin : 一行 UTF-8 JSON
#           {"sessionId","sessionTitle","cwd","reason","reasonDetail","triggeredAt","ruleId","ruleName"}
#   环境变量: NOTIFY_HUB_SESSION_ID / NOTIFY_HUB_RULE_ID / NOTIFY_HUB_CWD
#             / NOTIFY_HUB_REASON / NOTIFY_HUB_DETAIL / NOTIFY_HUB_TIME
#   cwd   : 插件已切到「规则的工作目录」，相对路径可以直接用
#   超时  : 默认 30 秒，超时会被插件杀掉 —— 本脚本没有任何阻塞等待
#
# 可选调参（都有默认值）：
#   NOTIFY_HUB_TITLE         覆盖通知标题（notify-router.py 会用到）
#   NOTIFY_HUB_SOUND         提示音文件，默认 /System/Library/Sounds/Glass.aiff
#   NOTIFY_HUB_SOUND_REPEAT  响几声，默认：等待批准 3 / 等待回答 2 / 一轮结束 1；0 = 静音
#   NOTIFY_HUB_DRY_RUN=1     只打印将要发的提醒，不响也不弹（自测用）
#
# 依赖：bash / afplay / osascript，都是 macOS 自带。

set -u   # 故意不设 -e：任何一步失败都要走到最后统一的报错分支

# ---------- 1. 读 stdin ----------
# 人工直接运行时 stdin 是终端，读它会挂住 -> 只有被管道/重定向时才读。
RAW=""
if [ ! -t 0 ]; then
  RAW="$(cat 2>/dev/null || true)"
fi

# ---------- 2. 取字段：优先 stdin JSON，其次环境变量，最后友好默认值 ----------
json_field() {
  [ -n "$RAW" ] || return 0
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$RAW" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
v = d.get(sys.argv[1]) if isinstance(d, dict) else None
print("" if v is None else v)' "$1" 2>/dev/null && return 0
  fi
  # 没有 python3 时的兜底：朴素的字符串提取，够用于「一行 JSON」的场景
  printf '%s' "$RAW" | tr -d '\n' |
    grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n 1 |
    sed 's/^[^:]*:[[:space:]]*"//; s/"$//'
}

SESSION_TITLE="$(json_field sessionTitle)"
SESSION_TITLE="${SESSION_TITLE:-未命名会话}"
REASON="$(json_field reason)"
REASON="${REASON:-${NOTIFY_HUB_REASON:-turn-end}}"
DETAIL="$(json_field reasonDetail)"
DETAIL="${DETAIL:-${NOTIFY_HUB_DETAIL:-}}"
WORKDIR="$(json_field cwd)"
WORKDIR="${WORKDIR:-${NOTIFY_HUB_CWD:-$(pwd)}}"

# ---------- 3. 按「为什么停下来」组织文案 ----------
TITLE_BASE="DSH 停下来了"
case "$REASON" in
  approval)
    TITLE="$TITLE_BASE · 等你批准"
    REASON_TEXT="工具调用在等你批准"
    DEFAULT_REPEAT=3
    ;;
  question)
    TITLE="$TITLE_BASE · 等你回答"
    REASON_TEXT="模型在等你回答问题"
    DEFAULT_REPEAT=2
    ;;
  turn-end)
    TITLE="$TITLE_BASE · 本轮结束"
    DEFAULT_REPEAT=1
    case "$DETAIL" in
      error)        REASON_TEXT="本轮以报错结束" ;;
      blocked)      REASON_TEXT="本轮被拦截" ;;
      max-tokens)   REASON_TEXT="本轮达到 token 上限" ;;
      aborted:user) REASON_TEXT="本轮被你中止" ;;
      completed|"") REASON_TEXT="本轮已跑完" ;;
      *)            REASON_TEXT="本轮结束（${DETAIL}）" ;;
    esac
    ;;
  *)
    TITLE="$TITLE_BASE"
    REASON_TEXT="触发原因：$REASON"
    DEFAULT_REPEAT=1
    ;;
esac

TITLE="${NOTIFY_HUB_TITLE:-$TITLE}"
SOUND="${NOTIFY_HUB_SOUND:-/System/Library/Sounds/Glass.aiff}"
case "$SOUND" in
  */*) ;;                                             # 已经是完整路径
  *) SOUND="/System/Library/Sounds/$SOUND" ;;         # 只写 Glass.aiff 时补全到系统音目录
esac
if [ ! -f "$SOUND" ] && [ -f "$SOUND.aiff" ]; then SOUND="$SOUND.aiff"; fi   # 允许省略 .aiff

REPEAT="${NOTIFY_HUB_SOUND_REPEAT:-$DEFAULT_REPEAT}"
case "$REPEAT" in ''|*[!0-9]*) REPEAT=1 ;; esac
if [ "$REPEAT" -gt 5 ]; then REPEAT=5; fi   # 别把 30 秒超时耗光

BODY_PLAIN="$SESSION_TITLE | $REASON_TEXT | $WORKDIR"   # 一行版，给 stdout
BODY_OSA="$SESSION_TITLE
$REASON_TEXT
$WORKDIR"                                               # 多行版，给通知正文

# ---------- 4. 试跑模式：只打印，不响也不弹 ----------
if [ "${NOTIFY_HUB_DRY_RUN:-0}" != "0" ] || [ "${1:-}" = "--dry-run" ]; then
  echo "[notify-macos] DRY-RUN 标题=$TITLE 正文=$BODY_PLAIN 声音=$SOUND 次数=$REPEAT"
  exit 0
fi

OK_NOTIFY=0
OK_SOUND=0

# ---------- 5. 桌面通知：osascript；标题/正文走 argv，避免 AppleScript 转义踩坑 ----------
if command -v osascript >/dev/null 2>&1; then
  if osascript - "$TITLE" "$BODY_OSA" <<'APPLESCRIPT' >/dev/null 2>&1
on run argv
	set theTitle to item 1 of argv
	set theBody to item 2 of argv
	display notification theBody with title theTitle
end run
APPLESCRIPT
  then
    OK_NOTIFY=1
  fi
fi

# ---------- 6. 声音：afplay 前台播放（每个系统音约 1 秒，重复次数已限幅） ----------
if [ "$REPEAT" -gt 0 ] && command -v afplay >/dev/null 2>&1 && [ -f "$SOUND" ]; then
  OK_SOUND=1
  i=0
  while [ "$i" -lt "$REPEAT" ]; do
    afplay "$SOUND" >/dev/null 2>&1 || { OK_SOUND=0; break; }
    i=$((i + 1))
  done
fi

# ---------- 7. 结果 ----------
if [ "$OK_NOTIFY" -eq 1 ] || [ "$OK_SOUND" -eq 1 ]; then
  echo "[notify-macos] 已提醒（桌面通知=$OK_NOTIFY 声音=$OK_SOUND 次数=${REPEAT}）: $BODY_PLAIN"
  exit 0
fi

echo "[notify-macos] 失败：osascript 和 afplay 都不可用" >&2
exit 1
