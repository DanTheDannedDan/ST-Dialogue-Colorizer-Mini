import { EventEmitter } from "../../../../lib/eventemitter.js";
import { user_avatar } from "../../../../script.js";
import { getContext } from "../../../extensions.js";
import { power_user } from "../../../power-user.js";
import { STCharacter, CharacterType } from "./STCharacter.js";

//#region Events

export const expEventSource = new EventEmitter();
export const exp_event_type = {
    /**
     * Emitted when the character card panel is changed to a different character. 
     * Receives an {@linkcode STCharacter} object representing the newly-selected character.
     * @param {STCharacter} character An object representing the new character.
     */
    CHAR_CARD_CHANGED: "char_card_changed",
    /**
     * Emitted when a new persona is added to the DOM.
     * Receives an {@linkcode STCharacter} object representing the created persona.
     * @param {STCharacter} persona An object representing the new persona.
     */
    PERSONA_ADDED: "persona_added",
    /**
     * Emitted when a persona is removed from the DOM. 
     * Receives an {@linkcode STCharacter} object representing the removed persona.
     * @param {STCharacter} persona An object representing the removed persona.
     */
    PERSONA_REMOVED: "persona_removed",
    /**
     * Emitted when the user changes persona. 
     * Receives an {@linkcode STCharacter} object representing the newly-selected persona.
     * @param {STCharacter} persona An object representing the selected persona.
     */
    PERSONA_CHANGED: "persona_changed",
    /**
     * Emitted when a message is added to the chat.
     * Receives the message element that was added.
     * @param {HTMLElement} addedMessage
     */
    MESSAGE_ADDED: "message_added",
    /**
     * Emitted when a message is removed from the chat.
     * Receives the message element that was removed.
     * @param {HTMLElement} removedMessage
     */
    MESSAGE_REMOVED: "message_removed",
    /**
     * Emitted once the `#chat` MutationObserver has successfully attached.
     * Lets listeners tag messages that were rendered before we were watching.
     */
    CHAT_OBSERVER_READY: "chat_observer_ready",
};

/**
 * 
 * @param {MutationRecord[]} mutationList 
 * @param {MutationObserver} observer 
 */
function onCharCardChanged(mutationList, observer) {
    for (const mutation of mutationList) {
        const target = /** @type {HTMLElement} */ (mutation.target);

        const avatarFilePath = target.getAttribute("value");
        if (!avatarFilePath) {
            continue;
        }

        // fromAvatar validates against the character list and can throw (e.g.
        // during list init, or for a transient/unknown avatar). Swallow it so a
        // single bad mutation doesn't spam the console or break the observer.
        try {
            const stChar = STCharacter.fromAvatar(CharacterType.CHARACTER, avatarFilePath);
            expEventSource.emit(exp_event_type.CHAR_CARD_CHANGED, stChar);
        } catch (err) {
            console.debug("[Palette Talk] Ignoring unresolved char card change:", err);
        }
    }
}

/**
 * 
 * @param {MutationRecord[]} mutationList 
 * @param {MutationObserver} observer 
 */
function onPersonasChanged(mutationList, observer) {
    for (const mutation of mutationList) {
        const target = /** @type {HTMLElement} */ (mutation.target);
        if (mutation.type === "attributes") {
            if (!target.classList.contains("selected")) {
                continue;
            }
            
            const stChar = getSTCharFromAvatarElem(target);
            if (!stChar) {
                continue;
            }
            expEventSource.emit(exp_event_type.PERSONA_CHANGED, stChar);
        }
        else if (mutation.type === "childList") {
            for (const removedNode of mutation.removedNodes) {
                if (!(removedNode instanceof HTMLElement)) {
                    continue;
                }

                if (!removedNode.classList.contains("avatar")) {
                    continue;
                }

                const stChar = getSTCharFromAvatarElem(removedNode);
                if (!stChar) {
                    continue;
                }
                expEventSource.emit(exp_event_type.PERSONA_REMOVED, stChar);
            }
            for (const addedNode of mutation.addedNodes) {
                if (!(addedNode instanceof HTMLElement)) {
                    continue;
                }

                if (!addedNode.classList.contains("avatar")) {
                    continue;
                }

                const stChar = getSTCharFromAvatarElem(addedNode);
                if (!stChar) {
                    continue;
                }
                expEventSource.emit(exp_event_type.PERSONA_ADDED, stChar);
            }
        }
    }

    function getSTCharFromAvatarElem(avatarElem) {
        const avatarFilePath = avatarElem.getAttribute("imgfile");
        if (!avatarFilePath) {
            return null;
        }

        const avatarFileName = avatarFilePath.slice(avatarFilePath.lastIndexOf('/') + 1);
        try {
            return STCharacter.fromAvatar(CharacterType.PERSONA, avatarFileName);
        } catch (err) {
            console.debug("[Palette Talk] Ignoring unresolved persona avatar:", err);
            return null;
        }
    }
}

