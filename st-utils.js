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
 * Returns all defined user personas.
 */
export function getAllPersonas() {
    const personas = power_user?.personas ?? {};
    return Object.keys(personas)
        .filter(Boolean)
        .map((avatarId) => makeAuthor(CharacterType.PERSONA, avatarId));
}

/**
 * Returns the currently active persona.
 */
export function getCurrentPersona() {
    const personas = power_user?.personas ?? {};
    if (user_avatar && (user_avatar in personas || typeof user_avatar === "string")) {
        if (user_avatar in personas) {
            return makeAuthor(CharacterType.PERSONA, user_avatar);
        }
    }

    const selectedEl = document.querySelector("#user_avatar_block .avatar.selected[imgfile]");
    const imgfile = selectedEl?.getAttribute("imgfile");
    if (imgfile) {
        const clean = imgfile.slice(imgfile.lastIndexOf("/") + 1);
        if (clean) return makeAuthor(CharacterType.PERSONA, clean);
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
    const avatar = (pole?.getAttribute("value") || pole?.value || "").trim();
    if (!avatar) return null;

    const ctx = getContext();
    const exists = Array.isArray(ctx.characters)
        ? ctx.characters.some((c) => c?.avatar === avatar)
        : true;
    return exists ? makeAuthor(CharacterType.CHARACTER, avatar) : null;
}

/**
 * Builds candidate URLs to load an avatar thumbnail, prioritizing TauriTavern's
 * host thumbnail helper when present and falling back cleanly to SillyTavern routes.
 *
 * @param {string} type
 * @param {string} avatarName
 * @param {string | null} [fallbackImgSrc=null]
 * @returns {string[]}
 */
export function getAvatarCandidateUrls(type, avatarName, fallbackImgSrc = null) {
    /** @type {string[]} */
    const urls = [];
    const ttKind = type === CharacterType.PERSONA ? "persona" : "avatar";
    const win = /** @type {any} */ (window);

    try {
        if (typeof win.__TAURITAVERN__?.assets?.thumbnailUrl === "function") {
            const u = win.__TAURITAVERN__.assets.thumbnailUrl(ttKind, avatarName);
            if (u) urls.push(u);
        } else if (typeof win.__TAURITAVERN_THUMBNAIL__ === "function") {
            const u = win.__TAURITAVERN_THUMBNAIL__(ttKind, avatarName);
            if (u) urls.push(u);
        }
    } catch (_) {
        /* ignore host thumbnail errors and use standard fallback routes */
    }

    const encoded = encodeURIComponent(avatarName);
    if (type === CharacterType.CHARACTER) {
        urls.push(`/thumbnail?type=avatar&file=${encoded}`);
        urls.push(`/characters/${encoded}`);
    } else if (type === CharacterType.PERSONA) {
        urls.push(`/User Avatars/${encoded}`);
        urls.push(`/thumbnail?type=persona&file=${encoded}`);
    }

    if (
        fallbackImgSrc &&
        !fallbackImgSrc.endsWith(SYSTEM_AVATAR_MARKER) &&
        !fallbackImgSrc.endsWith(GENERIC_AI_AVATAR_MARKER)
    ) {
        urls.push(fallbackImgSrc);
    }

    return [...new Set(urls.filter(Boolean))];
}

/**
 * Extracts a `{ type, file }` hint from any SillyTavern / TauriTavern avatar img src.
 * @param {string} src
 * @param {boolean} isUser
 * @returns {{ type: string, file: string } | null}
 */
function parseAvatarSrc(src, isUser) {
    if (!src) return null;
    if (src.endsWith(SYSTEM_AVATAR_MARKER) || src.endsWith(GENERIC_AI_AVATAR_MARKER)) {
        return null;
    }

    try {
        const parsed = new URL(src, window.location.origin);
        const paramFile = parsed.searchParams.get("file");
        const paramType = parsed.searchParams.get("type");

        if (paramFile) {
            const type =
                paramType === "persona" || isUser
                    ? CharacterType.PERSONA
                    : CharacterType.CHARACTER;
            return { type, file: safeDecode(paramFile) };
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
        if (lastSeg && !lastSeg.startsWith("five.") && !lastSeg.startsWith("ai4.")) {
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
 *  - TauriTavern `/thumbnail` & original-image URLs
 *  - "Hide from AI" messages (`is_system="true"` with a character/persona avatar)
 *  - Streaming placeholders before `original_avatar` or `img.src` settles
 *
 * Returns `null` for genuine System messages (`img/five.png`) without throwing.
 *
 * @param {HTMLElement} messageEl
 */
export function resolveMessageAuthor(messageEl) {
    const imgEl = /** @type {HTMLImageElement | null} */ (
        messageEl.querySelector(".mesAvatarWrapper > .avatar > img, .avatar > img")
    );
    const imgSrc = imgEl?.getAttribute("src") || "";

    // True system/narrator avatar -> leave uncolored cleanly.
    if (imgSrc && (imgSrc === SYSTEM_AVATAR_MARKER || imgSrc.endsWith("/" + SYSTEM_AVATAR_MARKER))) {
        return null;
    }

    const ctx = getContext();
    const mesIdAttr = messageEl.getAttribute("mesid");
    const mesIndex = mesIdAttr !== null && mesIdAttr !== "" ? Number(mesIdAttr) : NaN;
    const mes = Number.isInteger(mesIndex) && Array.isArray(ctx.chat) ? ctx.chat[mesIndex] : null;

    if (mes?.force_avatar && (mes.force_avatar === SYSTEM_AVATAR_MARKER || mes.force_avatar.endsWith("/" + SYSTEM_AVATAR_MARKER))) {
        return null;
    }

    const isUser =
        mes?.is_user !== undefined
            ? Boolean(mes.is_user)
            : messageEl.getAttribute("is_user") === "true";

    const chName = (
        mes?.name ||
        messageEl.getAttribute("ch_name") ||
        messageEl.querySelector(".name_text")?.textContent ||
        ""
    ).trim();

    const isTrueSystem =
        (mes?.is_system || messageEl.getAttribute("is_system") === "true") &&
        chName === "System" &&
        !mes?.original_avatar;

    if (isTrueSystem) {
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

        const fromSrc = parseAvatarSrc(imgSrc, true);
        if (fromSrc) {
            return makeAuthor(CharacterType.PERSONA, fromSrc.file, imgSrc || null);
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

    // 2. Parse <img src> (handles /thumbnail?type=avatar&file=..., /characters/..., etc.)
    const fromForce = mes?.force_avatar ? parseAvatarSrc(mes.force_avatar, false) : null;
    if (fromForce) {
        return makeAuthor(fromForce.type, fromForce.file, imgSrc || null);
    }

    const fromSrc = parseAvatarSrc(imgSrc, false);
    if (fromSrc) {
        return makeAuthor(fromSrc.type, fromSrc.file, imgSrc || null);
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