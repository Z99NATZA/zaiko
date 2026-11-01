import Pango from 'gi://Pango';

// Shape the real font/width before truncating, so Thai, long tokens and explicit
// newlines share the same five-visual-line limit. The full message stays in Log.
export function answerPreview(sourceLayout, text, width, maxLines = 5) {
    const layout = sourceLayout.copy();
    layout.set_width(Math.max(1, Math.floor(width)) * Pango.SCALE);
    layout.set_wrap(Pango.WrapMode.WORD_CHAR);
    layout.set_ellipsize(Pango.EllipsizeMode.NONE);
    layout.set_text(text, -1);
    if (layout.get_line_count() <= maxLines) {
        const [, height] = layout.get_pixel_size();
        return {text, height, lines: layout.get_line_count(), truncated: false};
    }

    const last = layout.get_line_readonly(maxLines - 1);
    const bytes = new TextEncoder().encode(text);
    const prefix = new TextDecoder().decode(bytes.slice(0, last.start_index + last.length)).trimEnd();
    const graphemes = Array.from(new Intl.Segmenter(undefined, {granularity: 'grapheme'})
        .segment(prefix), item => item.segment);
    let low = 0;
    let high = graphemes.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        layout.set_text(`${graphemes.slice(0, middle).join('').trimEnd()}…`, -1);
        if (layout.get_line_count() <= maxLines)
            low = middle;
        else
            high = middle - 1;
    }
    const preview = `${graphemes.slice(0, low).join('').trimEnd()}…`;
    layout.set_text(preview, -1);
    const [, height] = layout.get_pixel_size();
    return {text: preview, height, lines: layout.get_line_count(), truncated: true};
}
