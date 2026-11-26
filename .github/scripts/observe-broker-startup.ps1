param([string]$RunDirectory, [string]$TracePath)

# This runs in the CI runner's thread job, not another OS process.
$ErrorActionPreference = 'Stop'
$identityPath = Join-Path $RunDirectory 'broker-root.json'
$windowPath = Join-Path $RunDirectory 'broker-startup-window.json'
$endedPath = Join-Path $RunDirectory 'broker-startup-ended'
$properties = @('ProcessId', 'ParentProcessId', 'CreationDate', 'UserModeTime', 'KernelModeTime', 'ReadTransferCount', 'WriteTransferCount', 'WorkingSetSize')

function Write-Status([string]$Status) {
    @{ status = $Status } | ConvertTo-Json -Compress | Add-Content -LiteralPath $TracePath
}

function Get-CreationTicks($Row) {
    if ($null -eq $Row -or $Row.CreationDate -isnot [DateTime]) { return 0L }
    return $Row.CreationDate.ToUniversalTime().Ticks
}

function Test-Identity($Row, [long]$ProcessId, [long]$CreationTicks) {
    $observed = Get-CreationTicks $Row
    # CIM timestamps have microsecond precision; process times have 100ns precision.
    return $observed -gt 0 -and [long]$Row.ProcessId -eq $ProcessId -and [Math]::Abs($observed - $CreationTicks) -lt 10
}

function Get-Counters($Row) {
    $result = @{ processId = [long]$Row.ProcessId; creationTicks = (Get-CreationTicks $Row); unavailable = $false }
    foreach ($name in @('UserModeTime', 'KernelModeTime', 'ReadTransferCount', 'WriteTransferCount', 'WorkingSetSize')) {
        $value = 0L
        if ($null -eq $Row.$name -or -not [long]::TryParse([string]$Row.$name, [ref]$value) -or $value -lt 0) {
            $result[$name] = $null
            $result.unavailable = $true
        } else { $result[$name] = $value }
    }
    return $result
}

try {
    # The fixture runs late in a sequential suite. This wait is not its startup budget.
    $waitDeadline = [DateTime]::UtcNow.AddMinutes(20)
    $identity = $null
    $window = $null
    while ([DateTime]::UtcNow -lt $waitDeadline -and -not (Test-Path -LiteralPath $endedPath)) {
        try {
            if ((Get-Item -LiteralPath $identityPath).Length -gt 1024 -or (Get-Item -LiteralPath $windowPath).Length -gt 1024) { throw 'oversized identity' }
            $identity = Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json
            $window = Get-Content -LiteralPath $windowPath -Raw | ConvertFrom-Json
            break
        } catch { Start-Sleep -Milliseconds 250 }
    }
    if ($null -eq $identity -or $null -eq $window) { Write-Status 'identity-unavailable'; return }
    $rootId = 0L
    $creationTicks = 0L
    $deadlineMs = 0L
    if (-not [long]::TryParse([string]$identity.pid, [ref]$rootId) -or $rootId -le 0 -or $rootId -gt [uint32]::MaxValue -or
        -not [long]::TryParse([string]$identity.creationTicks, [ref]$creationTicks) -or $creationTicks -le 0 -or
        -not [long]::TryParse([string]$window.deadlineUnixMs, [ref]$deadlineMs)) { Write-Status 'identity-invalid'; return }
    $deadline = [DateTimeOffset]::FromUnixTimeMilliseconds($deadlineMs).UtcDateTime
    if ($deadline -gt [DateTime]::UtcNow.AddSeconds(45)) { Write-Status 'window-invalid'; return }
    for ($sample = 0; $sample -lt 10; $sample++) {
        if ([DateTime]::UtcNow -ge $deadline -or (Test-Path -LiteralPath $endedPath)) { break }
        $root = Get-CimInstance Win32_Process -Filter "ProcessId=$rootId" -Property $properties -OperationTimeoutSec 1
        if (-not (Test-Identity $root $rootId $creationTicks)) { Write-Status 'root-exited-or-identity-unavailable'; return }
        if ([DateTime]::UtcNow -ge $deadline -or (Test-Path -LiteralPath $endedPath)) { break }
        $rows = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$rootId" -Property $properties -OperationTimeoutSec 1 | Select-Object -First 9)
        $children = @()
        $unavailable = $false
        foreach ($row in ($rows | Select-Object -First 8)) {
            if ([DateTime]::UtcNow -ge $deadline -or (Test-Path -LiteralPath $endedPath)) { break }
            $childTicks = Get-CreationTicks $row
            if ([long]$row.ParentProcessId -ne $rootId -or $childTicks -lt ($creationTicks - 9) -or $childTicks -gt [DateTime]::UtcNow.Ticks) { $unavailable = $true; continue }
            $check = Get-CimInstance Win32_Process -Filter "ProcessId=$([long]$row.ProcessId)" -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 1
            if (-not (Test-Identity $check ([long]$row.ProcessId) $childTicks) -or [long]$check.ParentProcessId -ne $rootId) { $unavailable = $true; continue }
            $children += Get-Counters $row
        }
        if ([DateTime]::UtcNow -ge $deadline -or (Test-Path -LiteralPath $endedPath)) { break }
        $after = Get-CimInstance Win32_Process -Filter "ProcessId=$rootId" -Property ProcessId,CreationDate -OperationTimeoutSec 1
        if (-not (Test-Identity $after $rootId $creationTicks)) { Write-Status 'root-exited-or-identity-unavailable'; return }
        $observed = [DateTime]::UtcNow
        if ($observed -ge $deadline -or (Test-Path -LiteralPath $endedPath)) { break }
        @{ sample = $sample; observedUtcTicks = $observed.Ticks; root = (Get-Counters $root); children = $children; capped = ($rows.Count -gt 8); childrenUnavailable = $unavailable } |
            ConvertTo-Json -Compress -Depth 4 | Add-Content -LiteralPath $TracePath
        $remainingMs = [Math]::Min(5000, [Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds))
        if ($remainingMs -gt 0) { Start-Sleep -Milliseconds ([int]$remainingMs) }
    }
    Write-Status 'sampling-ended'
} catch { Write-Status 'observer-unavailable' }
