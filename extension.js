import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';

import { initLogging, createLogger } from './logger.js';

const journal = createLogger(import.meta.url);

// ============================================================
// CONSTANTS
// ============================================================

const SPEC_CACHE_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.cache', 'gnome-dbus-spec']);
const SPEC_CACHE_FILE = 'simple-dmenu.json';

const BUS_NAME = 'io.github.blueray453.SimpleDmenu';
const OBJECT_PATH = '/io/github/blueray453/SimpleDmenu';

const FILTER_DEBOUNCE_MS = 150;
const SCROLL_TIME = 0.15;

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

const LAYOUT = {
    CONTAINER_PADDING: 32,
    MULTI_MARKER_WIDTH: 44,
    PIN_MARKER_WIDTH: 40,
    RESULT_ICON_SIZE: 48,
    PINNED_ICON_SIZE: 48,
    PREVIEW_BOX_MARGIN: 4,
    CLOSE_BUTTON_SIZE: 48,
    CLOSE_BUTTON_MARGIN: 10,
    CLOSE_BUTTON_ICON_SIZE: 32,
    TITLE_HEIGHT_MIN: 60,
    TITLE_HEIGHT_MAX: 140,
    TITLE_HEIGHT_FRACTION: 0.25,
    CENTERED_WIDTH_FRAC: 0.9,
    CENTERED_HEIGHT_FRAC: 0.8,
    LEFT_RAIL_FRAC: 0.25,
    LEFT_RAIL_MIN_WIDTH: 300,
    PREVIEW_MIN_WIDTH: 400,
    LEFT_RAIL_FALLBACK_WIDTH: 200,
    RAIL_GAP: 10,
    STDIN_MAX_WIDTH: 1000,
    STDIN_MAX_HEIGHT: 600,
    STDIN_MARGIN: 100,
    STDIN_VERTICAL_MARGIN: 150,
};

// ============================================================
// MODULE STATE
//
// Everything the extension tracks at runtime lives here. The logic below is
// plain functions reading and writing this object, so there is exactly one
// place to look for "what state does this extension keep".
//
// Objects that own a widget tree or a per-instance signal lifecycle
// (DmenuView, WindowPreview) remain classes and are stored here as
// references. The controller logic that orchestrates them is module-level.
// ============================================================

const state = {
    // Extension context
    extensionPath: null,

    // Data
    search: { allItems: [], visibleItems: [], tokens: [] },
    selection: { index: 0, selectedIds: new Set() },

    // Widgets and controllers (classes)
    view: null,
    preview: null,
    appMenu: { menuManager: null, openMenu: null },

    // Modes — dispatcher is a switch on modeName, so only the name is kept.
    modeName: 'stdin',

    // Flags
    isOpen: false,
    multi: false,
    fullscreen: false,
    showPreview: false,
    previewWidth: 0,
    previewHeight: 0,

    // Timers
    filterTimeoutId: 0,

    // Favorites (cached at controller setup so signals can be disconnected)
    favorites: null,
    favoritesChangedId: 0,

    // D-Bus
    dbusImpl: null,
    ownerId: 0,
};

function resetState() {
    state.extensionPath = null;
    state.search = { allItems: [], visibleItems: [], tokens: [] };
    state.selection = { index: 0, selectedIds: new Set() };
    state.view = null;
    state.preview = null;
    state.appMenu = { menuManager: null, openMenu: null };
    state.modeName = 'stdin';
    state.isOpen = false;
    state.multi = false;
    state.fullscreen = false;
    state.showPreview = false;
    state.previewWidth = 0;
    state.previewHeight = 0;
    state.filterTimeoutId = 0;
    state.favorites = null;
    state.favoritesChangedId = 0;
    state.dbusImpl = null;
    state.ownerId = 0;
}

// ============================================================
// HELPERS
// ============================================================

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
            intervals.push({ start: idx, end: idx + lowerToken.length });
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

// ============================================================
// DATA MODEL
// ============================================================

function makeMenuItem({
    id,
    label,
    icon = null,
    data = null,
    shellApp = null,
    pinned = false,
}) {
    return { id, label, icon, data, shellApp, pinned };
}

// ============================================================
// SEARCH MODEL
// ============================================================

function searchSetItems(items) {
    state.search.allItems = [...items];
    state.search.visibleItems = [...items];
}

function searchSetQuery(query) {
    const filter = (query || '').trim().toLowerCase();
    state.search.tokens = filter.split(/\s+/).filter(Boolean);

    if (state.search.tokens.length === 0) {
        state.search.visibleItems = [...state.search.allItems];
        return state.search.visibleItems;
    }

    state.search.visibleItems = state.search.allItems.filter(item => {
        const lower = item.label.toLowerCase();
        return state.search.tokens.every(token => lower.includes(token));
    });

    return state.search.visibleItems;
}

function searchRemoveItemByData(data) {
    const before = state.search.allItems.length;
    state.search.allItems = state.search.allItems.filter(item => item.data !== data);
    return before !== state.search.allItems.length;
}

function searchRemoveItemById(id) {
    const normalized = String(id);
    const before = state.search.allItems.length;
    state.search.allItems = state.search.allItems.filter(item => String(item.id) !== normalized);
    return before !== state.search.allItems.length;
}

function searchUpdateItem(id, updater) {
    const item = state.search.allItems.find(item => String(item.id) === String(id));
    if (!item) return false;
    updater(item);
    return true;
}

// ============================================================
// SELECTION MODEL
// ============================================================

function selectionReset() {
    state.selection.index = 0;
    state.selection.selectedIds.clear();
}

