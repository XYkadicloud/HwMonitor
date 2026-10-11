# HwMonitor hardware sampler.
#
# Runs as a long-lived child process of the Node server and writes one compact
# JSON object per line to stdout. A resident process is essential here: creating
# PerformanceCounter objects costs ~1.6s on this class of machine, while
# reusing them costs 4-42ms per sample. Cold start is paid once, at launch.
#
# Design notes:
#  - All output goes through Write-Output of a single-line JSON string, so the
#    parent can parse line-by-line without any framing protocol.
#  - Per-counter errors are caught individually: a machine missing GPU or
#    thermal counters must still report everything else.
#  - Nothing here writes to disk, so a 1s cadence costs no I/O.

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:IntervalMs = 1000
if ($env:HWM_INTERVAL_MS) {
  $parsed = 0
  if ([int]::TryParse($env:HWM_INTERVAL_MS, [ref]$parsed) -and $parsed -ge 250) { $script:IntervalMs = $parsed }
}

function Write-Sample {
  param($Obj)
  # Depth 4 covers the deepest structure emitted (sample.gpu / sample.cpu.cores).
  # Lower depth measurably reduces ConvertTo-Json cost, which was ~35ms per
  # sample at depth 6 on the test machine.
  Write-Output ($Obj | ConvertTo-Json -Compress -Depth 4)
}

function New-Pc {
  <#  Create a PerformanceCounter, tolerating absence of the category. #>
  param([string]$Category, [string]$Counter, [string]$Instance)
  try {
    if ($Instance) {
      return New-Object System.Diagnostics.PerformanceCounter -ArgumentList $Category, $Counter, $Instance, $true
    }
    return New-Object System.Diagnostics.PerformanceCounter -ArgumentList $Category, $Counter, $true
  } catch {
    return $null
  }
}

function Get-PcValue {
  param($Counter)
  if ($null -eq $Counter) { return $null }
  try { return $Counter.NextValue() } catch { return $null }
}

# ---------------------------------------------------------------- static info
# Static identity is read from the registry where possible. On this class of
# machine the first WMI query costs ~1.5s (provider warm-up) and subsequent ones
# ~105ms, while registry reads cost single-digit milliseconds. WMI is still used
# for the values the registry does not carry.
$staticInfo = [ordered]@{}

try {
  $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
  $staticInfo.osName = $cv.ProductName
  $staticInfo.osDisplayVersion = $cv.DisplayVersion
  $staticInfo.osBuild = "$($cv.CurrentBuild).$($cv.UBR)"
  $staticInfo.osVersion = "$($cv.CurrentBuild).$($cv.UBR)"
} catch {}

try {
  $cpuKey = Get-ItemProperty 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0' -ErrorAction Stop
  $staticInfo.cpuName = "$($cpuKey.ProcessorNameString)".Trim()
  if ($cpuKey.'~MHz') { $staticInfo.cpuMaxMhz = [int]$cpuKey.'~MHz' }
} catch {}

# WMI fills in the rest (memory total, model, exact core counts).
try {
  $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
  $staticInfo.computerName = $cs.Name
  $staticInfo.manufacturer = "$($cs.Manufacturer)".Trim()
  $staticInfo.model = "$($cs.Model)".Trim()
  $staticInfo.totalPhysicalBytes = [double]$cs.TotalPhysicalMemory
  $staticInfo.totalMemoryBytes = [double]$cs.TotalPhysicalMemory
} catch {}

try {
  $cpu = Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1
  if (-not $staticInfo.cpuName) { $staticInfo.cpuName = "$($cpu.Name)".Trim() }
  $staticInfo.cpuCores = [int]$cpu.NumberOfCores
  $staticInfo.cpuThreads = [int]$cpu.NumberOfLogicalProcessors
  if (-not $staticInfo.cpuMaxMhz) { $staticInfo.cpuMaxMhz = [int]$cpu.MaxClockSpeed }
} catch {}

try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  if (-not $staticInfo.osName) { $staticInfo.osName = $os.Caption }
  if (-not $staticInfo.totalMemoryBytes) { $staticInfo.totalMemoryBytes = [double]$os.TotalVisibleMemorySize * 1024 }
  # Captured once; the emit loop derives uptime arithmetically instead of
  # re-querying WMI every second.
  try { $script:BootTime = $os.LastBootUpTime } catch { $script:BootTime = $null }
} catch {}

# Fall back to a tick-count derived boot time if WMI did not supply one. This is
# accurate to the second for uptime display purposes.
if (-not $script:BootTime) {
  try { $script:BootTime = (Get-Date) - [TimeSpan]::FromMilliseconds([Environment]::TickCount64) } catch {}
}

# Logical processor count is available without WMI.
if (-not $staticInfo.cpuThreads -and $env:NUMBER_OF_PROCESSORS) {
  $staticInfo.cpuThreads = [int]$env:NUMBER_OF_PROCESSORS
}

