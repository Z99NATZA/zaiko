export const LANGUAGES = Object.freeze(['en', 'th']);

export function normalizeLanguage(language) {
    return LANGUAGES.includes(language) ? language : 'en';
}

// Keep translation and interpolation independent of GNOME for straightforward tests.
export function createTranslator(catalogs, language) {
    const selected = catalogs[normalizeLanguage(language)] ?? {};
    const fallback = catalogs.en ?? {};
    return (key, values = {}) => {
        const text = Object.hasOwn(selected, key) ? selected[key]
            : Object.hasOwn(fallback, key) ? fallback[key] : key;
        return text.replace(/\{(\w+)\}/g, (placeholder, name) =>
            Object.hasOwn(values, name) ? String(values[name]) : placeholder);
    };
}
