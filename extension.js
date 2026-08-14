import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';
import { setLogging, setLogFn, journal } from './utils.js';

const SPEC_CACHE_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.cache', 'gnome-dbus-spec']);
const SPEC_CACHE_FILE = 'simple-dmenu.json';

const BUS_NAME = 'io.github.blueray453.SimpleDmenu';
const OBJECT_PATH = '/io/github/blueray453/SimpleDmenu';

const DBUS_INTERFACE = `<node>
  <interface name="io.github.blueray453.SimpleDmenu">
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

    export() {
        this._unexportInterface();

        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = null;
        }

        this._ownerId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            (connection) => {
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
                journal(`${name}: name acquired`);
            },
            (connection, name) => {
                journal(`${name}: name lost — another instance may already own it`, true);
                this._unexportInterface();
                this._ownerId = null;
            }
        );
    }

    unexport() {
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = null;
        }
        this._unexportInterface();
    }

    _unexportInterface() {
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

        // Main horizontal container
        this.actor = new St.BoxLayout({
            style_class: 'dmenu-container',
            vertical: false,
            reactive: true,
            can_focus: true,
        });

        // Left column: menu
        this._leftBox = new St.BoxLayout({
            style_class: 'dmenu-left-box',
            vertical: true,
            x_expand: false,
            y_expand: true,
        });

        // Right column: preview (visible only in window mode without fullscreen)
        this._previewBox = new St.BoxLayout({
            style_class: 'dmenu-preview-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
            visible: false,
        });

        this.actor.add_child(this._leftBox);
        this.actor.add_child(this._previewBox);

        // Pinned apps bar
        this.pinned_bar = new St.BoxLayout({
            style_class: 'dmenu-pinned-bar',
            vertical: false,
            x_expand: true,
        });
        this.pinned_bar.hide();

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

        this._leftBox.add_child(this.pinned_bar);
        this._leftBox.add_child(this.entry);
        this._leftBox.add_child(this.results_container);

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

        // Pin / context-menu state
        this._appFavorites = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this.actor);
        this._openMenu = null;

        // Preview state

        this._previewClone = null;
        this._previewOverlay = null;
        this._previewTitle = null;
        this._previewCloseButton = null;

        this._previewWindow = null;
        this._previewWindowId = 0;
        this._previewUnmanagedId = 0;

        this._showPreview = false;
        this._previewBoxWidth = 0;
        this._previewBoxHeight = 0;

        // Favorites changed listener
        AppFavorites.getAppFavorites().connectObject('changed', () => {
            if (this._isOpen && this._actionMode === 'drun') {
                this._refreshAppOrdering();
                this._renderPinnedBar();
            }
        }, this.actor);
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
        this._appFavorites = null;
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

        const appFavorites = AppFavorites.getAppFavorites();
        const favoriteIdSet = new Set(appFavorites.getFavorites().map(a => a.get_id()));

        const items = apps.map(a => {
            let shellApp = null;

            try {
                if (appSystem && typeof appSystem.lookup_app === 'function')
                    shellApp = appSystem.lookup_app(a.get_id());
            } catch (e) {
                journal(`Could not get Shell.App for ${a.get_id()}: ${e.message}`, true);
            }

            return {
                label: a.get_name(),
                icon: a.get_icon(),
                data: a,
                shellApp: shellApp,
                id: a.get_id(),
                pinned: favoriteIdSet.has(a.get_id()),
            };
        });

        this._actionMode = 'drun';
        this._appFavorites = appFavorites;
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
        this._appFavorites = null;
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
        this._appFavorites = null;
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

        // Determine if we show preview (window mode + not fullscreen)
        this._showPreview = (this._actionMode === 'window' && !fullscreen);

        // Show/hide preview box
        this._previewBox.visible = this._showPreview;

        // Set hints
        if (hint) {
            this.entry.set_hint_text(hint);
        } else if (this._actionMode === 'drun') {
            this.entry.set_hint_text('Type to filter · Enter: launch · Ctrl+P: pin/unpin · Super/Esc: cancel');
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

        this._renderPinnedBar();

        const monitor = Main.layoutManager.primaryMonitor;

        // --- Layout sizing ---
        let leftWidth, previewWidth, totalWidth, totalHeight;

        if (this._showPreview) {
            // Large layout: 25% menu / 75% preview, but NOT fullscreen – use 90% width and 80% height, centered
            const WIDTH_FRAC = 0.9;
            const HEIGHT_FRAC = 0.8;
            totalWidth = Math.min(Math.floor(monitor.width * WIDTH_FRAC), monitor.width - 40);
            totalHeight = Math.min(Math.floor(monitor.height * HEIGHT_FRAC), monitor.height - 40);

            leftWidth = Math.max(300, Math.floor(totalWidth * 0.25));
            previewWidth = totalWidth - leftWidth - 10; // 10px spacing
            if (previewWidth < 400) {
                leftWidth = Math.max(200, totalWidth - 400 - 10);
                previewWidth = totalWidth - leftWidth - 10;
            }
            this._leftBox.set_width(leftWidth);
            this._previewBoxWidth = previewWidth;
            this._previewBoxHeight = totalHeight;
            this.actor.set_width(totalWidth);
            this.actor.set_height(totalHeight);
            this.actor.set_position(
                monitor.x + Math.floor((monitor.width - totalWidth) / 2),
                monitor.y + Math.floor((monitor.height - totalHeight) / 2)
            );
        } else {
            // Original centered layout (as in the initial code) for other modes
            const MAX_WIDTH = Math.min(1000, monitor.width - 100);
            const MAX_HEIGHT = Math.min(600, monitor.height - 150);
            totalWidth = MAX_WIDTH;
            totalHeight = MAX_HEIGHT;
            leftWidth = totalWidth; // preview not shown, left box takes all width
            this._leftBox.set_width(leftWidth);
            this.actor.set_width(totalWidth);
            this.actor.set_height(totalHeight);
            this.actor.set_position(
                monitor.x + Math.floor((monitor.width - totalWidth) / 2),
                monitor.y + Math.floor(monitor.height / 6)
            );
        }

        // Fullscreen overrides everything
        if (fullscreen) {
            this.actor.set_width(monitor.width);
            this.actor.set_height(monitor.height);
            this.actor.set_position(monitor.x, monitor.y);
            this._previewBox.visible = false; // no preview in fullscreen
            this._leftBox.set_width(monitor.width);
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

        this._closeOpenMenu();
        this._clearPreview();

        if (!this._isOpen)
            return;

        this.pinned_bar.hide();
        this.pinned_bar.remove_all_children();

        Main.layoutManager.removeChrome(this.actor);
        this._isOpen = false;
        this._filterTokens = [];
        this._rowActors = [];
    }

    _scrollSelectedIntoView() {
        if (this._rowActors.length === 0)
            return;

        const selectedRow = this._rowActors[this._selectedIndex];
        if (!selectedRow)
            return;

        const SCROLL_TIME = 0.15;

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

            let offset = 0;
            const vfade = scrollView.get_effect('fade');
            if (vfade && vfade.fade_margins)
                offset = vfade.fade_margins.top || 0;

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
                newValue = y1 - offset;
            } else if (y2 > currentValue + pageSize - offset) {
                newValue = y2 + offset - pageSize;
            } else {
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
            this._closeOpenMenu();
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
                this._closeOpenMenu();
                this._selectedIndex = Math.min(this._visibleItems.length - 1, this._selectedIndex + 1);
                this._render();
            }
            return Clutter.EVENT_STOP;
        }

        if (sym === Clutter.KEY_Up) {
            if (this._visibleItems.length > 0) {
                this._closeOpenMenu();
                this._selectedIndex = Math.max(0, this._selectedIndex - 1);
                this._render();
            }
            return Clutter.EVENT_STOP;
        }

        if (this._actionMode === 'drun' && sym === Clutter.KEY_p &&
            (mods & Clutter.ModifierType.CONTROL_MASK)) {
            this._togglePinCurrent();
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

    _togglePinCurrent() {
        if (this._actionMode !== 'drun')
            return;

        if (this._visibleItems.length === 0 || this._selectedIndex >= this._visibleItems.length)
            return;

        const item = this._visibleItems[this._selectedIndex];
        const favorites = AppFavorites.getAppFavorites();

        if (favorites.isFavorite(item.id))
            favorites.removeFavorite(item.id);
        else
            favorites.addFavorite(item.id);
    }

    _refreshAppOrdering() {
        if (this._actionMode !== 'drun' || !this._appFavorites)
            return;

        const keepId = this._visibleItems[this._selectedIndex]
            ? this._visibleItems[this._selectedIndex].id
            : null;

        const favoriteIdSet = new Set(this._appFavorites.getFavorites().map(a => a.get_id()));

        for (const item of this._allItems)
            item.pinned = favoriteIdSet.has(item.id);

        this._updateResults();

        if (keepId) {
            const idx = this._visibleItems.findIndex(i => i.id === keepId);
            this._selectedIndex = idx !== -1 ? idx : 0;
        }

        this._render();
    }

    _renderPinnedBar() {
        this.pinned_bar.remove_all_children();

        if (this._actionMode !== 'drun' || !this._appFavorites) {
            this.pinned_bar.hide();
            return;
        }

        const favorites = this._appFavorites.getFavorites();
        if (favorites.length === 0) {
            this.pinned_bar.hide();
            return;
        }

        this.pinned_bar.show();

        for (const app of favorites) {
            const button = new St.Button({
                style_class: 'dmenu-pinned-icon',
                child: new St.Icon({ gicon: app.get_icon(), icon_size: 48 }),
                reactive: true,
                can_focus: true,
                track_hover: true,
            });

            button.connect('clicked', () => this._launchPinnedApp(app));

            button.connect('button-press-event', (actor, event) => {
                if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                    this._closeOpenMenu();
                    const menu = this._createAppMenu(button, app);
                    this._openMenu = menu;
                    menu.open(true);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this.pinned_bar.add_child(button);
        }
    }

    _launchPinnedApp(app) {
        try {
            app.launch([], null);
        } catch (e) {
            journal(`Failed to launch ${app.get_name()}: ${e.message}`, true);
        }

        this._service.emitSelected([app.get_name()]);
        this.hide();
    }

    _closeOpenMenu() {
        if (this._openMenu) {
            this._openMenu.close();
            this._openMenu = null;
        }
    }

    _createAppMenu(sourceActor, app) {
        const menu = new AppMenu(sourceActor, St.Side.BOTTOM, {
            favoritesSection: true,
            showSingleWindows: true,
        });

        menu.actor.add_style_class_name('dmenu-context-menu');

        Main.layoutManager.addChrome(menu.actor);
        menu.actor.hide();
        this._menuManager.addMenu(menu);

        menu.setApp(app);

        menu.connect('open-state-changed', (o, isOpen) => {
            if (!isOpen) {
                if (menu === this._openMenu)
                    this._openMenu = null;
                menu.destroy();
            }
        });

        return menu;
    }

    // ---------- Preview handling ----------

    _clearPreview() {
        if (this._previewWindow && this._previewUnmanagedId) {
            this._previewWindow.disconnect(this._previewUnmanagedId);
            this._previewUnmanagedId = 0;
        }

        if (this._previewOverlay) {
            this._previewOverlay.destroy();
            this._previewOverlay = null;
            this._previewClone = null;
            this._previewTitle = null;
            this._previewCloseButton = null;
        } else if (this._previewClone) {
            this._previewClone.destroy();
            this._previewClone = null;
        }

        this._previewWindow = null;
        this._previewWindowId = 0;
        this._previewBox.remove_all_children();
    }

    _removeClosedWindow(window) {
        if (!window)
            return;

        const windowId = window.get_id();

        // Remove the closed window from the master list.
        this._allItems = this._allItems.filter(item => {
            return item.data !== window && String(item.id) !== String(windowId);
        });

        // Recalculate fuzzy-search results using the updated master list.
        this._updateResults();

        // Keep selection valid.
        if (this._visibleItems.length === 0) {
            this._selectedIndex = 0;
            this._clearPreview();
            return;
        }

        if (this._selectedIndex >= this._visibleItems.length)
            this._selectedIndex = this._visibleItems.length - 1;

        // Render again with the corrected selection.
        this._render();
    }

    _updatePreview() {
        if (!this._showPreview || !this._isOpen || this._visibleItems.length === 0) {
            this._clearPreview();
            return;
        }

        const item = this._visibleItems[this._selectedIndex];

        if (!item || !item.data) {
            this._clearPreview();
            return;
        }

        const window = item.data;

        if (!(window instanceof Meta.Window)) {
            this._clearPreview();
            return;
        }

        // If the window changed, clear old preview
        if (this._previewWindow !== window) {
            this._clearPreview();

            this._previewWindow = window;
            this._previewWindowId = window.get_id();

            this._previewUnmanagedId = window.connect('unmanaged', () => {
                journal(`[WindowPreview] Window closed: ${window.get_title()}`);

                this._clearPreview();

                this._removeClosedWindow(window);
            });
        }

        const actor = window.get_compositor_private();

        if (!actor) {
            this._clearPreview();
            return;
        }

        // Get preview area dimensions BEFORE using them.
        // This avoids:
        // ReferenceError: can't access lexical declaration 'previewWidth'
        const previewWidth = this._previewBoxWidth;
        const previewHeight = this._previewBoxHeight;

        if (previewWidth <= 0 || previewHeight <= 0)
            return;

        // ------------------------------------------------------------
        // Create preview hierarchy
        // ------------------------------------------------------------

        if (!this._previewOverlay) {
            // Overlay covers the entire preview box.
            // Clone, title, and close button are positioned inside it.
            this._previewOverlay = new Clutter.Actor({
                width: previewWidth,
                height: previewHeight,
                reactive: true,
            });

            // Window clone
            this._previewClone = new Clutter.Clone({
                source: actor,
            });

            // --------------------------------------------------------
            // Window title
            // --------------------------------------------------------

            this._previewTitle = new St.Label({
                style_class: 'window-preview-title',
                text: window.get_title() || 'Untitled',
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            // Center the actual text inside the label.
            this._previewTitle.clutter_text.set_x_align(
                Clutter.ActorAlign.CENTER
            );

            this._previewTitle.clutter_text.set_y_align(
                Clutter.ActorAlign.CENTER
            );

            // Allow long titles to wrap to multiple lines.
            this._previewTitle.clutter_text.set_line_wrap(true);

            this._previewTitle.clutter_text.set_line_wrap_mode(
                Pango.WrapMode.WORD_CHAR
            );

            // Do not ellipsize the title.
            this._previewTitle.clutter_text.set_ellipsize(
                Pango.EllipsizeMode.NONE
            );

            // Large + bold + readable.
            this._previewTitle.set_style(
                'font-size: 32px;' +
                'font-weight: bold;' +
                'color: white;' +
                'background-color: rgba(0, 0, 0, 0.55);' +
                'padding: 8px 16px;'
            );

            // --------------------------------------------------------
            // Close button
            // --------------------------------------------------------

            this._previewCloseButton = new St.Button({
                style_class: 'window-close-button',
                child: new St.Icon({
                    icon_name: 'window-close-symbolic',
                    icon_size: 32,
                }),
                reactive: true,
                can_focus: true,
                track_hover: true,
            });

            this._previewCloseButton.connect('clicked', () => {
                try {
                    const currentWindow = this._previewWindow;

                    if (currentWindow)
                        currentWindow.delete(global.get_current_time());
                } catch (e) {
                    journal(
                        `Failed to close preview window: ${e.message}`,
                        true
                    );
                }

                return Clutter.EVENT_STOP;
            });

            // --------------------------------------------------------
            // Build hierarchy
            // --------------------------------------------------------

            this._previewOverlay.add_child(this._previewClone);
            this._previewOverlay.add_child(this._previewTitle);
            this._previewOverlay.add_child(this._previewCloseButton);

            this._previewBox.add_child(this._previewOverlay);
        } else {
            // Existing preview — update source and title.
            this._previewClone.source = actor;

            this._previewTitle.text = window.get_title() || 'Untitled';
        }

        // Keep overlay synced to current preview size.
        this._previewOverlay.set_size(
            previewWidth,
            previewHeight
        );

        // ------------------------------------------------------------
        // Determine source dimensions
        // ------------------------------------------------------------

        let srcWidth = actor.width || 0;
        let srcHeight = actor.height || 0;

        if (srcWidth === 0 || srcHeight === 0) {
            const rect = window.get_frame_rect();

            srcWidth = rect.width;
            srcHeight = rect.height;
        }

        if (srcWidth === 0 || srcHeight === 0) {
            srcWidth = 100;
            srcHeight = 100;
        }

        // ------------------------------------------------------------
        // Scale window to fit preview area
        // ------------------------------------------------------------

        const scaleX = previewWidth / srcWidth;
        const scaleY = previewHeight / srcHeight;

        const scale = Math.min(
            scaleX,
            scaleY,
            1.0
        );

        const targetWidth = srcWidth * scale;
        const targetHeight = srcHeight * scale;

        // ------------------------------------------------------------
        // Position clone
        // ------------------------------------------------------------

        const cloneX = (previewWidth - targetWidth) / 2;
        const cloneY = (previewHeight - targetHeight) / 2;

        this._previewClone.set_size(
            targetWidth,
            targetHeight
        );

        this._previewClone.set_position(
            cloneX,
            cloneY
        );

        // ------------------------------------------------------------
        // Position title
        // ------------------------------------------------------------

        // Keep title centered over the actual cloned window,
        // not the entire preview box.
        //
        // The title gets enough height for multiple wrapped lines.
        const titleHeight = Math.min(
            140,
            Math.max(60, targetHeight * 0.25)
        );

        this._previewTitle.set_size(
            targetWidth,
            titleHeight
        );

        this._previewTitle.set_position(
            cloneX,
            cloneY + (targetHeight / 2) - (titleHeight / 2)
        );

        // ------------------------------------------------------------
        // Position close button
        // ------------------------------------------------------------

        const closeButtonSize = 48;
        const closeMargin = 10;

        this._previewCloseButton.set_size(
            closeButtonSize,
            closeButtonSize
        );

        this._previewCloseButton.set_position(
            cloneX + targetWidth - closeButtonSize - closeMargin,
            cloneY + closeMargin
        );
    }

    // ---------- Activation ----------

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

            const pinMarker = new St.Label({
                text: (this._actionMode === 'drun' && item.pinned) ? '📌' : '',
                style_class: 'dmenu-pin-marker',
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
            row.add_child(pinMarker);

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

            row.connect('button-press-event', (actor, event) => {
                const button = event.get_button();

                if (button === Clutter.BUTTON_SECONDARY) {
                    if (this._actionMode !== 'drun')
                        return Clutter.EVENT_PROPAGATE;

                    const app = item.shellApp;

                    if (!app) {
                        journal(`No Shell.App available for ${item.label}`, true);
                        return Clutter.EVENT_STOP;
                    }

                    this._closeOpenMenu();

                    const menu = this._createAppMenu(row, app);
                    this._openMenu = menu;
                    menu.open(true);

                    return Clutter.EVENT_STOP;
                }

                if (button === Clutter.BUTTON_PRIMARY) {
                    label.remove_style_class_name('dmenu-result-hover');
                    label.add_style_class_name('dmenu-result-clicked');
                    this._selectedIndex = rowIndex;

                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                        this._activate();
                        return GLib.SOURCE_REMOVE;
                    });

                    return Clutter.EVENT_STOP;
                }

                return Clutter.EVENT_PROPAGATE;
            });

            this.results_box.add_child(row);
            this._rowActors.push(row);
        }

        this._scrollSelectedIntoView();

        // Update preview after rendering
        if (this._showPreview) {
            this._updatePreview();
        }
    }
};

export default class SimpleDmenuExtension extends Extension {
    _writeSpecCache() {
        try {
            GLib.mkdir_with_parents(SPEC_CACHE_DIR, 0o755);
            const spec = {
                bus_name: BUS_NAME,
                object_path: OBJECT_PATH,
                xml: DBUS_INTERFACE,
            };
            const filePath = GLib.build_filenamev([SPEC_CACHE_DIR, SPEC_CACHE_FILE]);
            GLib.file_set_contents(filePath, JSON.stringify(spec, null, 2));
            journal(`Wrote spec cache to ${filePath}`);
        } catch (e) {
            journal(`Failed to write spec cache: ${e.message}`, true);
        }
    }

    _removeSpecCache() {
        try {
            const filePath = GLib.build_filenamev([SPEC_CACHE_DIR, SPEC_CACHE_FILE]);
            const file = Gio.File.new_for_path(filePath);
            if (file.query_exists(null)) {
                file.delete(null);
                journal(`Removed spec cache`);
            }
        } catch (e) {
            journal(`Failed to remove spec cache: ${e.message}`, true);
        }
    }

    _installCli() {
        const cliScript = GLib.build_filenamev([this.path, 'cli', 'gdmenu']);
        const binDir = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin']);
        const symlinkPath = GLib.build_filenamev([binDir, 'gdmenu']);

        try {
            GLib.chmod(cliScript, 0o755);
            GLib.mkdir_with_parents(binDir, 0o755);

            const linkFile = Gio.File.new_for_path(symlinkPath);

            if (linkFile.query_exists(null)) {
                const info = linkFile.query_info(
                    Gio.FILE_ATTRIBUTE_STANDARD_SYMLINK_TARGET,
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                    null
                );
                if (info.get_symlink_target() !== cliScript) {
                    linkFile.delete(null);
                    linkFile.make_symbolic_link(cliScript, null);
                    journal(`Updated CLI symlink: ${symlinkPath}`);
                }
            } else {
                linkFile.make_symbolic_link(cliScript, null);
                journal(`Created CLI symlink: ${symlinkPath}`);
            }
        } catch (e) {
            journal(`Failed to setup CLI symlink: ${e.message}`, true);
        }
    }

    _removeCliSymlink() {
        const cliScript = GLib.build_filenamev([this.path, 'cli', 'gdmenu']);
        const symlinkPath = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'gdmenu']);

        try {
            const linkFile = Gio.File.new_for_path(symlinkPath);
            if (linkFile.query_exists(null)) {
                const info = linkFile.query_info(
                    Gio.FILE_ATTRIBUTE_STANDARD_SYMLINK_TARGET,
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                    null
                );
                if (info.get_symlink_target() === cliScript) {
                    linkFile.delete(null);
                    journal(`Removed CLI symlink`);
                }
            }
        } catch (e) {
            journal(`Failed to remove CLI symlink: ${e.message}`, true);
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

        this._installCli();
        this._writeSpecCache();
    }

    disable() {
        this._ui?.hide();
        this._ui = null;

        this._service?.unexport();
        this._service = null;

        this._removeCliSymlink();
        this._removeSpecCache();
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