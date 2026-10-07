$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-claude-test-support.ps1')

function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
    $expectedJson = ConvertTo-Json -InputObject $Expected -Depth 100 -Compress
    $actualJson = ConvertTo-Json -InputObject $Actual -Depth 100 -Compress
    if ($expectedJson -cne $actualJson) {
        throw "Assertion failed: $Message`nExpected: $expectedJson`nActual:   $actualJson"
    }
}

function Get-InstallerArguments($Fixture, [string[]]$Extra = @()) {
    return @(
        '-HubUrl', $Fixture.Server.HubBase,
        '-HostLabel', $Fixture.HostLabel,
        '-SettingsPath', $Fixture.SettingsPath,
        '-InstallPath', $Fixture.InstallPath,
        '-ClaudePath', $Fixture.ClaudePath,
        '-TaskName', $Fixture.TaskName
    ) + $Extra
}

foreach ($failurePoint in @('Register-ScheduledTask', 'Start-ScheduledTask')) {
    foreach ($upgrade in @($false, $true)) {
        $rollbackFixture = New-WindowsClaudeFixture
        try {
            [IO.File]::WriteAllText($rollbackFixture.SettingsPath, '{"model":"synthetic-preserved"}', [Text.UTF8Encoding]::new($false))
            [IO.File]::WriteAllText($rollbackFixture.ClaudePath, "@echo off`r`nexit /b 7`r`n", [Text.Encoding]::ASCII)
            $rollbackInstaller = Join-Path $rollbackFixture.RepositoryRoot 'scripts\install-claude-windows.ps1'
            $rollbackArguments = @(
                '-HubUrl', 'http://127.0.0.1:1', '-HostLabel', $rollbackFixture.HostLabel,
                '-SettingsPath', $rollbackFixture.SettingsPath, '-InstallPath', $rollbackFixture.InstallPath,
                '-ClaudePath', $rollbackFixture.ClaudePath, '-TaskName', $rollbackFixture.TaskName
            )
            $taskXmlBefore = $null
            $activePaths = @($rollbackFixture.SettingsPath)
            if ($upgrade) {
                $initialInstall = Invoke-WindowsClaudeScript -ScriptPath $rollbackInstaller -Arguments $rollbackArguments -TimeoutSeconds 60
                Assert-Equal 0 $initialInstall.ExitCode 'rollback fixture installs before an upgrade'
                Stop-ScheduledTask -TaskName $rollbackFixture.TaskName -TaskPath '\'
                $taskXmlBefore = Export-ScheduledTask -TaskName $rollbackFixture.TaskName -TaskPath '\'
                $activePaths += @(Get-ChildItem -LiteralPath $rollbackFixture.InstallPath -File | ForEach-Object { $_.FullName })
                [IO.File]::AppendAllText((Join-Path $rollbackFixture.InstallPath 'claude-hook.ps1'), "`n# synthetic local helper edit`n")
            }
            $before = @{}
            foreach ($path in $activePaths) { $before[$path] = [BitConverter]::ToString([IO.File]::ReadAllBytes($path)) }
            $backupFilesBefore = @(Get-ChildItem -LiteralPath $rollbackFixture.Root -Filter '*.bak-dash-*' -Recurse -File)
            $expectedBackupPaths = @($rollbackFixture.SettingsPath)
            if ($upgrade) {
                $expectedBackupPaths = @(
                    (Join-Path $rollbackFixture.InstallPath 'claude-hook.ps1'),
                    (Join-Path $rollbackFixture.InstallPath 'client-config.json')
                )
            }

            $failureArguments = @($rollbackArguments)
            $failureArguments[3] = 'synthetic-changed-host'
            $wrapper = Join-Path $rollbackFixture.Root 'scheduler-failure.ps1'
            $source = "Import-Module ScheduledTasks`nfunction $failurePoint { throw 'Synthetic scheduler refusal' }`n& '" +
                $rollbackInstaller.Replace("'", "''") + "'"
            for ($index = 0; $index -lt $failureArguments.Count; $index += 2) {
                $source += ' ' + $failureArguments[$index] + " '" + $failureArguments[$index + 1].Replace("'", "''") + "'"
            }
            $source += "`nexit `$LASTEXITCODE"
            [IO.File]::WriteAllText($wrapper, $source, [Text.Encoding]::Unicode)
            $failedInstall = Invoke-WindowsClaudeScript -ScriptPath $wrapper -TimeoutSeconds 60
            Assert-Equal 1 $failedInstall.ExitCode "$failurePoint failure reports a failed install"
            Assert-True ($failedInstall.Stderr -match 'Synthetic scheduler refusal') 'scheduler refusal reaches the installation boundary'
            foreach ($path in $activePaths) {
                Assert-Equal $before[$path] ([BitConverter]::ToString([IO.File]::ReadAllBytes($path))) `
                    "$failurePoint failure restores existing settings, config and locally modified helpers"
            }
            $backupsAfterFailure = @(Get-ChildItem -LiteralPath $rollbackFixture.Root -Filter '*.bak-dash-*' -Recurse -File)
            Assert-Equal ($backupFilesBefore.Count + $expectedBackupPaths.Count) $backupsAfterFailure.Count `
                'failed installation creates backups only for replaced pre-existing files'
            foreach ($backupPath in $expectedBackupPaths) {
                $pathBackups = @($backupsAfterFailure | Where-Object {
                    $_.FullName.StartsWith($backupPath + '.bak-dash-', [StringComparison]::OrdinalIgnoreCase)
                })
                Assert-Equal 1 $pathBackups.Count 'rollback does not create a backup of generated intermediate content'
                Assert-Equal $before[$backupPath] ([BitConverter]::ToString([IO.File]::ReadAllBytes($pathBackups[0].FullName))) `
                    'failed install backup retains the original user-owned bytes'
            }
            $remainingTask = Get-ScheduledTask -TaskName $rollbackFixture.TaskName -TaskPath '\' -ErrorAction SilentlyContinue
            if ($upgrade) {
                Assert-True ($null -ne $remainingTask) 'failed upgrade retains the previous liveness task'
                Assert-Equal $taskXmlBefore (Export-ScheduledTask -TaskName $rollbackFixture.TaskName -TaskPath '\') `
                    'failed upgrade restores the previous task definition'
            }
            else {
                Assert-True ($null -eq $remainingTask) 'failed first installation leaves no liveness task'
                Assert-True (-not (Test-Path -LiteralPath (Join-Path $rollbackFixture.InstallPath 'client-config.json'))) `
                    'failed first installation leaves no active client configuration'
                Assert-True (-not (Test-Path -LiteralPath (Join-Path $rollbackFixture.InstallPath 'claude-hook.ps1'))) `
                    'failed first installation removes its new hook executable'
            }
        }
        finally { Remove-WindowsClaudeFixture $rollbackFixture }
    }
}

$failedFixture = New-WindowsClaudeFixture
try {
    [IO.File]::WriteAllText($failedFixture.SettingsPath, '{"model":"synthetic-preserved"}', [Text.UTF8Encoding]::new($false))
    [IO.File]::SetAttributes($failedFixture.SettingsPath, [IO.FileAttributes]::ReadOnly)
    [IO.File]::WriteAllText($failedFixture.ClaudePath, "@echo off`r`nexit /b 7`r`n", [Text.Encoding]::ASCII)
    $failedInstall = Invoke-WindowsClaudeScript -ScriptPath (Join-Path $failedFixture.RepositoryRoot 'scripts\install-claude-windows.ps1') -Arguments @(
        '-HubUrl', 'http://127.0.0.1:1', '-HostLabel', $failedFixture.HostLabel,
        '-SettingsPath', $failedFixture.SettingsPath, '-InstallPath', $failedFixture.InstallPath,
        '-ClaudePath', $failedFixture.ClaudePath, '-TaskName', $failedFixture.TaskName
    ) -TimeoutSeconds 60
    Assert-Equal 1 $failedInstall.ExitCode 'unwritable settings fail the installation'
    Assert-Equal '{"model":"synthetic-preserved"}' ([IO.File]::ReadAllText($failedFixture.SettingsPath)) 'failed replacement preserves settings'
    Assert-True (-not (Get-ScheduledTask -TaskName $failedFixture.TaskName -ErrorAction SilentlyContinue)) 'failed settings write never starts background collection'
}
finally {
    [IO.File]::SetAttributes($failedFixture.SettingsPath, [IO.FileAttributes]::Normal)
    Remove-WindowsClaudeFixture $failedFixture
}

$fixture = New-WindowsClaudeFixture
$fixture.Server = $null
$installer = Join-Path $fixture.RepositoryRoot 'scripts\install-claude-windows.ps1'
$installed = $false
$taskCreated = $false
$umlaut = [string][char]0x00E9
$snow = [string][char]0x96EA
$original = [ordered]@{
    model = 'synthetic-windows-model'
    futureSetting = [ordered]@{ enabled = $true; nested = @('preserve synthetic unknown value') }
    permissions = [ordered]@{ allow = @('Read(C:\synthetic\**)') }
    hooks = [ordered]@{
        PreToolUse = @(
            [ordered]@{
                matcher = 'Bash'
                hooks = @(
                    [ordered]@{ type = 'command'; command = 'keep synthetic unrelated hook'; timeout = 19 },
                    [ordered]@{ type = 'command'; command = 'keep synthetic command # dash-hook text' }
                )
            }
        )
        SessionStart = @()
        CustomEmptyEvent = @()
        CustomEvent = @([ordered]@{ hooks = @([ordered]@{ type = 'command'; command = 'keep synthetic custom hook' }) })
    }
}
$rawSettings = "`r`n    " + (ConvertTo-Json -InputObject $original -Depth 30 -Compress) + "`r`n"
[System.IO.File]::WriteAllText($fixture.SettingsPath, $rawSettings, [System.Text.UTF8Encoding]::new($false))

$fakeClaude = "@echo off`r`nif /I `"%~1`" NEQ `"agents`" exit /b 9`r`nif /I `"%~2`" NEQ `"--json`" exit /b 9`r`necho {`"agents`":[{`"sessionId`":`"synthetic-live-session`",`"pid`":321,`"cwd`":`"C:\\synthetic`",`"name`":`"native fixture`",`"status`":`"running`"}]}`r`nexit /b 0`r`n"
$fakeClaudeArray = "@echo off`r`necho [{`"sessionId`":`"synthetic-array-session`"}]`r`nexit /b 0`r`n"
 [System.IO.File]::WriteAllText($fixture.ClaudePath, "@echo off`r`nexit /b 7`r`n", [System.Text.Encoding]::ASCII)

