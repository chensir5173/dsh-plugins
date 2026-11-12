#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-notify-hub 示例：把「DSH 停下来了」推到 iPhone（Bark）

契约（插件传给你的东西，别额外假设）：
  stdin  : 一行 UTF-8 JSON
           {"sessionId","sessionTitle","cwd","reason","reasonDetail","triggeredAt","ruleId","ruleName"}
  环境变量: NOTIFY_HUB_SESSION_ID / NOTIFY_HUB_RULE_ID / NOTIFY_HUB_CWD
            / NOTIFY_HUB_REASON / NOTIFY_HUB_DETAIL / NOTIFY_HUB_TIME
  cwd    : 插件已切到「规则的工作目录」，相对路径可以直接用
  超时   : 默认 30 秒，超时会被插件杀掉 —— 本脚本网络超时 5 秒，不阻塞

需要的环境变量：
  BARK_KEY   你的 Bark Key（不设置时用占位符 your_bark_key，真发之前会拒绝）
  BARK_BASE  Bark 服务地址，默认 https://api.day.app（自建服务改成自己的域名）
可选：
  BARK_SOUND 铃声名，如 birdsong / alarm；  BARK_GROUP 分组名，如 DSH
  BARK_LEVEL active / timeSensitive / critical；  BARK_ICON 图标 URL
  NOTIFY_HUB_TITLE 覆盖通知标题

用法：
  echo '{"sessionTitle":"修 bug","reason":"approval"}' | ./notify-bark.py
  ./notify-bark.py --dry-run                 # 只打印目标 URL，不发
  ./notify-bark.py --key your_bark_key --title "DSH"   # 参数覆盖（规则「参数」里可以直接填）
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 5  # 秒；插件默认 30 秒杀进程，网络调用必须短


def parse_args(argv):
    """极简参数解析：--key value / --key=value / --flag"""
    opts, flags = {}, set()
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg.startswith("--"):
            name = arg[2:]
            if "=" in name:
                name, value = name.split("=", 1)
                opts[name] = value
            elif i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                opts[name] = argv[i + 1]
                i += 1
            else:
                flags.add(name)
        i += 1
    return opts, flags


def load_payload():
    """读 stdin 的 JSON；人工直接运行（终端）时不要卡在等输入上"""
    raw = ""
    try:
        if not sys.stdin.isatty():
            raw = sys.stdin.read()
    except Exception:
        raw = ""
    if raw.strip():
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return {}


def compose(payload):
    """把上下文变成人类看得懂的标题 + 正文；没有 stdin 时给出友好默认值"""
    session_title = str(payload.get("sessionTitle") or "").strip() or "未命名会话"
    reason = str(payload.get("reason") or os.environ.get("NOTIFY_HUB_REASON") or "turn-end").strip()
    detail = str(payload.get("reasonDetail") or os.environ.get("NOTIFY_HUB_DETAIL") or "").strip()
    cwd = str(payload.get("cwd") or os.environ.get("NOTIFY_HUB_CWD") or "").strip() or os.getcwd()
    when = str(payload.get("triggeredAt") or os.environ.get("NOTIFY_HUB_TIME") or "").strip()

    if reason == "approval":
        title, reason_text = "DSH 停下来了 · 等你批准", "工具调用在等你批准"
    elif reason == "question":
        title, reason_text = "DSH 停下来了 · 等你回答", "模型在等你回答问题"
    elif reason == "turn-end":
        labels = {
            "error": "本轮以报错结束",
            "blocked": "本轮被拦截",
            "max-tokens": "本轮达到 token 上限",
            "aborted:user": "本轮被你中止",
            "completed": "本轮已跑完",
        }
        title = "DSH 停下来了 · 本轮结束"
        reason_text = labels.get(detail) or ("本轮结束（%s）" % detail if detail else "本轮已跑完")
    else:
        title, reason_text = "DSH 停下来了", "触发原因：%s" % reason

    title = os.environ.get("NOTIFY_HUB_TITLE") or title
    lines = ["会话：%s" % session_title, reason_text, "目录：%s" % cwd]
    if when:
        lines.append("时间：%s" % when)
    return {"title": title, "body": "\n".join(lines), "reason": reason, "cwd": cwd}


def mask(secret):
    """日志/dry-run 里不出现完整密钥"""
    if not secret:
        return "(未设置)"
    if len(secret) <= 6:
        return "***"
    return secret[:3] + "***" + secret[-2:]


def build_url(base, key, ctx, opts):
    """Bark 的路径式接口：{base}/{key}/{title}/{body}，附带的参数走 query"""
    url = "%s/%s/%s/%s" % (
        base.rstrip("/"),
        urllib.parse.quote(key, safe=""),
        urllib.parse.quote(ctx["title"], safe=""),
        urllib.parse.quote(ctx["body"], safe=""),
    )
    query = []
    for param, env in (("sound", "BARK_SOUND"), ("group", "BARK_GROUP"),
                       ("level", "BARK_LEVEL"), ("icon", "BARK_ICON")):
        value = opts.get(param) or os.environ.get(env)
        if value:
            query.append("%s=%s" % (param, urllib.parse.quote(value, safe="")))
    if query:
        url += "?" + "&".join(query)
    return url


def main():
    opts, flags = parse_args(sys.argv[1:])
    dry_run = "dry-run" in flags or os.environ.get("DRY_RUN", "0") == "1"

    ctx = compose(load_payload())
    key = opts.get("key") or os.environ.get("BARK_KEY") or "your_bark_key"
    base = opts.get("base") or os.environ.get("BARK_BASE") or "https://api.day.app"
    url = build_url(base, key, ctx, opts)

    if dry_run:
        safe_url = url.replace(key, mask(key)) if key else url
        print("[notify-bark] DRY-RUN 目标=%s（未发送）" % safe_url)
        if "show-key" not in flags and key:
            print("[notify-bark] 上面的 key 已打码；要看完整 URL 加 --show-key")
        return 0

    if key == "your_bark_key":
        print("[notify-bark] 失败：请先设置 BARK_KEY 环境变量（或 --key 参数）", file=sys.stderr)
        return 1

    try:
        request = urllib.request.Request(
            url, data=b"", method="POST",
            headers={"User-Agent": "dsh-notify-hub/0.1", "Content-Type": "text/plain; charset=utf-8"},
        )
        with urllib.request.urlopen(request, timeout=TIMEOUT) as resp:
            status = getattr(resp, "status", 200)
            text = resp.read(400).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        print("[notify-bark] 失败：HTTP %s %s" % (exc.code, exc.reason), file=sys.stderr)
        return 1
    except Exception as exc:
        print("[notify-bark] 失败：%s" % exc, file=sys.stderr)
        return 1

    code = None
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            code = parsed.get("code")
    except Exception:
        pass

    if status >= 400 or (code is not None and code != 200):
        print("[notify-bark] 失败：HTTP %s 响应=%s" % (status, text[:200]), file=sys.stderr)
        return 1

    print("[notify-bark] 已推送到 Bark：%s | %s" % (ctx["title"], ctx["body"].replace("\n", " / ")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
