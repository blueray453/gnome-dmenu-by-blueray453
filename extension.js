import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { setLogging, setLogFn, journal } from './utils.js';

const SPEC_CACHE_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.cache', 'gnome-dbus-spec']);
const BUS_NAME = 'org.gnome.Shell.Extensions.SimpleDmenu';
const OBJECT_PATH = '/org/gnome/Shell/Extensions/SimpleDmenu';

const DBUS_INTERFACE = `<node>
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

const FILTER_DEBOUNCE_MS = 150;
const SCROLL_TIME = 0.15;

class DmenuService {
    constructor(extension) {
        this._extension = extension;
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(DBUS_INTERFACE, this);
        this._ownerId = null;
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

    /**
     * Exports the interface on the session bus and requests ownership of
     * the well-known name. Both steps are guarded: a failure here, e.g. a
     * second copy of the extension already owning the name, is logged
     * instead of throwing out of Extension.enable().
     */
    export() {
        // 1. Clean up any previous export, if any.
        this._unexportInterface();

        // 2. Release any previous bus-name ownership.
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = null;
        }

        // 3. Request the bus name and export the interface.
        this._ownerId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            (connection) => {
                // Bus acquired: export the interface on this connection.
                try {
                    this._dbusImpl.export(connection, OBJECT_PATH);
                    journal(`D-Bus interface exported on ${OBJECT_PATH}`);
                    this._exported = true;
                } catch (e) {
                    journal(`Failed to export D-Bus interface: ${e.message}`, true);
                    this._exported = false;
                }
            },
            (connection, name) => {
                // Name acquired.
                journal(`${name}: name acquired`);
            },
            (connection, name) => {
                // Name lost: clean up.
                journal(`${name}: name lost — another instance may already own it`, true);
                this._unexportInterface();
                this._ownerId = null;
            }
        );
    }

    unexport() {
        // Release the bus name. This triggers the name-lost callback,
        // which calls _unexportInterface().
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = null;
        }

        // Also directly unexport in case the name-lost callback has not fired yet.
        this._unexportInterface();
    }

    _unexportInterface() {
        // Idempotent cleanup: ignore "not exported" errors.
        try {
            if (this._dbusImpl) {
                this._dbusImpl.unexport();
                this._exported = false;
            }
        } catch (e) {
            if (!e.message.includes('not exported')) {
                journal(`Failed to unexport D-Bus interface: ${e.message}`, true);
            }
        }
    }
}

/**
 * Generate Pango markup with <b> tags around each occurrence of tokens in label.
 * Tokens are matched case-insensitively.
 */
function highlightLabel(label, tokens) {
    if (!tokens || tokens.length === 0)
        return GLib.markup_escape_text(label, -1);

    const escaped = GLib.markup_escape_text(label, -1);
    const lowerLabel = label.toLowerCase();
    const intervals = [];

    for (const token of tokens) {
        const lowerToken = token.toLowerCase();
        let idx = lowerLabel.indexOf(lowerToken);

        while (idx !== -1) {
            intervals.push({
                start: idx,
                end: idx + lowerToken.length,
            });
            idx = lowerLabel.indexOf(lowerToken, idx + 1);
        }
    }

    if (intervals.length === 0)
        return escaped;

    intervals.sort((a, b) => a.start - b.start);

    const merged = [intervals[0]];
    for (let i = 1; i < intervals.length; i++) {
        const last = merged[merged.length - 1];
        const cur = intervals[i];

        if (cur.start <= last.end)
            last.end = Math.max(last.end, cur.end);
        else
            merged.push(cur);
    }

    let markup = '';
    let pos = 0;

    for (const interval of merged) {
        if (interval.start > pos)
            markup += escaped.substring(pos, interval.start);

        markup += `<b>${escaped.substring(interval.start, interval.end)}</b>`;
        pos = interval.end;
    }

    if (pos < escaped.length)
        markup += escaped.substring(pos);

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
        this._rowActors = [];
        this._selectedIndex = 0;
        this._selectedItems = new Set();
        this._filterTimeoutId = null;
        this._scrollIdleId = null;
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
            let label;
            let id;

            if (typeof item === 'string') {
                label = item;
                id = item;
            } else {
                label = item.label;
                id = item.id || item.label;
            }

            if (idMap.has(id))
                id = `${id}_${index}`;

            idMap.set(id, true);

            return {
                label,
                icon: item.icon || null,
                data: item.data || null,
                id,
            };
        });

        this._actionMode = 'stdin';
        this._showItems(itemObjects, multi, hint, fullscreen);
    }

    showApps(multi = false, hint = null, fullscreen = false) {
        const appSystem = Shell.AppSystem.get_default();
        let apps = [];

        if (appSystem && typeof appSystem.get_all === 'function')
            apps = appSystem.get_all().filter(a => a.should_show());
        else
            apps = Gio.AppInfo.get_all().filter(a => a.should_show());

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
        if (typeof Shell.WindowTracker.get_default === 'function')
            tracker = Shell.WindowTracker.get_default();
        else
            tracker = Main.windowTracker;

        const items = windows.map(w => {
            let title = w.get_title();
            if (!title || title.trim() === '')
                title = 'Untitled';

            const app = tracker ? tracker.get_window_app(w) : null;
            const icon = app ? app.get_icon() : Gio.ThemedIcon.new('application-x-executable');

            return {
                label: title,
                icon,
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

                if (info)
                    icon = info.get_icon();
            } catch (e) {
                icon = Gio.ThemedIcon.new('folder');
            }

            if (!icon)
                icon = Gio.ThemedIcon.new('folder');

            return {
                label,
                icon,
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
        if (this._isOpen)
            this._closeInternal();

        if (this._scrollIdleId) {
            GLib.source_remove(this._scrollIdleId);
            this._scrollIdleId = null;
        }

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
            if (this._isOpen)
                this.entry.grab_key_focus();

            return GLib.SOURCE_REMOVE;
        });

        this._updateResults();
    }

    _closeInternal() {
        if (this._filterTimeoutId) {
            GLib.source_remove(this._filterTimeoutId);
            this._filterTimeoutId = null;
        }

        if (this._scrollIdleId) {
            GLib.source_remove(this._scrollIdleId);
            this._scrollIdleId = null;
        }

        if (!this._isOpen)
            return;

        Main.layoutManager.removeChrome(this.actor);
        this._isOpen = false;
        this._filterTokens = [];
        this._rowActors = [];
    }

    /**
     * Scrolls the native ScrollView so the currently selected row is fully
     * visible. This waits one idle cycle so Clutter can allocate the newly
     * created row actors before reading their allocation boxes.
     */
    _scrollSelectedIntoView() {
        if (this._rowActors.length === 0)
            return;

        const selectedRow = this._rowActors[this._selectedIndex];
        if (!selectedRow)
            return;

        const SCROLL_TIME = 0.15;

        /*
         * Wait one idle cycle so Clutter can allocate the newly created rows.
         * Without this, get_allocation_box() may still return zero-sized boxes.
         */
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._isOpen || !this._rowActors.includes(selectedRow))
                return GLib.SOURCE_REMOVE;

            const scrollView = this.results_container;
            const adjustment = scrollView.vadjustment;

            if (!adjustment)
                return GLib.SOURCE_REMOVE;

            const lower = adjustment.lower || 0;
            const upper = adjustment.upper || 0;

            let pageSize = adjustment.page_size;
            if (!pageSize)
                pageSize = scrollView.height;

            if (!pageSize)
                return GLib.SOURCE_REMOVE;

            /*
             * If the scroll view has a fade effect, avoid scrolling the selected
             * row underneath the faded top/bottom area.
             */
            let offset = 0;
            const vfade = scrollView.get_effect('fade');
            if (vfade && vfade.fade_margins)
                offset = vfade.fade_margins.top || 0;

            /*
             * Get the selected row's allocation box and translate its coordinates
             * up through its parents until we reach the scroll view.
             */
            let box = selectedRow.get_allocation_box();
            let y1 = box.y1;
            let y2 = box.y2;

            let parent = selectedRow.get_parent();
            while (parent && parent !== scrollView) {
                box = parent.get_allocation_box();
                y1 += box.y1;
                y2 += box.y1;
                parent = parent.get_parent();
            }

            if (parent !== scrollView)
                return GLib.SOURCE_REMOVE;

            const currentValue = adjustment.value;
            let newValue = currentValue;

            if (y1 < currentValue + offset) {
                // Selected row is above the visible area.
                newValue = y1 - offset;
            } else if (y2 > currentValue + pageSize - offset) {
                // Selected row is below the visible area.
                newValue = y2 + offset - pageSize;
            } else {
                // Already fully visible.
                return GLib.SOURCE_REMOVE;
            }

            const maxValue = Math.max(lower, upper - pageSize);
            newValue = Math.max(lower, Math.min(newValue, maxValue));

            if (newValue === currentValue)
                return GLib.SOURCE_REMOVE;

            if (typeof adjustment.ease === 'function') {
                adjustment.ease(newValue, {
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    duration: SCROLL_TIME,
                });
            } else {
                adjustment.value = newValue;
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    _onTextChanged() {
        if (this._filterTimeoutId)
            GLib.source_remove(this._filterTimeoutId);

        this._filterTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FILTER_DEBOUNCE_MS, () => {
            this._selectedIndex = 0;
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
                this._render();
            }
            return Clutter.EVENT_STOP;
        }

        if (sym === Clutter.KEY_Up) {
            if (this._visibleItems.length > 0) {
                this._selectedIndex = Math.max(0, this._selectedIndex - 1);
                this._render();
            }
            return Clutter.EVENT_STOP;
        }

        if (this._multiSelectEnabled) {
            if (sym === Clutter.KEY_Tab) {
                this._toggleCurrent();

                if (this._visibleItems.length > 0)
                    this._selectedIndex = Math.min(this._visibleItems.length - 1, this._selectedIndex + 1);

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

                this._render();
                return Clutter.EVENT_STOP;
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _toggleCurrent() {
        if (!this._multiSelectEnabled)
            return;

        if (this._visibleItems.length === 0 || this._selectedIndex >= this._visibleItems.length)
            return;

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
                            if (workspace)
                                workspace.activate_with_focus(win, timestamp);
                            else
                                win.activate(timestamp);
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

        if (resultLabels.length > 0)
            this._service.emitSelected(resultLabels);
        else
            this._service.emitCancelled();

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

        this._render();
    }

    _render() {
        this.results_box.remove_all_children();
        this._rowActors = [];

        for (let i = 0; i < this._visibleItems.length; i++) {
            const item = this._visibleItems[i];

            const row = new St.BoxLayout({
                vertical: false,
                style_class: 'dmenu-result-row',
                x_expand: true,
                reactive: true,
                track_hover: true,
            });

            const markerText = this._multiSelectEnabled && this._selectedItems.has(item.id)
                ? '●'
                : '';

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

            const markup = highlightLabel(item.label, this._filterTokens);

            const label = new St.Label({
                style_class: i === this._selectedIndex
                    ? 'dmenu-result dmenu-result-selected'
                    : 'dmenu-result',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            label.clutter_text.set_markup(markup);

            row.add_child(marker);

            if (iconActor)
                row.add_child(iconActor);

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
            this._rowActors.push(row);
        }

        this._scrollSelectedIntoView();
    }
};

export default class SimpleDmenuExtension extends Extension {
    _writeSpecCache(busName, interfaces) {
        try {
            GLib.mkdir_with_parents(SPEC_CACHE_DIR, 0o755);
            const spec = {
                bus_name: busName,
                generated_at: new Date().toISOString(),
                interfaces,
            };
            const filePath = GLib.build_filenamev([SPEC_CACHE_DIR, `${busName}.json`]);
            GLib.file_set_contents(filePath, JSON.stringify(spec, null, 2));
        } catch (e) {
            console.error(`[SimpleDmenu] failed to write spec cache: ${e.message}`);
        }
    }

    _removeSpecCache(busName) {
        try {
            const filePath = GLib.build_filenamev([SPEC_CACHE_DIR, `${busName}.json`]);
            const file = Gio.File.new_for_path(filePath);
            if (file.query_exists(null)) {
                file.delete(null);
            }
        } catch (e) {
            console.error(`[SimpleDmenu] failed to remove spec cache: ${e.message}`);
        }
    }
    enable() {
        setLogFn((msg, error = false) => {
            const level = error
                ? GLib.LogLevelFlags.LEVEL_CRITICAL
                : GLib.LogLevelFlags.LEVEL_MESSAGE;

            GLib.log_structured(
                'gnome-dmenu-by-blueray453',
                level,
                {
                    MESSAGE: `${msg}`,
                    SYSLOG_IDENTIFIER: 'gnome-dmenu-by-blueray453',
                    CODE_FILE: GLib.filename_from_uri(import.meta.url)[0],
                }
            );
        });

        setLogging(true);
        journal('Enabled');

        this._service = new DmenuService(this);
        this._service.export();

        this._ui = new DmenuUI(this._service);

        this._writeSpecCache(BUS_NAME, {
            'org.gnome.Shell.Extensions.SimpleDmenu': {
                object_path: '/org/gnome/Shell/Extensions/SimpleDmenu',
                xml: DBUS_INTERFACE,
            },
        });
    }

    disable() {
        this._ui?.hide();
        this._ui = null;

        this._service?.unexport();
        this._service = null;

        this._removeSpecCache(BUS_NAME);
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