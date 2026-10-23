# Synchronous Claude goal-aware AskUserQuestion hook. Network failure emits no approval.
[CmdletBinding()]
param(
    [string]$ConfigPath = '',
    [string]$DashHookMarker = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$registrationAttempted = $false
$completed = $false
$session = $null
$toolUse = $null
$invocation = $null
$config = $null
$headers = @{ 'X-Dash-Entrypoint' = 'cli' }

function Read-DashAutopilotInput([int]$MaxBytes) {
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

function Test-DashExactKeys($Value, [string[]]$Required, [string[]]$Allowed) {
    if ($Value -isnot [System.Collections.IDictionary]) { return $false }
    foreach ($key in $Required) { if (-not $Value.Contains($key)) { return $false } }
    foreach ($key in $Value.Keys) { if ($Allowed -cnotcontains [string]$key) { return $false } }
    return $true
}

function Test-DashAutopilotMetadata($Value) {
    if (-not (Test-DashExactKeys $Value @('goal_id','expires_at','remaining_ttl_ms') @('goal_id','expires_at','remaining_ttl_ms'))) { return $false }
    foreach ($name in @('goal_id','expires_at','remaining_ttl_ms')) {
        if ($Value[$name] -isnot [long] -and $Value[$name] -isnot [int]) { return $false }
    }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    return $Value.goal_id -gt 0 -and $Value.expires_at -gt $now -and
        $Value.remaining_ttl_ms -gt 0 -and $Value.remaining_ttl_ms -le 86400000
}
function Test-DashAnswerMap($Answers, $Questions, [string]$Source) {
    if ($Answers -isnot [System.Collections.IDictionary] -or $Answers.Count -ne $Questions.Count) { return $false }
    foreach ($question in $Questions) {
        $text = [string]$question['question']
        if (-not $Answers.Contains($text) -or $Answers[$text] -isnot [string]) { return $false }
        $answer = [string]$Answers[$text]
        if ([System.Text.Encoding]::UTF8.GetByteCount($answer) -gt 32768 -or $answer -match '[\x00-\x08\x0b-\x1F\x7F]' -or
            ($answer -ne '' -and [string]::IsNullOrWhiteSpace($answer))) { return $false }
        if ($answer -eq '' -and $question['multiSelect'] -ne $true) { return $false }
        $labels = @($question['options'] | ForEach-Object { [string]$_['label'] })
        if ($answer -eq '' -and $question['multiSelect'] -eq $true) { continue }
        if ($labels -ccontains $answer) {
            if ($Source -eq 'autopilot') {
                $recommended = $question['recommended']
                if (($recommended -isnot [long] -and $recommended -isnot [int]) -or
                    $recommended -lt 0 -or $recommended -ge $question['options'].Count -or
                    $answer -cne [string]$question['options'][$recommended]['label']) { return $false }
            }
            continue
        }
        if ($Source -eq 'autopilot' -or $question['multiSelect'] -ne $true) { return $false }
        $selections = @($answer -split ', ')
        if ($selections.Count -eq 0 -or @($selections | Select-Object -Unique).Count -ne $selections.Count) { return $false }
        foreach ($selection in $selections) { if ($labels -cnotcontains $selection) { return $false } }
    }
    return $true
}

function Get-DashDialogAnswer($Value, $InvocationId, $Questions) {
    if (-not (Test-DashExactKeys $Value @('action','invocationId','source','answers') @('action','invocationId','source','answers','autopilot')) -or
        $Value.action -cne 'answer' -or $Value.invocationId -cne $InvocationId) { return $null }
    $source = [string]$Value.source
    if ($source -cnotin @('autopilot','web','telegram')) { return $null }
    if ($source -ceq 'autopilot') {
        if (-not $Value.Contains('autopilot') -or -not (Test-DashAutopilotMetadata $Value.autopilot)) { return $null }
    }
    elseif ($Value.Contains('autopilot')) { return $null }
    if (-not (Test-DashAnswerMap $Value.answers $Questions $source)) { return $null }
    return [pscustomobject]@{ Answers = $Value.answers; Source = $source; Autopilot = $Value.autopilot }
}

function Write-DashDialogAnswer($ToolInput, $Answer, [string]$Host, [string]$SessionId, [int64]$DeadlineMs,
    [System.Diagnostics.Stopwatch]$Clock, [int64]$HoldDeadlineMs = 605000, [int64]$HoldExpiresAt = 0) {
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($Clock.ElapsedMilliseconds -ge $HoldDeadlineMs -or $nowMs -ge $DeadlineMs -or
        ($HoldExpiresAt -gt 0 -and $nowMs -ge $HoldExpiresAt)) { return $false }
    if ($Answer.Source -ceq 'autopilot') {
        $remainingTtl = [Math]::Min([long]$Answer.Autopilot.remaining_ttl_ms,
            [long]($Answer.Autopilot.expires_at - $nowMs))
        if ($remainingTtl -lt 1) { return $false }
        Write-DashWindowsFenceCache -HostLabel $Host -SessionId $SessionId -Active:$true -GoalId ([long]$Answer.Autopilot.goal_id) `
            -ExpiresAt ([long]$Answer.Autopilot.expires_at) -RemainingTtlMs $remainingTtl
    }
    $ToolInput['answers'] = $Answer.Answers
    $json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $json.MaxJsonLength = 2097152
    $output = $json.Serialize(@{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'allow'; updatedInput = $ToolInput } })
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::Out.WriteLine($output)
    return $true
}

try {
    if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'client-config.json' }
    . (Join-Path $PSScriptRoot 'windows-client-common.ps1')
    $config = Read-DashWindowsConfig -Path $ConfigPath
    if ($config.AutopilotDialogsEnabled -ne $true -or $config.AutopilotFenceEnabled -ne $true -or $env:CLAUDE_CODE_ENTRYPOINT -cne 'cli') { exit 0 }
    Add-Type -AssemblyName System.Web.Extensions
    $json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $json.MaxJsonLength = 2097152
    $json.RecursionLimit = 100
    $payload = $json.DeserializeObject((Read-DashAutopilotInput 2097152))
    if ($payload -isnot [System.Collections.IDictionary] -or $payload['hook_event_name'] -cne 'PreToolUse' -or
        $payload['tool_name'] -cne 'AskUserQuestion') { exit 0 }
    $session = [string]$payload['session_id']
    $toolUse = [string]$payload['tool_use_id']
    $toolInput = $payload['tool_input']
    $questions = $toolInput['questions']
    if ($session -notmatch '^[A-Za-z0-9_-]{1,128}$' -or $toolUse -notmatch '^[A-Za-z0-9_-]{1,256}$' -or
        $toolInput -isnot [System.Collections.IDictionary] -or $questions -isnot [System.Array] -or
        $questions.Count -lt 1 -or $questions.Count -gt 16) { exit 0 }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    $normalizedQuestions = New-Object 'System.Collections.Generic.List[object]'
    $questionIndex = 0
    foreach ($question in $questions) {
        if ($question -isnot [System.Collections.IDictionary] -or $question['question'] -isnot [string] -or
            [string]::IsNullOrWhiteSpace($question['question']) -or -not $seen.Add([string]$question['question']) -or
            $question['options'] -isnot [System.Array] -or $question['options'].Count -lt 1 -or $question['options'].Count -gt 64) { exit 0 }
        $multiSelect = $question['multiSelect'] -eq $true
        if ($null -ne $question['multiSelect'] -and $question['multiSelect'] -isnot [bool]) { exit 0 }
        if ($question.Contains('header') -and ($question['header'] -isnot [string] -or
            [string]::IsNullOrWhiteSpace($question['header']) -or $question['header'].Length -gt 1024)) { exit 0 }
        if ($question.Contains('recommended') -and $question['recommended'] -isnot [int] -and $question['recommended'] -isnot [long]) { exit 0 }
        $normalizedOptions = New-Object 'System.Collections.Generic.List[object]'
        $labels = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
        foreach ($option in $question['options']) {
            if ($option -isnot [System.Collections.IDictionary] -or $option['label'] -isnot [string] -or
                [string]::IsNullOrWhiteSpace($option['label']) -or -not $labels.Add([string]$option['label']) -or
                ($multiSelect -and $option['label'].Contains(', '))) { exit 0 }
            $normalizedOption = [ordered]@{ label = [string]$option['label'] }
            foreach ($detailName in @('description','preview')) {
                if ($option.Contains($detailName)) {
                    $limit = if ($detailName -ceq 'description') { 4096 } else { 8192 }
                    if ($option[$detailName] -isnot [string] -or $option[$detailName].Length -gt $limit -or
                        $option[$detailName] -match '[\x00-\x08\x0b-\x1F\x7F]') { exit 0 }
                    $normalizedOption[$detailName] = [string]$option[$detailName]
                }
            }
            $normalizedOptions.Add($normalizedOption)
        }
        $normalizedQuestion = [ordered]@{
            id = [string]$questionIndex
            question = [string]$question['question']
            options = [object[]]$normalizedOptions.ToArray()
        }
        if ($question.Contains('header')) { $normalizedQuestion.header = [string]$question['header'] }
        if ($question.Contains('multiSelect')) { $normalizedQuestion.multiSelect = [bool]$question['multiSelect'] }
        if ($question.Contains('recommended') -and $question['recommended'] -ge 0 -and
            $question['recommended'] -lt $normalizedOptions.Count) {
            $normalizedQuestion.recommended = [int]$question['recommended']
        }
        $normalizedQuestions.Add($normalizedQuestion)
        $questionIndex++
    }

    $random = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($random) } finally { $rng.Dispose() }
    $invocation = [Convert]::ToBase64String($random).TrimEnd('=').Replace('+','-').Replace('/','_')
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $deadlineMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 605000
    $requestBody = $json.Serialize(@{ toolName = 'AskUserQuestion'; sessionId = $session; toolUseId = $toolUse;
        invocationId = $invocation; questions = $normalizedQuestions.ToArray(); hook_deadline_ms = $deadlineMs })
    $registrationAttempted = $true
    $response = Invoke-DashWindowsHttp -Uri ($config.HubBase + '/hook/ask') -HostLabel $config.HostLabel -Headers $headers `
        -Method POST -TimeoutMilliseconds 5000 -Body $requestBody -HasBody
    if ($response.StatusCode -ne 200) { exit 0 }
    $registration = $json.DeserializeObject($response.Body)
    if ($registration -isnot [System.Collections.IDictionary] -or $registration.action -isnot [string]) { exit 0 }
    if ($registration.action -ceq 'release' -and (Test-DashExactKeys $registration @('action') @('action'))) { exit 0 }
    if ($registration.action -ceq 'answer') {
        $answer = Get-DashDialogAnswer $registration $invocation $questions
        if ($null -ne $answer -and (Write-DashDialogAnswer $toolInput $answer $config.HostLabel $session $deadlineMs $clock)) { $completed = $true }
        exit 0
    }
    if ($registration.action -cne 'hold' -or
        -not (Test-DashExactKeys $registration @('action','invocationId','questionId','expiresAt') @('action','invocationId','questionId','expiresAt','answerAt','autopilot')) -or
        $registration.invocationId -cne $invocation -or $registration.questionId -cne $invocation -or
        $registration.expiresAt -isnot [long] -and $registration.expiresAt -isnot [int]) { exit 0 }
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($registration.expiresAt -le $nowMs -or $registration.expiresAt -gt $deadlineMs) { exit 0 }
    $autoMetadata = $registration.autopilot
    $answerAt = $registration.answerAt
    if ($registration.Contains('autopilot')) {
        if (-not (Test-DashAutopilotMetadata $autoMetadata) -or $null -eq $answerAt -or
            ($answerAt -isnot [long] -and $answerAt -isnot [int]) -or $answerAt -le $nowMs -or $answerAt -ge $registration.expiresAt) { exit 0 }
    }
    elseif ($registration.Contains('answerAt')) { exit 0 }

    $holdDeadline = [Math]::Min(605000, $clock.ElapsedMilliseconds + ($registration.expiresAt - $nowMs))
    while ($clock.ElapsedMilliseconds -lt $holdDeadline) {
        $remainingMs = $holdDeadline - [int]$clock.ElapsedMilliseconds
        if ($null -ne $autoMetadata -and $null -ne $answerAt -and
            [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $answerAt) {
            $resolveBody = $json.Serialize(@{ action = 'resolve'; toolName = 'AskUserQuestion'; sessionId = $session;
                toolUseId = $toolUse; invocationId = $invocation; questions = $normalizedQuestions.ToArray(); hook_deadline_ms = $deadlineMs })
            $resolved = Invoke-DashWindowsHttp -Uri ($config.HubBase + '/hook/ask') -HostLabel $config.HostLabel -Headers $headers `
                -Method POST -TimeoutMilliseconds ([Math]::Min(5000, $remainingMs)) -Body $resolveBody -HasBody
            if ($resolved.StatusCode -ne 200) { break }
            $decision = $json.DeserializeObject($resolved.Body)
            if ($decision -isnot [System.Collections.IDictionary]) { break }
            if ($decision.action -ceq 'release' -and (Test-DashExactKeys $decision @('action') @('action'))) { break }
            if ($decision.action -ceq 'answer') {
                $answer = Get-DashDialogAnswer $decision $invocation $questions
                if ($null -ne $answer -and (Write-DashDialogAnswer $toolInput $answer $config.HostLabel $session $deadlineMs $clock $holdDeadline $registration.expiresAt)) { $completed = $true }
                break
            }
            if ($decision.action -cne 'hold' -or
                -not (Test-DashExactKeys $decision @('action','invocationId','questionId','expiresAt') @('action','invocationId','questionId','expiresAt','answerAt','autopilot')) -or
                $decision.invocationId -cne $invocation -or $decision.questionId -cne $invocation -or
                ($decision.expiresAt -isnot [long] -and $decision.expiresAt -isnot [int]) -or
                $decision.expiresAt -ne $registration.expiresAt) { break }
            $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            if ($decision.Contains('autopilot')) {
                if ($null -eq $decision.answerAt -or
                    ($decision.answerAt -isnot [long] -and $decision.answerAt -isnot [int]) -or
                    $decision.answerAt -le $nowMs -or $decision.answerAt -ge $registration.expiresAt -or
                    -not (Test-DashAutopilotMetadata $decision.autopilot) -or
                    $decision.autopilot.goal_id -ne $autoMetadata.goal_id -or
                    $decision.autopilot.expires_at -ne $autoMetadata.expires_at) { break }
                $autoMetadata = $decision.autopilot
                $answerAt = $decision.answerAt
            }
            else {
                if ($decision.Contains('answerAt')) { break }
                $autoMetadata = $null
                $answerAt = $null
            }
            continue
        }
        $waitSeconds = [Math]::Min(50, [Math]::Max(1, [Math]::Ceiling($remainingMs / 1000)))
        if ($null -ne $answerAt) { $waitSeconds = [Math]::Min($waitSeconds, [Math]::Max(1, [Math]::Ceiling(($answerAt - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) / 1000))) }
        $waitUri = $config.HubBase + '/question/wait?session=' + [Uri]::EscapeDataString($session) + '&toolUseId=' +
            [Uri]::EscapeDataString($toolUse) + '&question=' + [Uri]::EscapeDataString($invocation) + '&wait=' + [string]$waitSeconds
        $wait = Invoke-DashWindowsHttp -Uri $waitUri -HostLabel $config.HostLabel -Headers $headers -Method GET `
            -TimeoutMilliseconds $remainingMs
        if ($wait.StatusCode -eq 204) { continue }
        if ($wait.StatusCode -ne 200) { break }
        $result = $json.DeserializeObject($wait.Body)
        if ($result -isnot [System.Collections.IDictionary] -or -not $result.Contains('answers')) { break }
        $answer = [pscustomobject]@{ Answers = $result.answers; Source = 'owner'; Autopilot = $null }
        if ((Test-DashAnswerMap $answer.Answers $questions 'owner') -and
            (Write-DashDialogAnswer $toolInput $answer $config.HostLabel $session $deadlineMs $clock $holdDeadline $registration.expiresAt)) { $completed = $true }
        break
    }
}
catch {
    # No approval, response content, or hook input is logged on failure.
}
finally {
    if ($registrationAttempted -and -not $completed -and $null -ne $config -and $null -ne $session -and $null -ne $toolUse -and $null -ne $invocation) {
        try {
            $cancelUri = $config.HubBase + '/question/cancel?session=' + [Uri]::EscapeDataString($session) + '&toolUseId=' +
                [Uri]::EscapeDataString($toolUse) + '&question=' + [Uri]::EscapeDataString($invocation)
            $null = Invoke-DashWindowsHttp -Uri $cancelUri -HostLabel $config.HostLabel -Headers $headers -Method DELETE -TimeoutMilliseconds 2000
        }
        catch { }
    }
}
exit 0
