# Run in the extracted WeNote Windows acceptance bundle.
$ErrorActionPreference = 'Stop'
$work = Join-Path ([IO.Path]::GetTempPath()) ('wenote-test-' + [Guid]::NewGuid())
$originBefore = $env:WENOTE_TEST_ORIGIN
$api = $null
$desktop = $null
New-Item -ItemType Directory -Path $work | Out-Null
try {
    Get-Content (Join-Path $PSScriptRoot 'BUILD.txt')
    Write-Output ([Environment]::OSVersion.VersionString)
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $addr = "127.0.0.1:$port"
    $env:WENOTE_TEST_ORIGIN = "http://$addr"
    $api = Start-Process (Join-Path $PSScriptRoot 'wenote-api.exe') -ArgumentList '-addr', $addr -WorkingDirectory $work -PassThru -WindowStyle Hidden
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        if ($api.HasExited) { throw "API exited with code $($api.ExitCode)" }
        try {
            $response = Invoke-WebRequest -Uri "$env:WENOTE_TEST_ORIGIN/healthz" -UseBasicParsing -TimeoutSec 1
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 200
    }
    if (!$ready) { throw 'Temporary local API did not start' }
    $suite = Join-Path $PSScriptRoot 'two-devices.exe'
    $tests = & $suite --list
    if ($LASTEXITCODE -ne 0 -or $tests -notcontains 'two_devices_and_web_converge: test') { throw 'Native sync test is missing' }
    & $suite --ignored --exact two_devices_and_web_converge --nocapture
    if ($LASTEXITCODE -ne 0) { throw "Desktop sync acceptance failed ($LASTEXITCODE)" }
    $desktop = Start-Process (Join-Path $PSScriptRoot 'WeNote.exe') -WorkingDirectory $work -PassThru
    for ($i = 0; $i -lt 100; $i++) {
        $desktop.Refresh()
        if ($desktop.HasExited) { throw "WeNote exited with code $($desktop.ExitCode)" }
        if ($desktop.MainWindowHandle -ne 0) { break }
        Start-Sleep -Milliseconds 200
    }
    if ($desktop.MainWindowHandle -eq 0) { throw 'WeNote did not open a native window' }
    Write-Output 'PASS: Native Windows desktop window and two-device sync acceptance'
} finally {
    foreach ($child in @($desktop, $api)) {
        if ($null -ne $child -and !$child.HasExited) { $child.Kill(); $child.WaitForExit() }
    }
    $env:WENOTE_TEST_ORIGIN = $originBefore
    Remove-Item -LiteralPath $work -Recurse -Force
}
