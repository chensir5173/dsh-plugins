#!/usr/bin/env bash
# dsh-notify-hub 示例：一个脚本覆盖常见聊天机器人 webhook
#   feishu  飞书自定义机器人      wecom   企业微信群机器人
#   dingtalk 钉钉自定义机器人     telegram  Telegram Bot
#   slack   Slack Incoming Webhook
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
#   WEBHOOK_KIND    feishu | wecom | dingtalk | telegram | slack（默认 feishu）
#   WEBHOOK_URL     通用 webhook 地址（feishu/wecom/dingtalk/slack 用）
#                   也可以分别用 FEISHU_WEBHOOK_URL / WECOM_WEBHOOK_URL /
#                   DINGTALK_WEBHOOK_URL / SLACK_WEBHOOK_URL 覆盖
#   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID   telegram 用这两个拼地址
#   NOTIFY_HUB_TITLE 覆盖标题
#
# 用法：
#   echo '{"sessionTitle":"修 bug","reason":"approval"}' | WEBHOOK_KIND=wecom WEBHOOK_URL=... ./notify-webhook.sh
#   ./notify-webhook.sh --dry-run                 # 只打印 JSON 和目标主机，不发
#   ./notify-webhook.sh --url=https://... --kind=feishu
#
# 依赖：bash + curl

set -u   # 不设 -e：失败也要走到统一的报错分支

DRY_RUN="${DRY_RUN:-0}"
KIND_ARG=""
URL_ARG=""
prev=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --kind=*) KIND_ARG="${arg#--kind=}" ;;
    --url=*)  URL_ARG="${arg#--url=}" ;;
  esac
  if [ "$prev" = "--kind" ]; then KIND_ARG="$arg"; fi
  if [ "$prev" = "--url" ]; then URL_ARG="$arg"; fi
  prev="$arg"
done

# ---------- 1. 读 stdin ----------
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

# ---------- 3. 文案 ----------
TITLE_BASE="DSH 停下来了"
case "$REASON" in
  approval) TITLE="$TITLE_BASE · 等你批准"; REASON_TEXT="工具调用在等你批准（急）" ;;
  question) TITLE="$TITLE_BASE · 等你回答"; REASON_TEXT="模型在等你回答问题" ;;
  turn-end)
    TITLE="$TITLE_BASE · 本轮结束"
    case "$DETAIL" in
      error)        REASON_TEXT="本轮以报错结束" ;;
      blocked)      REASON_TEXT="本轮被拦截" ;;
      max-tokens)   REASON_TEXT="本轮达到 token 上限" ;;
      aborted:user) REASON_TEXT="本轮被你中止" ;;
      completed|"") REASON_TEXT="本轮已跑完" ;;
      *)            REASON_TEXT="本轮结束（${DETAIL}）" ;;
    esac
    ;;
  *) TITLE="$TITLE_BASE"; REASON_TEXT="触发原因：$REASON" ;;
esac
TITLE="${NOTIFY_HUB_TITLE:-$TITLE}"

TEXT="$TITLE
会话：$SESSION_TITLE
$REASON_TEXT
目录：$WORKDIR"
if [ -n "$WHEN" ]; then TEXT="$TEXT
时间：$WHEN"; fi

# ---------- 4. 拼 JSON（bash 自带转义，不依赖 python3/jq） ----------
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"     # 反斜杠
  s="${s//\"/\\\"}"       # 双引号
  s="${s//$'\n'/\\n}"      # 换行
  s="${s//$'\r'/}"           # 回车
  s="${s//$'\t'/\\t}"      # 制表符
  printf '%s' "$s"
}

KIND="${WEBHOOK_KIND:-${KIND_ARG:-feishu}}"
ESC_TEXT="$(json_escape "$TEXT")"

case "$KIND" in
  feishu)   URL="${FEISHU_WEBHOOK_URL:-${WEBHOOK_URL:-${URL_ARG:-}}}" ;;
  wecom)    URL="${WECOM_WEBHOOK_URL:-${WEBHOOK_URL:-${URL_ARG:-}}}" ;;
  dingtalk) URL="${DINGTALK_WEBHOOK_URL:-${WEBHOOK_URL:-${URL_ARG:-}}}" ;;
  slack)    URL="${SLACK_WEBHOOK_URL:-${WEBHOOK_URL:-${URL_ARG:-}}}" ;;
  telegram) URL="${TELEGRAM_WEBHOOK_URL:-${URL_ARG:-}}" ;;
  *)        echo "[notify-webhook] 失败：不认识的 WEBHOOK_KIND=${KIND}（可选 feishu/wecom/dingtalk/telegram/slack）" >&2; exit 1 ;;
