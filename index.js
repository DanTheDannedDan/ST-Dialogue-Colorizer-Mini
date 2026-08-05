//#region ST imports

import {
  eventSource,
  event_types,
  saveSettingsDebounced,
} from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";

//#endregion ST imports

//#region Local imports

import { ColorizeSourceType } from "./constants.js";
import { ExColor } from "./ExColor.js";
import { CharacterType, STCharacter } from "./STCharacter.js";
import { getSmartAvatarColor } from "./color-utils.js";
import {
  createColorSourceDropdown,
  createColorTextPickerCombo,
  createCheckboxWithLabel,
} from "./element-creators.js";
import { initializeSettings } from "./settings-utils.js";
import {
  disposeStObservers,
  expEventSource,
  exp_event_type,
  getAllPersonas,
  getCharacterBeingEdited,
  getCurrentCharacter,
  getCurrentGroupCharacters,
  getCurrentPersona,
  getMessageAuthor,
  isInAnyChat,
  isInCharacterChat,
  isInGroupChat,
} from "./st-utils.js";
import { setInputColorPickerComboValue } from "./utils.js";
import { pickColor, isNativeEyeDropperSupported } from "./eyedropper.js";

//#endregion Local imports

const DEFAULT_STATIC_DIALOGUE_COLOR_HEX = "#e18a24";
/** @type {[number, number, number]} */
const DEFAULT_STATIC_DIALOGUE_COLOR_RGB = [225, 138, 36];

// Re-export for backwards compatibility (older imports referenced this from index.js).
export { ColorizeSourceType };

/**
 * @typedef {ReturnType<typeof createDefaultExtSettings>} PaletteTalkSettings
 */
/**
 * Builds a fresh per-character colour settings object.
 *
 * This is a factory rather than a shared constant on purpose: the character and
 * persona sections must never reference the same object, or editing one would
 * mutate the other.
 */
const createDefaultCharColorSettings = () => ({
  colorizeSource: ColorizeSourceType.AVATAR_SMART,
  staticColor: DEFAULT_STATIC_DIALOGUE_COLOR_HEX,
  colorOverrides: {},
  colorNameText: false,
  boostVibrancy: false,
  autoContrast: false,
});

const createDefaultExtSettings = () => ({
  charColorSettings: createDefaultCharColorSettings(),
  personaColorSettings: createDefaultCharColorSettings(),
  // Maps a displayed character NAME (lowercased) -> colour string. Used for
  // "Send As" NPCs whose messages can't be resolved to a real character/avatar.
  nameColorOverrides: {},
  // Colour NPC display names in addition to their dialogue.
  nameColorNames: false,
});

const extName = "SillyTavern-Palette-Talk";
// Derive the on-disk folder path from this module's own URL instead of
// hard-coding the folder name. This keeps the extension working even if the
// user cloned/installed it under a different directory name.
const extFolderPath = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const extSettings = initializeSettings(extName, createDefaultExtSettings);

function debounce(fn, delay = 100) {
  /** @type {number?} */
  let timeoutId = null;
  return function debounced(...args) {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }

    timeoutId = window.setTimeout(() => {
      fn.apply(this, args);
    }, delay);
  };
}

/** @type {HTMLStyleElement} */
let charactersStyleSheet;
/** @type {HTMLStyleElement} */
let personasStyleSheet;
/** @type {HTMLStyleElement} */
let namesStyleSheet;
/** @type {HTMLStyleElement} Transient live-preview rules; never persisted. */
let previewStyleSheet;

/**
 * Builds the CSS for one character/persona.
 *
 * The result is split in two because the pieces need different cascade
 * treatment:
 *
 * - `vars` only declares `--character-color`. Nothing outside this extension
 *   sets that property, so these rules compete only with each other and are
 *   placed in cascade layers to give avatar-vs-name a deterministic winner.
 * - `rules` actually paints `.name_text`, which *does* compete with
 *   SillyTavern's own styles. Unlayered declarations always beat layered ones,
 *   so these must stay outside any layer. They're order-independent anyway:
 *   every variant resolves the same `--character-color`.
 *
 * @param {STCharacter} stChar
 * @returns {Promise<{vars: string, rules: string}>}
 */
async function getCharStyleString(stChar) {
  const dialogueColor = await getCharacterDialogueColor(stChar);
  const colorSettings = getSettingsForChar(stChar);

  if (!dialogueColor) return { vars: "", rules: "" };

  const vars = `
            .mes[sdc-author_uid="${stChar.uid}"] {
                --character-color: ${dialogueColor.toCssString()};
            }
        `;

  // Apply color to character name if enabled
  const rules = colorSettings.colorNameText
    ? `
            .mes[sdc-author_uid="${stChar.uid}"] .name_text {
                color: var(--character-color);
            }
        `
    : "";

  return { vars, rules };
}

/**
 *
 * @param {STCharacter[]=} characterList
 */
async function updateCharactersStyleSheet(characterList) {
  if (!characterList) {
    if (!isInAnyChat()) {
      charactersStyleSheet.innerHTML = "";
      return;
    }
    if (isInGroupChat()) {
      characterList = getCurrentGroupCharacters();
    } else if (isInCharacterChat()) {
      characterList = [getCurrentCharacter()];
    }
  }

  // Filter out any nulls (e.g. a character/group member that couldn't be
  // resolved) so we never call getCharStyleString on undefined.
  characterList = (characterList ?? []).filter(Boolean);
  if (characterList.length === 0) {
    charactersStyleSheet.innerHTML = "";
    return;
  }

  const parts = await Promise.all(
    characterList.map(async (char) => await getCharStyleString(char))
  );
  charactersStyleSheet.innerHTML = composeAvatarCss(parts);
}

/**
 * Joins per-character CSS fragments, layering only the variable declarations.
 *
 * @param {{vars: string, rules: string}[]} parts
 * @returns {string}
 */
function composeAvatarCss(parts) {
  const vars = parts.map((p) => p.vars).join("");
  const rules = parts.map((p) => p.rules).join("");

  let css = "";
  if (vars.trim()) css += `@layer sdc-avatars {${vars}\n}`;
  // Unlayered on purpose — see getCharStyleString.
  if (rules.trim()) css += rules;
  return css;
}

// Handled differently from the chars style sheet so we don't have to do any dirty/complex tricks when a chat has messages
// from a persona the user isn't currently using (otherwise the message color would revert to the default).
/**
 *
 * @param {STCharacter[]=} personaList
 */
async function updatePersonasStyleSheet(personaList) {
  personaList = (personaList ?? getAllPersonas()).filter(Boolean);
  if (personaList.length === 0) {
    personasStyleSheet.innerHTML = "";
    return;
  }

  const parts = await Promise.all(
    personaList.map(async (persona) => await getCharStyleString(persona))
  );
  personasStyleSheet.innerHTML = composeAvatarCss(parts);
}

/**
 *
 * @param {STCharacter | CharacterType} charType
 */
function getSettingsForChar(charType) {
  if (charType instanceof STCharacter) {
    charType = charType.type;
  }

  switch (charType) {
    case CharacterType.CHARACTER:
      return extSettings.charColorSettings;
    case CharacterType.PERSONA:
      return extSettings.personaColorSettings;
    default:
      console.warn(
        `Character type '${charType}' has no settings key, using defaults.`
      );
      return createDefaultCharColorSettings();
  }
}

/**
 * Determines if the current application theme is light or dark.
 * Checks the computed background color of the body.
 * @returns {boolean} True if light theme, false if dark theme.
 */
function isLightTheme() {
  const rgb = window
    .getComputedStyle(document.body)
    .backgroundColor.match(/\d+/g);
  if (!rgb) return false; // Default to dark if can't determine

  // Calculate relative luminance
  const luminance =
    (0.299 * parseInt(rgb[0]) +
      0.587 * parseInt(rgb[1]) +
      0.114 * parseInt(rgb[2])) /
    255;
  return luminance > 0.5;
}

