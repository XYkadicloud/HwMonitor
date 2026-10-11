# HwMonitor hardware inventory.
#
# Emits one JSON object describing the machine's static hardware configuration.
# Run on demand (not per sample) because several of these queries are slow
# (Get-PhysicalDisk ~6.8s, Get-CimInstance Win32_Processor ~1.1s cold).
#
# Usage: powershell -File inventory.ps1

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$inv = [ordered]@{ generatedAt = (Get-Date).ToString('o') }

# ------------------------------------------------------------------- system
try {
  $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
  $inv.os = [ordered]@{
    name = $cv.ProductName
    edition = $cv.EditionID
    displayVersion = $cv.DisplayVersion
    build = "$($cv.CurrentBuild).$($cv.UBR)"
    installDate = $(try { [datetimeoffset]::FromUnixTimeSeconds([int]$cv.InstallDate).ToString('o') } catch { $null })
  }
} catch {}

try {
  $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
  $inv.system = [ordered]@{
    computerName = $cs.Name
    manufacturer = "$($cs.Manufacturer)".Trim()
    model = "$($cs.Model)".Trim()
    systemType = $cs.SystemType
    totalPhysicalBytes = [double]$cs.TotalPhysicalMemory
  }
} catch {}

try {
  $bios = Get-CimInstance Win32_BIOS -ErrorAction Stop
  $inv.bios = [ordered]@{
    vendor = "$($bios.Manufacturer)".Trim()
    version = "$($bios.SMBIOSBIOSVersion)".Trim()
    releaseDate = "$($bios.ReleaseDate)"
    serial = "$($bios.SerialNumber)".Trim()
  }
} catch {}

# ---------------------------------------------------------------------- CPU
try {
  $cpus = @(Get-CimInstance Win32_Processor -ErrorAction Stop)
  $inv.cpus = @($cpus | ForEach-Object {
    [ordered]@{
      name = "$($_.Name)".Trim()
      cores = [int]$_.NumberOfCores
      threads = [int]$_.NumberOfLogicalProcessors
      maxClockMhz = [int]$_.MaxClockSpeed
      currentClockMhz = [int]$_.CurrentClockSpeed
      l2CacheKb = [int]$_.L2CacheSize
      l3CacheKb = [int]$_.L3CacheSize
      socket = "$($_.SocketDesignation)"
      virtualizationFirmwareEnabled = [bool]$_.VirtualizationFirmwareEnabled
      architecture = [int]$_.Architecture
    }
  })
} catch {}

# ------------------------------------------------------------------ memory
try {
  $mods = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop)
  $inv.memoryModules = @($mods | ForEach-Object {
    [ordered]@{
      bank = "$($_.BankLabel)".Trim()
      slot = "$($_.DeviceLocator)".Trim()
      capacityBytes = [double]$_.Capacity
      speedMhz = [int]$_.Speed
      configuredSpeedMhz = [int]$_.ConfiguredClockSpeed
      manufacturer = "$($_.Manufacturer)".Trim()
      partNumber = "$($_.PartNumber)".Trim()
      memoryType = [int]$_.SMBIOSMemoryType
      formFactor = [int]$_.FormFactor
    }
  })
} catch {}

try {
  $arr = Get-CimInstance Win32_PhysicalMemoryArray -ErrorAction Stop
  $inv.memorySlots = [int]$arr.MemoryDevices
  $inv.memoryMaxCapacityKb = [double]$arr.MaxCapacityEx
} catch {}

# -------------------------------------------------------------------- disks
try {
  $pds = @(Get-PhysicalDisk -ErrorAction Stop)
  $inv.physicalDisks = @($pds | ForEach-Object {
    [ordered]@{
      name = "$($_.FriendlyName)".Trim()
      mediaType = "$($_.MediaType)"
      busType = "$($_.BusType)"
      sizeBytes = [double]$_.Size
      health = "$($_.HealthStatus)"
      status = "$($_.OperationalStatus)"
      serial = "$($_.SerialNumber)".Trim()
      firmware = "$($_.FirmwareVersion)".Trim()
      spindleSpeed = $(try { [int]$_.SpindleSpeed } catch { $null })
    }
  })
} catch {}

try {
  $vols = @(Get-CimInstance Win32_LogicalDisk -ErrorAction Stop)
  $inv.volumes = @($vols | ForEach-Object {
    [ordered]@{
      id = "$($_.DeviceID)"
      label = "$($_.VolumeName)"
      fs = "$($_.FileSystem)"
      driveType = [int]$_.DriveType
      sizeBytes = $(if ($_.Size) { [double]$_.Size } else { 0 })
      freeBytes = $(if ($_.FreeSpace) { [double]$_.FreeSpace } else { 0 })
    }
  })
} catch {}

# ------------------------------------------------------------- SMBIOS memory
try {
  $smb = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop | Select-Object -First 1)
  if ($smb) { $inv.memoryTypeCode = [int]$smb.SMBIOSMemoryType }
} catch {}

