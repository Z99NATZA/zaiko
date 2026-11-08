import Clutter from 'gi://Clutter';
import St from 'gi://St';

// Half a breath (ms) and how far she stretches up from her bottom edge.
const BREATH = Object.freeze({
    calm: {duration: 1800, stretch: 0.012},
    busy: {duration: 700, stretch: 0.016},
});
const BREATH_NAME = 'zaiko-breath';
// While a reply types out she bobs down behind her bottom edge and back.
const TALK = Object.freeze({duration: 170, depth: 0.03});
const TALK_NAME = 'zaiko-talk';

// Gentle idle breathing, a short pop when the frame changes and a bob while
// talking. All follow GNOME's animation setting and stop while hidden.
export class CharacterMotion {
    constructor(body, image) {
        this._body = body;
        this._image = image;
        this._active = false;
        this._busy = false;
        this._talking = false;
        body.set_pivot_point(0.5, 1);
        image.set_pivot_point(0.5, 1);
        this._settings = St.Settings.get();
        this._settingsId = this._settings.connect('notify::enable-animations', () => {
            this._breathe();
            this._talk();
        });
    }

    setActive(active) {
        if (this._active === active)
            return;
        this._active = active;
        this._breathe();
        this._talk();
    }

    setTalking(talking) {
        if (this._talking === talking)
            return;
        this._talking = talking;
        this._talk();
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
        this._body.remove_transition(TALK_NAME);
        this._body.remove_transition('translation-y');
        this._image.remove_all_transitions();
    }

    _animating() {
        return this._active && this._settings.enable_animations;
    }

    _talk() {
        this._body.remove_transition(TALK_NAME);
        if (!this._talking || !this._animating()) {
            // Settle back smoothly; ease() is fine for a short, finite move.
            if (this._body.translation_y && this._animating())
                this._body.ease({translation_y: 0, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                this._body.translation_y = 0;
            return;
        }
        this._body.remove_transition('translation-y');
        this._loop(TALK_NAME, 'translation-y', 0, Math.round(this._body.height * TALK.depth), TALK.duration);
    }

    _breathe() {
        this._body.remove_transition(BREATH_NAME);
        this._body.scale_y = 1;
        if (!this._animating()) {
            this._image.remove_all_transitions();
            this._image.set({scale_x: 1, scale_y: 1, opacity: 255});
            return;
        }
        const {duration, stretch} = this._busy ? BREATH.busy : BREATH.calm;
        this._loop(BREATH_NAME, 'scale-y', 1, 1 + stretch, duration);
    }

    // An endless back-and-forth on the body. A plain transition, not
    // actor.ease(): an endless ease would keep GNOME Shell marked busy and
    // block fullscreen unredirection while it runs.
    _loop(name, property, from, to, duration) {
        const loop = new Clutter.PropertyTransition({
            property_name: property,
            interval: new Clutter.Interval({value_type: this._body.find_property(property).value_type}),
            duration,
            repeat_count: -1,
            auto_reverse: true,
            progress_mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
        });
        loop.set_from(from);
        loop.set_to(to);
        this._body.add_transition(name, loop);
    }
}