/**
 * 
 * @param {MutationRecord[]} mutationList 
 * @param {MutationObserver} observer 
 */
function onChatChanged(mutationList, observer) {
    for (const mutation of mutationList) {
        for (const removedNode of mutation.removedNodes) {
            if (!(removedNode instanceof HTMLElement)) {
                continue;
            }
            if (!removedNode.classList.contains("mes"))
                continue;

            expEventSource.emit(exp_event_type.MESSAGE_REMOVED, removedNode);
        }
        
        for (const addedNode of mutation.addedNodes) {
            if (!(addedNode instanceof HTMLElement)) {
                continue;
            }
            if (!addedNode.classList.contains("mes"))
                continue;

            expEventSource.emit(exp_event_type.MESSAGE_ADDED, addedNode);
        }
    }
}

// Track every observer we create so they can be torn down on hot-reload.
/** @type {MutationObserver[]} */
const stObservers = [];

/** @type {number[]} Pending retry timers, cleared on dispose. */
const stRetryTimers = [];

/**
 * Safely observes a target, retrying until the node exists.
 *
 * This module is evaluated at import time, which can happen well before
 * SillyTavern has finished building its DOM (`#chat`, `#form_create`,
 * `#user_avatar_block` are all created lazily). The previous implementation
 * bailed out permanently on the first miss, which silently disabled message
 * tagging — and with it the whole name-based ("Send As" NPC) colouring path.
 *
 * We now poll on a bounded schedule and only give up after `maxAttempts`.
 *
 * @param {string} elementId
 * @param {MutationCallback} callback
 * @param {MutationObserverInit} config
 * @param {(el: HTMLElement) => (Element | null)} [resolveTarget]
 * @param {(target: Element) => void} [onAttached] Called once the observer is live.
 */
function safeObserve(elementId, callback, config, resolveTarget, onAttached) {
    const intervalMs = 250;
    const maxAttempts = 120; // ~30s — generous enough for a slow first paint.
    let attempts = 0;

    const attempt = () => {
        attempts++;
        const root = document.getElementById(elementId);
        const target = root ? (resolveTarget ? resolveTarget(root) : root) : null;

        if (target) {
            const observer = new MutationObserver(callback);
            observer.observe(target, config);
            stObservers.push(observer);
            try {
                onAttached?.(target);
            } catch (err) {
                console.warn(`[Palette Talk] onAttached handler for '#${elementId}' failed:`, err);
            }
            return;
        }

        if (attempts >= maxAttempts) {
            console.warn(`[Palette Talk] Element '#${elementId}' never appeared; related updates disabled.`);
            return;
        }

        stRetryTimers.push(window.setTimeout(attempt, intervalMs));
    };

    attempt();
}

//#region charCardChanged
safeObserve(
    "form_create",
    onCharCardChanged,
    { attributeFilter: ["value"] },
    (form) => form.querySelector("input#avatar_url_pole")
);
//#endregion

//#region personaChanged
safeObserve(
    "user_avatar_block",
    onPersonasChanged,
    { subtree: true, attributeFilter: ["class"], childList: true }
);
//#endregion

//#region chatChanged
safeObserve("chat", onChatChanged, { childList: true }, undefined, () => {
    // The chat node may have appeared with messages already rendered (late
    // attach, or a chat restored on startup). Announce readiness so listeners
    // can tag whatever is already on screen.
    expEventSource.emit(exp_event_type.CHAT_OBSERVER_READY);
});
//#endregion

/**
 * Disconnects all internal MutationObservers. Called on hot-reload/dispose so
 * a re-install without a full page reload doesn't leave stale observers running.
 */
export function disposeStObservers() {
    for (const timerId of stRetryTimers.splice(0)) {
        clearTimeout(timerId);
    }

    for (const observer of stObservers) {
        try {
            observer.disconnect();
        } catch (_) {
            /* noop */
        }
    }
    stObservers.length = 0;
}

//#endregion Events

/**
 * Returns a value indicating whether the user is currently in any chat.
 * 
 * @returns {boolean}
 */
export function isInAnyChat() {
    return isInCharacterChat() || isInGroupChat();
}

/**
 * Returns a value indicating whether the user is currently in a user-to-character chat.
 * 
 * @returns {boolean}
 */
export function isInCharacterChat() {
    // NB: characterId can legitimately be 0 (the first character), so a plain
    // truthiness check would wrongly report "no chat" for that character.
    const characterId = getContext().characterId;
    return characterId !== undefined && characterId !== null && characterId !== "";
}

/**
 * Returns a value indicating whether the user is currently in a group chat.
 * 
 * @returns {boolean}
 */
export function isInGroupChat() {
    return !!getContext().groupId;
}

/**
 * Gets all characters as a list of {@linkcode STCharacter} objects.
 * 
 * @returns {STCharacter[]}
 */
