import { ExColor } from "./ExColor.js";

/**
 * C#-style string format. Does not support named arguments.
 * 
 * @param {string} str
 * @param {any[]} args
 * 
 * @link https://stackoverflow.com/a/8463429
 */
export function stringFormat(str, ...args) {
    return str.replace(/\{\{|\}\}|\{(\d+)\}/g, function (curlyBrack, index) {
        return ((curlyBrack == "{{") ? "{" : ((curlyBrack == "}}") ? "}" : args[index]));
    });
}

/**
 * Loads an image from the specified url.
 * 
 * @param {string} url 
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.addEventListener('load', () => resolve(img), { once: true });
        img.addEventListener('error', reject, { once: true });
        img.src = url;
    });
}

/**
 * Ensures that the given image is fully loaded.
 * 
 * @param {HTMLImageElement} img 
 * @returns {Promise<HTMLImageElement>}
 */
export function waitForImage(img) {
    return new Promise((resolve, reject) => {
        const onLoad = () => {
            cleanup();
            resolve(img);
        };
        const onError = (err) => {
            cleanup();
            reject(err instanceof Error ? err : new Error("Image failed to load."));
        };
        const cleanup = () => {
            img.removeEventListener('load', onLoad);
            img.removeEventListener('error', onError);
        };

        // Already finished loading? Decide success/failure by naturalWidth: a
        // "complete" image with zero natural width actually failed to decode.
        if (img.complete) {
            if (img.naturalWidth > 0) {
                resolve(img);
            } else {
                reject(new Error("Image is complete but failed to decode (naturalWidth === 0)."));
            }
            return;
        }

        img.addEventListener('load', onLoad, { once: true });
        img.addEventListener('error', onError, { once: true });
    });
}

/**
 * Loads a script from a URI.
 * 
 * @param {string} scriptUri 
 * 
 * @returns {Promise<void>}
 */
export function loadScript(scriptUri) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.type = "text/javascript";
        script.async = true;

        script.addEventListener('load', () => {
            script.parentNode.removeChild(script);
            resolve();
        }, { once: true });
        
        script.addEventListener('error', (err) => {
            script.parentNode.removeChild(script);
            reject(err);
        }, { once: true });

        script.src = scriptUri;
        document.body.appendChild(script);
    });
}

/**
 * @param {string} groupName
 * @returns {HTMLInputElement}
 */
export function getCheckedRadioButtonInGroup(groupName) {
    // @ts-ignore
    return document.querySelector(`input[type="radio"][name="${groupName}"]:checked`).value;
}

/**
 * 
 * @param {string} groupName 
 * @param {string} value 
 * @returns {HTMLInputElement}
 */
export function getRadioButtonInGroup(groupName, value) {
    return document.querySelector(`input[type="radio"][name="${groupName}"][value="${value}"]`);
}

/**
 * @param {string} groupName
 * @returns {NodeListOf<HTMLInputElement>}
 */
export function getAllRadioButtonsInGroup(groupName) {
    return document.querySelectorAll(`input[type="radio"][name="${groupName}"]`)
}

/**
 * Wires a `<input type="color">` and a text field together so each reflects the
 * other, accepting any CSS colour notation in the text field.
 *
 * @param {HTMLInputElement} picker 
 * @param {HTMLInputElement} textbox 
 * @param {(textboxValue: string) => string?} textboxValueProcessor Returns a
 * normalised colour string, or `null` when the input is invalid.
 * @param {(colorValue: string) => void} onSuccess Committed value.
 * @param {((colorValue: string) => void)=} onPreview Continuous value while the
 * user is still interacting; nothing should be persisted from this.
 * @param {(() => void)=} onPreviewEnd Called when previewing stops.
 */
export function linkInputColorTextPicker(picker, textbox, textboxValueProcessor, onSuccess, onPreview, onPreviewEnd) {
    /**
     * The picker element only understands `#RRGGBB`, so any alpha or alternate
     * notation has to be flattened before assigning to it.
     * @param {string} value
     */
    const toPickerValue = (value) => {
        const parsed = ExColor.parse(value);
        return parsed ? '#' + parsed.toHex() : "#000000";
    };

    // 'input' fires continuously while the picker is dragged, giving live
    // feedback; 'change' fires once the dialog is dismissed and commits.
    $(picker).on('input', () => {
        textbox.value = picker.value;
        textbox.classList.remove("sdc-input-invalid");
        onPreview?.(picker.value);
    });

    $(picker).on('change', () => {
        const pickerValue = picker.value;

        textbox.value = pickerValue;
        textbox.setAttribute("lastValidValue", pickerValue);
        textbox.classList.remove("sdc-input-invalid");

        onPreviewEnd?.();
        onSuccess(pickerValue);
    });

    // Live validation + preview as the user types, without committing.
    $(textbox).on('input', () => {
        const raw = textbox.value;
        const isEmpty = raw.trim().length === 0;
        const processed = isEmpty ? null : textboxValueProcessor(raw);

        textbox.classList.toggle("sdc-input-invalid", !processed && !isEmpty);
        if (processed) {
            picker.value = toPickerValue(processed);
            onPreview?.(processed);
        }
    });

    $(textbox).on('focusout', () => {
        onPreviewEnd?.();

        const textboxValue = textboxValueProcessor(textbox.value);
        if (textboxValue === null) {
            // Reject invalid input by restoring the last good value.
            const lastValidValue = textbox.getAttribute("lastValidValue") ?? picker.value;
            textbox.value = lastValidValue;
            textbox.setAttribute("lastValidValue", lastValidValue);
            textbox.classList.remove("sdc-input-invalid");
            return;
        }

        textbox.value = textboxValue;
        textbox.setAttribute("lastValidValue", textboxValue);
        textbox.classList.remove("sdc-input-invalid");
        picker.value = toPickerValue(textboxValue);

        onSuccess(textboxValue);
    });
}

/**
 * Sets the values of the text and color inputs of a combo picker.
 * 
 * @param {HTMLElement} elemComboWrapper 
 * @param {string?} hexValue 
 */
export function setInputColorPickerComboValue(elemComboWrapper, hexValue) {
    const textInput = /** @type {HTMLInputElement} */ (elemComboWrapper.querySelector(`input[type="text"]`));
    const colorInput =/** @type {HTMLInputElement} */ (elemComboWrapper.querySelector(`input[type="color"]`));

    textInput.value = hexValue ?? "";
    textInput.classList.remove("sdc-input-invalid");
    if (hexValue) textInput.setAttribute("lastValidValue", hexValue);

    // The native picker can't represent alpha or non-hex notations, so store a
    // flattened hex approximation there.
    const parsed = hexValue ? ExColor.parse(hexValue) : null;
    colorInput.value = parsed ? '#' + parsed.toHex() : "#000000";
}