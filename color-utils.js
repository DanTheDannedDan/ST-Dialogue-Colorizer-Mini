import "./Vibrant.min.js";
import "./color-thief.umd.js";

/** @type {any} */
const Vibrant = window["Vibrant"];
/** @type {any} */
const ColorThief = window["ColorThief"];

const MAX_SWATCH_CACHE = 80;
/** @type {Map<string, Record<string, any>>} */
const swatchCache = new Map();
/** @type {Map<string, Promise<Record<string, any>>>} */
const pendingSwatches = new Map();

/** @type {CSSStyleDeclaration | null} */
let colorProbeStyle = null;

/**
 * Waits for an HTMLImageElement to finish loading.
 * @param {HTMLImageElement} img
 * @returns {Promise<HTMLImageElement>}
 */
export function waitForImage(img) {
    return new Promise((resolve, reject) => {
        if (img.complete) {
            if (img.naturalWidth > 0) {
                resolve(img);
            } else {
                reject(new Error("Image failed to decode (naturalWidth === 0)."));
            }
            return;
        }

        const onLoad = () => {
            cleanup();
            resolve(img);
        };
        const onError = () => {
            cleanup();
            reject(new Error("Image failed to load."));
        };
        const cleanup = () => {
            img.removeEventListener("load", onLoad);
            img.removeEventListener("error", onError);
        };

        img.addEventListener("load", onLoad, { once: true });
        img.addEventListener("error", onError, { once: true });
    });
}

/**
 * Invalidates cached swatch palettes matching a URL or filename fragment.
 * @param {string} fragment
 */
export function invalidateSwatchCache(fragment) {
    if (!fragment) return;
    const encoded = encodeURIComponent(fragment);
    for (const key of swatchCache.keys()) {
        if (key.includes(fragment) || key.includes(encoded)) {
            swatchCache.delete(key);
        }
    }
}

/**
 * Converts RGB (0-255) to HSL (0-1).
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {[number, number, number]}
 */
export function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;

    if (max === min) {
        return [0, 0, l];
    }

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;

    switch (max) {
        case r:
            h = (g - b) / d + (g < b ? 6 : 0);
            break;
        case g:
            h = (b - r) / d + 2;
            break;
        case b:
            h = (r - g) / d + 4;
            break;
    }

    return [h / 6, s, l];
}

/**
 * Converts HSL (0-1) to RGB (0-255).
 * @param {number} h
 * @param {number} s
 * @param {number} l
 * @returns {[number, number, number]}
 */
export function hslToRgb(h, s, l) {
    if (s === 0) {
        const gray = Math.round(l * 255);
        return [gray, gray, gray];
    }

    const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;

    return [
        Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
        Math.round(hue2rgb(p, q, h) * 255),
        Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    ];
}

/**
 * Converts RGB (0-255) to HSV (h: 0-360, s: 0-1, v: 0-1).
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {[number, number, number]}
 */
export function rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    const v = max;
    const s = max === 0 ? 0 : d / max;

    let h = 0;
    if (d !== 0) {
        switch (max) {
            case r:
                h = (g - b) / d + (g < b ? 6 : 0);
                break;
            case g:
                h = (b - r) / d + 2;
                break;
            case b:
                h = (r - g) / d + 4;
                break;
        }
        h *= 60;
    }

    return [h, s, v];
}

/**
 * Converts HSV (h: 0-360, s: 0-1, v: 0-1) to RGB (0-255).
 * @param {number} h
 * @param {number} s
 * @param {number} v
 * @returns {[number, number, number]}
 */
export function hsvToRgb(h, s, v) {
    const hue = ((h % 360) + 360) % 360;
    const c = v * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = v - c;

    let r1 = 0;
    let g1 = 0;
    let b1 = 0;

    if (hue < 60) {
        r1 = c; g1 = x;
    } else if (hue < 120) {
        r1 = x; g1 = c;
    } else if (hue < 180) {
        g1 = c; b1 = x;
    } else if (hue < 240) {
        g1 = x; b1 = c;
    } else if (hue < 300) {
        r1 = x; b1 = c;
    } else {
        r1 = c; b1 = x;
    }

    return [
        Math.round((r1 + m) * 255),
        Math.round((g1 + m) * 255),
        Math.round((b1 + m) * 255),
    ];
}

/**
 * Formats RGB (0-255) as `#rrggbb`.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string}
 */
export function rgbToHex(r, g, b) {
    const hex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Formats RGBA (r,g,b: 0-255, a: 0-255) to a canonical CSS string (`#rrggbb` or `rgba(...)`).
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} [a=255]
 * @returns {string}
 */
