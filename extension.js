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
import { setLogging, setLogFn, journal } from './utils.js';

// ============================================================
// CONSTANTS
// ============================================================

const SPEC_CACHE_DIR = GLib.build_filenamev([
    GLib.get_home_dir(),
    '.cache',
    'gnome-dbus-spec',
]);
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

// ============================================================
// DATA MODEL
// ============================================================

class MenuItem {
    constructor({
        id,
        label,
        icon = null,
        data = null,
        shellApp = null,
        pinned = false,
    }) {
        this.id = id;
        this.label = label;
        this.icon = icon;
        this.data = data;
        this.shellApp = shellApp;
        this.pinned = pinned;
    }
}

// ============================================================
// SHARED OPTIONS
// ============================================================

class DmenuOptions {
    constructor({
        multi = false,
        hint = null,
        fullscreen = false,
    } = {}) {
        this.multi = Boolean(multi);
        this.hint = hint || null;
        this.fullscreen = Boolean(fullscreen);
    }

    static from(multi = false, hint = null, fullscreen = false) {
        return new DmenuOptions({ multi, hint, fullscreen });
    }
}

// ============================================================
// SEARCH MODEL
// ============================================================

class SearchModel {
    constructor() {
        this._allItems = [];
        this._visibleItems = [];
        this._tokens = [];
    }

    setItems(items) {
        this._allItems = [...items];
        this._visibleItems = [...items];
    }

    get allItems() {
        return this._allItems;
    }

    get visibleItems() {
        return this._visibleItems;
    }

    get tokens() {
        return this._tokens;
    }

    setQuery(query) {
        const filter = (query || '').trim().toLowerCase();
        this._tokens = filter.split(/\s+/).filter(Boolean);

        if (this._tokens.length === 0) {
            this._visibleItems = [...this._allItems];
            return this._visibleItems;
        }

        this._visibleItems = this._allItems.filter(item => {
            const lower = item.label.toLowerCase();
            return this._tokens.every(token => lower.includes(token));
        });

        return this._visibleItems;
    }

    removeItemByData(data) {
        const before = this._allItems.length;
        this._allItems = this._allItems.filter(item => item.data !== data);
        return before !== this._allItems.length;
    }

    removeItemById(id) {
        const normalized = String(id);
        const before = this._allItems.length;

        this._allItems = this._allItems.filter(
            item => String(item.id) !== normalized
        );

        return before !== this._allItems.length;
    }

    updateItem(id, updater) {
        const item = this._allItems.find(item => String(item.id) === String(id));
        if (!item)
            return false;

        updater(item);
        return true;
    }
}

// ============================================================
// SELECTION MODEL
// ============================================================

class SelectionModel {
    constructor() {
        this.index = 0;
        this.selectedIds = new Set();
    }

    reset() {
        this.index = 0;
        this.selectedIds.clear();
    }

    clamp(count) {
        if (count <= 0) {
            this.index = 0;
            return;
        }

        this.index = Math.max(0, Math.min(this.index, count - 1));
    }

    moveUp(count) {
        if (count <= 0)
            return;

        this.index = Math.max(0, this.index - 1);
    }

    moveDown(count) {
        if (count <= 0)
            return;

        this.index = Math.min(count - 1, this.index + 1);
    }

    next(count) {
        if (count <= 0)
            return;

        this.index = Math.min(count - 1, this.index + 1);
    }

    toggle(item) {
        if (!item)
            return;

        if (this.selectedIds.has(item.id))
            this.selectedIds.delete(item.id);
        else
            this.selectedIds.add(item.id);
    }

    clear() {
        this.selectedIds.clear();
    }

    getSelectedItems(items) {
        if (this.selectedIds.size === 0)
            return [];

        return items.filter(item => this.selectedIds.has(item.id));
    }
}

// ============================================================
// APP MENU CONTROLLER
// ============================================================

class AppMenuController {
    constructor(sourceActor) {
        this._sourceActor = sourceActor;
        this._menuManager = new PopupMenu.PopupMenuManager(sourceActor);
        this._openMenu = null;
    }