$script:CoreCount = 1
if ($staticInfo.cpuThreads -and $staticInfo.cpuThreads -gt 0) { $script:CoreCount = [int]$staticInfo.cpuThreads }

# -------------------------------------------------------------- battery static
$batteryStatic = [ordered]@{ present = $false }
try {
  $batt = Get-CimInstance Win32_Battery -ErrorAction Stop | Select-Object -First 1
  if ($batt) {
    $batteryStatic.present = $true
    $batteryStatic.name = $batt.Name
    $batteryStatic.chemistry = $batt.Chemistry
    $batteryStatic.designVoltageMv = [int]$batt.DesignVoltage
  }
} catch {}

# Design capacity is not exposed by Win32_Battery; the ACPI classes carry it.
foreach ($cls in 'BatteryStaticData', 'BatteryFullChargedCapacity') {
  try {
    $o = Get-CimInstance -Namespace root/wmi -ClassName $cls -ErrorAction Stop | Select-Object -First 1
    if ($cls -eq 'BatteryStaticData' -and $o) {
      if ($o.DesignedCapacity) { $batteryStatic.designCapacityMwh = [int]$o.DesignedCapacity }
      if ($o.ManufactureName) { $batteryStatic.manufacturer = "$($o.ManufactureName)".Trim() }
      if ($o.DeviceName) { $batteryStatic.deviceName = "$($o.DeviceName)".Trim() }
      if ($o.CycleCount) { $batteryStatic.cycleCount = [int]$o.CycleCount }
    }
    if ($cls -eq 'BatteryFullChargedCapacity' -and $o) {
      if ($o.FullChargedCapacity) { $batteryStatic.fullChargeCapacityMwh = [int]$o.FullChargedCapacity }
    }
  } catch {}
}

# BatteryStaticData frequently fails on consumer hardware; fall back to the
# battery report, which the firmware populates even when the WMI class is absent.
# powercfg costs ~1.1s, so the result is cached to disk and reused across
# restarts; capacity values drift only over months of battery wear.
$cachePath = Join-Path $PSScriptRoot '..\data\battery-static.json'
$needReport = (-not $batteryStatic.designCapacityMwh) -or (-not $batteryStatic.fullChargeCapacityMwh)
if ($needReport -and (Test-Path $cachePath)) {
  try {
    $cached = Get-Content $cachePath -Raw | ConvertFrom-Json
    if (-not $batteryStatic.designCapacityMwh -and $cached.designCapacityMwh) { $batteryStatic.designCapacityMwh = [int]$cached.designCapacityMwh }
    if (-not $batteryStatic.fullChargeCapacityMwh -and $cached.fullChargeCapacityMwh) { $batteryStatic.fullChargeCapacityMwh = [int]$cached.fullChargeCapacityMwh }
    if (-not $batteryStatic.cycleCount -and $cached.cycleCount) { $batteryStatic.cycleCount = [int]$cached.cycleCount }
    if (-not $batteryStatic.manufacturer -and $cached.manufacturer) { $batteryStatic.manufacturer = "$($cached.manufacturer)" }
    $needReport = (-not $batteryStatic.designCapacityMwh) -or (-not $batteryStatic.fullChargeCapacityMwh)
  } catch {}
}

if ($needReport) {
  try {
    $tmp = Join-Path $env:TEMP ("hwm-batt-" + [guid]::NewGuid().ToString('N') + ".html")
    $null = & powercfg /batteryreport /output $tmp /duration 1 2>&1
    if (Test-Path $tmp) {
      $html = Get-Content $tmp -Raw
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
      $text = [regex]::Replace($html, '<[^>]+>', '|')
      if (-not $batteryStatic.designCapacityMwh) {
        # The HTML leaves runs of empty cells, so allow one or more pipes.
        $m = [regex]::Match($text, 'DESIGN CAPACITY\s*\|+\s*([\d,]+)\s*mWh')
        if ($m.Success) { $batteryStatic.designCapacityMwh = [int]($m.Groups[1].Value -replace ',', '') }
      }
      if (-not $batteryStatic.fullChargeCapacityMwh) {
        $m = [regex]::Match($text, 'FULL CHARGE CAPACITY\s*\|+\s*([\d,]+)\s*mWh')
        if ($m.Success) { $batteryStatic.fullChargeCapacityMwh = [int]($m.Groups[1].Value -replace ',', '') }
      }
      if (-not $batteryStatic.cycleCount) {
        $m = [regex]::Match($text, 'CYCLE COUNT\s*\|+\s*([\d,]+)')
        if ($m.Success) { $batteryStatic.cycleCount = [int]($m.Groups[1].Value -replace ',', '') }
      }
      if (-not $batteryStatic.manufacturer) {
        $m = [regex]::Match($text, 'MANUFACTURER\s*\|+\s*([^|]+)')
        if ($m.Success) { $batteryStatic.manufacturer = $m.Groups[1].Value.Trim() }
      }

      if ($batteryStatic.designCapacityMwh -or $batteryStatic.fullChargeCapacityMwh) {
        try {
          $cacheDir = Split-Path $cachePath -Parent
          if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null }
          [ordered]@{
            designCapacityMwh = $batteryStatic.designCapacityMwh
            fullChargeCapacityMwh = $batteryStatic.fullChargeCapacityMwh
            cycleCount = $batteryStatic.cycleCount
            manufacturer = $batteryStatic.manufacturer
            cachedAt = (Get-Date).ToString('o')
          } | ConvertTo-Json | Set-Content -Path $cachePath -Encoding UTF8
        } catch {}
      }
    }
  } catch {}
}

