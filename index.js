import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";

import {
    getSmartAvatarColor,
    invalidateSwatchCache,
    makeBetterContrast,
    normalizeCssColor,
    parseCssColor,
    rgbToHex,
} from "./color-utils.js";
import {
    closeColorPickerPopover,
    isColorPickerOpen,
    openColorPickerPopover,
} from "./color-picker.js";
import {
    closeActiveEyedropper,
    isEyedropperActive,
    isNativeEyeDropperSupported,
    pickColor,
} from "./eyedropper.js";
import {
    CharacterType,
    getAllPersonas,
    getAvatarCandidateUrls,
    getCharacterBeingEdited,
    getCurrentCharacter,
    getCurrentGroupCharacters,
    getCurrentPersona,
    isInGroupChat,
    resolveMessageAuthor,
} from "./st-utils.js";

const EXT_NAME = "ST-Dialogue-Colorizer-Mini";
const DEFAULT_FALLBACK_COLOR = "#e18a24";
const MAX_COLOR_CACHE = 150;

/**
 * Ensures minimal settings structure exists in `extension_settings`.
 * Everything else (Avatar Smart + manual override, color names, no boost,
 * no auto-contrast) is hardcoded.
 */
function ensureSettings() {
    if (!extension_settings[EXT_NAME] || typeof extension_settings[EXT_NAME] !== "object") {
        extension_settings[EXT_NAME] = {};
    }
    const s = extension_settings[EXT_NAME];
    if (!s.charColorOverrides || typeof s.charColorOverrides !== "object") {
        s.charColorOverrides = {};
    }
    if (!s.personaColorOverrides || typeof s.personaColorOverrides !== "object") {
        s.personaColorOverrides = {};
    }
    return s;
}

const extSettings = ensureSettings();

/**
 * @param {string} charType
 * @returns {Record<string, string>}
 */
function getOverridesMap(charType) {
    return charType === CharacterType.PERSONA
        ? extSettings.personaColorOverrides
        : extSettings.charColorOverrides;
}

/**
 * Detects whether the active SillyTavern / TauriTavern theme has a light surface.
 * Checks opaque surface backgrounds first (`#sheld`, `#chat`, `body`), and falls
 * back to inverted text luminance on translucent/glass themes.
 */
function detectLightTheme() {
    const candidates = [
        document.getElementById("sheld"),
        document.getElementById("chat"),
        document.body,
        document.documentElement,
    ];

    for (const el of candidates) {
        if (!el) continue;
        const bg = parseCssColor(window.getComputedStyle(el).backgroundColor);
        if (bg && bg.a >= 100) {
            const lum = (0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b) / 255;
            return lum > 0.5;
        }
    }

    const rootStyle = window.getComputedStyle(document.documentElement);
    for (const prop of ["--SmartThemeChatTintColor", "--SmartThemeBlurTintColor"]) {
        const val = rootStyle.getPropertyValue(prop);
        const parsed = parseCssColor(val);
        if (parsed && parsed.a >= 100) {
            const lum = (0.299 * parsed.r + 0.587 * parsed.g + 0.114 * parsed.b) / 255;
            return lum > 0.5;
        }
    }

    const textTarget = document.getElementById("chat") || document.body;
    if (textTarget) {
        const fg = parseCssColor(window.getComputedStyle(textTarget).color);
        if (fg && fg.a >= 100) {
            const lum = (0.299 * fg.r + 0.587 * fg.g + 0.114 * fg.b) / 255;
            return lum < 0.45;
        }
    }

    return false;
}

let cachedIsLightTheme = false;

/** @type {HTMLStyleElement | null} */
let colorStyleElement = null;

/**
 * Maps `uid` -> `{ varRule: CSSStyleRule, color: string }`.
 * Updating an override or dragging the color picker edits ONLY `varRule.style`,
 * keeping frame times < 0.2ms even on massive chats.
 * @type {Map<string, { varRule: CSSStyleRule, color: string }>}
 */
const activeRules = new Map();

/**
 * Bounded LRU cache of auto-extracted Avatar Smart colors keyed by `${uid}|${isLight}`.
 * @type {Map<string, string>}
 */
const smartColorCache = new Map();

/**
 * In-flight color extraction promises keyed by `${uid}|${isLight}` to deduplicate parallel calls.
 * @type {Map<string, Promise<string>>}
 */
const pendingColorTasks = new Map();

/**
 * @param {string} key
 * @param {string} value
 */
function setSmartCache(key, value) {
    if (smartColorCache.has(key)) {
        smartColorCache.delete(key);
    }
    smartColorCache.set(key, value);
    if (smartColorCache.size > MAX_COLOR_CACHE) {
        const oldest = smartColorCache.keys().next().value;
        if (oldest !== undefined) smartColorCache.delete(oldest);
    }
}

/**
 * Escapes a value for safe inclusion inside a CSS `[attr="..."]` selector.
 * @param {string} value
 * @returns {string}
 */
