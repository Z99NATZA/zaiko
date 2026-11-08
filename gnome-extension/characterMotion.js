import Clutter from 'gi://Clutter';
import St from 'gi://St';

// Half a breath (ms) and how far she stretches up from her bottom edge.
const BREATH = Object.freeze({
    calm: {duration: 1800, stretch: 0.012},
    busy: {duration: 700, stretch: 0.016},
});
const BREATH_NAME = 'zaiko-breath';

// Gentle idle breathing plus a short pop when the frame changes. Both follow
// GNOME's animation setting and stop while the character is hidden.
export class CharacterMotion {
    constructor(body, image) {
        this._body = body;
        this._image = image;
        this._active = false;
        this._busy = false;
        body.set_pivot_point(0.5, 1);
        image.set_pivot_point(0.5, 1);
        this._settings = St.Settings.get();
        this._settingsId = this._settings.connect('notify::enable-animations', () => this._breathe());
    }

    setActive(active) {
        if (this._active === active)
            return;
        this._active = active;
        this._breathe();
    }

    setBusy(busy) {
        if (this._busy === busy)
            return;
        this._busy = busy;
        this._breathe();
    }

    pop() {
        if (!this._animating())
            return;
        this._image.set({scale_x: 0.92, scale_y: 0.92, opacity: 140});
        this._image.ease({
            scale_x: 1, scale_y: 1, opacity: 255,
            duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    destroy() {
        this._settings.disconnect(this._settingsId);
        this._body.remove_transition(BREATH_NAME);
        this._image.remove_all_transitions();
    }

    _animating() {
        return this._active && this._settings.enable_animations;
    }

    _breathe() {
        this._body.remove_transition(BREATH_NAME);
        this._body.scale_y = 1;
        if (!this._animating()) {
            this._image.remove_all_transitions();
            this._image.set({scale_x: 1, scale_y: 1, opacity: 255});
            return;
        }
        // A plain transition, not actor.ease(): an endless ease would keep GNOME
        // Shell marked busy and block fullscreen unredirection while it runs.
        const {duration, stretch} = this._busy ? BREATH.busy : BREATH.calm;
        const breath = new Clutter.PropertyTransition({
            property_name: 'scale-y',
            interval: new Clutter.Interval({value_type: this._body.find_property('scale-y').value_type}),
            duration,
            repeat_count: -1,
            auto_reverse: true,
            progress_mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
        });
        breath.set_from(1);
        breath.set_to(1 + stretch);
        this._body.add_transition(BREATH_NAME, breath);
    }
}