    openForApp(sourceActor, app) {
        this.close();

        const menu = new AppMenu(sourceActor, St.Side.BOTTOM, {
            favoritesSection: true,
            showSingleWindows: true,
        });

        menu.actor.add_style_class_name('dmenu-context-menu');

        Main.layoutManager.addChrome(menu.actor);
        menu.actor.hide();
        this._menuManager.addMenu(menu);

        menu.setApp(app);

        this._openMenu = menu;

        menu.connect('open-state-changed', (o, isOpen) => {
            if (!isOpen) {
                if (menu === this._openMenu)
                    this._openMenu = null;

                menu.destroy();
            }
        });

        menu.open(true);
        return menu;
    }

    close() {
        if (!this._openMenu)
            return;

        const menu = this._openMenu;
        this._openMenu = null;

        try {
            menu.close();
        } catch (e) {
            journal(`Failed to close app menu: ${e.message}`, true);
        }
    }
}

// ============================================================
// SHARED CLONE-PREVIEW BUILDER
// Same technique used by the workspace-thumbnails extension: corrects
// for mutter's invisible shadow margin (buffer_rect vs frame_rect) so
// the clipped clone shows only the visible window content, scaled and
// centered exactly to targetHeight.
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
        const closeIconSize = options.closeButtonSize ?? 32;
        const closeOffsetX = options.closeButtonOffsetX ?? (closeIconSize + 14);
        const closeOffsetY = options.closeButtonOffsetY ?? 10;

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
// WINDOW PREVIEW / CLONE
// ============================================================

class WindowPreview {
    constructor(container, onWindowClosed = null) {
        this._container = container;
        this._onWindowClosed = onWindowClosed;

        this._window = null;
        this._unmanagedId = 0;

        this._clone = null; // clipped container returned by createClonePreviewActor
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

        // Fit-to-box: try full height first, fall back to fitting width —
        // identical to WindowCollectionOverlay._updatePreview.
        const aspect = windowFrame.width / windowFrame.height;
        let targetHeight = height;
        let targetWidth = targetHeight * aspect;
        if (targetWidth > width) {
            targetWidth = width;
            targetHeight = targetWidth / aspect;
        }

        const built = createClonePreviewActor(window, targetHeight, {
            onClose: win => this._requestClose(win),
            closeButtonSize: 48,
            closeButtonOffsetX: 58,
            closeButtonOffsetY: 10,
        });

        if (!built) {
            this.hide();
            return;
        }

        const cloneX = Math.max(0, (width - built.width) / 2);
        const cloneY = Math.max(0, (height - built.height) / 2);

        built.actor.set_position(cloneX, cloneY);

        this._clone = built.actor;
        this._container.add_child(this._clone);

        this._updateTitle(window, built.width, built.height, cloneX, cloneY);
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
        if (this._clone) {
            if (this._clone.get_parent() === this._container)
                this._container.remove_child(this._clone);
            this._clone.destroy();
            this._clone = null;
        }

        if (this._title) {
            if (this._title.get_parent() === this._container)
                this._container.remove_child(this._title);
            this._title.destroy();
            this._title = null;
        }
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
        if (!this._window || !this._unmanagedId)
            return;

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

    _updateTitle(window, targetWidth, targetHeight, cloneX, cloneY) {
        const titleText = window.get_title();

        this._title = new St.Label({
            style_class: 'window-preview-title',
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            text: titleText && titleText.trim() ? titleText : 'Untitled',
        });

        this._title.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        this._title.clutter_text.set_y_align(Clutter.ActorAlign.CENTER);
        this._title.clutter_text.set_line_wrap(true);
        this._title.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        this._title.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);

        const titleHeight = Math.min(140, Math.max(60, targetHeight * 0.25));

        this._title.set_size(targetWidth, titleHeight);
        this._title.set_position(cloneX, cloneY + (targetHeight - titleHeight) / 2);

        this._container.add_child(this._title);
    }
}

// ============================================================
// WINDOW MODE
// ============================================================

class WindowMode {
    constructor(controller) {
        this._controller = controller;
    }

    getCapabilities() {
        return {
            multi: false,
            hint: true,
            fullscreen: true,
            preview: true,
        };
    }