function selectionClamp(count) {
    if (count <= 0) { state.selection.index = 0; return; }
    state.selection.index = Math.max(0, Math.min(state.selection.index, count - 1));
}

function selectionMoveUp(count) {
    if (count <= 0) return;
    state.selection.index = Math.max(0, state.selection.index - 1);
}

function selectionMoveDown(count) {
    if (count <= 0) return;
    state.selection.index = Math.min(count - 1, state.selection.index + 1);
}

function selectionNext(count) {
    if (count <= 0) return;
    state.selection.index = Math.min(count - 1, state.selection.index + 1);
}

function selectionToggle(item) {
    if (!item) return;
    if (state.selection.selectedIds.has(item.id))
        state.selection.selectedIds.delete(item.id);
    else
        state.selection.selectedIds.add(item.id);
}

function selectionClear() {
    state.selection.selectedIds.clear();
}

function selectionGetSelectedItems(items) {
    if (state.selection.selectedIds.size === 0) return [];
    return items.filter(item => state.selection.selectedIds.has(item.id));
}

// ============================================================
// APP MENU CONTROLLER
// ============================================================

function appMenuInit(sourceActor) {
    state.appMenu.menuManager = new PopupMenu.PopupMenuManager(sourceActor);
}

function appMenuOpenForApp(sourceActor, app) {
    appMenuClose();

    const menu = new AppMenu(sourceActor, St.Side.BOTTOM, {
        favoritesSection: true,
        showSingleWindows: true,
    });

    menu.actor.add_style_class_name('dmenu-context-menu');

    Main.layoutManager.addChrome(menu.actor);
    menu.actor.hide();
    state.appMenu.menuManager.addMenu(menu);

    menu.setApp(app);
    state.appMenu.openMenu = menu;

    menu.connect('open-state-changed', (o, isOpen) => {
        if (!isOpen) {
            if (menu === state.appMenu.openMenu)
                state.appMenu.openMenu = null;
            menu.destroy();
        }
    });

    menu.open(true);
    return menu;
}

function appMenuClose() {
    if (!state.appMenu.openMenu) return;
    const menu = state.appMenu.openMenu;
    state.appMenu.openMenu = null;
    try {
        menu.close();
    } catch (e) {
        journal(`Failed to close app menu: ${e.message}`, true);
    }
}

// ============================================================
// SHARED CLONE-PREVIEW BUILDER
// ============================================================

function createClonePreviewActor(window, targetHeight, options = {}) {
    if (!window)
        return null;

    const windowActor = window.get_compositor_private();
    if (!windowActor)
        return null;

    const windowFrame = window.get_frame_rect();
    const bufferFrame = window.get_buffer_rect();
    if (windowFrame.height === 0)
        return null;

    const targetWidth = targetHeight * (windowFrame.width / windowFrame.height);
    const scale = targetHeight / windowFrame.height;

    const scaledLeftShadow = (windowFrame.x - bufferFrame.x) * scale;
    const scaledTopShadow = (windowFrame.y - bufferFrame.y) * scale;
    const scaledRightShadow = ((bufferFrame.x + bufferFrame.width) - (windowFrame.x + windowFrame.width)) * scale;
    const scaledBottomShadow = ((bufferFrame.y + bufferFrame.height) - (windowFrame.y + windowFrame.height)) * scale;

    const container = new Clutter.Actor({
        width: targetWidth,
        height: targetHeight,
        clip_to_allocation: true,
    });

    const clone = new Clutter.Clone({
        source: windowActor,
        width: targetWidth + scaledLeftShadow + scaledRightShadow,
        height: targetHeight + scaledTopShadow + scaledBottomShadow,
    });
    clone.set_position(-scaledLeftShadow, -scaledTopShadow);

    const cloneContainer = new Clutter.Actor();
    cloneContainer.add_child(clone);
    container.add_child(cloneContainer);

    if (options.onClose) {
        const closeIconSize = options.closeButtonSize ?? LAYOUT.CLOSE_BUTTON_ICON_SIZE;
        const closeButtonSize = LAYOUT.CLOSE_BUTTON_SIZE;
        const closeOffsetX = options.closeButtonOffsetX ?? (closeButtonSize + LAYOUT.CLOSE_BUTTON_MARGIN);
        const closeOffsetY = options.closeButtonOffsetY ?? LAYOUT.CLOSE_BUTTON_MARGIN;

        const closeButton = new St.Button({
            style_class: 'window-close-button',
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_size: closeIconSize,
            }),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            reactive: true,
        });

        closeButton.set_size(LAYOUT.CLOSE_BUTTON_SIZE, LAYOUT.CLOSE_BUTTON_SIZE);
        closeButton.set_position(targetWidth - closeOffsetX, closeOffsetY);
        closeButton.connect('clicked', () => {
            options.onClose(window);
            return Clutter.EVENT_STOP;
        });

        cloneContainer.add_child(closeButton);
    }

    return { actor: container, width: targetWidth, height: targetHeight };
}

// ============================================================
// WINDOW PREVIEW (class — owns a Clutter actor subtree and a
// per-window 'unmanaged' signal that needs explicit teardown)
// ============================================================

class WindowPreview {
    constructor(container, onWindowClosed = null) {
        this._container = container;
        this._onWindowClosed = onWindowClosed;
        this._window = null;
        this._unmanagedId = 0;
        this._wrapper = null;
        this._clone = null;
        this._title = null;
    }

