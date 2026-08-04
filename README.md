## gnome-dmenu-by-blueray453

A `dmenu`/`rofi`-style application launcher and text-selection prompt for
**GNOME Shell on Wayland**.

GNOME's Wayland compositor (Mutter) does not support the `wlr-layer-shell`
protocol, so traditional tools like `rofi` and `wofi` cannot overlay
themselves on top of other windows, steal keyboard focus, or float above
everything else. This project sidesteps that entirely by implementing the
prompt as a **GNOME Shell extension** — it runs inside the `gnome-shell`
process itself and uses the compositor's own APIs (`St`, `Clutter`,
`Main.layoutManager.addChrome`) to draw and focus itself, no layer-shell
required.

A small CLI client (`gdmenu-gjs`) talks to the extension over D-Bus, so you
can pipe text into it from shell scripts exactly like classic `dmenu`:

```bash
echo -e "reboot\nshutdown\nlock" | gdmenu-gjs | xargs -I{} systemctl {}
```

## Features

- Full-screen overlay drawn above all other windows, no layer-shell needed
- Fuzzy substring filtering as you type (multi-word, order-independent)
- Keyboard navigation (arrows, Tab, etc.)
- **Multi-select** support — mark several lines and return them all at once
- Mouse support — hover highlighting, click a line to select it
- Debounced filtering + virtualized rendering, so it stays responsive even
  with thousands of piped-in lines
- Solarized Dark theme out of the box (easily restyled via CSS)
- D-Bus signal–based architecture — the `Show` call returns immediately, so
  a UI bug can never hang or crash the calling script's D-Bus connection

## How it works

| Piece | Role |
|---|---|
| `extension.js` | Runs inside GNOME Shell. Exports a D-Bus service (`org.gnome.Shell.Extensions.SimpleDmenu`) with a `Show(items)` method, and emits `Selected(items)` / `Cancelled` signals once the user picks something or presses Escape. |
| `stylesheet.css` | St/Clutter theming — colors, fonts, spacing (Solarized Dark by default). |
| `gdmenu-gjs` | A standalone GJS CLI script. Reads lines from stdin, calls `Show()` over D-Bus, blocks on a `GLib.MainLoop` until a `Selected`/`Cancelled` signal arrives, then prints the result(s) to stdout — behaving like a normal Unix filter. |

## Requirements

- GNOME Shell 45, 46, or 47 (Wayland or X11)
- `gjs` (installed by default on any GNOME desktop)

## Installation

### 1. Install the extension

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/simple-dmenu@example.com
cp metadata.json extension.js stylesheet.css \
   ~/.local/share/gnome-shell/extensions/simple-dmenu@example.com/

gnome-extensions enable simple-dmenu@example.com
```

**Log out and back in.** Wayland sessions cannot hot-reload shell extensions
the way X11 could with `Alt+F2` → `r` — a full session restart is required
after installing or editing `extension.js`.

Verify it loaded correctly:

```bash
gnome-extensions info simple-dmenu@example.com
```

### 2. Install the CLI client

```bash
chmod +x gdmenu-gjs
cp gdmenu-gjs ~/.local/bin/gdmenu-gjs
```

Make sure `~/.local/bin` is on your `$PATH`:

```bash
echo $PATH | tr ':' '\n' | grep -q "$HOME/.local/bin" || \
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

## Usage

Pipe any newline-separated text into `gdmenu-gjs`; the selected line(s) are
printed to stdout.

```bash
# Basic single selection
echo -e "reboot\nshutdown\nlock" | gdmenu-gjs | xargs -I{} systemctl {}

# Pick a project directory to open in an editor
find ~/Projects -maxdepth 1 -type d | gdmenu-gjs | xargs -r code

# Connect to a wifi network
nmcli -t -f SSID dev wifi | sort -u | gdmenu-gjs | xargs -r nmcli dev wifi connect

# Multi-select: open several files at once (one `code` invocation, all args)
find ~/Notes -name '*.md' | gdmenu-gjs | xargs -r code

# Multi-select where you need ONE command run per selected line instead
find ~/Projects -maxdepth 1 -type d | gdmenu-gjs | while read -r dir; do
    code "$dir"
done
```