try {
    $plans = @{
        '/reply/wait/claude' = @(
            [ordered]@{ StatusCode = 204; Body = ''; ContentType = 'text/plain'; DelayMilliseconds = 0 },
            [ordered]@{ StatusCode = 200; Body = ('synthetic reply ' + $snow); ContentType = 'text/plain'; DelayMilliseconds = 0 },
            [ordered]@{ StatusCode = 200; Body = 'second synthetic reply'; ContentType = 'text/plain'; DelayMilliseconds = 0 },
            [ordered]@{ StatusCode = 204; Body = ''; ContentType = 'text/plain'; DelayMilliseconds = 700 }
        )
    }
    $fixture.Server = Start-WindowsClaudeHttpFixture -Directory $fixture.Root -Plans $plans
    $settingsBeforeNoOpUninstall = [System.IO.File]::ReadAllBytes($fixture.SettingsPath)
    [System.IO.File]::SetAttributes($fixture.SettingsPath, [System.IO.FileAttributes]::ReadOnly)
    try {
        $noOpUninstall = Invoke-WindowsClaudeScript -ScriptPath $installer `
            -Arguments (Get-InstallerArguments $fixture @('-Uninstall')) -TimeoutSeconds 30
        Assert-Equal 0 $noOpUninstall.ExitCode 'uninstall with no Dash hooks succeeds on read-only settings'
        Assert-Equal ([System.BitConverter]::ToString($settingsBeforeNoOpUninstall)) `
            ([System.BitConverter]::ToString([System.IO.File]::ReadAllBytes($fixture.SettingsPath))) `
            'no-op uninstall preserves the exact settings bytes'
        Assert-Equal 0 (@(Get-ChildItem -LiteralPath $fixture.Root -Filter 'Claude settings *.json.bak-dash-*').Count) `
            'no-op uninstall creates no settings backup'
    }
    finally {
        [System.IO.File]::SetAttributes($fixture.SettingsPath, [System.IO.FileAttributes]::Normal)
    }
    $original.hooks['Stop'] = @([ordered]@{
        hooks = @([ordered]@{
            type = 'command'
            command = '"C:\synthetic\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\synthetic\claude-hook.ps1" -DashHookMarker "# dash-hook"'
        })
    })
    $rawSettings = "`r`n    " + (ConvertTo-Json -InputObject $original -Depth 30 -Compress) + "`r`n"
    [System.IO.File]::WriteAllText($fixture.SettingsPath, $rawSettings, [System.Text.UTF8Encoding]::new($false))
    $collisionAction = New-ScheduledTaskAction -Execute $fixture.PowerShellExe `
        -Argument $fixture.CollisionTaskArguments -WorkingDirectory $fixture.Root
    $collisionTrigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddHours(1))
    $collisionPrincipal = New-ScheduledTaskPrincipal `
        -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $fixture.TaskName -TaskPath '\' -Action $collisionAction `
        -Trigger $collisionTrigger -Principal $collisionPrincipal `
        -Description $fixture.CollisionTaskDescription | Out-Null
    $taskCreated = $true
    $beforeCollision = [System.BitConverter]::ToString([System.IO.File]::ReadAllBytes($fixture.SettingsPath))
    $collisionDryRun = Invoke-WindowsClaudeScript -ScriptPath $installer `
        -Arguments (Get-InstallerArguments $fixture @('-DryRun')) -TimeoutSeconds 30
    Assert-Equal 1 $collisionDryRun.ExitCode 'dry-run refuses an unrelated same-name scheduled task'
    $collisionInstall = Invoke-WindowsClaudeScript -ScriptPath $installer `
        -Arguments (Get-InstallerArguments $fixture) -TimeoutSeconds 30
    Assert-Equal 1 $collisionInstall.ExitCode 'installer refuses an unrelated same-name scheduled task'
    $collisionUninstall = Invoke-WindowsClaudeScript -ScriptPath $installer `
        -Arguments (Get-InstallerArguments $fixture @('-Uninstall')) -TimeoutSeconds 30
    Assert-Equal 1 $collisionUninstall.ExitCode 'uninstaller refuses an unrelated same-name scheduled task'
    Assert-Equal $beforeCollision ([System.BitConverter]::ToString([System.IO.File]::ReadAllBytes($fixture.SettingsPath))) 'task collision leaves settings bytes unchanged'
    Assert-True (-not (Test-Path -LiteralPath $fixture.InstallPath)) 'task collision creates no helper directory'
    Assert-Equal 0 (@(Get-ChildItem -LiteralPath $fixture.Root -Filter 'Claude settings *.json.bak-dash-*').Count) 'task collision creates no settings backup'
    $remainingCollision = Get-ScheduledTask -TaskName $fixture.TaskName -TaskPath '\' -ErrorAction Stop
    Assert-Equal $fixture.CollisionTaskDescription $remainingCollision.Description 'task collision keeps the unrelated task'
    Assert-Equal $fixture.CollisionTaskArguments $remainingCollision.Actions[0].Arguments 'task collision preserves the unrelated action'
    Assert-Equal ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) (Get-WindowsClaudeAccountSid $remainingCollision.Principal.UserId) 'task collision preserves the unrelated principal'
    Unregister-ScheduledTask -TaskName $fixture.TaskName -TaskPath '\' -Confirm:$false
    $taskCreated = $false


    $beforeDryRun = [System.BitConverter]::ToString([System.IO.File]::ReadAllBytes($fixture.SettingsPath))
    $dryRun = Invoke-WindowsClaudeScript -ScriptPath $installer `
        -Arguments (Get-InstallerArguments $fixture @('-DryRun')) -TimeoutSeconds 30
    Assert-Equal 0 $dryRun.ExitCode 'installer dry-run succeeds'
    Assert-True (-not (Test-Path -LiteralPath $fixture.InstallPath)) 'dry-run creates no helper directory'
    Assert-True (-not (Get-ScheduledTask -TaskName $fixture.TaskName -ErrorAction SilentlyContinue)) 'dry-run creates no scheduled task'
    Assert-Equal $beforeDryRun ([System.BitConverter]::ToString([System.IO.File]::ReadAllBytes($fixture.SettingsPath))) 'dry-run leaves settings bytes untouched'
    $dottedLabelArguments = @(
        '-HubUrl', $fixture.Server.HubBase,
        '-HostLabel', 'synthetic.windows.host',
        '-SettingsPath', $fixture.SettingsPath,
        '-InstallPath', $fixture.InstallPath,
        '-ClaudePath', $fixture.ClaudePath,
        '-TaskName', $fixture.TaskName,
        '-DryRun'
    )
    $dottedLabelFailure = Invoke-WindowsClaudeScript -ScriptPath $installer `
        -Arguments $dottedLabelArguments -TimeoutSeconds 30
    Assert-Equal 1 $dottedLabelFailure.ExitCode 'installer rejects a dotted host label rather than silently truncating it'
    Assert-True (-not (Test-Path -LiteralPath $fixture.InstallPath)) 'rejected dotted host label creates no helper directory'
    Assert-True (-not (Get-ScheduledTask -TaskName $fixture.TaskName -ErrorAction SilentlyContinue)) 'rejected dotted host label creates no scheduled task'
    Assert-Equal $beforeDryRun ([System.BitConverter]::ToString([System.IO.File]::ReadAllBytes($fixture.SettingsPath))) `
        'rejected dotted host label leaves settings bytes untouched'

    $install = Invoke-WindowsClaudeScript -ScriptPath $installer `
        -Arguments (Get-InstallerArguments $fixture) -TimeoutSeconds 60
    Assert-Equal 0 $install.ExitCode ('native installer succeeds: ' + $install.Stderr)
    $installed = $true
    $task = Get-ScheduledTask -TaskName $fixture.TaskName -ErrorAction Stop
    $taskCreated = $true

    $unregisterFailureWrapper = Join-Path $fixture.Root 'simulate-unregister-failure.ps1'
    $unregisterFailureScript = @'
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$ArgumentsJson
)
function Unregister-ScheduledTask {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([string]$TaskName, [string]$TaskPath)
    $errorRecord = [System.Management.Automation.ErrorRecord]::new(
        [System.UnauthorizedAccessException]::new('Synthetic access denied removing the task.'),
        'SyntheticUnregisterDenied',
        [System.Management.Automation.ErrorCategory]::PermissionDenied,
        $TaskName
    )
    $PSCmdlet.WriteError($errorRecord)
}
$installerArguments = @($ArgumentsJson | ConvertFrom-Json)
& $InstallerPath @installerArguments
'@
    [System.IO.File]::WriteAllText($unregisterFailureWrapper, $unregisterFailureScript, [System.Text.UTF8Encoding]::new($false))
    $settingsBeforeUnregisterFailure = [System.BitConverter]::ToString([System.IO.File]::ReadAllBytes($fixture.SettingsPath))
    $clientConfigPath = Join-Path $fixture.InstallPath 'client-config.json'
    $livenessHelperPath = Join-Path $fixture.InstallPath 'claude-liveness.ps1'
    try {
        $uninstallArgumentsJson = ConvertTo-Json -InputObject (Get-InstallerArguments $fixture @('-Uninstall')) -Compress
        $failedUnregister = Invoke-WindowsClaudeScript -ScriptPath $unregisterFailureWrapper `
            -Arguments @($installer, $uninstallArgumentsJson) -TimeoutSeconds 30
        Assert-Equal 1 $failedUnregister.ExitCode 'uninstall fails when owned liveness task removal fails'
        $remainingTask = Get-ScheduledTask -TaskName $fixture.TaskName -TaskPath '\' -ErrorAction Stop
        Assert-Equal $fixture.TaskName $remainingTask.TaskName 'failed task removal leaves the liveness task registered'
        Assert-Equal $settingsBeforeUnregisterFailure `
            ([System.BitConverter]::ToString([System.IO.File]::ReadAllBytes($fixture.SettingsPath))) `
            'failed task removal leaves Claude settings unchanged'
        Assert-True (Test-Path -LiteralPath $clientConfigPath -PathType Leaf) 'failed task removal preserves client config'
        Assert-True (Test-Path -LiteralPath $livenessHelperPath -PathType Leaf) 'failed task removal preserves the liveness helper'
    }
    finally {
        Remove-Item -LiteralPath $unregisterFailureWrapper -Force -ErrorAction SilentlyContinue
    }

    $task = Get-ScheduledTask -TaskName $fixture.TaskName -ErrorAction Stop
    Assert-Equal ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) (Get-WindowsClaudeAccountSid $task.Principal.UserId) 'liveness task runs as the installing user'
    $repeatingTriggers = @($task.Triggers | Where-Object { $_.Repetition.Interval -eq 'PT1M' })
    Assert-Equal 1 $repeatingTriggers.Count 'liveness uses a supported one-minute repeating trigger'
    Assert-True ([string]::IsNullOrEmpty([string]$repeatingTriggers[0].Repetition.Duration)) 'liveness repetition is indefinite'

    Assert-Equal 'Interactive' ([string]$task.Principal.LogonType) 'liveness task requires the signed-in user context'

    $settings = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($fixture.SettingsPath, [System.Text.Encoding]::UTF8))
    Assert-Equal $true $settings.futureSetting.enabled 'unknown future settings are preserved'
    Assert-Equal 'preserve synthetic unknown value' $settings.futureSetting.nested[0] 'nested unknown settings are preserved'
    Assert-Equal 'synthetic-windows-model' $settings.model 'model setting is preserved'
    Assert-Equal 'keep synthetic unrelated hook' $settings.hooks.PreToolUse[0].hooks[0].command 'unrelated event hook is preserved'
    Assert-Equal 'keep synthetic command # dash-hook text' $settings.hooks.PreToolUse[0].hooks[1].command `
        'unrelated commands containing the marker text are preserved'
    $legacyStopCommands = @(
        $settings.hooks.Stop |
            ForEach-Object { $_.hooks } |
            ForEach-Object { $_ } |
            Where-Object { $_.command -is [string] -and $_.command.Contains('# dash-hook') }
    )
    Assert-Equal 0 $legacyStopCommands.Count 'the previous Dash command-form hook is replaced'
    Assert-True ($settings.hooks.SessionStart.Count -gt 0) 'managed hook is installed into a pre-existing empty event array'
    Assert-True ($settings.hooks.CustomEmptyEvent.Count -eq 0) 'pre-existing empty event array is preserved'
    Assert-Equal 'keep synthetic custom hook' $settings.hooks.CustomEvent[0].hooks[0].command 'custom event hook is preserved'

    $backupFiles = @(Get-ChildItem -LiteralPath $fixture.Root -Filter 'Claude settings *.json.bak-dash-*')
    Assert-Equal 1 $backupFiles.Count 'first install backs up existing Claude settings'
    $saved = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($backupFiles[0].FullName, [System.Text.Encoding]::UTF8))
    Assert-Equal 'synthetic-windows-model' $saved.model 'settings backup contains the original document'

    $unchangedSettings = [System.IO.File]::ReadAllText($fixture.SettingsPath, [System.Text.Encoding]::UTF8)
    $repeat = Invoke-WindowsClaudeScript -ScriptPath $installer `
        -Arguments (Get-InstallerArguments $fixture) -TimeoutSeconds 60
    Assert-Equal 0 $repeat.ExitCode 'reinstall succeeds'
    Assert-Equal $unchangedSettings ([System.IO.File]::ReadAllText($fixture.SettingsPath, [System.Text.Encoding]::UTF8)) 'reinstall is byte-idempotent for settings'
    $backupCount = @(Get-ChildItem -LiteralPath $fixture.Root -Filter 'Claude settings *.json.bak-dash-*').Count
    Assert-Equal 1 $backupCount 'reinstall does not create a needless settings backup'

    $configPath = Join-Path $fixture.InstallPath 'client-config.json'
    $config = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($configPath, [System.Text.Encoding]::UTF8))
    Assert-True (@($config.EmptyHookEvents) -contains 'SessionStart') `
        'reinstall metadata retains an event array that was empty before installation'

    $hookText = 'synthetic Unicode prompt ' + $umlaut + ' ' + $snow
    $hookEvent = [ordered]@{
        session_id = 'synthetic-hook-session'
        hook_event_name = 'UserPromptSubmit'
        cwd = 'C:\synthetic project'
        prompt = $hookText
    }
    $hookInput = ConvertTo-Json -InputObject $hookEvent -Depth 10 -Compress
    $hookResult = Invoke-WindowsClaudeScript -ScriptPath (Join-Path $fixture.InstallPath 'claude-hook.ps1') `
        -Stdin $hookInput -TimeoutSeconds 20 -Environment @{
            CLAUDE_CODE_ENTRYPOINT = 'cli'
            CLAUDE_CODE_SESSION_ATTENDED = 'true'
            CLAUDE_CODE_SESSION_KIND = 'interactive'
        }
    Assert-Equal 0 $hookResult.ExitCode 'hook transport failure or success never fails the Claude turn'
    $hookRequest = @(Get-WindowsClaudeRequests $fixture.Server | Where-Object { $_.Path -eq '/ingest/claude' }) | Select-Object -Last 1
    Assert-True ($null -ne $hookRequest) 'hook posts lifecycle JSON to Claude ingest'
    Assert-Equal 'POST' $hookRequest.Method 'hook uses POST'
    Assert-Equal $hookInput $hookRequest.Body 'redirected UTF-8 JSON reaches the hub without a re-encoding loss'
    Assert-Equal $fixture.HostLabel $hookRequest.Headers.PSObject.Properties['X-Dash-Host'].Value 'hook binds configured host identity'
    Assert-Equal 'cli' $hookRequest.Headers.PSObject.Properties['X-Dash-Entrypoint'].Value 'hook forwards Claude entrypoint metadata'
    Assert-Equal 'true' $hookRequest.Headers.PSObject.Properties['X-Dash-Attended'].Value 'hook forwards attended metadata'
    Assert-Equal 'interactive' $hookRequest.Headers.PSObject.Properties['X-Dash-Kind'].Value 'hook forwards session-kind metadata'

    $redirectDirectory = Join-Path $fixture.Root 'redirect target'
    New-Item -ItemType Directory -Path $redirectDirectory -Force | Out-Null
    $fixture.RedirectServer = Start-WindowsClaudeHttpFixture -Directory $redirectDirectory
    Set-WindowsClaudePlans $fixture.Server @{
        '/ingest/claude' = @([ordered]@{
            StatusCode = 302
            Body = ''
            ContentType = 'text/plain'
            DelayMilliseconds = 0
            ResponseHeaders = [ordered]@{ Location = $fixture.RedirectServer.HubBase + '/redirect-target' }
        })
    }
    $redirectHook = Invoke-WindowsClaudeScript -ScriptPath (Join-Path $fixture.InstallPath 'claude-hook.ps1') `
        -Stdin $hookInput -TimeoutSeconds 20
    Assert-Equal 0 $redirectHook.ExitCode 'redirect refusal does not fail the Claude turn'
    $redirectRequests = @(Get-WindowsClaudeRequests $fixture.RedirectServer).Count
    Assert-Equal 0 $redirectRequests 'hook transcript and host identity are never forwarded across a redirect'
    Set-WindowsClaudePlans $fixture.Server $plans

    $config.HubBase = 'http://127.0.0.1:1'
    [System.IO.File]::WriteAllText($configPath, (ConvertTo-Json -InputObject $config -Depth 10) + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    $offlineHook = Invoke-WindowsClaudeScript -ScriptPath (Join-Path $fixture.InstallPath 'claude-hook.ps1') `
        -Stdin $hookInput -TimeoutSeconds 10
    Assert-Equal 0 $offlineHook.ExitCode 'hub transport failures never fail a Claude turn'
    $config.HubBase = $fixture.Server.HubBase
    [System.IO.File]::WriteAllText($configPath, (ConvertTo-Json -InputObject $config -Depth 10) + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

    $replyInput = '{"session_id":"synthetic-reply-session"}'
    $waiterPath = Join-Path $fixture.InstallPath 'reply-wait.ps1'
    $replyOne = Invoke-WindowsClaudeScript -ScriptPath $waiterPath -Stdin $replyInput -TimeoutSeconds 10
    Assert-Equal 2 $replyOne.ExitCode 'a reply exits with asyncRewake status 2'
    Assert-Equal '' $replyOne.Stdout 'reply text is not printed to stdout'
    Assert-Equal ('synthetic reply ' + $snow) $replyOne.Stderr 'reply is written to stderr as UTF-8'
    $replyTwo = Invoke-WindowsClaudeScript -ScriptPath $waiterPath -Stdin $replyInput -TimeoutSeconds 10
    Assert-Equal 2 $replyTwo.ExitCode 'subsequent reply still wakes Claude'
    Assert-Equal 'second synthetic reply' $replyTwo.Stderr 'second reply body is preserved'
    $waitRequests = @(Get-WindowsClaudeRequests $fixture.Server | Where-Object { $_.Path -eq '/reply/wait/claude' })
    Assert-True ($waitRequests.Count -ge 3) 'waiter polls again after HTTP 204'
    $firstQuery = [System.Uri]::new('http://127.0.0.1' + $waitRequests[0].Target)
    $secondQuery = [System.Uri]::new('http://127.0.0.1' + $waitRequests[2].Target)
    $firstWaiter = Get-WindowsClaudeQueryValue $firstQuery.Query 'waiter'
    $secondWaiter = Get-WindowsClaudeQueryValue $secondQuery.Query 'waiter'
    Assert-True ($firstWaiter -match '^[a-f0-9]{32}$' -and $secondWaiter -match '^[a-f0-9]{32}$') 'waiter ids are unique 128-bit values'
    Assert-True ($firstWaiter -cne $secondWaiter) 'each stopped turn receives a fresh waiter id'
    Assert-Equal 'synthetic-reply-session' (Get-WindowsClaudeQueryValue $firstQuery.Query 'session') 'waiter binds the requested session'
    Assert-Equal $fixture.HostLabel $waitRequests[0].Headers.PSObject.Properties['X-Dash-Host'].Value 'reply waiter binds configured host identity'
    $requestsBeforeInvalidInput = $waitRequests.Count
    $invalidWait = Invoke-WindowsClaudeScript -ScriptPath $waiterPath -Stdin '{}' -TimeoutSeconds 10
    Assert-Equal 0 $invalidWait.ExitCode 'missing session id safely exits'
    $waitRequestsAfterInvalidInput = @(Get-WindowsClaudeRequests $fixture.Server | Where-Object { $_.Path -eq '/reply/wait/claude' }).Count
    Assert-Equal $requestsBeforeInvalidInput $waitRequestsAfterInvalidInput 'invalid hook input creates no waiter request'

    $config.ReplyWaitSeconds = 1
    [System.IO.File]::WriteAllText($configPath, (ConvertTo-Json -InputObject $config -Depth 10) + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $timeoutResult = Invoke-WindowsClaudeScript -ScriptPath $waiterPath -Stdin $replyInput -TimeoutSeconds 5
    $clock.Stop()
    Assert-Equal 0 $timeoutResult.ExitCode 'reply timeout is a harmless terminal result'
    Assert-True ($clock.Elapsed.TotalSeconds -lt 5) 'network waits remain bounded by the overall deadline'
    Assert-Equal '' $timeoutResult.Stderr 'timeouts never write an empty reply'


    Set-WindowsClaudePlans $fixture.Server @{
        '/reply/wait/claude' = @(@{ StatusCode = 200; Body = 'late synthetic reply'; ContentType = 'text/plain'; BodyByteDelayMilliseconds = 120 })
    }
    $slowReply = Invoke-WindowsClaudeScript -ScriptPath $waiterPath -Stdin $replyInput -TimeoutSeconds 6
    Assert-Equal 0 $slowReply.ExitCode 'a response trickling past the reply deadline must not wake Claude'
    Assert-Equal '' $slowReply.Stderr 'a late partial reply never reaches the model'
    Set-WindowsClaudePlans $fixture.Server $plans
    [System.IO.File]::WriteAllText($fixture.ClaudePath, $fakeClaude, [System.Text.Encoding]::ASCII)
    $livenessPath = Join-Path $fixture.InstallPath 'claude-liveness.ps1'
    $livenessResult = Invoke-WindowsClaudeScript -ScriptPath $livenessPath -TimeoutSeconds 20
    Assert-Equal 0 $livenessResult.ExitCode 'valid Claude agents output reports liveness'
    $livenessRequests = @(Get-WindowsClaudeRequests $fixture.Server | Where-Object { $_.Path -eq '/ingest/liveness/claude' })
    Assert-True ($livenessRequests.Count -ge 1) 'valid CLI result sends liveness reports'
    Assert-Equal 'synthetic-live-session' (ConvertFrom-Json -InputObject $livenessRequests[0].Body).agents[0].sessionId 'liveness report retains the active session'
    Assert-Equal $fixture.HostLabel $livenessRequests[0].Headers.PSObject.Properties['X-Dash-Host'].Value 'liveness binds configured host identity'

    [System.IO.File]::WriteAllText($fixture.ClaudePath, $fakeClaudeArray, [System.Text.Encoding]::ASCII)
    $arrayResult = Invoke-WindowsClaudeScript -ScriptPath $livenessPath -TimeoutSeconds 20
    Assert-Equal 0 $arrayResult.ExitCode 'single-agent JSON array output reports liveness'
    $arrayRequest = @(Get-WindowsClaudeRequests $fixture.Server | Where-Object { $_.Path -eq '/ingest/liveness/claude' }) | Select-Object -Last 1
    Assert-True ($arrayRequest.Body.StartsWith('[')) 'single-agent root arrays stay arrays instead of being dropped as malformed'
    $arrayAgents = @(ConvertFrom-Json -InputObject $arrayRequest.Body)
    Assert-Equal 'synthetic-array-session' $arrayAgents[0].sessionId 'single-agent array preserves its session id'

    $unicodeCwd = 'C:\synthetic\' + $snow
    $unicodeName = 'session ' + $umlaut
    $unicodeAgents = ConvertTo-Json -Compress -Depth 4 @{ agents = @(@{ sessionId = 'synthetic-unicode-session'; cwd = $unicodeCwd; name = $unicodeName }) }
    $encodedBody = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($unicodeAgents))
    $emit = '$bytes=[Convert]::FromBase64String("' + $encodedBody + '");[Console]::OpenStandardOutput().Write($bytes,0,$bytes.Length)'
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($emit))
    [IO.File]::WriteAllText($fixture.ClaudePath, "@echo off`r`npowershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand $encodedCommand`r`nexit /b 0`r`n", [Text.Encoding]::ASCII)
    $unicodeWrapper = Join-Path $fixture.Root 'unicode-liveness.ps1'
    [IO.File]::WriteAllText($unicodeWrapper, 'param([string]$Helper);[Console]::OutputEncoding=[Text.Encoding]::GetEncoding(437);& $Helper', [Text.Encoding]::ASCII)
    $unicodeResult = Invoke-WindowsClaudeScript -ScriptPath $unicodeWrapper -Arguments @('-Helper', $livenessPath) -TimeoutSeconds 20
    Assert-Equal 0 $unicodeResult.ExitCode 'non-UTF-8 console environments accept UTF-8 Claude output'
    $unicodeRequest = @(Get-WindowsClaudeRequests $fixture.Server | Where-Object { $_.Path -eq '/ingest/liveness/claude' }) | Select-Object -Last 1
    $unicodeAgent = (ConvertFrom-Json $unicodeRequest.Body).agents[0]
    Assert-Equal $unicodeCwd $unicodeAgent.cwd 'liveness preserves the Unicode working directory'
    Assert-Equal $unicodeName $unicodeAgent.name 'liveness preserves the Unicode session name'
    $livenessRequests = @(Get-WindowsClaudeRequests $fixture.Server | Where-Object { $_.Path -eq '/ingest/liveness/claude' })

    [System.IO.File]::WriteAllText($fixture.ClaudePath, "@echo off`r`nexit /b 7`r`n", [System.Text.Encoding]::ASCII)
    $livenessBeforeFailure = $livenessRequests.Count
    $failedCli = Invoke-WindowsClaudeScript -ScriptPath $livenessPath -TimeoutSeconds 20
    Assert-Equal 0 $failedCli.ExitCode 'CLI failure is safe for the scheduled task'
    $livenessAfterFailure = @(Get-WindowsClaudeRequests $fixture.Server | Where-Object { $_.Path -eq '/ingest/liveness/claude' }).Count
    Assert-Equal $livenessBeforeFailure $livenessAfterFailure 'failed CLI never posts a false empty session list'
    [System.IO.File]::WriteAllText($fixture.ClaudePath, "@echo off`r`necho malformed output`r`nexit /b 0`r`n", [System.Text.Encoding]::ASCII)
    $livenessBeforeMalformed = @(Get-WindowsClaudeRequests $fixture.Server | Where-Object { $_.Path -eq '/ingest/liveness/claude' }).Count
    $malformedCli = Invoke-WindowsClaudeScript -ScriptPath $livenessPath -TimeoutSeconds 20
    Assert-Equal 0 $malformedCli.ExitCode 'malformed successful CLI output is safe'
    $livenessAfterMalformed = @(Get-WindowsClaudeRequests $fixture.Server | Where-Object { $_.Path -eq '/ingest/liveness/claude' }).Count
    Assert-Equal $livenessBeforeMalformed $livenessAfterMalformed 'malformed output never posts a false empty list'
    [System.IO.File]::WriteAllText($fixture.ClaudePath, "@echo off`r`necho []`r`nexit /b 0`r`n", [System.Text.Encoding]::ASCII)

    $emptyCli = Invoke-WindowsClaudeScript -ScriptPath $livenessPath -TimeoutSeconds 20
    Assert-Equal 0 $emptyCli.ExitCode 'valid empty liveness result is allowed'
    $livenessAfterEmpty = @(Get-WindowsClaudeRequests $fixture.Server | Where-Object { $_.Path -eq '/ingest/liveness/claude' })
    Assert-Equal ($livenessBeforeFailure + 1) $livenessAfterEmpty.Count 'only an explicit valid empty array is posted as no active agents'
    Assert-Equal '[]' $livenessAfterEmpty[-1].Body 'valid empty result remains an empty JSON array'

    $unrelatedFile = Join-Path $fixture.InstallPath 'keep unrelated local file.txt'
    [System.IO.File]::WriteAllText($unrelatedFile, 'synthetic unrelated', [System.Text.Encoding]::UTF8)
    $modifiedHelper = Join-Path $fixture.InstallPath 'windows-client-common.ps1'
    [System.IO.File]::AppendAllText($modifiedHelper, [Environment]::NewLine + '# synthetic user modification', [System.Text.Encoding]::UTF8)
    $uninstall = Invoke-WindowsClaudeScript -ScriptPath $installer `
        -Arguments (Get-InstallerArguments $fixture @('-Uninstall')) -TimeoutSeconds 60
    Assert-Equal 0 $uninstall.ExitCode 'uninstaller succeeds'
    $installed = $false
    $taskCreated = $false
    Assert-True (-not (Get-ScheduledTask -TaskName $fixture.TaskName -ErrorAction SilentlyContinue)) 'uninstall removes only its liveness task'
    $restored = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($fixture.SettingsPath, [System.Text.Encoding]::UTF8))
    Assert-Equal $true $restored.futureSetting.enabled 'uninstall preserves unknown future settings'
    Assert-Equal 'preserve synthetic unknown value' $restored.futureSetting.nested[0] 'uninstall preserves nested unknown settings'
    Assert-True ($restored.hooks.CustomEmptyEvent.Count -eq 0) 'uninstall preserves unrelated empty event array'
    Assert-Equal 'keep synthetic unrelated hook' $restored.hooks.PreToolUse[0].hooks[0].command 'uninstall preserves the unrelated hook'
    Assert-Equal 0 $restored.hooks.SessionStart.Count 'uninstall restores a previously empty managed event array'
    Assert-Equal 'keep synthetic command # dash-hook text' $restored.hooks.PreToolUse[0].hooks[1].command `
        'uninstall preserves unrelated commands containing the marker text'
    Assert-Equal 'keep synthetic custom hook' $restored.hooks.CustomEvent[0].hooks[0].command 'uninstall preserves unrelated custom event hook'
    Assert-True (Test-Path -LiteralPath $unrelatedFile) 'uninstall preserves unrelated files in install directory'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fixture.InstallPath 'claude-hook.ps1'))) 'uninstall removes an unmodified managed helper'
    Assert-True (Test-Path -LiteralPath $modifiedHelper) 'uninstall preserves modified managed helpers'

    $noReplyInstall = Invoke-WindowsClaudeScript -ScriptPath $installer `
        -Arguments (Get-InstallerArguments $fixture @('-NoReply')) -TimeoutSeconds 60
    Assert-Equal 0 $noReplyInstall.ExitCode 'no-reply configuration installs'
    $installed = $true
    $finalUninstall = Invoke-WindowsClaudeScript -ScriptPath $installer `
        -Arguments (Get-InstallerArguments $fixture @('-Uninstall')) -TimeoutSeconds 60
    Assert-Equal 0 $finalUninstall.ExitCode 'no-reply install uninstalls cleanly'
    $installed = $false
    $taskCreated = $false

    Write-Output 'PASS: native Windows Claude install, lifecycle hook, reply waiter, liveness, and rollback scenarios.'
}
finally {
    if ($installed -or $taskCreated) {
        try {
            Invoke-WindowsClaudeScript -ScriptPath $installer `
                -Arguments (Get-InstallerArguments $fixture @('-Uninstall')) -TimeoutSeconds 60 | Out-Null
        }
        catch {
            # Remove-WindowsClaudeFixture unregisters only fixture-owned tasks.
        }
    }
    Remove-WindowsClaudeFixture $fixture
}
