export const SLASH_COMMANDS = Object.freeze([
    {name: '/status', descriptionKey: 'command.status'},
    {name: '/model', descriptionKey: 'command.model'},
    {name: '/exit', descriptionKey: 'command.exit'},
]);

export const COMMAND_VISIBLE_ROWS = 8;

export function translatedCommands(translate) {
    return SLASH_COMMANDS.map(({name, descriptionKey}) => ({name, description: translate(descriptionKey)}));
}

export const MODEL_COMMAND = '/model';

// "/model <filter>" lists model IDs (names only); otherwise match command prefixes.
export function commandMatches(text, commands = SLASH_COMMANDS, models = []) {
    const query = text.trimStart();
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
