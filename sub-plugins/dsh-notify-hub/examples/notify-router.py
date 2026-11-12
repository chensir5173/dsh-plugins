#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-notify-hub 示例：按「为什么停下来」分发到不同渠道的调度器

思路：
  1. 读 stdin JSON / NOTIFY_HUB_* 环境变量，拿到 reason（turn-end / approval / question）；
  2. 按 reason 选一种「语气」：等待批准 = 急（标题带 ⚠️ + 响 3 声），
     等待回答 = 中（🙋 + 响 2 声），一轮结束 = 安静（默认不响）；
  3. 把同一份契约（stdin JSON + 环境变量）交给若干个渠道脚本去发。

渠道（同目录下的其它示例脚本）：
  macos  -> notify-macos.sh      windows -> notify-windows.ps1
  bark   -> notify-bark.py       ntfy    -> notify-ntfy.sh
  webhook-> notify-webhook.sh    popo    -> notify-popo.py

渠道配置（环境变量，逗号分隔；也可用 --channels）：
  ROUTER_CHANNELS            所有原因都用这些渠道，例如 macos,ntfy
  ROUTER_CHANNELS_TURN_END   只覆盖「一轮结束」
  ROUTER_CHANNELS_APPROVAL   只覆盖「等待批准」
  ROUTER_CHANNELS_QUESTION   只覆盖「等待回答」
  一个都没配时：只跑当前系统的本机桌面提醒（macOS/Windows），其它平台只提示不报错。

契约（插件传给你的东西，别额外假设）：
  stdin  : 一行 UTF-8 JSON
           {"sessionId","sessionTitle","cwd","reason","reasonDetail","triggeredAt","ruleId","ruleName"}
  环境变量: NOTIFY_HUB_SESSION_ID / NOTIFY_HUB_RULE_ID / NOTIFY_HUB_CWD
            / NOTIFY_HUB_REASON / NOTIFY_HUB_DETAIL / NOTIFY_HUB_TIME
  超时   : 默认 30 秒 —— 本脚本给每个渠道 8 秒、总预算 20 秒，绝不超过。

用法：
  echo '{"sessionTitle":"修 bug","reason":"approval"}' | ROUTER_CHANNELS=macos,popo ./notify-router.py
  ROUTER_CHANNELS=macos,ntfy ./notify-router.py --dry-run     # 全链路试跑，不发
  ./notify-router.py --channels macos,popo --dry-run
