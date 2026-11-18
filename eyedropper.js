/**
 * Whether the native EyeDropper API is present on window.
 * @returns {boolean}
 */
export function isNativeEyeDropperSupported() {
    return typeof window !== "undefined" && "EyeDropper" in window;
}

/**
 * Samples a 3x3 region around the clicked viewport coordinates on an <img>,
 * accounting for `object-fit: cover` / `contain`.
 *
 * @param {HTMLImageElement} img
 * @param {number} clientX
 * @param {number} clientY
 * @returns {string | null} `#rrggbb` hex string, or null on failure.
 */
export function samplePixelFromImage(img, clientX, clientY) {
    try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) return null;

        const rect = img.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;

        let u = (clientX - rect.left) / rect.width;
        let v = (clientY - rect.top) / rect.height;

        const fit = getComputedStyle(img).objectFit;
        const imgAspect = w / h;
        const boxAspect = rect.width / rect.height;

        if (fit === "cover" && Math.abs(imgAspect - boxAspect) > 0.001) {
            if (imgAspect > boxAspect) {
                const scale = boxAspect / imgAspect;
                u = (u - 0.5) * scale + 0.5;
            } else {
                const scale = imgAspect / boxAspect;
                v = (v - 0.5) * scale + 0.5;
            }
        } else if (fit === "contain" && Math.abs(imgAspect - boxAspect) > 0.001) {
            if (imgAspect > boxAspect) {
                const scale = imgAspect / boxAspect;
                v = (v - 0.5) * scale + 0.5;
            } else {
                const scale = boxAspect / imgAspect;
                u = (u - 0.5) * scale + 0.5;
            }
        }

        u = Math.min(1, Math.max(0, u));
        v = Math.min(1, Math.max(0, v));

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0, w, h);

        const px = Math.min(w - 1, Math.max(0, Math.round(u * (w - 1))));
        const py = Math.min(h - 1, Math.max(0, Math.round(v * (h - 1))));

        const sx = Math.max(0, px - 1);
        const sy = Math.max(0, py - 1);
        const sw = Math.min(3, w - sx);
        const sh = Math.min(3, h - sy);
        const data = ctx.getImageData(sx, sy, sw, sh).data;

        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;

        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 16) continue;
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            count++;
        }

        if (count === 0) return null;

        const toHex = (n) => Math.round(n / count).toString(16).padStart(2, "0");
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    } catch (err) {
        console.warn("[ST Dialogue Colorizer Mini] Pixel sampling failed:", err);
        return null;
    }
}

/**
 * Click-on-avatar eyedropper fallback for WebViews / browsers without EyeDropper
 * (including TauriTavern on macOS, iOS, Linux, Android, and restricted WebView2).
 *
 * @returns {Promise<string | null>}
 */
export function pickFromAvatarByClick() {
    return new Promise((resolve) => {
        document.body.classList.add("sdc-eyedropper-active");

        /** @param {string | null} value */
        function finish(value) {
            document.body.classList.remove("sdc-eyedropper-active");
            document.removeEventListener("click", onClick, true);
            document.removeEventListener("keydown", onKey, true);
            resolve(value);
        }

        /** @param {MouseEvent} e */
        function onClick(e) {
            const target = /** @type {HTMLElement | null} */ (e.target);
            if (!target) {
                finish(null);
                return;
            }

            let img = target instanceof HTMLImageElement ? target : null;
            if (!img) {
                const container = target.closest(".avatar, .mesAvatarWrapper, #avatar_load_preview, .avatar_div");
                img = /** @type {HTMLImageElement | null} */ (
                    container?.querySelector("img") ?? target.querySelector?.("img") ?? null
                );
            }

            e.preventDefault();
            e.stopPropagation();

            if (!(img instanceof HTMLImageElement)) {
                finish(null);
                return;
            }

            finish(samplePixelFromImage(img, e.clientX, e.clientY));
        }

        /** @param {KeyboardEvent} e */
        function onKey(e) {
            if (e.key === "Escape") {
                e.preventDefault();
                finish(null);
            }
        }

        document.addEventListener("click", onClick, true);
        document.addEventListener("keydown", onKey, true);
    });
}

/**
 * Picks a color using the native EyeDropper when available and functional,
 * seamlessly falling back to click-on-avatar sampling in TauriTavern / non-Chromium WebViews.
 *
 * @returns {Promise<string | null>}
 */
export async function pickColor() {
    if (isNativeEyeDropperSupported()) {
        try {
            // @ts-ignore - EyeDropper not present in older lib.dom
            const dropper = new EyeDropper();
            const result = await dropper.open();
            return result?.sRGBHex ?? null;
        } catch (err) {
            if (err && err.name === "AbortError") {
                return null;
            }
            console.debug("[ST Dialogue Colorizer Mini] Native EyeDropper unavailable in WebView, falling back to click-on-avatar:", err);
        }
    }

    return pickFromAvatarByClick();
}