import { user_avatar } from "../../../../script.js";
import { getContext } from "../../../extensions.js";
import { power_user } from "../../../power-user.js";

/** @readonly */
export const CharacterType = {
    CHARACTER: "character",
    PERSONA: "persona",
};

const SYSTEM_AVATAR_MARKER = "img/five.png";
const GENERIC_AI_AVATAR_MARKER = "img/ai4.png";

/**
 * Returns whether the extension is running inside a TauriTavern host / Tauri WebView.
 * @returns {boolean}
 */
export function isTauriTavern() {
    if (typeof window === "undefined") return false;
    const win = /** @type {any} */ (window);
    return Boolean(
        win.__TAURITAVERN__ ||
        win.__TAURI_RUNNING__ ||
        win.__TAURITAVERN_MAIN_READY__ ||
        win.__TAURITAVERN_THUMBNAIL__ ||
        win.__TAURI_INTERNALS__ ||
        win.__TAURI__
    );
}

/**
 * Creates a lightweight author descriptor.
 * @param {string} type
 * @param {string} avatarName
 * @param {string | null} [fallbackImgSrc=null]
 */
export function makeAuthor(type, avatarName, fallbackImgSrc = null) {
    return {
        type,
        avatarName,
        uid: `${type}|${avatarName}`,
        fallbackImgSrc,
    };
}

/**
 * Safely checks whether a character index is present (handles index 0 properly).
 * @param {any} id
 * @returns {boolean}
 */
function hasCharacterId(id) {
    return id !== undefined && id !== null && id !== "";
}

/**
 * Returns whether the user is currently in a 1-on-1 character chat.
 * @returns {boolean}
 */
export function isInCharacterChat() {
    return hasCharacterId(getContext().characterId);
}

/**
 * Returns whether the user is currently in a group chat.
 * @returns {boolean}
 */
export function isInGroupChat() {
    return Boolean(getContext().groupId);
}

/**
 * Returns the active chat character, or null if not in a 1-on-1 chat.
 */
export function getCurrentCharacter() {
    const ctx = getContext();
    if (!hasCharacterId(ctx.characterId)) return null;
    const ch = ctx.characters?.[ctx.characterId];
    return ch?.avatar ? makeAuthor(CharacterType.CHARACTER, ch.avatar) : null;
}

/**
 * Returns the members of the current group chat, or an empty array.
 */
export function getCurrentGroupCharacters() {
    const ctx = getContext();
    if (!ctx.groupId) return [];
    const group = ctx.groups?.find((g) => g.id === ctx.groupId);
    if (!group || !Array.isArray(group.members)) return [];

    const out = [];
    for (const avatar of group.members) {
        if (avatar) {
            out.push(makeAuthor(CharacterType.CHARACTER, avatar));
        }
    }
    return out;
}

/**
 * Returns all defined user personas (plus active user_avatar if set).
 */
export function getAllPersonas() {
    const personas = power_user?.personas ?? {};
    const keys = new Set(Object.keys(personas).filter(Boolean));
    if (user_avatar && typeof user_avatar === "string") {
        keys.add(user_avatar);
    }
    return Array.from(keys).map((avatarId) => makeAuthor(CharacterType.PERSONA, avatarId));
}

/**
 * Returns the currently active persona.
 */
export function getCurrentPersona() {
    const personas = power_user?.personas ?? {};
    if (user_avatar && typeof user_avatar === "string" && user_avatar in personas) {
        return makeAuthor(CharacterType.PERSONA, user_avatar);
    }

    const selectedEl = document.querySelector(
        "#user_avatar_block .avatar.selected, #user_avatar_block .avatar-container.selected .avatar, #user_avatar_block .avatar-container.selected"
    );
    if (selectedEl) {
        const attrVal =
            selectedEl.getAttribute("imgfile") ||
            selectedEl.getAttribute("data-avatar-id") ||
            selectedEl.closest("[imgfile]")?.getAttribute("imgfile");
        if (attrVal) {
            const clean = attrVal.slice(attrVal.lastIndexOf("/") + 1);
            if (clean) return makeAuthor(CharacterType.PERSONA, clean);
        }
        const img = selectedEl.querySelector("img");
        const parsed = img ? parseAvatarSrc(img.getAttribute("src") || "", true) : null;
        if (parsed?.file) {
            return makeAuthor(CharacterType.PERSONA, parsed.file, img?.getAttribute("src") || null);
        }
    }

    return user_avatar ? makeAuthor(CharacterType.PERSONA, user_avatar) : null;
}

