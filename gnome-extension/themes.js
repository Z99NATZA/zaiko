// Palette and names mirror zhyprbola's components/Theme.qml and SettingsPanel.qml.
export const THEMES = Object.freeze([
    {id: 'current', label: 'Purple', accent: '#875A82', text: '#3F2B41', control: '#F2EAF2', hover: '#E9DDE9', selected: '#D3BDD1', track: '#E2D2E2'},
    {id: 'white', label: 'White Mist', accent: '#467B9D', text: '#263B4C', control: '#EAF1F5', hover: '#DDEAF0', selected: '#BFD6E3', track: '#D3E2EA'},
    {id: 'white-sky', label: 'White Sky', accent: '#1E73E7', text: '#174269', control: '#EAF4FF', hover: '#DCEEFF', selected: '#B7D6FA', track: '#D1E7FA'},
    {id: 'forest', label: 'Forest Calm', accent: '#477F6D', text: '#194C3C', control: '#E8F3EE', hover: '#D9EAE1', selected: '#B8D6C8', track: '#CFE3D8'},
    {id: 'one-half-gray', label: 'One Half Gray', accent: '#68717D', text: '#2D3640', control: '#ECEFF1', hover: '#E0E5E8', selected: '#C5CDD5', track: '#CFD7DC'},
    {id: 'red', label: 'Red', accent: '#B83252', text: '#542437', control: '#FAE9EE', hover: '#F5DCE4', selected: '#EDBDCB', track: '#EECBD5'},
    {id: 'mauve', label: 'Sakura', accent: '#BE345F', text: '#4A293A', control: '#FBECF0', hover: '#F8D6E0', selected: '#ECB7C9', track: '#EAC9D5'},
    {id: 'silver-dawn', label: 'Silver Dawn', accent: '#6275A6', text: '#303B58', control: '#EDF0F8', hover: '#DFE5F2', selected: '#C3CDE5', track: '#D5DDEF'},
].map(Object.freeze));

export const DEFAULT_APPEARANCE = Object.freeze({theme: 'current', syncZhyprbola: false});

export function themeFor(id) {
    return THEMES.find(theme => theme.id === id) ?? THEMES[0];
}

export function parseAppearance(text) {
    try {
        const value = JSON.parse(text);
        return {
            theme: themeFor(value?.theme).id,
            syncZhyprbola: value?.syncZhyprbola === true,
        };
    } catch (_error) {
        return {...DEFAULT_APPEARANCE};
    }
}

export function resolveAppearance(settings, externalText) {
    const externalId = externalText?.trim();
    // zhyprbola migrated rose-galaxy to mauve (Sakura).
    const external = THEMES.find(theme => theme.id ===
        (externalId === 'rose-galaxy' ? 'mauve' : externalId));
    const synced = settings.syncZhyprbola && Boolean(external);
    return {theme: themeFor(synced ? external.id : settings.theme), synced};
}

function alpha(hex, opacity) {
    const channels = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
    return `rgba(${channels.join(', ')}, ${opacity})`;
}

export function logPrefixColor(theme, role) {
    if (!['user', 'assistant'].includes(role))
        return null;
    // Two readable shades of the selected accent on a light themed surface.
    const factor = role === 'user' ? 0.82 : 0.58;
    return `#${[1, 3, 5].map(offset => Math.round(
        Number.parseInt(theme.accent.slice(offset, offset + 2), 16) * factor)
        .toString(16).padStart(2, '0')).join('')}`;
}

