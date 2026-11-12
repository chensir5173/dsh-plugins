<#
  dsh-notify-hub 示例：Windows 本地提醒（Win10/11 原生 Toast + 可选提示音）

  契约（插件传给你的东西，别额外假设）：
    stdin : 一行 UTF-8 JSON
            {"sessionId","sessionTitle","cwd","reason","reasonDetail","triggeredAt","ruleId","ruleName"}
    环境变量: NOTIFY_HUB_SESSION_ID / NOTIFY_HUB_RULE_ID / NOTIFY_HUB_CWD
              / NOTIFY_HUB_REASON / NOTIFY_HUB_DETAIL / NOTIFY_HUB_TIME
    cwd   : 插件已切到「规则的工作目录」，相对路径可以直接用
    超时  : 默认 30 秒，超时会被插件杀掉 —— 本脚本没有任何阻塞等待

  可选调参（都有默认值）：
    NOTIFY_HUB_TITLE       覆盖通知标题（notify-router.py 会用到）
    NOTIFY_HUB_BEEP=0      关掉提示音（默认 1，响一声）
    NOTIFY_HUB_DRY_RUN=1   只打印，不弹窗（自测用），等价于 -DryRun

  用法：powershell -NoProfile -ExecutionPolicy Bypass -File notify-windows.ps1
  依赖：Windows PowerShell 5.1（系统自带），无需安装任何模块。
#>

[CmdletBinding()]
param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$newline = [System.Environment]::NewLine

# ---------- 1. 读 stdin：按原始字节 + UTF-8 解码，中文标题不会乱码 ----------
function Read-StdinUtf8 {
  $text = ''
  try {
    if ([Console]::IsInputRedirected) {   # 人工直接运行时 stdin 是控制台，读它会挂住
      $stdin = [Console]::OpenStandardInput()
      $buf = New-Object System.IO.MemoryStream
      $stdin.CopyTo($buf)
      $text = [System.Text.Encoding]::UTF8.GetString($buf.ToArray())
    }
  } catch {
    # 退路：字节读失败时用 Console.In（编码按系统默认，可能丢中文）
    try {
      if ([Console]::IsInputRedirected) { $text = [Console]::In.ReadToEnd() }
    } catch { $text = '' }
  }
  return $text.TrimStart([char]0xFEFF)   # 去掉可能的 BOM
}

$raw = Read-StdinUtf8
$data = $null
if ($raw -and $raw.Trim().Length -gt 0) {
  try { $data = $raw | ConvertFrom-Json } catch { $data = $null }
}

# ---------- 2. 取字段：优先 stdin JSON，其次环境变量，最后友好默认值 ----------
$sessionTitle = if ($data -and $data.sessionTitle) { [string]$data.sessionTitle } else { '未命名会话' }
$reason       = if ($data -and $data.reason)       { [string]$data.reason }       elseif ($env:NOTIFY_HUB_REASON) { $env:NOTIFY_HUB_REASON } else { 'turn-end' }
$detail       = if ($data -and $data.reasonDetail) { [string]$data.reasonDetail } elseif ($env:NOTIFY_HUB_DETAIL) { $env:NOTIFY_HUB_DETAIL } else { '' }
$workdir      = if ($data -and $data.cwd)          { [string]$data.cwd }          elseif ($env:NOTIFY_HUB_CWD) { $env:NOTIFY_HUB_CWD } else { (Get-Location).Path }

# ---------- 3. 按「为什么停下来」组织文案 ----------
$titleBase = 'DSH 停下来了'
switch ($reason) {
  'approval' {
    $title = "$titleBase · 等你批准"
    $reasonText = '工具调用在等你批准'
  }
  'question' {
    $title = "$titleBase · 等你回答"
    $reasonText = '模型在等你回答问题'
  }
  'turn-end' {
    $title = "$titleBase · 本轮结束"
    switch ($detail) {
      'error'        { $reasonText = '本轮以报错结束' }
      'blocked'      { $reasonText = '本轮被拦截' }
      'max-tokens'   { $reasonText = '本轮达到 token 上限' }
      'aborted:user' { $reasonText = '本轮被你中止' }
      ''             { $reasonText = '本轮已跑完' }
      'completed'    { $reasonText = '本轮已跑完' }
      default        { $reasonText = "本轮结束（${detail}）" }
    }
  }
  default {
    $title = $titleBase
    $reasonText = "触发原因：$reason"
  }
}
if ($env:NOTIFY_HUB_TITLE) { $title = $env:NOTIFY_HUB_TITLE }

$body = @($sessionTitle, $reasonText, $workdir) -join $newline
$oneLine = "$sessionTitle | $reasonText | $workdir"

# ---------- 4. 试跑模式：只打印，不弹窗 ----------
if ($DryRun -or $env:NOTIFY_HUB_DRY_RUN -eq '1') {
  Write-Output "[notify-windows] DRY-RUN 标题=$title 正文=$oneLine"
  exit 0
}

# ---------- 5. 原生 Toast（Win10/11 自带 WinRT，无需模块） ----------
function Show-Toast([string]$Title, [string]$Body) {
  try {
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
      [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $nodes = $template.GetElementsByTagName('text')
    $nodes.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
    $nodes.Item(1).AppendChild($template.CreateTextNode($Body)) | Out-Null
    $toast = New-Object Windows.UI.Notifications.ToastNotification $template
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DSH Idle Hook')
    $notifier.Show($toast)
    return $true
  } catch {
    Write-Verbose "Toast 不可用：$($_.Exception.Message)"
    return $false
  }
}

# ---------- 6. 退路一：老式气泡通知 ----------
function Show-Balloon([string]$Title, [string]$Body) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $ni = New-Object System.Windows.Forms.NotifyIcon
    $ni.Icon = [System.Drawing.SystemIcons]::Information
    $ni.BalloonTipTitle = $Title
    $ni.BalloonTipText = $Body
    $ni.Visible = $true
    $ni.ShowBalloonTip(5000)
    Start-Sleep -Milliseconds 800   # 让气泡有机会显示出来再释放
    $ni.Dispose()
    return $true
  } catch {
    Write-Verbose "气泡通知不可用：$($_.Exception.Message)"
    return $false
  }
}

# ---------- 7. 退路二：msg 命令（终端会话里的纯文本，兜底用） ----------
function Show-Msg([string]$Title, [string]$Body) {
  try {
    if (-not (Get-Command msg.exe -ErrorAction SilentlyContinue)) { return $false }
    & msg.exe * "$Title - $Body" | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

$ok = (Show-Toast $title $body)
if (-not $ok) { $ok = (Show-Balloon $title $body) }
if (-not $ok) { $ok = (Show-Msg $title $body) }

# ---------- 8. 提示音 ----------
if ($env:NOTIFY_HUB_BEEP -ne '0') {
  try { [console]::beep(880, 200) } catch { Write-Verbose '当前宿主没有控制台，跳过提示音' }
}

# ---------- 9. 结果 ----------
if ($ok) {
  Write-Output "[notify-windows] 已提醒: $oneLine"
  exit 0
}
Write-Error "[notify-windows] 失败：Toast / 气泡 / msg 都不可用"
exit 1