/**
 * Returns the character currently open in the Character Editor (`#form_create`), or null.
 */
export function getCharacterBeingEdited() {
    const pole = /** @type {HTMLInputElement | null} */ (
        document.getElementById("avatar_url_pole")
    );
    // Always prefer live `.value` property because jQuery `.val(...)` updates `.value`
    // without updating the HTML `value` attribute.
    const avatar = (pole?.value || pole?.getAttribute("value") || "").trim();
    if (!avatar) return null;

    const ctx = getContext();
    const exists = Array.isArray(ctx.characters)
        ? ctx.characters.some((c) => c?.avatar === avatar)
        : true;
    return exists ? makeAuthor(CharacterType.CHARACTER, avatar) : null;
}

/**
 * Appends a cache-busting query parameter to non-blob/non-data HTTP URLs.
 * @param {string} url
 * @param {number} stamp
 * @returns {string}
 */
function appendCacheBuster(url, stamp) {
    if (!url || /^(blob:|data:)/i.test(url)) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}_sdc_t=${stamp}`;
}

/**
 * Builds candidate URLs to load an avatar thumbnail, prioritizing TauriTavern's
 * host thumbnail helper when present and falling back cleanly to SillyTavern routes.
 *
 * @param {string} type
 * @param {string} avatarName
 * @param {string | null} [fallbackImgSrc=null]
 * @param {boolean} [useTimestamp=false]
 * @returns {string[]}
 */
export function getAvatarCandidateUrls(
    type,
    avatarName,
    fallbackImgSrc = null,
    useTimestamp = false
) {
    /** @type {string[]} */
    const urls = [];
    const ttKind = type === CharacterType.PERSONA ? "persona" : "avatar";
    const win = /** @type {any} */ (window);
    const isSingleSegment =
        Boolean(avatarName) &&
        !avatarName.includes("/") &&
        !avatarName.includes("\\") &&
        !avatarName.includes("..");

    if (isSingleSegment) {
        try {
            if (typeof win.__TAURITAVERN__?.assets?.thumbnailUrl === "function") {
                const u = win.__TAURITAVERN__.assets.thumbnailUrl(
                    ttKind,
                    avatarName,
                    useTimestamp
                );
                if (u) urls.push(u);
            } else if (typeof win.__TAURITAVERN_THUMBNAIL__ === "function") {
                const u = win.__TAURITAVERN_THUMBNAIL__(
                    ttKind,
                    avatarName,
                    useTimestamp
                );
                if (u) urls.push(u);
            }
        } catch (_) {
            /* ignore host thumbnail errors and use standard fallback routes */
        }
    }

    const encoded = encodeURIComponent(avatarName);
    const stamp = useTimestamp ? Date.now() : 0;
    const maybeBust = (u) => (useTimestamp ? appendCacheBuster(u, stamp) : u);

    if (isSingleSegment) {
        if (type === CharacterType.CHARACTER) {
            urls.push(maybeBust(`/thumbnail?type=avatar&file=${encoded}`));
            urls.push(maybeBust(`/characters/${encoded}`));
        } else if (type === CharacterType.PERSONA) {
            urls.push(maybeBust(`/User Avatars/${encoded}`));
            urls.push(maybeBust(`/thumbnail?type=persona&file=${encoded}`));
        }
    } else if (avatarName) {
        urls.push(maybeBust(avatarName));
    }

    if (
        fallbackImgSrc &&
        !fallbackImgSrc.endsWith(SYSTEM_AVATAR_MARKER) &&
        !fallbackImgSrc.endsWith(GENERIC_AI_AVATAR_MARKER)
    ) {
        urls.push(useTimestamp ? appendCacheBuster(fallbackImgSrc, stamp) : fallbackImgSrc);
    }

    return [...new Set(urls.filter(Boolean))];
}

/**
 * Decodes URI components cleanly without throwing on stray `%` characters.
 * @param {string} value
 * @returns {string}
 */
function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch (_) {
        return value;
    }
}

/**
 * Extracts a `{ type, file }` hint from any SillyTavern / TauriTavern avatar img src.
 * @param {string} src
 * @param {boolean} isUser
 * @returns {{ type: string, file: string } | null}
 */
function parseAvatarSrc(src, isUser) {
    if (!src) return null;
    if (/^(blob:|data:|about:|javascript:)/i.test(src)) {
        return null;
    }
    if (src.endsWith(SYSTEM_AVATAR_MARKER) || src.endsWith(GENERIC_AI_AVATAR_MARKER)) {
        return null;
    }

    try {
        const parsed = new URL(src, window.location.origin);
        if (/^(blob:|data:|about:|javascript:)$/i.test(parsed.protocol)) {
            return null;
        }

        // Note: URLSearchParams.get() already percent-decodes once; do not decode twice.
        const paramFile = parsed.searchParams.get("file");
        const paramType = parsed.searchParams.get("type");

        if (paramFile) {
            const type =
                paramType === "persona" || isUser
                    ? CharacterType.PERSONA
                    : CharacterType.CHARACTER;
            return { type, file: paramFile };
        }

        const path = parsed.pathname;
        if (path.includes("/User Avatars/") || path.includes("/User%20Avatars/")) {
            const idx = path.lastIndexOf("/");
            const file = safeDecode(path.slice(idx + 1));
            return file ? { type: CharacterType.PERSONA, file } : null;
        }
        if (path.includes("/characters/")) {
            const idx = path.lastIndexOf("/");
            const file = safeDecode(path.slice(idx + 1));
            return file ? { type: CharacterType.CHARACTER, file } : null;
        }

        const lastSeg = safeDecode(path.slice(path.lastIndexOf("/") + 1));
        if (
            lastSeg &&
            lastSeg !== "thumbnail" &&
            !lastSeg.startsWith("five.") &&
            !lastSeg.startsWith("ai4.")
        ) {
            return {
                type: isUser ? CharacterType.PERSONA : CharacterType.CHARACTER,
                file: lastSeg,
            };
        }
    } catch (_) {
        /* ignore malformed URL */
    }

    return null;
}

/**
 * Matches a display name against defined personas.
 * @param {string} name
 * @returns {string | null}
 */
function findPersonaByName(name) {
    if (!name) return null;
    const personas = power_user?.personas;
    if (!personas) return null;
    for (const [avatarId, personaName] of Object.entries(personas)) {
        if (personaName === name) return avatarId;
    }
    return null;
}

/**
 * Resolves the author of a `.mes` element across SillyTavern & TauriTavern.
 * Handles:
 *  - Normal 1-on-1 & group chat messages (via `chat[mesid].original_avatar`)
 *  - TauriTavern `/thumbnail`, host thumbnail helpers & original-image URLs
 *  - "Hide from AI" messages (`is_system="true"` with a character/persona avatar)
 *  - Windowed / virtualized chat surfaces where `ctx.chat[mesid]` may be offset or absent
 *  - Streaming placeholders before `original_avatar` or `img.src` settles
 *
 * Returns `null` for genuine System / Tool messages (`img/five.png`) without throwing.
 *
 * @param {HTMLElement} messageEl
 */
export function resolveMessageAuthor(messageEl) {
    const imgEl = /** @type {HTMLImageElement | null} */ (
        messageEl.querySelector(".mesAvatarWrapper > .avatar > img, .avatar > img")
    );
    const imgSrc = imgEl?.getAttribute("src") || "";

    // True system/narrator avatar -> leave uncolored cleanly.
    if (
        imgSrc &&
        (imgSrc === SYSTEM_AVATAR_MARKER || imgSrc.endsWith("/" + SYSTEM_AVATAR_MARKER))
    ) {
        return null;
    }

    const ctx = getContext();
    const mesIdAttr = messageEl.getAttribute("mesid");
    const mesIndex = mesIdAttr !== null && mesIdAttr !== "" ? Number(mesIdAttr) : NaN;
    const rawMes =
        Number.isInteger(mesIndex) && Array.isArray(ctx.chat) ? ctx.chat[mesIndex] : null;

    const domIsUserAttr = messageEl.getAttribute("is_user");
    const domNameAttr = (
        messageEl.getAttribute("ch_name") ||
        messageEl.querySelector(".name_text")?.textContent ||
        ""
    ).trim();

    // Guard against windowed/shifted chat[] mismatch by verifying basic identity alignment.
    const mes =
        rawMes &&
        (domIsUserAttr === null || Boolean(rawMes.is_user) === (domIsUserAttr === "true")) &&
        (!domNameAttr || !rawMes.name || rawMes.name === domNameAttr)
            ? rawMes
            : null;

    if (
        mes?.force_avatar &&
        (mes.force_avatar === SYSTEM_AVATAR_MARKER ||
            mes.force_avatar.endsWith("/" + SYSTEM_AVATAR_MARKER))
    ) {
        return null;
    }

    const isUser =
        mes?.is_user !== undefined ? Boolean(mes.is_user) : domIsUserAttr === "true";

    const chName = (mes?.name || domNameAttr || "").trim();

    const isSystemFlag = Boolean(
        mes?.is_system || messageEl.getAttribute("is_system") === "true"
    );
    const isToolFloor = Boolean(
        mes?.role === "tool" ||
        mes?.extra?.type === "tool" ||
        messageEl.getAttribute("is_tool") === "true"
    );

    const parsedImg = parseAvatarSrc(imgSrc, isUser);

    if (isSystemFlag && (chName === "System" || !chName) && !mes?.original_avatar && !parsedImg) {
        return null;
    }
    if (isToolFloor && !mes?.original_avatar && !parsedImg) {
        return null;
    }

    // 1. Canonical chat model fields (immune to thumbnail URL rewrites)
    if (!isUser && mes?.original_avatar) {
        return makeAuthor(CharacterType.CHARACTER, mes.original_avatar, imgSrc || null);
    }

    if (isUser) {
        const fromForce = mes?.force_avatar ? parseAvatarSrc(mes.force_avatar, true) : null;
        if (fromForce) {
            return makeAuthor(CharacterType.PERSONA, fromForce.file, imgSrc || null);
        }

        if (parsedImg) {
            return makeAuthor(CharacterType.PERSONA, parsedImg.file, imgSrc || null);
        }

        const byName = findPersonaByName(chName);
        if (byName) {
            return makeAuthor(CharacterType.PERSONA, byName, imgSrc || null);
        }

        if (user_avatar) {
            return makeAuthor(CharacterType.PERSONA, user_avatar, imgSrc || null);
        }
        return null;
    }

    // 2. Parse <img src> or force_avatar (handles /thumbnail?type=avatar&file=..., /characters/..., etc.)
    const fromForce = mes?.force_avatar ? parseAvatarSrc(mes.force_avatar, false) : null;
    if (fromForce) {
        return makeAuthor(fromForce.type, fromForce.file, imgSrc || null);
    }

    if (parsedImg) {
        return makeAuthor(parsedImg.type, parsedImg.file, imgSrc || null);
    }

    // 3. Single-character chat fallback (useful during early streaming before avatar src renders)
    if (!ctx.groupId && hasCharacterId(ctx.characterId)) {
        const currChar = ctx.characters?.[ctx.characterId];
        if (currChar?.avatar && (!chName || chName === currChar.name)) {
            return makeAuthor(CharacterType.CHARACTER, currChar.avatar, imgSrc || null);
        }
    }

    // 4. Group chat / name fallback
    if (chName) {
        if (ctx.groupId && Array.isArray(ctx.groups)) {
            const group = ctx.groups.find((g) => g.id === ctx.groupId);
            if (group?.members && Array.isArray(ctx.characters)) {
                for (const avatar of group.members) {
                    const memberChar = ctx.characters.find((c) => c?.avatar === avatar);
                    if (memberChar?.name === chName) {
                        return makeAuthor(CharacterType.CHARACTER, memberChar.avatar, imgSrc || null);
                    }
                }
            }
        }
        const byCharName = Array.isArray(ctx.characters)
            ? ctx.characters.find((c) => c?.name === chName)
            : null;
        if (byCharName?.avatar) {
            return makeAuthor(CharacterType.CHARACTER, byCharName.avatar, imgSrc || null);
        }
    }

    return null;
}