function cssEscapeAttr(value) {
    return String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\d ")
        .replace(/\n/g, "\\a ");
}

function initStyleSheet() {
    document.getElementById("sdc-colors-style")?.remove();
    activeRules.clear();
    colorStyleElement = document.createElement("style");
    colorStyleElement.id = "sdc-colors-style";
    document.head.appendChild(colorStyleElement);

    const sheet = colorStyleElement.sheet;
    if (sheet) {
        sheet.insertRule(
            `#chat .mes[data-sdc-uid] .mes_text q, #chat .mes[data-sdc-uid] .ch_name .name_text, #chat .mes[data-sdc-uid] .name_text, .mes[data-sdc-uid] .mes_text q, .mes[data-sdc-uid] .ch_name .name_text, .mes[data-sdc-uid] .name_text { color: var(--sdc-color); }`,
            sheet.cssRules.length
        );
    }
}

/**
 * Immediately inserts or updates the CSS variable `--sdc-color` for a single UID.
 * Zero full-stylesheet rebuilds and zero animations.
 *
 * @param {string} uid
 * @param {string} cssColor
 */
function applyCssColor(uid, cssColor) {
    if (!cssColor) return;
    if (!colorStyleElement || !colorStyleElement.isConnected || !colorStyleElement.sheet) {
        const snapshot = Array.from(activeRules.entries(), ([k, v]) => [k, v.color]);
        initStyleSheet();
        for (const [k, c] of snapshot) {
            if (k !== uid) applyCssColor(k, c);
        }
    }

    const sheet = colorStyleElement?.sheet;
    if (!sheet) return;

    const existing = activeRules.get(uid);
    if (existing) {
        if (existing.color !== cssColor) {
            existing.varRule.style.setProperty("--sdc-color", cssColor);
            existing.color = cssColor;
        }
        return;
    }

    const esc = cssEscapeAttr(uid);
    const varIdx = sheet.insertRule(
        `.mes[data-sdc-uid="${esc}"] { --sdc-color: ${cssColor}; }`,
        sheet.cssRules.length
    );
    const varRule = /** @type {CSSStyleRule} */ (sheet.cssRules[varIdx]);
    activeRules.set(uid, { varRule, color: cssColor });
}

/**
 * Loads an avatar Image from candidate URLs in order until one decodes.
 * @param {string} type
 * @param {string} avatarName
 * @param {string | null} [fallbackImgSrc]
 * @param {boolean} [cacheBust=false]
 * @returns {Promise<HTMLImageElement | null>}
 */
async function loadAvatarImage(type, avatarName, fallbackImgSrc = null, cacheBust = false) {
    const candidates = getAvatarCandidateUrls(type, avatarName, fallbackImgSrc, cacheBust);
    for (const url of candidates) {
        const loaded = await new Promise((resolve) => {
            const img = new Image();
            let settled = false;
            const timer = window.setTimeout(() => {
                if (settled) return;
                settled = true;
                img.onload = null;
                img.onerror = null;
                resolve(null);
            }, 10000);

            img.onload = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(img.naturalWidth > 0 ? img : null);
            };
            img.onerror = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(null);
            };
            img.src = url;
        });
        if (loaded) return /** @type {HTMLImageElement} */ (loaded);
    }
    return null;
}

/**
 * Resolves the Avatar Smart color for an author (ignoring manual override), using cache.
 * @param {{ type: string, avatarName: string, uid: string, fallbackImgSrc?: string | null }} author
 * @param {boolean} [cacheBust=false]
 * @returns {Promise<string>}
 */
async function resolveSmartColor(author, cacheBust = false) {
    const isLight = cachedIsLightTheme;
    const cacheKey = `${author.uid}|${isLight ? "L" : "D"}`;

    if (!cacheBust) {
        const cached = smartColorCache.get(cacheKey);
        if (cached) {
            setSmartCache(cacheKey, cached);
            return cached;
        }

        const inflight = pendingColorTasks.get(cacheKey);
        if (inflight) return inflight;
    }

    const task = (async () => {
        try {
            const img = await loadAvatarImage(
                author.type,
                author.avatarName,
                author.fallbackImgSrc ?? null,
                cacheBust
            );
            if (!img) return DEFAULT_FALLBACK_COLOR;

            const smartRgb = await getSmartAvatarColor(img);
            if (!smartRgb) return DEFAULT_FALLBACK_COLOR;

            const adjusted = makeBetterContrast(smartRgb, isLight);
            const hex = rgbToHex(adjusted[0], adjusted[1], adjusted[2]);
            setSmartCache(cacheKey, hex);
            return hex;
        } catch (err) {
            console.debug(`[${EXT_NAME}] Avatar Smart extraction failed for ${author.uid}:`, err);
            return DEFAULT_FALLBACK_COLOR;
        } finally {
            pendingColorTasks.delete(cacheKey);
        }
    })();

    pendingColorTasks.set(cacheKey, task);
    return task;
}

