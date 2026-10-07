[CmdletBinding()]
param(
    [string]$ConfigPath = '',
    [string]$DashHookMarker = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$questionId = $null
$completed = $false
$config = $null
$payload = $null

try {
    if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'client-config.json' }
    . (Join-Path $PSScriptRoot 'windows-client-common.ps1')
    $config = Read-DashWindowsConfig -Path $ConfigPath
    if ($config.QuestionsEnabled -ne $true -or $env:CLAUDE_CODE_ENTRYPOINT -cne 'cli') { exit 0 }
    $waitSeconds = [int]$config.QuestionWaitSeconds
    if ($waitSeconds -lt 1 -or $waitSeconds -gt 600) { exit 0 }

    # JSON object keys are case-sensitive. In particular, two question texts can
    # differ only by case; PowerShell 5.1 ConvertFrom-Json cannot preserve those.
    Add-Type -AssemblyName System.Web.Extensions
    $json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $json.MaxJsonLength = 2097152
    $json.RecursionLimit = 100
    $payload = $json.DeserializeObject((Read-DashWindowsStdin))
    if ($payload -isnot [System.Collections.IDictionary] -or
        $payload['hook_event_name'] -cne 'PreToolUse' -or
        $payload['tool_name'] -cne 'AskUserQuestion') { exit 0 }
    $session = $payload['session_id']
    $toolUse = $payload['tool_use_id']
    if ($session -isnot [string] -or [string]::IsNullOrWhiteSpace($session) -or
        $toolUse -isnot [string] -or [string]::IsNullOrWhiteSpace($toolUse)) { exit 0 }
    $original = $payload['tool_input']
    if ($original -isnot [System.Collections.IDictionary]) { exit 0 }
    $questions = $original['questions']
    if ($questions -isnot [System.Array] -or $questions.Count -lt 1 -or $questions.Count -gt 4) { exit 0 }
    $texts = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    foreach ($question in $questions) {
        if ($question -isnot [System.Collections.IDictionary] -or
            $question['question'] -isnot [string] -or
            [string]::IsNullOrWhiteSpace($question['question']) -or
            -not $texts.Add($question['question'])) { exit 0 }
    }

    $random = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($random) } finally { $rng.Dispose() }
    $invocation = [Convert]::ToBase64String($random).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $timeoutMs = $waitSeconds * 1000
    $register = $json.Serialize(@{
        sessionId = $session
        toolUseId = $toolUse
        invocationId = $invocation
        questions = $questions
        timeoutMs = $timeoutMs
    })
    $headers = @{
        'X-Dash-Entrypoint' = [string]$env:CLAUDE_CODE_ENTRYPOINT
        'X-Dash-Attended' = [string]$env:CLAUDE_CODE_SESSION_ATTENDED
        'X-Dash-Kind' = [string]$env:CLAUDE_CODE_SESSION_KIND
    }
    $registration = Invoke-DashWindowsHttp -Uri ($config.HubBase + '/question/register') -HostLabel $config.HostLabel -Headers $headers -Method POST -TimeoutMilliseconds ([Math]::Min(5000, $timeoutMs)) -Body $register -HasBody
    if ($registration.StatusCode -ne 201) { exit 0 }
    $registered = $json.DeserializeObject($registration.Body)
    if ($registered -isnot [System.Collections.IDictionary] -or
        $registered['questionId'] -isnot [string] -or
        [string]::IsNullOrWhiteSpace($registered['questionId'])) { exit 0 }
    $questionId = $registered['questionId']
    $waitUri = $config.HubBase + '/question/wait?session=' + [Uri]::EscapeDataString($session) +
        '&toolUse=' + [Uri]::EscapeDataString($toolUse) + '&question=' + [Uri]::EscapeDataString($questionId)

    while ($clock.ElapsedMilliseconds -lt $timeoutMs) {
        $remainingMs = $timeoutMs - [int]$clock.ElapsedMilliseconds
        $pollSeconds = [Math]::Min(50, [Math]::Floor($remainingMs / 1000))
        if ($pollSeconds -lt 1) { break }
        $reply = Invoke-DashWindowsHttp -Uri ($waitUri + '&wait=' + $pollSeconds) -HostLabel $config.HostLabel -Method GET -TimeoutMilliseconds $remainingMs
        if ($reply.StatusCode -eq 204) { continue }
        if ($reply.StatusCode -ne 200 -or $clock.ElapsedMilliseconds -ge $timeoutMs) { break }
        $result = $json.DeserializeObject($reply.Body)
        if ($result -isnot [System.Collections.IDictionary]) { break }
        $answers = $result['answers']
        if ($answers -isnot [System.Collections.IDictionary] -or $answers.Count -ne $texts.Count) { break }
        $valid = $true
        foreach ($text in $texts) {
            if (-not $answers.ContainsKey($text) -or $answers[$text] -isnot [string] -or
                [string]::IsNullOrWhiteSpace($answers[$text])) { $valid = $false; break }
        }
        if (-not $valid) { break }
        $original['answers'] = $answers
        $output = $json.Serialize(@{
            hookSpecificOutput = @{
                hookEventName = 'PreToolUse'
                permissionDecision = 'allow'
                updatedInput = $original
            }
        })
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        [Console]::Out.WriteLine($output)
        $completed = $true
        break
    }
}
catch {
    # No decision means the native question UI remains available. Never echo a
    # payload, remote error body, or an unvalidated answer on a failure path.
}
finally {
    if (-not $completed -and $null -ne $questionId -and $null -ne $config) {
        try {
            $cancel = $json.Serialize(@{ sessionId = $session; toolUseId = $toolUse; questionId = $questionId })
            $null = Invoke-DashWindowsHttp -Uri ($config.HubBase + '/question/cancel') -HostLabel $config.HostLabel -Method POST -TimeoutMilliseconds 2000 -Body $cancel -HasBody
        }
        catch { }
    }
}
exit 0