export function getAllCharacters() {
    return Object.values(getContext().characters).map(
        (char) => STCharacter.fromAvatar(CharacterType.CHARACTER, char.avatar)
    );
}

/**
 * Gets all of the user's personas as a list of {@linkcode STCharacter} objects.
 * 
 * @returns {STCharacter[]}
 */
export function getAllPersonas() {
    return Object.entries(power_user.personas).map(
        ([avatarId, name]) => STCharacter.fromAvatar(CharacterType.PERSONA, avatarId)
    );
}

/**
 * Gets the user's currently selected persona.
 * @returns {STCharacter}
 */
export function getCurrentPersona() {
    return STCharacter.fromAvatar(CharacterType.PERSONA, user_avatar);
}

/**
 * Gets the current chat character as an {@linkcode STCharacter}.
 * 
 * @returns {STCharacter?} The current character, or `null` if not currently in a user-to-character chat.
 */
export function getCurrentCharacter() {
    const stContext = getContext();
    const currCharIndex = stContext.characterId;
    // characterId can be 0, so check for absence explicitly rather than falsiness.
    if (currCharIndex === undefined || currCharIndex === null || currCharIndex === "")
        return null;

    const character = stContext.characters[currCharIndex];
    if (!character)
        return null;

    return STCharacter.fromAvatar(CharacterType.CHARACTER, character.avatar);
}

/**
 * Gets the character members in the current group chat as a list of {@linkcode STCharacter} objects.
 * 
 * @returns {STCharacter[]?} An array containing the characters in the current group chat, or `null` if not currently in a group chat.
 */
export function getCurrentGroupCharacters() {
    const stContext = getContext();
    const currGroupId = stContext.groupId;
    if (!currGroupId)
        return null;

    const currGroup = stContext.groups.find(group => group.id === currGroupId);
    if (!currGroup)
        return null;

    return currGroup.members
        .map(charAvatar => {
            try {
                return STCharacter.fromAvatar(CharacterType.CHARACTER, charAvatar);
            } catch (err) {
                console.debug("[Palette Talk] Skipping unresolved group member:", charAvatar, err);
                return null;
            }
        })
        .filter(Boolean);
}

/**
 * Gets the character that is currently being or was last edited. This is not necessarily the current character,
 * as a character's card can be edited from a group chat.
 * 
 * @returns {STCharacter?}
 */
export function getCharacterBeingEdited() {
    // Resolve lazily: the element may not exist at module-load time, and looking
    // it up on demand avoids a hard dependency during initialization.
    const avatarUrlPole = document.getElementById("avatar_url_pole");
    const avatar = avatarUrlPole?.getAttribute("value");
    if (!avatar) {
        return null;
    }
    return STCharacter.fromAvatar(CharacterType.CHARACTER, avatar);
}

/**
 * Gets the author of the given message as an {@link STCharacter}.
 * 
 * @param {HTMLElement} message 
 * @returns {STCharacter?} The author of the message, or `null` if the author couldn't be determined.
 */
export function getMessageAuthor(message) {
    /** @type {HTMLImageElement} */
    const avatarThumbImg = message.querySelector(".mesAvatarWrapper > .avatar > img");
    if (!avatarThumbImg) {
        return null;
    }
    const avatarThumbSrc = avatarThumbImg.getAttribute("src");

    const isUser = message.getAttribute("is_user") === "true";
    // workaround for bug(?) in ST ('/sys {msg}' does not set 'is_system' attr to 'true')
    const isSystem = message.getAttribute("is_system") === "true" || avatarThumbSrc === STCharacter.System.avatarImageThumbnailFilePath;

    /** @type {CharacterType} */
    let charType;
    if (isUser)
        charType = CharacterType.PERSONA;
    else if (isSystem)
        charType = CharacterType.SYSTEM;
    else
        charType = CharacterType.CHARACTER;

    const avatarFileName = getAvatarFileNameFromImgSrc(charType, avatarThumbSrc);
    return STCharacter.fromAvatar(charType, avatarFileName);
}

/**
 * @param {CharacterType} charType
 * @param {string} imageSrc
 * @returns {string?}
 */
function getAvatarFileNameFromImgSrc(charType, imageSrc) {
    let split = imageSrc.split('/').pop();
    switch (charType) {
        case CharacterType.CHARACTER:
            const charThumbRegexp = /\?type=avatar&file=(.*)/i;
            const charMatch = split.match(charThumbRegexp)?.at(1);
            return charMatch ? decodeURIComponent(charMatch) : split;
        case CharacterType.PERSONA:
            // TODO: Needs uri decode?
            const userThumbRegexp = /\?type=persona&file=(.*)/i;
            const userMatch = split.match(userThumbRegexp)?.at(1);
            return userMatch ? decodeURIComponent(userMatch) : split;
            // It turns out, this did in fact need a uri decode
        case CharacterType.SYSTEM:
            return imageSrc;
        default:
            return null;
    }
}