if ($batteryStatic.designCapacityMwh -and $batteryStatic.designCapacityMwh -gt 0 -and $batteryStatic.fullChargeCapacityMwh) {
  $batteryStatic.healthPct = [math]::Round(100.0 * $batteryStatic.fullChargeCapacityMwh / $batteryStatic.designCapacityMwh, 1)
}

# ------------------------------------------------------------- disk inventory
# Get-PhysicalDisk costs ~6.8s on this hardware, which would dominate startup.
# Physical disk inventory changes only when hardware is added or removed, so it
# is cached to disk and reused; a stale cache is refreshed in the background
# after the first sample has already been emitted.
$diskCachePath = Join-Path $PSScriptRoot '..\data\disks-cache.json'
$diskInventory = @()
$diskCacheFresh = $false
if (Test-Path $diskCachePath) {
  try {
    $cachedDisks = Get-Content $diskCachePath -Raw | ConvertFrom-Json
    $ageHours = ((Get-Date) - [datetime]$cachedDisks.cachedAt).TotalHours
    if ($ageHours -lt 24 -and $cachedDisks.disks) {
      $diskInventory = @($cachedDisks.disks)
      $diskCacheFresh = $true
    }
  } catch {}
}

if (-not $diskCacheFresh) {
  try {
    $pd = Get-PhysicalDisk -ErrorAction Stop
    foreach ($d in $pd) {
      $diskInventory += [ordered]@{
        name = "$($d.FriendlyName)".Trim()
        mediaType = "$($d.MediaType)"
        sizeBytes = [double]$d.Size
        health = "$($d.HealthStatus)"
        status = "$($d.OperationalStatus)"
        busType = "$($d.BusType)"
      }
    }
    if ($diskInventory.Count -gt 0) {
      try {
        $cacheDir = Split-Path $diskCachePath -Parent
        if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null }
        [ordered]@{ cachedAt = (Get-Date).ToString('o'); disks = $diskInventory } |
          ConvertTo-Json -Depth 5 | Set-Content -Path $diskCachePath -Encoding UTF8
      } catch {}
    }
  } catch {}
}

# ------------------------------------------------------------- counter objects
# Every counter is optional; nulls are reported as "unsupported" by the UI.
$cCpuTotal   = New-Pc 'Processor Information' '% Processor Time' '_Total'
$cCpuUser    = New-Pc 'Processor Information' '% User Time' '_Total'
$cCpuPriv    = New-Pc 'Processor Information' '% Privileged Time' '_Total'
$cCpuFreq    = New-Pc 'Processor Information' '% Processor Performance' '_Total'
$cMemAvail   = New-Pc 'Memory' 'Available MBytes' $null
$cMemCommit  = New-Pc 'Memory' 'Committed Bytes' $null
$cMemLimit   = New-Pc 'Memory' 'Commit Limit' $null
$cMemCache   = New-Pc 'Memory' 'Cache Bytes' $null
$cMemPages   = New-Pc 'Memory' 'Pages/sec' $null
$cDiskRead   = New-Pc 'PhysicalDisk' 'Disk Read Bytes/sec' '_Total'
$cDiskWrite  = New-Pc 'PhysicalDisk' 'Disk Write Bytes/sec' '_Total'
$cDiskBusy   = New-Pc 'PhysicalDisk' '% Disk Time' '_Total'
$cDiskQ      = New-Pc 'PhysicalDisk' 'Current Disk Queue Length' '_Total'
$cSysQueue   = New-Pc 'System' 'Processor Queue Length' $null
$cSysCtx     = New-Pc 'System' 'Context Switches/sec' $null
$cSysProc    = New-Pc 'System' 'Processes' $null
$cSysThread  = New-Pc 'System' 'Threads' $null

