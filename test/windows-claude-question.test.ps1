[CmdletBinding()]
param([string]$RepositoryRoot = '')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $RepositoryRoot) { $RepositoryRoot = Split-Path -Parent $PSScriptRoot }
. (Join-Path $PSScriptRoot 'windows-claude-test-support.ps1')
Add-Type -AssemblyName System.Web.Extensions
$json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$json.MaxJsonLength = 2097152
$utf8 = New-Object System.Text.UTF8Encoding($false)
$passed = 0

function Assert-Question([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Get-QuestionHeader($Request, [string]$Name) {
    $property = $Request.Headers.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return [string]$property.Value
}


$custom = 'custom ' + [char]0x65E5 + "`nsecond line"
$payload = @{
    hook_event_name = 'PreToolUse'
    tool_name = 'AskUserQuestion'
    session_id = 'synthetic-question-session'
    tool_use_id = 'synthetic-tool-use'
    tool_input = @{
        questions = @(
            @{ question = 'Shade?'; header = 'Shade'; multiSelect = $false; options = @(
                @{ label = 'Blue (Recommended)'; description = 'First shade' },
                @{ label = 'Green'; description = 'Second shade' }
            ) },
            @{ question = 'shade?'; header = 'Features'; multiSelect = $true; options = @(
                @{ label = 'Logging'; description = 'Record activity' },
                @{ label = 'Metrics'; description = 'Measure activity' }
            ) },
            @{ question = 'Notes?'; header = 'Notes'; multiSelect = $false; options = @(
                @{ label = 'None'; description = 'No notes' },
                @{ label = 'Later'; description = 'Add later' }
            ) }
        )
        metadata = @{ marker = 'keep original input' }
    }
}
# Hashtable keys are case-insensitive in PowerShell; use JSON's real dictionary
# semantics for answers whose question texts differ only by case.
$validAnswers = $json.DeserializeObject('{"Shade?":"Blue (Recommended)","shade?":"Logging, Metrics","Notes?":""}')
$validAnswers['Notes?'] = $custom
$cases = @(
    @{ Name = 'exact multi-question labels and Unicode custom text'; Status = 200; Body = $json.Serialize(@{ answers = $validAnswers }); Allows = $true },
    @{ Name = 'incomplete answer falls back'; Status = 200; Body = '{"answers":{"Shade?":"Blue"}}'; Allows = $false },
    @{ Name = 'non-text answer falls back'; Status = 200; Body = '{"answers":{"Shade?":true,"shade?":"Logging","Notes?":"None"}}'; Allows = $false },
    @{ Name = 'malformed answer falls back'; Status = 200; Body = '{'; Allows = $false },
    @{ Name = 'wrong identity response falls back'; Status = 409; Body = '{}'; Allows = $false },
    @{ Name = 'registration rejection cancels possible controls'; Status = 200; Body = '{}'; Allows = $false; RegisterStatus = 503; NoWait = $true },
    @{ Name = 'extra answer question falls back'; Status = 200; Body = '{"answers":{"Shade?":"Blue","shade?":"Logging","Notes?":"None","Unexpected?":"Other"}}'; Allows = $false },
    @{ Name = 'timeout cancels remote controls'; Status = 204; Body = ''; Allows = $false; Delay = 1200; WaitSeconds = 2 },
    @{ Name = 'permission tools never register'; Status = 200; Body = '{}'; Allows = $false; Tool = 'ExitPlanMode'; NoRequests = $true },
    @{ Name = 'unrelated tool never registers'; Status = 200; Body = '{}'; Allows = $false; Tool = 'Bash'; NoRequests = $true },
    @{ Name = 'permission request events never register'; Status = 200; Body = '{}'; Allows = $false; Event = 'PermissionRequest'; NoRequests = $true },
    @{ Name = 'headless permission hosts never wait for hidden controls'; Status = 200; Body = '{}'; Allows = $false; Entrypoint = 'sdk-cli'; NoRequests = $true },
    @{ Name = 'disabled question mode never registers'; Status = 200; Body = '{}'; Allows = $false; Disabled = $true; NoRequests = $true }
)

foreach ($case in $cases) {
    $fixture = New-WindowsClaudeFixture -RepositoryRoot $RepositoryRoot
    try {
        $registerStatus = if ($case.RegisterStatus) { [int]$case.RegisterStatus } else { 201 }
        $fixture.Server = Start-WindowsClaudeHttpFixture -Directory $fixture.Root -Plans @{
            '/question/register' = @(@{ StatusCode = $registerStatus; Body = '{"questionId":"synthetic-question-identity","expiresAt":9999999999999}'; ContentType = 'application/json' })
            '/question/wait' = @(@{ StatusCode = $case.Status; Body = $case.Body; ContentType = 'application/json'; DelayMilliseconds = $case.Delay })
            '/question/cancel' = @(@{ StatusCode = 200; Body = '{"ok":true}'; ContentType = 'application/json' })
        }
        New-Item -ItemType Directory -Path $fixture.InstallPath -Force | Out-Null
        foreach ($name in @('windows-client-common.ps1', 'claude-question.ps1')) {
            Copy-Item -LiteralPath (Join-Path $RepositoryRoot ('scripts/' + $name)) -Destination (Join-Path $fixture.InstallPath $name)
        }
        $duration = if ($case.WaitSeconds) { $case.WaitSeconds } else { 10 }
        $config = @{
            ManagedBy = 'oh-my-dash-claude-windows'; SchemaVersion = 1
            HubBase = $fixture.Server.HubBase; HostLabel = $fixture.HostLabel
            ReplyWaitSeconds = 1; QuestionsEnabled = (-not $case.Disabled); QuestionWaitSeconds = $duration
        }
        [IO.File]::WriteAllText((Join-Path $fixture.InstallPath 'client-config.json'), ($config | ConvertTo-Json), $utf8)
        $inputBody = $json.DeserializeObject($json.Serialize($payload))
        if ($case.Tool) { $inputBody['tool_name'] = $case.Tool }
        if ($case.Event) { $inputBody['hook_event_name'] = $case.Event }
        $entrypoint = if ($case.Entrypoint) { $case.Entrypoint } else { 'cli' }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $result = Invoke-WindowsClaudeScript -ScriptPath (Join-Path $fixture.InstallPath 'claude-question.ps1') -Stdin ($json.Serialize($inputBody)) -TimeoutSeconds 15 -Environment @{ CLAUDE_CODE_ENTRYPOINT = $entrypoint }
        Assert-Question ($result.ExitCode -eq 0) ($case.Name + ': hook failed instead of returning to terminal: ' + $result.Stderr)
        Assert-Question ([string]::IsNullOrWhiteSpace($result.Stderr)) ($case.Name + ': failure disclosed hook data')
        $requests = @(Get-WindowsClaudeRequests -Fixture $fixture.Server)
        $registrationRequests = @($requests | Where-Object Path -eq '/question/register')
        $waitRequests = @($requests | Where-Object Path -eq '/question/wait')
        $cancelRequests = @($requests | Where-Object Path -eq '/question/cancel')
        if (-not $case.NoRequests) {
            $expectedWaitCount = if ($case.NoWait) { 0 } else { 1 }
            Assert-Question ($registrationRequests.Count -eq 1 -and $waitRequests.Count -eq $expectedWaitCount) ($case.Name + ': registration or wait count changed')
            $registration = $registrationRequests[0]
            $waitRequest = if ($case.NoWait) { $null } else { $waitRequests[0] }
            Assert-Question ($registration.Method -ceq 'POST' -and
                (Get-QuestionHeader $registration 'X-Dash-Entrypoint') -ceq 'cli' -and
                (Get-QuestionHeader $registration 'X-Dash-Host') -ceq $fixture.HostLabel) 'Question registration method or identity headers changed'
            if ($null -ne $waitRequest) {
                Assert-Question ($waitRequest.Method -ceq 'GET' -and
                    (Get-QuestionHeader $waitRequest 'X-Dash-Entrypoint') -ceq 'cli' -and
                    (Get-QuestionHeader $waitRequest 'X-Dash-Host') -ceq $fixture.HostLabel) 'Question wait method or identity headers changed'
            }
            $registerBody = $json.DeserializeObject($registration.Body)
            $invocation = $registerBody['invocationId']
            Assert-Question ($registerBody['sessionId'] -ceq $payload.session_id -and
                $registerBody['toolUseId'] -ceq $payload.tool_use_id -and
                $invocation -is [string] -and $invocation -cmatch '^[A-Za-z0-9_-]{43}$') 'Question registration identity changed'
            $invocationBytes = [Convert]::FromBase64String($invocation.Replace('-', '+').Replace('_', '/') + '=')
            Assert-Question ($invocationBytes.Length -eq 32) 'Question invocation identity was not 32 random bytes'
            Assert-Question ($registerBody['timeoutMs'] -eq ($duration * 1000)) 'Question registration timeout changed'
            $sentQuestions = @($registerBody['questions'])
            Assert-Question ($sentQuestions.Count -eq 3 -and
                $sentQuestions[0]['question'] -ceq 'Shade?' -and
                $sentQuestions[1]['question'] -ceq 'shade?' -and
                $sentQuestions[2]['question'] -ceq 'Notes?') 'Question text or ordering changed'
            Assert-Question ((@($sentQuestions[0]['options'] | ForEach-Object { $_['label'] }) -join '|') -ceq 'Blue (Recommended)|Green' -and
                $sentQuestions[1]['multiSelect'] -eq $true -and
                (@($sentQuestions[1]['options'] | ForEach-Object { $_['label'] }) -join '|') -ceq 'Logging|Metrics') 'Option labels, order or multi-select mode changed'
            if ($null -ne $waitRequest) {
                $waitUri = [Uri]::new('http://127.0.0.1' + $waitRequest.Target)
                $waitQueryNames = @($waitUri.Query.TrimStart('?').Split('&') | ForEach-Object { [Uri]::UnescapeDataString(($_ -split '=', 2)[0]) })
                Assert-Question (($waitQueryNames -join '|') -ceq 'session|toolUseId|question|wait' -and
                    (Get-WindowsClaudeQueryValue $waitUri.Query 'session') -ceq $payload.session_id -and
                    (Get-WindowsClaudeQueryValue $waitUri.Query 'toolUseId') -ceq $payload.tool_use_id -and
                    (Get-WindowsClaudeQueryValue $waitUri.Query 'question') -ceq $invocation) 'Wait used a different or incomplete invocation identity'
                $waitSeconds = 0
                Assert-Question ([int]::TryParse((Get-WindowsClaudeQueryValue $waitUri.Query 'wait'), [ref]$waitSeconds) -and
                    $waitSeconds -ge 1 -and $waitSeconds -le 55) 'Question wait interval was outside the hub contract'
            }
            if ($cancelRequests.Count -gt 0) {
                Assert-Question ($cancelRequests.Count -eq 1) 'Question fallback sent duplicate cancellation requests'
                $cancelRequest = $cancelRequests[0]
                $cancelUri = [Uri]::new('http://127.0.0.1' + $cancelRequest.Target)
                $cancelQueryNames = @($cancelUri.Query.TrimStart('?').Split('&') | ForEach-Object { [Uri]::UnescapeDataString(($_ -split '=', 2)[0]) })
                Assert-Question ($cancelRequest.Method -ceq 'DELETE' -and
                    [string]::IsNullOrEmpty($cancelRequest.Body) -and
                    ($cancelQueryNames -join '|') -ceq 'session|toolUseId|question' -and
                    (Get-WindowsClaudeQueryValue $cancelUri.Query 'session') -ceq $payload.session_id -and
                    (Get-WindowsClaudeQueryValue $cancelUri.Query 'toolUseId') -ceq $payload.tool_use_id -and
                    (Get-WindowsClaudeQueryValue $cancelUri.Query 'question') -ceq $invocation -and
                    (Get-QuestionHeader $cancelRequest 'X-Dash-Entrypoint') -ceq 'cli' -and
                    (Get-QuestionHeader $cancelRequest 'X-Dash-Host') -ceq $fixture.HostLabel) 'Question fallback cancelled a different invocation or used the wrong API contract'
            }
        }
        if ($case.Allows) {
            $output = $json.DeserializeObject($result.Stdout)
            $decision = $output['hookSpecificOutput']
            Assert-Question ($decision['permissionDecision'] -ceq 'allow' -and $decision['hookEventName'] -ceq 'PreToolUse') 'Answered question did not use the native hook contract'
            $updatedInput = $decision['updatedInput']
            $answers = $updatedInput['answers']
            Assert-Question ($answers.Count -eq 3 -and
                $answers['Shade?'] -ceq 'Blue (Recommended)' -and
                $answers['shade?'] -ceq 'Logging, Metrics' -and
                $answers['Notes?'] -ceq $custom) 'Question identity, multi-select or Unicode custom text changed'
            $updatedQuestions = @($updatedInput['questions'])
            Assert-Question ($updatedInput['metadata']['marker'] -ceq 'keep original input' -and
                $updatedQuestions.Count -eq 3 -and
                $updatedQuestions[0]['question'] -ceq 'Shade?' -and
                (@($updatedQuestions[0]['options'] | ForEach-Object { $_['label'] }) -join '|') -ceq 'Blue (Recommended)|Green' -and
                $updatedQuestions[1]['multiSelect'] -eq $true) 'Hook did not preserve the original tool input'
            Assert-Question (@($requests | Where-Object Path -eq '/question/cancel').Count -eq 0) 'Delivered answer was cancelled'
        }
        else {
            Assert-Question ([string]::IsNullOrWhiteSpace($result.Stdout)) ($case.Name + ': failure returned a hook decision')
            if ($case.NoRequests) {
                Assert-Question ($requests.Count -eq 0) ($case.Name + ': non-question path reached the broker')
            }
            else {
                $cancel = $cancelRequests
                Assert-Question ($cancel.Count -eq 1) ($case.Name + ': fallback did not invalidate remote controls')
            }
        }
        if ($case.WaitSeconds) { Assert-Question ($clock.Elapsed.TotalSeconds -lt 7) 'Remote question wait exceeded its bounded fallback window' }
        $passed++
        Write-Output ('PASS: ' + $case.Name)
    }
    finally {
        Remove-WindowsClaudeFixture -Fixture $fixture
    }
}
Write-Output ("Windows question boundary checks: $passed passed")