esac

case "$KIND" in
  feishu)   JSON='{"msg_type":"text","content":{"text":"'"$ESC_TEXT"'"}}' ;;
  wecom)    JSON='{"msgtype":"text","text":{"content":"'"$ESC_TEXT"'"}}' ;;
  dingtalk) JSON='{"msgtype":"text","text":{"content":"'"$ESC_TEXT"'"}}' ;;
  slack)    JSON='{"text":"'"$ESC_TEXT"'"}' ;;
  telegram)
    TOKEN="${TELEGRAM_BOT_TOKEN:-}"
    CHAT="${TELEGRAM_CHAT_ID:-}"
    [ -n "$URL" ] || URL="https://api.telegram.org/bot$TOKEN/sendMessage"
    JSON='{"chat_id":"'"$CHAT"'","text":"'"$ESC_TEXT"'","disable_notification":false}'
    ;;
esac

# 目标主机（日志里不打印完整 token）
HOST="$(printf '%s' "$URL" | sed -e 's#^[A-Za-z][A-Za-z0-9+.-]*://##' -e 's#/.*$##')"
HOST="${HOST:-（未配置地址）}"

# ---------- 5. 试跑：打印 JSON 与目标主机，不发 ----------
if [ "$DRY_RUN" != "0" ]; then
  echo "[notify-webhook] DRY-RUN kind=$KIND 目标主机=${HOST}（未发送）"
  echo "[notify-webhook] DRY-RUN JSON: $JSON"
  exit 0
fi

if [ -z "$URL" ]; then
  echo "[notify-webhook] 失败：没有配置地址。kind=$KIND 需要 WEBHOOK_URL" >&2
  exit 1
fi
if [ "$KIND" = "telegram" ] && { [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; }; then
  echo "[notify-webhook] 失败：telegram 需要 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID" >&2
  exit 1
fi

# ---------- 6. 发送 ----------
RESP="$(curl -sS --max-time 5 -w '\n%{http_code}' -X POST "$URL" \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary "$JSON" 2>&1)"
CURL_RC=$?
CODE="$(printf '%s' "$RESP" | tail -n 1)"
BODY_RESP="$(printf '%s' "$RESP" | sed '$d' | head -c 300)"

case "$CODE" in
  ''|*[!0-9]*)
    echo "[notify-webhook] 失败：curl 没能连上 ${HOST}（exit=${CURL_RC}）: $(printf '%s' "$RESP" | head -n 1)" >&2
    exit 1
    ;;
esac
if [ "$CODE" -lt 200 ] || [ "$CODE" -ge 300 ]; then
  echo "[notify-webhook] 失败：HTTP $CODE 响应=$BODY_RESP" >&2
  exit 1
fi

# 各家成功都会回 code/errcode=0 或 ok=true，这里做一个轻量判断
# 各家成功时会回 code/errcode = 0（有些网关回 200）或 ok=true，这里做一个轻量判断
FAIL_MSG=""
for num in $(printf '%s' "$BODY_RESP" | grep -Eo '"(code|errcode)"[[:space:]]*:[[:space:]]*[0-9]+' | grep -Eo '[0-9]+$' | sort -u); do
  if [ "$num" != "0" ] && [ "$num" != "200" ]; then FAIL_MSG="业务码 $num"; fi
done
if printf '%s' "$BODY_RESP" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*false'; then FAIL_MSG="ok=false"; fi
if [ -n "$FAIL_MSG" ]; then
  echo "[notify-webhook] 失败：${KIND} 返回业务错误（${FAIL_MSG}）：$BODY_RESP" >&2
  exit 1
fi

echo "[notify-webhook] 已发送到 ${KIND}（${HOST}，HTTP ${CODE}）: $TITLE | $SESSION_TITLE | $REASON_TEXT"
