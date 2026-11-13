# Tailscale Machines for Herdr

A better **Add a machine** window for the [Herdr](https://herdr.dev) desktop app. It finds the machines you can reach before you type anything: your Tailscale tailnet first, then computers on the local network that announce ssh, then your ssh config. Add one with a click or Enter.

- **Tailscale.** Every computer on your tailnet (phones and devices shared in from other tailnets left out), online ones first, each with its MagicDNS name and IP. Offline ones are dimmed, with when they were last seen.
- **Local network.** Computers announcing ssh over Bonjour (macOS: Remote Login on) or Avahi (Linux).
- **ssh config.** Your `Host` entries, without git forges (GitHub, GitLab, `git@` hosts…).
- **One field.** Type to search all three; ↑ ↓ to choose, Enter to add. Typing `user@host` adds that.
- **as.** The ssh user for Tailscale and local machines (default: ssh's own). Remembered.
- **When it needs you** (a password, a new host key, installing herdr-core there): *Answer in a terminal* opens `hc machine add` in a terminal over the window; the row turns Added once it's done.
- **Added** machines get a *New space* button.

## Install

Ask your agent inside Herdr: *"Add the mod at github.com/Umupa/herdr-tailscale-machines"*. Or by hand:

```sh
git clone https://github.com/Umupa/herdr-tailscale-machines.git
cp -R herdr-tailscale-machines/mods/tailscale-machines ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/tailscale-machines
```

Then bind a key in `~/.config/herdr-app/keys.json` (this repo's `keys.json` uses ⌘⇧M; on Linux and Windows pick e.g. `ctrl-shift-m`):

```json
{ "global": { "cmd-shift-m": "mod.open:tailscale-machines" } }
```

Or run `herdr-app do mod.open --name tailscale-machines`. Herdr's own *Add machine* buttons still open Herdr's window; this mod doesn't change your layout.

## What it touches

- **Programs, while the window is open:** `tailscale status --json` (every 8 s), `hc machine ls` (every 8 s), and once (or on ↻) `dns-sd` on macOS / `avahi-browse` on Linux for about 3 s. Adding runs `hc machine add <target> --name <name>`. *Answer in a terminal* runs it through `hc run`.
- **Files:** reads `~/.ssh/config` and the files it includes.
- **Storage:** the `as` user in this mod's localStorage. No network of its own.

## Uninstall

Delete `mods/tailscale-machines/` and its key.

## Credits

Builds on herdr-app's Add a machine (Apache-2.0). Icons: [Lucide](https://lucide.dev) (ISC). Not affiliated with Tailscale. See [NOTICE](NOTICE).