    show(window, width, height) {
        if (!(window instanceof Meta.Window) || width <= 0 || height <= 0) {
            this.hide();
            return;
        }

        if (this._window !== window) {
            this._disconnectWindowLifecycle();
            this._window = window;
            this._connectWindowLifecycle(window);
        }

        this._clearClone();

        const windowFrame = window.get_frame_rect();
        if (windowFrame.height === 0) {
            this.hide();
            return;
        }

        const aspect = windowFrame.width / windowFrame.height;
        let targetHeight = height;
        let targetWidth = targetHeight * aspect;
        if (targetWidth > width) {
            targetWidth = width;
            targetHeight = targetWidth / aspect;
        }

        const built = createClonePreviewActor(window, targetHeight, {
            onClose: win => this._requestClose(win),
            closeButtonSize: LAYOUT.CLOSE_BUTTON_ICON_SIZE,
            closeButtonOffsetX: LAYOUT.CLOSE_BUTTON_SIZE + LAYOUT.CLOSE_BUTTON_MARGIN,
            closeButtonOffsetY: LAYOUT.CLOSE_BUTTON_MARGIN,
        });

        if (!built) { this.hide(); return; }

        this._wrapper = new Clutter.Actor({ width, height });
        this._container.add_child(this._wrapper);

        const cloneX = Math.max(0, (width - built.width) / 2);
        const cloneY = Math.max(0, (height - built.height) / 2);

        built.actor.set_position(cloneX, cloneY);
        this._clone = built.actor;
        this._wrapper.add_child(this._clone);

        this._title = this._buildTitle(window, built.width, built.height);
        const titleHeight = this._title.height;
        this._title.set_position(cloneX, cloneY + (built.height - titleHeight) / 2);
        this._wrapper.add_child(this._title);
    }

    hide() {
        this._disconnectWindowLifecycle();
        this._window = null;
        this._clearClone();
        this._container.remove_all_children();
    }

    destroy() {
        this.hide();
    }

    _clearClone() {
        if (this._wrapper) {
            if (this._wrapper.get_parent() === this._container)
                this._container.remove_child(this._wrapper);
            this._wrapper.destroy();
            this._wrapper = null;
        }
        this._clone = null;
        this._title = null;
    }

    _connectWindowLifecycle(window) {
        this._unmanagedId = window.connect('unmanaged', () => {
            this._unmanagedId = 0;
            const closedWindow = this._window;
            this._window = null;
            this._clearClone();
            this._container.remove_all_children();
            if (this._onWindowClosed)
                this._onWindowClosed(closedWindow);
        });
    }

    _disconnectWindowLifecycle() {
        if (!this._window || !this._unmanagedId) return;
        try {
            this._window.disconnect(this._unmanagedId);
        } catch (e) {
            journal(`Failed to disconnect window preview signal: ${e.message}`, true);
        }
        this._unmanagedId = 0;
    }

    _requestClose(window) {
        try {
            window.delete(global.get_current_time());
        } catch (e) {
            journal(`Failed to close preview window: ${e.message}`, true);
        }
    }

    _buildTitle(window, cloneWidth, cloneHeight) {
        const titleText = window.get_title();

        const title = new St.Label({
            style_class: 'window-preview-title',
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            text: titleText && titleText.trim() ? titleText : 'Untitled',
        });

        title.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        title.clutter_text.set_y_align(Clutter.ActorAlign.CENTER);
        title.clutter_text.set_line_wrap(true);
        title.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        title.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);

        const titleHeight = Math.min(
            LAYOUT.TITLE_HEIGHT_MAX,
            Math.max(LAYOUT.TITLE_HEIGHT_MIN, cloneHeight * LAYOUT.TITLE_HEIGHT_FRACTION)
        );
        title.set_size(cloneWidth, titleHeight);

        return title;
    }
}

// ============================================================
// MODES
// ============================================================

function windowModeGetCapabilities() {
    return { multi: false, hint: true, fullscreen: true, preview: true };
}

function windowModeGetItems() {
    const windows = global.display.get_tab_list(Meta.TabList.NORMAL, null);

    let tracker;
    if (typeof Shell.WindowTracker.get_default === 'function')
        tracker = Shell.WindowTracker.get_default();
    else
        tracker = Main.windowTracker;

    return windows.map(window => {
        let title = window.get_title();
        if (!title || title.trim() === '')
            title = 'Untitled';

        const app = tracker ? tracker.get_window_app(window) : null;
        const icon = app ? app.get_icon() : Gio.ThemedIcon.new('application-x-executable');

        return makeMenuItem({
            label: title,
            icon,
            data: window,
            id: String(window.get_id()),
        });
    });
}

function windowModeActivate(item) {
    const window = item?.data;
    if (!window) return;

    const timestamp = global.get_current_time();
    try {
        const workspace = window.get_workspace();
        if (workspace)
            workspace.activate_with_focus(window, timestamp);
        else
            window.activate(timestamp);
    } catch (e) {
        journal(`Failed to activate window ${item.label}: ${e.message}`, true);
    }
}

function windowModeHandleClosedWindow(window) {
    if (!window) return;
    journal(`[WindowMode] Window closed: ${window.get_title() || 'Untitled'}`);
    removeItemByData(window);
}

// ---- drun ----

function drunModeGetCapabilities() {
    return { multi: false, hint: true, fullscreen: true, preview: false };
}

function drunModeGetItems() {
    const appSystem = Shell.AppSystem.get_default();
    let apps = [];

    if (appSystem && typeof appSystem.get_all === 'function')
        apps = appSystem.get_all().filter(app => app.should_show());
    else
        apps = Gio.AppInfo.get_all().filter(app => app.should_show());

    apps.sort((a, b) => a.get_name().localeCompare(b.get_name()));

    const favoriteIds = new Set(state.favorites.getFavorites().map(app => app.get_id()));

    return apps.map(app => {
        let shellApp = null;
        try {
            if (appSystem && typeof appSystem.lookup_app === 'function')
                shellApp = appSystem.lookup_app(app.get_id());
        } catch (e) { /* ignore */ }

        return makeMenuItem({
            label: app.get_name(),
            icon: app.get_icon(),
            data: app,
            shellApp,
            id: app.get_id(),
            pinned: favoriteIds.has(app.get_id()),
        });
    });
}

