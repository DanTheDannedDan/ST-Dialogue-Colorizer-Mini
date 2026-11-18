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
    rgbToHex,
} from "./color-utils.js";
import {
    closeColorPickerPopover,
    openColorPickerPopover,
} from "./color-picker.js";
import { pickColor, isNativeEyeDropperSupported } from "./eyedropper.js";
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
 * Detects whether the active SillyTavern theme has a light background.
 * Cached and updated only when body theme attributes change.
 */
function detectLightTheme() {
    const match = window.getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    if (!match || match.length < 3) return false;
    const luminance =
        (0.299 * parseInt(match[0], 10) +
            0.587 * parseInt(match[1], 10) +
            0.114 * parseInt(match[2], 10)) /
        255;
    return luminance > 0.5;
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
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function initStyleSheet() {
    document.getElementById("sdc-colors-style")?.remove();
    colorStyleElement = document.createElement("style");
    colorStyleElement.id = "sdc-colors-style";
    document.head.appendChild(colorStyleElement);
}

/**
 * Immediately inserts or updates the CSS variable `--sdc-color` for a single UID.
 * Zero full-stylesheet rebuilds and zero animations.
 *
 * @param {string} uid
 * @param {string} cssColor
 */
function applyCssColor(uid, cssColor) {
    const sheet = colorStyleElement?.sheet;
    if (!sheet || !cssColor) return;

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

    sheet.insertRule(
        `.mes[data-sdc-uid="${esc}"] .mes_text q, .mes[data-sdc-uid="${esc}"] .ch_name .name_text, .mes[data-sdc-uid="${esc}"] .name_text { color: var(--sdc-color); }`,
        sheet.cssRules.length
    );

    activeRules.set(uid, { varRule, color: cssColor });
}

/**
 * Loads an avatar Image from candidate URLs in order until one decodes.
 * @param {string} type
 * @param {string} avatarName
 * @param {string | null} [fallbackImgSrc]
 * @returns {Promise<HTMLImageElement | null>}
 */
async function loadAvatarImage(type, avatarName, fallbackImgSrc = null) {
    const candidates = getAvatarCandidateUrls(type, avatarName, fallbackImgSrc);
    for (const url of candidates) {
        const loaded = await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img.naturalWidth > 0 ? img : null);
            img.onerror = () => resolve(null);
            img.src = url;
        });
        if (loaded) return /** @type {HTMLImageElement} */ (loaded);
    }
    return null;
}

/**
 * Resolves the Avatar Smart color for an author (ignoring manual override), using cache.
 * @param {{ type: string, avatarName: string, uid: string, fallbackImgSrc?: string | null }} author
 * @returns {Promise<string>}
 */
