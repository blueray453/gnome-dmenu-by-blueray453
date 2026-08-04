# gnome-dmenu-by-blueray453

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

A small CLI helper (`cli/gdmenu`) talks to the extension over D-Bus, so you
can pipe text into it from shell scripts exactly like classic `dmenu`:

```bash
echo -e "reboot\nshutdown\nlock" | gdmenu | xargs -I{} systemctl {}
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
- D-Bus signal–based architecture — `Show()` returns immediately, so a UI
  bug can never hang or crash the calling script's D-Bus connection
- Structured logging via `journal()`, filterable in `journalctl`

## How it works

| Piece | Role |
|---|---|
| `extension.js` | Runs inside GNOME Shell. Exports a D-Bus service (`org.gnome.Shell.Extensions.SimpleDmenu`) with a `Show(items)` method, and emits `Selected(items)` / `Cancelled` signals once the user picks something or presses Escape. |
| `stylesheet.css` | St/Clutter theming — colors, fonts, spacing (Solarized Dark by default). |
| `cli/gdmenu` | A standalone GJS CLI script, symlinked into your `$PATH` separately from the extension. Reads lines from stdin, calls `Show()` over D-Bus, blocks on a `GLib.MainLoop` until a `Selected`/`Cancelled` signal arrives, then prints the result(s) to stdout — behaving like a normal Unix filter. |

### 2. Install the CLI helper

Rather than copying `cli/gdmenu`, symlink it into your `$PATH` so pulling
future updates with `git pull` automatically updates the command too:

```bash
mkdir -p ~/.local/bin
chmod +x "$HOME/.local/share/gnome-shell/extensions/gnome-dmenu-by-blueray453/cli/gdmenu"
ln -sf "$HOME/.local/share/gnome-shell/extensions/gnome-dmenu-by-blueray453/cli/gdmenu" ~/.local/bin/gdmenu
```
Make sure `~/.local/bin` is on your `$PATH`

## Usage

Pipe any newline-separated text into `gdmenu`; the selected line(s) are
printed to stdout.

```bash
# Basic selection
echo -e "reboot\nshutdown\nlock" | gdmenu
```

**Exit codes**: `0` with output on selection, `1` with no output if
cancelled (Escape) — so `xargs -r` (don't run on empty input) or `&&`
chaining behaves correctly either way.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Type anything | Filter the list (multi-word, order-independent substring match) |
| `↓` | Move selection down |
| `↑` | Move selection up |
| `Enter` | Confirm — returns the multi-selected items if any are marked, otherwise the currently highlighted line |
| `Tab` | Toggle the highlighted line into/out of the multi-selection (marked with `●`), then advance to the next line |
| `Ctrl` + `Space` | Toggle the highlighted line into/out of the multi-selection **without** advancing |
| `Shift` + `Enter` | Toggle the highlighted line and advance, **without** closing the menu (handy for marking many items in a row) |
| `Esc` | Cancel — nothing is returned, menu closes |

## Mouse controls

| Action | Result |
|---|---|
| Hover over a line | Highlights it |
| Click a line | Selects and confirms that line immediately (brief green flash before closing) |
| Click anywhere else in the menu | Refocuses the text entry so you can keep typing |

## Multi-select example

```bash
find ~/Projects -maxdepth 1 -type d | gdmenu | xargs -r code
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

Edit `stylesheet.css` — it ships with a
[Solarized Dark](https://ethanschoonover.com/solarized/) palette. Font
sizes, padding, hover/selected/click-flash colors are all plain CSS on
`St` widgets, so no JS changes are needed for restyling.

```bash
cp stylesheet.css \
  ~/.local/share/gnome-shell/extensions/gnome-dmenu-by-blueray453/stylesheet.css
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

To avoid any naming collision with other extensions, change these
constants in both `extension.js` and `cli/gdmenu` (they must match
exactly in both files):

```js
const BUS_NAME = 'org.gnome.Shell.Extensions.SimpleDmenu';
const OBJECT_PATH = '/org/gnome/Shell/Extensions/SimpleDmenu';
```

## Debugging

Logging is structured via `journal()` in `utils.js` and tagged with
`SYSLOG_IDENTIFIER=gnome-dmenu-by-blueray453`, so you can filter cleanly
instead of scrolling through all of GNOME Shell's log noise:

```bash
journalctl -f -o cat SYSLOG_IDENTIFIER=gnome-dmenu-by-blueray453
```

Trigger the extension (run `gdmenu` in another terminal) while this is
running to see live output.

Logging is enabled by default (`setLogging(true)` in `enable()`). To
silence non-error messages, set it to `false`:

```js
setLogging(false);
```

Errors are always logged regardless of this setting, at
`GLib.LogLevelFlags.LEVEL_CRITICAL`, so they won't be missed even with
logging disabled.