export function rgbaToCssString(r, g, b, a = 255) {
    const alpha = Math.max(0, Math.min(255, Math.round(a)));
    if (alpha >= 255) {
        return rgbToHex(r, g, b);
    }
    const alpha01 = Math.round((alpha / 255) * 100) / 100;
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha01})`;
}

/**
 * Parses any valid CSS color string into `{ r, g, b, a }` (all 0-255).
 * Rejects empty strings and `transparent`.
 *
 * @param {any} input
 * @returns {{ r: number, g: number, b: number, a: number } | null}
 */
export function parseCssColor(input) {
    if (typeof input !== "string") return null;
    const value = input.trim();
    if (!value || value.toLowerCase() === "transparent") return null;

    if (!colorProbeStyle) {
        colorProbeStyle = document.createElement("span").style;
    }

    colorProbeStyle.color = "";
    colorProbeStyle.color = value;
    if (!colorProbeStyle.color) return null;

    let normalized = colorProbeStyle.color;

    if (/^(color|oklch|oklab|lab|lch|hwb)\(/i.test(normalized)) {
        const probeEl = document.createElement("span");
        probeEl.style.cssText = `color:${value};position:absolute;visibility:hidden;pointer-events:none;`;
        (document.body || document.documentElement).appendChild(probeEl);
        normalized = getComputedStyle(probeEl).color || normalized;
        probeEl.remove();
    }

    const match = normalized.match(
        /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.%]+))?\s*\)$/i
    );
    if (!match) return null;

    const [, rStr, gStr, bStr, rawAlpha] = match;
    let alpha = 255;
    if (rawAlpha !== undefined) {
        alpha = rawAlpha.endsWith("%")
            ? (parseFloat(rawAlpha) / 100) * 255
            : parseFloat(rawAlpha) * 255;
    }

    return {
        r: Math.max(0, Math.min(255, Math.round(parseFloat(rStr)))),
        g: Math.max(0, Math.min(255, Math.round(parseFloat(gStr)))),
        b: Math.max(0, Math.min(255, Math.round(parseFloat(bStr)))),
        a: Math.max(0, Math.min(255, Math.round(alpha))),
    };
}

/**
 * Normalizes any CSS color string into `#rrggbb` or `rgba(...)`, or `null` if invalid.
 * @param {any} input
 * @returns {string | null}
 */
export function normalizeCssColor(input) {
    const parsed = parseCssColor(input);
    return parsed ? rgbaToCssString(parsed.r, parsed.g, parsed.b, parsed.a) : null;
}

/**
 * Classifies RGB color into a Vibrant.js swatch bucket.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string}
 */
function classifyColor(r, g, b) {
    const [, sNorm, lNorm] = rgbToHsl(r, g, b);
    const saturation = sNorm * 100;
    const lightness = lNorm * 100;

    const vibrancyType = saturation > 40 ? "Vibrant" : "Muted";
    let lightnessType = "";
    if (lightness < 40) lightnessType = "Dark";
    else if (lightness > 60) lightnessType = "Light";

    return lightnessType ? `${lightnessType}${vibrancyType}` : vibrancyType;
}

/**
 * Downscales an image onto an offscreen canvas for fast color extraction.
 * @param {HTMLImageElement} image
 * @param {number} [maxDimension=192]
 * @returns {HTMLCanvasElement}
 */
function createDownscaledCanvas(image, maxDimension = 192) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    let width = image.naturalWidth || image.width;
    let height = image.naturalHeight || image.height;
    if (!width || !height || !ctx) {
        throw new Error("Image has empty dimensions or 2D context unavailable.");
    }

    if (width > height && width > maxDimension) {
        height *= maxDimension / width;
        width = maxDimension;
    } else if (height > maxDimension) {
        width *= maxDimension / height;
        height = maxDimension;
    }

    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    // ColorThief expects naturalWidth/naturalHeight on the element it receives.
    // @ts-ignore
    canvas.naturalWidth = canvas.width;
    // @ts-ignore
    canvas.naturalHeight = canvas.height;

    return canvas;
}

/**
 * Extracts ColorThief swatches as a fallback when Vibrant misses buckets.
 * @param {HTMLCanvasElement} canvas
 * @param {number} [paletteSize=12]
 * @returns {Record<string, { getRgb: () => number[], getHex: () => string }>}
 */
function getColorThiefSwatches(canvas, paletteSize = 12) {
    const colorThief = new ColorThief();
    const palette = colorThief.getPalette(canvas, paletteSize);
    if (!Array.isArray(palette) || palette.length === 0) {
        throw new Error("Color Thief failed to extract palette.");
    }

    const classified = {};
    for (const color of palette) {
        const category = classifyColor(color[0], color[1], color[2]);
        if (category && !classified[category]) {
            classified[category] = {
                getRgb: () => color,
                getHex: () => rgbToHex(color[0], color[1], color[2]),
            };
        }
    }
    return classified;
}

