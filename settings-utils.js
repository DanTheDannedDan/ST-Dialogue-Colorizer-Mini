import { extension_settings } from "../../../extensions.js";
import { ByRef } from "./ByRef.js";

/** @template TSettings */
export class STExtensionSettingsWrapper {
    #settings;

    /**
     * 
     * @param {TSettings} settings
     */
    constructor(settings) {
        if (settings === null || settings === undefined) {
            throw new Error("Settings object is null or undefined; pass in a valid settings object.");
        }

        this.#settings = settings;
    }

    get settings() {
        return this.#settings;
    }

    /**
     * Gets the value of the specified key.
     * 
     * @param {keyof TSettings} key 
     * @returns {TSettings[keyof TSettings]}
     */
    get(key) {
        return this.#settings[key];
    }

    /**
     * Sets a setting to the specified value.
     * 
     * @param {keyof TSettings} key
     * @param {TSettings[keyof TSettings]} value
     */
    set(key, value) {
        this.#settings[key] = value;
    }

    /**
     * Deletes the specified setting.
     * 
     * @param {keyof TSettings} key
     */
    delete(key) {
        delete this.#settings[key];
    }

    /**
     * Create a new settings wrapper by using a {@linkcode ByRef} to initialize the wrapped settings object.
     * 
     * @template TSettings
     * @param {ByRef<TSettings>} refSettings A reference passed-by-reference to a settings object.
     * @param {TSettings=} defaultSettings A default settings object to initialize the passed settings with, if necessary.
     */
    static safeWrap(refSettings, defaultSettings) {
        if (!(refSettings instanceof ByRef)) {
            throw new TypeError("STExtensionSettingsWrapper.safeWrap() requires a ByRef.");
        }

        const savedSettings = refSettings.ref;
        refSettings.ref = Object.assign({}, defaultSettings ?? {}, savedSettings);
        return new this(refSettings.ref);
    }

    /**
     * Wraps the extension settings object for the specified extension.
     * 
     * @template TSettings
     * @param {string} extensionName The name of the extension to wrap the settings of.
     * @param {TSettings=} defaultSettings A default settings object to initialize the extension's settings with, if necessary.
     */
    static wrapSettingsForExtension(extensionName, defaultSettings) {
        /** @type {extension_settings[extensionName]} */
        const byRefSettings = ByRef.createKeyAccessor(extension_settings, extensionName);
        return this.safeWrap(byRefSettings, defaultSettings);
    }
}

/**
 * Returns whether a value is a plain object (and therefore safe to merge into
 * recursively). Arrays and class instances are treated as opaque values.
 *
 * @param {any} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Recursively merges saved settings over defaults.
 *
 * A shallow `Object.assign` would let a saved nested object completely replace
 * its default counterpart, so any option added in a later version would stay
 * `undefined` for existing users. This walks nested plain objects instead, so
 * new defaults appear while user values win. Unknown saved keys are preserved.
 *
 * @template T
 * @param {T} defaults
 * @param {any} saved
 * @returns {T}
 */
export function mergeSettings(defaults, saved) {
    if (!isPlainObject(saved)) {
        return isPlainObject(defaults) ? structuredClone(defaults) : defaults;
    }

    /** @type {any} */
    const result = isPlainObject(defaults) ? structuredClone(defaults) : {};

    for (const [key, savedValue] of Object.entries(saved)) {
        const defaultValue = result[key];
        result[key] = isPlainObject(defaultValue) && isPlainObject(savedValue)
            ? mergeSettings(defaultValue, savedValue)
            : savedValue;
    }

    return result;
}

/**
 * Ensures the settings dictionary for the specified extension is initialized and then returns it.
 *
 * @template TSettings
 * @param {string} extensionName
 * @param {(() => TSettings) | TSettings} [defaultSettings] Either a defaults
 * object or a factory returning one. A factory is preferred when the defaults
 * contain sibling keys that must not share the same object reference —
 * `structuredClone` faithfully preserves internal aliasing, which would
 * otherwise make edits to one section silently mutate another.
 * @returns {TSettings}
 */
export function initializeSettings(extensionName, defaultSettings) {
    const savedSettings = extension_settings[extensionName];
    const defaults = typeof defaultSettings === 'function'
        ? /** @type {() => TSettings} */ (defaultSettings)()
        : defaultSettings;

    extension_settings[extensionName] = mergeSettings(defaults ?? /** @type {any} */ ({}), savedSettings);
    return extension_settings[extensionName];
}