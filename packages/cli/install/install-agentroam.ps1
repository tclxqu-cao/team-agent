$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$NodeVersion = "22.22.0"
$MinimumNodeVersion = "22.22.0"
# 默认跟随 npm preview 最新标签；可用 $env:AGENTROAM_VERSION 钉精确版本
# 例如：$env:AGENTROAM_VERSION = "<x.y.z-preview.N>"; ./install-agentroam.ps1
$AgentRoamVersionRequest = if ($env:AGENTROAM_VERSION) { $env:AGENTROAM_VERSION } else { "preview" }
$AgentRoamVersion = "pending-version"
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
New-Item -ItemType Directory -Force -Path $NodeParent, $LauncherParent, $WrapperDir | Out-Null

function Test-NodeVersion([string]$VersionText) {
  if ($VersionText -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$') { return $false }
  try { return [Version]($VersionText.Split('+')[0]) -ge [Version]$MinimumNodeVersion } catch { return $false }
}

function Test-SupportedNode([string]$NodeBin) {
  if (-not (Test-Path -LiteralPath $NodeBin -PathType Leaf)) { return $false }
  try { return Test-NodeVersion ((& $NodeBin -p 'process.versions.node' 2>$null).Trim()) } catch { return $false }
}

function Get-NvmRoots {
  $Candidates = @()
  if ($env:NVM_HOME) { $Candidates += $env:NVM_HOME }
  if ($env:APPDATA) { $Candidates += (Join-Path $env:APPDATA "nvm") }
  $NvmCommand = Get-Command nvm.exe -ErrorAction SilentlyContinue
  if ($NvmCommand) {
    try {
      $RootOutput = (& $NvmCommand.Source root 2>$null | Select-Object -Last 1)
      if ($RootOutput) {
        $RootText = $RootOutput.Trim()
        if ($RootText -match '^[^:]+:\s+(.+)$') { $RootText = $Matches[1].Trim() }
        $Candidates += $RootText
      }
    } catch {}
  }
  @($Candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } | Select-Object -Unique)
}