async function resolveSmartColor(author) {
    const isLight = cachedIsLightTheme;
    const cacheKey = `${author.uid}|${isLight ? "L" : "D"}`;

    const cached = smartColorCache.get(cacheKey);
    if (cached) return cached;

    const inflight = pendingColorTasks.get(cacheKey);
    if (inflight) return inflight;

    const task = (async () => {
        try {
            const img = await loadAvatarImage(
                author.type,
                author.avatarName,
                author.fallbackImgSrc ?? null
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
 */
async function ensureAuthorColor(author) {
    const overrides = getOverridesMap(author.type);
    const rawOverride = overrides[author.avatarName];
    const validOverride = rawOverride ? normalizeCssColor(rawOverride) : null;

    if (validOverride) {
        applyCssColor(author.uid, validOverride);
        return validOverride;
    }

    const smartHex = await resolveSmartColor(author);

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
        if (uid && !activeRules.has(uid)) {
            const author = resolveMessageAuthor(messageEl);
            if (author) ensureAuthorColor(author);
        }
        return;
    }

    /** @type {any} */ (messageEl)._sdcSig = sig;

    const author = resolveMessageAuthor(messageEl);
    if (!author) {
        if (messageEl.hasAttribute("data-sdc-uid")) {
            messageEl.removeAttribute("data-sdc-uid");
        }
        return;
    }

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
 * @param {() => ({ type: string, avatarName: string, uid: string } | null)} getAuthor
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
    textInput.title = "Any CSS color: #RRGGBB, #RGBA, rgb(), rgba(), hsl(), hsla(), or named colors.";

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
        : "Pick a color by clicking on an avatar";

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
     * @param {string} cssColor
     */
    function previewOverride(cssColor) {
        const author = getAuthor();
        if (!author) return;
        textInput.value = cssColor;
        textInput.classList.remove("sdc-input-invalid");
        swatchBtn.style.backgroundColor = cssColor;
        swatchBtn.classList.add("is-override");
        resetBtn.style.display = "flex";
        applyCssColor(author.uid, cssColor);
    }

    /**
     * Persists a manual override or clears it back to Avatar Smart auto-detect.
     * @param {string | null} rawColor
     */
    async function commitOverride(rawColor) {
        const author = getAuthor();
        if (!author) return;

        const overrides = getOverridesMap(author.type);
        const normalized = rawColor ? normalizeCssColor(rawColor) : null;

        if (normalized) {
            overrides[author.avatarName] = normalized;
            applyCssColor(author.uid, normalized);
        } else {
            delete overrides[author.avatarName];
            await ensureAuthorColor(author);
        }

        saveSettingsDebounced();
        syncUI();
    }

    // Text field interactions
    textInput.addEventListener("input", () => {
        const raw = textInput.value.trim();
        if (!raw) {
            textInput.classList.remove("sdc-input-invalid");
            return;
        }
        const normalized = normalizeCssColor(raw);
        textInput.classList.toggle("sdc-input-invalid", !normalized);
        if (normalized) {
            previewOverride(normalized);
        }
    });

    textInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            textInput.blur();
        }
    });

    textInput.addEventListener("focusout", () => {
        const raw = textInput.value.trim();
        if (!raw) {
            commitOverride(null);
            return;
        }
        const normalized = normalizeCssColor(raw);
        if (normalized) {
            commitOverride(normalized);
        } else {
            syncUI();
        }
    });

    // Custom in-WebView color picker button
    swatchBtn.addEventListener("click", async () => {
        const author = getAuthor();
        if (!author) return;

        const overrides = getOverridesMap(author.type);
        const saved = overrides[author.avatarName];
        const initial =
            (saved && normalizeCssColor(saved)) ||
            (await resolveSmartColor(author));

        openColorPickerPopover({
            anchor: swatchBtn,
            initialColor: initial,
            onInput: (color) => previewOverride(color),
            onCommit: (color) => commitOverride(color),
        });
    });

    // Eyedropper
    eyedropperBtn.addEventListener("click", async () => {
        closeColorPickerPopover();
        eyedropperBtn.classList.add("sdc-eyedropper-btn-active");
        try {
            const hex = await pickColor();
            if (hex) {
                await commitOverride(hex);
            }
        } finally {
            eyedropperBtn.classList.remove("sdc-eyedropper-btn-active");
        }
    });

    // Reset back to auto-detect
    resetBtn.addEventListener("click", () => {
        closeColorPickerPopover();
        commitOverride(null);
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

function tryInjectCharacterOverride() {
    if (document.getElementById("sdc-char_color_override")) return true;
    const form = document.getElementById("form_create");
    if (!form) return false;
    const anchor = form.querySelector("#avatar-and-name-block");
    if (!anchor) return false;

    const control = createColorOverrideControl("sdc-char_color_override", getCharacterBeingEdited);
    anchor.insertAdjacentElement("afterend", control);
    return true;
}

function tryInjectPersonaOverride() {
    if (document.getElementById("sdc-persona_color_override")) return true;

    const personaDesc = document.getElementById("persona_description");
    if (personaDesc?.parentElement) {
        const control = createColorOverrideControl("sdc-persona_color_override", getCurrentPersona);
        personaDesc.parentElement.insertAdjacentElement("afterbegin", control);
        return true;
    }

    const labels = Array.from(document.querySelectorAll("label"));
    const currentPersonaLabel = labels.find((l) =>
        (l.textContent ?? "").trim().toLowerCase().includes("current persona")
    );
    const row = currentPersonaLabel?.closest("div") ?? currentPersonaLabel?.parentElement;
    if (!row) return false;

    const control = createColorOverrideControl("sdc-persona_color_override", getCurrentPersona);
    row.insertAdjacentElement("beforebegin", control);
    return true;
}

function tryInjectAllOverrideUIs() {
    const charOk = tryInjectCharacterOverride();
    const personaOk = tryInjectPersonaOverride();
    return charOk && personaOk;
}

// =========================================================================
// Lifecycle, Observers & Initialization
// =========================================================================

jQuery(async ($) => {
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

    onDispose(() => {
        closeColorPickerPopover();
        for (const t of activeTimers) clearTimeout(t);
        activeTimers.length = 0;
        for (const obs of activeObservers) obs.disconnect();
        activeObservers.length = 0;
    });

    // Wait briefly for TauriTavern host readiness if running inside TauriTavern.
    const hostReady = /** @type {any} */ (window).__TAURITAVERN__?.ready
        ?? /** @type {any} */ (window).__TAURITAVERN_MAIN_READY__;
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
    initStyleSheet();
    onDispose(() => {
        colorStyleElement?.remove();
        colorStyleElement = null;
        activeRules.clear();
    });

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
    //    - Shallow childList observer catches newly appended/prepended/virtual-mounted `.mes`
    //    - Attribute-only subtree observer catches virtualizer recycled nodes or swipe speaker changes
    //      (NEVER observes characterData or childList inside .mes_text, so zero overhead during streaming)
    attachWithRetry(
        () => document.getElementById("chat"),
        (chatEl) => {
            const childObserver = new MutationObserver((mutations) => {
                for (const m of mutations) {
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
            childObserver.observe(chatEl, { childList: true });
            activeObservers.push(childObserver);

            const attrObserver = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.target instanceof HTMLElement && m.target.classList.contains("mes")) {
                        tagMessage(m.target);
                    }
                }
            });
            attrObserver.observe(chatEl, {
                subtree: true,
                attributes: true,
                attributeFilter: ["mesid", "ch_name", "is_user"],
            });
            activeObservers.push(attrObserver);

            tagVisibleMessages();
        }
    );

    // 2. Observe Character Card Editor selection (`#avatar_url_pole`)
    attachWithRetry(
        () => document.getElementById("avatar_url_pole"),
        (pole) => {
            const poleObs = new MutationObserver(() => {
                closeColorPickerPopover();
                syncOverrideControl("sdc-char_color_override");
            });
            poleObs.observe(pole, { attributes: true, attributeFilter: ["value"] });
            activeObservers.push(poleObs);

            const onPoleChange = () => syncOverrideControl("sdc-char_color_override");
            pole.addEventListener("change", onPoleChange);
            onDispose(() => pole.removeEventListener("change", onPoleChange));

            tryInjectCharacterOverride();
            syncOverrideControl("sdc-char_color_override");
        }
    );

    // 3. Observe Persona Management changes (`#user_avatar_block` / `#PersonaManagement`)
    attachWithRetry(
        () => document.getElementById("PersonaManagement") || document.getElementById("user_avatar_block"),
        (panel) => {
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

            tryInjectPersonaOverride();
            syncOverrideControl("sdc-persona_color_override");
        }
    );

    // 4. Observe theme changes (light vs dark)
    const themeObs = new MutationObserver(() => {
        const isLight = detectLightTheme();
        if (isLight !== cachedIsLightTheme) {
            cachedIsLightTheme = isLight;
            refreshAllStyledAuthors();
            syncOverrideControl("sdc-char_color_override");
            syncOverrideControl("sdc-persona_color_override");
        }
    });
    themeObs.observe(document.body, {
        attributes: true,
        attributeFilter: ["class", "style"],
    });
    activeObservers.push(themeObs);

    // 5. Lazy UI injection fallback for drawers/tabs opened minutes/hours later
    const onDrawerInteraction = (e) => {
        const target = /** @type {HTMLElement | null} */ (e.target);
        if (!target) return;
        if (
            target.closest(
                ".drawer-toggle, .drawer-icon, #rightNavDrawerIcon, #persona-management-button, #rm_button_characters, .character_select"
            )
        ) {
            setTimeout(() => {
                tryInjectAllOverrideUIs();
                syncOverrideControl("sdc-char_color_override");
                syncOverrideControl("sdc-persona_color_override");
            }, 80);
        }
    };
    document.addEventListener("click", onDrawerInteraction, true);
    onDispose(() => document.removeEventListener("click", onDrawerInteraction, true));

    // 6. SillyTavern events (covers streaming, non-streaming, swipes, edits, chat switches)
    safeEventOn(event_types.CHAT_CHANGED, () => {
        closeColorPickerPopover();
        refreshActiveAuthors();
        tagVisibleMessages();
        syncOverrideControl("sdc-char_color_override");
    });

    safeEventOn(event_types.APP_READY, () => {
        tryInjectAllOverrideUIs();
        refreshActiveAuthors();
        tagVisibleMessages();
        syncOverrideControl("sdc-char_color_override");
        syncOverrideControl("sdc-persona_color_override");
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

    safeEventOn(event_types.PERSONA_CHANGED, () => {
        closeColorPickerPopover();
        refreshActiveAuthors();
        syncOverrideControl("sdc-persona_color_override");
    });

    safeEventOn(event_types.CHARACTER_EDITED, () => {
        const edited = getCharacterBeingEdited();
        if (edited) {
            clearSmartCacheForAuthor(edited.uid, edited.avatarName);
            ensureAuthorColor(edited);
        }
        syncOverrideControl("sdc-char_color_override");
    });

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