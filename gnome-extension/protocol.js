// Pure helpers shared with the headless contract checks.
export const CORE_BUS = 'org.zaiko.Companion';
export const CORE_PATH = '/org/zaiko/Companion';
export const DESKTOP_BUS = 'org.zaiko.Desktop';
export const DESKTOP_PATH = '/org/zaiko/Desktop';

export const DESKTOP_XML = `<node>
  <interface name="org.zaiko.Desktop">
    <method name="Present"/>
    <method name="OpenApp">
      <arg name="app" type="s" direction="in"/>
      <arg name="success" type="b" direction="out"/>
      <arg name="message" type="s" direction="out"/>
    </method>
    <method name="OpenTerminal">
      <arg name="mode" type="s" direction="in"/>
      <arg name="success" type="b" direction="out"/>
      <arg name="message" type="s" direction="out"/>
    </method>
  </interface>
</node>`;

export const APP_IDS = Object.freeze({
    terminal: ['io.github.z99natza.zter.desktop'],
    vscode: ['code.desktop', 'code-oss.desktop'],
});

export const APP_ACTIONS = Object.freeze({
    vscode: 'new-empty-window',
});

export const TERMINAL_ACTIONS = Object.freeze({
    default: null,
    tab: 'new-tab',
    standalone: 'new-window',
});

export function parseSnapshot(payload) {
    const snapshot = JSON.parse(payload);
    if (!snapshot || !Array.isArray(snapshot.messages) ||
        !['idle', 'thinking', 'working', 'error'].includes(snapshot.state))
        throw new Error('Invalid companion snapshot');

    const messages = snapshot.messages.map(message => {
        if (!message || typeof message.role !== 'string' ||
            typeof message.content !== 'string')
            throw new Error('Invalid companion message');
        return {role: message.role, content: message.content};
    });

    return {
        messages,
        state: snapshot.state,
        request_id: typeof snapshot.request_id === 'string' ? snapshot.request_id : null,
        error: typeof snapshot.error === 'string' ? snapshot.error : null,
        provider: typeof snapshot.provider === 'string' ? snapshot.provider : '',
        model: typeof snapshot.model === 'string' ? snapshot.model : '',
        models: Array.isArray(snapshot.models)
            ? snapshot.models.filter(model => typeof model === 'string') : [],
    };
}

export function parseEvent(payload) {
    const event = JSON.parse(payload);
    if (!event || !['state', 'message', 'error', 'present'].includes(event.type))
        throw new Error('Invalid companion event');
    return event;
}

export function isBusy(snapshot) {
    return ['thinking', 'working'].includes(snapshot.state);
}

export function expressionFor(snapshot) {
    if (['error', 'thinking', 'working'].includes(snapshot.state))
        return snapshot.state;
    return snapshot.messages.at(-1)?.role === 'assistant' ? 'happy' : 'neutral';
}

export function clampPosition(x, y, width, height, area, margin = 8) {
    const left = area.x + margin;
    const top = area.y + margin;
    return {
        x: Math.round(Math.max(left, Math.min(x, Math.max(left, area.x + area.width - width - margin)))),
        y: Math.round(Math.max(top, Math.min(y, Math.max(top, area.y + area.height - height - margin)))),
    };
}

export function panelPosition(character, panel, area) {
    const gap = 12;
    const y = character.y + character.height - panel.height;
    const left = clampPosition(character.x - panel.width - gap, y, panel.width, panel.height, area);
    const right = clampPosition(character.x + character.width + gap, y, panel.width, panel.height, area);
    const leftSpace = character.x - (left.x + panel.width);
    const rightSpace = right.x - (character.x + character.width);
    return leftSpace >= rightSpace ? left : right;
}

export function compactPosition(character, answer, input, area) {
    return {
        input: clampPosition(character.x + (character.width - input.width) / 2,
            character.y + character.height - input.height, input.width, input.height, area),
        answer: clampPosition(character.x + (character.width - answer.width) / 2,
            character.y - answer.height - 8, answer.width, answer.height, area),
    };
}

export function latestAssistant(messages) {
    return messages.findLast(message => message.role === 'assistant')?.content ?? '';
}

export function transcriptLine(message, speakers = {me: 'Me', action: 'Action'}) {
    const prefix = message.role === 'user' ? `[${speakers.me}]` : message.role === 'assistant' ? '[Aiko]' : `[${speakers.action}]`;
    const color = message.role === 'user' ? '#98c379' : message.role === 'assistant' ? '#c678dd' : null;
    return {prefix, text: `${prefix} ${message.content}`, color};
}

export function formatElapsed(seconds, units = {hour: 'h', minute: 'm', second: 's'}) {
    const elapsed = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor(elapsed % 3600 / 60);
    const parts = [];
    if (hours)
        parts.push(`${hours}${units.hour}`);
    if (hours || minutes)
        parts.push(`${minutes}${units.minute}`);
    parts.push(`${elapsed % 60}${units.second}`);
    return parts.join(' ');
}

// A menu row listing every choice, such as "CharSize: 1 2 3 4 5". dim holds
// the UTF-8 byte ranges of the inactive choices, for Pango attributes.
export function choiceLabel(title, choices, active) {
    const encoder = new TextEncoder();
    let text = `${title}:`;
    const dim = [];
    for (const choice of choices) {
        text += ' ';
        const start = encoder.encode(text).length;
        text += choice;
        if (choice !== active)
            dim.push([start, encoder.encode(text).length]);
    }
    return {text, dim};
}
