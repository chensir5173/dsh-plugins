#!/usr/bin/env bash
# dsh-notify-hub 示例：推送到 ntfy（手机装 ntfy App 订阅主题就能收，或自建服务）
#
# 契约（插件传给你的东西，别额外假设）：
#   stdin : 一行 UTF-8 JSON
#           {"sessionId","sessionTitle","cwd","reason","reasonDetail","triggeredAt","ruleId","ruleName"}
#   环境变量: NOTIFY_HUB_SESSION_ID / NOTIFY_HUB_RULE_ID / NOTIFY_HUB_CWD
#             / NOTIFY_HUB_REASON / NOTIFY_HUB_DETAIL / NOTIFY_HUB_TIME
#   cwd   : 插件已切到「规则的工作目录」，相对路径可以直接用
#   超时  : 默认 30 秒会杀掉脚本 —— 本脚本 curl --max-time 5，不阻塞
#
# 环境变量：
#   NTFY_TOPIC     主题名（默认占位符 your_topic；真用要换成足够随机的长串，等于密码）
#   NTFY_BASE      服务地址，默认 https://ntfy.sh；自建填 https://ntfy.example.com
#   NTFY_TOKEN     需要鉴权时填，会带 Authorization: Bearer
#   NTFY_PRIORITY  优先级 1..5（默认按原因：等待批准/等待回答/报错=4，其余=3）
#   NTFY_TAGS      标签，逗号分隔（默认按原因给 warning / question / white_check_mark）
#   NOTIFY_HUB_TITLE 覆盖标题
#
# 用法：
#   echo '{"sessionTitle":"修 bug","reason":"approval"}' | ./notify-ntfy.sh
#   ./notify-ntfy.sh --dry-run          # 只打印目标和正文，不发
#   ./notify-ntfy.sh --topic my-topic   # 参数覆盖（规则「参数」里可以直接填）
#
# 依赖：bash + curl（macOS / Linux / WSL 都自带）

set -u   # 不设 -e：失败也要走到统一的报错分支

DRY_RUN="${DRY_RUN:-0}"
TOPIC_ARG=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --topic=*) TOPIC_ARG="${arg#--topic=}" ;;
  esac
done
# --topic value 这种写法也支持一下
prev=""
for arg in "$@"; do
  if [ "$prev" = "--topic" ]; then TOPIC_ARG="$arg"; fi
  prev="$arg"
done

# ---------- 1. 读 stdin（终端下不要挂住等输入） ----------
RAW=""
if [ ! -t 0 ]; then
  RAW="$(cat 2>/dev/null || true)"
fi

# ---------- 2. 取字段：stdin JSON -> 环境变量 -> 友好默认值 ----------
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
WHEN="$(json_field triggeredAt)"
WHEN="${WHEN:-${NOTIFY_HUB_TIME:-}}"

# ---------- 3. 文案与优先级 ----------
TITLE_BASE="DSH 停下来了"
case "$REASON" in
  approval)
    TITLE="$TITLE_BASE · 等你批准"; REASON_TEXT="工具调用在等你批准"
    DEFAULT_PRIORITY=4; DEFAULT_TAGS="warning"
    ;;
  question)
    TITLE="$TITLE_BASE · 等你回答"; REASON_TEXT="模型在等你回答问题"
    DEFAULT_PRIORITY=4; DEFAULT_TAGS="question"
    ;;
  turn-end)
    TITLE="$TITLE_BASE · 本轮结束"; DEFAULT_PRIORITY=3; DEFAULT_TAGS="white_check_mark"
    case "$DETAIL" in
      error)        REASON_TEXT="本轮以报错结束"; DEFAULT_PRIORITY=4; DEFAULT_TAGS="rotating_light" ;;
      blocked)      REASON_TEXT="本轮被拦截"; DEFAULT_PRIORITY=4; DEFAULT_TAGS="no_entry" ;;
      max-tokens)   REASON_TEXT="本轮达到 token 上限"; DEFAULT_PRIORITY=4; DEFAULT_TAGS="warning" ;;
      aborted:user) REASON_TEXT="本轮被你中止"; DEFAULT_TAGS="arrow_backward" ;;
      completed|"") REASON_TEXT="本轮已跑完" ;;
      *)            REASON_TEXT="本轮结束（${DETAIL}）" ;;
    esac
    ;;
  *)
    TITLE="$TITLE_BASE"; REASON_TEXT="触发原因：$REASON"; DEFAULT_PRIORITY=3; DEFAULT_TAGS="robot"
    ;;