# Per-core CPU. Instance names are "0,0","0,1",... for cores, plus "_Total" and
# a "0,_Total" group aggregate. Only real core instances are kept, so the UI
# does not show a duplicate aggregate row.
$coreCounters = @()
try {
  $cpuCat = New-Object System.Diagnostics.PerformanceCounterCategory('Processor Information')
  foreach ($inst in $cpuCat.GetInstanceNames()) {
    if ($inst -like '*_Total*') { continue }
    $c = New-Pc 'Processor Information' '% Processor Time' $inst
    if ($c) { $coreCounters += [pscustomobject]@{ name = $inst; counter = $c } }
  }
} catch {}

# Network counters are per-adapter; aggregate across all of them.
$netCounters = @()
try {
  $netCat = New-Object System.Diagnostics.PerformanceCounterCategory('Network Interface')
  foreach ($inst in $netCat.GetInstanceNames()) {
    $rx = New-Pc 'Network Interface' 'Bytes Received/sec' $inst
    $tx = New-Pc 'Network Interface' 'Bytes Sent/sec' $inst
    if ($rx -and $tx) {
      $netCounters += [pscustomobject]@{ name = $inst; rx = $rx; tx = $tx }
    }
  }
} catch {}

# GPU Engine exposes one instance per (process, engine) pair. Instances come and
# go as processes start and exit, so the list is refreshed periodically rather
# than cached forever. We only need the busiest engine to report a usable number.
#
# Polling every engine costs ~70ms per pass on this hardware (72 instances), so
# GPU is sampled on a slower cadence than the rest of the metrics and the last
# reading is carried between passes. GPU load changes far more slowly than CPU,
# so a 3s effective cadence is not a meaningful loss of fidelity.
$script:GpuCounters = @()
$script:GpuRefreshAt = 0
$script:GpuSampleEvery = 3
function Update-GpuCounters {
  $script:GpuCounters = @()
  try {
    $cat = New-Object System.Diagnostics.PerformanceCounterCategory('GPU Engine')
    foreach ($inst in $cat.GetInstanceNames()) {
      $c = New-Pc 'GPU Engine' 'Utilization Percentage' $inst
      if ($c) {
        $null = $c.NextValue()
        $script:GpuCounters += [pscustomobject]@{ name = $inst; counter = $c }
      }
    }
  } catch {}
  $script:GpuRefreshAt = (Get-Date).AddSeconds(20)
}
Update-GpuCounters

# Thermal Zone Information exists on many systems but not all; absent is fine.
$thermalCounters = @()
try {
  $tcat = New-Object System.Diagnostics.PerformanceCounterCategory('Thermal Zone Information')
  foreach ($inst in $tcat.GetInstanceNames()) {
    $c = New-Pc 'Thermal Zone Information' 'Temperature' $inst
    if ($c) {
      $null = $c.NextValue()
      $thermalCounters += [pscustomobject]@{ name = $inst; counter = $c }
    }
  }
} catch {}

# --------------------------------------------------------- WMI query handles
# Persistent searchers avoid re-parsing queries on every sample (~180ms -> ~19ms).
$scope = $null
try {
  $scope = New-Object System.Management.ManagementScope('\\.\root\cimv2')
  $scope.Connect()
} catch {}

$scopeWmi = $null
try {
  $scopeWmi = New-Object System.Management.ManagementScope('\\.\root\wmi')
  $scopeWmi.Connect()
} catch {}

function New-Searcher {
  param($Scope, [string]$Query)
  if ($null -eq $Scope) { return $null }
  try {
    $q = New-Object System.Management.ObjectQuery($Query)
    return New-Object System.Management.ManagementObjectSearcher($Scope, $q)
  } catch { return $null }
}

$sVolumes = New-Searcher $scope 'SELECT DeviceID,VolumeName,FileSystem,Size,FreeSpace FROM Win32_LogicalDisk WHERE DriveType=3'
$sBattery = New-Searcher $scopeWmi 'SELECT RemainingCapacity,Voltage,DischargeRate,ChargeRate,Charging,Discharging,PowerOnline FROM BatteryStatus'

# --------------------------------------------------------------- process CPU
# Process CPU is derived from TotalProcessorTime deltas between samples.
# [System.Diagnostics.Process]::GetProcesses() is used instead of Get-Process:
# on this class of machine Get-Process costs ~180ms while GetProcesses costs
# ~8ms, and that overhead was itself inflating the CPU percentage we report.
$script:PrevProc = @{}
$script:PrevProcAt = $null

