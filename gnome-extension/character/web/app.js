'use strict';

// Per-model settings: which part of the model to frame, which expression file
// plays each Zaiko mood, and which parameter opens the mouth.
const PRESETS = {
    Mao: {
        // Fractions of the model's height, from the top: hat to hips.
        frame: {top: 0.03, bottom: 0.62},
        expressions: {neutral: 'exp_01', happy: 'exp_02', shy: 'exp_06', sad: 'exp_05', surprised: 'exp_07'},
        mouth: 'ParamA',
    },
};
const FALLBACK = {frame: {top: 0, bottom: 1}, expressions: {}, mouth: 'ParamMouthOpenY'};

const modelName = new URLSearchParams(location.search).get('model') || 'Mao';
const preset = PRESETS[modelName] ?? FALLBACK;

function post(message) {
    if (window.webkit?.messageHandlers?.zaiko)
        window.webkit.messageHandlers.zaiko.postMessage(message);
    else
        console.log(`zaiko: ${message}`);
}

window.addEventListener('error', event => post(`error: ${event.message}`));
window.addEventListener('unhandledrejection', event => post(`error: ${event.reason?.message ?? event.reason}`));

const app = new PIXI.Application({
    view: document.getElementById('stage'),
    backgroundAlpha: 0,
    resizeTo: window,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
});

let model = null;
let speaking = false;
let mouth = 0;

function layout() {
    if (!model)
        return;
    const {originalWidth, originalHeight} = model.internalModel;
    const {top, bottom} = preset.frame;
    const scale = window.innerHeight / (originalHeight * (bottom - top));
    model.scale.set(scale);
    model.x = (window.innerWidth - originalWidth * scale) / 2;
    model.y = -top * originalHeight * scale;
}

function updateMouth() {
    // Talking flap: a quick, slightly irregular open/close while speaking.
    const now = performance.now() / 1000;
    const target = speaking ? 0.25 + 0.55 * Math.abs(Math.sin(now * 11) * Math.sin(now * 4.3 + 1)) : 0;
    mouth += (target - mouth) * 0.35;
    model.internalModel.coreModel.setParameterValueById(preset.mouth, mouth);
}

window.zaiko = {
    setExpression(name) {
        const file = preset.expressions[name];
        if (model && file)
            model.expression(file);
    },
    setSpeaking(value) {
        speaking = Boolean(value);
    },
};

async function main() {
    const url = `../../assets/live2d/${modelName}/${modelName}.model3.json`;
    model = await PIXI.live2d.Live2DModel.from(url, {autoInteract: false});
    app.stage.addChild(model);
    model.internalModel.on('beforeModelUpdate', updateMouth);
    layout();
    window.addEventListener('resize', layout);
    window.zaiko.setExpression('neutral');
    post('ready');
}

main().catch(error => post(`error: ${error.message ?? error}`));