/**
 * Improves color contrast for better readability on dark or light backgrounds.
 * Ensures adequate saturation and luminance while preserving hue.
 * Optionally boosts vibrancy.
 *
 * @param {import("./ExColor.js").ColorArray} rgb
 * @param {boolean} boostVibrancy - Whether to apply 20% saturation boost
 * @param {boolean} isLight - Whether the current theme is light
 * @returns {import("./ExColor.js").ColorArray}
 */
function makeBetterContrast(rgb, boostVibrancy = false, isLight = false) {
  const [h, s, l, a] = ExColor.rgb2hsl(rgb);

  let nHue = h;
  let nSat = s;
  let nLum = l;

  // Ensure minimum saturation for vibrancy
  if (nSat < 0.4) {
    nSat = Math.min(nSat + 0.3, 0.8);
  }

  if (isLight) {
    // Light Theme Logic: Darken colors that are too bright
    if (nLum > 0.6) {
      nLum = 0.45; // Darken bright colors
    } else if (nLum > 0.4) {
      nLum = 0.4; // Slight darken for mid-range
    }
    // Ensure it's not TOO dark though, or it looks like black text
    if (nLum < 0.2) {
      nLum = 0.25;
    }
  } else {
    // Dark Theme Logic (Default)
    // Ensure luminance is in readable range (not too dark, not too bright)
    if (nLum < 0.5) {
      nLum = 0.65; // Brighten dark colors
    } else if (nLum < 0.7) {
      nLum = 0.7; // Slight boost for mid-range
    } else if (nLum > 0.85) {
      nLum = 0.8; // Tone down very bright colors
    }
  }

  // Apply optional vibrancy boost (35% saturation increase)
  if (boostVibrancy) {
    nSat = Math.max(0, Math.min(1, nSat + 0.35));
  }

  return ExColor.hsl2rgb([nHue, nSat, nLum, a]);
}

/** WCAG 2.x AA threshold for normal-sized body text. */
const WCAG_AA_NORMAL_TEXT = 4.5;

/**
 * Reads the effective background colour behind chat messages.
 *
 * Message blocks are frequently transparent over a blurred backdrop, so this
 * walks up the ancestor chain until it finds a non-transparent background,
 * falling back to the document body.
 *
 * @returns {ExColor} The resolved background colour.
 */
function getChatBackgroundColor() {
  const probeTargets = [
    document.querySelector("#chat .mes .mes_block"),
    document.querySelector("#chat .mes"),
    document.getElementById("chat"),
    document.body,
  ].filter(Boolean);

  for (const start of probeTargets) {
    let node = /** @type {Element?} */ (start);
    while (node && node !== document.documentElement) {
      const bg = window.getComputedStyle(node).backgroundColor;
      const parsed = ExColor.parse(bg);
      // Skip fully transparent layers — they don't determine what the reader sees.
      if (parsed && (parsed.toRgb().a ?? 255) > 8) {
        return parsed;
      }
      node = node.parentElement;
    }
  }

  return ExColor.fromRgb(isLightTheme() ? [255, 255, 255, 255] : [0, 0, 0, 255]);
}

/**
 * Nudges a colour's lightness until it meets the WCAG AA contrast ratio against
 * the given background, preserving hue and saturation.
 *
 * Direction is chosen by the background's luminance: colours are lightened on
 * dark backgrounds and darkened on light ones. If the target ratio can't be
 * reached even at the extreme, the best attempt found is returned.
 *
 * @param {ExColor} color The colour to adjust.
 * @param {ExColor} background The background it will be rendered on.
 * @param {number} [targetRatio] Desired minimum contrast ratio.
 * @returns {ExColor} The adjusted colour (or the original if already compliant).
 */
function enforceContrast(color, background, targetRatio = WCAG_AA_NORMAL_TEXT) {
  if (ExColor.contrastRatio(color, background) >= targetRatio) {
    return color;
  }

  const { h, s, a } = color.toHsl();
  const backgroundIsLight = background.getLuminance() > 0.18;
  const step = backgroundIsLight ? -0.02 : 0.02;

  let best = color;
  let bestRatio = ExColor.contrastRatio(color, background);
  let lum = color.toHsl().l;

  // 50 steps at 0.02 covers the full 0..1 lightness range from either end.
  for (let i = 0; i < 50; i++) {
    lum += step;
    if (lum < 0 || lum > 1) break;

    const candidate = ExColor.fromHsl([h, s, lum, a]);
    const ratio = ExColor.contrastRatio(candidate, background);

    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = candidate;
    }
    if (ratio >= targetRatio) {
      return candidate;
    }
  }

  return best;
}

/**
 * Applies the auto-contrast pass when the given settings enable it.
 *
 * @param {ExColor?} color
 * @param {{autoContrast?: boolean}} colorSettings
 * @returns {ExColor?}
 */
function applyAutoContrast(color, colorSettings) {
  if (!color || !colorSettings?.autoContrast) return color;
  try {
    return enforceContrast(color, getChatBackgroundColor());
  } catch (err) {
    console.warn("[Palette Talk] Auto-contrast failed; using original color.", err);
    return color;
  }
}

const MAX_CACHE_SIZE = 100; // Prevent memory issues with many characters
let avatarColorCache = {};
let cacheInsertionOrder = []; // Track insertion order for LRU eviction

/**
 * Removes the specified cache entry and keeps insertion tracking in sync.
 * @param {string} cacheKey
 */
function removeCacheEntry(cacheKey) {
  delete avatarColorCache[cacheKey];
  const index = cacheInsertionOrder.indexOf(cacheKey);
  if (index > -1) {
    cacheInsertionOrder.splice(index, 1);
  }
}

/**
 * Enforces the maximum cache size by removing oldest entries
 */
function enforceCacheLimit() {
  if (Object.keys(avatarColorCache).length > MAX_CACHE_SIZE) {
    // Remove oldest 20% of entries to avoid frequent cleanup
    const entriesToRemove = Math.floor(MAX_CACHE_SIZE * 0.2);
    for (
      let i = 0;
      i < entriesToRemove && cacheInsertionOrder.length > 0;
      i++
    ) {
      const oldestKey = cacheInsertionOrder.shift();
      delete avatarColorCache[oldestKey];
    }
  }
}

/**
 * Adds an entry to the cache with size enforcement
 * @param {string} key
 * @param {ExColor} value
 */
function addToCache(key, value) {
  avatarColorCache[key] = value;
  cacheInsertionOrder.push(key);
  enforceCacheLimit();
}

/**
 * Clears the cache for a specific character type only
 * @param {CharacterType} charType
 */
function clearCacheForCharType(charType) {
  const prefix = `${charType}|`;
  Object.keys(avatarColorCache).forEach((key) => {
    if (key.startsWith(prefix)) {
      removeCacheEntry(key);
    }
  });
}

/**
 * Clears cached colors for a specific character (all adjustment variants).
 * @param {STCharacter} stChar
 */
function clearCacheForCharacter(stChar) {
  const prefix = `${stChar.type}|${stChar.uid}|`;
  Object.keys(avatarColorCache).forEach((key) => {
    if (key.startsWith(prefix)) {
      removeCacheEntry(key);
    }
  });
}

/**
 * Gets the dialogue color for a character using smart color extraction.
 *
 * @param {STCharacter} stChar
 * @returns {Promise<ExColor?>}
 */
