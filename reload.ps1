# 重载机器人：重新读取 .env 与 personas/ 的改动并重启进程。
#
#   reload.cmd          （双击即可，不需要管理员权限）
#   powershell -File reload.ps1 -Quiet
#
# 为什么需要它：.env 和 personas/*.json 都只在进程启动时读一次，
# 改完不重启是不会生效的。这个脚本把"停 → 起 → 等连接 → 报结果"做成一键。
#
# 会话上下文不会丢：PERSIST_SESSIONS=true 时会话落盘在 data/sessions.json。
#
# NOTE: 本文件是 UTF-8 **带 BOM** 保存的，Windows PowerShell 5.1 靠它正确识别中文。
#       用编辑器改完请确认 BOM 还在（没有 BOM 会整段解析失败）。

param(
  # 启动后等待 WS 连上的最长时间（秒）
  [int]$WaitSec = 30,
  # 只打印结果，不逐条输出
  [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ROOT    = Split-Path -Parent $MyInvocation.MyCommand.Path
# 优先用 PATH 里的 node；找不到再退回常见安装位置（PS 5.1 兼容写法）
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $NODE = $nodeCmd.Source
} else {
  $NODE = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
$CLI     = Join-Path $ROOT 'bin\cli.js'
$ENVFILE = Join-Path $ROOT '.env'
$PERSONAS= Join-Path $ROOT 'personas'
$BOTLOG  = Join-Path $ROOT 'logs\bot-run.log'

function Say($m, $color = 'Gray') {
  if (-not $Quiet) { Write-Host $m -ForegroundColor $color }
}

function Step($n, $t) {
  if (-not $Quiet) { Write-Host ''; Write-Host "--- $n $t ---" -ForegroundColor Yellow }
}

function Get-Bot {
  # 直接输出数组，调用方一律用 @() 包住 —— 两者必须配套。实测：
  #   `return ,$r` + @()  → 0 个进程也报 1 个（PID 会是空的）
  #   直接输出     + @()  → 3/1/0 个进程分别报 3/1/0，正确
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '[\\/]cli\.js' })
}

function Test-OneBot {
  $a = Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue
  $b = Get-NetTCPConnection -State Listen -LocalPort 3001 -ErrorAction SilentlyContinue
  return ([bool]$a -and [bool]$b)
}

if (-not (Test-Path $CLI))    { Write-Host "✗ 找不到 $CLI" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $NODE))   { Write-Host "✗ 找不到 Node 运行时：$NODE" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $ENVFILE)){ Write-Host "✗ 找不到 .env：$ENVFILE" -ForegroundColor Red; exit 1 }

if (-not $Quiet) {
  Write-Host ''
  Write-Host '  ==============================================================' -ForegroundColor Cyan
  Write-Host '        DeepSeek  x  QQ    重载配置' -ForegroundColor Cyan
  Write-Host '  ==============================================================' -ForegroundColor Cyan
  Write-Host ("        {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
}

# ---------------- 1. 现在的状态 ----------------
Step '1/5' '当前配置'
$envTime = (Get-Item $ENVFILE).LastWriteTime
Say ("  .env        最后修改 {0}" -f $envTime)
$personaFiles = @()
if (Test-Path $PERSONAS) {
  $personaFiles = @(Get-ChildItem $PERSONAS -File -Filter '*.json' |
    Where-Object { -not $_.Name.StartsWith('_') })
}
Say ("  personas/   {0} 个可用人格{1}" -f $personaFiles.Count,
  $(if ($personaFiles.Count) { "：" + (($personaFiles | ForEach-Object { $_.BaseName }) -join '、') } else { '（只有模板，机器人会走 .env 里的单一人设）' }))

$before = @(Get-Bot)
Say ("  机器人      当前 {0} 个{1}" -f $before.Count,
  $(if ($before.Count) { "（PID " + (($before | ForEach-Object { $_.ProcessId }) -join ',') + "）" } else { '' }))

# ---------------- 2. 检查后端 ----------------
Step '2/5' 'OneBot / NapCat 状态'
$onebotUp = Test-OneBot
if ($onebotUp) {
  Say '  OneBot 端口 3000/3001  监听中' 'Green'
} else {
  Say '  端口 3000/3001 未监听 —— 机器人起来后连不上，会一直重连。' 'Red'
  Say '  重新注入 NapCat 需要管理员权限，请改用桌面「启动 DeepSeek QQ 机器人」快捷方式。' 'Red'
}

# ---------------- 3. 停 ----------------
Step '3/5' '停止当前机器人'
if (-not $before.Count) {
  Say '  没有在运行，跳过'
} else {
  foreach ($p in $before) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    Say ("  已停 PID {0}" -f $p.ProcessId)
  }
  # 等端口锁（127.0.0.1:39999）释放
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 300
    if (-not (Get-NetTCPConnection -State Listen -LocalPort 39999 -ErrorAction SilentlyContinue)) { break }
  }
}