/**
 * Extracts Vibrant + ColorThief swatches from an image, with LRU caching.
 * @param {HTMLImageElement} image
 * @returns {Promise<Record<string, any>>}
 */
async function getSwatchesFromImage(image) {
    await waitForImage(image);
    const cacheKey = image.currentSrc || image.src;

    if (swatchCache.has(cacheKey)) {
        return /** @type {Record<string, any>} */ (swatchCache.get(cacheKey));
    }
    if (pendingSwatches.has(cacheKey)) {
        return /** @type {Promise<Record<string, any>>} */ (pendingSwatches.get(cacheKey));
    }

    const task = (async () => {
        try {
            const canvas = createDownscaledCanvas(image);
            const vibrant = new Vibrant(canvas, 64, 12);
            let swatches = vibrant.swatches();

            const required = [
                "Vibrant", "DarkVibrant", "LightVibrant",
                "Muted", "DarkMuted", "LightMuted",
            ];

            if (required.some((name) => !swatches[name])) {
                try {
                    const fallback = getColorThiefSwatches(canvas, 12);
                    const merged = { ...swatches };
                    for (const name of required) {
                        if (!merged[name] && fallback[name]) {
                            merged[name] = fallback[name];
                        }
                    }
                    swatches = merged;
                } catch (err) {
                    console.debug("[ST Dialogue Colorizer Mini] ColorThief fallback failed:", err);
                }
            }

            swatchCache.set(cacheKey, swatches);
            if (swatchCache.size > MAX_SWATCH_CACHE) {
                const oldest = swatchCache.keys().next().value;
                if (oldest !== undefined) swatchCache.delete(oldest);
            }

            return swatches;
        } finally {
            pendingSwatches.delete(cacheKey);
        }
    })();

    pendingSwatches.set(cacheKey, task);
    return task;
}

/**
 * Filters out colors that are too dark, washed out, or grayish for dialogue text.
 * @param {number[] | null | undefined} rgb
 * @returns {boolean}
 */
function isColorQualityGood(rgb) {
    if (!rgb) return false;
    const [r, g, b] = rgb;
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (luminance < 0.15 || luminance > 0.95) return false;

    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const saturation = max === 0 ? 0 : (max - min) / max;
    return saturation >= 0.25;
}

/**
 * Population-weighted average across available swatches.
 * @param {Record<string, any>} swatches
 * @returns {[number, number, number] | null}
 */
function getAverageColorFromSwatches(swatches) {
    const valid = Object.values(swatches).filter(Boolean);
    if (valid.length === 0) return null;

    let totalR = 0;
    let totalG = 0;
    let totalB = 0;
    let totalPop = 0;

    for (const swatch of valid) {
        const [r, g, b] = swatch.getRgb();
        const pop = swatch.getPopulation ? swatch.getPopulation() : 1;
        totalR += r * pop;
        totalG += g * pop;
        totalB += b * pop;
        totalPop += pop;
    }

    if (totalPop === 0) totalPop = 1;
    return [
        Math.round(totalR / totalPop),
        Math.round(totalG / totalPop),
        Math.round(totalB / totalPop),
    ];
}

/**
 * Extracts the best dialogue color from an avatar image using Avatar Smart logic.
 * @param {HTMLImageElement} image
 * @returns {Promise<[number, number, number] | null>}
 */
export async function getSmartAvatarColor(image) {
    const swatches = await getSwatchesFromImage(image);
    const priority = [
        "Vibrant",
        "DarkVibrant",
        "LightVibrant",
        "Muted",
        "DarkMuted",
        "LightMuted",
    ];

    for (const name of priority) {
        const swatch = swatches[name];
        if (swatch) {
            const rgb = swatch.getRgb();
            if (isColorQualityGood(rgb)) {
                return [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2])];
            }
        }
    }

    return getAverageColorFromSwatches(swatches);
}

/**
 * Adjusts extracted Avatar Smart color into a readable lightness/saturation range
 * for light or dark themes (with vibrancy boost disabled).
 *
 * @param {[number, number, number]} rgb
 * @param {boolean} isLight
 * @returns {[number, number, number]}
 */
export function makeBetterContrast(rgb, isLight) {
    let [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);

    if (s < 0.4) {
        s = Math.min(s + 0.3, 0.8);
    }

    if (isLight) {
        if (l > 0.6) l = 0.45;
        else if (l > 0.4) l = 0.4;
        if (l < 0.2) l = 0.25;
    } else {
        if (l < 0.5) l = 0.65;
        else if (l < 0.7) l = 0.7;
        else if (l > 0.85) l = 0.8;
    }

    return hslToRgb(h, s, l);
}