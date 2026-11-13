# Tailscale Machines for Herdr

[中文](README.zh-CN.md)

Add a machine in [Herdr](https://herdr.dev) without typing: your Tailscale tailnet, the local network and your ssh config, in one searchable list.

![Tailscale Machines](preview.png)

- **Tailscale** computers first, online on top
- **Local network** machines that announce ssh
- **ssh config** hosts, without GitHub / GitLab
- Search, ↑ ↓, Enter; or type `user@host`
- Guesses the ssh user from a Mac's name, or set it in **as**
- New host key? **Trust and add**. Needs a password? Copy the one command to run

## Install for agent

Paste this to your agent in Herdr:

```text
Install the Herdr mod at https://github.com/Umupa/herdr-tailscale-machines:
copy both folders in mods/ into ~/.config/herdr-app/mods/, run herdr-app check on each,
bind cmd-shift-m to "mod.open:tailscale-machines" in my keys.json,
and set my layout's sidebar-footer block to the "tailscale-footer" mod.
```

## Install by hand

```sh
git clone https://github.com/Umupa/herdr-tailscale-machines.git
cp -R herdr-tailscale-machines/mods/* ~/.config/herdr-app/mods/
```

Key, in `~/.config/herdr-app/keys.json`:

```json
{ "global": { "cmd-shift-m": "mod.open:tailscale-machines" } }
```

To make the sidebar's **Add machine** open it, set the footer block in your layout:

```json
{ "id": "sidebar-footer", "type": "block", "content": { "mod": "tailscale-footer", "props": { "footer": true } } }
```

## Notes

Runs `tailscale status`, `dns-sd` / `avahi-browse`, `ssh-keyscan` and `hc machine` while open; reads `~/.ssh/config`. No network of its own. Not affiliated with Tailscale. Apache-2.0, see [NOTICE](NOTICE).