export function themeStylesheet() {
    return THEMES.map(theme => {
        const root = `.zaiko-panel.zaiko-appearance.zaiko-theme-${theme.id}`;
        const log = `.zaiko-panel.zaiko-log.zaiko-theme-${theme.id}`;
        const input = `.zaiko-input-overlay.zaiko-theme-${theme.id}`;
        const answer = `.zaiko-answer.zaiko-theme-${theme.id}`;
        const context = `.zaiko-context.zaiko-theme-${theme.id}`;
        const close = `.zaiko-panel-close.zaiko-theme-${theme.id}`;
        const thumb = `.zaiko-scroll-thumb.zaiko-theme-${theme.id}`;
        const track = `.zaiko-scroll-track.zaiko-theme-${theme.id}#trough`;
        return `
${root} { color: ${theme.text}; background-color: #FAFCFD; }
${root} .zaiko-title, ${root} .zaiko-theme-name { color: ${theme.text}; }
${root} .zaiko-placeholder, ${root} .zaiko-theme-detail { color: ${alpha(theme.text, 0.68)}; }
${root} .zaiko-error { color: #B83252; }
${root} .zaiko-button { color: ${theme.text}; background-color: ${theme.control}; }
${root} .zaiko-button:hover, ${root} .zaiko-button:focus { background-color: ${theme.hover}; }
${root} .zaiko-button:checked { background-color: ${theme.selected}; }
${root} .zaiko-button:insensitive { color: ${alpha(theme.text, 0.45)}; background-color: ${alpha(theme.control, 0.65)}; }
${root} .zaiko-sync:checked { color: #FFFFFF; background-color: ${theme.accent}; }
${root} .zaiko-sync:checked:hover, ${root} .zaiko-sync:checked:focus { background-color: ${alpha(theme.accent, 0.85)}; }
${root} .zaiko-theme-check { color: ${theme.accent}; }
${root} .zaiko-scroll StScrollBar StBin#trough { background-color: ${alpha(theme.track, 0.5)}; }
${root} .zaiko-scroll StScrollBar .vhandle { background-color: ${theme.track}; }
.zaiko-panel .zaiko-swatch-${theme.id} { background-color: ${theme.accent}; }
${log} { color: ${theme.text}; background-color: ${alpha(theme.control, 0.97)}; border-color: ${theme.track}; }
${log} .zaiko-log-message, ${log} .zaiko-log-entry { color: ${theme.text}; }
${log} .zaiko-log-status, ${log} .zaiko-placeholder, ${log} .zaiko-log-entry StLabel { color: ${alpha(theme.text, 0.65)}; }
${log} .zaiko-log-error { color: #B83252; }
${log} .zaiko-log-composer { background-color: ${theme.hover}; border-color: ${theme.track}; }
${log} .zaiko-log-entry { caret-color: ${theme.accent};
    selection-background-color: ${theme.selected}; selected-color: ${theme.text}; }
${log} .zaiko-log-send { color: ${theme.accent}; border-color: ${alpha(theme.accent, 0.3)}; }
${log} .zaiko-log-send:hover, ${log} .zaiko-log-send:focus { background-color: ${theme.selected}; border-color: ${theme.accent}; }
${log} .zaiko-log-send:insensitive { color: ${alpha(theme.text, 0.4)}; border-color: ${theme.track}; }
${track} { background-color: ${alpha(theme.track, 0.25)}; border-radius: 3px; }
${thumb} { background-color: ${alpha(theme.accent, 0.4)}; }
${thumb}:hover, ${thumb}:active { background-color: ${alpha(theme.accent, 0.75)}; }
${close} { color: ${theme.text}; background-color: ${theme.control}; border-color: ${theme.track}; }
${close}:hover, ${close}:focus { background-color: ${theme.selected}; border-color: ${theme.accent}; }
${input} { color: #FFFFFF; background-color: ${alpha(theme.accent, 0.18)}; border-color: ${alpha(theme.selected, 0.45)}; }
${input} .zaiko-overlay-entry, ${input} .zaiko-overlay-entry:focus {
    color: #FFFFFF; background-color: transparent; border-color: transparent;
    caret-color: #FFFFFF; selection-background-color: ${alpha(theme.accent, 0.65)}; selected-color: #FFFFFF; }
${input} .zaiko-overlay-entry StLabel { color: ${alpha('#FFFFFF', 0.65)}; }
${input} .zaiko-overlay-send { color: ${alpha('#FFFFFF', 0.85)}; background-color: transparent; border-color: ${alpha(theme.selected, 0.3)}; }
${input} .zaiko-overlay-send:hover, ${input} .zaiko-overlay-send:focus {
    color: #FFFFFF; background-color: ${alpha(theme.accent, 0.28)}; border-color: ${alpha(theme.selected, 0.75)}; }
${input} .zaiko-overlay-send:insensitive {
    color: ${alpha('#FFFFFF', 0.3)}; background-color: transparent; border-color: ${alpha(theme.selected, 0.15)}; }
${answer} { color: #FFFFFF; }
${answer}.zaiko-answer-error { color: #FFB6C7; }
${context} { color: ${theme.text}; -arrow-background-color: #FAFCFD; -arrow-border-color: ${theme.track}; }
${context} .popup-menu-content { background-color: #FAFCFD; }
${context} .popup-menu-item { color: ${theme.text}; }
${context} .popup-menu-item:active, ${context} .popup-menu-item:hover,
${context} .popup-menu-item:focus { color: ${theme.text}; background-color: ${theme.hover}; }
`;
    }).join('\n');
}