async function getCharacterDialogueColor(stChar) {
  const colorSettings = getSettingsForChar(stChar);
  const colorizeSource = Object.keys(colorSettings.colorOverrides).includes(
    stChar.avatarName
  )
    ? ColorizeSourceType.CHAR_COLOR_OVERRIDE
    : colorSettings.colorizeSource;

  switch (colorizeSource) {
    case ColorizeSourceType.AVATAR_SMART: {
      const isLight = isLightTheme();
      // Create cache key that includes character type, vibrancy boost setting,
      // auto-contrast state, and theme.
      const cacheKey = `${stChar.type}|${stChar.uid}|${
        colorSettings.boostVibrancy ? "boosted" : "normal"
      }|${colorSettings.autoContrast ? "wcag" : "raw"}|${isLight ? "light" : "dark"}`;

      // Check cache first
      if (avatarColorCache[cacheKey]) {
        return avatarColorCache[cacheKey];
      }

      try {
        const avatar = stChar.getAvatarImageThumbnail();
        const colorRgb = await getSmartAvatarColor(avatar);
        const betterContrastRgb = colorRgb
          ? makeBetterContrast(
              colorRgb,
              colorSettings.boostVibrancy || false,
              isLight
            )
          : DEFAULT_STATIC_DIALOGUE_COLOR_RGB;
        const exColor = applyAutoContrast(
          ExColor.fromRgb(betterContrastRgb),
          colorSettings
        );

        // Cache the result with size enforcement
        addToCache(cacheKey, exColor);
        return exColor;
      } catch (error) {
        console.warn(
          `[Palette Talk] Failed to extract color from avatar for ${stChar.uid}:`,
          error
        );
        // Return default color on error
        const exColor = ExColor.fromRgb(DEFAULT_STATIC_DIALOGUE_COLOR_RGB);
        addToCache(cacheKey, exColor); // Cache the fallback too
        return exColor;
      }
    }
    case ColorizeSourceType.STATIC_COLOR: {
      return applyAutoContrast(
        ExColor.parse(colorSettings.staticColor),
        colorSettings
      );
    }
    case ColorizeSourceType.CHAR_COLOR_OVERRIDE: {
      const overrideColor = colorSettings.colorOverrides[stChar.avatarName];
      return overrideColor
        ? applyAutoContrast(ExColor.parse(overrideColor), colorSettings)
        : null;
    }
    case ColorizeSourceType.DISABLED:
    default:
      return null;
  }
}

/**
 * Reads the displayed character name from a message element.
 * Used as a fallback for "Send As" NPCs that have no resolvable avatar.
 *
 * @param {HTMLElement} message
 * @returns {string} The trimmed display name, or "".
 */
function getMessageDisplayName(message) {
  const nameElem = message.querySelector(".ch_name .name_text, .name_text");
  return (nameElem?.textContent ?? "").trim();
}

/**
 * Adds author UID + display-name attributes to a message element.
 *
 * The UID attribute drives avatar-based colouring. The name attribute is a
 * fallback so "Send As" NPC messages (which often share a default avatar and
 * can't be resolved to a real character) can still be coloured by name.
 *
 * @param {HTMLElement} message
 */
function addAuthorUidClassToMessage(message) {
  const authorChatUidAttr = "sdc-author_uid";

  // Always (re)tag the display name — Send-As can reuse a message slot.
  const displayName = getMessageDisplayName(message);
  if (displayName) {
    message.setAttribute("sdc-author_name", displayName.toLowerCase());
  }

  if (message.hasAttribute(authorChatUidAttr)) {
    return;
  }

  let messageAuthorChar = null;
  try {
    messageAuthorChar = getMessageAuthor(message);
  } catch (err) {
    // Send-As NPCs / unusual avatars can throw here; that's expected — we
    // fall back to name-based colouring below instead of failing.
    console.debug("[Palette Talk] Could not resolve message author, using name fallback.", err);
  }

  if (messageAuthorChar) {
    message.setAttribute(authorChatUidAttr, messageAuthorChar.uid);
  }
}

function addAuthorUidToExistingMessages() {
  const chatElem = document.getElementById("chat");
  if (!chatElem) {
    return;
  }

  chatElem.querySelectorAll(":scope > .mes").forEach((message) => {
    addAuthorUidClassToMessage(message);
  });
}

//#region Event Handlers

const scheduleCharacterSettingsRefresh = debounce(async () => {
  await updateCharactersStyleSheet();
  saveSettingsDebounced();
}, 120);

const schedulePersonaSettingsRefresh = debounce(async () => {
  await updatePersonasStyleSheet();
  saveSettingsDebounced();
}, 120);

const scheduleAllSettingsRefresh = debounce(async () => {
  await updateCharactersStyleSheet();
  await updatePersonasStyleSheet();
  updateNamesStyleSheet();
  saveSettingsDebounced();
}, 120);

const scheduleNamesRefresh = debounce(() => {
  updateNamesStyleSheet();
  saveSettingsDebounced();
}, 120);

function onCharacterSettingsUpdated() {
  scheduleCharacterSettingsRefresh();
}

function onPersonaSettingsUpdated() {
  schedulePersonaSettingsRefresh();
}

function onAnySettingsUpdated() {
  scheduleAllSettingsRefresh();
}

/**
 *
 * @param {STCharacter} char
 */
function onCharacterChanged(char) {
  const colorOverride = document.getElementById("sdc-char_color_override");
  if (!colorOverride) return;
  const newValue = extSettings.charColorSettings.colorOverrides[char.avatarName];
  // Prefer the custom override UI setter if present; fall back to legacy input combo behavior.
  const setter = /** @type {any} */ (colorOverride).__sdcSetColorOverrideValue;
  if (typeof setter === "function") {
    setter(newValue);
    return;
  }
  setInputColorPickerComboValue(colorOverride, newValue);
}

/**
 *
 * @param {STCharacter} persona
 */
function onPersonaChanged(persona) {
  const colorOverride = document.getElementById("sdc-persona_color_override");
  if (!colorOverride) return;
  const newValue =
    extSettings.personaColorSettings.colorOverrides[persona.avatarName];
  // Prefer the custom override UI setter if present; fall back to legacy input combo behavior.
  const setter = /** @type {any} */ (colorOverride).__sdcSetColorOverrideValue;
  if (typeof setter === "function") {
    setter(newValue);
    return;
  }
  setInputColorPickerComboValue(colorOverride, newValue);
}

//#endregion Event Handlers

//#region Initialization

function initializeStyleSheets() {
  // Declare layer order up front. Later layers win regardless of the order the
  // individual <style> elements end up in, so name-based "Send As" overrides
  // reliably beat avatar-derived colours of equal specificity.
  const layerOrder = document.createElement("style");
  layerOrder.id = "sdc-layer_order";
  layerOrder.innerHTML = "@layer sdc-avatars, sdc-names, sdc-preview;";
  document.head.appendChild(layerOrder);

  charactersStyleSheet = createAndAppendStyleSheet("sdc-chars_style_sheet");
  personasStyleSheet = createAndAppendStyleSheet("sdc-personas_style_sheet");
  namesStyleSheet = createAndAppendStyleSheet("sdc-names_style_sheet");
  previewStyleSheet = createAndAppendStyleSheet("sdc-preview_style_sheet");

  function createAndAppendStyleSheet(id) {
    const styleSheet = document.createElement("style");
    styleSheet.id = id;
    return document.body.appendChild(styleSheet);
  }
}

/**
 * Escapes a string for safe use inside a CSS attribute-selector value.
 * @param {string} value
 * @returns {string}
 */