/**
 * Computes and applies the active color (manual override first, otherwise Avatar Smart)
 * for a single author. Guards against mid-flight override edits.
 *
 * @param {{ type: string, avatarName: string, uid: string, fallbackImgSrc?: string | null }} author
 * @param {{ cacheBust?: boolean }} [options]
 */
async function ensureAuthorColor(author, options = {}) {
    const overrides = getOverridesMap(author.type);
    const rawOverride = overrides[author.avatarName];
    const validOverride = rawOverride ? normalizeCssColor(rawOverride) : null;

    if (validOverride) {
        applyCssColor(author.uid, validOverride);
        return validOverride;
    }

    const smartHex = await resolveSmartColor(author, Boolean(options.cacheBust));

    // Re-check in case a manual override was set while the image was decoding.
    const latestRaw = overrides[author.avatarName];
    const latestValid = latestRaw ? normalizeCssColor(latestRaw) : null;
    const finalColor = latestValid ?? smartHex;

    applyCssColor(author.uid, finalColor);
    return finalColor;
}

/**
 * Clears cached smart colors for a specific author UID.
 * @param {string} uid
 * @param {string} avatarName
 */
function clearSmartCacheForAuthor(uid, avatarName) {
    smartColorCache.delete(`${uid}|L`);
    smartColorCache.delete(`${uid}|D`);
    pendingColorTasks.delete(`${uid}|L`);
    pendingColorTasks.delete(`${uid}|D`);
    invalidateSwatchCache(avatarName);
}

/**
 * Tags a single `.mes` element with `data-sdc-uid` and triggers color resolution
 * if that UID isn't already styled. Uses a fast change signature to avoid redundant
 * work during token streaming.
 *
 * @param {HTMLElement} messageEl
 */
function tagMessage(messageEl) {
    const imgEl = /** @type {HTMLImageElement | null} */ (
        messageEl.querySelector(".mesAvatarWrapper > .avatar > img, .avatar > img")
    );
    const imgSrc = imgEl?.getAttribute("src") || "";
    const sig = `${messageEl.getAttribute("mesid") ?? ""}|${
        messageEl.getAttribute("is_user") ?? ""
    }|${messageEl.getAttribute("is_system") ?? ""}|${
        messageEl.getAttribute("ch_name") ?? ""
    }|${imgSrc}`;

    // Fast path during streaming: return in O(1) if nothing about author identity changed.
    if (/** @type {any} */ (messageEl)._sdcSig === sig) {
        const uid = messageEl.getAttribute("data-sdc-uid");
        if (uid) {
            if (!activeRules.has(uid)) {
                const author = resolveMessageAuthor(messageEl);
                if (author) ensureAuthorColor(author);
            }
            return;
        }
        if (/** @type {any} */ (messageEl)._sdcIsUncolored) {
            return;
        }
    }

    /** @type {any} */ (messageEl)._sdcSig = sig;

    const author = resolveMessageAuthor(messageEl);
    if (!author) {
        /** @type {any} */ (messageEl)._sdcIsUncolored = true;
        if (messageEl.hasAttribute("data-sdc-uid")) {
            messageEl.removeAttribute("data-sdc-uid");
        }
        return;
    }

    /** @type {any} */ (messageEl)._sdcIsUncolored = false;
    if (messageEl.getAttribute("data-sdc-uid") !== author.uid) {
        messageEl.setAttribute("data-sdc-uid", author.uid);
    }

    if (!activeRules.has(author.uid)) {
        ensureAuthorColor(author);
    }
}

/**
 * Tags a single message by its SillyTavern `mesid`.
 * @param {number | string | undefined} mesId
 */
function tagMessageById(mesId) {
    const chatEl = document.getElementById("chat");
    if (!chatEl) return;

    if (mesId !== undefined && mesId !== null && mesId !== "") {
        const el = chatEl.querySelector(`.mes[mesid="${CSS.escape(String(mesId))}"]`);
        if (el instanceof HTMLElement) {
            tagMessage(el);
            return;
        }
    }

    const lastMes = chatEl.querySelector(".mes:last-of-type");
    if (lastMes instanceof HTMLElement) {
        tagMessage(lastMes);
    }
}

/**
 * Tags all currently mounted `.mes` nodes in `#chat`.
 */
function tagVisibleMessages() {
    const chatEl = document.getElementById("chat");
    if (!chatEl) return;
    const messages = chatEl.querySelectorAll(".mes");
    for (let i = 0; i < messages.length; i++) {
        tagMessage(/** @type {HTMLElement} */ (messages[i]));
    }
}

/**
 * Pre-resolves colors for active chat participants & personas.
 */
function refreshActiveAuthors() {
    const tasks = [];

    if (isInGroupChat()) {
        for (const ch of getCurrentGroupCharacters()) {
            tasks.push(ensureAuthorColor(ch));
        }
    } else {
        const curr = getCurrentCharacter();
        if (curr) tasks.push(ensureAuthorColor(curr));
    }

    for (const persona of getAllPersonas()) {
        tasks.push(ensureAuthorColor(persona));
    }

    return Promise.all(tasks);
}