function Get-TopProcesses {
  param([int]$Top = 8)
  $now = Get-Date
  $cur = @{}
  $snap = @()

  # A single guarded pass collects Id + TotalProcessorTime. Accessing properties
  # on a process that exits mid-enumeration throws, so each item is guarded once
  # here instead of repeatedly in the comparison loop below; that cut this
  # section from ~525ms to ~110ms on the test machine.
  foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
    try {
      if ($p.HasExited) { continue }
      $id = $p.Id
      $cur[$id] = $p.TotalProcessorTime.TotalMilliseconds
      $snap += [pscustomobject]@{ p = $p; id = $id }
    } catch {}
  }

  $out = @()
  $dshOut = @()
  if ($script:PrevProcAt) {
    $elapsedMs = ($now - $script:PrevProcAt).TotalMilliseconds
    if ($elapsedMs -gt 50) {
      foreach ($s in $snap) {
        if (-not $script:PrevProc.ContainsKey($s.id)) { continue }
        $delta = $cur[$s.id] - $script:PrevProc[$s.id]
        if ($delta -lt 0) { continue }
        $pct = 100.0 * $delta / $elapsedMs / $script:CoreCount
        if ($pct -le 0.05) { continue }
        # ProcessName/WorkingSet64 can throw if the process exits right now.
        try {
          $out += [ordered]@{
            pid = $s.id
            name = $s.p.ProcessName
            cpuPct = [math]::Round($pct, 2)
            memMb = [math]::Round($s.p.WorkingSet64 / 1MB, 1)
          }
        } catch {}
      }
    }
  }

  # DSH process accounting. The DSH host runs as node.exe, and each subagent or
  # sandbox runs its own node child, so node processes are reported with their
  # command line so the UI can label their role.
  #
  # Command lines are fetched with ONE batched WMI query and cached per PID.
  # Querying Win32_Process per process was measurably disastrous here: five
  # separate WMI queries per sample pushed sampling cost to ~2.5s (above the
  # interval itself). A process's command line never changes after it starts, so
  # the cache only needs to grow as new PIDs appear.
  if (-not $script:CmdLineCache) { $script:CmdLineCache = @{} }
  if (-not $script:CmdLineCacheAt) { $script:CmdLineCacheAt = [datetime]::MinValue }

  $nodePids = @()
  foreach ($s in $snap) {
    try {
      if ($s.p.ProcessName -eq 'node' -or $s.p.ProcessName -eq 'dsh') { $nodePids += $s.id }
    } catch {}
  }

  # Refresh the cache when new node PIDs appear, or every 60s to drop dead ones.
  $needRefresh = ((Get-Date) - $script:CmdLineCacheAt).TotalSeconds -gt 60
  if (-not $needRefresh) {
    foreach ($id in $nodePids) { if (-not $script:CmdLineCache.ContainsKey($id)) { $needRefresh = $true; break } }
  }
  if ($needRefresh) {
    $fresh = @{}
    try {
      foreach ($w in Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='dsh.exe'" -ErrorAction SilentlyContinue) {
        try { $fresh[[int]$w.ProcessId] = "$($w.CommandLine)" } catch {}
      }
      $script:CmdLineCache = $fresh
      $script:CmdLineCacheAt = Get-Date
    } catch {}
  }

  foreach ($s in $snap) {
    try {
      if ($s.p.ProcessName -ne 'node' -and $s.p.ProcessName -ne 'dsh') { continue }
      $cpuPct = 0.0
      if ($script:PrevProc.ContainsKey($s.id) -and $script:PrevProcAt) {
        $delta = $cur[$s.id] - $script:PrevProc[$s.id]
        $elapsedMs2 = ($now - $script:PrevProcAt).TotalMilliseconds
        if ($delta -ge 0 -and $elapsedMs2 -gt 50) { $cpuPct = [math]::Round(100.0 * $delta / $elapsedMs2 / $script:CoreCount, 2) }
      }

      $cmd = ''
      if ($script:CmdLineCache.ContainsKey($s.id)) { $cmd = $script:CmdLineCache[$s.id] }

      $role = 'node'
      if ($cmd -match 'dsh\\lib\\bin\.js' -or $cmd -match 'dsh/lib/bin\.js') { $role = 'dsh-host' }
      elseif ($cmd -match 'dsh-subprocess-local') { $role = 'subagent' }
      elseif ($cmd -match 'dsh-sandbox-windows-acl') { $role = 'sandbox' }
      elseif ($cmd -match 'dsh\\lib\\' -or $cmd -match 'dsh/lib/') { $role = 'dsh-other' }

      $dshOut += [ordered]@{
        pid = $s.id
        role = $role
        cpuPct = $cpuPct
        memMb = [math]::Round($s.p.WorkingSet64 / 1MB, 1)
        startedAt = $(try { ([DateTimeOffset]$s.p.StartTime).ToUnixTimeMilliseconds() } catch { $null })
        commandLine = if ($cmd.Length -gt 300) { $cmd.Substring(0, 300) } else { $cmd }
      }
    } catch {}
  }

  $script:PrevProc = $cur
  $script:PrevProcAt = $now
  $script:LastDshProcs = @($dshOut)
  return @($out | Sort-Object { -$_.cpuPct } | Select-Object -First $Top)
}

