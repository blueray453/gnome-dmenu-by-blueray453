# gnome-dmenu-by-blueray453

A `dmenu`/`rofi`-style application launcher, window switcher, and
text-selection prompt for **GNOME Shell on Wayland**.

GNOME's Wayland compositor (Mutter) does not support the `wlr-layer-shell`
protocol, so traditional tools like `rofi` and `wofi` cannot overlay
themselves on top of other windows, steal keyboard focus, or float above
everything else. This project sidesteps that entirely by implementing the
prompt as a **GNOME Shell extension** — it runs inside the `gnome-shell`
process itself and uses the compositor's own APIs (`St`, `Clutter`,
`Main.layoutManager.addChrome`) to draw and focus itself, no layer-shell
required.

A small CLI helper (`cli/gdmenu`) talks to the extension over D-Bus, so you
can pipe text into it from shell scripts exactly like classic `dmenu`, or
use it directly as an app launcher / window switcher / file picker.

## Features

- Full-screen or floating overlay drawn above all other windows, no
  layer-shell needed
- Four modes: plain text (stdin), app launcher, window switcher, file paths
- Fuzzy substring filtering as you type (multi-word, order-independent),
  with matched text bolded in the results
- Icons shown for apps, windows, and file paths
- Keyboard navigation (arrows, Tab, etc.)
- **Multi-select** support — mark several items and return them all at once
- Mouse support — hover highlighting, click a line to select it
- Debounced filtering + virtualized rendering, so it stays responsive even
  with thousands of piped-in lines
- Solarized Dark theme out of the box (easily restyled via CSS)
- D-Bus signal–based architecture — `Show*()` methods return immediately,
  so a UI bug can never hang or crash the calling script's D-Bus connection
- Structured logging via `journal()`, filterable in `journalctl`


## Install the CLI helper

Rather than copying `cli/gdmenu`, symlink it into your `$PATH` so pulling
future updates with `git pull` automatically updates the command too:

```bash
mkdir -p ~/.local/bin
chmod +x "$HOME/.local/share/gnome-shell/extensions/gnome-dmenu-by-blueray453/cli/gdmenu"
ln -sf "$HOME/.local/share/gnome-shell/extensions/gnome-dmenu-by-blueray453/cli/gdmenu" ~/.local/bin/gdmenu
```
Make sure `~/.local/bin` is on your `$PATH`

## Usage

```
gdmenu [OPTIONS]
```

### Modes (choose one)

| Flag | Behavior |
|---|---|
| *(none)* | Reads plain text lines from stdin |
| `--drun` | Shows installed applications (app launcher); selecting one launches it directly |
| `--window` | Shows currently open windows (window switcher); selecting one focuses it directly |
| `--paths` | Reads file paths from stdin and displays them with file-type icons |

### Options

| Flag | Effect |
|---|---|
| `--multi` | Enable multi-select (default: off) |
| `--hint TEXT` | Custom hint text shown in the search entry |
| `--fullscreen` | Make the menu fill the entire screen instead of a centered floating box |
| `--help`, `-h` | Show usage help |

**Exit codes**: `0` with output on selection, `1` with no output if
cancelled (Escape) or no input was given; `2` on a connection/D-Bus error —
so `xargs -r` (don't run on empty input) or `&&` chaining behaves correctly.

Note: `--drun` and `--window` act immediately when you select an item
(launching the app / focusing the window) *in addition to* printing the
label to stdout — you don't need to pipe the output anywhere for those two
modes to be useful on their own.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Type anything | Filter the list (multi-word, order-independent substring match, matches bolded) |
| `↓` | Move selection down |
| `↑` | Move selection up |
| `Enter` | Confirm — returns the multi-selected items if any are marked, otherwise the currently highlighted line |
| `Tab` *(multi-select only)* | Toggle the highlighted item into/out of the selection (marked with `●`), then advance to the next item |
| `Ctrl` + `Space` *(multi-select only)* | Toggle the highlighted item into/out of the selection **without** advancing |
| `Shift` + `Enter` *(multi-select only)* | Toggle the highlighted item and advance, **without** closing the menu |
| `Esc` | Cancel — nothing is returned, menu closes |

`Tab`, `Ctrl+Space`, and `Shift+Enter` only do anything when `--multi` was
passed; without it they're no-ops.

## Mouse controls

| Action | Result |
|---|---|
| Hover over a line | Highlights it |
| Click a line | Selects and confirms that line immediately (brief green flash before closing) |
| Click anywhere else in the menu | Refocuses the text entry so you can keep typing |

## Commands to test

### 1. No mode — stdin (plain text)

```bash
# Basic
echo -e "Option 1\nOption 2" | gdmenu

# With multi-select and custom hint
echo -e "Apple\nBanana\nCherry" | gdmenu --multi --hint "Pick fruits"

# With fullscreen and hint
echo -e "Alpha\nBeta\nGamma" | gdmenu --fullscreen --hint "Select a letter"

# All options together
echo -e "One\nTwo\nThree" | gdmenu --multi --hint "Choose one or more" --fullscreen
```

### 2. Application launcher (`--drun`)

```bash
# Basic app launcher
gdmenu --drun

# With multi-select
gdmenu --drun --multi

# With custom hint and fullscreen
gdmenu --drun --hint "Launch an app" --fullscreen

# All options
gdmenu --drun --multi --hint "Select apps to run" --fullscreen
```

### 3. Window switcher (`--window`)

```bash
# Basic window switcher
gdmenu --window

# With multi-select
gdmenu --window --multi

# With custom hint and fullscreen
gdmenu --window --hint "Switch to window" --fullscreen

# All options
gdmenu --window --multi --hint "Select windows to focus" --fullscreen
```

### 4. File paths with icons (`--paths`)

```bash
# Basic – read from a file
cat ~/.dotfiles/rofi-bookmarks-list | gdmenu --paths

# With custom hint and fullscreen
cat ~/.dotfiles/rofi-bookmarks-list | gdmenu --paths --hint "Select a bookmark" --fullscreen

# With multi-select
cat ~/.dotfiles/rofi-bookmarks-list | gdmenu --paths --multi --hint "Pick one or more" --fullscreen

# All options
cat ~/.dotfiles/rofi-bookmarks-list | gdmenu --paths --multi --hint "Choose bookmarks" --fullscreen
```

### 5. Help

```bash
gdmenu --help
```

## Multi-select example

```bash
find . -maxdepth 1 -type d | gdmenu --paths --multi --fullscreen --hint "Select directories" | xargs -r codium
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
sizes, padding, hover/selected/click-flash colors, and icon size are all
plain CSS on `St` widgets, so no JS changes are needed for restyling.

```bash
cp stylesheet.css \
  ~/.local/share/gnome-shell/extensions/gnome-dmenu-by-blueray453/stylesheet.css
# log out / log in to apply
```

Note: icon sizing uses St's `icon-size` property rather than `width`/
`height` — `width`/`height` only sets the layout box and doesn't tell the
icon theme what resolution to load, which causes blurry upscaled icons.

### Number of visible results

In `extension.js`:

```js
const ITEMS_PER_PAGE = 10;
```

Rendering is virtualized — only this many rows exist at once regardless of
how many items were loaded, so raising this doesn't hurt correctness, just
adds more on-screen rows.

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

