# AgentRoam bootstrap installers

These versioned installers support macOS Apple Silicon and Windows x64. They reuse the active Node.js installation when it meets `>=22.22.0`, with no upper version bound. Otherwise they search NVM for the highest compatible version, then fall back to the verified private Node.js `22.22.0` runtime under the AgentRoam data directory. They then register and start the current-user AgentRoam background service. They never modify, replace, or uninstall system Node.js or global power settings.

## macOS Apple Silicon

```sh
curl -fsSL https://gitee.com/caoqu/team-agent/releases/download/v0.2.0-preview.16/install-agentroam.sh | sh
```

The command installs the wrapper at `~/.local/bin/agentroam`. If that directory is not already in `PATH`, the installer prints the required shell setting without editing shell profiles.

## Windows x64

```powershell
irm https://gitee.com/caoqu/team-agent/releases/download/v0.2.0-preview.16/install-agentroam.ps1 | iex
```

The command installs `%USERPROFILE%\.agentroam\bin\agentroam.cmd` and adds only that user directory to the user-level `PATH`. It does not require administrator access or change the machine-level `PATH`.

## Service behavior

Run the installer from the project directory AgentRoam should expose, or set `AGENTROAM_ROOT` explicitly. An installer launched from the home directory without an explicit root stops before service registration so it cannot expose the entire home directory accidentally.

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

Set `AGENTROAM_DATA_DIR` before running either installer to override the default `~/.agentroam` data directory. Node is stored at `<data-dir>/runtimes/node/22.22.0`, and the launcher is stored at `<data-dir>/launcher/0.2.0-preview.16`.

Each AgentRoam release pins its own Node patch and installer assets. Updates happen only by running a newer versioned installer or installing a newer AgentRoam release; startup never follows a moving Node.js release channel.

To uninstall the wrapper, remove `~/.local/bin/agentroam` on macOS or `%USERPROFILE%\.agentroam\bin\agentroam.cmd` on Windows. The private runtime, launcher, session data, and configuration under the data directory are preserved until explicitly removed by the user.
