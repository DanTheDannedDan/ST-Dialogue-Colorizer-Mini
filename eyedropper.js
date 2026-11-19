import { parseCssColor, rgbToHex } from "./color-utils.js";
import { getAvatarCandidateUrls, isTauriTavern } from "./st-utils.js";

const LOUPE_GRID = 11; // 11x11 pixels around cursor
const LOUPE_SCALE = 9; // 99x99 canvas

/** @type {(() => void) | null} */
let activeAbortFn = null;

/**
 * Whether the native screen EyeDropper API should be used as primary.
 * Returns `false` inside TauriTavern WebViews (where native EyeDropper is unsupported
 * or broken across WebView2 / WKWebView / WebKitGTK / mobile) and on touch devices.
 *
 * @returns {boolean}
 */
export function isNativeEyeDropperSupported() {
    if (typeof window === "undefined") return false;
    if (!("EyeDropper" in window)) return false;
    if (isTauriTavern()) return false;
    if (window.matchMedia?.("(pointer: coarse)").matches && !window.matchMedia?.("(hover: hover)").matches) {
        return false;
    }
    return true;
}

/**
 * Whether an interactive in-app eyedropper session is currently open.
 * @returns {boolean}
 */
export function isEyedropperActive() {
    return activeAbortFn !== null;
}

/**
 * Cancels any currently running in-app eyedropper session.
 */
export function closeActiveEyedropper() {
    if (activeAbortFn) {
        const fn = activeAbortFn;
        activeAbortFn = null;
        fn();
    }
}

/**
 * Parses a single CSS `object-position` or `background-position` token into pixel offset.
 * @param {string} token
 * @param {number} freeSpace
 * @returns {number}
 */
function parsePositionToken(token, freeSpace) {
    if (!token) return freeSpace * 0.5;
    if (token.endsWith("%")) {
        const pct = parseFloat(token);
        return Number.isFinite(pct) ? (pct / 100) * freeSpace : freeSpace * 0.5;
    }
    if (token.endsWith("px")) {
        const px = parseFloat(token);
        return Number.isFinite(px) ? px : freeSpace * 0.5;
    }
    if (token === "left" || token === "top") return 0;
    if (token === "right" || token === "bottom") return freeSpace;
    return freeSpace * 0.5;
}

/**
 * Parses a 2-token position string (e.g. "50% 50%" or "10px 20px").
 * @param {string} raw
 * @returns {[string, string]}
 */
function splitPositionTokens(raw) {
    const parts = (raw || "50% 50%").trim().split(/\s+/);
    if (parts.length >= 2) {
        return [parts[0], parts[1]];
    }
    return [parts[0] || "50%", "50%"];
}

/**
 * Maps viewport coordinates `(clientX, clientY)` onto natural image coordinates `(px, py)`
 * for an `<img>` element, accounting for padding, border, `object-fit`, and `object-position`.
 *
 * @param {HTMLImageElement} img
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{ px: number, py: number, w: number, h: number, inside: boolean } | null}
 */
function mapClientToImagePixel(img, clientX, clientY) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;

    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const cs = getComputedStyle(img);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const padT = parseFloat(cs.paddingTop) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0;
    const brdL = parseFloat(cs.borderLeftWidth) || 0;
    const brdR = parseFloat(cs.borderRightWidth) || 0;
    const brdT = parseFloat(cs.borderTopWidth) || 0;
    const brdB = parseFloat(cs.borderBottomWidth) || 0;

    const boxLeft = rect.left + brdL + padL;
    const boxTop = rect.top + brdT + padT;
    const boxW = rect.width - brdL - brdR - padL - padR;
    const boxH = rect.height - brdT - brdB - padT - padB;
    if (boxW <= 0 || boxH <= 0) return null;

    const fit = cs.objectFit || "fill";
    let renW = boxW;
    let renH = boxH;

    if (fit === "contain") {
        const scale = Math.min(boxW / w, boxH / h);
        renW = w * scale;
        renH = h * scale;
    } else if (fit === "cover") {
        const scale = Math.max(boxW / w, boxH / h);
        renW = w * scale;
        renH = h * scale;
    } else if (fit === "none") {
        renW = w;
        renH = h;
    } else if (fit === "scale-down") {
        const scale = Math.min(1, Math.min(boxW / w, boxH / h));
        renW = w * scale;
        renH = h * scale;
    }

    const [posX, posY] = splitPositionTokens(cs.objectPosition);
    const imgLeft = boxLeft + parsePositionToken(posX, boxW - renW);
    const imgTop = boxTop + parsePositionToken(posY, boxH - renH);

    const u = (clientX - imgLeft) / renW;
    const v = (clientY - imgTop) / renH;
    const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;

    const cu = Math.min(1, Math.max(0, u));
    const cv = Math.min(1, Math.max(0, v));

    return {
        px: Math.min(w - 1, Math.max(0, Math.floor(cu * w))),
        py: Math.min(h - 1, Math.max(0, Math.floor(cv * h))),
        w,
        h,
        inside,
    };
}

