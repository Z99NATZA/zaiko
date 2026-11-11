export const SLASH_COMMANDS = Object.freeze([
    {name: '/status', descriptionKey: 'command.status'},
    {name: '/model', descriptionKey: 'command.model'},
    {name: '/permissions', descriptionKey: 'command.permissions'},
    {name: '/clear', descriptionKey: 'command.clear'},
    {name: '/cls', descriptionKey: 'command.clear'},
    {name: '/exit', descriptionKey: 'command.exit'},
]);

export const COMMAND_VISIBLE_ROWS = 8;

export function translatedCommands(translate) {
    return SLASH_COMMANDS.map(({name, descriptionKey}) => ({name, description: translate(descriptionKey)}));
}

export const MODEL_COMMAND = '/model';
export const PERMISSIONS_COMMAND = '/permissions';

// Mode names stay in English in every language.
export const PERMISSION_MODES = Object.freeze([
    {name: 'ask', label: 'Ask for approval'},
    {name: 'full', label: 'Full Access'},
]);

// "/model <filter>" lists model IDs (names only) and "/permissions <filter>"
// lists modes; otherwise match command prefixes.
export function commandMatches(text, commands = SLASH_COMMANDS, models = [], permissions = PERMISSION_MODES) {
    const query = text.trimStart();
    const mode = /^\/permissions\s+(\S*)$/i.exec(query);
    if (mode) {
        const filter = mode[1].toLowerCase();
        // Mode rows show only their label; name is what gets submitted.
        return permissions.filter(({name}) => name.startsWith(filter))
            .map(({name, label}) => ({name, description: '', label, permission: true}));
    }
    const model = /^\/model\s+(\S*)$/i.exec(query);
    if (model) {
        const filter = model[1].toLowerCase();
        return models.filter(name => name.toLowerCase().includes(filter))
            .map(name => ({name, description: '', model: true}));
    }
    if (!/^\/[a-z\d]*$/i.test(query))
        return [];
    return commands.filter(command => command.name.startsWith(query.toLowerCase()));
}