# ------------------------------------------------------------------- GPU
try {
  $vcs = @(Get-CimInstance Win32_VideoController -ErrorAction Stop)
  $inv.gpus = @($vcs | ForEach-Object {
    [ordered]@{
      name = "$($_.Name)".Trim()
      # AdapterRAM is a 32-bit field and saturates near 4GB on many drivers, so
      # it is reported as-is and treated as advisory rather than exact.
      adapterRamBytes = $(if ($_.AdapterRAM) { [double]$_.AdapterRAM } else { $null })
      driverVersion = "$($_.DriverVersion)"
      driverDate = "$($_.DriverDate)"
      videoProcessor = "$($_.VideoProcessor)"
      currentHorizontalResolution = [int]$_.CurrentHorizontalResolution
      currentVerticalResolution = [int]$_.CurrentVerticalResolution
      currentRefreshRate = [int]$_.CurrentRefreshRate
      status = "$($_.Status)"
    }
  })
} catch {}

# ------------------------------------------------------------------ battery
$batt = [ordered]@{ present = $false }
try {
  $b = Get-CimInstance Win32_Battery -ErrorAction Stop | Select-Object -First 1
  if ($b) {
    $batt.present = $true
    $batt.name = "$($b.Name)".Trim()
    $batt.deviceId = "$($b.DeviceID)"
    $batt.chemistry = [int]$b.Chemistry
    $batt.designVoltageMv = [int]$b.DesignVoltage
    $batt.status = [int]$b.BatteryStatus
  }
} catch {}

# Capacity values live in root/wmi or the battery report, not Win32_Battery.
try {
  $sd = Get-CimInstance -Namespace root/wmi -ClassName BatteryStaticData -ErrorAction Stop | Select-Object -First 1
  if ($sd) {
    if ($sd.DesignedCapacity) { $batt.designCapacityMwh = [int]$sd.DesignedCapacity }
    if ($sd.CycleCount) { $batt.cycleCount = [int]$sd.CycleCount }
  }
} catch {}

try {
  $fc = Get-CimInstance -Namespace root/wmi -ClassName BatteryFullChargedCapacity -ErrorAction Stop | Select-Object -First 1
  if ($fc -and $fc.FullChargedCapacity) { $batt.fullChargeCapacityMwh = [int]$fc.FullChargedCapacity }
} catch {}

if (-not $batt.designCapacityMwh -or -not $batt.fullChargeCapacityMwh) {
  try {
    $cache = Join-Path $PSScriptRoot '..\data\battery-static.json'
    if (Test-Path $cache) {
      $c = Get-Content $cache -Raw | ConvertFrom-Json
      if (-not $batt.designCapacityMwh -and $c.designCapacityMwh) { $batt.designCapacityMwh = [int]$c.designCapacityMwh }
      if (-not $batt.fullChargeCapacityMwh -and $c.fullChargeCapacityMwh) { $batt.fullChargeCapacityMwh = [int]$c.fullChargeCapacityMwh }
      if (-not $batt.cycleCount -and $c.cycleCount) { $batt.cycleCount = [int]$c.cycleCount }
    }
  } catch {}
}

if ($batt.designCapacityMwh -and $batt.fullChargeCapacityMwh -and $batt.designCapacityMwh -gt 0) {
  $batt.healthPct = [math]::Round(100.0 * $batt.fullChargeCapacityMwh / $batt.designCapacityMwh, 1)
}
$inv.battery = $batt

# ------------------------------------------------------------------ network
try {
  $adapters = @(Get-NetAdapter -ErrorAction Stop)
  $inv.networkAdapters = @($adapters | ForEach-Object {
    [ordered]@{
      name = "$($_.Name)"
      description = "$($_.InterfaceDescription)"
      status = "$($_.Status)"
      linkSpeed = "$($_.LinkSpeed)"
      macAddress = "$($_.MacAddress)"
    }
  })
} catch {
  # Fall back to WMI if the NetAdapter module is unavailable.
  try {
    $inv.networkAdapters = @(Get-CimInstance Win32_NetworkAdapter -ErrorAction Stop |
      Where-Object { $_.PhysicalAdapter } |
      ForEach-Object {
        [ordered]@{
          name = "$($_.NetConnectionID)"
          description = "$($_.Name)"
          macAddress = "$($_.MACAddress)"
          speedBps = $(if ($_.Speed) { [double]$_.Speed } else { $null })
        }
      })
  } catch {}
}

# ---------------------------------------------------------------- capability
# Reported so the UI can explain missing panels instead of showing blanks.
$inv.capabilities = [ordered]@{
  battery = [bool]$batt.present
  thermalZones = $false
  gpuEngineCounters = $false
}
try {
  $t = New-Object System.Diagnostics.PerformanceCounterCategory('Thermal Zone Information')
  $inv.capabilities.thermalZones = ($t.GetInstanceNames().Count -gt 0)
} catch {}
try {
  $g = New-Object System.Diagnostics.PerformanceCounterCategory('GPU Engine')
  $inv.capabilities.gpuEngineCounters = ($g.GetInstanceNames().Count -gt 0)
} catch {}

Write-Output ($inv | ConvertTo-Json -Compress -Depth 6)
