export const SLASH_COMMANDS = Object.freeze([
    {name: '/status', descriptionKey: 'command.status'},
]);

export const COMMAND_VISIBLE_ROWS = 8;

export function translatedCommands(translate) {
    return SLASH_COMMANDS.map(({name, descriptionKey}) => ({name, description: translate(descriptionKey)}));
}

export function commandMatches(text, commands = SLASH_COMMANDS) {
    const query = text.trimStart();
    if (!/^\/[a-z\d]*$/i.test(query))
        return [];
    return commands.filter(command => command.name.startsWith(query.toLowerCase()));
}
