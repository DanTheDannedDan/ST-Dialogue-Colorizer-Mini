/**
 * @typedef {[number, number, number, number?]} ColorArray
 */

/**
 * @typedef {object} RgbaObject
 * @property {number} r - The red value (0-255).
 * @property {number} g - The green value (0-255).
 * @property {number} b - The blue value (0-255).
 * @property {number=} a - The alpha value (0-255).
 */

/**
 * @typedef {object} HslaObject
 * @property {number} h - The hue value (0-1).
 * @property {number} s - The saturation value (0-1).
 * @property {number} l - The luminosity value (0-1).
 * @property {number=} a - The alpha value (0-1).
 */

/**
 * Provides many utility methods to convert between color representations.
 */
export class ExColor {
    /** @type {ColorArray?} */ #rgba;
    /** @type {ColorArray?} */ #hsla;
    /** @type {String?} */ #hex;

    /**
     * @hideconstructor 
     * Use the static constructor functions `ExColor.fromRgb()` and `ExColor.fromHsl()` instead.
     * 
     * Creates a new `ExColor` object with the specified RGB values. At least one object must be provided.
     * 
     * @param {ColorArray | RgbaObject | null} rgba An array of numbers `[r, g, b, a?]` or an object `{ r: number, g: number, b: number, a?: number }`. 
     * Numbers should be within the range `0-255`.
     * 
     * @param {ColorArray | HslaObject | null} hsla An array of numbers `[h, s, l, a?]` or an object `{ h: number, s: number, l: number, a?: number }`. 
     * Numbers should be within the range `0-1`.
     * 
     * 
     * The only validation done is checking for an array or an object for performance reasons.
     */
    constructor(rgba, hsla) {
        if (!rgba && !hsla)
            throw new Error(`No arguments provided to constructor.`);

        if (rgba) {
            if (Array.isArray(rgba)) {
                this.#rgba = rgba;
            } else if (typeof rgba === 'object') {
                this.#rgba = [rgba.r, rgba.g, rgba.b, rgba.a];
            } else {
                throw new TypeError(`Unsupported data type '${typeof rgba}'.`);
            }
        }

        if (hsla) {
            if (Array.isArray(hsla)) {
                this.#hsla = hsla;
            } else if (typeof hsla === 'object') {
                this.#hsla = [hsla.h, hsla.s, hsla.l, hsla.a];
            } else {
                throw new TypeError(`Unsupported data type '${typeof hsla}'.`);
            }
        }
    }

    /**
     * 
     * @returns {RgbaObject}
     */
    toRgb() {
        if (!this.#rgba) {
            this.#rgba = ExColor.hsl2rgb(this.#hsla);
        }
        
        const [r, g, b, a] = this.#rgba;
        return {r, g, b, a};
    }

    /**
     * 
     * @returns {HslaObject}
     */
    toHsl() {
        if (!this.#hsla) {
            this.#hsla = ExColor.rgb2hsl(this.#rgba);
        }

        const [h, s, l, a] = this.#hsla;
        return {h, s, l, a};
    }

    /**
     * Converts this color value to a hex color string. The resulting string does not have a leading hash `#`.
     * 
     * @param {boolean} shortform If `true`, will return a shortform version of the hex color if possible.
     * @returns {string}
     */
    toHex(shortform = false) {
        if (!this.#hex) {
            if (!this.#rgba) {
                this.#rgba = ExColor.hsl2rgb(this.#hsla);
            }

            this.#hex = ExColor.rgb2hex(this.#rgba);
        }

        let hex = this.#hex;
        if (shortform) {
            hex = ExColor.hexLongToShort(hex) || hex;
        }

        return hex;
    }

