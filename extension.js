import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DMenuIface = `
<node>
  <interface name="org.gnome.Shell.Extensions.SimpleDmenu">
    <method name="Prompt">
      <arg type="as" direction="in" name="lines"/>
      <arg type="s" direction="out" name="selection"/>
    </method>
  </interface>
</node>`;

const MAX_VISIBLE = 10;

const DMenu = GObject.registerClass(
    {
        Signals: {
            'selected': { param_types: [GObject.TYPE_STRING] },
            'cancelled': {},
        },
    },
    class DMenu extends St.BoxLayout {
        _init(lines) {
            super._init({
                vertical: true,
                style_class: 'dmenu-box',
                reactive: true,
                can_focus: true,
            });

            this._allLines = lines;
            this._filtered = lines.slice(0, MAX_VISIBLE);
            this._selectedIndex = 0;

            this._entry = new St.Entry({
                style_class: 'dmenu-entry',
                hint_text: 'Type to filter, Enter to select, Esc to cancel',
                can_focus: true,
            });
            this.add_child(this._entry);

            this._resultsBox = new St.BoxLayout({ vertical: true, style_class: 'dmenu-results' });
            this.add_child(this._resultsBox);

            this._entry.clutter_text.connect('text-changed', () => {
                this._filterLines(this._entry.get_text());
            });
            this._entry.clutter_text.connect('key-press-event', this._onKeyPress.bind(this));

            this._render();
        }

        focusEntry() {
            this._entry.grab_key_focus();
        }

        _filterLines(query) {
            const q = query.toLowerCase();
            this._filtered = q
                ? this._allLines.filter(l => l.toLowerCase().includes(q)).slice(0, MAX_VISIBLE)
                : this._allLines.slice(0, MAX_VISIBLE);
            this._selectedIndex = 0;
            this._render();
        }

        _render() {
            this._resultsBox.destroy_all_children();
            this._filtered.forEach((line, i) => {
                const label = new St.Label({
                    text: line,
                    style_class: i === this._selectedIndex
                        ? 'dmenu-result dmenu-result-selected'
                        : 'dmenu-result',
                });
                this._resultsBox.add_child(label);
            });
        }

        _onKeyPress(actor, event) {
            const sym = event.get_key_symbol();

            if (sym === Clutter.KEY_Escape) {
                this.emit('cancelled');
                return Clutter.EVENT_STOP;
            }

            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                const choice = this._filtered.length > 0
                    ? this._filtered[this._selectedIndex]
                    : this._entry.get_text();
                if (choice)
                    this.emit('selected', choice);
                else
                    this.emit('cancelled');
                return Clutter.EVENT_STOP;
            }

            if (sym === Clutter.KEY_Down) {
                if (this._filtered.length > 0) {
                    this._selectedIndex = (this._selectedIndex + 1) % this._filtered.length;
                    this._render();
                }
                return Clutter.EVENT_STOP;
            }

            if (sym === Clutter.KEY_Up) {
                if (this._filtered.length > 0) {
                    this._selectedIndex =
                        (this._selectedIndex - 1 + this._filtered.length) % this._filtered.length;
                    this._render();
                }
                return Clutter.EVENT_STOP;
            }

            if (sym === Clutter.KEY_Tab) {
                if (this._filtered.length > 0) {
                    this._entry.set_text(this._filtered[this._selectedIndex]);
                    this._entry.clutter_text.set_cursor_position(-1);
                }
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        }
    });

class DMenuDBusService {
    constructor(extension) {
        this._extension = extension;
        this._impl = Gio.DBusExportedObject.wrapJSObject(DMenuIface, this);
        this._impl.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/SimpleDmenu');
    }

    PromptAsync(params, invocation) {
        const [lines] = params;
        try {
            this._extension.openPrompt(lines, (selection) => {
                try {
                    invocation.return_value(new GLib.Variant('(s)', [selection ?? '']));
                } catch (e) {
                    logError(e, 'SimpleDmenu: failed to return D-Bus value');
                }
            });
        } catch (e) {
            logError(e, 'SimpleDmenu: openPrompt threw');
            invocation.return_error_literal(
                Gio.DBusError, Gio.DBusError.FAILED, `SimpleDmenu error: ${e}`);
        }
    }

    destroy() {
        this._impl.unexport();
    }
}

export default class SimpleDmenuExtension extends Extension {
    enable() {
        this._menu = null;
        this._grab = null;
        this._pendingCallback = null;
        this._service = new DMenuDBusService(this);
    }

    openPrompt(lines, onSelect) {
        if (this._menu)
            this._closeMenu(null);

        this._pendingCallback = onSelect;
        this._menu = new DMenu(lines);

        this._menu.connect('selected', (_actor, text) => this._closeMenu(text));
        this._menu.connect('cancelled', () => this._closeMenu(null));

        Main.layoutManager.addChrome(this._menu, { affectsInputRegion: true });

        const monitor = Main.layoutManager.primaryMonitor;
        this._menu.set_width(Math.min(700, monitor.width - 100));
        this._menu.set_position(
            monitor.x + Math.floor((monitor.width - this._menu.width) / 2),
            monitor.y + Math.floor(monitor.height / 4)
        );

        // IMPORTANT: pushModal returns a grab handle on modern GNOME Shell.
        // That handle — not the actor — must be passed to popModal later.
        this._grab = Main.pushModal(this._menu);

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._menu?.focusEntry();
            return GLib.SOURCE_REMOVE;
        });
    }

    _closeMenu(result) {
        if (!this._menu)
            return;

        try {
            if (this._grab) {
                Main.popModal(this._grab);
                this._grab = null;
            }
            Main.layoutManager.removeChrome(this._menu);
            this._menu.destroy();
        } catch (e) {
            logError(e, 'SimpleDmenu: error while closing menu');
        }
        this._menu = null;

        const cb = this._pendingCallback;
        this._pendingCallback = null;
        if (cb)
            cb(result);
    }

    disable() {
        this._closeMenu(null);
        this._service?.destroy();
        this._service = null;
    }
}