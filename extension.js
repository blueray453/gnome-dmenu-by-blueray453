import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { setLogging, setLogFn, journal } from './utils.js';

const BUS_NAME = 'org.gnome.Shell.Extensions.SimpleDmenu';
const OBJECT_PATH = '/org/gnome/Shell/Extensions/SimpleDmenu';

const DBUS_INTERFACE = `
<node>
  <interface name="org.gnome.Shell.Extensions.SimpleDmenu">
    <method name="Show">
      <arg type="as" name="items" direction="in"/>
      <arg type="b" name="multi" direction="in"/>
      <arg type="s" name="hint" direction="in"/>
      <arg type="b" name="fullscreen" direction="in"/>
    </method>
    <method name="ShowApps">
      <arg type="b" name="multi" direction="in"/>
      <arg type="s" name="hint" direction="in"/>
      <arg type="b" name="fullscreen" direction="in"/>
    </method>
    <method name="ShowWindows">
      <arg type="b" name="multi" direction="in"/>
      <arg type="s" name="hint" direction="in"/>
      <arg type="b" name="fullscreen" direction="in"/>
    </method>
    <method name="ShowPaths">
      <arg type="as" name="paths" direction="in"/>
      <arg type="b" name="multi" direction="in"/>
      <arg type="s" name="hint" direction="in"/>
      <arg type="b" name="fullscreen" direction="in"/>
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

    Show(items, multi, hint, fullscreen) {
        this._extension.show(items, multi, hint, fullscreen);
    }

    ShowApps(multi, hint, fullscreen) {
        this._extension.showApps(multi, hint, fullscreen);
    }

    ShowWindows(multi, hint, fullscreen) {
        this._extension.showWindows(multi, hint, fullscreen);
    }

    ShowPaths(paths, multi, hint, fullscreen) {
        this._extension.showPaths(paths, multi, hint, fullscreen);
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

/**
 * Generate Pango markup with <b> tags around each occurrence of tokens in label.
 * Tokens are matched case‑insensitively.
 */
function highlightLabel(label, tokens) {
    if (!tokens || tokens.length === 0) {
        return GLib.markup_escape_text(label, -1);
    }
    const escaped = GLib.markup_escape_text(label, -1);
    const lowerLabel = label.toLowerCase();
    const intervals = [];
    for (const token of tokens) {
        const lowerToken = token.toLowerCase();
        let idx = lowerLabel.indexOf(lowerToken);
        while (idx !== -1) {
            intervals.push({ start: idx, end: idx + lowerToken.length });
            idx = lowerLabel.indexOf(lowerToken, idx + 1);
        }
    }
    if (intervals.length === 0) return escaped;

    intervals.sort((a, b) => a.start - b.start);
    const merged = [intervals[0]];
    for (let i = 1; i < intervals.length; i++) {
        const last = merged[merged.length - 1];
        const cur = intervals[i];
        if (cur.start <= last.end) {
            last.end = Math.max(last.end, cur.end);
        } else {
            merged.push(cur);
        }
    }

    let markup = '';
    let pos = 0;
    for (const interval of merged) {
        if (interval.start > pos) {
            markup += escaped.substring(pos, interval.start);
        }
        markup += '<b>' + escaped.substring(interval.start, interval.end) + '</b>';
        pos = interval.end;
    }
    if (pos < escaped.length) {
        markup += escaped.substring(pos);
    }
    return markup;
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
        clutterText.connect('activate', this._activate.bind(this));

        this.actor.connect('key-press-event', this._onKeyPress.bind(this));
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
        this._multiSelectEnabled = false;
        this._fullscreen = false;
        this._actionMode = 'stdin';
        this._filterTokens = [];
    }

    // ---------- Public API ----------

    show(items, multi = false, hint = null, fullscreen = false) {
        const idMap = new Map();
        const itemObjects = items.map((item, index) => {
            let label, id;
            if (typeof item === 'string') {
                label = item;
                id = item;
            } else {
                label = item.label;
                id = item.id || item.label;
            }
            if (idMap.has(id)) {
                id = `${id}_${index}`;
            }
            idMap.set(id, true);
            return {
                label: label,
                icon: item.icon || null,
                data: item.data || null,
                id: id,
            };
        });
        this._actionMode = 'stdin';
        this._showItems(itemObjects, multi, hint, fullscreen);
    }

    showApps(multi = false, hint = null, fullscreen = false) {
        let appSystem = Shell.AppSystem.get_default();
        let apps = [];
        if (appSystem && typeof appSystem.get_all === 'function') {
            apps = appSystem.get_all().filter(a => a.should_show());
        } else {
            apps = Gio.AppInfo.get_all().filter(a => a.should_show());
        }
        apps.sort((a, b) => a.get_name().localeCompare(b.get_name()));
        const items = apps.map(a => ({
            label: a.get_name(),
            icon: a.get_icon(),
            data: a,
            id: a.get_id(),
        }));
        this._actionMode = 'drun';
        this._showItems(items, multi, hint, fullscreen);
    }

    showWindows(multi = false, hint = null, fullscreen = false) {
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
        let tracker = null;
        if (typeof Shell.WindowTracker.get_default === 'function') {
            tracker = Shell.WindowTracker.get_default();
        } else {
            tracker = Main.windowTracker;
        }
        const items = windows.map(w => {
            let title = w.get_title();
            if (!title || title.trim() === '') title = 'Untitled';
            let app = tracker ? tracker.get_window_app(w) : null;
            const icon = app ? app.get_icon() : Gio.ThemedIcon.new('application-x-executable');
            return {
                label: title,
                icon: icon,
                data: w,
                id: String(w.get_id()),
            };
        });
        this._actionMode = 'window';
        this._showItems(items, multi, hint, fullscreen);
    }

    showPaths(paths, multi = false, hint = null, fullscreen = false) {
        const items = paths.map(path => {
            const label = path;
            let icon = null;
            try {
                const file = Gio.File.new_for_path(path);
                const info = file.query_info(
                    Gio.FILE_ATTRIBUTE_STANDARD_ICON,
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );
                if (info) icon = info.get_icon();
            } catch (e) {
                icon = Gio.ThemedIcon.new('folder');
            }
            if (!icon) icon = Gio.ThemedIcon.new('folder');
            return {
                label: label,
                icon: icon,
                data: path,
                id: path,
            };
        });
        this._actionMode = 'paths';
        this._showItems(items, multi, hint, fullscreen);
    }

    hide() {
        this._closeInternal();
    }

    // ---------- Internal UI logic ----------

    _showItems(items, multi, hint, fullscreen) {
        if (this._isOpen) this._closeInternal();

        this._allItems = items;
        this._multiSelectEnabled = multi;
        this._fullscreen = fullscreen;
        if (hint) {
            this.entry.set_hint_text(hint);
        } else if (multi) {
            this.entry.set_hint_text('Type to filter · Enter: select · Tab: multi-select · Esc: cancel');
        } else {
            this.entry.set_hint_text('Type to filter · Enter: select · Esc: cancel');
        }
        this.entry.set_text('');
        this._selectedIndex = 0;
        this._scrollStart = 0;
        this._selectedItems.clear();
        this._filterTokens = [];
        this._isOpen = true;

        const monitor = Main.layoutManager.primaryMonitor;
        if (fullscreen) {
            this.actor.set_width(monitor.width);
            this.actor.set_height(monitor.height);
            this.actor.set_position(monitor.x, monitor.y);
        } else {
            this.actor.set_width(Math.min(1000, monitor.width - 100));
            this.actor.set_height(Math.min(600, monitor.height - 150));
            this.actor.set_position(
                monitor.x + Math.floor((monitor.width - this.actor.width) / 2),
                monitor.y + Math.floor(monitor.height / 6)
            );
        }

        Main.layoutManager.addChrome(this.actor, { affectsInputRegion: true });

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._isOpen) this.entry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });

        this._updateResults();
    }

    _closeInternal() {
        if (!this._isOpen) return;
        if (this._filterTimeoutId) {
            GLib.source_remove(this._filterTimeoutId);
            this._filterTimeoutId = null;
        }
        Main.layoutManager.removeChrome(this.actor);
        this._isOpen = false;
        this._filterTokens = [];
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

        if (this._multiSelectEnabled) {
            if (sym === Clutter.KEY_Tab) {
                this._toggleCurrent();
                if (this._visibleItems.length > 0)
                    this._selectedIndex = Math.min(this._visibleItems.length - 1, this._selectedIndex + 1);
                this._updateScrollWindow();
                this._render();
                return Clutter.EVENT_STOP;
            }

            if (sym === Clutter.KEY_space && (mods & Clutter.ModifierType.CONTROL_MASK)) {
                this._toggleCurrent();
                this._render();
                return Clutter.EVENT_STOP;
            }

            if ((sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) &&
                (mods & Clutter.ModifierType.SHIFT_MASK)) {
                this._toggleCurrent();
                if (this._visibleItems.length > 0)
                    this._selectedIndex = Math.min(this._visibleItems.length - 1, this._selectedIndex + 1);
                this._updateScrollWindow();
                this._render();
                return Clutter.EVENT_STOP;
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _toggleCurrent() {
        if (!this._multiSelectEnabled) return;
        if (this._visibleItems.length === 0 || this._selectedIndex >= this._visibleItems.length) return;
        const item = this._visibleItems[this._selectedIndex];
        const id = item.id;
        if (this._selectedItems.has(id))
            this._selectedItems.delete(id);
        else
            this._selectedItems.add(id);
    }

    _activate() {
        let resultLabels = [];
        let selectedItems = [];

        if (this._multiSelectEnabled && this._selectedItems.size > 0) {
            selectedItems = this._visibleItems.filter(item =>
                this._selectedItems.has(item.id)
            );
        } else if (this._visibleItems.length > 0 && this._selectedIndex < this._visibleItems.length) {
            selectedItems = [this._visibleItems[this._selectedIndex]];
        } else if (this.entry.get_text()) {
            resultLabels = [this.entry.get_text()];
        }

        if (selectedItems.length > 0) {
            if (this._actionMode === 'drun') {
                for (const item of selectedItems) {
                    const app = item.data;
                    if (app && typeof app.launch === 'function') {
                        try {
                            app.launch([], null);
                        } catch (e) {
                            journal(`Failed to launch ${item.label}: ${e.message}`, true);
                        }
                    }
                }
                resultLabels = selectedItems.map(item => item.label);
            } else if (this._actionMode === 'window') {
                const timestamp = global.get_current_time();
                for (const item of selectedItems) {
                    const win = item.data;
                    if (win) {
                        try {
                            const workspace = win.get_workspace();
                            if (workspace) {
                                workspace.activate_with_focus(win, timestamp);
                            } else {
                                win.activate(timestamp);
                            }
                        } catch (e) {
                            journal(`Failed to activate window ${item.label}: ${e.message}`, true);
                        }
                    }
                }
                resultLabels = selectedItems.map(item => item.label);
            } else if (this._actionMode === 'paths') {
                resultLabels = selectedItems.map(item => item.data);
            } else {
                resultLabels = selectedItems.map(item => item.label);
            }
        }

        if (resultLabels.length > 0) {
            this._service.emitSelected(resultLabels);
        } else {
            this._service.emitCancelled();
        }

        this.hide();
    }

    _updateResults() {
        const filter = this.entry.get_text().trim().toLowerCase();
        const tokens = filter.split(/\s+/).filter(t => t.length > 0);
        this._filterTokens = tokens;

        this._visibleItems = tokens.length === 0
            ? this._allItems
            : this._allItems.filter(item => {
                const lower = item.label.toLowerCase();
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

            const markerText = this._multiSelectEnabled && this._selectedItems.has(item.id) ? '●' : '';
            const marker = new St.Label({
                text: markerText,
                style_class: 'dmenu-marker',
                y_align: Clutter.ActorAlign.CENTER,
            });

            let iconActor = null;
            if (item.icon) {
                iconActor = new St.Icon({
                    gicon: item.icon,
                    style_class: 'dmenu-icon',
                    y_align: Clutter.ActorAlign.CENTER,
                });
            }

            // Create label with markup support
            const markup = highlightLabel(item.label, this._filterTokens);
            const label = new St.Label({
                style_class: i === this._selectedIndex
                    ? 'dmenu-result dmenu-result-selected'
                    : 'dmenu-result',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });
            // Use the underlying ClutterText to set markup
            label.clutter_text.set_markup(markup);

            row.add_child(marker);
            if (iconActor) row.add_child(iconActor);
            row.add_child(label);

            row.connect('enter-event', () => {
                label.add_style_class_name('dmenu-result-hover');
                return Clutter.EVENT_PROPAGATE;
            });
            row.connect('leave-event', () => {
                label.remove_style_class_name('dmenu-result-hover');
                return Clutter.EVENT_PROPAGATE;
            });

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
        setLogFn((msg, error = false) => {
            let level = error ? GLib.LogLevelFlags.LEVEL_CRITICAL : GLib.LogLevelFlags.LEVEL_MESSAGE;
            GLib.log_structured(
                'gnome-dmenu-by-blueray453',
                level,
                {
                    MESSAGE: `${msg}`,
                    SYSLOG_IDENTIFIER: 'gnome-dmenu-by-blueray453',
                    CODE_FILE: GLib.filename_from_uri(import.meta.url)[0]
                }
            );
        });
        setLogging(true);
        journal('Enabled');

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

    show(items, multi = false, hint = null, fullscreen = false) {
        this._ui.show(items, multi, hint, fullscreen);
    }

    showApps(multi = false, hint = null, fullscreen = false) {
        this._ui.showApps(multi, hint, fullscreen);
    }

    showWindows(multi = false, hint = null, fullscreen = false) {
        this._ui.showWindows(multi, hint, fullscreen);
    }

    showPaths(paths, multi = false, hint = null, fullscreen = false) {
        this._ui.showPaths(paths, multi, hint, fullscreen);
    }
}