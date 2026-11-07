// Minimal GLB 2.0 reader and CPU projection for GNOME Shell's native actor.
// Supports the mesh/material/TRS/linear-animation subset exported by Blender.
const COMPONENTS = Object.freeze({
    5120: [1, 'getInt8'], 5121: [1, 'getUint8'], 5122: [2, 'getInt16'],
    5123: [2, 'getUint16'], 5125: [4, 'getUint32'], 5126: [4, 'getFloat32'],
});
const TYPE_WIDTH = Object.freeze({SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16});
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = (edge0, edge1, value) => {
    const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
};
const toSrgb = channel => {
    const value = clamp(channel, 0, 1);
    return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
};
const normalize = vector => {
    const length = Math.hypot(...vector);
    return vector.map(component => component / length);
};
// Key light from the upper left, toward the viewer (+Z faces the camera).
const LIGHT = normalize([-0.24, 0.36, 0.90]);
const HALF = normalize([-0.14, 0.62, 0.77]);
const COOL_SHADOW = [0.70, 0.68, 0.86];
const WARM_SHADOW = [0.97, 0.80, 0.80];
const RIM = [0.62, 0.70, 1.0];
// Depth step (model units) that counts as one surface overlapping another.
const EDGE_DEPTH = 0.05;
const INK = [0.16, 0.11, 0.17];
const INK_STRENGTH = 0.42;

