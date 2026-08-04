import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BUS_NAME = 'org.gnome.Shell.Extensions.SimpleDmenu';
const OBJECT_PATH = '/org/gnome/Shell/Extensions/SimpleDmenu';
const INTERFACE_NAME = 'org.gnome.Shell.Extensions.SimpleDmenu';

const DBUS_INTERFACE = `
<node>
  <interface name="org.gnome.Shell.Extensions.SimpleDmenu">
    <method name="Show">
      <arg type="as" name="items" direction="in"/>
    </method>
    <signal name="Selected">
      <arg type="as" name="items"/>
    </signal>
    <signal name="Cancelled"/>
  </interface>
</node>`;

const ITEMS_PER_PAGE = 10;
const FILTER_DEBOUNCE_MS = 150;

class DmenuService {
    constructor(extension) {
        this._extension = extension;
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(DBUS_INTERFACE, this);
    }

    // Fire-and-forget: returns immediately, actual result comes via signal.
    // Nothing about GNOME Shell is left "waiting" on a correct reply, so a
    // bug in the UI code later can't hang or crash the caller's D-Bus call.
    Show(items) {
        this._extension.show(items);
    }

    emitSelected(items) {
        this._dbusImpl.emit_signal('Selected', GLib.Variant.new('(as)', [items]));
    }

    emitCancelled() {
        this._dbusImpl.emit_signal('Cancelled', null);
    }

