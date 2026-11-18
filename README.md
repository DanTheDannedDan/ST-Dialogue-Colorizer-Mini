# ST Dialogue Colorizer Mini

A lightweight, zero-bloat SillyTavern extension that automatically colors dialogue quotes and speaker names using each character's and persona's avatar palette.

No settings panel, no unnecessary menus, and zero lag.

---

## ⚡ Key Highlights

- **Zero Settings Menu**: Out of the box, it uses Avatar Smart extraction, colors quotes and speaker names, and respects natural theme tones without requiring setup or configuration drawers.
- **Reliable Manual Overrides**: Fine-tune colors directly inside the Character Editor (`Dialogue Color`) or Persona Management. Clear the field or click the reset button (`↺`) at any time to return to auto-detection.
- **Built for Speed & Stability**:
  - Fully handles **streamed generation**, non-streamed input, and message editing without drops or stalls.
  - Zero token-stream overhead—avoids deep subtree scanning and updates CSS custom properties via `requestAnimationFrame`.
  - Zero lag when dragging the color picker, even across long chats.
  - Completely removed CSS transitions and animations for instant, crisp rendering.
- **First-Class TauriTavern Support**:
  - Replaces fragile native color inputs with an integrated, in-WebView pointer-driven color picker popover that works across WKWebView (macOS/iOS), WebKitGTK (Linux), Android WebView, and Windows WebView2.
  - Supports `/thumbnail` routes, original images, and custom host asset endpoints without path-decoding failures.
- **Eyedropper Tool**: Samples any color directly from the screen (Chromium) or by clicking an avatar image (TauriTavern / Safari / Firefox).

---

## 🎨 How It Works

1. **Avatar Smart Extraction**: Scans the avatar image through Vibrant.js and Color Thief fallbacks, filtering out muddy, pitch-black, or washed-out shades to pick the best dialogue color.
2. **Applied Automatically**:
   - Dialogue quotes (`<q>`) are colored automatically.
   - Character and persona display names (`.name_text`) match their dialogue color.
3. **Manual Overrides**:
   - Open the **Character Editor** or **Persona Management** drawer.
   - Enter any CSS color (`#rrggbb`, `rgb()`, `hsl()`, or named colors), click the custom swatch to use the built-in color picker, or click the **Eyedropper** (`🖌`) to sample a color from an avatar.
   - Click the **Reset** button (`↺`) or clear the input to restore automatic avatar detection.

---

## 📦 Installation

### Method 1: SillyTavern Extension Installer (Recommended)
1. In SillyTavern, open the **Extensions** menu (stacked blocks icon).
2. Click **Install Extension**.
3. Paste the repository URL:
   ```
   https://github.com/DanTheDannedDan/ST-Dialogue-Colorizer-Mini
   ```
4. Click **Save**.

### Method 2: Manual Clone
Clone or extract the repository directly into your SillyTavern installation:
```bash
cd SillyTavern/public/scripts/extensions/third-party/
git clone https://github.com/DanTheDannedDan/ST-Dialogue-Colorizer-Mini.git
```

---

## 🎯 CSS Styling Hook

The extension assigns the resolved color to `--sdc-color` scoped to each message element. You can use this variable in your custom themes or user styles:

```css
/* Example: Match avatar border to dialogue color */
.mes[data-sdc-uid] .mesAvatarWrapper .avatar {
    outline: 1px solid var(--sdc-color);
}

/* Example: Accentuate the message header */
.mes[data-sdc-uid] .ch_name {
    border-left: 2px solid var(--sdc-color);
    padding-left: 6px;
}
```

---

## 📝 License

MIT License. See [LICENSE](./LICENSE) for details.