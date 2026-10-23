# Synchronous Claude PreToolUse deny-fence hook. Never grants permission; failures consult the private cache.
[CmdletBinding()]
param(
    [string]$ConfigPath = '',
    [string]$DashHookMarker = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Read-DashFenceInput([int]$MaxBytes) {
    $stream = [Console]::OpenStandardInput()
    $memory = New-Object System.IO.MemoryStream
    $buffer = New-Object byte[] 8192
    try {
        while (($read = $stream.Read($buffer, 0, [Math]::Min($buffer.Length, $MaxBytes + 1 - [int]$memory.Length))) -gt 0) {
            $memory.Write($buffer, 0, $read)
            if ($memory.Length -gt $MaxBytes) { throw 'Hook input too large.' }
        }
        return [System.Text.UTF8Encoding]::new($false, $true).GetString($memory.ToArray())
    }
    finally { $memory.Dispose() }
}

function Test-DashFenceResponse($Value) {
    if ($Value -isnot [System.Collections.IDictionary] -or $Value.active_goal -isnot [bool]) { return $false }
    $allowed = @('active_goal','goal_id','expires_at','remaining_ttl_ms','permissionDecision','reason')
    foreach ($key in $Value.Keys) { if ($allowed -cnotcontains [string]$key) { return $false } }
    foreach ($name in @('goal_id','expires_at','remaining_ttl_ms')) { if (-not $Value.Contains($name)) { return $false } }
    if (-not $Value.active_goal) {
        return $Value.Keys.Count -eq 4 -and $null -eq $Value.goal_id -and $null -eq $Value.expires_at -and
            ($Value.remaining_ttl_ms -is [int] -or $Value.remaining_ttl_ms -is [long]) -and $Value.remaining_ttl_ms -eq 0
    }
    if ($Value.Keys.Count -ne 4 -and $Value.Keys.Count -ne 6) { return $false }
    foreach ($name in @('goal_id','expires_at','remaining_ttl_ms')) {
        if (-not $Value.Contains($name) -or ($Value[$name] -isnot [long] -and $Value[$name] -isnot [int])) { return $false }
    }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($Value.goal_id -lt 1 -or $Value.expires_at -le $now -or
        $Value.remaining_ttl_ms -lt 1 -or $Value.remaining_ttl_ms -gt 86400000) { return $false }
    if ($Value.Contains('permissionDecision') -and ($Value.permissionDecision -cne 'deny' -or
        -not $Value.Contains('reason') -or $Value.reason -isnot [string] -or
        $Value.reason.Length -gt 512 -or $Value.reason -match '[\x00-\x1F\x7F]')) { return $false }
    if ($Value.Contains('reason') -and -not $Value.Contains('permissionDecision')) { return $false }
    return $true
}

try {
    if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'client-config.json' }
    . (Join-Path $PSScriptRoot 'windows-client-common.ps1')
    $config = Read-DashWindowsConfig -Path $ConfigPath
    if ($config.AutopilotFenceEnabled -ne $true -or $env:CLAUDE_CODE_ENTRYPOINT -cne 'cli') { exit 0 }
    Add-Type -AssemblyName System.Web.Extensions
    $json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $json.MaxJsonLength = 2097152
    $json.RecursionLimit = 100
    $payload = $json.DeserializeObject((Read-DashFenceInput 2097152))
    if ($payload -isnot [System.Collections.IDictionary] -or $payload['hook_event_name'] -cne 'PreToolUse') {
        Emit-DashWindowsFenceDeny 'dash autopilot fence: uninspectable tool call; ask the owner'
        exit 0
    }
    $session = $payload['session_id']
    $tool = $payload['tool_name']
    $input = $payload['tool_input']
    if ($session -isnot [string] -or $session -notmatch '^[A-Za-z0-9_-]{1,128}$' -or
        $tool -isnot [string] -or $tool -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,255}$' -or
        ($input -isnot [System.Collections.IDictionary] -and $input -isnot [System.Array])) {
        Emit-DashWindowsFenceDeny 'dash autopilot fence: uninspectable tool call; ask the owner'
        exit 0
    }
    try {
        $body = $json.Serialize(@{ harness = 'claude'; sessionId = $session; tool = $tool; input = $input })
        $response = Invoke-DashWindowsHttp -Uri ($config.HubBase + '/hook/fence') -HostLabel $config.HostLabel `
            -Headers @{ 'X-Dash-Entrypoint' = 'cli' } -Method POST -TimeoutMilliseconds 3000 -Body $body -HasBody
        if ($response.StatusCode -ne 200 -or [System.Text.Encoding]::UTF8.GetByteCount($response.Body) -gt 1048576) {
            throw 'Fence request failed.'
        }
        $result = $json.DeserializeObject($response.Body)
        if (-not (Test-DashFenceResponse $result)) {
            try { Write-DashWindowsFenceCache -HostLabel $config.HostLabel -SessionId $session -Active:$true -InvalidActive } catch { }
            Emit-DashWindowsFenceDeny 'dash autopilot fence metadata invalid; ask the owner'
            exit 0
        }
        if (-not $result.active_goal) {
            try { Write-DashWindowsFenceCache -HostLabel $config.HostLabel -SessionId $session -Active:$false } catch { }
            exit 0
        }
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $remainingTtl = [Math]::Min([long]$result.remaining_ttl_ms, [long]($result.expires_at - $nowMs))
        if ($remainingTtl -lt 1) {
            try { Write-DashWindowsFenceCache -HostLabel $config.HostLabel -SessionId $session -Active:$true -InvalidActive } catch { }
            Emit-DashWindowsFenceDeny 'dash autopilot fence metadata invalid; ask the owner'
            exit 0
        }
        try {
            Write-DashWindowsFenceCache -HostLabel $config.HostLabel -SessionId $session -Active:$true `
                -GoalId ([long]$result.goal_id) -ExpiresAt ([long]$result.expires_at) -RemainingTtlMs $remainingTtl
        }
        catch {
            Emit-DashWindowsFenceDeny 'dash autopilot fence cache unavailable; ask the owner'
            exit 0
        }
        if ($result.permissionDecision -ceq 'deny') {
            Emit-DashWindowsFenceDeny ([string]$result.reason)
        }
        exit 0
    }
    catch {
        $state = Get-DashWindowsFenceState $config.HostLabel $session
        if ($state -eq 'active') { Emit-DashWindowsFenceDeny 'dash hub unreachable; autopilot paused, ask the owner' }
        elseif ($state -eq 'invalid') { Emit-DashWindowsFenceDeny 'dash autopilot fence cache invalid; ask the owner' }
        else { Emit-DashWindowsFenceDeny 'dash hub unreachable; autopilot state unconfirmed, ask the owner' }
        exit 0
    }
}
catch {
    [Console]::Out.WriteLine('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"dash autopilot fence: uninspectable tool call; ask the owner"}}')
}
exit 0
