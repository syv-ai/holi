$ErrorActionPreference = 'Stop'
$directory = Join-Path $env:RUNNER_TEMP ("broker-observer-contract-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
try {
    $self = [Diagnostics.Process]::GetCurrentProcess()
    try { $creationTicks = $self.StartTime.ToUniversalTime().Ticks } finally { $self.Dispose() }
    @{ pid = $PID; creationTicks = $creationTicks } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $directory 'broker-root.json')
    $windowPath = Join-Path $directory 'broker-startup-window.json'
    $tracePath = Join-Path $directory 'samples.jsonl'
    @{ deadlineUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 15000 } | ConvertTo-Json -Compress | Set-Content -LiteralPath $windowPath
    & "$PSScriptRoot/observe-broker-startup.ps1" $directory $tracePath
    $records = @(Get-Content -LiteralPath $tracePath | ForEach-Object { $_ | ConvertFrom-Json })
    $samples = @($records | Where-Object { $null -ne $_.root })
    if ($samples.Count -lt 1 -or $samples.Count -gt 10 -or @($records | Where-Object { $_.status -and $_.status -ne 'sampling-ended' }).Count) { throw 'Valid observer contract produced no bounded samples' }
    foreach ($sample in $samples) {
        if ($sample.root.processId -ne $PID -or $sample.root.unavailable -or $sample.root.UserModeTime -lt 0 -or $sample.root.KernelModeTime -lt 0 -or $sample.root.WorkingSetSize -le 0 -or $sample.children.Count -gt 8) { throw 'Observer identity or activity unavailable' }
    }
    Remove-Item -LiteralPath $tracePath
    @{ deadlineUnixMs = 1234.5 } | ConvertTo-Json -Compress | Set-Content -LiteralPath $windowPath
    & "$PSScriptRoot/observe-broker-startup.ps1" $directory $tracePath
    $invalid = @(Get-Content -LiteralPath $tracePath | ForEach-Object { $_ | ConvertFrom-Json })
    if ($invalid.Count -ne 1 -or $invalid[0].status -ne 'identity-invalid') { throw 'Fractional deadline was not rejected' }
    Write-Host "BROKER_OBSERVER_CONTRACT passed samples=$($samples.Count)"
} finally {
    Remove-Item -LiteralPath $directory -Recurse -Force
    if (Test-Path -LiteralPath $directory) { throw 'Observer contract workspace remains' }
}