/**
 * Refreshes colors for all currently known UIDs (e.g. when theme light/dark flips).
 */
async function refreshAllStyledAuthors() {
    await refreshActiveAuthors();
    const chatEl = document.getElementById("chat");
    if (!chatEl) return;

    const seen = new Set();
    chatEl.querySelectorAll(".mes[data-sdc-uid]").forEach((el) => {
        const uid = el.getAttribute("data-sdc-uid");
        if (!uid || seen.has(uid)) return;
        seen.add(uid);
        const author = resolveMessageAuthor(/** @type {HTMLElement} */ (el));
        if (author) ensureAuthorColor(author);
    });
}

// =========================================================================
// Compact Dialogue Color Override UI (Character Editor & Persona Management)
// =========================================================================

/**
 * Creates the minimal inline Dialogue Color override control:
 * Text Input + Custom Picker Swatch + Eyedropper + Reset to Auto.
 *
 * @param {string} id
 * @param {() => ({ type: string, avatarName: string, uid: string, fallbackImgSrc?: string | null } | null)} getAuthor
 */
function createColorOverrideControl(id, getAuthor) {
    const wrapper = document.createElement("div");
    wrapper.id = id;
    wrapper.className = "sdc-color-override-container";

    const separator = document.createElement("div");
    separator.className = "sdc-separator";

    const labelRow = document.createElement("div");
    labelRow.className = "sdc-label-row";
    const label = document.createElement("label");
    label.className = "sdc-override-label";
    label.innerHTML = `
        <span>Dialogue Color</span>
        <i class="fa-solid fa-circle-info margin5 opacity50p"
           title="Override the auto-detected Avatar Smart color. Clear or click reset to restore auto-detection."></i>
    `;
    labelRow.appendChild(label);

    const controlRow = document.createElement("div");
    controlRow.className = "sdc-inline-color-row";

    const textInput = document.createElement("input");
    textInput.type = "text";
    textInput.className = "text_pole sdc-color-input";
    textInput.placeholder = "Auto (#RRGGBB / rgb())";
    textInput.title = "Any CSS color: #RRGGBB, #RGBA, rgb(), rgba(), hsl(), hsla(), oklch(), or named colors.";

    const swatchBtn = document.createElement("button");
    swatchBtn.type = "button";
    swatchBtn.className = "sdc-color-swatch-btn";
    swatchBtn.title = "Pick a dialogue color";

    const eyedropperBtn = document.createElement("button");
    eyedropperBtn.type = "button";
    eyedropperBtn.className = "menu_button menu_button_icon sdc-eyedropper-btn";
    eyedropperBtn.innerHTML = '<i class="fa-solid fa-eye-dropper"></i>';
    eyedropperBtn.title = isNativeEyeDropperSupported()
        ? "Pick a color from the screen or avatar"
        : "Pick a color from an avatar or anywhere on screen";

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "menu_button menu_button_icon sdc-reset-btn";
    resetBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i>';
    resetBtn.title = "Reset to auto-detect from avatar";
    resetBtn.style.display = "none";

    controlRow.append(textInput, swatchBtn, eyedropperBtn, resetBtn);
    wrapper.append(separator, labelRow, controlRow);

    /** Keeps track of async smart color sync token so stale promises don't overwrite newer UI state. */
    let syncToken = 0;

    /**
     * Refreshes the control UI from saved state (and shows the auto-detected color on the swatch).
     */
    async function syncUI() {
        const token = ++syncToken;
        const author = getAuthor();
        textInput.classList.remove("sdc-input-invalid");

        if (!author) {
            textInput.value = "";
            textInput.disabled = true;
            swatchBtn.disabled = true;
            eyedropperBtn.disabled = true;
            swatchBtn.style.backgroundColor = "";
            swatchBtn.classList.remove("is-override");
            resetBtn.style.display = "none";
            return;
        }

        textInput.disabled = false;
        swatchBtn.disabled = false;
        eyedropperBtn.disabled = false;

        const overrides = getOverridesMap(author.type);
        const saved = overrides[author.avatarName];
        const validSaved = saved ? normalizeCssColor(saved) : null;

        if (validSaved) {
            textInput.value = validSaved;
            swatchBtn.style.backgroundColor = validSaved;
            swatchBtn.classList.add("is-override");
            resetBtn.style.display = "flex";
            return;
        }

        textInput.value = "";
        swatchBtn.classList.remove("is-override");
        resetBtn.style.display = "none";

        const smartColor = await resolveSmartColor(author);
        if (token !== syncToken) return;
        swatchBtn.style.backgroundColor = smartColor;
    }

    /**
     * Live-updates CSS rule & UI without committing to settings yet (for fast picker dragging).
     * @param {{ type: string, avatarName: string, uid: string }} targetAuthor
     * @param {string} cssColor
     * @param {boolean} [updateTextInput=true]
     */
    function previewOverrideFor(targetAuthor, cssColor, updateTextInput = true) {
        if (!targetAuthor) return;
        applyCssColor(targetAuthor.uid, cssColor);

        // Only update control visuals if this control still points to `targetAuthor`.
        if (getAuthor()?.uid !== targetAuthor.uid) return;
        if (updateTextInput) {
            textInput.value = cssColor;
        }
        textInput.classList.remove("sdc-input-invalid");
        swatchBtn.style.backgroundColor = cssColor;
        swatchBtn.classList.add("is-override");
        resetBtn.style.display = "flex";
    }

    /**
     * Persists a manual override or clears it back to Avatar Smart auto-detect.
     * @param {{ type: string, avatarName: string, uid: string }} targetAuthor
     * @param {string | null} rawColor
     */
    async function commitOverrideFor(targetAuthor, rawColor) {
        if (!targetAuthor) return;

        const overrides = getOverridesMap(targetAuthor.type);
        const normalized = rawColor ? normalizeCssColor(rawColor) : null;

        if (normalized) {
            overrides[targetAuthor.avatarName] = normalized;
            applyCssColor(targetAuthor.uid, normalized);
        } else {
            delete overrides[targetAuthor.avatarName];
            await ensureAuthorColor(targetAuthor);
        }

        saveSettingsDebounced();
        if (getAuthor()?.uid === targetAuthor.uid) {
            syncUI();
        }
    }

    // Text field interactions
    textInput.addEventListener("input", () => {
        const author = getAuthor();
        if (!author) return;
        const raw = textInput.value.trim();
        if (!raw) {
            textInput.classList.remove("sdc-input-invalid");
            return;
        }
        const normalized = normalizeCssColor(raw);
        textInput.classList.toggle("sdc-input-invalid", !normalized);
        if (normalized) {
            // Do NOT overwrite `textInput.value` while user is actively typing.
            previewOverrideFor(author, normalized, false);
        }
    });

    textInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            textInput.blur();
        }
    });

    textInput.addEventListener("focusout", () => {
        const author = getAuthor();
        if (!author) return;
        const raw = textInput.value.trim();
        if (!raw) {
            commitOverrideFor(author, null);
            return;
        }
        const normalized = normalizeCssColor(raw);
        if (normalized) {
            commitOverrideFor(author, normalized);
        } else {
            syncUI();
        }
    });

    // Custom in-WebView color picker button
    swatchBtn.addEventListener("click", async () => {
        closeActiveEyedropper();
        const targetAuthor = getAuthor();
        if (!targetAuthor) return;

        const overrides = getOverridesMap(targetAuthor.type);
        const saved = overrides[targetAuthor.avatarName];
        const initial =
            (saved && normalizeCssColor(saved)) ||
            (await resolveSmartColor(targetAuthor));

        // Guard in case author changed or button detached while async smart color resolved
        if (!swatchBtn.isConnected || getAuthor()?.uid !== targetAuthor.uid) return;

        openColorPickerPopover({
            anchor: swatchBtn,
            initialColor: initial,
            onInput: (color) => previewOverrideFor(targetAuthor, color, true),
            onCommit: (color) => commitOverrideFor(targetAuthor, color),
        });
    });

    // Eyedropper
    eyedropperBtn.addEventListener("click", async () => {
        closeColorPickerPopover();
        const targetAuthor = getAuthor();
        if (!targetAuthor) return;

        eyedropperBtn.classList.add("sdc-eyedropper-btn-active");
        try {
            const hex = await pickColor({
                author: targetAuthor,
                triggerElement: eyedropperBtn,
            });
            if (hex) {
                await commitOverrideFor(targetAuthor, hex);
            }
        } finally {
            eyedropperBtn.classList.remove("sdc-eyedropper-btn-active");
        }
    });

    // Reset back to auto-detect
    resetBtn.addEventListener("click", () => {
        closeColorPickerPopover();
        closeActiveEyedropper();
        const author = getAuthor();
        if (!author) return;
        commitOverrideFor(author, null);
    });

    /** @type {any} */ (wrapper).__sdcSyncUI = syncUI;
    syncUI();

    return wrapper;
}

