# AgentRoam bootstrap installers

These installers support macOS Apple Silicon and Windows x64. They install the newest published `preview` release by default (resolved from the npm dist-tag); pin an exact release with `AGENTROAM_VERSION=<x.y.z-preview.N>`. They reuse the active Node.js installation when it meets `>=22.22.0`, with no upper version bound. Otherwise they search NVM for the highest compatible version, then fall back to the verified private Node.js `22.22.0` runtime under the AgentRoam data directory. They then register and start the current-user AgentRoam background service. They never modify, replace, or uninstall system Node.js or global power settings.

## macOS Apple Silicon

```sh
curl -fsSL https://github.com/tclxqu-cao/team-agent/raw/main/packages/cli/install/install-agentroam.sh | sh
```

The command installs the wrapper at `~/.local/bin/agentroam`. If that directory is not already in `PATH`, the installer prints the required shell setting without editing shell profiles.

## Windows x64

```powershell
irm https://github.com/tclxqu-cao/team-agent/raw/main/packages/cli/install/install-agentroam.ps1 | iex
```

The command installs `%USERPROFILE%\.agentroam\bin\agentroam.cmd` and adds only that user directory to the user-level `PATH`. It does not require administrator access or change the machine-level `PATH`.

## Service behavior

Run the installer from the project directory AgentRoam should expose, or set `AGENTROAM_ROOT` explicitly. The current directory is accepted even when it is the home directory.

The installer registers and starts the service after Node, CLI, and `doctor` validation. When a previous AgentRoam user service is installed, the new CLI stops it, waits for its process and platform registration to exit, removes only the old service registration, and then registers the replacement. Session data, pairing state, managed runtimes, and logs remain in the data directory. While foreground AgentRoam or the service is running, it prevents idle system sleep but still allows the display to dim and turn off. Lid close, explicit sleep, hibernation, shutdown, and low-battery forced sleep remain controlled by the operating system.

On interactive terminals, `service install`, `start`, `status`, and `restart` print a scannable QR code beside the `Open:` URL. Piped or redirected output stays plain text, and `agentroam service install --no-qr` suppresses the code. `service url` always prints only the raw URL for scripting.

Use the installer for first installation, upgrades, and repair. Use these commands for routine control:

```text
agentroam service start
agentroam service stop
agentroam service restart
agentroam service status
agentroam service url
agentroam service logs
agentroam service uninstall
```

## Data and updates

Set `AGENTROAM_DATA_DIR` before running either installer to override the default `~/.agentroam` data directory. Node is stored at `<data-dir>/runtimes/node/22.22.0`, and the launcher is stored at `<data-dir>/launcher/<version>`.

Each AgentRoam release pins its own Node patch. Updates happen by running the installer again (it resolves the newest published `preview`) or by installing a newer AgentRoam release; startup never follows a moving Node.js release channel.

To uninstall the wrapper, remove `~/.local/bin/agentroam` on macOS or `%USERPROFILE%\.agentroam\bin\agentroam.cmd` on Windows. The private runtime, launcher, session data, and configuration under the data directory are preserved until explicitly removed by the user.

## Optional desktop app

After CLI setup succeeds, interactive installers ask whether to download the desktop app. Answer `y` to download the matching macOS DMG or Windows installer into a unique folder under Downloads, verify its release-manifest SHA-256, and show the file. Open it to complete installation. Answer `n` or press Enter to keep using CLI only. Noninteractive runs skip the prompt.

Set `AGENTROAM_INSTALL_DESKTOP=yes` or `no` explicitly for automation. The Shell installer reads `/dev/tty`, so `curl ... | sh` remains interactive. A missing desktop artifact or failed download does not undo CLI installation. This requires a published CLI that includes `bin/desktop-download.mjs` and matching desktop release assets.

On macOS, the desktop app opens its own permission guide on first launch, even before connecting to a service. Screen Recording enables phone viewing; Accessibility enables keyboard and mouse control. Returning from System Settings rechecks permissions and resumes an enabled session. Restart the desktop app if macOS requires it. Desktop live publishing follows the selected CLI service, including its actual port. Windows desktop download is supported, but the current screen/input helper is macOS-only.