# ------------------------------------------------------------------- emit loop
Write-Sample ([ordered]@{
  kind = 'hello'
  intervalMs = $script:IntervalMs
  static = $staticInfo
  batteryStatic = $batteryStatic
  disks = $diskInventory
  capabilities = [ordered]@{
    cpu = ($null -ne $cCpuTotal)
    memory = ($null -ne $cMemAvail)
    disk = ($null -ne $cDiskRead)
    network = ($netCounters.Count -gt 0)
    gpu = ($script:GpuCounters.Count -gt 0)
    thermal = ($thermalCounters.Count -gt 0)
    battery = ($null -ne $sBattery)
  }
  pid = $PID
})

# Prime rate-based counters, then let one interval elapse so the first emitted
# sample carries real deltas instead of zeros.
foreach ($c in @($cCpuTotal, $cCpuUser, $cCpuPriv, $cCpuFreq, $cMemPages, $cDiskRead, $cDiskWrite, $cDiskBusy, $cDiskQ, $cSysCtx)) {
  if ($c) { $null = Get-PcValue $c }
}
foreach ($cc in $coreCounters) { $null = Get-PcValue $cc.counter }
foreach ($nc in $netCounters) { $null = Get-PcValue $nc.rx; $null = Get-PcValue $nc.tx }
$null = Get-TopProcesses 1
Start-Sleep -Milliseconds $script:IntervalMs

