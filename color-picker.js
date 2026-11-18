import {
    hsvToRgb,
    parseCssColor,
    rgbToHex,
    rgbToHsv,
    rgbaToCssString,
} from "./color-utils.js";

/** @type {(() => void) | null} */
let activeCloseFn = null;
/** @type {HTMLElement | null} */
let activeAnchor = null;

/**
 * Closes any currently open color picker popover.
 */
export function closeColorPickerPopover() {
    if (activeCloseFn) {
        const fn = activeCloseFn;
        activeCloseFn = null;
        activeAnchor = null;
        fn();
    }
}

/**
 * Opens a self-contained, WebView-safe HSV+Alpha color picker popover anchored to `anchor`.
 * Replaces native `<input type="color">` which breaks across TauriTavern WebViews.
 * Uses Pointer Events + `requestAnimationFrame` coalescing for lag-free dragging.
 *
 * @param {object} options
 * @param {HTMLElement} options.anchor
 * @param {string} options.initialColor
 * @param {(cssColor: string) => void} options.onInput
 * @param {(cssColor: string) => void} options.onCommit
 * @param {() => void} [options.onClose]
 */
export function openColorPickerPopover({
    anchor,
    initialColor,
    onInput,
    onCommit,
    onClose,
}) {
    if (activeAnchor === anchor && activeCloseFn) {
        closeColorPickerPopover();
        return;
    }
    closeColorPickerPopover();

    const parsed = parseCssColor(initialColor) ?? { r: 225, g: 138, b: 36, a: 255 };
    const [initH, initS, initV] = rgbToHsv(parsed.r, parsed.g, parsed.b);

    let h = initH;
    let s = initS;
    let v = initV;
    let a = parsed.a / 255;
    let dirty = false;
    let rafId = 0;
    let pendingCss = "";

    const popover = document.createElement("div");
    popover.className = "sdc-picker-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Dialogue Color Picker");

    // 2D Saturation / Value plane
    const svBox = document.createElement("div");
    svBox.className = "sdc-cp-sv";
    const svWhite = document.createElement("div");
    svWhite.className = "sdc-cp-sv-white";
    const svBlack = document.createElement("div");
    svBlack.className = "sdc-cp-sv-black";
    const svThumb = document.createElement("div");
    svThumb.className = "sdc-cp-sv-thumb";
    svBox.append(svWhite, svBlack, svThumb);

    // Hue bar
    const hueBar = document.createElement("div");
    hueBar.className = "sdc-cp-hue";
    const hueThumb = document.createElement("div");
    hueThumb.className = "sdc-cp-bar-thumb";
    hueBar.appendChild(hueThumb);

    // Alpha bar
    const alphaBar = document.createElement("div");
    alphaBar.className = "sdc-cp-alpha";
    const alphaGrad = document.createElement("div");
    alphaGrad.className = "sdc-cp-alpha-grad";
    const alphaThumb = document.createElement("div");
    alphaThumb.className = "sdc-cp-bar-thumb";
    alphaBar.append(alphaGrad, alphaThumb);

    // Compact readout footer
    const footer = document.createElement("div");
    footer.className = "sdc-cp-footer";
    const previewChip = document.createElement("span");
    previewChip.className = "sdc-cp-chip";
    const readout = document.createElement("span");
    readout.className = "sdc-cp-readout";
    footer.append(previewChip, readout);

    popover.append(svBox, hueBar, alphaBar, footer);
    document.body.appendChild(popover);

    function currentCssColor() {
        const [r, g, b] = hsvToRgb(h, s, v);
        return rgbaToCssString(r, g, b, Math.round(a * 255));
    }

    function syncVisuals() {
        const [r, g, b] = hsvToRgb(h, s, v);
        const opaqueHex = rgbToHex(r, g, b);
        const cssColor = rgbaToCssString(r, g, b, Math.round(a * 255));

        svBox.style.backgroundColor = `hsl(${Math.round(h)}, 100%, 50%)`;
        svThumb.style.left = `${s * 100}%`;
        svThumb.style.top = `${(1 - v) * 100}%`;

        hueThumb.style.left = `${(h / 360) * 100}%`;

        alphaGrad.style.background = `linear-gradient(to right, rgba(${r}, ${g}, ${b}, 0), ${opaqueHex})`;
        alphaThumb.style.left = `${a * 100}%`;

        previewChip.style.backgroundColor = cssColor;
        readout.textContent = cssColor;
        return cssColor;
    }

    function emitLive(cssColor) {
        dirty = true;
        pendingCss = cssColor;
        if (!rafId) {
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                onInput(pendingCss);
            });
        }
    }

    function flushCommit() {
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
        }
        if (dirty) {
            dirty = false;
            const cssColor = currentCssColor();
            onInput(cssColor);
            onCommit(cssColor);
        }
    }

    function positionPopover() {
        if (!document.body.contains(anchor)) {
            closeColorPickerPopover();
            return;
        }
        const rect = anchor.getBoundingClientRect();
        const popW = popover.offsetWidth || 224;
        const popH = popover.offsetHeight || 220;
        const margin = 8;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let left = rect.left;
        if (left + popW > vw - margin) {
            left = vw - popW - margin;
        }
        left = Math.max(margin, left);

        let top = rect.bottom + 6;
        if (top + popH > vh - margin) {
            const aboveTop = rect.top - popH - 6;
            top = aboveTop >= margin ? aboveTop : Math.max(margin, vh - popH - margin);
        }

        popover.style.left = `${Math.round(left)}px`;
        popover.style.top = `${Math.round(top)}px`;
    }

    /**
     * Attaches smooth pointer capture dragging to a surface.
     * @param {HTMLElement} surface
     * @param {(nx: number, ny: number) => void} onMove
     */
    function bindDrag(surface, onMove) {
        let dragging = false;

        const updateFromEvent = (e) => {
            const rect = surface.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            const nx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            const ny = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
            onMove(nx, ny);
            emitLive(syncVisuals());
        };

        surface.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 && e.pointerType === "mouse") return;
            e.preventDefault();
            dragging = true;
            surface.setPointerCapture?.(e.pointerId);
            updateFromEvent(e);
        });

        surface.addEventListener("pointermove", (e) => {
            if (!dragging) return;
            updateFromEvent(e);
        });

        const endDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            try {
                surface.releasePointerCapture?.(e.pointerId);
            } catch (_) {
                /* noop */
            }
            flushCommit();
        };

        surface.addEventListener("pointerup", endDrag);
        surface.addEventListener("pointercancel", endDrag);
    }

    bindDrag(svBox, (nx, ny) => {
        s = nx;
        v = 1 - ny;
    });

    bindDrag(hueBar, (nx) => {
        h = Math.min(359.99, Math.max(0, nx * 360));
    });

    bindDrag(alphaBar, (nx) => {
        a = Math.round(nx * 100) / 100;
    });

    function onDocPointerDown(e) {
        const target = /** @type {Node | null} */ (e.target);
        if (target && (popover.contains(target) || anchor.contains(target))) {
            return;
        }
        closeColorPickerPopover();
    }

    function onDocKeyDown(e) {
        if (e.key === "Escape") {
            e.preventDefault();
            closeColorPickerPopover();
        }
    }

    function onViewportChange() {
        positionPopover();
    }

    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
    window.addEventListener("resize", onViewportChange);

    syncVisuals();
    positionPopover();

    activeAnchor = anchor;
    activeCloseFn = () => {
        flushCommit();
        document.removeEventListener("pointerdown", onDocPointerDown, true);
        document.removeEventListener("keydown", onDocKeyDown, true);
        window.removeEventListener("resize", onViewportChange);
        popover.remove();
        onClose?.();
    };
}