# ---------------- 4. 起 ----------------
Step '4/5' '启动（重新读取 .env 与 personas/）'
Remove-Item $BOTLOG, "$BOTLOG.err" -ErrorAction SilentlyContinue
try {
  Start-Process -FilePath $NODE -ArgumentList @("`"$CLI`"") -WorkingDirectory $ROOT `
    -WindowStyle Hidden -RedirectStandardOutput $BOTLOG -RedirectStandardError "$BOTLOG.err" -ErrorAction Stop
} catch {
  Write-Host "  ✗ 启动失败：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
Say '  已发出启动命令'

# ---------------- 5. 等连接 ----------------
Step '5/5' "等待事件通道连接（最多 ${WaitSec}s）"
$connected = $false
for ($i = 1; $i -le $WaitSec; $i++) {
  Start-Sleep -Seconds 1
  $ws = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
    Where-Object { $_.RemotePort -eq 3001 })
  if ($ws.Count -gt 0) { $connected = $true; break }
  if ($i % 5 -eq 0) { Say ("  等待中… {0}s" -f $i) }
}

$after = @(Get-Bot)
if (-not $Quiet -and (Test-Path $BOTLOG)) {
  Write-Host ''
  Write-Host '  --- 启动日志 ---' -ForegroundColor DarkGray
  Get-Content $BOTLOG -Encoding UTF8 | Select-Object -Last 8 |
    ForEach-Object { Write-Host ("  " + $_.Trim()) -ForegroundColor DarkGray }
  if (Test-Path "$BOTLOG.err") {
    $e = Get-Content "$BOTLOG.err" -Raw
    if ($e) {
      Write-Host '  --- stderr ---' -ForegroundColor DarkGray
      Write-Host ("  " + $e.Trim()) -ForegroundColor DarkGray
    }
  }
}

# ---------------- 汇总 ----------------
Write-Host ''
Write-Host '  ==============================================================' -ForegroundColor Cyan
if ($after.Count -eq 0) {
  Write-Host '   重载失败：进程没有起来' -ForegroundColor Red
  Write-Host ("   去看日志：{0}" -f $BOTLOG) -ForegroundColor Red
} elseif (-not $connected) {
  Write-Host ("   机器人已启动（PID {0}），但事件通道还没连上" -f (($after | ForEach-Object { $_.ProcessId }) -join ',')) -ForegroundColor Yellow
  if (-not $onebotUp) {
    Write-Host '   原因很可能是 NapCat 没在跑 —— 请双击桌面启动快捷方式。' -ForegroundColor Yellow
  } else {
    Write-Host '   再等一会通常会自动连上（重连退避最长 30s）。' -ForegroundColor Yellow
  }
} else {
  Write-Host ("   重载完成  机器人 PID {0}   事件通道已连接" -f (($after | ForEach-Object { $_.ProcessId }) -join ',')) -ForegroundColor Green
  if ($personaFiles.Count -gt 0) {
    Write-Host '   会话上下文已保留（PERSIST_SESSIONS）；人格选择也还记得。' -ForegroundColor Green
  }
}
Write-Host '  ==============================================================' -ForegroundColor Cyan
Write-Host ''