"""

import json
import os
import shlex
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))

PER_CHANNEL_TIMEOUT = 8   # 秒：单个渠道脚本最多跑多久
BUDGET_SECONDS = 20       # 秒：整个路由器最多跑多久（插件默认 30 秒杀进程）

# 渠道 -> (脚本名, 是否只在某个平台跑)
# 「内网 notify」的几个脚本（popo / mail）默认放在 examples/private/ 下（该目录被 .gitignore 忽略，
# 不入库）；脚本名在 examples/ 与 examples/private/ 两处都会找，随便你放哪儿。
CHANNELS = {
    "macos": ("notify-macos.sh", "darwin"),
    "windows": ("notify-windows.ps1", "win32"),
    "bark": ("notify-bark.py", None),
    "ntfy": ("notify-ntfy.sh", None),
    "webhook": ("notify-webhook.sh", None),
    "popo": ("notify-popo.py", None),
    "mail": ("notify-mail.py", None),
}

# 每种原因的语气：标题前缀、ntfy 优先级、macOS 提示音与次数
TONES = {
    "approval": {"prefix": "⚠️ ", "priority": "5", "repeat": "3", "sound": "Glass.aiff",
                 "text": "工具调用在等你批准（急）"},
    "question": {"prefix": "🙋 ", "priority": "4", "repeat": "2", "sound": "Glass.aiff",
                 "text": "模型在等你回答问题"},
    "turn-end": {"prefix": "", "priority": "3", "repeat": "0", "sound": "Tink.aiff",
                 "text": "本轮已跑完"},
    "unknown": {"prefix": "", "priority": "3", "repeat": "1", "sound": "Glass.aiff",
                "text": "DSH 停下来了"},
}


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


def tone_of(payload):
    """决定这次通知的语气；返回 (reason, tone, 标题, 正文行列表)"""
    reason = str(payload.get("reason") or os.environ.get("NOTIFY_HUB_REASON") or "turn-end").strip()
    detail = str(payload.get("reasonDetail") or os.environ.get("NOTIFY_HUB_DETAIL") or "").strip()
    tone = dict(TONES.get(reason) or TONES["unknown"])

    if reason == "turn-end":
        if detail in ("error", "blocked", "max-tokens"):
            tone.update(priority="4", repeat="2", sound="Glass.aiff")
            tone["text"] = {"error": "本轮以报错结束", "blocked": "本轮被拦截",
                            "max-tokens": "本轮达到 token 上限"}[detail]
        elif detail == "aborted:user":
            tone["text"] = "本轮被你中止"
        elif detail and detail != "completed":
            tone["text"] = "本轮结束（%s）" % detail
    elif reason == "question":
        pass
    elif reason != "approval":
        tone["text"] = "触发原因：%s" % reason

    title = (tone["prefix"] + "DSH 停下来了 · " + {
        "approval": "等你批准", "question": "等你回答", "turn-end": "本轮结束",
    }.get(reason, reason))
    return reason, tone, title


def pick_channels(argv_opts, reason):
    """渠道优先级：命令行 > 按原因的变量 > 通用变量 > 本机桌面提醒"""
    if argv_opts.get("channels"):
        raw = argv_opts["channels"]
    else:
        raw = os.environ.get("ROUTER_CHANNELS_%s" % reason.replace("-", "_").upper()) or ""
        if not raw:
            raw = os.environ.get("ROUTER_CHANNELS") or ""
    if raw.strip():
        names = [item.strip().lower() for item in raw.replace(";", ",").split(",")]
        return [name for name in names if name and name in CHANNELS]

    # 没配置 -> 只做本机桌面提醒
    if sys.platform == "darwin":
        return ["macos"]
    if sys.platform == "win32":
        return ["windows"]
    return []


def resolve_script(script):
    """脚本可在 examples/ 或 examples/private/（后者不入库），两处都找"""
    for candidate in (os.path.join(HERE, script), os.path.join(HERE, "private", script)):
        if os.path.exists(candidate):
            return candidate
    return None


def child_command(name, dry_run):
    """渠道名 -> 可直接执行的 argv；脚本文件不存在 / 平台不对时返回 None"""
    script, platform_only = CHANNELS[name]
    if platform_only and sys.platform != platform_only:
        return None
    path = resolve_script(script)
    if not path:
        print("[notify-router] 跳过渠道 %s：%s 与 private/%s 都没有这个脚本" % (name, script, script),
              file=sys.stderr)
        return None

    if name == "windows":
        cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path]
        if dry_run:
            cmd.append("-DryRun")
        return cmd
    if path.endswith(".py"):
        cmd = [sys.executable, path]
    elif path.endswith(".sh"):
        cmd = [shutil.which("bash") or "/bin/bash", path]
    else:
        cmd = [path]
    if dry_run:
        cmd.append("--dry-run")
    return cmd


def run_channel(name, cmd, payload_json, env, dry_run):
    """跑一个渠道脚本，把它的 stdin/env 契约原样给它；返回 (name, ok, 输出一行)"""
    try:
        proc = subprocess.run(
            cmd, input=payload_json, capture_output=True, text=True,
            timeout=PER_CHANNEL_TIMEOUT, env=env, cwd=os.getcwd(),
        )
    except subprocess.TimeoutExpired:
        return name, False, "超时（>%ss）" % PER_CHANNEL_TIMEOUT
    except Exception as exc:
        return name, False, "启动失败：%s" % exc

    out = (proc.stdout or "").strip().splitlines()
    err = (proc.stderr or "").strip().splitlines()
    first = (out[-1] if out else (err[-1] if err else ""))[:200]
    return name, proc.returncode == 0, ("rc=%s %s" % (proc.returncode, first)).strip()


def main():
    argv_opts, flags = parse_args(sys.argv[1:])
    dry_run = "dry-run" in flags or os.environ.get("DRY_RUN", "0") == "1"

    payload = load_payload()
    reason, tone, title = tone_of(payload)
    session_title = str(payload.get("sessionTitle") or "").strip() or "未命名会话"
    cwd = str(payload.get("cwd") or os.environ.get("NOTIFY_HUB_CWD") or "").strip() or os.getcwd()

    # 补齐一份完整 payload 再传给渠道脚本：手工运行时也有合理内容
    forwarded = {
        "sessionId": payload.get("sessionId") or os.environ.get("NOTIFY_HUB_SESSION_ID") or None,
        "sessionTitle": payload.get("sessionTitle") or "未命名会话",
        "cwd": payload.get("cwd") or cwd,
        "reason": payload.get("reason") or reason,
        "reasonDetail": payload.get("reasonDetail") or os.environ.get("NOTIFY_HUB_DETAIL") or None,
        "triggeredAt": payload.get("triggeredAt") or os.environ.get("NOTIFY_HUB_TIME") or None,
        "ruleId": payload.get("ruleId") or os.environ.get("NOTIFY_HUB_RULE_ID") or None,
        "ruleName": payload.get("ruleName"),
    }
    payload_json = json.dumps(forwarded, ensure_ascii=False)

    # 给渠道脚本的额外环境：覆盖标题 / 声音 / 优先级，让语气统一
    env = dict(os.environ)
    env.update({
        "NOTIFY_HUB_TITLE": title,
        "NOTIFY_HUB_REASON": reason,
        "NOTIFY_HUB_DETAIL": str(forwarded["reasonDetail"] or ""),
        "NOTIFY_HUB_CWD": cwd,
        "NOTIFY_HUB_SOUND": tone["sound"],
        "NOTIFY_HUB_SOUND_REPEAT": tone["repeat"],
        "NTFY_PRIORITY": tone["priority"],
        "NTFY_TAGS": {"approval": "warning", "question": "question"}.get(reason, "white_check_mark"),
    })
    if dry_run:
        env["DRY_RUN"] = "1"
        env["NOTIFY_HUB_DRY_RUN"] = "1"

    names = pick_channels(argv_opts, reason)
    if not names:
        print("[notify-router] 没有可用渠道（%s 上没有本机桌面示例，也未配置 ROUTER_CHANNELS）" % sys.platform)
        return 0

    if dry_run:
        print("[notify-router] DRY-RUN 原因=%s 标题=%s 渠道=%s" % (reason, title, ",".join(names)))

    started = time.time()
    results = []
    for name in names:
        if time.time() - started > BUDGET_SECONDS:
            results.append((name, False, "总预算 %ss 用完，跳过" % BUDGET_SECONDS))
            continue
        cmd = child_command(name, dry_run)
        if not cmd:
            results.append((name, False, "平台不匹配或脚本缺失"))
            continue
        if dry_run:
            print("[notify-router] DRY-RUN 将执行: %s" % " ".join(shlex.quote(part) for part in cmd))
        results.append(run_channel(name, cmd, payload_json, env, dry_run))

    ok_names = [name for name, ok, _ in results if ok]
    bad = [(name, why) for name, ok, why in results if not ok]

    for name, why in bad:
        print("[notify-router] 渠道 %s 失败：%s" % (name, why), file=sys.stderr)
    if dry_run:
        for name, _, why in results:
            print("[notify-router] DRY-RUN 渠道 %s -> %s" % (name, why))

    summary = "%s | 会话：%s | 渠道 %s/%s 成功（%s）" % (
        title, session_title, len(ok_names), len(results), ",".join(ok_names) or "无")
    if ok_names:
        print("[notify-router] %s" % summary)
        return 0

    print("[notify-router] 失败：所有渠道都没成功 —— %s" % summary, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
