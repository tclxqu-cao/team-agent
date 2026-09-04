$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$NodeVersion = "22.22.0"
$AgentRoamVersion = "0.2.0-preview.9"
$NodeArchive = "node-v22.22.0-win-x64.zip"
$NodeSha256 = "c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a"
$NodeUrl = "https://nodejs.org/dist/v22.22.0/$NodeArchive"
$NpmRegistry = "https://registry.npmjs.org"
$DataDir = if ($env:AGENTROAM_DATA_DIR) { $env:AGENTROAM_DATA_DIR } else { Join-Path $HOME ".agentroam" }
$NodeParent = Join-Path $DataDir "runtimes\node"
$NodeRoot = Join-Path $NodeParent $NodeVersion
$NodeLock = "$NodeRoot.lock"
$LauncherParent = Join-Path $DataDir "launcher"
$LauncherRoot = Join-Path $LauncherParent $AgentRoamVersion
$LauncherLock = "$LauncherRoot.lock"
$WrapperDir = Join-Path $HOME ".agentroam\bin"
$WrapperPath = Join-Path $WrapperDir "agentroam.cmd"
$ServiceRootExplicit = -not [string]::IsNullOrWhiteSpace($env:AGENTROAM_ROOT)
$ServiceRoot = if ($ServiceRootExplicit) { $env:AGENTROAM_ROOT } else { (Get-Location).Path }
if (-not (Test-Path -LiteralPath $ServiceRoot -PathType Container)) { throw "AgentRoam root is not a directory: $ServiceRoot" }
$ServiceRoot = [System.IO.Path]::GetFullPath($ServiceRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$HomeRoot = [System.IO.Path]::GetFullPath($HOME).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
if (-not $ServiceRootExplicit -and $ServiceRoot -eq $HomeRoot) {
  throw "Refusing to expose the entire home directory implicitly; run from a project directory or set AGENTROAM_ROOT explicitly"
}

New-Item -ItemType Directory -Force -Path $NodeParent, $LauncherParent, $WrapperDir | Out-Null

function Test-Node22([string]$NodeBin) {
  if (-not (Test-Path -LiteralPath $NodeBin -PathType Leaf)) { return $false }
  try { return (& $NodeBin -p 'process.versions.node.split(".")[0]' 2>$null) -eq "22" } catch { return $false }
}

function Test-ManagedNode {
  $NodeBin = Join-Path $NodeRoot "node.exe"
  $NpmCli = Join-Path $NodeRoot "node_modules\npm\bin\npm-cli.js"
  if (-not (Test-Path -LiteralPath $NodeBin -PathType Leaf) -or -not (Test-Path -LiteralPath $NpmCli -PathType Leaf)) { return $false }
  try { return (& $NodeBin --version 2>$null) -eq "v$NodeVersion" } catch { return $false }
}

function Enter-InstallLock([string]$Path) {
  $Deadline = [DateTime]::UtcNow.AddMinutes(15)
  while ($true) {
    try {
      $Stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      $Bytes = [Text.Encoding]::UTF8.GetBytes("$PID`n$([DateTime]::UtcNow.ToString('o'))`n")
      $Stream.Write($Bytes, 0, $Bytes.Length)
      return $Stream
    } catch [System.IO.IOException] {
      if (Test-Path -LiteralPath $Path) {
        $Age = [DateTime]::UtcNow - (Get-Item -LiteralPath $Path).LastWriteTimeUtc
        if ($Age.TotalMinutes -gt 15) { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue; continue }
      }
      if ([DateTime]::UtcNow -ge $Deadline) { throw "Timed out waiting for install lock $Path" }
      Start-Sleep -Milliseconds 500
    }
  }
}

$SystemNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($env:AGENTROAM_BOOTSTRAP_TEST -eq "1" -and $env:AGENTROAM_FORCE_PRIVATE_NODE -eq "1") { $SystemNode = $null }
if ($SystemNode -and (Test-Node22 $SystemNode.Source)) {
  $NodeBin = $SystemNode.Source
} else {
  if (-not (Test-ManagedNode)) {
    $NodeLockHandle = Enter-InstallLock $NodeLock
    try {
      if (-not (Test-ManagedNode)) {
        $TempRoot = Join-Path $NodeParent ".node-$NodeVersion-$PID-$([Guid]::NewGuid().ToString('N'))"
        $ArchivePath = Join-Path $TempRoot $NodeArchive
        $ExtractPath = Join-Path $TempRoot "extract"
        New-Item -ItemType Directory -Force -Path $ExtractPath | Out-Null
        try {
          Write-Host "Downloading Node.js $NodeVersion..."
          if ($env:AGENTROAM_NODE_ARCHIVE_FILE) {
            Copy-Item -LiteralPath $env:AGENTROAM_NODE_ARCHIVE_FILE -Destination $ArchivePath
          } else {
            Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 -Uri $NodeUrl -OutFile $ArchivePath
          }
          $ActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash.ToLowerInvariant()
          if ($ActualHash -ne $NodeSha256) { throw "Node.js archive checksum mismatch" }
          Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractPath -Force
          $Entries = @(Get-ChildItem -LiteralPath $ExtractPath)
          if ($Entries.Count -ne 1 -or $Entries[0].Name -ne "node-v$NodeVersion-win-x64") { throw "Unexpected Node.js archive layout" }
          $Extracted = $Entries[0].FullName
          $ExtractedNode = Join-Path $Extracted "node.exe"
          $ExtractedNpm = Join-Path $Extracted "node_modules\npm\bin\npm-cli.js"
          if (-not (Test-Path -LiteralPath $ExtractedNpm) -or (& $ExtractedNode --version) -ne "v$NodeVersion") { throw "Node.js runtime validation failed" }
          Remove-Item -LiteralPath $NodeRoot -Recurse -Force -ErrorAction SilentlyContinue
          Move-Item -LiteralPath $Extracted -Destination $NodeRoot
          if (-not (Test-ManagedNode)) { throw "Node.js activation validation failed" }
        } finally {
          Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
      }
    } finally {
      $NodeLockHandle.Dispose()
      Remove-Item -LiteralPath $NodeLock -Force -ErrorAction SilentlyContinue
    }
  }
  $NodeBin = Join-Path $NodeRoot "node.exe"
}

$NodeDirectory = Split-Path -Parent $NodeBin
$NpmCandidates = @(
  (Join-Path $NodeDirectory "node_modules\npm\bin\npm-cli.js"),
  (Join-Path $NodeDirectory "..\node_modules\npm\bin\npm-cli.js")
)
$NpmCli = $NpmCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $NpmCli) { throw "npm CLI was not found beside $NodeBin" }

$PackageSpec = "agentroam@$AgentRoamVersion"
$ExtraPackageSpecs = @()
if ($env:AGENTROAM_BOOTSTRAP_TEST -eq "1" -and $env:AGENTROAM_PACKAGE_SPEC) {
  $PackageSpec = $env:AGENTROAM_PACKAGE_SPEC
  if ($env:AGENTROAM_BOOTSTRAP_EXTRA_SPECS) { $ExtraPackageSpecs = @($env:AGENTROAM_BOOTSTRAP_EXTRA_SPECS.Split(';') | Where-Object { $_ }) }
}
$Entry = Join-Path $LauncherRoot "node_modules\agentroam\bin\agentroam.mjs"

function Test-Launcher {
  if (-not (Test-Path -LiteralPath $Entry -PathType Leaf)) { return $false }
  try {
    $Output = & $NodeBin $Entry version 2>$null
    return $LASTEXITCODE -eq 0 -and $Output -match [Regex]::Escape($AgentRoamVersion)
  } catch { return $false }
}

if (-not (Test-Launcher)) {
  $LauncherLockHandle = Enter-InstallLock $LauncherLock
  try {
    if (-not (Test-Launcher)) {
      $TempLauncher = Join-Path $LauncherParent ".launcher-$AgentRoamVersion-$PID-$([Guid]::NewGuid().ToString('N'))"
      try {
        $NpmArgs = @("install", "--no-audit", "--no-fund", "--registry", $NpmRegistry, "--prefix", $TempLauncher) + $ExtraPackageSpecs + @($PackageSpec)
        & $NodeBin $NpmCli @NpmArgs
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
        $TempEntry = Join-Path $TempLauncher "node_modules\agentroam\bin\agentroam.mjs"
        $VersionOutput = & $NodeBin $TempEntry version
        if ($LASTEXITCODE -ne 0 -or $VersionOutput -notmatch [Regex]::Escape($AgentRoamVersion)) { throw "AgentRoam version validation failed" }
        Remove-Item -LiteralPath $LauncherRoot -Recurse -Force -ErrorAction SilentlyContinue
        Move-Item -LiteralPath $TempLauncher -Destination $LauncherRoot
      } finally {
        Remove-Item -LiteralPath $TempLauncher -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
  } finally {
    $LauncherLockHandle.Dispose()
    Remove-Item -LiteralPath $LauncherLock -Force -ErrorAction SilentlyContinue
  }
}

$WrapperTemp = "$WrapperPath.$PID.tmp"
$WrapperContent = "@echo off`r`n`"$NodeBin`" `"$Entry`" %*`r`n"
[System.IO.File]::WriteAllText($WrapperTemp, $WrapperContent, [Text.Encoding]::ASCII)
Move-Item -LiteralPath $WrapperTemp -Destination $WrapperPath -Force

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$PathParts = @($UserPath -split ";" | Where-Object { $_ })
if ($PathParts -notcontains $WrapperDir) {
  $UpdatedPath = if ($UserPath) { "$UserPath;$WrapperDir" } else { $WrapperDir }
  [Environment]::SetEnvironmentVariable("Path", $UpdatedPath, "User")
  $env:Path = "$env:Path;$WrapperDir"
}

& $NodeBin $Entry doctor --data-dir $DataDir
if ($LASTEXITCODE -ne 0) { throw "AgentRoam doctor failed with exit code $LASTEXITCODE" }
if ($env:AGENTROAM_INSTALL_SKIP_SERVICE -eq "1") {
  Write-Host "AgentRoam service registration skipped for isolated verification."
} else {
  & $NodeBin $Entry service install --root $ServiceRoot --data-dir $DataDir
  if ($LASTEXITCODE -ne 0) { throw "AgentRoam service installation failed with exit code $LASTEXITCODE" }
}
Write-Host "`nAgentRoam $AgentRoamVersion installed: $WrapperPath"
Write-Host "Open a new terminal, then run: agentroam service status"
