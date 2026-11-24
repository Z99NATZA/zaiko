// Log surface opacity, as a whole percent. Only the Log panel's background
// alpha changes; text, border and the composer keep their own styling.
export const LOG_OPACITY_MIN = 50;
export const LOG_OPACITY_MAX = 100;
export const DEFAULT_LOG_OPACITY = 90;

// Clamps to whole percents 50-100.
export function normalizeLogOpacity(value) {
    const percent = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(percent))
        return DEFAULT_LOG_OPACITY;
    return Math.min(LOG_OPACITY_MAX, Math.max(LOG_OPACITY_MIN, percent));
}

// Slider position in 0..1 for a percent, and back again. Every pointer
// position maps to a whole percent, so the Log follows the drag continuously.
export function logOpacityToSlider(percent) {
    const span = LOG_OPACITY_MAX - LOG_OPACITY_MIN;
    return (normalizeLogOpacity(percent) - LOG_OPACITY_MIN) / span;
}

export function logOpacityFromSlider(value) {
    const span = LOG_OPACITY_MAX - LOG_OPACITY_MIN;
    const clamped = Math.min(1, Math.max(0, Number(value) || 0));
    return normalizeLogOpacity(Math.round(LOG_OPACITY_MIN + clamped * span));
}

// The Log surface is the One Half Dark background #282c34 at this alpha.
export function logSurfaceStyle(percent) {
    const alpha = normalizeLogOpacity(percent) / 100;
    return `background-color: rgba(40, 44, 52, ${alpha.toFixed(2)});`;
}
