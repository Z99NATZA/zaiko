import {GltfModel} from './gltfModel.js';

export class AikoModel {
    constructor(area, GLib, Cairo, Gdk, GdkPixbuf, modelFile) {
        this._area = area;
        this._GLib = GLib;
        this._Cairo = Cairo;
        this._Gdk = Gdk;
        this._GdkPixbuf = GdkPixbuf;
        this._model = this._load(modelFile);
        this._expression = 'neutral';
        this._startedAt = GLib.get_monotonic_time();
        this._signal = area.connect('repaint', () => this._paint());
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            if (!this._area)
                return GLib.SOURCE_REMOVE;
            if (this._area.is_visible())
                this._area.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
        area.queue_repaint();
    }

    _load(file) {
        try {
            const [success, bytes] = file.load_contents(null);
            if (!success)
                throw new Error('could not read model file');
            return new GltfModel(bytes);
        } catch (error) {
            console.error(`Zaiko: could not load Aiko GLB: ${error.message}`);
            throw error;
        }
    }

    setExpression(expression) {
        if (['neutral', 'happy', 'shy', 'sad', 'surprised'].includes(expression))
            this._expression = expression;
        this._area?.queue_repaint();
    }

    _paint() {
        if (!this._area || !this._model)
            return;
        const cr = this._area.get_context();
        try {
            const [width, height] = this._area.get_surface_size();
            if (!width || !height)
                return;
            cr.setAntialias(this._Cairo.Antialias.BEST);
            cr.save();
            cr.setOperator(this._Cairo.Operator.CLEAR);
            cr.paint();
            cr.restore();

            const elapsed = (this._GLib.get_monotonic_time() - this._startedAt) / 1e6;
            const [, modelHeight] = this._model.extent;
            const scale = (height - 18) / modelHeight;
            const [centerX, centerY] = this._model.center;
            cr.save();
            cr.setSourceRGBA(0.06, 0.08, 0.14, 0.11);
            cr.arc(width / 2, height - 8, Math.min(width * 0.28, scale * modelHeight * 0.34), 0, Math.PI * 2);
            cr.fill();
            cr.restore();
            const data = this._model.renderPixels(elapsed, this._expression, width, height);
            const pixbuf = this._GdkPixbuf.Pixbuf.new_from_bytes(this._GLib.Bytes.new(data),
                this._GdkPixbuf.Colorspace.RGB, true, 8, width, height, width * 4);
            this._Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0);
            cr.paint();
            this._drawExpression(cr, width, height, scale, centerX, centerY);
        } finally {
            cr.$dispose();
        }
    }

    _drawExpression(cr, width, height, scale, centerX, centerY) {
        const faceX = x => width / 2 + (x - centerX) * scale;
        const faceY = y => height / 2 - (y - centerY) * scale;
        // Matches the mouth in build_aiko.py after the head pivot scale.
        const mouthX = faceX(0), mouthY = faceY(2.118);
        cr.save();
        cr.setLineCap(this._Cairo.LineCap.ROUND);
        cr.setLineJoin(this._Cairo.LineJoin.ROUND);
        cr.setLineWidth(Math.max(1, scale * 0.013));
        cr.setSourceRGBA(0.66, 0.25, 0.36, 0.95);
        if (this._expression === 'surprised') {
            cr.save();
            cr.translate(mouthX, mouthY);
            cr.scale(scale * 0.035, scale * 0.045);
            cr.arc(0, 0, 1, 0, Math.PI * 2);
            cr.fill();
            cr.restore();
        } else {
            // Paint over the neutral mouth before drawing the active expression.
            cr.save();
            cr.translate(mouthX, mouthY);
            cr.scale(scale * 0.072, scale * 0.034);
            cr.arc(0, 0, 1, 0, Math.PI * 2);
            cr.setSourceRGBA(0.96, 0.82, 0.79, 1);
            cr.fill();
            cr.restore();
            cr.setSourceRGBA(0.66, 0.25, 0.36, 0.95);
            cr.moveTo(mouthX - scale * 0.047, mouthY);
            if (this._expression === 'happy') {
                cr.curveTo(mouthX - scale * 0.02, mouthY + scale * 0.045,
                    mouthX + scale * 0.02, mouthY + scale * 0.045, mouthX + scale * 0.047, mouthY);
            } else if (this._expression === 'sad') {
                cr.curveTo(mouthX - scale * 0.02, mouthY - scale * 0.04,
                    mouthX + scale * 0.02, mouthY - scale * 0.04, mouthX + scale * 0.047, mouthY);
            } else {
                cr.curveTo(mouthX - scale * 0.02, mouthY + scale * 0.022,
                    mouthX + scale * 0.02, mouthY + scale * 0.022, mouthX + scale * 0.047, mouthY);
            }
            cr.stroke();
        }
        if (this._expression === 'shy') {
            cr.setSourceRGBA(0.96, 0.38, 0.49, 0.30);
            for (const x of [-0.42, 0.42]) {
                cr.save();
                cr.translate(faceX(x), faceY(2.188));
                cr.scale(scale * 0.10, scale * 0.06);
                cr.arc(0, 0, 1, 0, Math.PI * 2);
                cr.fill();
                cr.restore();
            }
        }
        cr.restore();
    }

    destroy() {
        if (this._timer) {
            this._GLib.Source.remove(this._timer);
            this._timer = 0;
        }
        if (this._area && this._signal) {
            this._area.disconnect(this._signal);
            this._signal = 0;
        }
        this._model = null;
        this._area = null;
    }
}