/**
 * Syncs an already-injected override UI element.
 * @param {string} elementId
 */
function syncOverrideControl(elementId) {
    const el = /** @type {any} */ (document.getElementById(elementId));
    if (el && typeof el.__sdcSyncUI === "function") {
        el.__sdcSyncUI();
    }
}

// =========================================================================
// Lifecycle, Observers & Initialization
// =========================================================================

jQuery(async () => {
    // Hot-reload cleanup
    if (window.__sdcDispose && typeof window.__sdcDispose === "function") {
        try {
            window.__sdcDispose();
        } catch (err) {
            console.warn(`[${EXT_NAME}] Previous dispose failed:`, err);
        }
    }

    /** @type {Array<() => void>} */
    const cleanupTasks = [];
    const onDispose = (fn) => cleanupTasks.push(fn);

    /** @param {string | undefined} eventType @param {Function} handler */
    const safeEventOn = (eventType, handler) => {
        if (!eventType) return;
        eventSource.on(eventType, handler);
        onDispose(() => {
            eventSource.removeListener?.(eventType, handler);
            eventSource.off?.(eventType, handler);
        });
    };

    /** @type {number[]} */
    const activeTimers = [];
    /** @type {MutationObserver[]} */
    const activeObservers = [];
    let charEditorObserverAttached = false;
    let personaObserverAttached = false;

    onDispose(() => {
        closeColorPickerPopover();
        closeActiveEyedropper();
        for (const t of activeTimers) clearTimeout(t);
        activeTimers.length = 0;
        for (const obs of activeObservers) obs.disconnect();
        activeObservers.length = 0;
    });

    // Cooperate with TauriTavern Android / mobile hardware back navigation
    const win = /** @type {any} */ (window);
    const prevBackHandler = win.__TAURITAVERN_HANDLE_BACK__;
    win.__TAURITAVERN_HANDLE_BACK__ = () => {
        if (isEyedropperActive()) {
            closeActiveEyedropper();
            return true;
        }
        if (isColorPickerOpen()) {
            closeColorPickerPopover();
            return true;
        }
        if (typeof prevBackHandler === "function") {
            return prevBackHandler();
        }
        return false;
    };
    onDispose(() => {
        if (prevBackHandler !== undefined) {
            win.__TAURITAVERN_HANDLE_BACK__ = prevBackHandler;
        } else {
            delete win.__TAURITAVERN_HANDLE_BACK__;
        }
    });

    initStyleSheet();
    onDispose(() => {
        colorStyleElement?.remove();
        colorStyleElement = null;
        activeRules.clear();
    });

    function ensureCharEditorObserver() {
        if (charEditorObserverAttached) return;
        const preview = document.getElementById("avatar_load_preview");
        const pole = document.getElementById("avatar_url_pole");
        const form = document.getElementById("form_create");
        if (!preview && !pole && !form) return;
        charEditorObserverAttached = true;

        const onCharEditorChange = () => {
            closeColorPickerPopover();
            syncOverrideControl("sdc-char_color_override");
        };

        if (preview) {
            const previewObs = new MutationObserver(onCharEditorChange);
            previewObs.observe(preview, { attributes: true, attributeFilter: ["src"] });
            activeObservers.push(previewObs);
        }
        if (pole) {
            const poleObs = new MutationObserver(onCharEditorChange);
            poleObs.observe(pole, { attributes: true, attributeFilter: ["value"] });
            activeObservers.push(poleObs);

            pole.addEventListener("change", onCharEditorChange);
            onDispose(() => pole.removeEventListener("change", onCharEditorChange));
        }
        if (form) {
            const formObs = new MutationObserver(() => {
                syncOverrideControl("sdc-char_color_override");
            });
            formObs.observe(form, { attributes: true, attributeFilter: ["style", "class"] });
            activeObservers.push(formObs);
        }
    }

    function ensurePersonaObserver() {
        if (personaObserverAttached) return;
        const panel =
            document.getElementById("PersonaManagement") ||
            document.getElementById("user_avatar_block");
        if (!panel) return;
        personaObserverAttached = true;

        let syncScheduled = false;
        const schedulePersonaSync = () => {
            if (syncScheduled) return;
            syncScheduled = true;
            requestAnimationFrame(() => {
                syncScheduled = false;
                tryInjectPersonaOverride();
                syncOverrideControl("sdc-persona_color_override");
                refreshActiveAuthors();
            });
        };

        const personaObs = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (
                    m.type === "attributes" &&
                    m.target instanceof HTMLElement &&
                    m.target.classList.contains("selected")
                ) {
                    schedulePersonaSync();
                    return;
                }
                if (m.type === "childList" && (m.addedNodes.length || m.removedNodes.length)) {
                    schedulePersonaSync();
                    return;
                }
            }
        });
        personaObs.observe(panel, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["class"],
        });
        activeObservers.push(personaObs);
    }

    function tryInjectCharacterOverride() {
        ensureCharEditorObserver();
        if (document.getElementById("sdc-char_color_override")) return true;
        const form = document.getElementById("form_create");
        if (!form) return false;
        const anchor = form.querySelector("#avatar-and-name-block");
        if (!anchor) return false;

        const control = createColorOverrideControl(
            "sdc-char_color_override",
            getCharacterBeingEdited
        );
        anchor.insertAdjacentElement("afterend", control);
        return true;
    }

    function tryInjectPersonaOverride() {
        ensurePersonaObserver();
        if (document.getElementById("sdc-persona_color_override")) return true;

        const personaDesc = document.getElementById("persona_description");
        if (personaDesc?.parentElement) {
            const control = createColorOverrideControl(
                "sdc-persona_color_override",
                getCurrentPersona
            );
            personaDesc.parentElement.insertAdjacentElement("afterbegin", control);
            return true;
        }

        const labels = Array.from(document.querySelectorAll("label"));
        const currentPersonaLabel = labels.find((l) =>
            (l.textContent ?? "").trim().toLowerCase().includes("current persona")
        );
        const row = currentPersonaLabel?.closest("div") ?? currentPersonaLabel?.parentElement;
        if (!row) return false;

        const control = createColorOverrideControl(
            "sdc-persona_color_override",
            getCurrentPersona
        );
        row.insertAdjacentElement("beforebegin", control);
        return true;
    }

    function tryInjectAllOverrideUIs() {
        const charOk = tryInjectCharacterOverride();
        const personaOk = tryInjectPersonaOverride();
        return charOk && personaOk;
    }

    function checkThemeChange() {
        const isLight = detectLightTheme();
        if (isLight !== cachedIsLightTheme) {
            cachedIsLightTheme = isLight;
            refreshAllStyledAuthors();
            syncOverrideControl("sdc-char_color_override");
            syncOverrideControl("sdc-persona_color_override");
        }
    }

    // Register SillyTavern events IMMEDIATELY before awaiting host readiness
    // so deferred TauriTavern loads never miss early CHAT_CHANGED / APP_READY events.
    safeEventOn(event_types.CHAT_CHANGED, () => {
        closeColorPickerPopover();
        closeActiveEyedropper();
        refreshActiveAuthors();
        tagVisibleMessages();
        syncOverrideControl("sdc-char_color_override");
    });

    safeEventOn(event_types.APP_READY, () => {
        tryInjectAllOverrideUIs();
        checkThemeChange();
        refreshActiveAuthors();
        tagVisibleMessages();
        syncOverrideControl("sdc-char_color_override");
        syncOverrideControl("sdc-persona_color_override");
    });

    safeEventOn(event_types.EXTENSIONS_FIRST_LOAD, () => {
        tryInjectAllOverrideUIs();
        refreshActiveAuthors();
        tagVisibleMessages();
    });

    safeEventOn(event_types.GENERATION_STARTED, () => tagMessageById(undefined));
    safeEventOn(event_types.STREAM_TOKEN_RECEIVED, () => tagMessageById(undefined));
    safeEventOn(event_types.GENERATION_ENDED, () => tagMessageById(undefined));
    safeEventOn(event_types.GENERATION_STOPPED, () => tagMessageById(undefined));

    safeEventOn(event_types.USER_MESSAGE_RENDERED, (mesId) => tagMessageById(mesId));
    safeEventOn(event_types.CHARACTER_MESSAGE_RENDERED, (mesId) => tagMessageById(mesId));
    safeEventOn(event_types.MESSAGE_RECEIVED, (mesId) => tagMessageById(mesId));
    safeEventOn(event_types.MESSAGE_SENT, (mesId) => tagMessageById(mesId));
    safeEventOn(event_types.MESSAGE_UPDATED, (mesId) => tagMessageById(mesId));
    safeEventOn(event_types.MESSAGE_EDITED, (mesId) => tagMessageById(mesId));
    safeEventOn(event_types.MESSAGE_SWIPED, (mesId) => tagMessageById(mesId));
    safeEventOn(event_types.MORE_MESSAGES_LOADED, () => tagVisibleMessages());
    safeEventOn(event_types.GROUP_UPDATED, () => refreshActiveAuthors());
    safeEventOn(event_types.SETTINGS_UPDATED, () => checkThemeChange());
    safeEventOn(event_types.CHARACTER_PAGE_LOADED, () => {
        tryInjectCharacterOverride();
        syncOverrideControl("sdc-char_color_override");
    });

    safeEventOn(event_types.PERSONA_CHANGED, () => {
        closeColorPickerPopover();
        closeActiveEyedropper();
        refreshActiveAuthors();
        tagVisibleMessages();
        syncOverrideControl("sdc-persona_color_override");
    });

    safeEventOn(event_types.CHARACTER_EDITED, () => {
        const edited = getCharacterBeingEdited();
        if (edited) {
            clearSmartCacheForAuthor(edited.uid, edited.avatarName);
            ensureAuthorColor(edited, { cacheBust: true });
        }
        syncOverrideControl("sdc-char_color_override");
    });

    // Wait briefly for TauriTavern host readiness if running inside TauriTavern.
    const hostReady = win.__TAURITAVERN__?.ready ?? win.__TAURITAVERN_MAIN_READY__;
    if (hostReady && typeof hostReady.then === "function") {
        try {
            await Promise.race([
                hostReady,
                new Promise((r) => setTimeout(r, 3000)),
            ]);
        } catch (_) {
            /* proceed even if host ready promise rejects */
        }
    }

    cachedIsLightTheme = detectLightTheme();

    // Attach to DOM elements that might appear slightly later during boot
    function attachWithRetry(finder, onFound, intervalMs = 200, maxAttempts = 150) {
        let attempts = 0;
        const step = () => {
            const target = finder();
            if (target) {
                onFound(target);
                return;
            }
            if (++attempts < maxAttempts) {
                activeTimers.push(window.setTimeout(step, intervalMs));
            }
        };
        step();
    }

    // 1. Observe #chat cleanly:
    //    - Subtree childList observer catches newly mounted `.mes` (including inside
    //      TauriTavern virtualizer wrapper divs) while skipping mutations inside `.mes`
    //      itself (zero overhead during token streaming).
    //    - Attribute observer catches virtualizer recycled nodes, swipe speaker changes,
    //      or late-loading avatar `src` attributes.
    attachWithRetry(
        () => document.getElementById("chat"),
        (chatEl) => {
            const childObserver = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (
                        m.target !== chatEl &&
                        m.target instanceof HTMLElement &&
                        m.target.closest(".mes")
                    ) {
                        continue;
                    }
                    for (const node of m.addedNodes) {
                        if (!(node instanceof HTMLElement)) continue;
                        if (node.classList.contains("mes")) {
                            tagMessage(node);
                        } else if (node.firstElementChild) {
                            const nested = node.querySelectorAll(".mes");
                            for (let i = 0; i < nested.length; i++) {
                                tagMessage(/** @type {HTMLElement} */ (nested[i]));
                            }
                        }
                    }
                }
            });
            childObserver.observe(chatEl, { childList: true, subtree: true });
            activeObservers.push(childObserver);

            const attrObserver = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    const target = m.target;
                    if (!(target instanceof HTMLElement)) continue;
                    if (m.attributeName === "src") {
                        if (target.matches(".mesAvatarWrapper img, .avatar img")) {
                            const mesEl = target.closest(".mes");
                            if (mesEl instanceof HTMLElement) {
                                tagMessage(mesEl);
                            }
                        }
                    } else if (target.classList.contains("mes")) {
                        tagMessage(target);
                    }
                }
            });
            attrObserver.observe(chatEl, {
                subtree: true,
                attributes: true,
                attributeFilter: ["mesid", "ch_name", "is_user", "is_system", "src"],
            });
            activeObservers.push(attrObserver);

            tagVisibleMessages();
        }
    );

    // 2. Observe Character Card Editor & Persona Management
    attachWithRetry(
        () =>
            document.getElementById("avatar_load_preview") ||
            document.getElementById("avatar_url_pole"),
        () => {
            tryInjectCharacterOverride();
            syncOverrideControl("sdc-char_color_override");
        }
    );

    attachWithRetry(
        () =>
            document.getElementById("PersonaManagement") ||
            document.getElementById("user_avatar_block"),
        () => {
            tryInjectPersonaOverride();
            syncOverrideControl("sdc-persona_color_override");
        }
    );

    // 3. Observe theme changes (light vs dark)
    const themeObs = new MutationObserver(() => checkThemeChange());
    themeObs.observe(document.body, {
        attributes: true,
        attributeFilter: ["class", "style"],
    });
    themeObs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
    });
    activeObservers.push(themeObs);

    if (typeof win.__TAURITAVERN__?.api?.layout?.subscribe === "function") {
        try {
            const unsubLayout = win.__TAURITAVERN__.api.layout.subscribe(() => {
                checkThemeChange();
            });
            if (typeof unsubLayout === "function") {
                onDispose(unsubLayout);
            }
        } catch (_) {
            /* noop */
        }
    }

    // 4. Lazy UI injection & character switch fallback (covers jQuery `.val()` updates
    //    and drawers opened minutes or hours after startup)
    const onDrawerOrSelectionClick = (e) => {
        const target = /** @type {HTMLElement | null} */ (e.target);
        if (!target) return;
        if (
            target.closest(
                ".drawer-toggle, .drawer-icon, #rightNavDrawerIcon, #persona-management-button, #rm_button_characters, #rm_button_selected_ch, .character_select, .group_member, [chid], #user_avatar_block .avatar"
            )
        ) {
            requestAnimationFrame(() => {
                tryInjectAllOverrideUIs();
                syncOverrideControl("sdc-char_color_override");
                syncOverrideControl("sdc-persona_color_override");
            });
            activeTimers.push(
                window.setTimeout(() => {
                    tryInjectAllOverrideUIs();
                    syncOverrideControl("sdc-char_color_override");
                    syncOverrideControl("sdc-persona_color_override");
                }, 100)
            );
        }
    };
    document.addEventListener("click", onDrawerOrSelectionClick, true);
    onDispose(() => document.removeEventListener("click", onDrawerOrSelectionClick, true));

    // Immediate startup sync (crucial for TauriTavern deferred extension loading
    // when APP_READY / CHAT_CHANGED may have already fired before init)
    tryInjectAllOverrideUIs();
    await refreshActiveAuthors();
    tagVisibleMessages();

    window.__sdcDispose = () => {
        for (const fn of cleanupTasks) {
            try {
                fn();
            } catch (_) {
                /* noop */
            }
        }
        document.getElementById("sdc-char_color_override")?.remove();
        document.getElementById("sdc-persona_color_override")?.remove();
        delete window.__sdcDispose;
    };
});