esac

TITLE="${NOTIFY_HUB_TITLE:-$TITLE}"
TOPIC="${NTFY_TOPIC:-${TOPIC_ARG:-your_topic}}"
BASE="${NTFY_BASE:-https://ntfy.sh}"
PRIORITY="${NTFY_PRIORITY:-$DEFAULT_PRIORITY}"
TAGS="${NTFY_TAGS:-$DEFAULT_TAGS}"
TARGET="$BASE/$TOPIC"

BODY="$TITLE
会话：$SESSION_TITLE
$REASON_TEXT
目录：$WORKDIR"
if [ -n "$WHEN" ]; then BODY="$BODY
时间：$WHEN"; fi

# ntfy 的 HTTP 头必须是 ASCII：中文标题用 RFC 2047 编码（ntfy 支持）
header_value() {
  case "$1" in
    *[!\ -~]*) printf '=?UTF-8?B?%s?=' "$(printf '%s' "$1" | base64 | tr -d '\n')" ;;
    *) printf '%s' "$1" ;;
  esac
}

# ---------- 4. 试跑：只打印，不发 ----------
if [ "$DRY_RUN" != "0" ]; then
  echo "[notify-ntfy] DRY-RUN 目标=${TARGET}（未发送）"
  echo "[notify-ntfy] DRY-RUN 请求头: Title: $(header_value "$TITLE") | Priority: $PRIORITY | Tags: $TAGS"
  echo "[notify-ntfy] DRY-RUN 正文:"
  printf '%s\n' "$BODY"
  exit 0
fi

if [ "$TOPIC" = "your_topic" ]; then
  echo "[notify-ntfy] 失败：请先设置 NTFY_TOPIC 环境变量（或 --topic 参数）" >&2
  exit 1
fi

# ---------- 5. 发送 ----------
HEADERS=(-H "Title: $(header_value "$TITLE")" -H "Priority: $PRIORITY" -H "Content-Type: text/plain; charset=utf-8")
[ -n "$TAGS" ] && HEADERS+=(-H "Tags: $TAGS")
if [ -n "${NTFY_TOKEN:-}" ]; then
  HEADERS+=(-H "Authorization: Bearer $NTFY_TOKEN")
fi

RESP="$(curl -sS --max-time 5 -w '\n%{http_code}' -X POST "$TARGET" \
  "${HEADERS[@]+"${HEADERS[@]}"}" --data-binary "$BODY" 2>&1)"
CURL_RC=$?
CODE="$(printf '%s' "$RESP" | tail -n 1)"

case "$CODE" in
  ''|*[!0-9]*)
    echo "[notify-ntfy] 失败：curl 没能连上 ${BASE}（exit=${CURL_RC}）: $(printf '%s' "$RESP" | head -n 1)" >&2
    exit 1
    ;;
esac
if [ "$CODE" -lt 200 ] || [ "$CODE" -ge 300 ]; then
  echo "[notify-ntfy] 失败：HTTP $CODE 响应=$(printf '%s' "$RESP" | sed '$d' | head -c 300)" >&2
  exit 1
fi

echo "[notify-ntfy] 已推送到 ${TARGET}（HTTP ${CODE}）: $TITLE | $SESSION_TITLE | $REASON_TEXT"
