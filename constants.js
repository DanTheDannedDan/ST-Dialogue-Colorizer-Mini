/* ============================================================
 * Palette Talk — shared constants.
 *
 * Kept in its own module so that both index.js and element-creators.js can
 * import it without creating a circular dependency between them.
 * ============================================================ */

/**
 * @typedef {ValueOf<typeof ColorizeSourceType>} ColorizeSourceType
 * @readonly
 */
export const ColorizeSourceType = {
  AVATAR_SMART: "avatar_smart",
  CHAR_COLOR_OVERRIDE: "char_color_override",
  STATIC_COLOR: "static_color",
  DISABLED: "disabled",
};