    getItems() {
        const windows = global.display.get_tab_list(
            Meta.TabList.NORMAL,
            null
        );

        let tracker = null;
        if (typeof Shell.WindowTracker.get_default === 'function')
            tracker = Shell.WindowTracker.get_default();
        else
            tracker = Main.windowTracker;

        return windows.map(window => {
            let title = window.get_title();
            if (!title || title.trim() === '')
                title = 'Untitled';

            const app = tracker ? tracker.get_window_app(window) : null;
            const icon = app
                ? app.get_icon()
                : Gio.ThemedIcon.new('application-x-executable');

            return new MenuItem({
                label: title,
                icon,
                data: window,
                id: String(window.get_id()),
            });
        });
    }

    activate(item) {
        const window = item?.data;
        if (!window)
            return;

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

    handleClosedWindow(window) {
        if (!window)
            return;

        journal(`[WindowMode] Window closed: ${window.get_title() || 'Untitled'}`);
        this._controller.removeItemByData(window);
    }
}

// ============================================================
// DRUN MODE
// ============================================================

class DrunMode {
    constructor(controller) {
        this._controller = controller;
        this._favorites = AppFavorites.getAppFavorites();
    }

    getCapabilities() {
        return {
            multi: false,
            hint: true,
            fullscreen: true,
            preview: false,
        };
    }

    getItems() {
        const appSystem = Shell.AppSystem.get_default();
        let apps = [];

        if (appSystem && typeof appSystem.get_all === 'function')
            apps = appSystem.get_all().filter(app => app.should_show());
        else
            apps = Gio.AppInfo.get_all().filter(app => app.should_show());

        apps.sort((a, b) => a.get_name().localeCompare(b.get_name()));

        const favoriteIds = new Set(
            this._favorites.getFavorites().map(app => app.get_id())
        );

        return apps.map(app => {
            let shellApp = null;

            try {
                if (appSystem && typeof appSystem.lookup_app === 'function')
                    shellApp = appSystem.lookup_app(app.get_id());
            } catch (e) {
                journal(
                    `Could not get Shell.App for ${app.get_id()}: ${e.message}`,
                    true
                );
            }

            return new MenuItem({
                label: app.get_name(),
                icon: app.get_icon(),
                data: app,
                shellApp,
                id: app.get_id(),
                pinned: favoriteIds.has(app.get_id()),
            });
        });
    }

    activate(item) {
        const app = item?.data;
        if (!app || typeof app.launch !== 'function')
            return;

        try {
            app.launch([], null);
        } catch (e) {
            journal(`Failed to launch ${item.label}: ${e.message}`, true);
        }
    }

    togglePin(item) {
        if (!item)
            return;

        if (this._favorites.isFavorite(item.id))
            this._favorites.removeFavorite(item.id);
        else
            this._favorites.addFavorite(item.id);
    }

    getFavorites() {
        return this._favorites.getFavorites();
    }

    isFavoriteChangedListener(callback) {
        return this._favorites.connect('changed', callback);
    }

    disconnectFavoriteListener(id) {
        if (!id)
            return;

        try {
            this._favorites.disconnect(id);
        } catch (e) {
            journal(`Failed to disconnect favorites signal: ${e.message}`, true);
        }
    }

    activatePinned(app) {
        try {
            app.launch([], null);
        } catch (e) {
            journal(`Failed to launch ${app.get_name()}: ${e.message}`, true);
        }
    }
}

// ============================================================
// PATH MODE
// ============================================================

class PathMode {
    constructor(controller) {
        this._controller = controller;
    }

    getCapabilities() {
        return {
            multi: true,
            hint: true,
            fullscreen: true,
            preview: false,
        };
    }

    getItems(paths) {
        return paths.map(path => {
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

            return new MenuItem({
                label: path,
                icon,
                data: path,
                id: path,
            });
        });
    }

    activate(item) {
        return item?.data ?? null;
    }
}

// ============================================================
// GENERIC / STDIN MODE
// ============================================================

class GenericMode {
    constructor(controller) {
        this._controller = controller;
    }

    getCapabilities() {
        return {
            multi: true,
            hint: true,
            fullscreen: true,
            preview: false,
        };
    }

    getItems(items) {
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

            return new MenuItem({
                label,
                icon: item.icon || null,
                data: item.data || null,
                id,
            });
        });
    }

    activate(item) {
        return item?.label ?? null;
    }
}