function Find-NvmNode {
  $VersionMatches = foreach ($NvmRoot in (Get-NvmRoots)) {
    foreach ($VersionDirectory in Get-ChildItem -LiteralPath $NvmRoot -Directory -ErrorAction SilentlyContinue) {
      $Candidate = Join-Path $VersionDirectory.FullName "node.exe"
      if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { continue }
      try {
        $VersionText = (& $Candidate -p 'process.versions.node' 2>$null).Trim()
        if (Test-NodeVersion $VersionText) {
          $Version = [Version]($VersionText.Split('+')[0])
          [pscustomobject]@{ Path = $Candidate; Version = $Version }
        }
      } catch {}
    }
  }
  $Best = $VersionMatches | Sort-Object Version -Descending | Select-Object -First 1
  if ($Best) { return $Best.Path }
  return $null
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
if ($SystemNode -and (Test-SupportedNode $SystemNode.Source)) {
  $NodeBin = $SystemNode.Source
} else {
  $NvmNode = if ($env:AGENTROAM_BOOTSTRAP_TEST -eq "1" -and $env:AGENTROAM_FORCE_PRIVATE_NODE -eq "1") { $null } else { Find-NvmNode }
  if ($NvmNode) {
    $NodeBin = $NvmNode
    Write-Host "Using Node.js $(& $NodeBin --version) from NVM: $NodeBin"
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
}

if ($env:AGENTROAM_BOOTSTRAP_TEST -eq "1" -and $env:AGENTROAM_BOOTSTRAP_NODE_DISCOVERY_ONLY -eq "1") {
  Write-Output $NodeBin
  exit 0
}

$NodeDirectory = Split-Path -Parent $NodeBin
$NpmCandidates = @(
  (Join-Path $NodeDirectory "node_modules\npm\bin\npm-cli.js"),
  (Join-Path $NodeDirectory "..\node_modules\npm\bin\npm-cli.js")
)
$NpmCli = $NpmCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $NpmCli) { throw "npm CLI was not found beside $NodeBin" }

# 解析 dist-tag → 精确版本（安装最总是最新发布）
if ($AgentRoamVersionRequest -notmatch '\d$') {
    $Resolved = (& $NodeBin $NpmCli view "agentroam@$AgentRoamVersionRequest" version --registry $NpmRegistry 2>$null | Select-Object -Last 1)
    if (-not $Resolved) { throw "could not resolve agentroam@$AgentRoamVersionRequest from $NpmRegistry" }
    $AgentRoamVersion = ([string]$Resolved).Trim()
    Write-Host "Installing AgentRoam $AgentRoamVersion (resolved from $AgentRoamVersionRequest)"
} else {
    $AgentRoamVersion = $AgentRoamVersionRequest
}
$LauncherRoot = Join-Path $LauncherParent $AgentRoamVersion
$LauncherLock = "$LauncherRoot.lock"
$PackageSpec = "agentroam@$AgentRoamVersion"
$ExtraPackageSpecs = @()
if ($env:AGENTROAM_BOOTSTRAP_TEST -eq "1" -and $env:AGENTROAM_PACKAGE_SPEC) {
  $PackageSpec = $env:AGENTROAM_PACKAGE_SPEC
  if ($env:AGENTROAM_BOOTSTRAP_EXTRA_SPECS) { $ExtraPackageSpecs = @($env:AGENTROAM_BOOTSTRAP_EXTRA_SPECS.Split(';') | Where-Object { $_ }) }
}
$Entry = Join-Path $LauncherRoot "node_modules\agentroam\bin\agentroam.mjs"

$LauncherCheckSource = @'
const { readFileSync, statSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { dirname, resolve, sep } = require("node:path");
const [prefix, launcherVersion, minimumNodeVersion, target, mode] = process.argv.slice(process.argv[1] === "-" ? 2 : 1);
try {
  const packageName = {
    "darwin-arm64": "agentroam-runtime-darwin-arm64",
    "windows-amd64": "agentroam-runtime-win32-x64",
  }[target];
  if (!packageName) throw new Error("Unsupported runtime target: " + target);
  const launcherPath = resolve(prefix, "node_modules/agentroam/package.json");
  const launcher = JSON.parse(readFileSync(launcherPath, "utf8"));
  if (launcher.version !== launcherVersion) throw new Error("AgentRoam launcher version mismatch");
  const version = launcher.optionalDependencies?.[packageName];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Runtime dependency must use an exact version: " + packageName);
  }
  if (mode === "spec") {
    console.log(packageName + "@" + version);
  } else {
    if (mode !== "verify") throw new Error("Unknown runtime validation mode: " + mode);
    const launcherRequire = createRequire(launcherPath);
    const manifestPath = launcherRequire.resolve(packageName + "/manifest.json");
    const runtimeRoot = dirname(launcherRequire.resolve(packageName + "/runtime"));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const runtimePackage = JSON.parse(readFileSync(resolve(dirname(manifestPath), "package.json"), "utf8"));
    if (runtimePackage.name !== packageName || runtimePackage.version !== version ||
        manifest.packageVersion !== version || manifest.target !== target ||
        manifest.schemaVersion !== 2 || manifest.minimumNodeVersion !== minimumNodeVersion ||
        !manifest.nativeFiles || typeof manifest.nativeFiles !== "object" || Array.isArray(manifest.nativeFiles)) {
      throw new Error("Invalid runtime manifest: " + manifestPath);
    }
    const nativeTarget = target === "darwin-arm64" ? "darwin-arm64" : "win32-x64";
    for (const file of [
      "node_modules/better-sqlite3/prebuilds/" + nativeTarget + ".node",
      "node_modules/node-pty/prebuilds/" + nativeTarget + "/pty.node",
      ...(target === "darwin-arm64"
        ? ["node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"]
        : ["node_modules/node-pty/prebuilds/win32-x64/conpty.node",
          "node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll",
          "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe"]),
    ]) {
      if (!manifest.nativeFiles[file]) throw new Error("Missing runtime native inventory: " + file);
    }
    for (const file of ["bin/agentroam.mjs"]) {
      if (!statSync(resolve(dirname(launcherPath), file)).isFile()) throw new Error("Missing launcher file: " + file);
    }
    for (const file of ["ws-server.mjs", ".next/BUILD_ID"]) {
      if (!statSync(resolve(runtimeRoot, file)).isFile()) throw new Error("Missing runtime file: " + file);
    }
    for (const [file, expectedHash] of Object.entries(manifest.nativeFiles)) {
      const path = resolve(runtimeRoot, file);
      if (!path.startsWith(runtimeRoot + sep) || !/^[a-f0-9]{64}$/.test(expectedHash)) {
        throw new Error("Invalid runtime native inventory: " + file);
      }
      const actualHash = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (actualHash !== expectedHash) throw new Error("Runtime native file checksum mismatch: " + file);
    }
    const runtimeRequire = createRequire(resolve(runtimeRoot, "package.json"));
    for (const name of ["better-sqlite3", "node-pty"]) {
      if (!runtimeRequire.resolve(name).startsWith(runtimeRoot + sep)) throw new Error("Missing runtime module: " + name);
    }
    const Database = runtimeRequire("better-sqlite3");
    const database = new Database(":memory:");
    try {
      if (database.prepare("SELECT 1 AS ok").get()?.ok !== 1) throw new Error("SQLite runtime query failed");
    } finally {
      database.close();
    }
    if (typeof runtimeRequire("node-pty").spawn !== "function") throw new Error("Invalid PTY runtime module");
  }
} catch (error) {
  console.error("AgentRoam runtime validation failed: " + error.message);
  process.exitCode = 1;
}
'@

function Test-LauncherRuntime([string]$Prefix) {
  try {
    # Pipe JavaScript to Node so Windows PowerShell 5 does not strip its quotes.
    $LauncherCheckSource | & $NodeBin - $Prefix $AgentRoamVersion $MinimumNodeVersion windows-amd64 verify 2>$null
    return $LASTEXITCODE -eq 0
  } catch { return $false }
}

function Test-Launcher {
  return Test-LauncherRuntime $LauncherRoot
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
        $RuntimeSpec = [string]($LauncherCheckSource | & $NodeBin - $TempLauncher $AgentRoamVersion $MinimumNodeVersion windows-amd64 spec)
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($RuntimeSpec)) { throw "AgentRoam runtime dependency validation failed" }
        if (-not (Test-LauncherRuntime $TempLauncher)) {
          Remove-Item -LiteralPath (Join-Path $TempLauncher "node_modules\agentroam-runtime-win32-x64") -Recurse -Force -ErrorAction SilentlyContinue
          $RuntimeArgs = @("install", "--save-exact", "--include=optional", "--no-audit", "--no-fund", "--registry", $NpmRegistry, "--prefix", $TempLauncher, $RuntimeSpec.Trim())
          & $NodeBin $NpmCli @RuntimeArgs
          if ($LASTEXITCODE -ne 0) { throw "Required AgentRoam runtime install failed with exit code $LASTEXITCODE" }
        }
        $LauncherCheckSource | & $NodeBin - $TempLauncher $AgentRoamVersion $MinimumNodeVersion windows-amd64 verify
        if ($LASTEXITCODE -ne 0) { throw "AgentRoam runtime validation failed; previous installation preserved" }
        $PreviousLauncher = $null
        if (Test-Path -LiteralPath $LauncherRoot) {
          $PreviousLauncher = Join-Path $LauncherParent ".previous-$AgentRoamVersion-$([Guid]::NewGuid().ToString('N'))"
          Move-Item -LiteralPath $LauncherRoot -Destination $PreviousLauncher
        }
        try {
          Move-Item -LiteralPath $TempLauncher -Destination $LauncherRoot
        } catch {
          if ($PreviousLauncher -and -not (Test-Path -LiteralPath $LauncherRoot)) {
            Move-Item -LiteralPath $PreviousLauncher -Destination $LauncherRoot
          }
          throw
        }
        if ($PreviousLauncher) { Remove-Item -LiteralPath $PreviousLauncher -Recurse -Force }
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
if ($LASTEXITCODE -ne 0) { Write-Warning "Some component checks failed; continuing background service installation. Affected features may be unavailable. Run agentroam doctor to retry." }
if ($env:AGENTROAM_INSTALL_SKIP_SERVICE -eq "1") {
  Write-Host "AgentRoam service registration skipped for isolated verification."
} else {
  & $NodeBin $Entry service install --root $ServiceRoot --data-dir $DataDir
  if ($LASTEXITCODE -ne 0) { throw "CLI installed, but the background service failed (exit $LASTEXITCODE). Run agentroam service logs, fix the error, then run agentroam service start and agentroam pair." }
}
Write-Host "`nAgentRoam $AgentRoamVersion installed: $WrapperPath"
Write-Host "Open a new terminal, then run: agentroam service status"

$DesktopChoice = if ($env:AGENTROAM_INSTALL_DESKTOP) { $env:AGENTROAM_INSTALL_DESKTOP } else { "ask" }
if ($env:AGENTROAM_INSTALL_SKIP_SERVICE -eq "1" -and $DesktopChoice -eq "ask") { $DesktopChoice = "no" }
if ($DesktopChoice -eq "ask") {
  $DesktopChoice = "no"
  if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    try { $DesktopChoice = Read-Host "Download the desktop app for remote viewing and control? [y/N]" } catch { $DesktopChoice = "no" }
  }
}
if ($DesktopChoice -match '^(y|yes|是)$') {
  $DesktopHelper = Join-Path $LauncherRoot "node_modules\agentroam\bin\desktop-download.mjs"
  if (Test-Path -LiteralPath $DesktopHelper -PathType Leaf) {
    & $NodeBin $DesktopHelper $AgentRoamVersion
    if ($LASTEXITCODE -ne 0) { Write-Warning "CLI installation completed. You can retry the desktop download later." }
  } else {
    Write-Warning "This CLI version does not support desktop downloads. CLI installation completed; upgrade to retry."
  }
} else { Write-Host "Desktop download skipped. CLI is ready to use." }
