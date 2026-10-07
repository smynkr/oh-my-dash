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
    @{ Name = 'stale invocation falls back'; Status = 409; Body = '{}'; Allows = $false },
    @{ Name = 'timeout cancels remote controls'; Status = 204; Body = ''; Allows = $false; Delay = 1200; WaitSeconds = 2 },
    @{ Name = 'permission tools never register'; Status = 200; Body = '{}'; Allows = $false; Tool = 'ExitPlanMode'; NoRequests = $true },
    @{ Name = 'permission request events never register'; Status = 200; Body = '{}'; Allows = $false; Event = 'PermissionRequest'; NoRequests = $true },
    @{ Name = 'headless permission hosts never wait for hidden controls'; Status = 200; Body = '{}'; Allows = $false; Entrypoint = 'sdk-cli'; NoRequests = $true },
    @{ Name = 'disabled question mode never registers'; Status = 200; Body = '{}'; Allows = $false; Disabled = $true; NoRequests = $true }
)

foreach ($case in $cases) {
    $fixture = New-WindowsClaudeFixture -RepositoryRoot $RepositoryRoot
    try {
        $fixture.Server = Start-WindowsClaudeHttpFixture -Directory $fixture.Root -Plans @{
            '/question/register' = @(@{ StatusCode = 201; Body = '{"questionId":"synthetic-question-identity","expiresAt":9999999999999}'; ContentType = 'application/json' })
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
        if ($case.Allows) {
            $output = $json.DeserializeObject($result.Stdout)
            $decision = $output['hookSpecificOutput']
            Assert-Question ($decision['permissionDecision'] -ceq 'allow' -and $decision['hookEventName'] -ceq 'PreToolUse') 'Answered question did not use the native hook contract'
            $answers = $decision['updatedInput']['answers']
            Assert-Question ($answers['Shade?'] -ceq 'Blue (Recommended)' -and $answers['shade?'] -ceq 'Logging, Metrics' -and $answers['Notes?'] -ceq $custom) 'Question identity, multi-select or Unicode custom text changed'
            Assert-Question (@($requests | Where-Object Path -eq '/question/cancel').Count -eq 0) 'Delivered answer was cancelled'
        }
        else {
            Assert-Question ([string]::IsNullOrWhiteSpace($result.Stdout)) ($case.Name + ': failure returned a hook decision')
            if ($case.NoRequests) {
                Assert-Question ($requests.Count -eq 0) ($case.Name + ': non-question path reached the broker')
            }
            else {
                $cancel = @($requests | Where-Object Path -eq '/question/cancel')
                Assert-Question ($cancel.Count -eq 1) ($case.Name + ': fallback did not invalidate remote controls')
                $cancelBody = $json.DeserializeObject($cancel[0].Body)
                Assert-Question ($cancelBody['questionId'] -ceq 'synthetic-question-identity' -and $cancelBody['toolUseId'] -ceq $payload.tool_use_id) 'Fallback cancelled the wrong invocation'
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
