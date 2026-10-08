$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-claude-test-support.ps1')

function Assert-Headless($Condition, [string]$Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

foreach ($launcher in @('local-headless', 'powershell', 'headless')) {
    $fixture = New-WindowsClaudeFixture
    try {
        $fixture.Server = Start-WindowsClaudeHttpFixture -Directory $fixture.Root
        [IO.File]::WriteAllText($fixture.SettingsPath, '{"model":"synthetic-preserved"}', [Text.UTF8Encoding]::new($false))
        $probePath = Join-Path $fixture.Root 'console-probe.ps1'
        $reportPath = Join-Path $fixture.Root 'console-observation.json'
        $probe = @'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ConsoleProbe {
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
"@
[pscustomobject]@{ Visible = [ConsoleProbe]::IsWindowVisible([ConsoleProbe]::GetConsoleWindow()); Session = (Get-Process -Id $PID).SessionId } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'console-observation.json') -Encoding UTF8
'{"agents":[{"sessionId":"synthetic-headless-session"}]}'
'@
        [IO.File]::WriteAllText($probePath, $probe, [Text.Encoding]::Unicode)
        $shim = '@echo off' + "`r`n" + '"' + $fixture.PowerShellExe + '" -NoProfile -ExecutionPolicy Bypass -File "%~dp0console-probe.ps1"' + "`r`n"
        [IO.File]::WriteAllText($fixture.ClaudePath, $shim, [Text.Encoding]::ASCII)
        $installer = Join-Path $fixture.RepositoryRoot 'scripts\install-claude-windows.ps1'
        $arguments = @('-HubUrl', $fixture.Server.HubBase, '-HostLabel', $fixture.HostLabel,
            '-SettingsPath', $fixture.SettingsPath, '-InstallPath', $fixture.InstallPath,
            '-ClaudePath', $fixture.ClaudePath, '-TaskName', $fixture.TaskName)
        $powershellArguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $fixture.InstallPath 'claude-liveness.ps1') + '"'
        $conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
        if ($launcher -eq 'powershell') {
            $action = New-ScheduledTaskAction -Execute $fixture.PowerShellExe -Argument $powershellArguments -WorkingDirectory $fixture.InstallPath
        } elseif ($launcher -eq 'local-headless') {
            $action = New-ScheduledTaskAction -Execute $conhost -Argument ('--headless ' + $fixture.PowerShellExe + ' ' + $powershellArguments)
        } else {
            $action = New-ScheduledTaskAction -Execute $conhost -Argument ('--headless "' + $fixture.PowerShellExe + '" ' + $powershellArguments) -WorkingDirectory $fixture.InstallPath
        }
        $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
        $trigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddHours(2)) -RepetitionInterval (New-TimeSpan -Minutes 3)
        Register-ScheduledTask -TaskName $fixture.TaskName -Action $action -Principal $principal -Trigger $trigger `
            -Settings (New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)) `
            -Description $fixture.ManagedTaskDescription | Out-Null
        [xml]$before = Export-ScheduledTask -TaskName $fixture.TaskName
        $dryRun = Invoke-WindowsClaudeScript -ScriptPath $installer -Arguments ($arguments + '-DryRun') -TimeoutSeconds 30
        Assert-Headless ($dryRun.ExitCode -eq 0) "$launcher upgrade preview accepts only the managed task: $($dryRun.Stderr)"
        Assert-Headless (-not (Test-Path -LiteralPath $fixture.InstallPath)) 'preview does not install helpers'
        Assert-Headless (([xml](Export-ScheduledTask -TaskName $fixture.TaskName)).OuterXml -ceq $before.OuterXml) 'preview preserves the task'
        $install = Invoke-WindowsClaudeScript -ScriptPath $installer -Arguments $arguments -TimeoutSeconds 60
        Assert-Headless ($install.ExitCode -eq 0) "$launcher upgrade succeeds: $($install.Stderr)"
        [xml]$after = Export-ScheduledTask -TaskName $fixture.TaskName
        foreach ($section in @('Principals', 'Triggers', 'Settings')) {
            Assert-Headless ($before.Task.$section.OuterXml -ceq $after.Task.$section.OuterXml) "$launcher upgrade preserves $section"
        }
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        do {
            $requests = @(Get-WindowsClaudeRequests $fixture.Server | Where-Object { $_.Path -eq '/ingest/liveness/claude' })
            if ($requests.Count -gt 0) { break }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $deadline)
        Assert-Headless ($requests.Count -eq 1) 'scheduled task delivers one liveness report through the installed helper'
        Assert-Headless ((ConvertFrom-Json $requests[0].Body).agents[0].sessionId -ceq 'synthetic-headless-session') 'scheduled report contains the actual child output'
        $observation = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
        Assert-Headless ($observation.Session -gt 0) 'probe executes in the signed-in desktop session'
        Assert-Headless ($observation.Visible -eq $false) 'scheduled CLI child has no visible console'
        Stop-ScheduledTask -TaskName $fixture.TaskName

        if ($launcher -eq 'headless') {
            $managedAction = (Get-ScheduledTask -TaskName $fixture.TaskName).Actions
            $settingsBefore = [Convert]::ToBase64String([IO.File]::ReadAllBytes($fixture.SettingsPath))
            $badActions = @(
                (New-ScheduledTaskAction -Execute $conhost -Argument ('--headless "' + $fixture.PowerShellExe + '" ' + $powershellArguments + ' -Unexpected') -WorkingDirectory $fixture.InstallPath),
                (New-ScheduledTaskAction -Execute $conhost -Argument ('--headless "C:\unrelated\powershell.exe" ' + $powershellArguments) -WorkingDirectory $fixture.InstallPath),
                (New-ScheduledTaskAction -Execute $conhost -Argument ('--headless "' + $fixture.PowerShellExe + '" ' + $powershellArguments) -WorkingDirectory $fixture.Root),
                (New-ScheduledTaskAction -Execute $fixture.PowerShellExe -Argument $powershellArguments)
            )
            foreach ($badAction in $badActions) {
                try {
                    Set-ScheduledTask -TaskName $fixture.TaskName -Action $badAction | Out-Null
                    $unownedXml = Export-ScheduledTask -TaskName $fixture.TaskName
                    foreach ($mode in @('install', 'uninstall')) {
                        $extra = if ($mode -eq 'uninstall') { @('-Uninstall') } else { @() }
                        $refused = Invoke-WindowsClaudeScript -ScriptPath $installer -Arguments ($arguments + $extra) -TimeoutSeconds 30
                        Assert-Headless ($refused.ExitCode -eq 1) "$mode refuses a changed task despite its managed description"
                        Assert-Headless ((Export-ScheduledTask -TaskName $fixture.TaskName) -ceq $unownedXml) 'refusal leaves task untouched'
                        Assert-Headless ([Convert]::ToBase64String([IO.File]::ReadAllBytes($fixture.SettingsPath)) -ceq $settingsBefore) 'refusal leaves settings untouched'
                    }
                } finally { Set-ScheduledTask -TaskName $fixture.TaskName -Action $managedAction | Out-Null }
            }
        }
        $uninstall = Invoke-WindowsClaudeScript -ScriptPath $installer -Arguments ($arguments + '-Uninstall') -TimeoutSeconds 60
        Assert-Headless ($uninstall.ExitCode -eq 0) 'headless task uninstalls'
        Assert-Headless ($null -eq (Get-ScheduledTask -TaskName $fixture.TaskName -ErrorAction SilentlyContinue)) 'uninstall removes the managed headless task'
    } finally { Remove-WindowsClaudeFixture $fixture }
}
Write-Output 'PASS: native headless polling, managed task migrations, preserved scheduling, and ownership refusals.'
