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

export function themeStylesheet() {
    return THEMES.map(theme => {
        const root = `.zaiko-chat.zaiko-theme-${theme.id}`;
        return `
${root} { color: ${theme.text}; background-color: #FAFCFD; }
${root} .zaiko-title, ${root} .zaiko-section-title,
${root} .zaiko-message-content, ${root} .zaiko-theme-name { color: ${theme.text}; }
${root} .zaiko-status, ${root} .zaiko-hint,
${root} .zaiko-placeholder, ${root} .zaiko-theme-detail { color: ${alpha(theme.text, 0.68)}; }
${root} .zaiko-error { color: #B83252; }
${root} .zaiko-button { color: ${theme.text}; background-color: ${theme.control}; }
${root} .zaiko-button:hover, ${root} .zaiko-button:focus { background-color: ${theme.hover}; }
${root} .zaiko-button:checked { background-color: ${theme.selected}; }
${root} .zaiko-button:insensitive { color: ${alpha(theme.text, 0.45)}; background-color: ${alpha(theme.control, 0.65)}; }
${root} .zaiko-primary, ${root} .zaiko-sync:checked { color: #FFFFFF; background-color: ${theme.accent}; }
${root} .zaiko-primary:hover, ${root} .zaiko-primary:focus,
${root} .zaiko-sync:checked:hover, ${root} .zaiko-sync:checked:focus { background-color: ${alpha(theme.accent, 0.85)}; }
${root} .zaiko-primary:insensitive { color: ${alpha(theme.text, 0.45)}; background-color: ${theme.track}; }
${root} .zaiko-message { background-color: ${theme.control}; }
${root} .zaiko-message-user { background-color: ${theme.selected}; }
${root} .zaiko-message-role, ${root} .zaiko-theme-check { color: ${theme.accent}; }
${root} .zaiko-entry { color: ${theme.text}; background-color: ${theme.control}; border-color: transparent;
    selection-background-color: ${theme.selected}; selected-color: ${theme.text}; caret-color: ${theme.accent}; }
${root} .zaiko-entry:focus { border-color: ${theme.accent}; }
${root} .zaiko-entry StLabel { color: ${alpha(theme.text, 0.68)}; }
${root} .zaiko-scroll StScrollBar StBin#trough { background-color: ${alpha(theme.track, 0.5)}; }
${root} .zaiko-scroll StScrollBar StButton#vhandle { background-color: ${theme.track}; }
.zaiko-chat .zaiko-swatch-${theme.id} { background-color: ${theme.accent}; }
`;
    }).join('\n');
}