function cssEscapeAttrValue(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

/**
 * Rebuilds the name-based stylesheet from `nameColorOverrides`. This colours
 * "Send As" NPC dialogue (and names) by the displayed character name, which is
 * the only reliable identifier those messages have.
 */
function updateNamesStyleSheet() {
  if (!namesStyleSheet) return;
  const overrides = extSettings.nameColorOverrides || {};
  const colorNames = extSettings.nameColorNames;

  const entries = Object.entries(overrides)
    // Re-parse the colour before injecting it into a <style> tag — the settings
    // file could be hand-edited/corrupted, and we don't want to emit broken or
    // unsafe CSS. Parsing also normalises any CSS notation to a safe literal.
    .map(([name, value]) => [name, ExColor.normalizeColorString(value)])
    .filter(([name, color]) => name && color);

  const vars = entries
    .map(
      ([name, color]) =>
        `
        .mes[sdc-author_name="${cssEscapeAttrValue(name)}"] { --character-color: ${color}; }`
    )
    .join("");

  const rules = colorNames
    ? entries
        .map(
          ([name]) =>
            `
        .mes[sdc-author_name="${cssEscapeAttrValue(name)}"] .name_text { color: var(--character-color); }`
        )
        .join("")
    : "";

  // The variable declarations sit in a cascade layer declared *after* the
  // avatar layer (see initializeStyleSheets). A "Send As" message often
  // resolves to a real character too, so it carries both sdc-author_uid and
  // sdc-author_name at equal specificity — the layer makes the name override
  // win explicitly rather than relying on <style> insertion order.
  let css = "";
  if (vars.trim()) css += `@layer sdc-names {${vars}\n}`;
  // Unlayered: competes with SillyTavern's own .name_text styles.
  if (rules.trim()) css += rules;

  namesStyleSheet.innerHTML = css;
}

/**
 * Shows a temporary colour on real messages so the user can judge a colour in
 * context while dragging the picker, without touching saved settings.
 *
 * Rules live in their own top-most cascade layer, so they override both avatar
 * and name colouring for as long as the preview is active.
 *
 * @param {string?} color Any CSS colour, or `null`/empty to clear the preview.
 * @param {string} [authorName] Restrict the preview to one NPC name. When
 * omitted, every message in the chat is previewed.
 */
function setLivePreview(color, authorName) {
  if (!previewStyleSheet) return;

  const parsed = color ? ExColor.normalizeColorString(color) : null;
  if (!parsed) {
    previewStyleSheet.innerHTML = "";
    return;
  }

  const name = (authorName ?? "").trim().toLowerCase();
  const sel = name
    ? `.mes[sdc-author_name="${cssEscapeAttrValue(name)}"]`
    : "#chat .mes";

  // The variable goes in the top-most layer so it beats both avatar and name
  // colours; the quote rule is unlayered so it can't lose to SillyTavern's own
  // styles. `!important` would be the alternative, but it would then also
  // override the user's custom CSS.
  previewStyleSheet.innerHTML = `@layer sdc-preview {
        ${sel} { --character-color: ${parsed}; }
    }
    ${sel} .mes_text q { color: var(--character-color); }`;
}

/** Clears any active live preview. */
function clearLivePreview() {
  if (previewStyleSheet) previewStyleSheet.innerHTML = "";
}

/**
 * Collects distinct speaker names from the messages currently rendered in the
 * chat, so the NPC field can suggest real names instead of relying on the user
 * typing an exact match.
 *
 * Reads the DOM rather than the chat array because "Send As" messages are
 * precisely the ones whose author can't be resolved from the data model.
 *
 * @returns {string[]} Display names, de-duplicated case-insensitively.
 */
function collectChatSpeakerNames() {
  const chatElem = document.getElementById("chat");
  if (!chatElem) return [];

  /** @type {Map<string, string>} lowercased -> original casing */
  const names = new Map();

  chatElem.querySelectorAll(":scope > .mes").forEach((message) => {
    const name = getMessageDisplayName(/** @type {HTMLElement} */ (message));
    if (!name) return;
    const key = name.toLowerCase();
    if (!names.has(key)) names.set(key, name);
  });

  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Builds the dialogue-settings controls (color source dropdown, static color
 * picker, name/vibrancy toggles) for one section (character OR persona).
 *
 * Instead of relying on fragile `children[N]` indexing, this anchors inserts to
 * stable markers in the HTML: the `.sdc_settings_section_head` and the row
 * tagged `[data-sdc-role="static-color-row"]`.
 *
 * @param {object} opts
 * @param {string} opts.sectionSelector Selector of the section container.
 * @param {string} opts.idPrefix Prefix for generated element IDs.
 * @param {object} opts.settings The settings object for this section.
 * @param {CharacterType} opts.charType Character type (for cache clearing).
 * @param {() => void} opts.onUpdated Refresh callback.
 * @param {string} opts.nameLabel Label for the "color names" toggle.
 */
function buildDialogueSettingsSection(opts) {
  const { sectionSelector, idPrefix, settings, charType, onUpdated, nameLabel } =
    opts;

  const elemExtensionSettings = document.getElementById(
    "sdc-extension-settings"
  );
  const section = elemExtensionSettings.querySelector(sectionSelector);
  if (!section) {
    console.warn(`[Palette Talk] Settings section '${sectionSelector}' not found.`);
    return;
  }

  const sectionHead = section.querySelector(".sdc_settings_section_head");
  const staticColorRow = section.querySelector('[data-sdc-role="static-color-row"]');
  if (!sectionHead || !staticColorRow) {
    console.warn(`[Palette Talk] Settings anchors missing in '${sectionSelector}'.`);
    return;
  }

  // Color source dropdown — inserted right after the section heading.
  const colorSourceDropdown = createColorSourceDropdown(
    `${idPrefix}_colorize_source`,
    (changedEvent) => {
      const value = $(changedEvent.target).prop("value");
      settings.colorizeSource = value;
      staticColorRow.style.display =
        value === ColorizeSourceType.STATIC_COLOR ? "block" : "none";
      onUpdated();
    }
  );
  sectionHead.insertAdjacentElement("afterend", colorSourceDropdown);

  // Static color picker — appended inside the static color row.
  const staticColorPickerCombo = createColorTextPickerCombo(
    (textboxValue) => ExColor.normalizeColorString(textboxValue),
    (colorValue) => {
      settings.staticColor = colorValue;
      onUpdated();
    },
    // Live preview while dragging the picker / typing, before anything is saved.
    (previewValue) => setLivePreview(previewValue),
    clearLivePreview
  );
  staticColorRow.insertAdjacentElement("beforeend", staticColorPickerCombo);

  // Color name text checkbox — after the static color row.
  const colorNameCheckbox = createCheckboxWithLabel(
    `${idPrefix}_color_name`,
    nameLabel,
    "When enabled, names will be colored in addition to dialogue quotes.",
    settings.colorNameText || false,
    (checked) => {
      settings.colorNameText = checked;
      onUpdated();
    }
  );
  staticColorRow.insertAdjacentElement("afterend", colorNameCheckbox);

  // Vibrancy boost checkbox — after the name checkbox.
  const vibrancyCheckbox = createCheckboxWithLabel(
    `${idPrefix}_boost_vibrancy`,
    "Boost color vibrancy",
    "Increases saturation by 35% for more colorful dialogue (Avatar Smart mode only).",
    settings.boostVibrancy || false,
    (checked) => {
      settings.boostVibrancy = checked;
      clearCacheForCharType(charType);
      onUpdated();
    }
  );
  colorNameCheckbox.insertAdjacentElement("afterend", vibrancyCheckbox);

  // Auto-contrast checkbox — after the vibrancy checkbox.
  const autoContrastCheckbox = createCheckboxWithLabel(
    `${idPrefix}_auto_contrast`,
    "Auto-contrast (WCAG AA)",
    "Adjusts lightness until dialogue meets a 4.5:1 contrast ratio against the chat background, keeping the original hue.",
    settings.autoContrast || false,
    (checked) => {
      settings.autoContrast = checked;
      clearCacheForCharType(charType);
      onUpdated();
    }
  );
  vibrancyCheckbox.insertAdjacentElement("afterend", autoContrastCheckbox);

  // Initialize values and visibility.
  staticColorRow.style.display =
    settings.colorizeSource === ColorizeSourceType.STATIC_COLOR
      ? "block"
      : "none";
  $(colorSourceDropdown.querySelector("select"))
    .prop("value", settings.colorizeSource)
    .trigger("change");
  $(staticColorPickerCombo.querySelector('input[type="text"]'))
    .prop("value", settings.staticColor)
    .trigger("focusout");
}

function initializeSettingsUI() {
  buildDialogueSettingsSection({
    sectionSelector: "#sdc-char_dialogue_settings",
    idPrefix: "sdc-char",
    settings: extSettings.charColorSettings,
    charType: CharacterType.CHARACTER,
    onUpdated: onCharacterSettingsUpdated,
    nameLabel: "Apply color to character names",
  });

  buildDialogueSettingsSection({
    sectionSelector: "#sdc-persona_dialogue_settings",
    idPrefix: "sdc-persona",
    settings: extSettings.personaColorSettings,
    charType: CharacterType.PERSONA,
    onUpdated: onPersonaSettingsUpdated,
    nameLabel: "Apply color to persona names",
  });
}

/**
 * Set by the NPC settings UI so chat-level events can refresh the name
 * suggestion list. No-op until that section has been built.
 * @type {() => void}
 */
let onNameSuggestionsStale = () => {};

/**
 * Builds the "Send As / NPC Colors" section in the settings panel. Lets the
 * user map a character NAME to a colour, which is applied to messages posted
 * via the "Send As" feature (those NPCs have no resolvable avatar). Solves
 * upstream Issue #1.
 */
function initializeNameOverridesUI() {
  const root = document.getElementById("sdc-extension-settings");
  if (!root) return;
  // Prefer the styled card so the section sits inside the rounded panel.
  const content =
    root.querySelector(".sdc_settings_card") ||
    root.querySelector(".inline-drawer-content");
  if (!content) return;

  extSettings.nameColorOverrides ??= {};

  const section = document.createElement("div");
  section.id = "sdc-name_overrides_settings";
  section.className = "sdc-extension_block dc-color-settings-group";

  const header = document.createElement("div");
  header.className = "sdc_settings_section_head";
  header.innerHTML = `
        <label title="Colour dialogue for characters posted via 'Send As' (NPCs without their own avatar), matched by name.">
            <h4 class="sdc_settings_heading">Send As / NPC Colors<span class="margin5 fa-solid fa-circle-info opacity50p"></span></h4>
        </label>`;
  section.appendChild(header);

  const list = document.createElement("div");
  list.className = "sdc-name-overrides-list";
  section.appendChild(list);

  /** Re-renders the list of name -> colour rows. */
  function renderRows() {
    list.innerHTML = "";
    const entries = Object.entries(extSettings.nameColorOverrides);
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sdc-name-overrides-empty";
      empty.textContent = "No NPC colors yet. Add one below.";
      list.appendChild(empty);
    }
    entries.forEach(([name, hex]) => list.appendChild(createRow(name, hex)));
  }

  /**
   * @param {string} name
   * @param {string} color
   */
  function createRow(name, color) {
    const row = document.createElement("div");
    row.className = "sdc-name-override-row";

    const swatch = document.createElement("span");
    swatch.className = "sdc-name-override-swatch";
    swatch.style.backgroundColor = color;

    const nameSpan = document.createElement("span");
    nameSpan.className = "sdc-name-override-name";
    nameSpan.textContent = name;
    nameSpan.title = name;

    const colorSpan = document.createElement("span");
    colorSpan.className = "sdc-name-override-hex";
    colorSpan.textContent = color.startsWith("#") ? color.toUpperCase() : color;
    colorSpan.title = color;

    // Hovering a saved row previews that colour on the matching messages.
    row.addEventListener("mouseenter", () => setLivePreview(color, name));
    row.addEventListener("mouseleave", clearLivePreview);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "menu_button menu_button_icon sdc-name-override-del";
    delBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
    delBtn.title = "Remove this NPC color";
    delBtn.onclick = () => {
      delete extSettings.nameColorOverrides[name];
      clearLivePreview();
      renderRows();
      scheduleNamesRefresh();
    };

    row.append(swatch, nameSpan, colorSpan, delBtn);
    return row;
  }

  // --- Add-new row -----------------------------------------------------
  const addRow = document.createElement("div");
  addRow.className = "sdc-name-override-add";

  // Names are suggested from the current chat via a datalist, so "Send As"
  // NPCs can be picked instead of typed (an exact match is required to apply).
  const nameSuggestions = document.createElement("datalist");
  nameSuggestions.id = "sdc-npc_name_suggestions";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "text_pole";
  nameInput.placeholder = "Character name";
  nameInput.setAttribute("list", nameSuggestions.id);
  nameInput.title = "Start typing, or pick a speaker detected in this chat.";

  /** Refreshes the suggestion list from whatever is on screen right now. */
  function refreshNameSuggestions() {
    const existing = new Set(Object.keys(extSettings.nameColorOverrides));
    const names = collectChatSpeakerNames().filter(
      (name) => !existing.has(name.toLowerCase())
    );

    nameSuggestions.innerHTML = "";
    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      nameSuggestions.appendChild(option);
    }
  }

  // Rebuild suggestions when the field is focused and when the chat changes,
  // so newly-seen speakers show up without reopening the panel.
  nameInput.addEventListener("focus", refreshNameSuggestions);
  onNameSuggestionsStale = refreshNameSuggestions;

  const colorTextInput = document.createElement("input");
  colorTextInput.type = "text";
  colorTextInput.className = "text_pole sdc-hex-input";
  colorTextInput.placeholder = "#RRGGBB / rgb() / hsl()";
  colorTextInput.title =
    "Any CSS color: #RRGGBB, #RGBA, rgb(), rgba(), hsl(), hsla(), or a name like 'tomato'.";

  const colorPickerWrapper = document.createElement("div");
  colorPickerWrapper.className =
    "dc-color-picker-wrapper sdc-custom-picker-wrapper";
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.className = "dc-color-picker";
  colorInput.value = DEFAULT_STATIC_DIALOGUE_COLOR_HEX;
  colorPickerWrapper.appendChild(colorInput);

  /** The colour currently represented by the add-row, or `null` if invalid. */
  const getPendingColor = () =>
    ExColor.normalizeColorString(colorTextInput.value) ??
    (colorTextInput.value.trim() === "" ? colorInput.value : null);

  /** Previews the pending colour, scoped to the typed name when it matches. */
  function previewPending() {
    const color = getPendingColor();
    const name = nameInput.value.trim();
    setLivePreview(color, name || undefined);
  }

  // 'input' (not 'change') so dragging the picker updates live.
  colorInput.addEventListener("input", () => {
    colorTextInput.value = colorInput.value;
    colorTextInput.classList.remove("sdc-input-invalid");
    previewPending();
  });

  // Two-way binding: typing a colour drives the swatch as well.
  colorTextInput.addEventListener("input", () => {
    const parsed = ExColor.parse(colorTextInput.value);
    const isEmpty = colorTextInput.value.trim() === "";
    colorTextInput.classList.toggle("sdc-input-invalid", !parsed && !isEmpty);
    if (parsed) {
      // <input type="color"> only accepts #RRGGBB, so drop any alpha here.
      colorInput.value = "#" + parsed.toHex();
    }
    previewPending();
  });

  nameInput.addEventListener("input", previewPending);
  colorTextInput.addEventListener("blur", clearLivePreview);
  nameInput.addEventListener("blur", clearLivePreview);

  const eyedropperBtn = document.createElement("button");
  eyedropperBtn.type = "button";
  eyedropperBtn.className = "menu_button menu_button_icon sdc-eyedropper-btn";
  eyedropperBtn.innerHTML = '<i class="fa-solid fa-eye-dropper"></i>';
  eyedropperBtn.title = isNativeEyeDropperSupported()
    ? "Pick a colour from anywhere on screen"
    : "Pick a colour by clicking on an avatar";
  eyedropperBtn.onclick = async () => {
    const picked = await pickColor();
    if (picked) {
      colorTextInput.value = picked;
      colorInput.value = picked;
      colorTextInput.classList.remove("sdc-input-invalid");
      previewPending();
    }
  };

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "menu_button sdc-name-override-addbtn";
  addBtn.textContent = "Add";
  addBtn.onclick = () => {
    const name = nameInput.value.trim();
    const color = getPendingColor();
    if (!name || !color) {
      colorTextInput.classList.toggle("sdc-input-invalid", !color);
      return;
    }

    extSettings.nameColorOverrides[name.toLowerCase()] = color;
    nameInput.value = "";
    colorTextInput.value = "";
    colorTextInput.classList.remove("sdc-input-invalid");
    clearLivePreview();
    refreshNameSuggestions();
    renderRows();
    scheduleNamesRefresh();
  };

  // Enter in either field commits the entry.
  const submitOnEnter = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addBtn.click();
    }
  };
  nameInput.addEventListener("keydown", submitOnEnter);
  colorTextInput.addEventListener("keydown", submitOnEnter);

  addRow.append(
    nameInput,
    nameSuggestions,
    colorTextInput,
    colorPickerWrapper,
    eyedropperBtn,
    addBtn
  );
  section.appendChild(addRow);

  // Per-section toggle: NPC name colouring used to piggyback on the character
  // setting, which made it impossible to control independently.
  const colorNamesToggle = createCheckboxWithLabel(
    "sdc-name_color_names",
    "Apply color to NPC names",
    "When enabled, NPC display names are colored in addition to their dialogue.",
    extSettings.nameColorNames || false,
    (checked) => {
      extSettings.nameColorNames = checked;
      scheduleNamesRefresh();
    }
  );
  section.appendChild(colorNamesToggle);

  content.appendChild(section);
  refreshNameSuggestions();
  renderRows();
}