**Exit codes**: `0` with output on selection, `1` with no output if
cancelled (Escape) — so `xargs -r` (don't run on empty input) or `&&`
chaining behaves correctly either way.

## Keybindings

| Key | Action |
|---|---|
| Type anything | Filter the list (multi-word, order-independent substring match) |
| `↓` / `↑` | Move selection down / up |
| `Enter` | Confirm — returns the multi-selected items if any are marked, otherwise the currently highlighted line |
| `Tab` | Toggle the highlighted line into/out of the multi-selection (marked with `●`), then advance to the next line |
| `Ctrl` + `Space` | Toggle the highlighted line into/out of the multi-selection **without** advancing |
| `Shift` + `Enter` | Toggle the highlighted line and advance, **without** closing the menu (handy for marking many items in a row) |
| `Esc` | Cancel — nothing is returned, menu closes |
| Mouse hover over a line | Highlights it |
| Mouse click on a line | Selects and confirms that line immediately (brief green flash before closing) |
| Click anywhere else in the menu | Refocuses the text entry so you can keep typing |

## Multi-select example

```bash
find ~/Projects -maxdepth 1 -type d | gdmenu-gjs | xargs -r code
```

1. Type to filter down to the projects you want.
2. Highlight one → press `Tab` (marks it with `●`, jumps to the next line).
3. Repeat for as many as you like.
4. Press `Enter` — every marked line is printed, one per output line.
5. `xargs -r code` opens them all in one editor window.

If nothing is marked when you press `Enter`, it just returns the single
currently-highlighted line — so single-select workflows need zero extra
steps.

## Customization

### Theme

Edit `stylesheet.css` in the extension folder — it ships with a
[Solarized Dark](https://ethanschoonover.com/solarized/) palette. Font
sizes, padding, hover/selected/click-flash colors are all plain CSS custom
properties on `St` widgets, so no JS changes are needed for restyling.

```bash
cp stylesheet.css ~/.local/share/gnome-shell/extensions/simple-dmenu@example.com/stylesheet.css
# log out / log in to apply
```

### Number of visible results

In `extension.js`:

```js
const ITEMS_PER_PAGE = 10;
```

Rendering is virtualized — only this many `St.Label` rows exist at once
regardless of how many lines were piped in, so raising this doesn't hurt
correctness, just adds more on-screen rows.

### Filter debounce

```js
const FILTER_DEBOUNCE_MS = 150;
```

Lower this for snappier filtering on small lists, raise it if you're
piping in very large lists (thousands of lines) and typing feels janky.

### D-Bus name / object path

If you want to avoid any naming collision with other extensions, change:

```js
const BUS_NAME = 'org.gnome.Shell.Extensions.SimpleDmenu';
const OBJECT_PATH = '/org/gnome/Shell/Extensions/SimpleDmenu';
const INTERFACE_NAME = 'org.gnome.Shell.Extensions.SimpleDmenu';
```

in both `extension.js` and `gdmenu-gjs`, and update `metadata.json`'s
`uuid` accordingly.

## Debugging

Watch GNOME Shell's logs while testing:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Common issues:

| Symptom | Likely cause |
|---|---|
| `gdmenu: could not reach extension` | Extension isn't enabled, or you haven't logged out/in since installing — check `gnome-extensions info simple-dmenu@example.com` |
| Call hangs indefinitely | A JS exception was thrown inside the extension before it could emit a signal — check `journalctl` for a stack trace |
| Typed text doesn't appear / no focus | Extension didn't grab entry focus in time — try clicking inside the box once as a workaround, then file an issue |
| Menu doesn't reflect `extension.js` edits | Wayland requires a full logout/login to reload shell extension code — there is no in-place reload like X11's `Alt+F2` → `r` |

## Architecture notes / why it's built this way

- **No `wlr-layer-shell`**: not supported by Mutter, so instead of a
  standalone client window, this runs as GJS code *inside* the compositor
  process, using `Main.layoutManager.addChrome()` — the same mechanism
  GNOME uses for the Activities overview and notification popups.
- **No `Main.pushModal`/`popModal`**: earlier versions used a full modal
  grab, but the grab-handle API has changed across GNOME Shell versions
  (some expect the actor, some expect a returned grab object), which caused
  hard-to-diagnose crashes. This version relies on `addChrome` + explicit
  key focus instead — simpler and version-stable, at the cost of not doing
  a true compositor-level input grab (clicking outside the box does not
  currently get blocked, only redirected to refocus the entry).
- **D-Bus signals, not blocking method replies**: `Show()` returns
  instantly; the actual result comes back later via a `Selected` or
  `Cancelled` signal. This means a bug in the UI code can never leave a
  D-Bus method invocation hanging — the caller isn't blocked on a promise
  the extension has to fulfill correctly, it's just listening for an event.