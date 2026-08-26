import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

let loggingEnabled = false;
let logOutput = 'journal';
let uuid = null;
let logFile = null;


/*
 * logger.js is in the extension root.
 */
const extensionDir = GLib.path_get_dirname(
    GLib.filename_from_uri(import.meta.url)[0]
);


/*
 * Initialize logging.
 *
 * output:
 *   'journal' -> GNOME Journal only
 *   'file'    -> file only
 *   'both'    -> GNOME Journal + file
 *
 * enabled:
 *   true  -> logging enabled
 *   false -> logging disabled
 */
function initLogging(
    extensionUuid,
    output = 'journal',
    enabled = true
) {
    uuid = extensionUuid;
    logOutput = output;
    loggingEnabled = enabled;

    if (output === 'file' || output === 'both') {
        logFile = GLib.build_filenamev([
            GLib.get_home_dir(),
            `${uuid}.log`,
        ]);
    } else {
        logFile = null;
    }
}


/*
 * Create a logger for a source file.
 *
 * Usage:
 *
 * const journal = createLogger(import.meta.url);
 */
function createLogger(source) {
    let sourceFile;

    try {
        sourceFile = GLib.filename_from_uri(source)[0];
    } catch (e) {
        sourceFile = source;
    }

    /*
     * Convert absolute path into a path
     * relative to the extension root.
     */
    const prefix = `${extensionDir}/`;

    if (sourceFile.startsWith(prefix)) {
        sourceFile = sourceFile.substring(prefix.length);
    }

    const relativeSource = sourceFile;


    return function journal(msg) {

        /*
         * Logging disabled?
         *
         * Do absolutely nothing.
         */
        if (!loggingEnabled)
            return;


        /*
         * Create timestamp once.
         */
        // const timestamp = GLib.DateTime
        //     .new_now_local()
        //     .format('%Y-%m-%d %H:%M:%S');


        /*
         * Create the complete message once.
         *
         * Both Journal and file receive
         * exactly this same string.
         */
        // const output = `[${timestamp}] [${relativeSource}] ${msg}`;
        const output = `[${relativeSource}] ${msg}`;


        if (
            logOutput === 'journal' ||
            logOutput === 'both'
        ) {
            writeToJournal(output);
        }


        if (
            logOutput === 'file' ||
            logOutput === 'both'
        ) {
            writeToFile(output);
        }
    };
}


function writeToJournal(output) {
    GLib.log_structured(
        uuid,
        GLib.LogLevelFlags.LEVEL_MESSAGE,
        {
            MESSAGE: output,
            SYSLOG_IDENTIFIER: uuid,
        }
    );
}


function writeToFile(output) {
    if (!logFile)
        return;

    try {
        const file = Gio.File.new_for_path(logFile);

        const stream = file.append_to(
            Gio.FileCreateFlags.NONE,
            null
        );

        const bytes =
            new TextEncoder().encode(`${output}\n`);

        stream.write_all(bytes, null);
        stream.close(null);

    } catch (e) {
        /*
         * Don't call journal() here.
         */
        console.error(
            `[${uuid}] Failed to write log file: ${e}`
        );
    }
}


export {
    initLogging,
    createLogger,
};