/**
 * Extracts a pixel buffer for an `<img>` element into a lightweight offscreen canvas.
 * Falls back to `fetch(src)` -> `Blob` -> `createImageBitmap` if the initial canvas is tainted.
 *
 * @param {HTMLImageElement} img
 * @returns {Promise<{ width: number, height: number, data: Uint8ClampedArray } | null>}
 */
async function readImagePixelsAsync(img) {
    const syncRes = readImagePixelsSync(img);
    if (syncRes && !syncRes.tainted) return syncRes.buffer;

    const src = img.currentSrc || img.src;
    if (!src) return null;

    try {
        const resp = await fetch(src, { credentials: "same-origin" });
        if (!resp.ok) return null;
        const blob = await resp.blob();
        const bmp = await createImageBitmap(blob);
        try {
            const canvas = document.createElement("canvas");
            canvas.width = bmp.width;
            canvas.height = bmp.height;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) return null;
            ctx.drawImage(bmp, 0, 0);
            const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
            return { width: bmp.width, height: bmp.height, data };
        } finally {
            bmp.close?.();
        }
    } catch (_) {
        return null;
    }
}

/**
 * Synchronous pixel buffer extraction for same-origin `<img>` elements.
 * @param {HTMLImageElement} img
 * @returns {{ tainted: boolean, buffer: { width: number, height: number, data: Uint8ClampedArray } | null }}
 */
function readImagePixelsSync(img) {
    try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) return { tainted: false, buffer: null };

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return { tainted: false, buffer: null };
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        return { tainted: false, buffer: { width: w, height: h, data } };
    } catch (err) {
        const isSecurity = err && (err.name === "SecurityError" || /tainted/i.test(String(err)));
        return { tainted: Boolean(isSecurity), buffer: null };
    }
}

/**
 * Samples a 3x3 region around the clicked viewport coordinates on an `<img>`,
 * accounting for `object-fit`, `object-position`, padding, and border.
 *
 * @param {HTMLImageElement} img
 * @param {number} clientX
 * @param {number} clientY
 * @returns {string | null} `#rrggbb` hex string, or null on failure.
 */
export function samplePixelFromImage(img, clientX, clientY) {
    try {
        const mapped = mapClientToImagePixel(img, clientX, clientY);
        if (!mapped) return null;
        const { buffer } = readImagePixelsSync(img);
        if (!buffer) return null;

        const sx = Math.max(0, mapped.px - 1);
        const sy = Math.max(0, mapped.py - 1);
        const ex = Math.min(buffer.width - 1, mapped.px + 1);
        const ey = Math.min(buffer.height - 1, mapped.py + 1);

        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;

        for (let y = sy; y <= ey; y++) {
            for (let x = sx; x <= ex; x++) {
                const idx = (y * buffer.width + x) * 4;
                if (buffer.data[idx + 3] < 16) continue;
                r += buffer.data[idx];
                g += buffer.data[idx + 1];
                b += buffer.data[idx + 2];
                count++;
            }
        }

        if (count === 0) return null;
        return rgbToHex(r / count, g / count, b / count);
    } catch (err) {
        console.warn("[ST Dialogue Colorizer Mini] Pixel sampling failed:", err);
        return null;
    }
}

/**
 * Extracts first CSS `url(...)` from a `background-image` computed value.
 * @param {string} bgImage
 * @returns {string | null}
 */