function initializeCharSpecificUI() {
  /**
   * Preset colors for quick selection (readable on both light/dark themes)
   */
  const PRESET_COLORS = [
    { hex: "#E74C3C", name: "Coral Red" },
    { hex: "#E67E22", name: "Orange" },
    { hex: "#F1C40F", name: "Gold" },
    { hex: "#27AE60", name: "Green" },
    { hex: "#3498DB", name: "Blue" },
    { hex: "#9B59B6", name: "Purple" },
  ];

  /**
   *
   * @param {string} id
   * @param {() => STCharacter} stCharGetter
   */
  function createColorOverrideElem(id, stCharGetter) {
    // Create container
    const wrapper = document.createElement("div");
    wrapper.id = id;
    wrapper.className = "sdc-color-override-container";

    // Add subtle separator at top
    const separator = document.createElement("div");
    separator.className = "sdc-separator";

    // Create label row
    const labelRow = document.createElement("div");
    labelRow.className = "sdc-label-row";

    const label = document.createElement("label");
    label.className = "sdc-override-label";
    label.innerHTML = `
            <span>Dialogue Color</span>
            <i class="fa-solid fa-circle-info margin5 opacity50p" 
               title="Pick a preset color or enter a custom hex. Click reset to use auto-detection."></i>
        `;
    labelRow.appendChild(label);

    // Create the inline control row
    const controlRow = document.createElement("div");
    controlRow.className = "sdc-inline-color-row";

    // Preset swatches container
    const presetsContainer = document.createElement("div");
    presetsContainer.className = "sdc-preset-swatches";

    /** @type {HTMLButtonElement[]} */
    const swatchButtons = [];

    // Track current selection state
    let currentColor = "";

    /**
     * Updates the visual selection state of all swatches
     * @param {string} selectedColor
     */
    function updateSwatchSelection(selectedColor) {
      currentColor = selectedColor;
      swatchButtons.forEach((btn) => {
        const isSelected =
          btn.dataset.color.toUpperCase() === selectedColor.toUpperCase();
        btn.classList.toggle("selected", isSelected);
      });
      // Update custom input selection state
      const isCustom =
        selectedColor &&
        !PRESET_COLORS.some(
          (p) => p.hex.toUpperCase() === selectedColor.toUpperCase()
        );
      customInputWrapper.classList.toggle("selected", isCustom);
      // Show/hide reset button
      resetBtn.style.display = selectedColor ? "flex" : "none";
    }

    /**
     * Applies a color override
     * @param {string} colorValue
     */
    function applyColorOverride(colorValue) {
      const stChar = stCharGetter();
      if (!stChar) return; // No character/persona resolved yet — nothing to apply to.
      const colorSettings = getSettingsForChar(stChar);

      if (colorValue && colorValue.length > 0) {
        colorSettings.colorOverrides[stChar.avatarName] = colorValue;
      } else {
        delete colorSettings.colorOverrides[stChar.avatarName];
      }

      // Clear cache when override changes
      clearCacheForCharacter(stChar);

      if (stChar.type === CharacterType.PERSONA) {
        onPersonaSettingsUpdated();
      } else {
        onCharacterSettingsUpdated();
      }

      setUIOverrideValue(colorValue);
    }

    /**
     * Updates ONLY the UI state (swatch selection, custom highlight, reset visibility, inputs).
     * Does not update settings.
     *
     * @param {string?} colorValue
     */
    function setUIOverrideValue(colorValue) {
      const value = colorValue ?? "";
      updateSwatchSelection(value);

      // Update custom input to show the color. The native picker only accepts
      // #RRGGBB, so translucent/non-hex values are flattened for it alone.
      textInput.classList.remove("sdc-input-invalid");
      if (value) {
        textInput.value = value;
        const parsed = ExColor.parse(value);
        colorInput.value = parsed ? "#" + parsed.toHex() : "#808080";
      } else {
        textInput.value = "";
        colorInput.value = "#808080";
      }

      // Reflect the chosen colour in the live preview. When cleared, fall back
      // to the auto-detected avatar colour so the preview is still meaningful.
      if (value) {
        updatePreview(value);
      } else {
        updatePreviewFromAuto();
      }
    }

    /**
     * Updates the preview using the colour SDC would auto-pick for this
     * character (avatar-smart / static), so an empty override still previews.
     */
    async function updatePreviewFromAuto() {
      try {
        const stChar = stCharGetter();
        const autoColor = await getCharacterDialogueColor(stChar);
        updatePreview(autoColor ? autoColor.toCssString() : "");
      } catch (_) {
        updatePreview("");
      }
    }

    // Create preset swatch buttons
    PRESET_COLORS.forEach((preset) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "sdc-preset-swatch";
      swatch.dataset.color = preset.hex;
      swatch.style.backgroundColor = preset.hex;
      swatch.title = preset.name;
      swatch.onclick = () => {
        clearLivePreview();
        applyColorOverride(preset.hex);
      };
      // Hovering previews the preset on real messages before committing.
      swatch.addEventListener("mouseenter", () => setLivePreview(preset.hex));
      swatch.addEventListener("mouseleave", clearLivePreview);
      swatchButtons.push(swatch);
      presetsContainer.appendChild(swatch);
    });

    // Divider between presets and custom
    const divider = document.createElement("div");
    divider.className = "sdc-color-divider";

    // Custom color input wrapper
    const customInputWrapper = document.createElement("div");
    customInputWrapper.className = "sdc-custom-color-wrapper";

    // Colour text input — accepts any CSS colour notation.
    const textInput = document.createElement("input");
    textInput.type = "text";
    textInput.className = "text_pole sdc-hex-input";
    textInput.placeholder = "#RRGGBB / rgb() / hsl()";
    textInput.title =
      "Any CSS color: #RRGGBB, #RGBA, rgb(), rgba(), hsl(), hsla(), or a name like 'tomato'.";

    // Color picker
    const colorPickerWrapper = document.createElement("div");
    colorPickerWrapper.className =
      "dc-color-picker-wrapper sdc-custom-picker-wrapper";

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.className = "dc-color-picker";
    colorInput.value = "#808080";

    colorPickerWrapper.appendChild(colorInput);

    // Wire up custom input events
    textInput.addEventListener("focusout", () => {
      clearLivePreview();
      const validated = ExColor.normalizeColorString(textInput.value);
      if (validated) {
        applyColorOverride(validated);
      } else if (textInput.value.trim() === "") {
        // Allow clearing via empty input
        applyColorOverride("");
      } else {
        // Invalid: revert the field to the stored value rather than keeping
        // unusable text on screen.
        textInput.classList.remove("sdc-input-invalid");
        const stChar = stCharGetter();
        const saved = stChar
          ? getSettingsForChar(stChar).colorOverrides[stChar.avatarName] || ""
          : "";
        textInput.value = saved;
      }
    });

    // Live validation + preview on real messages as the user types.
    textInput.addEventListener("input", () => {
      const parsed = ExColor.normalizeColorString(textInput.value);
      const isEmpty = textInput.value.trim() === "";
      textInput.classList.toggle("sdc-input-invalid", !parsed && !isEmpty);
      if (parsed) {
        colorInput.value = "#" + ExColor.parse(parsed).toHex();
        updatePreview(parsed);
        setLivePreview(parsed);
      }
    });

    textInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        textInput.blur();
      }
    });

    // 'input' fires while dragging, so the chat updates in real time.
    colorInput.addEventListener("input", () => {
      textInput.value = colorInput.value;
      textInput.classList.remove("sdc-input-invalid");
      updatePreview(colorInput.value);
      setLivePreview(colorInput.value);
    });

    colorInput.addEventListener("change", () => {
      clearLivePreview();
      applyColorOverride(colorInput.value);
    });

    customInputWrapper.appendChild(textInput);
    customInputWrapper.appendChild(colorPickerWrapper);

    // Eyedropper button — pick a colour straight from an avatar (or anywhere on
    // screen with the native EyeDropper API). This is the headline feature.
    const eyedropperBtn = document.createElement("button");
    eyedropperBtn.type = "button";
    eyedropperBtn.className = "menu_button menu_button_icon sdc-eyedropper-btn";
    eyedropperBtn.innerHTML = '<i class="fa-solid fa-eye-dropper"></i>';
    eyedropperBtn.title = isNativeEyeDropperSupported()
      ? "Pick a colour from anywhere on screen (e.g. the avatar)"
      : "Pick a colour by clicking on an avatar image";
    eyedropperBtn.onclick = async () => {
      eyedropperBtn.classList.add("sdc-eyedropper-btn-active");
      try {
        const hex = await pickColor();
        if (hex) {
          clearLivePreview();
          applyColorOverride(hex);
        }
      } finally {
        eyedropperBtn.classList.remove("sdc-eyedropper-btn-active");
      }
    };

    // Reset button
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "menu_button menu_button_icon sdc-reset-btn";
    resetBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i>';
    resetBtn.title = "Reset to auto-detect from avatar";
    resetBtn.style.display = "none";
    resetBtn.onclick = () => applyColorOverride("");

    // Assemble the control row
    controlRow.appendChild(presetsContainer);
    controlRow.appendChild(divider);
    controlRow.appendChild(customInputWrapper);
    controlRow.appendChild(eyedropperBtn);
    controlRow.appendChild(resetBtn);

    // Live preview — shows a sample dialogue line in the chosen colour so the
    // user can judge readability before committing.
    const previewRow = document.createElement("div");
    previewRow.className = "sdc-preview-row";
    const previewQuote = document.createElement("span");
    previewQuote.className = "sdc-preview-quote";
    previewQuote.textContent = '"The quick brown fox."';
    const previewLabel = document.createElement("span");
    previewLabel.className = "sdc-preview-label";
    previewLabel.textContent = "Preview";
    previewRow.appendChild(previewLabel);
    previewRow.appendChild(previewQuote);

    /** @param {string} color Any CSS colour, or "" to clear. */
    function updatePreview(color) {
      previewQuote.style.color = color && color.length ? color : "";

      // Surface the contrast ratio against the real chat background so the
      // user can tell at a glance whether the colour is actually readable.
      const parsed = color ? ExColor.parse(color) : null;
      if (!parsed) {
        previewLabel.textContent = "Preview";
        previewLabel.removeAttribute("data-sdc-contrast");
        previewLabel.title = "";
        return;
      }

      const ratio = ExColor.contrastRatio(parsed, getChatBackgroundColor());
      const rounded = Math.round(ratio * 10) / 10;
      const passes = ratio >= WCAG_AA_NORMAL_TEXT;

      previewLabel.textContent = `Preview · ${rounded}:1`;
      previewLabel.dataset.sdcContrast = passes ? "pass" : "fail";
      previewLabel.title = passes
        ? `Meets WCAG AA (${rounded}:1 ≥ 4.5:1).`
        : `Below WCAG AA (${rounded}:1 < 4.5:1) — may be hard to read.`;
    }

    // Assemble wrapper
    wrapper.appendChild(separator);
    wrapper.appendChild(labelRow);
    wrapper.appendChild(controlRow);
    wrapper.appendChild(previewRow);

    // Expose a setter so the persona/character change handlers can refresh UI state
    // when the selected persona/character changes.
    /** @type {any} */ (wrapper).__sdcSetColorOverrideValue = setUIOverrideValue;

    // Initialize with current value
    setTimeout(() => {
      const stChar = stCharGetter();
      if (!stChar) return;
      const colorSettings = getSettingsForChar(stChar);
      const savedColor = colorSettings.colorOverrides[stChar.avatarName] || "";
      setUIOverrideValue(savedColor);
    }, 100);

    return wrapper;
  }

  /**
   * Attempts to insert the character override UI into the character editor.
   * This UI target isn't always present (e.g. if user hasn't opened the editor yet).
   * @returns {boolean} true if inserted or already present
   */
  function tryInsertCharacterOverride() {
    if (document.getElementById("sdc-char_color_override")) return true;

    const elemCharCardForm = document.getElementById("form_create");
    if (!elemCharCardForm) return false;

    const elemAvatarNameBlock = elemCharCardForm.querySelector(
      "div#avatar-and-name-block"
    );
    if (!elemAvatarNameBlock) return false;

    const elemCharColorOverride = createColorOverrideElem(
      "sdc-char_color_override",
      getCharacterBeingEdited
    );
    elemAvatarNameBlock.insertAdjacentElement("afterend", elemCharColorOverride);
    return true;
  }

  /**
   * Finds a good anchor element to insert the persona override UI.
   * Tries known IDs first, then falls back to locating the "Current Persona" label.
   * @returns {{anchor: Element, position: InsertPosition}?}
   */
  function findPersonaOverrideAnchor() {
    const elemPersonaDescription = document.getElementById("persona_description");
    if (elemPersonaDescription?.parentElement) {
      return { anchor: elemPersonaDescription.parentElement, position: "afterbegin" };
    }

    // Fallback: find the label that contains "Current Persona" and insert before its row/container.
    const labels = Array.from(document.querySelectorAll("label"));
    const currentPersonaLabel = labels.find((l) =>
      (l.textContent ?? "").trim().toLowerCase().includes("current persona")
    );
    if (!currentPersonaLabel) return null;

    const row =
      currentPersonaLabel.closest("div") ?? currentPersonaLabel.parentElement;
    if (!row) return null;

    return { anchor: row, position: "beforebegin" };
  }

  /**
   * Attempts to insert the persona override UI into Persona Management settings.
   * This panel may be created lazily, so we retry when DOM changes.
   * @returns {boolean} true if inserted or already present
   */
  function tryInsertPersonaOverride() {
    if (document.getElementById("sdc-persona_color_override")) return true;

    const anchor = findPersonaOverrideAnchor();
    if (!anchor) return false;

    const elemPersonaColorOverride = createColorOverrideElem(
      "sdc-persona_color_override",
      getCurrentPersona
    );
    anchor.anchor.insertAdjacentElement(anchor.position, elemPersonaColorOverride);
    return true;
  }

  function tryInsertAll() {
    const charOk = tryInsertCharacterOverride();
    const personaOk = tryInsertPersonaOverride();
    return { charOk, personaOk };
  }

  // Initial attempt (might only succeed partially depending on which UI panels exist)
  const initial = tryInsertAll();
  if (initial.charOk && initial.personaOk) {
    return () => {}; // Nothing left to observe; no cleanup needed.
  }

  // Watch for the Persona Management and/or Character Editor DOM being created.
  //
  // IMPORTANT: we deliberately do NOT observe `document.body` with
  // `subtree: true` forever. That fired on every DOM mutation (including every
  // token during message streaming) and was a major source of lag. Instead we
  // scope the observer to the settings/drawer containers where these panels
  // actually appear, debounce it, and hard-stop after a timeout so it can never
  // run for the lifetime of the page.
  const scopedContainers = [
    document.getElementById("right-nav-panel"),
    document.getElementById("persona-management-block"),
    document.getElementById("PersonaManagement"),
    document.getElementById("user-settings-block"),
  ].filter((el) => el instanceof HTMLElement);

  // Fallback: if none of the known containers exist yet, watch body but only
  // for direct children being added (childList without subtree is cheap) and
  // stop as soon as we can scope properly or after the timeout.
  const injectionObserver = new MutationObserver(
    debounce(() => {
      const { charOk, personaOk } = tryInsertAll();
      if (charOk && personaOk) {
        injectionObserver.disconnect();
        clearTimeout(stopTimer);
      }
    }, 250)
  );

  if (scopedContainers.length > 0) {
    for (const container of scopedContainers) {
      injectionObserver.observe(container, { childList: true, subtree: true });
    }
  } else {
    // Cheap, shallow watch — no subtree — just until the drawers get created.
    injectionObserver.observe(document.body, { childList: true });
  }

  // Safety net: never let this observer live forever. The override UIs are
  // purely cosmetic, so giving up after a while is fine.
  const stopTimer = setTimeout(() => injectionObserver.disconnect(), 60_000);

  return () => {
    injectionObserver.disconnect();
    clearTimeout(stopTimer);
  };
}

