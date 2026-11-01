// Real Pango shaping checks without a GNOME Shell or user configuration.
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import {answerPreview} from '../answerPreview.js';

function assert(value, description) {
    if (!value)
        throw new Error(description);
}

const context = PangoCairo.FontMap.get_default().create_context();
const layout = Pango.Layout.new(context);
const font = Pango.FontDescription.from_string('Sans');
font.set_absolute_size(14 * Pango.SCALE);
layout.set_font_description(font);
layout.set_single_paragraph_mode(false);

const short = answerPreview(layout, '[Aiko] สวัสดีค่ะ', 288);
assert(short.text === '[Aiko] สวัสดีค่ะ' && short.lines === 1 && !short.truncated, 'Short answer stays one natural line');
const samples = [
    'หนึ่ง\nสอง\nสาม\nสี่\nห้า\nหก\nเจ็ด',
    'ไอโกะอยู่นี่นะคะและจะช่วยตอบคำถามของคุณค่ะ '.repeat(30),
    'abcdefghij'.repeat(200),
    'A family 👩‍👩‍👦 and Thai กำลัง '.repeat(80),
    '\n\n\n\n\n\n\n',
];
for (const width of [80, 180, 288, 480]) {
    for (const text of samples) {
        const result = answerPreview(layout, `[Aiko] ${text}`, width);
        assert(result.text.startsWith('[Aiko]'), 'Speaker prefix participates in displayed preview');
        assert(result.lines <= 5 && result.truncated && result.text.endsWith('…'), 'Truncated answer is at most five lines');
        const measured = layout.copy();
        measured.set_width(width * Pango.SCALE);
        measured.set_wrap(Pango.WrapMode.WORD_CHAR);
        measured.set_text(result.text, -1);
        assert(measured.get_line_count() <= 5, 'Displayed text independently shapes to at most five lines');
        assert(result.height === measured.get_pixel_size()[1], 'Plain answer height matches actual shaped preview');
    }
}
const five = answerPreview(layout, '1\n2\n3\n4\n5', 288);
assert(five.lines === 5 && !five.truncated, 'Exactly five actual lines do not gain an ellipsis');
assert(short.height < five.height, 'Short answers do not reserve five lines');
font.set_absolute_size(24 * Pango.SCALE);
layout.set_font_description(font);
const scaled = answerPreview(layout, 'A long answer '.repeat(50), 288);
assert(scaled.lines <= 5 && scaled.height > five.height, 'Reshape using a larger font preserves line cap and grows height');
print('PASS Pango answer previews: Thai, explicit newlines, graphemes, long tokens, widths and font size');