// ============================================================
// MAIN VIEW
// ============================================================

class DmenuView {
    constructor(controller) {
        this._controller = controller;

        this.actor = new St.BoxLayout({
            style_class: 'dmenu-container',
            vertical: false,
            reactive: true,
            can_focus: true,
        });

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
        this._filterTimeoutId = null;
        this._scrollIdleId = null;

        this.entry.get_clutter_text().connect(
            'text-changed',
            () => this._handleTextChanged()
        );

        this.entry.get_clutter_text().connect(
            'activate',
            () => this._controller.activate()
        );

        this.actor.connect(
            'key-press-event',
            (actor, event) => this._controller.handleKeyPress(actor, event)
        );

        this.actor.connect('button-press-event', () => {
            this.entry.grab_key_focus();
            return Clutter.EVENT_STOP;
        });
    }

    destroy() {
        this.cancelPendingWork();
        this.actor.destroy();
    }

    show() {
        this.actor.show();
    }

    hide() {
        this.actor.hide();
    }

    cancelPendingWork() {
        if (this._filterTimeoutId) {
            GLib.source_remove(this._filterTimeoutId);
            this._filterTimeoutId = null;
        }

        if (this._scrollIdleId) {
            GLib.source_remove(this._scrollIdleId);
            this._scrollIdleId = null;
        }
    }

    setHint(text) {
        this.entry.set_hint_text(text);
    }

    resetInput() {
        this.entry.set_text('');
    }

    getQuery() {
        return this.entry.get_text();
    }

    focusInput(isOpen) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (isOpen)
                this.entry.grab_key_focus();