jQuery(async ($) => {
  // Hot-reload guard: if a previous instance is still around (e.g. the user
  // re-installed/updated without a full page reload), tear it down first so we
  // don't end up with duplicate buttons, observers and style sheets.
  if (window.__sdcInitialized && typeof window.__sdcDispose === "function") {
    try {
      window.__sdcDispose();
    } catch (e) {
      console.warn("[Palette Talk] Previous dispose failed:", e);
    }
  }
  window.__sdcInitialized = true;

  /** @type {Array<() => void>} Cleanup callbacks run on dispose. */
  const cleanupTasks = [];
  /** @param {() => void} fn */
  const onDispose = (fn) => cleanupTasks.push(fn);

  let settingsHtml;
  try {
    settingsHtml = await $.get(`${extFolderPath}/palette-talk.html`);
  } catch (err) {
    console.error(
      `[Palette Talk] Failed to load settings HTML from '${extFolderPath}/palette-talk.html'. The extension folder name may be unexpected.`,
      err
    );
    return; // Abort init cleanly instead of leaving a half-broken state.
  }

  const elemStExtensionSettings2 = document.getElementById(
    "extensions_settings2"
  );
  $(elemStExtensionSettings2).append(settingsHtml);

  initializeStyleSheets();
  initializeSettingsUI();
  initializeNameOverridesUI();
  const disposeCharSpecificUI = initializeCharSpecificUI();
  if (typeof disposeCharSpecificUI === "function") {
    onDispose(disposeCharSpecificUI);
  }

  // Note: Palette Talk has no wand-menu button on purpose — all settings live
  // in the Extensions panel, so a wand entry would just duplicate that.

  eventSource.on(event_types.CHAT_CHANGED, () => {
    // Messages of the newly-loaded chat are rendered in bulk and were never
    // seen by the MESSAGE_ADDED handler, so they must be tagged here — without
    // this, name-based ("Send As" NPC) colouring only worked for messages that
    // arrived while the chat was already open.
    addAuthorUidToExistingMessages();
    updateCharactersStyleSheet();
    updateNamesStyleSheet();
    onNameSuggestionsStale();
  });

  // The chat observer can attach after the first messages are painted; tag
  // whatever is already on screen at that point.
  expEventSource.on(exp_event_type.CHAT_OBSERVER_READY, () => {
    addAuthorUidToExistingMessages();
    updateNamesStyleSheet();
    onNameSuggestionsStale();
  });

  expEventSource.on(exp_event_type.MESSAGE_ADDED, (message) => {
    addAuthorUidClassToMessage(message);
    onNameSuggestionsStale();
  });

  expEventSource.on(exp_event_type.CHAR_CARD_CHANGED, (char) => {
    onCharacterChanged(char);
    clearCacheForCharacter(char);
    updateCharactersStyleSheet();
  });
  expEventSource.on(exp_event_type.PERSONA_CHANGED, (persona) => {
    onPersonaChanged(persona);
    clearCacheForCharacter(persona);
    updatePersonasStyleSheet();
  });
  expEventSource.on(exp_event_type.PERSONA_ADDED, (persona) => {
    clearCacheForCharacter(persona);
    updatePersonasStyleSheet();
  });
  expEventSource.on(exp_event_type.PERSONA_REMOVED, (persona) => {
    clearCacheForCharacter(persona);
    updatePersonasStyleSheet();
  });

  eventSource.once(event_types.APP_READY, () => {
    onPersonaChanged(getCurrentPersona()); // Initialize color inputs with starting values.
    addAuthorUidToExistingMessages();
    updateCharactersStyleSheet();
    updatePersonasStyleSheet();
    updateNamesStyleSheet();
  });

  // Watch for persona changes in the Persona Management panel (#PersonaManagement)
  // The avatar containers get a "selected" class when clicked
  const personaManagementObserver = new MutationObserver(
    debounce(() => {
      onPersonaChanged(getCurrentPersona());
    }, 100)
  );

  // Try to observe immediately, and also set up a watcher in case the panel is created later
  function tryObservePersonaManagement() {
    const personaManagement = document.getElementById("PersonaManagement");
    if (personaManagement) {
      personaManagementObserver.observe(personaManagement, {
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
      });
      return true;
    }
    return false;
  }

  onDispose(() => personaManagementObserver.disconnect());

  if (!tryObservePersonaManagement()) {
    // Panel doesn't exist yet — watch (shallowly + debounced) for it to be
    // created, and give up after a timeout so this never runs forever.
    const panelWatcher = new MutationObserver(
      debounce(() => {
        if (tryObservePersonaManagement()) {
          panelWatcher.disconnect();
          clearTimeout(panelWatcherStop);
        }
      }, 250)
    );
    panelWatcher.observe(document.body, { childList: true });
    const panelWatcherStop = setTimeout(() => panelWatcher.disconnect(), 60_000);
    onDispose(() => {
      panelWatcher.disconnect();
      clearTimeout(panelWatcherStop);
    });
  }

  // Watch for theme changes to update colors automatically
  let lastThemeIsLight = isLightTheme();
  const themeObserver = new MutationObserver(
    debounce(() => {
      // Check if the theme actually changed to avoid unnecessary updates
      const currentThemeIsLight = isLightTheme();
      if (currentThemeIsLight !== lastThemeIsLight) {
        lastThemeIsLight = currentThemeIsLight;
        updateCharactersStyleSheet();
        updatePersonasStyleSheet();
      }
    }, 500)
  );

  themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  onDispose(() => themeObserver.disconnect());

  // ---------------------------------------------------------------------
  // Dispose — removes injected DOM/observers so a hot-reload starts clean.
  // ---------------------------------------------------------------------
  window.__sdcDispose = function sdcDispose() {
    for (const task of cleanupTasks) {
      try {
        task();
      } catch (_) {
        /* noop — keep disposing the rest */
      }
    }
    // Tear down the low-level DOM observers created in st-utils.js too.
    try {
      disposeStObservers();
    } catch (_) {
      /* noop */
    }
    // Remove injected DOM nodes.
    [
      "sdc-extension-settings",
      "sdc-layer_order",
      "sdc-chars_style_sheet",
      "sdc-personas_style_sheet",
      "sdc-names_style_sheet",
      "sdc-preview_style_sheet",
      "sdc-char_color_override",
      "sdc-persona_color_override",
    ].forEach((id) => document.getElementById(id)?.remove());
    // Drop the suggestion-refresh hook so it can't retain a detached DOM tree.
    onNameSuggestionsStale = () => {};
    window.__sdcInitialized = false;
  };
});

//#endregion Initialization