function extractBackgroundImageUrl(bgImage) {
    if (!bgImage || bgImage === "none") return null;
    const match = bgImage.match(/url\(\s*(['"]?)(.*?)\1\s*\)/i);
    return match && match[2] ? match[2] : null;
}

/**
 * Maps viewport coordinates onto a CSS `background-image` buffer.
 * @param {HTMLElement} el
 * @param {{ width: number, height: number, data: Uint8ClampedArray }} buffer
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{ px: number, py: number } | null}
 */
function mapClientToBackgroundPixel(el, buffer, clientX, clientY) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const cs = getComputedStyle(el);

    const w = buffer.width;
    const h = buffer.height;
    const size = (cs.backgroundSize || "auto").trim().toLowerCase();

    let renW = w;
    let renH = h;
    if (size === "cover") {
        const scale = Math.max(rect.width / w, rect.height / h);
        renW = w * scale;
        renH = h * scale;
    } else if (size === "contain") {
        const scale = Math.min(rect.width / w, rect.height / h);
        renW = w * scale;
        renH = h * scale;
    } else if (size !== "auto") {
        const parts = size.split(/\s+/);
        const parseDim = (tok, base, otherBase, aspectScale) => {
            if (!tok || tok === "auto") return null;
            if (tok.endsWith("%")) return (parseFloat(tok) / 100) * base;
            if (tok.endsWith("px")) return parseFloat(tok);
            return otherBase * aspectScale;
        };
        const rw = parseDim(parts[0], rect.width, h, w / h);
        const rh = parseDim(parts[1] ?? "auto", rect.height, w, h / w);
        if (rw && rh) {
            renW = rw;
            renH = rh;
        } else if (rw) {
            renW = rw;
            renH = rw * (h / w);
        } else if (rh) {
            renH = rh;
            renW = rh * (w / h);
        }
    }

    const posX = cs.backgroundPositionX || "50%";
    const posY = cs.backgroundPositionY || "50%";
    const left = rect.left + parsePositionToken(posX, rect.width - renW);
    const top = rect.top + parsePositionToken(posY, rect.height - renH);

    let u = (clientX - left) / renW;
    let v = (clientY - top) / renH;

    const repeat = (cs.backgroundRepeat || "repeat").toLowerCase();
    if (repeat.includes("no-repeat")) {
        if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    } else {
        u = ((u % 1) + 1) % 1;
        v = ((v % 1) + 1) % 1;
    }

    return {
        px: Math.min(w - 1, Math.max(0, Math.floor(u * w))),
        py: Math.min(h - 1, Math.max(0, Math.floor(v * h))),
    };
}

/**
 * Checks if `(clientX, clientY)` sits directly over a rendered text glyph
 * and returns that text's computed RGB hex color if so.
 *
 * @param {number} clientX
 * @param {number} clientY
 * @returns {string | null}
 */
function sampleTextGlyphColorAtPoint(clientX, clientY) {
    try {
        /** @type {Text | null} */
        let textNode = null;
        let offset = 0;

        if (typeof document.caretPositionFromPoint === "function") {
            const pos = document.caretPositionFromPoint(clientX, clientY);
            if (pos && pos.offsetNode?.nodeType === Node.TEXT_NODE) {
                textNode = /** @type {Text} */ (pos.offsetNode);
                offset = pos.offset;
            }
        } else if (typeof document.caretRangeFromPoint === "function") {
            const range = document.caretRangeFromPoint(clientX, clientY);
            if (range && range.startContainer?.nodeType === Node.TEXT_NODE) {
                textNode = /** @type {Text} */ (range.startContainer);
                offset = range.startOffset;
            }
        }

        if (!textNode || !textNode.data) return null;
        const parentEl = textNode.parentElement;
        if (!parentEl || parentEl.closest("#sdc-eyedropper-hud, #sdc-eyedropper-avatar-dock, #sdc-eyedropper-loupe")) {
            return null;
        }

        const len = textNode.data.length;
        if (len === 0) return null;
        const start = Math.max(0, Math.min(len - 1, offset));
        const checkOffsets = start > 0 ? [start, start - 1] : [start];

        for (const idx of checkOffsets) {
            if (!textNode.data[idx] || /\s/.test(textNode.data[idx])) continue;
            const r = document.createRange();
            r.setStart(textNode, idx);
            r.setEnd(textNode, Math.min(len, idx + 1));
            const rects = r.getClientRects();
            for (let i = 0; i < rects.length; i++) {
                const box = rects[i];
                if (
                    clientX >= box.left - 1 &&
                    clientX <= box.right + 1 &&
                    clientY >= box.top - 1 &&
                    clientY <= box.bottom + 1
                ) {
                    const parsed = parseCssColor(getComputedStyle(parentEl).color);
                    if (parsed && parsed.a > 16) {
                        return rgbToHex(parsed.r, parsed.g, parsed.b);
                    }
                }
            }
        }
    } catch (_) {
        /* ignore caret range errors */
    }
    return null;
}

/**
 * Composites visible CSS background colors down the `elementsFromPoint` stack.
 * @param {Element[]} stack
 * @returns {string | null}
 */
function sampleCompositedBackgroundColor(stack) {
    let accR = 0;
    let accG = 0;
    let accB = 0;
    let remainAlpha = 1;

    for (const el of stack) {
        if (!(el instanceof HTMLElement || el instanceof SVGElement)) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        const parsed = parseCssColor(cs.backgroundColor);
        if (!parsed || parsed.a <= 0) continue;

        const srcA = (parsed.a / 255) * remainAlpha;
        accR += parsed.r * srcA;
        accG += parsed.g * srcA;
        accB += parsed.b * srcA;
        remainAlpha *= 1 - parsed.a / 255;

        if (remainAlpha <= 0.02) break;
    }

    const totalOpaque = 1 - remainAlpha;
    if (totalOpaque < 0.05) return null;

    // Composite remaining fraction over neutral dark backdrop if semi-transparent
    const r = accR + 24 * remainAlpha;
    const g = accG + 24 * remainAlpha;
    const b = accB + 24 * remainAlpha;
    return rgbToHex(r, g, b);
}

/**
 * Interactive In-App Magnifier Eyedropper.
 * Works reliably across TauriTavern (WebView2, WKWebView, WebKitGTK, Android, iOS)
 * and every desktop/mobile browser without relying on `window.EyeDropper`.
 *
 * @param {object} [options]
 * @param {{ type: string, avatarName: string, fallbackImgSrc?: string | null } | null} [options.author]
 * @param {HTMLElement | null} [options.triggerElement]
 * @returns {Promise<string | null>}
 */
export function pickFromAvatarByClick(options = {}) {
    closeActiveEyedropper();

    const { author = null, triggerElement = null } = options;

    return new Promise((resolve) => {
        let finished = false;
        let rafId = 0;
        let latestPointer = null;
        let lastHex = null;
        let dockVisible = false;
        let avatarBuffer = null;

        /** @type {Map<string, { width: number, height: number, data: Uint8ClampedArray }>} */
        const pixelCache = new Map();
        /** @type {Set<string>} */
        const loadingUrls = new Set();

        const isCoarse = Boolean(window.matchMedia?.("(pointer: coarse)").matches);

        document.body.classList.add("sdc-eyedropper-active");

        // -----------------------------------------------------------------
        // Build HUD Pill, Avatar Quick-Sample Dock, and 11x11 Magnifier Loupe
        // -----------------------------------------------------------------
        const hud = document.createElement("div");
        hud.id = "sdc-eyedropper-hud";
        hud.setAttribute("role", "status");

        const chip = document.createElement("span");
        chip.className = "sdc-ed-chip";

        const hexLabel = document.createElement("span");
        hexLabel.className = "sdc-ed-hex";
        hexLabel.textContent = "#------";

        const hint = document.createElement("span");
        hint.className = "sdc-ed-hint";
        hint.textContent = isCoarse
            ? "Tap any color/image or drag on avatar"
            : "Click any image or color · Esc to cancel";

        const avatarToggleBtn = document.createElement("button");
        avatarToggleBtn.type = "button";
        avatarToggleBtn.className = "menu_button sdc-ed-btn";
        avatarToggleBtn.innerHTML = '<i class="fa-solid fa-image"></i><span>Avatar</span>';
        avatarToggleBtn.title = "Toggle enlarged avatar sampler";
        avatarToggleBtn.style.display = author ? "inline-flex" : "none";

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "menu_button sdc-ed-btn sdc-ed-cancel";
        cancelBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        cancelBtn.title = "Cancel eyedropper (Esc)";

        hud.append(chip, hexLabel, hint, avatarToggleBtn, cancelBtn);

        const dock = document.createElement("div");
        dock.id = "sdc-eyedropper-avatar-dock";
        dock.style.display = "none";

        const dockHeader = document.createElement("div");
        dockHeader.className = "sdc-ed-dock-header";
        const dockTitle = document.createElement("span");
        dockTitle.textContent = "Sample Avatar";
        const dockCloseBtn = document.createElement("button");
        dockCloseBtn.type = "button";
        dockCloseBtn.className = "menu_button sdc-ed-dock-close";
        dockCloseBtn.innerHTML = '<i class="fa-solid fa-minus"></i>';
        dockCloseBtn.title = "Minimize avatar sampler";
        dockHeader.append(dockTitle, dockCloseBtn);

        const dockCanvas = document.createElement("canvas");
        dockCanvas.className = "sdc-ed-avatar-canvas";
        dockCanvas.width = 192;
        dockCanvas.height = 192;
        const dockCtx = dockCanvas.getContext("2d", { willReadFrequently: true });

        dock.append(dockHeader, dockCanvas);

        const loupe = document.createElement("div");
        loupe.id = "sdc-eyedropper-loupe";
        loupe.style.display = "none";

        const loupeCanvas = document.createElement("canvas");
        loupeCanvas.className = "sdc-ed-loupe-canvas";
        loupeCanvas.width = LOUPE_GRID * LOUPE_SCALE;
        loupeCanvas.height = LOUPE_GRID * LOUPE_SCALE;
        const loupeCtx = loupeCanvas.getContext("2d");

        const loupeBadge = document.createElement("div");
        loupeBadge.className = "sdc-ed-loupe-badge";
        loupeBadge.textContent = "#------";

        loupe.append(loupeCanvas, loupeBadge);

        document.body.append(hud, dock, loupe);

        function setDockVisible(show) {
            dockVisible = show;
            dock.style.display = show ? "flex" : "none";
            avatarToggleBtn.classList.toggle("sdc-ed-btn-active", show);
        }

        // Load author avatar into Dock canvas if provided
        if (author) {
            const hasVisibleAuthorImg = (() => {
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const imgs = document.querySelectorAll(
                    "#avatar_load_preview, #user_avatar_block .avatar.selected img, .mes .avatar img"
                );
                for (const el of imgs) {
                    const src = el.getAttribute("src") || "";
                    if (!src) continue;
                    const enc = encodeURIComponent(author.avatarName);
                    if (!src.includes(author.avatarName) && !src.includes(enc)) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width > 16 && r.height > 16 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw) {
                        return true;
                    }
                }
                return false;
            })();

            if (isCoarse || !hasVisibleAuthorImg) {
                setDockVisible(true);
            }

            (async () => {
                const candidates = getAvatarCandidateUrls(
                    author.type,
                    author.avatarName,
                    author.fallbackImgSrc ?? null
                );
                for (const url of candidates) {
                    if (finished) return;
                    const img = await new Promise((res) => {
                        const im = new Image();
                        im.onload = () => res(im.naturalWidth > 0 ? im : null);
                        im.onerror = () => res(null);
                        im.src = url;
                    });
                    if (!img || finished || !dockCtx) continue;

                    const iw = img.naturalWidth;
                    const ih = img.naturalHeight;
                    const scale = Math.min(dockCanvas.width / iw, dockCanvas.height / ih);
                    const dw = Math.round(iw * scale);
                    const dh = Math.round(ih * scale);
                    const dx = Math.round((dockCanvas.width - dw) / 2);
                    const dy = Math.round((dockCanvas.height - dh) / 2);

                    dockCtx.clearRect(0, 0, dockCanvas.width, dockCanvas.height);
                    dockCtx.drawImage(img, dx, dy, dw, dh);
                    try {
                        const data = dockCtx.getImageData(0, 0, dockCanvas.width, dockCanvas.height).data;
                        avatarBuffer = { width: dockCanvas.width, height: dockCanvas.height, data };
                    } catch (_) {
                        avatarBuffer = null;
                    }
                    break;
                }
            })();
        }

        // -----------------------------------------------------------------
        // Buffer Loading & Sampling Helpers
        // -----------------------------------------------------------------
        function ensureUrlBufferAsync(url) {
            if (!url || pixelCache.has(url) || loadingUrls.has(url)) return;
            loadingUrls.add(url);
            fetch(url, { credentials: "same-origin" })
                .then((r) => (r.ok ? r.blob() : null))
                .then((blob) => (blob ? createImageBitmap(blob) : null))
                .then((bmp) => {
                    if (!bmp || finished) {
                        bmp?.close?.();
                        return;
                    }
                    try {
                        const c = document.createElement("canvas");
                        c.width = bmp.width;
                        c.height = bmp.height;
                        const ctx = c.getContext("2d", { willReadFrequently: true });
                        if (!ctx) return;
                        ctx.drawImage(bmp, 0, 0);
                        const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
                        if (pixelCache.size > 12) {
                            const oldest = pixelCache.keys().next().value;
                            if (oldest !== undefined) pixelCache.delete(oldest);
                        }
                        pixelCache.set(url, { width: bmp.width, height: bmp.height, data });
                    } finally {
                        bmp.close?.();
                    }
                })
                .catch(() => { /* ignore */ })
                .finally(() => {
                    loadingUrls.delete(url);
                });
        }

        function getImgBufferCached(img) {
            const key = img.currentSrc || img.src;
            if (!key) return null;
            if (pixelCache.has(key)) return pixelCache.get(key);
            const { tainted, buffer } = readImagePixelsSync(img);
            if (buffer) {
                if (pixelCache.size > 12) {
                    const oldest = pixelCache.keys().next().value;
                    if (oldest !== undefined) pixelCache.delete(oldest);
                }
                pixelCache.set(key, buffer);
                return buffer;
            }
            if (tainted) {
                ensureUrlBufferAsync(key);
            }
            return null;
        }

        function getBgBufferCached(url) {
            if (!url) return null;
            if (pixelCache.has(url)) return pixelCache.get(url);
            ensureUrlBufferAsync(url);
            return null;
        }

        /**
         * Reads a pixel color and optional 11x11 buffer patch at `(clientX, clientY)`.
         * @param {number} clientX
         * @param {number} clientY
         * @returns {{ hex: string, buffer?: { width: number, height: number, data: Uint8ClampedArray }, px?: number, py?: number } | null}
         */
        function sampleScreenPointSync(clientX, clientY) {
            // 1. Direct hit on our Avatar Quick-Sample Dock Canvas
            if (dockVisible && avatarBuffer) {
                const dr = dockCanvas.getBoundingClientRect();
                if (
                    clientX >= dr.left &&
                    clientX <= dr.right &&
                    clientY >= dr.top &&
                    clientY <= dr.bottom &&
                    dr.width > 0 &&
                    dr.height > 0
                ) {
                    const px = Math.min(
                        avatarBuffer.width - 1,
                        Math.max(0, Math.floor(((clientX - dr.left) / dr.width) * avatarBuffer.width))
                    );
                    const py = Math.min(
                        avatarBuffer.height - 1,
                        Math.max(0, Math.floor(((clientY - dr.top) / dr.height) * avatarBuffer.height))
                    );
                    const idx = (py * avatarBuffer.width + px) * 4;
                    if (avatarBuffer.data[idx + 3] >= 16) {
                        return {
                            hex: rgbToHex(
                                avatarBuffer.data[idx],
                                avatarBuffer.data[idx + 1],
                                avatarBuffer.data[idx + 2]
                            ),
                            buffer: avatarBuffer,
                            px,
                            py,
                        };
                    }
                }
            }

            const stack = document
                .elementsFromPoint(clientX, clientY)
                .filter(
                    (el) =>
                        !hud.contains(el) &&
                        !dock.contains(el) &&
                        !loupe.contains(el)
                );

            // 2. Inspect images, canvases, and CSS background images in visual z-order
            for (const el of stack) {
                if (el instanceof HTMLImageElement && el.complete && (el.naturalWidth || el.width)) {
                    const mapped = mapClientToImagePixel(el, clientX, clientY);
                    if (!mapped || !mapped.inside) continue;
                    const buffer = getImgBufferCached(el);
                    if (buffer) {
                        const idx = (mapped.py * buffer.width + mapped.px) * 4;
                        if (buffer.data[idx + 3] >= 16) {
                            return {
                                hex: rgbToHex(
                                    buffer.data[idx],
                                    buffer.data[idx + 1],
                                    buffer.data[idx + 2]
                                ),
                                buffer,
                                px: mapped.px,
                                py: mapped.py,
                            };
                        }
                    }
                } else if (el instanceof HTMLCanvasElement && el.width > 0 && el.height > 0) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        const cx = Math.min(
                            el.width - 1,
                            Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * el.width))
                        );
                        const cy = Math.min(
                            el.height - 1,
                            Math.max(0, Math.floor(((clientY - rect.top) / rect.height) * el.height))
                        );
                        try {
                            const ctx = el.getContext("2d", { willReadFrequently: true });
                            if (ctx) {
                                const patchHalf = Math.floor(LOUPE_GRID / 2);
                                const sx = Math.max(0, cx - patchHalf);
                                const sy = Math.max(0, cy - patchHalf);
                                const sw = Math.min(LOUPE_GRID, el.width - sx);
                                const sh = Math.min(LOUPE_GRID, el.height - sy);
                                const p = ctx.getImageData(cx, cy, 1, 1).data;
                                if (p[3] >= 16) {
                                    const patchData = ctx.getImageData(sx, sy, sw, sh).data;
                                    return {
                                        hex: rgbToHex(p[0], p[1], p[2]),
                                        buffer: { width: sw, height: sh, data: patchData },
                                        px: cx - sx,
                                        py: cy - sy,
                                    };
                                }
                            }
                        } catch (_) {
                            /* tainted canvas */
                        }
                    }
                } else if (el instanceof HTMLElement) {
                    const bgUrl = extractBackgroundImageUrl(getComputedStyle(el).backgroundImage);
                    if (bgUrl) {
                        const buffer = getBgBufferCached(bgUrl);
                        if (buffer) {
                            const mapped = mapClientToBackgroundPixel(el, buffer, clientX, clientY);
                            if (mapped) {
                                const idx = (mapped.py * buffer.width + mapped.px) * 4;
                                if (buffer.data[idx + 3] >= 16) {
                                    return {
                                        hex: rgbToHex(
                                            buffer.data[idx],
                                            buffer.data[idx + 1],
                                            buffer.data[idx + 2]
                                        ),
                                        buffer,
                                        px: mapped.px,
                                        py: mapped.py,
                                    };
                                }
                            }
                        }
                    }
                }
            }

            // 3. Direct text glyph hit (e.g. picking another character's dialogue color)
            const glyphHex = sampleTextGlyphColorAtPoint(clientX, clientY);
            if (glyphHex) {
                return { hex: glyphHex };
            }

            // 4. Composited CSS background color
            const bgHex = sampleCompositedBackgroundColor(stack);
            if (bgHex) {
                return { hex: bgHex };
            }

            return null;
        }

        /**
         * Async fallback on click in case an image hadn't finished decoding into the cache yet.
         */
        async function sampleScreenPointAsync(clientX, clientY) {
            const syncHit = sampleScreenPointSync(clientX, clientY);
            if (syncHit) return syncHit;

            const stack = document
                .elementsFromPoint(clientX, clientY)
                .filter((el) => !hud.contains(el) && !dock.contains(el) && !loupe.contains(el));

            for (const el of stack) {
                if (el instanceof HTMLImageElement && el.complete && (el.naturalWidth || el.width)) {
                    const mapped = mapClientToImagePixel(el, clientX, clientY);
                    if (!mapped || !mapped.inside) continue;
                    const buf = await readImagePixelsAsync(el);
                    if (buf) {
                        const idx = (mapped.py * buf.width + mapped.px) * 4;
                        if (buf.data[idx + 3] >= 16) {
                            return { hex: rgbToHex(buf.data[idx], buf.data[idx + 1], buf.data[idx + 2]) };
                        }
                    }
                }
            }
            return null;
        }

        // -----------------------------------------------------------------
        // Loupe Rendering
        // -----------------------------------------------------------------
        function renderLoupe(clientX, clientY, sample, aboveFinger) {
            if (!sample || !loupeCtx) {
                loupe.style.display = "none";
                return;
            }

            lastHex = sample.hex;
            chip.style.backgroundColor = sample.hex;
            hexLabel.textContent = sample.hex;
            loupeBadge.textContent = sample.hex;

            const half = Math.floor(LOUPE_GRID / 2);
            loupeCtx.imageSmoothingEnabled = false;

            if (sample.buffer && sample.px !== undefined && sample.py !== undefined) {
                const { width, height, data } = sample.buffer;
                for (let dy = -half; dy <= half; dy++) {
                    for (let dx = -half; dx <= half; dx++) {
                        const sx = sample.px + dx;
                        const sy = sample.py + dy;
                        let fill = "#202024";
                        if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
                            const idx = (sy * width + sx) * 4;
                            const a = data[idx + 3];
                            if (a >= 16) {
                                fill = `rgb(${data[idx]}, ${data[idx + 1]}, ${data[idx + 2]})`;
                            }
                        }
                        loupeCtx.fillStyle = fill;
                        loupeCtx.fillRect(
                            (dx + half) * LOUPE_SCALE,
                            (dy + half) * LOUPE_SCALE,
                            LOUPE_SCALE,
                            LOUPE_SCALE
                        );
                    }
                }
            } else {
                loupeCtx.fillStyle = sample.hex;
                loupeCtx.fillRect(0, 0, loupeCanvas.width, loupeCanvas.height);
            }

            // Crisp center pixel reticle
            const cx = half * LOUPE_SCALE;
            const cy = half * LOUPE_SCALE;
            loupeCtx.strokeStyle = "#000000";
            loupeCtx.lineWidth = 2;
            loupeCtx.strokeRect(cx - 1, cy - 1, LOUPE_SCALE + 2, LOUPE_SCALE + 2);
            loupeCtx.strokeStyle = "#ffffff";
            loupeCtx.lineWidth = 1;
            loupeCtx.strokeRect(cx, cy, LOUPE_SCALE, LOUPE_SCALE);

            loupe.style.display = "flex";
            const lw = loupe.offsetWidth || 108;
            const lh = loupe.offsetHeight || 126;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const margin = 8;

            let left = clientX + (aboveFinger ? -lw / 2 : 18);
            let top = aboveFinger ? clientY - lh - 28 : clientY + 18;

            if (!aboveFinger) {
                if (left + lw > vw - margin) left = clientX - lw - 18;
                if (top + lh > vh - margin) top = clientY - lh - 18;
            }
            left = Math.max(margin, Math.min(vw - lw - margin, left));
            top = Math.max(margin, Math.min(vh - lh - margin, top));

            loupe.style.left = `${Math.round(left)}px`;
            loupe.style.top = `${Math.round(top)}px`;
        }

        // -----------------------------------------------------------------
        // Teardown & Event Wiring
        // -----------------------------------------------------------------
        function finish(value) {
            if (finished) return;
            finished = true;
            if (activeAbortFn === abortSession) {
                activeAbortFn = null;
            }
            if (rafId) {
                cancelAnimationFrame(rafId);
                rafId = 0;
            }

            document.body.classList.remove("sdc-eyedropper-active");
            document.removeEventListener("pointermove", onDocPointerMove, true);
            document.removeEventListener("click", onDocClick, true);
            document.removeEventListener("keydown", onDocKeyDown, true);

            pixelCache.clear();
            loadingUrls.clear();
            avatarBuffer = null;

            hud.remove();
            dock.remove();
            loupe.remove();
            resolve(value);
        }

        function abortSession() {
            finish(null);
        }

        activeAbortFn = abortSession;

        avatarToggleBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            setDockVisible(!dockVisible);
        });

        dockCloseBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            setDockVisible(false);
        });

        cancelBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            finish(null);
        });

        // Touch & mouse drag-to-aim inside the Avatar Quick-Sample Dock
        let dockDragging = false;
        let dockDragMoved = false;
        let dockStartX = 0;
        let dockStartY = 0;

        dockCanvas.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 && e.pointerType === "mouse") return;
            e.preventDefault();
            e.stopPropagation();
            dockDragging = true;
            dockDragMoved = false;
            dockStartX = e.clientX;
            dockStartY = e.clientY;
            try {
                dockCanvas.setPointerCapture?.(e.pointerId);
            } catch (_) {
                /* noop */
            }
            const sample = sampleScreenPointSync(e.clientX, e.clientY);
            renderLoupe(e.clientX, e.clientY, sample, e.pointerType !== "mouse");
        });

        dockCanvas.addEventListener("pointermove", (e) => {
            if (!dockDragging) return;
            if (Math.hypot(e.clientX - dockStartX, e.clientY - dockStartY) > 4) {
                dockDragMoved = true;
            }
            const sample = sampleScreenPointSync(e.clientX, e.clientY);
            renderLoupe(e.clientX, e.clientY, sample, e.pointerType !== "mouse");
        });

        const endDockDrag = (e) => {
            if (!dockDragging) return;
            dockDragging = false;
            try {
                dockCanvas.releasePointerCapture?.(e.pointerId);
            } catch (_) {
                /* noop */
            }
            const sample = sampleScreenPointSync(e.clientX, e.clientY);
            if (sample?.hex) {
                finish(sample.hex);
            } else if (dockDragMoved && lastHex) {
                finish(lastHex);
            }
        };

        dockCanvas.addEventListener("pointerup", endDockDrag);
        dockCanvas.addEventListener("pointercancel", () => {
            dockDragging = false;
            loupe.style.display = "none";
        });

        function onDocPointerMove(e) {
            if (dockDragging) return;
            if (e.pointerType === "touch") return;
            latestPointer = { x: e.clientX, y: e.clientY };
            if (!rafId) {
                rafId = requestAnimationFrame(() => {
                    rafId = 0;
                    if (finished || !latestPointer) return;
                    if (
                        hud.contains(document.elementFromPoint(latestPointer.x, latestPointer.y)) ||
                        dockHeader.contains(document.elementFromPoint(latestPointer.x, latestPointer.y))
                    ) {
                        loupe.style.display = "none";
                        return;
                    }
                    const sample = sampleScreenPointSync(latestPointer.x, latestPointer.y);
                    renderLoupe(latestPointer.x, latestPointer.y, sample, false);
                });
            }
        }

        async function onDocClick(e) {
            const target = /** @type {Node | null} */ (e.target);
            if (target && triggerElement && triggerElement.contains(target)) {
                return;
            }
            if (target && (hud.contains(target) || dock.contains(target))) {
                return;
            }

            e.preventDefault();
            e.stopPropagation();

            const hit = await sampleScreenPointAsync(e.clientX, e.clientY);
            if (finished) return;
            if (hit?.hex) {
                finish(hit.hex);
            } else {
                hint.textContent = "No color sampled there — click an image or press Cancel";
            }
        }

        function onDocKeyDown(e) {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                finish(null);
            }
        }

        document.addEventListener("pointermove", onDocPointerMove, true);
        document.addEventListener("click", onDocClick, true);
        document.addEventListener("keydown", onDocKeyDown, true);
    });
}

/**
 * Picks a color using the native EyeDropper when available and reliable
 * (desktop non-Tauri browsers), seamlessly falling back to the In-App
 * Magnifier Eyedropper in TauriTavern / mobile / non-Chromium WebViews.
 *
 * @param {object} [options]
 * @param {{ type: string, avatarName: string, fallbackImgSrc?: string | null } | null} [options.author]
 * @param {HTMLElement | null} [options.triggerElement]
 * @returns {Promise<string | null>}
 */
export async function pickColor(options = {}) {
    if (isNativeEyeDropperSupported()) {
        const startedAt = performance.now();
        try {
            // @ts-ignore - EyeDropper not present in older lib.dom
            const dropper = new EyeDropper();
            const result = await dropper.open();
            return result?.sRGBHex ?? null;
        } catch (err) {
            const elapsed = performance.now() - startedAt;
            // Respect genuine user Esc cancel (> 200ms); otherwise fall back on WebView errors/instant aborts.
            if (err && err.name === "AbortError" && elapsed > 200) {
                return null;
            }
            console.debug(
                "[ST Dialogue Colorizer Mini] Native EyeDropper unavailable or blocked, falling back to In-App Eyedropper:",
                err
            );
        }
    }

    return pickFromAvatarByClick(options);
}