    export() {
        this._dbusImpl.export(Gio.DBus.session, OBJECT_PATH);
        this._ownerId = Gio.DBus.session.own_name(
            BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    }

    unexport() {
        this._dbusImpl.unexport();
        if (this._ownerId) {
            Gio.DBus.session.unown_name(this._ownerId);
            this._ownerId = null;
        }
    }
}

const DmenuUI = class {
    constructor(service) {
        this._service = service;

        this.actor = new St.BoxLayout({
            style_class: 'dmenu-container',
            vertical: true,
            reactive: true,
            can_focus: true,
        });

        this.entry = new St.Entry({
            style_class: 'dmenu-entry',
            hint_text: 'Type to filter · Enter: select · Tab: multi-select · Esc: cancel',
            can_focus: true,
            x_expand: true,
        });

        this.results_container = new St.ScrollView({
            style_class: 'dmenu-results-container',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
            reactive: true,
        });
        this.results_box = new St.BoxLayout({
            style_class: 'dmenu-results-box',
            vertical: true,
            reactive: true,
        });
        this.results_container.set_child(this.results_box);

        this.actor.add_child(this.entry);
        this.actor.add_child(this.results_container);

        const clutterText = this.entry.get_clutter_text();
        clutterText.connect('text-changed', this._onTextChanged.bind(this));

        // Return is consumed internally by ClutterText's 'activate' signal
        // before it would ever reach a key-press-event handler on a parent
        // actor — so Enter MUST be handled here, not in _onKeyPress.
        clutterText.connect('activate', this._activate.bind(this));

        // Navigation keys (Up/Down/Tab/Escape/Ctrl+Space/Shift+Enter) are not
        // consumed by ClutterText in a single-line entry, so these bubble fine.
        this.actor.connect('key-press-event', this._onKeyPress.bind(this));

        // Clicking anywhere in the menu (background, results area, empty
        // padding) should refocus the entry, not just clicking the entry itself.
        this.actor.connect('button-press-event', () => {
            this.entry.grab_key_focus();
            return Clutter.EVENT_STOP;
        });

        this._allItems = [];
        this._visibleItems = [];
        this._selectedIndex = 0;
        this._scrollStart = 0;
        this._selectedItems = new Set();
        this._filterTimeoutId = null;
        this._isOpen = false;
    }

    show(items) {
        if (this._isOpen)
            this._closeInternal();

        this._allItems = items;
        this.entry.set_text('');
        this._selectedIndex = 0;
        this._scrollStart = 0;
        this._selectedItems.clear();
        this._isOpen = true;

        const monitor = Main.layoutManager.primaryMonitor;
        this.actor.set_width(Math.min(1000, monitor.width - 100));
        this.actor.set_height(Math.min(600, monitor.height - 150));
        this.actor.set_position(
            monitor.x + Math.floor((monitor.width - this.actor.width) / 2),
            monitor.y + Math.floor(monitor.height / 6)
        );

        Main.layoutManager.addChrome(this.actor, { affectsInputRegion: true });

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._isOpen)
                this.entry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });

        this._updateResults();
    }

    hide() {
        this._closeInternal();
    }

    _closeInternal() {
        if (!this._isOpen)
            return;
        if (this._filterTimeoutId) {
            GLib.source_remove(this._filterTimeoutId);
            this._filterTimeoutId = null;
        }
        Main.layoutManager.removeChrome(this.actor);
        this._isOpen = false;
    }

    _onTextChanged() {
        if (this._filterTimeoutId)
            GLib.source_remove(this._filterTimeoutId);

        this._filterTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FILTER_DEBOUNCE_MS, () => {
            this._selectedIndex = 0;
            this._scrollStart = 0;
            this._updateResults();
            this._filterTimeoutId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _onKeyPress(actor, event) {
        const sym = event.get_key_symbol();
        const mods = event.get_state();

        if (sym === Clutter.KEY_Escape) {
            this._service.emitCancelled();
            this.hide();
            return Clutter.EVENT_STOP;
        }

        if (sym === Clutter.KEY_Down) {
            if (this._visibleItems.length > 0) {
                this._selectedIndex = Math.min(this._visibleItems.length - 1, this._selectedIndex + 1);
                this._updateScrollWindow();
                this._render();
            }
            return Clutter.EVENT_STOP;
        }

        if (sym === Clutter.KEY_Up) {
            if (this._visibleItems.length > 0) {
                this._selectedIndex = Math.max(0, this._selectedIndex - 1);
                this._updateScrollWindow();
                this._render();
            }
            return Clutter.EVENT_STOP;
        }

        // Tab: toggle current item into the multi-selection set, advance to next
        if (sym === Clutter.KEY_Tab) {
            this._toggleCurrent();
            if (this._visibleItems.length > 0)
                this._selectedIndex = Math.min(this._visibleItems.length - 1, this._selectedIndex + 1);
            this._updateScrollWindow();
            this._render();
            return Clutter.EVENT_STOP;
        }

        // Ctrl+Space: toggle current item without advancing
        if (sym === Clutter.KEY_space && (mods & Clutter.ModifierType.CONTROL_MASK)) {
            this._toggleCurrent();
            this._render();
            return Clutter.EVENT_STOP;
        }

        // Shift+Return: toggle current item and advance, without closing the menu
        if ((sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) &&
            (mods & Clutter.ModifierType.SHIFT_MASK)) {
            this._toggleCurrent();
            if (this._visibleItems.length > 0)
                this._selectedIndex = Math.min(this._visibleItems.length - 1, this._selectedIndex + 1);
            this._updateScrollWindow();
            this._render();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _toggleCurrent() {
        if (this._visibleItems.length === 0 || this._selectedIndex >= this._visibleItems.length)
            return;
        const item = this._visibleItems[this._selectedIndex];
        if (this._selectedItems.has(item))
            this._selectedItems.delete(item);
        else
            this._selectedItems.add(item);
    }

    // Plain Enter (or clicking a row): return the multi-selection if any
    // items were toggled, otherwise just the currently highlighted line.
    _activate() {
        let result = [];

        if (this._selectedItems.size > 0) {
            result = Array.from(this._selectedItems);
        } else if (this._visibleItems.length > 0 && this._selectedIndex < this._visibleItems.length) {
            result = [this._visibleItems[this._selectedIndex]];
        } else if (this.entry.get_text()) {
            result = [this.entry.get_text()];
        }

        if (result.length > 0)
            this._service.emitSelected(result);
        else
            this._service.emitCancelled();

        this.hide();
    }

    _updateResults() {
        const filter = this.entry.get_text().trim().toLowerCase();
        const tokens = filter.split(/\s+/).filter(t => t.length > 0);

        this._visibleItems = tokens.length === 0
            ? this._allItems
            : this._allItems.filter(item => {
                const lower = item.toLowerCase();
                return tokens.every(tok => lower.includes(tok));
            });

        this._updateScrollWindow();
        this._render();
    }

    _updateScrollWindow() {
        if (this._visibleItems.length === 0) {
            this._scrollStart = 0;
            return;
        }
        const buffer = Math.floor(ITEMS_PER_PAGE / 4);

        if (this._selectedIndex < this._scrollStart + buffer) {
            this._scrollStart = Math.max(0, this._selectedIndex - buffer);
        } else if (this._selectedIndex >= this._scrollStart + ITEMS_PER_PAGE - buffer) {
            this._scrollStart = Math.min(
                Math.max(0, this._visibleItems.length - ITEMS_PER_PAGE),
                this._selectedIndex - ITEMS_PER_PAGE + buffer + 1
            );
        }
        this._scrollStart = Math.max(0, this._scrollStart);
    }

    // Only renders the current page window (ITEMS_PER_PAGE actors max),
    // regardless of how many lines were piped in — keeps things responsive
    // with thousands of input lines.
    _render() {
        this.results_box.remove_all_children();

        const end = Math.min(this._scrollStart + ITEMS_PER_PAGE, this._visibleItems.length);
        for (let i = this._scrollStart; i < end; i++) {
            const item = this._visibleItems[i];
            const row = new St.BoxLayout({
                vertical: false,
                style_class: 'dmenu-result-row',
                x_expand: true,
                reactive: true,
                track_hover: true,
            });

            const marker = new St.Label({
                text: this._selectedItems.has(item) ? '●' : '',
                style_class: 'dmenu-marker',
                y_align: Clutter.ActorAlign.CENTER,
            });

            const label = new St.Label({
                text: item,
                style_class: i === this._selectedIndex
                    ? 'dmenu-result dmenu-result-selected'
                    : 'dmenu-result',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            row.add_child(marker);
            row.add_child(label);

            // Hover: give clear visual feedback that a row is clickable,
            // even before the user clicks anything.
            row.connect('enter-event', () => {
                label.add_style_class_name('dmenu-result-hover');
                return Clutter.EVENT_PROPAGATE;
            });
            row.connect('leave-event', () => {
                label.remove_style_class_name('dmenu-result-hover');
                return Clutter.EVENT_PROPAGATE;
            });

            // Click: flash a distinct "clicked" style briefly so the user
            // sees confirmation of what was picked, then activate.
            const rowIndex = i;
            row.connect('button-press-event', () => {
                label.remove_style_class_name('dmenu-result-hover');
                label.add_style_class_name('dmenu-result-clicked');
                this._selectedIndex = rowIndex;

                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    this._activate();
                    return GLib.SOURCE_REMOVE;
                });
                return Clutter.EVENT_STOP;
            });

            this.results_box.add_child(row);
        }
    }
};

export default class SimpleDmenuExtension extends Extension {
    enable() {
        this._service = new DmenuService(this);
        this._service.export();
        this._ui = new DmenuUI(this._service);
    }

    disable() {
        this._ui?.hide();
        this._ui = null;
        this._service?.unexport();
        this._service = null;
    }

    show(items) {
        this._ui.show(items);
    }
}