function multiply(a, b) {
    const result = new Array(16).fill(0);
    for (let column = 0; column < 4; column++)
        for (let row = 0; row < 4; row++)
            for (let k = 0; k < 4; k++)
                result[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    return result;
}

function compose(translation, rotation, scale) {
    const [x, y, z, w] = rotation;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    return [
        (1 - (yy + zz)) * scale[0], (xy + wz) * scale[0], (xz - wy) * scale[0], 0,
        (xy - wz) * scale[1], (1 - (xx + zz)) * scale[1], (yz + wx) * scale[1], 0,
        (xz + wy) * scale[2], (yz - wx) * scale[2], (1 - (xx + yy)) * scale[2], 0,
        translation[0], translation[1], translation[2], 1,
    ];
}

function transformPoint(matrix, point) {
    const [x, y, z] = point;
    return [
        matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    ];
}

export class GltfModel {
    constructor(bytes) {
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const view = new DataView(buffer);
        if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2)
            throw new Error('Aiko model must be a GLB 2.0 file');
        const jsonLength = view.getUint32(12, true);
        this._json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)));
        const binHeader = 20 + jsonLength;
        const binLength = view.getUint32(binHeader, true);
        this._binary = new DataView(buffer, binHeader + 8, binLength);
        this._accessorCache = new Map();
        this._faceCache = new Map();
        this._materials = this._json.materials.map(material => {
            const pbr = material.pbrMetallicRoughness ?? {};
            return {
                color: pbr.baseColorFactor ?? [1, 1, 1, 1],
                roughness: pbr.roughnessFactor ?? 0.6,
                metallic: pbr.metallicFactor ?? 0,
                // Skin keeps warm shadows; everything else gets cool anime shadows.
                warm: /skin|blush|lips/i.test(material.name ?? ''),
            };
        });
        this._materials.push({color: [0.7, 0.7, 0.7, 1], roughness: 0.6, metallic: 0, warm: false});
        this._nodes = this._json.nodes.map((node, index) => ({
            index, name: node.name ?? `node-${index}`, node,
            children: node.children ?? [], parent: -1,
            baseTranslation: node.translation ?? [0, 0, 0],
            baseRotation: node.rotation ?? [0, 0, 0, 1],
            baseScale: node.scale ?? [1, 1, 1],
            tracks: {},
            primitives: [],
        }));
        for (const node of this._nodes)
            for (const child of node.children)
                this._nodes[child].parent = node.index;
        this._readMeshes();
        this._readAnimations();
        this._measureBounds();
    }

    _readAccessor(index) {
        if (this._accessorCache.has(index))
            return this._accessorCache.get(index);
        const accessor = this._json.accessors[index];
        const [componentSize, method] = COMPONENTS[accessor.componentType];
        const width = TYPE_WIDTH[accessor.type];
        const view = this._json.bufferViews[accessor.bufferView];
        const stride = view.byteStride ?? componentSize * width;
        const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        const values = new Array(accessor.count);
        for (let i = 0; i < accessor.count; i++) {
            const row = new Array(width);
            for (let j = 0; j < width; j++) {
                const offset = start + i * stride + j * componentSize;
                let value = this._binary[method](offset, true);
                if (accessor.normalized) {
                    if (accessor.componentType === 5120) value = Math.max(value / 127, -1);
                    else if (accessor.componentType === 5121) value /= 255;
                    else if (accessor.componentType === 5122) value = Math.max(value / 32767, -1);
                    else if (accessor.componentType === 5123) value /= 65535;
                }
                row[j] = value;
            }
            values[i] = row;
        }
        this._accessorCache.set(index, values);
        return values;
    }

    get center() {
        return this._center.slice(0, 2);
    }

    get extent() {
        return this._extent.slice(0, 2);
    }

    get depthCenter() {
        return this._center[2];
    }

    _readMeshes() {
        for (const {node, primitives} of this._nodes) {
            if (node.mesh === undefined)
                continue;
            for (const primitive of this._json.meshes[node.mesh].primitives) {
                if ((primitive.mode ?? 4) !== 4 || primitive.attributes.POSITION === undefined)
                    continue;
                const positions = this._readAccessor(primitive.attributes.POSITION);
                const normals = primitive.attributes.NORMAL === undefined
                    ? positions.map(() => [0, 0, 1]) : this._readAccessor(primitive.attributes.NORMAL);
                const indices = primitive.indices === undefined
                    ? Array.from({length: positions.length}, (_unused, index) => index)
                    : this._readAccessor(primitive.indices).map(value => value[0]);
                const material = this._materials[primitive.material] === undefined
                    ? this._materials.length - 1 : primitive.material;
                primitives.push({positions, normals, indices, material});
            }
        }
    }

    _readAnimations() {
        this._duration = 0;
        for (const animation of this._json.animations ?? []) {
            for (const channel of animation.channels) {
                const target = channel.target;
                if (!target || !['translation', 'rotation', 'scale'].includes(target.path))
                    continue;
                const sampler = animation.samplers[channel.sampler];
                const times = this._readAccessor(sampler.input).map(row => row[0]);
                let values = this._readAccessor(sampler.output);
                if (sampler.interpolation === 'CUBICSPLINE')
                    values = values.filter((_value, index) => index % 3 === 1);
                this._duration = Math.max(this._duration, times.at(-1) ?? 0);
                this._nodes[target.node].tracks[target.path] = {
                    times, values, path: target.path, interpolation: sampler.interpolation ?? 'LINEAR',
                };
            }
        }
    }

    _trackValue(track, time, base) {
        if (!track || !track.times.length)
            return base;
        const {times, values, interpolation} = track;
        if (time <= times[0])
            return values[0];
        if (time >= times.at(-1))
            return values.at(-1);
        let right = 1;
        while (times[right] < time)
            right++;
        const left = right - 1;
        if (interpolation === 'STEP')
            return values[left];
        const fraction = (time - times[left]) / (times[right] - times[left]);
        const value = values[left].map((component, index) => component + (values[right][index] - component) * fraction);
        if (value.length === 4 && track.path === 'rotation') {
            const length = Math.hypot(...value) || 1;
            return value.map(component => component / length);
        }
        return value;
    }

    _worldMatrices(time) {
        const local = this._nodes.map(node => {
            const translation = this._trackValue(node.tracks.translation, time, node.baseTranslation);
            const rotation = this._trackValue(node.tracks.rotation, time, node.baseRotation);
            const scale = this._trackValue(node.tracks.scale, time, node.baseScale);
            return compose(translation, rotation, scale);
        });
        const world = new Array(this._nodes.length);
        const getWorld = index => {
            if (world[index])
                return world[index];
            const parent = this._nodes[index].parent;
            world[index] = parent < 0 ? local[index] : multiply(getWorld(parent), local[index]);
            return world[index];
        };
        for (let index = 0; index < this._nodes.length; index++)
            getWorld(index);
        return world;
    }

    _measureBounds() {
        const world = this._worldMatrices(0);
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const node of this._nodes) {
            const matrix = world[node.index];
            for (const primitive of node.primitives)
                for (const point of primitive.positions) {
                    const transformed = transformPoint(matrix, point);
                    for (let axis = 0; axis < 3; axis++) {
                        min[axis] = Math.min(min[axis], transformed[axis]);
                        max[axis] = Math.max(max[axis], transformed[axis]);
                    }
                }
        }
        this._center = min.map((value, axis) => (value + max[axis]) / 2);
        this._extent = max.map((value, axis) => value - min[axis]);
    }

    _primitives(expression) {
        if (this._faceCache.has(expression))
            return this._faceCache.get(expression);
        const list = [];
        for (const node of this._nodes) {
            const expressionNode = /^(happy|shy|sad|surprised)_/i.exec(node.name);
            if (expressionNode && expressionNode[1].toLowerCase() !== expression)
                continue;
            for (const primitive of node.primitives)
                list.push({node: node.index, primitive});
        }
        this._faceCache.set(expression, list);
        return list;
    }

    triangleCount(expression) {
        return this._primitives(expression).reduce((sum, {primitive}) => sum + primitive.indices.length / 3, 0);
    }

    // Anime cel shading: a soft two-tone ramp, tinted shadows, a cool rim
    // light so dark hair reads against dark desktops, and a small specular
    // glint on metal.
    _shadeInto(out, offset, material, nx, ny, nz) {
        const length = Math.hypot(nx, ny, nz) || 1;
        nx /= length;
        ny /= length;
        nz /= length;
        const light = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2];
        const lit = smoothstep(-0.02, 0.14, light);
        const form = 0.93 + 0.07 * clamp(light, 0, 1);
        const tint = material.warm ? WARM_SHADOW : COOL_SHADOW;
        const rim = Math.max(0, 1 - Math.abs(nz)) ** 3 * (0.10 + 0.14 * Math.max(0, ny + 0.3));
        let specular = 0;
        if (material.metallic > 0.3) {
            const half = nx * HALF[0] + ny * HALF[1] + nz * HALF[2];
            specular = smoothstep(0.86, 0.94, half) * 0.35;
        }
        for (let axis = 0; axis < 3; axis++) {
            const base = material.color[axis];
            const value = (base * tint[axis] * (1 - lit) + base * lit) * form + specular + rim * RIM[axis];
            out[offset + axis] = toSrgb(value);
        }
    }

    renderPixels(time, expression, width, height) {
        // Rasterize at 2x and box-filter down, so edges and outlines stay smooth.
        const ss = 2;
        const W = width * ss, H = height * ss, count = W * H;
        const depth = new Float32Array(count).fill(-Infinity);
        const normalX = new Float32Array(count), normalY = new Float32Array(count), normalZ = new Float32Array(count);
        const materialAt = new Int16Array(count).fill(-1);
        const [, modelHeight] = this.extent;
        // Preserve the large chibi head size and let wide side locks crop at
        // the actor edges, as they do in the in-game portrait references.
        const scale = (height - 18) / modelHeight * ss;
        const yaw = Math.sin(time * 0.55) * 0.065;
        const bob = Math.sin(time * 1.8) * 1.2 * ss;
        const cosine = Math.cos(yaw), sine = Math.sin(yaw);
        const clipTime = this._duration > 0 ? time % this._duration : 0;
        const world = this._worldMatrices(clipTime);
        const [centerX, centerY, centerZ] = this._center;

        for (const {node, primitive} of this._primitives(expression)) {
            const m = world[node];
            const {positions, normals, indices, material} = primitive;
            const n = positions.length;
            const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n);
            const tx = new Float32Array(n), ty = new Float32Array(n), tz = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const [x, y, z] = positions[i];
                const localX = m[0] * x + m[4] * y + m[8] * z + m[12] - centerX;
                const worldY = m[1] * x + m[5] * y + m[9] * z + m[13];
                const localZ = m[2] * x + m[6] * y + m[10] * z + m[14] - centerZ;
                sx[i] = W / 2 + (localX * cosine + localZ * sine) * scale;
                sy[i] = H / 2 - (worldY - centerY) * scale + bob;
                sz[i] = -localX * sine + localZ * cosine;
                const [a, b, c] = normals[i];
                const vx = m[0] * a + m[4] * b + m[8] * c;
                const vy = m[1] * a + m[5] * b + m[9] * c;
                const vz = m[2] * a + m[6] * b + m[10] * c;
                tx[i] = vx * cosine + vz * sine;
                ty[i] = vy;
                tz[i] = -vx * sine + vz * cosine;
            }
            for (let i = 0; i + 2 < indices.length; i += 3) {
                const ia = indices[i], ib = indices[i + 1], ic = indices[i + 2];
                const ax = sx[ia], ay = sy[ia], bx = sx[ib], by = sy[ib], cx = sx[ic], cy = sy[ic];
                const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
                if (Math.abs(area) < 0.001)
                    continue;
                const xMin = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
                const xMax = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
                const yMin = Math.max(0, Math.floor(Math.min(ay, by, cy)));
                const yMax = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
                const invArea = 1 / area;
                const az = sz[ia], bz = sz[ib], cz = sz[ic];
                for (let y = yMin; y <= yMax; y++) {
                    const py = y + 0.5;
                    for (let x = xMin; x <= xMax; x++) {
                        const px = x + 0.5;
                        const wa = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * invArea;
                        if (wa < -0.001)
                            continue;
                        const wb = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * invArea;
                        const wc = 1 - wa - wb;
                        if (wb < -0.001 || wc < -0.001)
                            continue;
                        const z = wa * az + wb * bz + wc * cz;
                        const pixel = y * W + x;
                        if (z <= depth[pixel])
                            continue;
                        depth[pixel] = z;
                        normalX[pixel] = wa * tx[ia] + wb * tx[ib] + wc * tx[ic];
                        normalY[pixel] = wa * ty[ia] + wb * ty[ib] + wc * ty[ic];
                        normalZ[pixel] = wa * tz[ia] + wb * tz[ib] + wc * tz[ic];
                        materialAt[pixel] = material;
                    }
                }
            }
        }

        // Shade each visible sample once.
        const color = new Float32Array(count * 3);
        for (let pixel = 0; pixel < count; pixel++) {
            const material = materialAt[pixel];
            if (material >= 0)
                this._shadeInto(color, pixel * 3, this._materials[material], normalX[pixel], normalY[pixel], normalZ[pixel]);
        }

        // Colored ink lines: on the silhouette and wherever a nearer surface
        // overlaps a farther one (hair over face, arms over body, lock over lock).
        const ink = new Uint8Array(count);
        for (let y = 1; y < H - 1; y++) {
            for (let x = 1; x < W - 1; x++) {
                const pixel = y * W + x;
                if (materialAt[pixel] < 0)
                    continue;
                const z = depth[pixel];
                for (const neighbor of [pixel - 1, pixel + 1, pixel - W, pixel + W]) {
                    if (materialAt[neighbor] < 0 || depth[neighbor] > z + EDGE_DEPTH) {
                        ink[pixel] = 1;
                        break;
                    }
                }
            }
        }
        for (let pixel = 0; pixel < count; pixel++) {
            if (!ink[pixel])
                continue;
            const offset = pixel * 3;
            for (let axis = 0; axis < 3; axis++)
                color[offset + axis] = color[offset + axis] * INK_STRENGTH + INK[axis] * (1 - INK_STRENGTH);
        }

        // Downsample with coverage-weighted averaging; alpha is coverage.
        const pixels = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let r = 0, g = 0, b = 0, covered = 0;
                for (let dy = 0; dy < ss; dy++) {
                    for (let dx = 0; dx < ss; dx++) {
                        const pixel = (y * ss + dy) * W + x * ss + dx;
                        if (materialAt[pixel] < 0)
                            continue;
                        r += color[pixel * 3];
                        g += color[pixel * 3 + 1];
                        b += color[pixel * 3 + 2];
                        covered++;
                    }
                }
                if (!covered)
                    continue;
                const offset = (y * width + x) * 4;
                pixels[offset] = Math.round(r / covered * 255);
                pixels[offset + 1] = Math.round(g / covered * 255);
                pixels[offset + 2] = Math.round(b / covered * 255);
                pixels[offset + 3] = Math.round(covered / (ss * ss) * 255);
            }
        }
        return pixels;
    }
}