function drunModeLaunchApp(app) {
    try {
        const isShellApp = typeof app.get_id === 'function' && typeof app.get_name === 'function';
        if (isShellApp)
            app.launch(global.get_current_time(), -1, 0);
        else
            app.launch([], null);
        return true;
    } catch (e) {
        try {
            if (typeof app.get_id === 'function' && typeof app.get_name === 'function')
                app.launch([], null);
            else
                app.launch(global.get_current_time(), -1, 0);
            return true;
        } catch (e2) {
            journal(`Launch failed: ${e2.message}`, true);
            return false;
        }
    }
}

function drunModeActivate(item) {
    const app = item?.data;
    if (!app) return;
    drunModeLaunchApp(app);
}

function drunModeTogglePin(item) {
    if (!item) return;
    if (state.favorites.isFavorite(item.id))
        state.favorites.removeFavorite(item.id);
    else
        state.favorites.addFavorite(item.id);
}

function drunModeGetFavorites() {
    return state.favorites.getFavorites();
}

// ---- paths ----

function pathModeGetCapabilities() {
    return { multi: true, hint: true, fullscreen: true, preview: false };
}

function pathModeGetItems(paths) {
    return paths.map(path => {
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

        return makeMenuItem({
            label: path,
            icon,
            data: path,
            id: path,
        });
    });
}

function pathModeActivate(item) {
    return item?.data ?? null;
}

// ---- generic / stdin ----

function genericModeGetCapabilities() {
    return { multi: true, hint: true, fullscreen: true, preview: false };
}

function genericModeGetItems(items) {
    const idMap = new Map();

    return items.map((item, index) => {
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

        return makeMenuItem({
            label,
            icon: item.icon || null,
            data: item.data || null,
            id,
        });
    });
}

function genericModeActivate(item) {
    return item?.label ?? null;
}

// ---- mode dispatcher ----

function getModeCapabilities(modeName) {
    switch (modeName) {
        case 'window': return windowModeGetCapabilities();
        case 'drun': return drunModeGetCapabilities();
        case 'paths': return pathModeGetCapabilities();
        case 'stdin':
        default: return genericModeGetCapabilities();
    }
}

function activateInMode(modeName, item) {
    switch (modeName) {
        case 'window': windowModeActivate(item); return item.label;
        case 'drun': drunModeActivate(item); return item.label;
        case 'paths': return pathModeActivate(item);
        case 'stdin':
        default: return genericModeActivate(item);
    }
}

// ============================================================
// MAIN VIEW (class — owns a widget hierarchy with self-attached
// signal handlers and two pending timeout ids)
// ============================================================