    /**
     * Converts this color to a CSS colour string, emitting `rgba()` whenever the
     * colour is translucent (hex can't represent alpha in a way older ST themes
     * reliably handle).
     *
     * @returns {string}
     */
    toCssString() {
        const { r, g, b, a } = this.toRgb();
        const alpha = a === undefined || a === null ? 255 : a;
        if (alpha >= 255) {
            return '#' + this.toHex();
        }

        const alpha01 = Math.round((alpha / 255) * 1000) / 1000;
        return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha01})`;
    }

    /**
     * Relative luminance per WCAG 2.x. Alpha is ignored.
     *
     * @returns {number} `0` (black) to `1` (white).
     */
    getLuminance() {
        const { r, g, b } = this.toRgb();
        const channel = (value) => {
            const v = value / 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    }

    /**
     * WCAG 2.x contrast ratio between two colours, from `1` (identical) to
     * `21` (black on white).
     *
     * @param {ExColor} a
     * @param {ExColor} b
     * @returns {number}
     */
    static contrastRatio(a, b) {
        const lumA = a.getLuminance();
        const lumB = b.getLuminance();
        const lighter = Math.max(lumA, lumB);
        const darker = Math.min(lumA, lumB);
        return (lighter + 0.05) / (darker + 0.05);
    }

    /**
     * Parses any CSS colour string into an `ExColor`, including `rgb()/rgba()`,
     * `hsl()/hsla()`, named colours, `#RGBA`/`#RRGGBBAA` and modern syntaxes
     * such as `oklch()`.
     *
     * Rather than hand-rolling a parser for every notation, this defers to the
     * browser's own CSS engine and then reads back the normalised value. That
     * keeps the accepted syntax in lockstep with whatever the user's browser
     * actually supports.
     *
     * @param {any} input
     * @returns {ExColor?} `null` when the value isn't a valid CSS colour.
     */
    static parse(input) {
        if (input instanceof ExColor) return input;
        if (typeof input !== 'string') return null;

        const value = input.trim();
        if (value.length === 0) return null;

        // `transparent` normalises to rgba(0,0,0,0) and would silently produce
        // an invisible colour; reject it as a colour choice.
        if (value.toLowerCase() === 'transparent') return null;

        const probe = document.createElement('span').style;
        probe.color = '';
        probe.color = value;
        // The assignment is a no-op for invalid values, leaving color empty.
        if (!probe.color) return null;

        let normalized = probe.color;

        // Some engines only resolve modern colour functions once the value is
        // laid out, so fall back to a computed style read.
        if (/^(color|oklch|oklab|lab|lch|hwb)\(/i.test(normalized)) {
            const probeEl = document.createElement('span');
            probeEl.style.cssText = `color:${value};position:absolute;`;
            document.body.appendChild(probeEl);
            normalized = getComputedStyle(probeEl).color || normalized;
            probeEl.remove();
        }

        const match = normalized.match(
            /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.%]+))?\s*\)$/i
        );
        if (!match) return null;

        const [, r, g, b, rawAlpha] = match;

        let alpha = 255;
        if (rawAlpha !== undefined) {
            alpha = rawAlpha.endsWith('%')
                ? (parseFloat(rawAlpha) / 100) * 255
                : parseFloat(rawAlpha) * 255;
        }

        return ExColor.fromRgb([
            Math.round(parseFloat(r)),
            Math.round(parseFloat(g)),
            Math.round(parseFloat(b)),
            Math.round(alpha),
        ]);
    }

    /**
     * Whether the given string is a colour value this extension can understand.
     * Broader than {@linkcode ExColor.isValidHexString} — accepts every CSS
     * colour notation the browser supports.
     *
     * @param {any} input
     * @returns {boolean}
     */
    static isValidColorString(input) {
        return ExColor.parse(input) !== null;
    }

    /**
     * Normalises any CSS colour string to a canonical form for storage.
     * Returns `#RRGGBB` for opaque colours and `rgba(...)` when translucent.
     *
     * @param {any} input
     * @returns {string?} `null` when the value isn't a valid colour.
     */
    static normalizeColorString(input) {
        return ExColor.parse(input)?.toCssString() ?? null;
    }

    /**
     * Creates a new `ExColor` object from the specified RGBA values.
     * 
     * @param {ColorArray | RgbaObject} rgba An array of numbers `[r, g, b, a?]` or an object `{ r: number, g: number, b: number, a?: number }`. 
     * Numbers should be within the range `0-255`.
     * 
     * The only validation done is checking for an array or an object for performance reasons.
     * 
     * @returns {ExColor}
     */
    static fromRgb(rgba) {
        return new ExColor(rgba, null);
    }
    
    /**
     * Creates a new `ExColor` object from the specified HSLA values.
     * 
     * @param {ColorArray | HslaObject} hsla An array of numbers `[h, s, l, a?]` or an object `{ h: number, s: number, l: number, a?: number }`. 
     * Numbers should be within the range `0-1`.
     * 
     * The only validation done is checking for an array or an object for performance reasons.
     * 
     * @returns {ExColor}
     */
    static fromHsl(hsla) {
        return new ExColor(null, hsla);
    }

    /**
     * Creates a new `ExColor` object from the specified hex color value.
     * 
     * @param {string} hex A string with an optional leading hash `#`, followed by exactly three or six hexadecimal characters.
     * @param {number=} alpha An optional alpha value between `0-255`.
     * 
     * The only validation done is checking for an array or an object for performance reasons.
     * 
     * @returns {ExColor}
     */
    static fromHex(hex, alpha) {
        const rgba = ExColor.hex2rgb(hex, alpha);
        return new ExColor(rgba, null);
    }

    /**
     * Converts the specified RGBA values to HSLA. The alpha value is scaled to fit the resulting range.
     * 
     * @param {ColorArray | RgbaObject} rgba An array of numbers `[r, g, b, a?]` or an object `{ r: number, g: number, b: number, a?: number }`.
     * Numbers should be within the range `0-255`.
     * 
     * @returns {ColorArray} The resulting HSLA values, in the range `0-1`.
     */
    static rgb2hsl(rgba) {
        let r, g, b, a;
        if (Array.isArray(rgba)) {
            [r, g, b, a = 255] = rgba;
        } else if (typeof rgba === 'object') {
            [r, g, b, a = 255] = [rgba.r, rgba.g, rgba.b, rgba.a];
        } else {
            throw new TypeError(`Unsupported data type '${typeof rgba}'.`);
        }

        r /= 255;
        g /= 255;
        b /= 255;
        a /= 255;

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const maxMin = (max + min);

        let h, s, l = maxMin / 2;
        if (max !== min) {
            let d = max - min;
            s = l > 0.5 ? d / (2 - d) : d / maxMin;

            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4;
            }

            h /= 6;
        } else { // achromatic
            h = s = 0;
        }

        return [h, s, l, a];
    }

    /**
     * Converts the specified HSLA values to RGBA. The alpha value is scaled to fit the resulting range.
     * 
     * @param {ColorArray | HslaObject} hsla An array of numbers `[h, s, l, a?]` or an object `{ h: number, s: number, l: number, a?: number }`.
     * Numbers should be within the range `0-1`.
     * 
     * @returns {ColorArray} The resulting RGBA values, in the range `0-255`.
     */
    static hsl2rgb(hsla) {
        let h, s, l, a;
        if (Array.isArray(hsla)) {
            [h, s, l, a = 1] = hsla;
        } else if (typeof hsla === 'object') {
            [h, s, l, a = 1] = [hsla.h, hsla.s, hsla.l, hsla.a];
        } else {
            throw new TypeError(`Unsupported data type '${typeof hsla}'.`);
        }

        let r, g, b;
        if (s !== 0) {
            function hue2rgb(p, q, t) {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
            }

            let q = l < 0.5 
                ? l * (1 + s) 
                : l + s - l * s;
            let p = 2 * l - q;

            r = hue2rgb(p, q, h + 1/3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1/3);
        } else { // achromatic
            r = g = b = l;
        }

        r = Math.round(r * 255);
        g = Math.round(g * 255);
        b = Math.round(b * 255);
        a = Math.round(a * 255);
        return [r, g, b, a];
    }

    /**
     * Converts the specified RGB value into a hex color string. The resulting string does not have a leading hash `#`.
     * @param {ColorArray | RgbaObject} rgb 
     * @returns {string}
     */
    static rgb2hex(rgb) {
        let r, g, b;
        if (Array.isArray(rgb)) {
            [r, g, b] = rgb;
        } else if (typeof rgb === 'object') {
            [r, g, b] = [rgb.r, rgb.g, rgb.b];
        } else {
            throw new TypeError(`Unsupported data type '${typeof rgb}'.`);
        }

        function num2hex(num) {
            const hex = num.toString(16);
            return hex.length == 1 ? '0' + hex : hex;
        }

        return num2hex(r) + num2hex(g) + num2hex(b);
    }

    /**
     * Converts the specified HSL value into a hex color string. The resulting string does not have a leading hash `#`.
     * 
     * This function works by first converting to RGB.
     * 
     * @param {ColorArray | HslaObject} hsl 
     * @returns {string}
     */
    static hsl2hex(hsl) {
        let rgb = ExColor.hsl2rgb(hsl);
        return ExColor.rgb2hex(rgb);
    }

    /**
     * Converts the specified hex color value into an RGB value. Does not support alpha.
     * 
     * @param {string} hex A string with an optional leading hash `#` followed by exactly three or six hexadecimal characters.
     * @param {number=} alpha An optional alpha value between `0-255`.
     * @returns {ColorArray}
     */
    static hex2rgb(hex, alpha) {
        hex = this.#hexNormalize(hex);
        if (hex.length === 3) hex = ExColor.hexShortToLong(hex);

        let r = parseInt(hex.slice(0, 2), 16);
        let g = parseInt(hex.slice(2, 4), 16);
        let b = parseInt(hex.slice(4, 6), 16);
        return [r, g, b, alpha];
    }

    /**
     * Gets whether the given object is a valid hex color string. A leading hash `#` is allowed.
     * 
     * @param {any} obj
     * @returns {boolean}
     */
    static isValidHexString(obj) {
        if (typeof obj !== 'string') return false;
        return /^#?(?:[0-9A-F]{3}){1,2}$/i.test(obj);
    }

    /**
     * Returns whether the specified long hex string can be converted to shortform. Returns `true` if the hex string is already short.
     * @param {string} hex
     * @returns {boolean}
     */
    static hexCanBeShort(hex) {
        hex = this.#hexNormalize(hex);
        if (hex.length === 3) return true;

        return hex[0] == hex[1] &&
               hex[2] == hex[3] &&
               hex[4] == hex[5];
    }

    /**
     * @param {string} hex
     * @returns {boolean}
     */
    static hexIsShort(hex) {
        hex = this.#hexNormalize(hex);
        return length === 3;
    }

    /**
     * Converts the specified long hex color string into shortform. 
     * Returns `hex` if it is already short. 
     * Returns `null` if it cannot be represented in shortform.
     * 
     * @param {string} hex
     * @returns {string?}
     */
    static hexLongToShort(hex) {
        hex = this.#hexNormalize(hex);
        if (!this.hexCanBeShort(hex)) return null;
        if (hex.length === 3) return hex;

        return hex[0] + hex [2] + hex[4];
    }

    /**
     * Converts the specified short hex color string into longform.
     * 
     * @param {string} hex
     * @returns {string}
     */
    static hexShortToLong(hex) {
        hex = this.#hexNormalize(hex);
        if (hex.length === 6) return hex;
        
        return hex[0] + hex[0] +
               hex[1] + hex[1] +
               hex[2] + hex[2];
    }

    /**
     * Ensures the given hex string has a leading hash.
     * 
     * @param {string} hex 
     * @returns {string}
     */
    static getHexWithHash(hex) {
        hex = this.#hexNormalize(hex);
        return '#' + hex;
    }

    /**
     * Gets the given hex string without any leading hash.
     * 
     * @param {string} hex 
     * @returns {string}
     */
    static getHexWithoutHash(hex) {
        return this.#hexNormalize(hex);
    }

    /**
     * Trims any beginning hash `#` from the hex string and throws on an invalid hex color string.
     * 
     * @param {any} hex 
     * @returns {string}
     */
    static #hexNormalize(hex) {
        if (!this.isValidHexString(hex)) 
            throw new TypeError("Invalid hex color string.");

        hex = hex.substring(hex.lastIndexOf('#') + 1);
        return hex;
    }
}