$seq = 0
while ($true) {
  $loopStart = Get-Date
  $seq++
  $sample = [ordered]@{ kind = 'sample'; seq = $seq; t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

  # --- CPU
  try {
    $cpu = [ordered]@{}
    $v = Get-PcValue $cCpuTotal
    if ($null -ne $v) { $cpu.totalPct = [math]::Round($v, 1) }
    $v = Get-PcValue $cCpuUser
    if ($null -ne $v) { $cpu.userPct = [math]::Round($v, 1) }
    $v = Get-PcValue $cCpuPriv
    if ($null -ne $v) { $cpu.privilegedPct = [math]::Round($v, 1) }
    # "% Processor Performance" is relative to nominal clock; multiply to get
    # an approximate current MHz. Capped at 200% to reject nonsense readings.
    $v = Get-PcValue $cCpuFreq
    if ($null -ne $v -and $staticInfo.cpuMaxMhz) {
      $mhz = [math]::Min(200.0, [math]::Max(0.0, $v)) / 100.0 * $staticInfo.cpuMaxMhz
      $cpu.currentMhz = [int][math]::Round($mhz)
    }
    $cores = @()
    foreach ($cc in $coreCounters) {
      $cv = Get-PcValue $cc.counter
      if ($null -ne $cv) { $cores += [ordered]@{ name = $cc.name; pct = [math]::Round($cv, 1) } }
    }
    $cpu.cores = $cores
    $sample.cpu = $cpu
  } catch {}

  # --- Memory
  try {
    $mem = [ordered]@{}
    $avail = Get-PcValue $cMemAvail
    if ($null -ne $avail) {
      $mem.availableBytes = [double]$avail * 1MB
      $total = $staticInfo.totalMemoryBytes
      if ($total -and $total -gt 0) {
        $mem.usedBytes = [double]($total - $mem.availableBytes)
        $mem.usedPct = [math]::Round(100.0 * $mem.usedBytes / $total, 1)
      }
    }
    $v = Get-PcValue $cMemCommit
    if ($null -ne $v) { $mem.committedBytes = [double]$v }
    $v = Get-PcValue $cMemLimit
    if ($null -ne $v) { $mem.commitLimitBytes = [double]$v }
    $v = Get-PcValue $cMemCache
    if ($null -ne $v) { $mem.cacheBytes = [double]$v }
    $v = Get-PcValue $cMemPages
    if ($null -ne $v) { $mem.pagesPerSec = [math]::Round($v, 1) }
    if ($staticInfo.totalMemoryBytes) { $mem.totalBytes = $staticInfo.totalMemoryBytes }
    $sample.memory = $mem
  } catch {}

  # --- Battery and power
  # DischargeRate/ChargeRate are the only true whole-system power figures the
  # firmware exposes; everything else about power on this class of machine is an
  # estimate and is labelled as such in the UI.
  try {
    if ($sBattery) {
      $bat = [ordered]@{}
      foreach ($o in $sBattery.Get()) {
        $bat.present = $true
        $rem = $o['RemainingCapacity']
        $volt = $o['Voltage']
        $dis = $o['DischargeRate']
        $chg = $o['ChargeRate']
        if ($null -ne $rem) { $bat.remainingMwh = [int]$rem }
        if ($null -ne $volt) { $bat.voltageMv = [int]$volt }
        if ($null -ne $dis) { $bat.dischargeMw = [int]$dis }
        if ($null -ne $chg) { $bat.chargeMw = [int]$chg }
        try { $bat.charging = [bool]$o['Charging'] } catch {}
        try { $bat.discharging = [bool]$o['Discharging'] } catch {}
        try { $bat.acOnline = [bool]$o['PowerOnline'] } catch {}
        break
      }
      if ($bat.present) {
        $full = $batteryStatic.fullChargeCapacityMwh
        $design = $batteryStatic.designCapacityMwh
        if ($bat.remainingMwh -and $full -and $full -gt 0) {
          $bat.percent = [math]::Round(100.0 * $bat.remainingMwh / $full, 1)
          $bat.fullChargeCapacityMwh = $full
        }
        if ($design) { $bat.designCapacityMwh = $design }
        # Runtime estimate only makes sense while actually discharging.
        if ($bat.discharging -and $bat.dischargeMw -and $bat.dischargeMw -gt 0 -and $bat.remainingMwh) {
          $bat.runtimeMinutes = [math]::Round(60.0 * $bat.remainingMwh / $bat.dischargeMw, 1)
        }
        if ($bat.charging -and $bat.chargeMw -and $bat.chargeMw -gt 0 -and $full -and $bat.remainingMwh) {
          $bat.minutesToFull = [math]::Round(60.0 * ($full - $bat.remainingMwh) / $bat.chargeMw, 1)
        }

        # --- Explicit power reading -----------------------------------------
        # A single unambiguous "what is the machine doing with power right now"
        # value, so consumers never have to re-derive it from charging flags.
        # While charging, the battery's ChargeRate is the input power going in;
        # while discharging, DischargeRate is the whole-system draw.
        # Only ASCII is emitted here; display strings are localised in the JS layer.
        # Windows PowerShell 5.1 decodes .ps1 contents with the system ANSI codepage
        # unless a UTF-8 BOM is present, so non-ASCII literals in this file are a
        # latent parse-time hazard.
        $power = [ordered]@{}
        if ($bat.charging -and $bat.chargeMw -gt 0) {
          $power.mode = 'charging'
          $power.watts = [math]::Round($bat.chargeMw / 1000.0, 2)
          $power.source = 'battery-charge-rate'
          $power.rawMw = $bat.chargeMw
        } elseif ($bat.discharging -and $bat.dischargeMw -gt 0) {
          $power.mode = 'discharging'
          $power.watts = [math]::Round($bat.dischargeMw / 1000.0, 2)
          $power.source = 'battery-discharge-rate'
          $power.rawMw = $bat.dischargeMw
        } elseif ($bat.acOnline) {
          # Plugged in but the battery reports neither charge nor discharge
          # current: typically full or in trickle/maintenance mode. Reporting 0 W
          # here would be misleading, so the state is named instead.
          $power.mode = 'ac-idle'
          $power.watts = 0
          $power.source = 'battery-flags'
          $power.rawMw = 0
        } else {
          $power.mode = 'unknown'
          $power.watts = $null
          $power.source = 'none'
          $power.rawMw = $null
        }
        $bat.power = $power
        $sample.power = $power
      } else {
        $bat.present = $false
        $sample.power = [ordered]@{ mode = 'none'; watts = $null; source = 'none'; rawMw = $null }
      }
      $sample.battery = $bat
    }
  } catch {}

  # --- Disks (volumes + throughput)
  try {
    $disks = @()
    if ($sVolumes) {
      foreach ($o in $sVolumes.Get()) {
        $size = 0; $free = 0
        try { $size = [double]$o['Size'] } catch {}
        try { $free = [double]$o['FreeSpace'] } catch {}
        if ($size -le 0) { continue }
        $disks += [ordered]@{
          id = "$($o['DeviceID'])"
          label = "$($o['VolumeName'])"
          fs = "$($o['FileSystem'])"
          sizeBytes = $size
          freeBytes = $free
          usedBytes = [double]($size - $free)
          usedPct = [math]::Round(100.0 * ($size - $free) / $size, 1)
          freePct = [math]::Round(100.0 * $free / $size, 1)
        }
      }
    }
    $sample.volumes = $disks

    $io = [ordered]@{}
    $v = Get-PcValue $cDiskRead
    if ($null -ne $v) { $io.readBytesPerSec = [math]::Round($v, 0) }
    $v = Get-PcValue $cDiskWrite
    if ($null -ne $v) { $io.writeBytesPerSec = [math]::Round($v, 0) }
    $v = Get-PcValue $cDiskBusy
    if ($null -ne $v) { $io.busyPct = [math]::Round([math]::Min(100.0, $v), 1) }
    $v = Get-PcValue $cDiskQ
    if ($null -ne $v) { $io.queueLength = [math]::Round($v, 2) }
    $sample.diskIo = $io
  } catch {}

  # --- Network
  try {
    $rxTotal = 0.0; $txTotal = 0.0; $adapters = @()
    foreach ($nc in $netCounters) {
      $rx = Get-PcValue $nc.rx
      $tx = Get-PcValue $nc.tx
      if ($null -eq $rx -or $null -eq $tx) { continue }
      $rxTotal += $rx; $txTotal += $tx
      if ($rx -gt 0 -or $tx -gt 0) {
        $adapters += [ordered]@{
          name = $nc.name
          rxBytesPerSec = [math]::Round($rx, 0)
          txBytesPerSec = [math]::Round($tx, 0)
        }
      }
    }
    $sample.network = [ordered]@{
      rxBytesPerSec = [math]::Round($rxTotal, 0)
      txBytesPerSec = [math]::Round($txTotal, 0)
      adapters = $adapters
    }
  } catch {}

  # --- GPU
  # Sampled on a slower cadence than the rest (see GpuSampleEvery); the previous
  # reading is reused in between, with gpu.sampled flagging freshness.
  try {
    if ((Get-Date) -gt $script:GpuRefreshAt) { Update-GpuCounters }
    if (-not $script:GpuNextPoll) { $script:GpuNextPoll = 0 }
    if ($seq -ge $script:GpuNextPoll) {
      $script:GpuNextPoll = $seq + $script:GpuSampleEvery
      $gpuPct = 0.0
      $gpuTop = $null
      foreach ($g in $script:GpuCounters) {
        $v = Get-PcValue $g.counter
        if ($null -eq $v) { continue }
        if ($v -gt $gpuPct) { $gpuPct = $v; $gpuTop = $g.name }
      }
      $script:GpuLast = [ordered]@{
        maxEnginePct = [math]::Round($gpuPct, 1)
        topEngine = $gpuTop
      }
      $script:GpuSampledAt = $seq
    }
    if ($script:GpuLast) {
      $sample.gpu = [ordered]@{
        supported = $true
        maxEnginePct = $script:GpuLast.maxEnginePct
        topEngine = $script:GpuLast.topEngine
        engineCount = $script:GpuCounters.Count
        sampled = ($script:GpuSampledAt -eq $seq)
        sampledAtSeq = $script:GpuSampledAt
      }
    } else {
      $sample.gpu = [ordered]@{ supported = ($script:GpuCounters.Count -gt 0); maxEnginePct = 0; engineCount = $script:GpuCounters.Count; sampled = $false }
    }
  } catch {}

  # --- Thermal (absent on many laptops; reported as unsupported)
  try {
    $temps = @()
    foreach ($tc in $thermalCounters) {
      $v = Get-PcValue $tc.counter
      if ($null -eq $v) { continue }
      # Some drivers report deci-Kelvin instead of Celsius.
      if ($v -gt 200) { $v = $v / 10.0 - 273.15 }
      if ($v -gt -50 -and $v -lt 150) {
        $temps += [ordered]@{ zone = $tc.name; celsius = [math]::Round($v, 1) }
      }
    }
    $sample.thermal = [ordered]@{
      supported = ($temps.Count -gt 0)
      zones = $temps
    }
  } catch {}

  # --- System
  try {
    $sys = [ordered]@{}
    $v = Get-PcValue $cSysQueue
    if ($null -ne $v) { $sys.processorQueue = [math]::Round($v, 2) }
    $v = Get-PcValue $cSysCtx
    if ($null -ne $v) { $sys.contextSwitchesPerSec = [math]::Round($v, 0) }
    $v = Get-PcValue $cSysProc
    if ($null -ne $v) { $sys.processCount = [int]$v }
    $v = Get-PcValue $cSysThread
    if ($null -ne $v) { $sys.threadCount = [int]$v }
    if ($script:BootTime) {
      $sys.uptimeSeconds = [int]((Get-Date) - $script:BootTime).TotalSeconds
    }
    $sample.system = $sys
  } catch {}

  # --- Processes (also collects DSH process accounting as a side effect)
  try {
    $sample.processes = @(Get-TopProcesses 8)
    $sample.dshProcesses = @($script:LastDshProcs)
  } catch {}

  # Self-reported sampling cost. The UI shows this so the monitor's own overhead
  # is visible rather than silently distorting the numbers it displays.
  $sample.selfCostMs = [int]((Get-Date) - $loopStart).TotalMilliseconds

  Write-Sample $sample

  # Keep a steady cadence regardless of how long sampling took.
  $elapsed = ((Get-Date) - $loopStart).TotalMilliseconds
  $sleep = $script:IntervalMs - $elapsed
  if ($sleep -lt 50) { $sleep = 50 }
  Start-Sleep -Milliseconds ([int]$sleep)
}