class DmenuView {
    constructor() {
        this.actor = new St.BoxLayout({
            style_class: 'dmenu-container',
            vertical: false,
            reactive: true,
            can_focus: true,
        });
        this.actor.set_style(`padding: ${LAYOUT.CONTAINER_PADDING}px;`);

        this.leftBox = new St.BoxLayout({
            style_class: 'dmenu-left-box',
            vertical: true,
            x_expand: false,
            y_expand: true,
        });

        this.previewBox = new St.BoxLayout({
            style_class: 'dmenu-preview-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this.previewBox.set_style(`margin: ${LAYOUT.PREVIEW_BOX_MARGIN}px;`);

        this.actor.add_child(this.leftBox);
        this.actor.add_child(this.previewBox);

        this.pinnedBar = new St.BoxLayout({
            style_class: 'dmenu-pinned-bar',
            vertical: false,
            x_expand: true,
        });
        this.pinnedBar.hide();

        this.entry = new St.Entry({
            style_class: 'dmenu-entry',
            hint_text: 'Type to filter · Enter: select · Tab: multi-select · Esc: cancel',
            can_focus: true,
            x_expand: true,
        });

        this.resultsContainer = new St.ScrollView({
            style_class: 'dmenu-results-container',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
            reactive: true,
        });

        this.resultsBox = new St.BoxLayout({
            style_class: 'dmenu-results-box',
            vertical: true,
            reactive: true,
        });

        this.resultsContainer.set_child(this.resultsBox);

        this.leftBox.add_child(this.pinnedBar);
        this.leftBox.add_child(this.entry);
        this.leftBox.add_child(this.resultsContainer);

        this._rowActors = [];
        this._scrollIdleId = null;

        this.entry.get_clutter_text().connect('text-changed', () => scheduleSearchUpdate());
        this.entry.get_clutter_text().connect('activate', () => activate());

        this.actor.connect('key-press-event', (actor, event) => handleKeyPress(actor, event));
        this.actor.connect('button-press-event', () => {
            this.entry.grab_key_focus();
            return Clutter.EVENT_STOP;
        });
    }

    destroy() {
        this.cancelPendingWork();
        this.actor.destroy();
    }

    show() { this.actor.show(); }
    hide() { this.actor.hide(); }

    cancelPendingWork() {
        if (this._scrollIdleId) {
            GLib.source_remove(this._scrollIdleId);
            this._scrollIdleId = null;
        }
    }

    setHint(text) { this.entry.set_hint_text(text); }
    resetInput() { this.entry.set_text(''); }
    getQuery() { return this.entry.get_text(); }

    focusInput(isOpen) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (isOpen) this.entry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    configureLayout(showPreview, fullscreen) {
        const monitor = Main.layoutManager.primaryMonitor;
        const pad2 = LAYOUT.CONTAINER_PADDING * 2;

        let totalWidth, totalHeight, leftWidth, previewWidth = 0;

        const computeRail = usableWidth => {
            let lw = Math.max(LAYOUT.LEFT_RAIL_MIN_WIDTH, Math.floor(usableWidth * LAYOUT.LEFT_RAIL_FRAC));
            let pw = usableWidth - lw - LAYOUT.RAIL_GAP;
            if (pw < LAYOUT.PREVIEW_MIN_WIDTH) {
                lw = Math.max(LAYOUT.LEFT_RAIL_FALLBACK_WIDTH, usableWidth - LAYOUT.PREVIEW_MIN_WIDTH - LAYOUT.RAIL_GAP);
                pw = usableWidth - lw - LAYOUT.RAIL_GAP;
            }
            return [lw, pw];
        };

        if (showPreview) {
            if (fullscreen) {
                totalWidth = monitor.width;
                totalHeight = monitor.height;
                [leftWidth, previewWidth] = computeRail(totalWidth - pad2);
                this.leftBox.set_width(leftWidth);
                this.previewBox.visible = true;
                this.actor.set_width(totalWidth);
                this.actor.set_height(totalHeight);
                this.actor.set_position(monitor.x, monitor.y);
                return { previewWidth, previewHeight: totalHeight };
            }

            totalWidth = Math.min(Math.floor(monitor.width * LAYOUT.CENTERED_WIDTH_FRAC), monitor.width - 40);
            totalHeight = Math.min(Math.floor(monitor.height * LAYOUT.CENTERED_HEIGHT_FRAC), monitor.height - 40);
            [leftWidth, previewWidth] = computeRail(totalWidth);
            this.leftBox.set_width(leftWidth);
            this.previewBox.visible = true;
            this.actor.set_width(totalWidth);
            this.actor.set_height(totalHeight);
            this.actor.set_position(
                monitor.x + Math.floor((monitor.width - totalWidth) / 2),
                monitor.y + Math.floor((monitor.height - totalHeight) / 2)
            );
            return { previewWidth, previewHeight: totalHeight };
        }

        totalWidth = Math.min(LAYOUT.STDIN_MAX_WIDTH, monitor.width - LAYOUT.STDIN_MARGIN);
        totalHeight = Math.min(LAYOUT.STDIN_MAX_HEIGHT, monitor.height - LAYOUT.STDIN_VERTICAL_MARGIN);
        leftWidth = totalWidth - pad2;
        this.leftBox.set_width(leftWidth);
        this.previewBox.visible = false;

        if (fullscreen) {
            this.actor.set_width(monitor.width);
            this.actor.set_height(monitor.height);
            this.actor.set_position(monitor.x, monitor.y);
            this.leftBox.set_width(monitor.width - pad2);
        } else {
            this.actor.set_width(totalWidth);
            this.actor.set_height(totalHeight);
            this.actor.set_position(
                monitor.x + Math.floor((monitor.width - totalWidth) / 2),
                monitor.y + Math.floor(monitor.height / 6)
            );
        }

        return { previewWidth, previewHeight: totalHeight };
    }

    renderResults(items, tokens, selectedIndex, selectedIds, modeName, multi) {
        this.resultsBox.remove_all_children();
        this._rowActors = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            const row = new St.BoxLayout({
                vertical: false,
                style_class: 'dmenu-result-row',
                x_expand: true,
                reactive: true,
                track_hover: true,
            });

            if (multi) {
                const marker = new St.Label({
                    text: selectedIds.has(item.id) ? '●' : '',
                    style_class: 'dmenu-marker',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                marker.set_style(`width: ${LAYOUT.MULTI_MARKER_WIDTH}px; text-align: center;`);
                row.add_child(marker);
            }

            if (modeName === 'drun') {
                const pinMarker = new St.Label({
                    text: item.pinned ? '📌' : '',
                    style_class: 'dmenu-pin-marker',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                pinMarker.set_style(`width: ${LAYOUT.PIN_MARKER_WIDTH}px; text-align: center;`);
                row.add_child(pinMarker);
            }

            let iconActor = null;
            if (item.icon) {
                iconActor = new St.Icon({
                    gicon: item.icon,
                    style_class: 'dmenu-icon',
                    icon_size: LAYOUT.RESULT_ICON_SIZE,
                    y_align: Clutter.ActorAlign.CENTER,
                });
            }

            const label = new St.Label({
                style_class: i === selectedIndex
                    ? 'dmenu-result dmenu-result-selected'
                    : 'dmenu-result',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.set_markup(highlightLabel(item.label, tokens));

            if (iconActor) row.add_child(iconActor);
            row.add_child(label);

            const rowIndex = i;

            row.connect('enter-event', () => {
                label.add_style_class_name('dmenu-result-hover');
                selectIndex(rowIndex);
                return Clutter.EVENT_PROPAGATE;
            });

            row.connect('leave-event', () => {
                label.remove_style_class_name('dmenu-result-hover');
                return Clutter.EVENT_PROPAGATE;
            });

            row.connect('button-press-event', (actor, event) => {
                const button = event.get_button();
                if (button === Clutter.BUTTON_SECONDARY) {
                    openContextMenu(item, row);
                    return Clutter.EVENT_STOP;
                }
                if (button === Clutter.BUTTON_PRIMARY) {
                    label.remove_style_class_name('dmenu-result-hover');
                    label.add_style_class_name('dmenu-result-clicked');
                    selectIndex(rowIndex);
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                        activate();
                        return GLib.SOURCE_REMOVE;
                    });
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this.resultsBox.add_child(row);
            this._rowActors.push(row);
        }

        this.scrollSelectedIntoView(selectedIndex);
    }

    updateSelection(selectedIndex, visibleItems, showPreview) {
        for (let i = 0; i < this._rowActors.length; i++) {
            const row = this._rowActors[i];
            const label = row.get_last_child();
            if (label && label.has_style_class_name)
                label.remove_style_class_name('dmenu-result-selected');
        }

        if (selectedIndex >= 0 && selectedIndex < this._rowActors.length) {
            const row = this._rowActors[selectedIndex];
            const label = row.get_last_child();
            if (label && label.add_style_class_name)
                label.add_style_class_name('dmenu-result-selected');
        }

        if (showPreview && visibleItems.length > 0) {
            const selectedItem = visibleItems[selectedIndex];
            if (selectedItem?.data instanceof Meta.Window) {
                state.preview.show(
                    selectedItem.data,
                    state.previewWidth,
                    state.previewHeight
                );
            } else {
                state.preview.hide();
            }
        } else {
            state.preview.hide();
        }
    }

    renderPinnedApps(apps) {
        this.pinnedBar.remove_all_children();

        if (!apps || apps.length === 0) {
            this.pinnedBar.hide();
            return;
        }

        this.pinnedBar.show();

        for (const app of apps) {
            const button = new St.Button({
                style_class: 'dmenu-pinned-icon',
                child: new St.Icon({
                    gicon: app.get_icon(),
                    icon_size: LAYOUT.PINNED_ICON_SIZE,
                }),
                reactive: true,
                can_focus: true,
                track_hover: true,
            });

            button.connect('clicked', () => activatePinnedApp(app));
            button.connect('button-press-event', (actor, event) => {
                if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                    openContextMenuForApp(app, button);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this.pinnedBar.add_child(button);
        }
    }

    clearPinnedApps() {
        this.pinnedBar.hide();
        this.pinnedBar.remove_all_children();
    }

    scrollSelectedIntoView(index) {
        if (this._rowActors.length === 0) return;
        const selectedRow = this._rowActors[index];
        if (!selectedRow) return;

        const scrollView = this.resultsContainer;

        this._scrollIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._scrollIdleId = null;

            if (!state.isOpen || !this._rowActors.includes(selectedRow))
                return GLib.SOURCE_REMOVE;

            const adjustment = scrollView.vadjustment;
            if (!adjustment) return GLib.SOURCE_REMOVE;

            const lower = adjustment.lower || 0;
            const upper = adjustment.upper || 0;

            let pageSize = adjustment.page_size;
            if (!pageSize) pageSize = scrollView.height;
            if (!pageSize) return GLib.SOURCE_REMOVE;

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

            if (parent !== scrollView) return GLib.SOURCE_REMOVE;

            const currentValue = adjustment.value;
            let newValue = currentValue;

            if (y1 < currentValue + offset)
                newValue = y1 - offset;
            else if (y2 > currentValue + pageSize - offset)
                newValue = y2 + offset - pageSize;
            else
                return GLib.SOURCE_REMOVE;

            const maxValue = Math.max(lower, upper - pageSize);
            newValue = Math.max(lower, Math.min(newValue, maxValue));

            if (newValue === currentValue) return GLib.SOURCE_REMOVE;

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
}

// ============================================================
// CONTROLLER (module functions operating on module state)
// ============================================================

function controllerSetup() {
    state.favorites = AppFavorites.getAppFavorites();

    state.view = new DmenuView();

    appMenuInit(state.view.actor);

    state.preview = new WindowPreview(
        state.view.previewBox,
        window => windowModeHandleClosedWindow(window)
    );

    state.favoritesChangedId = state.favorites.connect('changed', () => {
        if (!state.isOpen || state.modeName !== 'drun') return;
        syncPinnedItems();
        render();
    });
}

function controllerDestroy() {
    closeMenu();

    if (state.favoritesChangedId) {
        try { state.favorites.disconnect(state.favoritesChangedId); } catch (e) { /* ignore */ }
        state.favoritesChangedId = 0;
    }

    state.preview.destroy();
    state.view.destroy();
}

function showGeneric(items, multi = false, hint = null, fullscreen = false) {
    openMenu('stdin', genericModeGetItems(items), multi, hint, fullscreen);
}

function showApps(multi = false, hint = null, fullscreen = false) {
    openMenu('drun', drunModeGetItems(), multi, hint, fullscreen);
}

function showWindows(multi = false, hint = null, fullscreen = false) {
    openMenu('window', windowModeGetItems(), multi, hint, fullscreen);
}

function showPaths(paths, multi = false, hint = null, fullscreen = false) {
    openMenu('paths', pathModeGetItems(paths), multi, hint, fullscreen);
}

function openMenu(modeName, items, multi, hint, fullscreen) {
    if (state.isOpen) closeMenu();

    const capabilities = {
        multi: false, hint: true, fullscreen: true, preview: false,
        ...getModeCapabilities(modeName),
    };

    state.modeName = modeName;
    state.multi = capabilities.multi ? Boolean(multi) : false;
    state.fullscreen = capabilities.fullscreen ? Boolean(fullscreen) : false;
    state.showPreview = Boolean(capabilities.preview);
    state.isOpen = true;

    searchSetItems(items);
    selectionReset();

    state.view.cancelPendingWork();
    state.view.resetInput();

    setHint(capabilities.hint ? hint : null);

    const layout = state.view.configureLayout(state.showPreview, state.fullscreen);
    state.previewWidth = layout.previewWidth;
    state.previewHeight = layout.previewHeight;

    Main.layoutManager.addChrome(state.view.actor, { affectsInputRegion: true });

    state.view.focusInput(state.isOpen);
    renderPinnedBar();
    searchSetQuery('');
    render();
}

function closeMenu() {
    if (state.filterTimeoutId) {
        GLib.source_remove(state.filterTimeoutId);
        state.filterTimeoutId = 0;
    }

    state.view.cancelPendingWork();
    appMenuClose();
    state.preview.hide();

    if (!state.isOpen) return;

    state.view.clearPinnedApps();
    Main.layoutManager.removeChrome(state.view.actor);
    state.isOpen = false;

    searchSetItems([]);
    selectionReset();
}

function setHint(hint) {
    if (hint) { state.view.setHint(hint); return; }

    if (state.modeName === 'drun') {
        state.view.setHint('Type to filter · Enter: launch · Ctrl+P: pin/unpin · Super/Esc: cancel');
    } else if (state.multi) {
        state.view.setHint('Type to filter · Enter: select · Tab: multi-select · Esc: cancel');
    } else {
        state.view.setHint('Type to filter · Enter: select · Esc: cancel');
    }
}

function render() {
    const items = state.search.visibleItems;

    state.view.renderResults(
        items,
        state.search.tokens,
        state.selection.index,
        state.selection.selectedIds,
        state.modeName,
        state.multi
    );

    updateSelectionOnly();
}

function renderPinnedBar() {
    if (state.modeName !== 'drun') {
        state.view.clearPinnedApps();
        return;
    }
    state.view.renderPinnedApps(drunModeGetFavorites());
}

function syncPinnedItems() {
    if (state.modeName !== 'drun') return;

    const favoriteIds = new Set(drunModeGetFavorites().map(app => app.get_id()));
    for (const item of state.search.allItems)
        item.pinned = favoriteIds.has(item.id);

    renderPinnedBar();
}

function togglePinCurrent() {
    const items = state.search.visibleItems;
    if (items.length === 0) return;
    const item = items[state.selection.index];
    if (!item) return;
    drunModeTogglePin(item);
}

function toggleCurrent() {
    const items = state.search.visibleItems;
    if (items.length === 0) return;
    selectionToggle(items[state.selection.index]);
}

function getActivationItems() {
    const items = state.search.visibleItems;

    if (state.multi && state.selection.selectedIds.size > 0)
        return selectionGetSelectedItems(items);

    if (items.length > 0 && state.selection.index < items.length)
        return [items[state.selection.index]];

    return [];
}

function selectIndex(index) {
    const count = state.search.visibleItems.length;
    if (count === 0) return;

    const newIndex = Math.max(0, Math.min(index, count - 1));
    if (state.selection.index === newIndex) return;

    state.selection.index = newIndex;
    updateSelectionOnly();
}

function updateSelectionOnly() {
    state.view.updateSelection(
        state.selection.index,
        state.search.visibleItems,
        state.showPreview
    );
}

function removeItemByData(data) {
    const removed = searchRemoveItemByData(data);
    if (!removed) return;

    const visible = searchSetQuery(state.view.getQuery());
    selectionClamp(visible.length);

    state.selection.selectedIds.forEach(id => {
        if (!state.search.allItems.some(item => item.id === id))
            state.selection.selectedIds.delete(id);
    });

    render();
}

function scheduleSearchUpdate() {
    if (state.filterTimeoutId)
        GLib.source_remove(state.filterTimeoutId);

    state.filterTimeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        FILTER_DEBOUNCE_MS,
        () => {
            state.filterTimeoutId = 0;
            if (!state.isOpen) return GLib.SOURCE_REMOVE;

            appMenuClose();
            state.selection.index = 0;
            searchSetQuery(state.view.getQuery());
            render();

            return GLib.SOURCE_REMOVE;
        }
    );
}

function handleKeyPress(actor, event) {
    const sym = event.get_key_symbol();
    const mods = event.get_state();
    const visibleCount = state.search.visibleItems.length;

    if (sym === Clutter.KEY_Escape) {
        serviceEmitCancelled();
        closeMenu();
        return Clutter.EVENT_STOP;
    }

    if (sym === Clutter.KEY_Down) {
        if (visibleCount > 0) {
            appMenuClose();
            selectionMoveDown(visibleCount);
            updateSelectionOnly();
        }
        return Clutter.EVENT_STOP;
    }

    if (sym === Clutter.KEY_Up) {
        if (visibleCount > 0) {
            appMenuClose();
            selectionMoveUp(visibleCount);
            updateSelectionOnly();
        }
        return Clutter.EVENT_STOP;
    }

    if (state.modeName === 'drun' &&
        sym === Clutter.KEY_p &&
        (mods & Clutter.ModifierType.CONTROL_MASK)) {
        togglePinCurrent();
        return Clutter.EVENT_STOP;
    }

    if (!state.multi)
        return Clutter.EVENT_PROPAGATE;

    if (sym === Clutter.KEY_Tab) {
        toggleCurrent();
        selectionNext(visibleCount);
        updateSelectionOnly();
        return Clutter.EVENT_STOP;
    }

    if (sym === Clutter.KEY_space && (mods & Clutter.ModifierType.CONTROL_MASK)) {
        toggleCurrent();
        updateSelectionOnly();
        return Clutter.EVENT_STOP;
    }

    if ((sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) &&
        (mods & Clutter.ModifierType.SHIFT_MASK)) {
        toggleCurrent();
        selectionNext(visibleCount);
        updateSelectionOnly();
        return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_PROPAGATE;
}

function activate() {
    const selectedItems = getActivationItems();
    let resultLabels = [];

    if (selectedItems.length > 0) {
        if (state.modeName === 'drun') {
            selectedItems.forEach(item => activateInMode('drun', item));
            resultLabels = selectedItems.map(item => item.label);
        } else if (state.modeName === 'window') {
            selectedItems.forEach(item => activateInMode('window', item));
            resultLabels = selectedItems.map(item => item.label);
        } else if (state.modeName === 'paths') {
            resultLabels = selectedItems
                .map(item => activateInMode('paths', item))
                .filter(value => value !== null && value !== undefined);
        } else {
            resultLabels = selectedItems
                .map(item => activateInMode('stdin', item))
                .filter(value => value !== null && value !== undefined);
        }
    } else if (state.view.getQuery()) {
        resultLabels = [state.view.getQuery()];
    }

    if (resultLabels.length > 0)
        serviceEmitSelected(resultLabels);
    else
        serviceEmitCancelled();

    closeMenu();
}

function activatePinnedApp(app) {
    drunModeActivate({ data: app });
    serviceEmitSelected([app.get_name()]);
    closeMenu();
}

function openContextMenu(item, sourceActor) {
    if (state.modeName !== 'drun') return;

    if (!item?.shellApp) {
        journal(`No Shell.App available for ${item?.label || 'unknown item'}`, true);
        return;
    }

    appMenuOpenForApp(sourceActor, item.shellApp);
}

function openContextMenuForApp(app, sourceActor) {
    appMenuOpenForApp(sourceActor, app);
}

// ============================================================
// DBUS SERVICE (module functions)
// ============================================================

const dbusMethods = {
    Show(items, multi, hint, fullscreen) { showGeneric(items, multi, hint, fullscreen); },
    ShowApps(multi, hint, fullscreen) { showApps(multi, hint, fullscreen); },
    ShowWindows(multi, hint, fullscreen) { showWindows(multi, hint, fullscreen); },
    ShowPaths(paths, multi, hint, fullscreen) { showPaths(paths, multi, hint, fullscreen); },
};

function serviceEmitSelected(items) {
    state.dbusImpl.emit_signal('Selected', GLib.Variant.new('(as)', [items]));
}

function serviceEmitCancelled() {
    state.dbusImpl.emit_signal('Cancelled', null);
}

function serviceExport() {
    serviceUnexport();

    if (state.ownerId) {
        Gio.bus_unown_name(state.ownerId);
        state.ownerId = 0;
    }

    state.dbusImpl = Gio.DBusExportedObject.wrapJSObject(DBUS_INTERFACE, dbusMethods);

    state.ownerId = Gio.bus_own_name(
        Gio.BusType.SESSION,
        BUS_NAME,
        Gio.BusNameOwnerFlags.NONE,
        connection => {
            try {
                state.dbusImpl.export(connection, OBJECT_PATH);
                journal(`D-Bus interface exported on ${OBJECT_PATH}`);
            } catch (e) {
                journal(`Failed to export D-Bus interface: ${e.message}`, true);
            }
        },
        (connection, name) => {
            journal(`${name}: name acquired`);
        },
        (connection, name) => {
            journal(`${name}: name lost — another instance may already own it`, true);
            serviceUnexport();
            state.ownerId = 0;
        }
    );
}

function serviceUnexport() {
    if (state.ownerId) {
        Gio.bus_unown_name(state.ownerId);
        state.ownerId = 0;
    }

    try {
        if (state.dbusImpl) {
            state.dbusImpl.unexport();
        }
    } catch (e) {
        if (!e.message.includes('not exported')) {
            journal(`Failed to unexport D-Bus interface: ${e.message}`, true);
        }
    }
}

// ============================================================
// SPEC CACHE / CLI
// ============================================================

function writeSpecCache() {
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

function removeSpecCache() {
    try {
        const filePath = GLib.build_filenamev([SPEC_CACHE_DIR, SPEC_CACHE_FILE]);
        const file = Gio.File.new_for_path(filePath);
        if (file.query_exists(null)) {
            file.delete(null);
            journal('Removed spec cache');
        }
    } catch (e) {
        journal(`Failed to remove spec cache: ${e.message}`, true);
    }
}

function installCli(extensionPath) {
    const cliScript = GLib.build_filenamev([extensionPath, 'cli', 'gdmenu']);
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

function removeCliSymlink(extensionPath) {
    const cliScript = GLib.build_filenamev([extensionPath, 'cli', 'gdmenu']);
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
                journal('Removed CLI symlink');
            }
        }
    } catch (e) {
        journal(`Failed to remove CLI symlink: ${e.message}`, true);
    }
}

// ============================================================
// EXTENSION ENTRY POINT
//
// This class exists only because GNOME Shell requires an Extension subclass
// and because enable/disable hooks and this.path come from it. All the real
// work is done by the module-level functions above.
// ============================================================

export default class SimpleDmenuExtension extends Extension {
    enable() {
        initLogging(this.uuid, 'both', false);
        journal(`Enabled`);

        resetState();
        state.extensionPath = this.path;

        controllerSetup();
        serviceExport();

        installCli(this.path);
        writeSpecCache();
    }

    disable() {
        controllerDestroy();
        serviceUnexport();

        removeCliSymlink(this.path);
        removeSpecCache();

        resetState();
    }

    show(items, multi = false, hint = null, fullscreen = false) {
        showGeneric(items, multi, hint, fullscreen);
    }

    showApps(multi = false, hint = null, fullscreen = false) {
        showApps(multi, hint, fullscreen);
    }

    showWindows(multi = false, hint = null, fullscreen = false) {
        showWindows(multi, hint, fullscreen);
    }

    showPaths(paths, multi = false, hint = null, fullscreen = false) {
        showPaths(paths, multi, hint, fullscreen);
    }
}