            return GLib.SOURCE_REMOVE;
        });
    }

    configureLayout(showPreview, fullscreen) {
        const monitor = Main.layoutManager.primaryMonitor;

        let totalWidth;
        let totalHeight;
        let leftWidth;
        let previewWidth = 0;

        if (showPreview) {
            if (fullscreen) {
                // Same left-rail/preview split as the normal view below,
                // just claiming the whole monitor instead of 90%/80% + centering.
                totalWidth = monitor.width;
                totalHeight = monitor.height;

                leftWidth = Math.max(300, Math.floor(totalWidth * 0.25));
                previewWidth = totalWidth - leftWidth - 10;

                if (previewWidth < 400) {
                    leftWidth = Math.max(200, totalWidth - 400 - 10);
                    previewWidth = totalWidth - leftWidth - 10;
                }

                this.leftBox.set_width(leftWidth);
                this.previewBox.visible = true;

                this.actor.set_width(totalWidth);
                this.actor.set_height(totalHeight);
                this.actor.set_position(monitor.x, monitor.y);

                return { previewWidth, previewHeight: totalHeight };
            }

            // Unchanged: the original centered view.
            const WIDTH_FRAC = 0.9;
            const HEIGHT_FRAC = 0.8;

            totalWidth = Math.min(
                Math.floor(monitor.width * WIDTH_FRAC),
                monitor.width - 40
            );

            totalHeight = Math.min(
                Math.floor(monitor.height * HEIGHT_FRAC),
                monitor.height - 40
            );

            leftWidth = Math.max(300, Math.floor(totalWidth * 0.25));
            previewWidth = totalWidth - leftWidth - 10;

            if (previewWidth < 400) {
                leftWidth = Math.max(200, totalWidth - 400 - 10);
                previewWidth = totalWidth - leftWidth - 10;
            }

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

        // Non-preview modes: unchanged.
        const MAX_WIDTH = Math.min(1000, monitor.width - 100);
        const MAX_HEIGHT = Math.min(600, monitor.height - 150);

        totalWidth = MAX_WIDTH;
        totalHeight = MAX_HEIGHT;
        leftWidth = totalWidth;

        this.leftBox.set_width(leftWidth);
        this.previewBox.visible = false;

        if (fullscreen) {
            this.actor.set_width(monitor.width);
            this.actor.set_height(monitor.height);
            this.actor.set_position(monitor.x, monitor.y);
            this.leftBox.set_width(monitor.width);
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

            const marker = new St.Label({
                text: multi && selectedIds.has(item.id) ? '●' : '',
                style_class: 'dmenu-marker',
                y_align: Clutter.ActorAlign.CENTER,
            });

            const pinMarker = new St.Label({
                text: modeName === 'drun' && item.pinned ? '📌' : '',
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

            const label = new St.Label({
                style_class: i === selectedIndex
                    ? 'dmenu-result dmenu-result-selected'
                    : 'dmenu-result',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            label.clutter_text.set_markup(
                highlightLabel(item.label, tokens)
            );

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
                    this._controller.openContextMenu(item, row);
                    return Clutter.EVENT_STOP;
                }

                if (button === Clutter.BUTTON_PRIMARY) {
                    label.remove_style_class_name('dmenu-result-hover');
                    label.add_style_class_name('dmenu-result-clicked');
                    this._controller.selectIndex(rowIndex);

                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                        this._controller.activate();
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
                    icon_size: 48,
                }),
                reactive: true,
                can_focus: true,
                track_hover: true,
            });

            button.connect('clicked', () => {
                this._controller.activatePinnedApp(app);
            });

            button.connect('button-press-event', (actor, event) => {
                if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                    this._controller.openContextMenuForApp(app, button);
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
        if (this._rowActors.length === 0)
            return;

        const selectedRow = this._rowActors[index];
        if (!selectedRow)
            return;

        const isOpen = () => this._controller.isOpen;
        const scrollView = this.resultsContainer;

        this._scrollIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._scrollIdleId = null;

            if (!isOpen() || !this._rowActors.includes(selectedRow))
                return GLib.SOURCE_REMOVE;

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

            if (y1 < currentValue + offset)
                newValue = y1 - offset;
            else if (y2 > currentValue + pageSize - offset)
                newValue = y2 + offset - pageSize;
            else
                return GLib.SOURCE_REMOVE;

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

    _handleTextChanged() {
        this._controller.scheduleSearchUpdate();
    }
}

// ============================================================
// MAIN CONTROLLER
// ============================================================

class DmenuController {
    constructor(service) {
        this._service = service;

        this._search = new SearchModel();
        this._selection = new SelectionModel();

        this._windowMode = new WindowMode(this);
        this._drunMode = new DrunMode(this);
        this._pathMode = new PathMode(this);
        this._genericMode = new GenericMode(this);

        this._mode = this._genericMode;
        this._modeName = 'stdin';

        this._view = new DmenuView(this);
        this._appMenu = new AppMenuController(this._view.actor);
        this._preview = new WindowPreview(
            this._view.previewBox,
            window => this._windowMode.handleClosedWindow(window)
        );

        this._isOpen = false;
        this._multi = false;
        this._fullscreen = false;
        this._filterTimeoutId = null;
        this._showPreview = false;
        this._previewWidth = 0;
        this._previewHeight = 0;

        this._favoritesChangedId = this._drunMode.isFavoriteChangedListener(() => {
            if (!this._isOpen || this._modeName !== 'drun')
                return;

            this._syncPinnedItems();
            this._render();
        });
    }

    get isOpen() {
        return this._isOpen;
    }

    show(items, multi = false, hint = null, fullscreen = false) {
        const options = DmenuOptions.from(multi, hint, fullscreen);

        this._open(
            'stdin',
            this._genericMode,
            this._genericMode.getItems(items),
            options
        );
    }

    showApps(multi = false, hint = null, fullscreen = false) {
        const options = DmenuOptions.from(multi, hint, fullscreen);

        this._open(
            'drun',
            this._drunMode,
            this._drunMode.getItems(),
            options
        );
    }

    showWindows(multi = false, hint = null, fullscreen = false) {
        const options = DmenuOptions.from(multi, hint, fullscreen);

        this._open(
            'window',
            this._windowMode,
            this._windowMode.getItems(),
            options
        );
    }

    showPaths(paths, multi = false, hint = null, fullscreen = false) {
        const options = DmenuOptions.from(multi, hint, fullscreen);

        this._open(
            'paths',
            this._pathMode,
            this._pathMode.getItems(paths),
            options
        );
    }

    hide() {
        this._closeInternal();
    }

    destroy() {
        this._closeInternal();

        if (this._favoritesChangedId) {
            this._drunMode.disconnectFavoriteListener(this._favoritesChangedId);
            this._favoritesChangedId = 0;
        }

        this._preview.destroy();
        this._view.destroy();
    }

    selectIndex(index) {
        const count = this._search.visibleItems.length;
        if (count === 0)
            return;

        this._selection.index = Math.max(0, Math.min(index, count - 1));
        this._render();
    }

    removeItemByData(data) {
        const removed = this._search.removeItemByData(data);
        if (!removed)
            return;

        const visible = this._search.setQuery(this._view.getQuery());
        this._selection.clamp(visible.length);
        this._selection.selectedIds.forEach(id => {
            if (!this._search.allItems.some(item => item.id === id))
                this._selection.selectedIds.delete(id);
        });

        this._render();
    }

    scheduleSearchUpdate() {
        if (this._filterTimeoutId)
            GLib.source_remove(this._filterTimeoutId);

        this._filterTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            FILTER_DEBOUNCE_MS,
            () => {
                this._filterTimeoutId = null;

                if (!this._isOpen)
                    return GLib.SOURCE_REMOVE;

                this._appMenu.close();
                this._selection.index = 0;
                this._search.setQuery(this._view.getQuery());
                this._render();

                return GLib.SOURCE_REMOVE;
            }
        );
    }

    handleKeyPress(actor, event) {
        const sym = event.get_key_symbol();
        const mods = event.get_state();
        const visibleCount = this._search.visibleItems.length;

        if (sym === Clutter.KEY_Escape) {
            this._service.emitCancelled();
            this.hide();
            return Clutter.EVENT_STOP;
        }

        if (sym === Clutter.KEY_Down) {
            if (visibleCount > 0) {
                this._appMenu.close();
                this._selection.moveDown(visibleCount);
                this._render();
            }
            return Clutter.EVENT_STOP;
        }

        if (sym === Clutter.KEY_Up) {
            if (visibleCount > 0) {
                this._appMenu.close();
                this._selection.moveUp(visibleCount);
                this._render();
            }
            return Clutter.EVENT_STOP;
        }

        if (this._modeName === 'drun' &&
            sym === Clutter.KEY_p &&
            (mods & Clutter.ModifierType.CONTROL_MASK)) {
            this._togglePinCurrent();
            return Clutter.EVENT_STOP;
        }

        if (!this._multi)
            return Clutter.EVENT_PROPAGATE;

        if (sym === Clutter.KEY_Tab) {
            this._toggleCurrent();
            this._selection.next(visibleCount);
            this._render();
            return Clutter.EVENT_STOP;
        }

        if (sym === Clutter.KEY_space &&
            (mods & Clutter.ModifierType.CONTROL_MASK)) {
            this._toggleCurrent();
            this._render();
            return Clutter.EVENT_STOP;
        }

        if ((sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) &&
            (mods & Clutter.ModifierType.SHIFT_MASK)) {
            this._toggleCurrent();
            this._selection.next(visibleCount);
            this._render();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    activate() {
        const selectedItems = this._getActivationItems();
        let resultLabels = [];

        if (selectedItems.length > 0) {
            if (this._modeName === 'drun') {
                selectedItems.forEach(item => this._drunMode.activate(item));
                resultLabels = selectedItems.map(item => item.label);
            } else if (this._modeName === 'window') {
                selectedItems.forEach(item => this._windowMode.activate(item));
                resultLabels = selectedItems.map(item => item.label);
            } else if (this._modeName === 'paths') {
                resultLabels = selectedItems
                    .map(item => this._pathMode.activate(item))
                    .filter(value => value !== null && value !== undefined);
            } else {
                resultLabels = selectedItems
                    .map(item => this._genericMode.activate(item))
                    .filter(value => value !== null && value !== undefined);
            }
        } else if (this._view.getQuery()) {
            resultLabels = [this._view.getQuery()];
        }

        if (resultLabels.length > 0)
            this._service.emitSelected(resultLabels);
        else
            this._service.emitCancelled();

        this.hide();
    }

    activatePinnedApp(app) {
        this._drunMode.activatePinned(app);
        this._service.emitSelected([app.get_name()]);
        this.hide();
    }

    openContextMenu(item, sourceActor) {
        if (this._modeName !== 'drun')
            return;

        if (!item?.shellApp) {
            journal(`No Shell.App available for ${item?.label || 'unknown item'}`, true);
            return;
        }

        this._appMenu.openForApp(sourceActor, item.shellApp);
    }

    openContextMenuForApp(app, sourceActor) {
        this._appMenu.openForApp(sourceActor, app);
    }

    _open(modeName, mode, items, options) {
        if (this._isOpen)
            this._closeInternal();

        const capabilities = {
            multi: false,
            hint: true,
            fullscreen: true,
            preview: false,
            ...(typeof mode.getCapabilities === 'function'
                ? mode.getCapabilities()
                : {}),
        };

        const requested = options instanceof DmenuOptions
            ? options
            : new DmenuOptions(options);

        // Unsupported mode options are intentionally ignored.
        const effectiveOptions = new DmenuOptions({
            multi: capabilities.multi ? requested.multi : false,
            hint: capabilities.hint ? requested.hint : null,
            fullscreen: capabilities.fullscreen ? requested.fullscreen : false,
        });

        this._modeName = modeName;
        this._mode = mode;
        this._multi = effectiveOptions.multi;
        this._fullscreen = effectiveOptions.fullscreen;
        this._isOpen = true;

        this._search.setItems(items);
        this._selection.reset();

        // this._showPreview = Boolean(
        //     capabilities.preview && !effectiveOptions.fullscreen
        // );
        this._showPreview = Boolean(capabilities.preview);

        this._view.cancelPendingWork();
        this._view.resetInput();
        this._setHint(effectiveOptions.hint);

        const layout = this._view.configureLayout(
            this._showPreview,
            effectiveOptions.fullscreen
        );

        this._previewWidth = layout.previewWidth;
        this._previewHeight = layout.previewHeight;

        Main.layoutManager.addChrome(this._view.actor, {
            affectsInputRegion: true,
        });

        this._view.focusInput(this._isOpen);
        this._renderPinnedBar();
        this._search.setQuery('');
        this._render();
    }

    _closeInternal() {
        if (this._filterTimeoutId) {
            GLib.source_remove(this._filterTimeoutId);
            this._filterTimeoutId = null;
        }

        this._view.cancelPendingWork();
        this._appMenu.close();
        this._preview.hide();

        if (!this._isOpen)
            return;

        this._view.clearPinnedApps();
        Main.layoutManager.removeChrome(this._view.actor);
        this._isOpen = false;

        this._search.setItems([]);
        this._selection.reset();
    }

    _setHint(hint) {
        if (hint) {
            this._view.setHint(hint);
            return;
        }

        if (this._modeName === 'drun') {
            this._view.setHint(
                'Type to filter · Enter: launch · Ctrl+P: pin/unpin · Super/Esc: cancel'
            );
        } else if (this._multi) {
            this._view.setHint(
                'Type to filter · Enter: select · Tab: multi-select · Esc: cancel'
            );
        } else {
            this._view.setHint(
                'Type to filter · Enter: select · Esc: cancel'
            );
        }
    }

    _render() {
        const items = this._search.visibleItems;

        this._view.renderResults(
            items,
            this._search.tokens,
            this._selection.index,
            this._selection.selectedIds,
            this._modeName,
            this._multi
        );

        if (this._showPreview && items.length > 0) {
            const selectedItem = items[this._selection.index];

            if (selectedItem?.data instanceof Meta.Window) {
                this._preview.show(
                    selectedItem.data,
                    this._previewWidth,
                    this._previewHeight
                );
            } else {
                this._preview.hide();
            }
        } else {
            this._preview.hide();
        }
    }

    _renderPinnedBar() {
        if (this._modeName !== 'drun') {
            this._view.clearPinnedApps();
            return;
        }

        this._view.renderPinnedApps(this._drunMode.getFavorites());
    }

    _syncPinnedItems() {
        if (this._modeName !== 'drun')
            return;

        const favoriteIds = new Set(
            this._drunMode.getFavorites().map(app => app.get_id())
        );

        for (const item of this._search.allItems)
            item.pinned = favoriteIds.has(item.id);

        this._renderPinnedBar();
    }

    _togglePinCurrent() {
        const items = this._search.visibleItems;
        if (items.length === 0)
            return;

        const item = items[this._selection.index];
        if (!item)
            return;

        this._drunMode.togglePin(item);
    }

    _toggleCurrent() {
        const items = this._search.visibleItems;
        if (items.length === 0)
            return;

        this._selection.toggle(items[this._selection.index]);
    }

    _getActivationItems() {
        const items = this._search.visibleItems;

        if (this._multi && this._selection.selectedIds.size > 0)
            return this._selection.getSelectedItems(items);

        if (items.length > 0 && this._selection.index < items.length)
            return [items[this._selection.index]];

        return [];
    }
}

// ============================================================
// DBUS SERVICE
// ============================================================

class DmenuService {
    constructor(extension) {
        this._extension = extension;
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(
            DBUS_INTERFACE,
            this
        );
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
        this._dbusImpl.emit_signal(
            'Selected',
            GLib.Variant.new('(as)', [items])
        );
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
            connection => {
                try {
                    this._dbusImpl.export(connection, OBJECT_PATH);
                    journal(`D-Bus interface exported on ${OBJECT_PATH}`);
                    this._exported = true;
                } catch (e) {
                    journal(
                        `Failed to export D-Bus interface: ${e.message}`,
                        true
                    );
                    this._exported = false;
                }
            },
            (connection, name) => {
                journal(`${name}: name acquired`);
            },
            (connection, name) => {
                journal(
                    `${name}: name lost — another instance may already own it`,
                    true
                );
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
                journal(
                    `Failed to unexport D-Bus interface: ${e.message}`,
                    true
                );
            }
        }
    }
}

// ============================================================
// GNOME SHELL EXTENSION
// ============================================================

export default class SimpleDmenuExtension extends Extension {
    _writeSpecCache() {
        try {
            GLib.mkdir_with_parents(SPEC_CACHE_DIR, 0o755);

            const spec = {
                bus_name: BUS_NAME,
                object_path: OBJECT_PATH,
                xml: DBUS_INTERFACE,
            };

            const filePath = GLib.build_filenamev([
                SPEC_CACHE_DIR,
                SPEC_CACHE_FILE,
            ]);

            GLib.file_set_contents(
                filePath,
                JSON.stringify(spec, null, 2)
            );

            journal(`Wrote spec cache to ${filePath}`);
        } catch (e) {
            journal(`Failed to write spec cache: ${e.message}`, true);
        }
    }

    _removeSpecCache() {
        try {
            const filePath = GLib.build_filenamev([
                SPEC_CACHE_DIR,
                SPEC_CACHE_FILE,
            ]);

            const file = Gio.File.new_for_path(filePath);

            if (file.query_exists(null)) {
                file.delete(null);
                journal('Removed spec cache');
            }
        } catch (e) {
            journal(`Failed to remove spec cache: ${e.message}`, true);
        }
    }

    _installCli() {
        const cliScript = GLib.build_filenamev([
            this.path,
            'cli',
            'gdmenu',
        ]);
        const binDir = GLib.build_filenamev([
            GLib.get_home_dir(),
            '.local',
            'bin',
        ]);
        const symlinkPath = GLib.build_filenamev([
            binDir,
            'gdmenu',
        ]);

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
        const cliScript = GLib.build_filenamev([
            this.path,
            'cli',
            'gdmenu',
        ]);
        const symlinkPath = GLib.build_filenamev([
            GLib.get_home_dir(),
            '.local',
            'bin',
            'gdmenu',
        ]);

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

        this._controller = new DmenuController(this._service);

        this._installCli();
        this._writeSpecCache();
    }

    disable() {
        this._controller?.destroy();
        this._controller = null;

        this._service?.unexport();
        this._service = null;

        this._removeCliSymlink();
        this._removeSpecCache();
    }

    show(items, multi = false, hint = null, fullscreen = false) {
        this._controller.show(items, multi, hint, fullscreen);
    }

    showApps(multi = false, hint = null, fullscreen = false) {
        this._controller.showApps(multi, hint, fullscreen);
    }

    showWindows(multi = false, hint = null, fullscreen = false) {
        this._controller.showWindows(multi, hint, fullscreen);
    }

    showPaths(paths, multi = false, hint = null, fullscreen = false) {
        this._controller.showPaths(paths, multi, hint, fullscreen);
    }
}
