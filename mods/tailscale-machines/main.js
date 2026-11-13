// tailscale-machines: Herdr's Add a machine, with the machines it can find.
// Your tailnet first (`tailscale status --json`), then the local network
// (ssh announced over Bonjour / Avahi), then your ssh config. One field
// searches them all or takes a `user@host`. Adding is `hc machine add`, as in
// herdr-app 0.1.15's defaults/mods/machine-add, whose ssh config reading and
// error handling this keeps. Opened as a dialog: `mod.open tailscale-machines`.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView, ScrollHandle } from "gpui-base";
import { hc, exec, home, readTextFile, theme, props, closeOverlay, run, window } from "herdr";

const OWN = (name) => `mods/tailscale-machines/icons/${name}.svg`;
const I = (name) => `mods/workspace-chrome/${name}.svg`;
const shellArg = (s) => /^[a-z0-9_@%+=:,./-]+$/i.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
const machineName = (s) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "machine";

// ---- ssh config (as Herdr's machine-add reads it)

async function includeFiles(value) {
  const paths = (value.match(/"[^"]*"|\S+/g) ?? [])
    .map((p) => p.replace(/^"|"$/g, ""))
    .map((p) => (p.startsWith("~/") ? `${home()}/${p.slice(2)}` : p.startsWith("/") || /^[a-z]:[\\/]/i.test(p) ? p : `${home()}/.ssh/${p}`));
  const files = [];
  for (const p of paths) {
    if (!/[*?[]/.test(p)) { files.push(p); continue; }
    const glob = /^[a-z]:/i.test(p) ? p.replace(/\\/g, "/") : p;
    const r = await exec("sh", ["-c", 'IFS=; for p in "$@"; do for f in $p; do [ -f "$f" ] && printf "%s\\n" "$f"; done; done', "sh", glob]).catch(() => null);
    files.push(...(r?.stdout ?? "").split("\n").filter(Boolean));
  }
  return files;
}

async function parseConfig(text, hosts = [], depth = 0) {
  let cur = null;
  for (const raw of (text ?? "").split("\n")) {
    const m = raw.trim().match(/^([^\s#=]+)\s*=?\s*(.*)$/);
    if (!m) continue;
    const [key, value] = [m[1].toLowerCase(), m[2].trim()];
    if (key === "host" || key === "match") {
      const names = key === "host" ? value.split(/\s+/).filter((h) => h && !/[*?!]/.test(h) && !hosts.some((x) => x.alias === h || x.aliases.includes(h))) : [];
      cur = names.length ? { alias: names[0], aliases: names.slice(1), hostname: null, user: null } : null;
      if (cur) hosts.push(cur);
    } else if (key === "include" && depth < 16) {
      for (const f of await includeFiles(value)) await parseConfig(await readTextFile(f).catch(() => null), hosts, depth + 1);
    } else if (cur && key === "hostname") cur.hostname = value;
    else if (cur && key === "user") cur.user = value;
  }
  return hosts;
}

// Git forges take ssh too, but nobody runs agents there.
const GIT = /(^|[.@-])(github|gitlab|gitee|bitbucket|codeberg|gitea|sourcehut|sr\.ht)([.-]|$)/i;
const isGitHost = (h) => h.user === "git" || GIT.test(h.alias) || GIT.test(h.hostname ?? "");

// ---- Tailscale

// macOS names a computer after its owner: "tivirus的Mac mini", "Can's MacBook Pro".
function guessUser(hostName) {
  const m = (hostName ?? "").match(/^([A-Za-z0-9._-]+)(?:的|'s |’s )/);
  return m ? m[1].toLowerCase() : null;
}

const TAILSCALE = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
const PHONES = /^(ios|android|tvos)$/i;

async function tailscale() {
  for (const bin of TAILSCALE) {
    const r = await exec(bin, ["status", "--json"], { timeout: 6000 }).catch(() => null);
    if (!r) continue;
    let d;
    try { d = JSON.parse(r.stdout); } catch { return { state: r.stderr.trim() || "Tailscale didn't answer", peers: [] }; }
    if (d.BackendState !== "Running") return { state: d.BackendState === "NeedsLogin" ? "Tailscale needs you to log in" : "Tailscale is stopped", peers: [] };
    const me = d.Self?.UserID;
    const peers = Object.values(d.Peer ?? {})
      .filter((p) => !p.ShareeNode && !PHONES.test(p.OS ?? ""))
      .map((p) => {
        const dns = (p.DNSName ?? "").replace(/\.$/, "");
        const host = dns || p.TailscaleIPs?.[0] || p.HostName;
        return {
          host,
          name: machineName(dns ? dns.split(".")[0] : p.HostName),
          title: dns ? dns.split(".")[0] : p.HostName,
          sub: [p.HostName, p.TailscaleIPs?.[0]].filter(Boolean).join(" · "),
          os: p.OS ?? "",
          online: Boolean(p.Online),
          mine: p.UserID === me,
          seen: p.LastSeen,
          user: guessUser(p.HostName),
        };
      })
      .sort((a, b) => (b.online - a.online) || (b.mine - a.mine) || a.title.localeCompare(b.title));
    return { state: null, peers, tailnet: d.MagicDNSSuffix ?? d.CurrentTailnet?.Name ?? "" };
  }
  return { state: "missing", peers: [] };
}

// ---- local network: ssh announced over mDNS

const MAC_LAN = `d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
printf 'SELF\\t%s\\n' "$(scutil --get LocalHostName 2>/dev/null)"
dns-sd -B _ssh._tcp local. > "$d/b" 2>/dev/null & p=$!; sleep 1.5; kill $p 2>/dev/null
awk 'NR>4 && $2=="Add" { for (k=1;k<=6;k++) $k=""; sub(/^ +/,""); print }' "$d/b" | sort -u > "$d/n"
i=0
while IFS= read -r n; do
  i=$((i+1))
  ( dns-sd -L "$n" _ssh._tcp local. > "$d/l$i" 2>/dev/null & q=$!; sleep 1.2; kill $q 2>/dev/null
    h=$(sed -n 's/.*can be reached at \\([^ ]*\\).*/\\1/p' "$d/l$i" | head -1)
    [ -n "$h" ] && printf '%s\\t%s\\n' "$n" "$h" ) &
done < "$d/n"
wait`;

const LINUX_LAN = `printf 'SELF\\t%s\\n' "$(hostname)"
command -v avahi-browse >/dev/null || exit 0
avahi-browse -rtp _ssh._tcp 2>/dev/null | awk -F';' '$1=="=" && $3=="IPv4" { print $4 "\\t" $7 ":" $9 }'`;

const unescape = (s) => s.replace(/\\(\d{3})/g, (_m, n) => String.fromCharCode(Number(n))).replace(/\\(.)/g, "$1");

async function lan(platform) {
  const script = platform === "macos" ? MAC_LAN : platform === "linux" ? LINUX_LAN : null;
  if (!script) return null;
  const r = await exec("sh", ["-c", script], { timeout: 12000 }).catch(() => null);
  const lines = (r?.stdout ?? "").split("\n").filter(Boolean).map((l) => l.split("\t"));
  const self = (lines.find(([k]) => k === "SELF")?.[1] ?? "").toLowerCase();
  const seen = new Map();
  for (const [title, at] of lines) {
    if (title === "SELF" || !at) continue;
    const m = at.match(/^(.*?)\.?:(\d+)$/);
    const host = (m ? m[1] : at).replace(/\.$/, "");
    const port = m ? m[2] : "22";
    const label = host.replace(/\.local$/i, "");
    if (!host || label.toLowerCase() === self || seen.has(host)) continue;
    seen.set(host, {
      host: port === "22" ? host : `${host}:${port}`,
      name: machineName(label),
      title: unescape(title),
      sub: port === "22" ? host : `${host}:${port}`,
      online: true,
      user: guessUser(unescape(title)),
    });
  }
  return [...seen.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function ago(iso) {
  const t = Date.parse(iso ?? "");
  if (!t || t < 86400000) return "offline";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

// ---- the dialog

export default class TailscaleMachines extends View {
  init(_props, cx) {
    this.platform = window()?.platform;
    this.me = home().split(/[\\/]/).pop();
    this.ts = null; // { state, peers, tailnet }
    this.lan = undefined; // undefined: looking; null: not on this OS
    this.hosts = null;
    this.added = [];
    this.state = {}; // target -> "adding" | { text, needs }
    this.pending = new Set();
    this.sel = 0;
    this.typed = "";
    this.scroll = ScrollHandle.new();
    this.handle = cx.focus_handle();

    this.search = InputState.new({ placeholder: "Search, or user@host" });
    this.search.on("change", (_e, cx) => { this.typed = this.search.value(); this.sel = 0; cx.notify(); });
    this.search.on("submit", (_e, cx) => this.enter(cx));
    this.search.on("focus", (_e, cx) => { this.focus = "search"; cx.notify(); });
    this.search.on("blur", (_e, cx) => { if (this.focus === "search") this.focus = null; cx.notify(); });

    let user = "";
    try { user = localStorage.getItem("user") ?? ""; } catch { /* no storage */ }
    this.user = user;
    this.userInput = InputState.new({ placeholder: this.me });
    this.userInput.set_value(user);
    this.userInput.on("change", (_e, cx) => {
      this.user = this.userInput.value().trim();
      try { localStorage.setItem("user", this.user); } catch { /* no storage */ }
      cx.notify();
    });
    this.userInput.on("submit", (_e, cx) => { this.search.focus(); cx.notify(); });
    this.userInput.on("focus", (_e, cx) => { this.focus = "user"; cx.notify(); });
    this.userInput.on("blur", (_e, cx) => { if (this.focus === "user") this.focus = null; cx.notify(); });

    this.search.focus();
    cx.timer.after(600, () => this.search.focus());

    cx.spawn(async (cx) => {
      this.hosts = (await parseConfig(await readTextFile(`${home()}/.ssh/config`).catch(() => null))).filter((h) => !isGitHost(h));
      await this.refresh();
      cx.notify();
    });
    this.discover(cx);
    // The tailnet changes (a box wakes up); hc learns of machines added elsewhere.
    cx.timer.every(8000, (cx) => {
      if (this.busy) return;
      this.busy = true;
      cx.spawn(async (cx) => {
        try {
          this.ts = await tailscale();
          await this.refresh();
          cx.notify();
        } finally { this.busy = false; }
      });
    });
  }

  discover(cx) {
    this.lan = undefined;
    this.ts = this.ts ?? null;
    cx.notify();
    cx.spawn(async (cx) => { this.ts = await tailscale(); cx.notify(); });
    cx.spawn(async (cx) => { this.lan = await lan(this.platform); cx.notify(); });
  }

  async refresh() {
    const r = await hc(["machine", "ls", "--json"]).catch(() => null);
    try {
      this.added = r?.code === 0 ? (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary) : [];
    } catch { this.added = []; }
    for (const target of this.pending) {
      if (!this.addedAs(target)) continue;
      this.pending.delete(target);
      delete this.state[target];
    }
  }

  // The machine a target became, matched by its whole target, its name or its host.
  addedAs(target) {
    const host = target.replace(/^[^@]*@/, "").replace(/:\d+$/, "").toLowerCase();
    return this.added.find((m) => m.target === target || m.name === target || (m.host ?? "").toLowerCase() === host || (m.target ?? "").replace(/^[^@]*@/, "").replace(/:\d+$/, "").toLowerCase() === host);
  }

  // The "as" field, else the owner named in a Mac's name, else ssh's default.
  withUser(host, guess) {
    const user = this.user || guess;
    return user ? `${user}@${host}` : host;
  }

  // Who ssh logs in as, before the rest: "tivirus@ · tivirus的Mac mini · 100.82.251.54".
  asSub(p) {
    const user = this.user || p.user;
    return user ? `${user}@ · ${p.sub}` : p.sub;
  }

  // Every row the list shows, in order, each with what Add runs.
  rows() {
    const q = this.typed.trim().toLowerCase();
    const hit = (r) => !q || `${r.title} ${r.sub} ${r.host ?? ""}`.toLowerCase().includes(q);
    const sections = [];
    const ts = this.ts;
    sections.push({
      key: "ts", title: "Tailscale", icon: OWN("tailnet"),
      note: ts === null ? "looking" : ts.state === "missing" ? "Not installed" : ts.state ?? (ts.peers.length ? null : "No other computers on your tailnet"),
      rows: (ts?.peers ?? []).map((p) => ({ ...p, icon: /linux|windows/i.test(p.os) ? I("server") : OWN("laptop"), target: this.withUser(p.host, p.user), sub: this.asSub(p), name: p.name, dim: !p.online, right: p.online ? null : ago(p.seen) })).filter(hit),
    });
    if (this.lan !== null) {
      sections.push({
        key: "lan", title: "Local network", icon: OWN("wifi"),
        note: this.lan === undefined ? "looking" : this.lan.length ? null : "Nothing here announces ssh",
        rows: (this.lan ?? []).map((p) => ({ ...p, icon: OWN("laptop"), target: this.withUser(p.host, p.user), sub: this.asSub(p) })).filter(hit),
      });
    }
    sections.push({
      key: "ssh", title: "ssh config", icon: OWN("key"),
      note: this.hosts === null ? "looking" : this.hosts.length ? null : "No hosts",
      rows: (this.hosts ?? []).map((h) => ({
        title: h.alias, target: h.alias, icon: I("server"),
        sub: [h.user, h.hostname].filter(Boolean).join("@") || (h.aliases.length ? `also ${h.aliases.join(", ")}` : ""),
      })).filter(hit),
    });
    const typed = this.typed.trim();
    const custom = typed && !/\s/.test(typed) && /[@.:]/.test(typed) ? { title: typed, target: typed, icon: OWN("square-terminal"), sub: "over ssh", custom: true } : null;
    return { sections, custom };
  }

  // Rows Enter and the arrows move through: what can still be added.
  pickable(view) {
    const list = view.sections.flatMap((s) => s.rows).filter((r) => !r.dim && !this.addedAs(r.target));
    return view.custom && !list.length ? [view.custom] : view.custom ? [...list, view.custom] : list;
  }

  enter(cx) {
    const list = this.pickable(this.rows());
    const r = list[Math.min(this.sel, list.length - 1)];
    if (r) this.add(r, cx);
  }

  move(d, cx) {
    const n = this.pickable(this.rows()).length;
    if (!n) return;
    this.sel = (this.sel + d + n) % n;
    if (this.selIndex != null) this.scroll.scroll_to_item(this.selIndex[this.sel] ?? 0);
    cx.notify();
  }

  add(row, cx) {
    const target = row.target;
    if (!target || this.state[target] === "adding") return;
    this.pending.delete(target);
    this.state[target] = "adding";
    cx.notify();
    const args = ["machine", "add", target, "--json"];
    if (row.name && !this.added.some((m) => m.name === row.name)) args.push("--name", row.name);
    cx.spawn(async (cx) => {
      const r = await hc(args).catch((e) => ({ code: 1, stderr: String(e), stdout: "" }));
      let why = null;
      try {
        why = r.code === 0 ? null : (JSON.parse(r.stdout || r.stderr).error ?? { message: (r.stderr || r.stdout).trim() });
      } catch {
        why = { message: (r.stderr || r.stdout || "it didn't answer").trim() };
      }
      const msg = why?.message ?? "";
      if (why && /host key verification failed/i.test(msg) && !/IDENTIFICATION HAS CHANGED/i.test(msg)) {
        const key = await this.hostKey(target);
        if (key) {
          this.state[target] = { hostkey: key, row };
          cx.notify();
          return;
        }
      }
      if (!why) {
        delete this.state[target];
        if (row.custom) { this.search.set_value(""); this.typed = ""; }
      } else if (["hc_missing", "incompatible", "login_needed", "auth_failed", "host_key"].includes(why.kind) || /password|passphrase|host key|permission denied|login/i.test(why.message ?? "")) {
        this.pending.add(target);
        const user = target.includes("@") ? target.split("@")[0] : null;
        const password = /password|permission denied|publickey/i.test(msg);
        const add = `hc machine add ${args.slice(2, 3).concat(args.slice(4)).map(shellArg).join(" ")}`;
        // Without a key, ssh-copy-id asks the password once; then hc logs in on its own.
        this.state[target] = { needs: true, command: password ? `ssh-copy-id ${shellArg(target)} && ${add}` : add,
          text: password
            ? `ssh couldn't log in${user ? ` as ${user}` : ""} without a password. Run this in a terminal once (or change “as”):`
            : "Run this in a terminal to answer it (a password, or installing herdr-core there):" };
      } else this.state[target] = { text: why.message || "it didn't work" };
      await this.refresh();
      cx.notify();
    });
  }

  // The keys the host offers, their fingerprint, and the names this computer
  // already trusts that same key under (the machine's LAN address, often).
  async hostKey(target) {
    const host = target.replace(/^[^@]*@/, "");
    const m = host.match(/^(.*):(\d+)$/);
    const [name, port] = m ? [m[1], m[2]] : [host, "22"];
    const scan = await exec("ssh-keyscan", ["-T", "5", "-p", port, name], { timeout: 10000 }).catch(() => null);
    const lines = (scan?.stdout ?? "").split("\n").filter((l) => l && !l.startsWith("#"));
    if (!lines.length) return null;
    const ed = lines.find((l) => l.includes(" ssh-ed25519 ")) ?? lines[0];
    const fp = await exec("sh", ["-c", 'printf "%s\\n" "$1" | ssh-keygen -lf -', "sh", ed]).catch(() => null);
    const blob = ed.split(" ")[2];
    const known = (await readTextFile(`${home()}/.ssh/known_hosts`).catch(() => ""))
      .split("\n").filter((l) => blob && l.includes(blob)).map((l) => l.split(" ")[0]).filter((n) => !n.startsWith("|"));
    return { lines, fingerprint: (fp?.stdout ?? "").split(" ")[1] ?? "", known: [...new Set(known.flatMap((n) => n.split(",")))] };
  }

  trust(target, cx) {
    const st = this.state[target];
    if (!st?.hostkey) return;
    this.state[target] = "adding";
    cx.notify();
    cx.spawn(async (cx) => {
      const text = st.hostkey.lines.join("\n") + "\n";
      await exec("sh", ["-c", 'mkdir -p "$HOME/.ssh" && printf "%s" "$1" >> "$HOME/.ssh/known_hosts"', "sh", text]).catch(() => null);
      delete this.state[target];
      this.add(st.row, cx);
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  key(e, cx) {
    if (e.key === "escape") { this.close(); cx.stop_propagation(); }
    else if (e.key === "down" || (e.key === "n" && e.modifiers?.control)) { this.move(1, cx); cx.stop_propagation(); }
    else if (e.key === "up" || (e.key === "p" && e.modifiers?.control)) { this.move(-1, cx); cx.stop_propagation(); }
  }

  button(t, id, label, onClick, solid = false) {
    return div().id(id).h(26).px(10).flex().flex_none().items_center().rounded(7).text_size(12).font_medium().cursor_pointer()
      .when(solid, (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.88)))
      .when(!solid, (el) => el.border_1().border_color(t.input).bg(t.raised).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(label);
  }

  hostKeyCard(t, target) {
    const k = this.state[target].hostkey;
    return v_flex().gap(6).pl(35).pr(10).pb(8)
      .child(div().text_size(12).text_color(t.muted).child(k.known.length
        ? `Same host key you already trust for ${k.known.slice(0, 2).join(", ")}.`
        : "First time connecting: check this is the machine's key."))
      .child(div().text_size(11.5).text_color(t.dim).child(k.fingerprint))
      .child(h_flex().gap(6).items_center()
        .child(this.button(t, `tm-trust-${target}`, "Trust and add", (cx) => this.trust(target, cx), true))
        .child(this.button(t, `tm-cancel-${target}`, "Cancel", (cx) => { delete this.state[target]; cx.notify(); })));
  }

  message(t, target) {
    const st = this.state[target];
    if (st.hostkey) return this.hostKeyCard(t, target);
    const text = String(st.text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return v_flex().gap(6).pl(35).pr(10).pb(8)
      .child(div().text_size(12).text_color(t.blocked).child(TextView.html(`tm-msg-${target}`, `<span>${text}</span>`).selectable(true)))
      .when(Boolean(st.needs), (el) => el.child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().px(8).py(4).rounded(6).bg(t.background).border_1().border_color(t.border).text_size(12).text_color(t.foreground).child(st.command))
        .child(this.button(t, `tm-copy-${target}`, this.copied === st.command ? "Copied" : "Copy", (cx) => { cx.write_to_clipboard(st.command); this.copied = st.command; cx.notify(); }, true))));
  }

  row(t, r, selected) {
    const st = this.state[r.target];
    const machine = this.addedAs(r.target);
    const right = machine
      ? h_flex().gap(8).items_center()
        .child(h_flex().gap(5).items_center().text_size(12).text_color(t.ansi2).child(svg(I("circle-check")).size(13)).child("Added"))
        .child(this.button(t, `tm-open-${r.target}`, "New space", () => { this.close(); run("space.new", { machine: machine.name }); }))
      : st === "adding"
        ? h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child(svg(I("spinner")).size(12).text_color(t.working).spin(900)).child("Connecting")
        : r.dim
          ? div().text_size(12).text_color(t.dim).child(r.right ?? "offline")
          : this.button(t, `tm-add-${r.target}`, "Add", (cx) => this.add(r, cx));
    const idle = !machine && !st && !r.dim;
    return v_flex().flex_none()
      .child(h_flex().id(`tm-row-${r.target}`).h(38).px(10).gap(10).items_center().rounded(8)
        .when(selected, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .when(Boolean(r.dim), (el) => el.opacity(0.5))
        .when(idle, (el) => el.cursor_pointer().on_click((_e, cx) => this.add(r, cx)))
        .child(div().relative().flex_none()
          .child(svg(r.icon).size(15).text_color(t.muted))
          .when(r.online !== undefined, (el) => el.child(div().absolute().right(-2).bottom(-1).size(7).rounded(4).border_1().border_color(t.popover).bg(r.online ? t.ansi2 : t.dim))))
        .child(div().flex_none().max_w(240).truncate().text_size(13).text_color(t.foreground).child(r.title))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(r.sub ?? ""))
        .child(right))
      .when(Boolean(st && st !== "adding" && !machine), (el) => el.child(this.message(t, r.target)));
  }

  header(t, s) {
    return h_flex().flex_none().pt(12).pb(4).px(10).gap(7).items_center().text_size(11.5).font_medium().text_color(t.dim)
      .child(svg(s.icon).size(12))
      .child(s.title)
      .when(s.key === "ts" && Boolean(this.ts?.tailnet), (el) => el.child(div().text_color(t.dim).opacity(0.7).child(this.ts.tailnet)))
      .when(s.note === "looking", (el) => el.child(svg(I("spinner")).size(11).spin(900)));
  }

  render() {
    const t = theme();
    const view = this.rows();
    const picks = this.pickable(view);
    this.sel = Math.min(this.sel, Math.max(0, picks.length - 1));
    const chosen = picks[this.sel];
    const q = this.typed.trim();

    // Flat children, so the arrows can scroll a row into view by its index.
    const children = [];
    this.selIndex = [];
    const push = (el, r) => {
      if (r) { const i = picks.indexOf(r); if (i >= 0) this.selIndex[i] = children.length; }
      children.push(el);
    };
    if (view.custom && picks.length === 1 && picks[0] === view.custom) push(this.row(t, view.custom, true), view.custom);
    for (const s of view.sections) {
      if (q && !s.rows.length) continue;
      push(this.header(t, s));
      if (s.note && s.note !== "looking" && !s.rows.length) push(div().px(10).py(6).text_size(12.5).text_color(t.dim).child(s.note));
      for (const r of s.rows) push(this.row(t, r, r === chosen), r);
    }
    if (view.custom && !(picks.length === 1 && picks[0] === view.custom)) {
      push(this.header(t, { key: "custom", title: "Typed", icon: OWN("square-terminal") }));
      push(this.row(t, view.custom, view.custom === chosen), view.custom);
    }

    const field = (state, focused, w) => Input.new(state).h(34).px(10).items_center().rounded(8).border_1()
      .border_color(focused ? t.accent : t.input).bg(t.background).text_size(13).text_color(t.foreground)
      .when(Boolean(w), (el) => el.w(w).flex_none()).when(!w, (el) => el.flex_1());

    return v_flex().id("tailscale-machines").track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).p(18).gap(12).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().gap(6)
        .child(div().flex_1().text_size(15).font_semibold().child("Add a machine"))
        .child(div().id("tm-refresh").p(5).rounded(5).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.discover(cx); cx.spawn(async (cx) => { await this.refresh(); cx.notify(); }); })
          .child(svg(OWN("refresh")).size(13)))
        .child(div().id("tm-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(h_flex().gap(8)
        .child(field(this.search, this.focus === "search", 0))
        .child(h_flex().flex_none().gap(6).items_center().text_size(12).text_color(t.dim)
          .child("as").child(field(this.userInput, this.focus === "user", 110))))
      .child(v_flex().id("tm-list").max_h(400).min_h(0).flex_shrink(1).overflow_y_scroll().track_scroll(this.scroll).mx(-10)
        .children(children.length ? children : [div().px(10).py(10).text_size(12.5).text_color(t.dim).child(`Nothing matches “${q}”`)]));
  }
}
