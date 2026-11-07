"""Build Aiko's Blender source model and export an animated glTF binary.

Run with Blender 5.2+: blender --background --python build_aiko.py
Set ZAIKO_NO_RENDER=1 to skip the Cycles preview while iterating.

A chibi take on Aiko's original portraits: blue-black wavy hair with vivid
blue streaks and a side braid, violet-blue eyes, a blue diamond earring and
pendant, a white sleeveless ribbed turtleneck, and a black jacket worn off the
shoulders with blue lining. Proportions follow PGR-style dorm chibis: about
2.3 heads tall, short chubby limbs, big rounded shoes, and a little wave.
"""

import math
import os
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector

bpy.context.preferences.filepaths.save_version = 0

ROOT = Path(__file__).resolve().parent
BLEND_PATH = ROOT / "aiko.blend"
GLB_PATH = ROOT / "aiko.glb"
PREVIEW_PATH = Path("/tmp/zaiko-aiko-preview.png")
FPS = 24
END_FRAME = 48

# Head ellipsoid. Face details are placed on its surface with head_pt().
HEAD_C = Vector((0.0, 0.0, 2.58))
HEAD_R = Vector((0.50, 0.46, 0.56))
EYE_X, EYE_Z = 0.205, 2.33
MOUTH_Z = 2.09
# The head group is scaled up around the neck pivot for chibi proportions, so
# the exported mouth sits at HEAD_PIVOT_Z + (MOUTH_Z - HEAD_PIVOT_Z) * HEAD_SCALE
# (2.118); character3d.js draws the expression mouths there.
HEAD_PIVOT_Z = 2.02
HEAD_SCALE = 1.4
# Back hair hangs outside the head group, so it spreads to match the big head.
HAIR_SPREAD = 1.2
# Raising the feet shortens the legs to chibi (about 2.3 heads tall) proportions.
FOOT_Z = 0.24


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for data in list(bpy.data.materials):
        bpy.data.materials.remove(data)


clear_scene()


def srgb(r, g, b):
    def lin(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(r), lin(g), lin(b))


def material(name, color, roughness=0.42, metallic=0.0, subsurface=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1.0)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    if "Subsurface Weight" in shader.inputs:
        shader.inputs["Subsurface Weight"].default_value = subsurface
    return mat


SKIN = material("Aiko | porcelain skin", srgb(255, 232, 222), 0.32, subsurface=0.08)
SKIN_SHADE = material("Aiko | soft skin shade", srgb(238, 184, 176), 0.4)
BLUSH = material("Aiko | rose blush", srgb(255, 158, 168), 0.5)
BLUSH_LINE = material("Aiko | blush line", srgb(240, 120, 136), 0.5)
LIPS = material("Aiko | lips", srgb(206, 110, 120), 0.4)
HAIR = material("Aiko | blue-black hair", srgb(36, 38, 78), 0.3)
HAIR_SHADE = material("Aiko | hair shadow", srgb(18, 19, 42), 0.36)
HAIR_SHEEN = material("Aiko | hair sheen", srgb(122, 130, 186), 0.22)
HAIR_SHINE = material("Aiko | crown shine", srgb(92, 100, 160), 0.22)
STREAK = material("Aiko | electric blue streak", srgb(30, 88, 246), 0.25)
STREAK_LIGHT = material("Aiko | blue streak light", srgb(86, 156, 255), 0.2)
LASH = material("Aiko | lashes", srgb(26, 20, 34), 0.3)
EYE_WHITE = material("Aiko | eye white", srgb(255, 253, 252), 0.16)
IRIS_RIM = material("Aiko | iris rim", srgb(34, 30, 92), 0.2)
IRIS = material("Aiko | violet-blue iris", srgb(78, 84, 206), 0.18)
IRIS_LIGHT = material("Aiko | iris glow", srgb(150, 172, 255), 0.16)
PUPIL = material("Aiko | pupil", srgb(22, 18, 54), 0.13)
KNIT = material("Aiko | white ribbed knit", srgb(244, 244, 250), 0.5)
KNIT_SHADE = material("Aiko | knit rib shade", srgb(206, 208, 224), 0.5)
JACKET = material("Aiko | black jacket", srgb(28, 28, 38), 0.4)
JACKET_LIGHT = material("Aiko | jacket fold", srgb(52, 52, 70), 0.36)
LINING = material("Aiko | blue lining", srgb(36, 92, 240), 0.3)
PIPING = material("Aiko | white piping", srgb(236, 240, 255), 0.3)
SKIRT = material("Aiko | navy skirt", srgb(30, 32, 58), 0.4)
SOCK = material("Aiko | black socks", srgb(24, 24, 34), 0.45)
SHOE = material("Aiko | black shoes", srgb(18, 18, 26), 0.2, metallic=0.1)
SILVER = material("Aiko | silver", srgb(214, 220, 236), 0.2, metallic=0.8)
GEM = material("Aiko | blue crystal", srgb(34, 110, 246), 0.12, metallic=0.2)
GEM_LIGHT = material("Aiko | crystal glint", srgb(160, 214, 255), 0.1)

def make_rig():
    root = bpy.data.objects.new("Aiko_Root", None)
    bpy.context.collection.objects.link(root)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.15
    groups = {"root": root}
    for name, location in (("head", (0.0, 0.0, HEAD_PIVOT_Z)),
                           ("arm_l", (-0.26, 0.0, 1.88)),
                           ("arm_r", (0.26, 0.0, 1.88)),
                           ("hair_l", (-0.40, 0.1, 2.6)),
                           ("hair_r", (0.40, 0.1, 2.6))):
        pivot = bpy.data.objects.new(f"Aiko_{name.title()}_Pivot", None)
        bpy.context.collection.objects.link(pivot)
        pivot.empty_display_type = "SPHERE"
        pivot.empty_display_size = 0.05
        pivot.location = location
        pivot.parent = root
        groups[name] = pivot
    return groups


def attach(obj, group):
    bpy.context.view_layer.update()
    before = obj.matrix_world.copy()
    obj.parent = group
    obj.matrix_parent_inverse = group.matrix_world.inverted()
    obj.matrix_world = before
    bpy.context.view_layer.update()
    return obj


def finish(obj, mat, group="root"):
    if mat:
        obj.data.materials.append(mat)
    if obj.type == "MESH":
        for face in obj.data.polygons:
            face.use_smooth = True
    return attach(obj, groups[group])


def sphere(name, location, scale, mat, group="root", segments=12, rings=8):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    return finish(obj, mat, group)


def capsule(name, start, end, radius, mat, group="root", depth=None, segments=12, rings=8):
    start, end = Vector(start), Vector(end)
    delta = end - start
    obj = sphere(name, (start + end) / 2, (radius, depth or radius, delta.length / 2 + radius),
                 mat, group, segments, rings)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(delta.normalized())
    return obj


def torus(name, location, major, minor, mat, group="root", scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=14,
                                     minor_segments=4, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    return finish(obj, mat, group)


def diamond(name, location, size, mat, group="root", scale=(0.75, 0.38, 1.25), roll=0.0):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=size, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.rotation_euler = (0, roll, 0)
    obj.data.materials.append(mat)
    return attach(obj, groups[group])


def head_normal(x, z):
    """Outward normal of the front head surface at screen position (x, z)."""
    p = head_surface(x, z)
    n = Vector(((p.x - HEAD_C.x) / HEAD_R.x ** 2, (p.y - HEAD_C.y) / HEAD_R.y ** 2,
                (p.z - HEAD_C.z) / HEAD_R.z ** 2))
    return n.normalized()


def head_surface(x, z):
    t = 1 - ((x - HEAD_C.x) / HEAD_R.x) ** 2 - ((z - HEAD_C.z) / HEAD_R.z) ** 2
    return Vector((x, HEAD_C.y - HEAD_R.y * math.sqrt(max(t, 0.0)), z))


def head_pt(x, z, lift=0.0):
    return tuple(head_surface(x, z) + head_normal(x, z) * lift)


def decal(name, x, z, sx, sz, lift, thickness, mat, group="head", segments=14, rings=8, tilt=0.0):
    """A flattened ellipsoid lying on the face, e.g. an eye layer or blush."""
    obj = sphere(name, head_pt(x, z, lift), (sx, thickness, sz), mat, group, segments, rings)
    obj.rotation_mode = "QUATERNION"
    facing = Vector((0, -1, 0)).rotation_difference(head_normal(x, z))
    from mathutils import Quaternion
    obj.rotation_quaternion = facing @ Quaternion((0, 1, 0), tilt)
    return obj


def head_patch(name, x, z, rx, rz, lift, mat, group="head", rings=8, segments=18, rim=0.02):
    """An elliptical dome on the head surface that shades like skin.

    It rises to `lift` in the middle and settles to `rim` at the edge, so it
    covers the eye without leaving a visible step around it.
    """
    vertices = [head_pt(x, z, lift)]
    normals = [tuple(head_normal(x, z))]
    for ring in range(1, rings + 1):
        f = ring / rings
        height = rim + (lift - rim) * (1 - f ** 8)
        for index in range(segments):
            angle = 2 * math.pi * index / segments
            px, pz = x + rx * f * math.cos(angle), z + rz * f * math.sin(angle)
            vertices.append(head_pt(px, pz, height))
            normals.append(tuple(head_normal(px, pz)))
    faces = [(0, 1 + index, 1 + (index + 1) % segments) for index in range(segments)]
    for ring in range(rings - 1):
        for index in range(segments):
            a = 1 + ring * segments + index
            b = 1 + ring * segments + (index + 1) % segments
            faces.append((a, a + segments, b + segments, b))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(mat)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    mesh.update()
    # Use the head's own normals so the patch shades exactly like the face under it.
    mesh.normals_split_custom_set_from_vertices(normals)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return attach(obj, groups[group])


def hair_lock(name, points, widths, mat, group="root", depth=0.03, steps=4, sides=6):
    """Smooth, flattened, tapered ribbon volume for a hair lock or fabric panel."""
    controls = [Vector(point) for point in points]
    samples = []
    for segment in range(len(controls) - 1):
        p0 = controls[max(0, segment - 1)]
        p1 = controls[segment]
        p2 = controls[segment + 1]
        p3 = controls[min(len(controls) - 1, segment + 2)]
        for step in range(steps):
            t = step / steps
            t2, t3 = t * t, t * t * t
            point = 0.5 * ((2 * p1) + (-p0 + p2) * t +
                           (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
                           (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
            width = widths[segment] * (1 - t) + widths[segment + 1] * t
            samples.append((point, width))
    samples.append((controls[-1], widths[-1]))

    vertices, faces = [], []
    view = Vector((0, -1, 0))
    for index, (point, width) in enumerate(samples):
        tangent = (samples[min(index + 1, len(samples) - 1)][0] -
                   samples[max(index - 1, 0)][0]).normalized()
        across = tangent.cross(view).normalized()
        if across.length < 0.01:
            across = Vector((1, 0, 0))
        deep = tangent.cross(across).normalized()
        radius = max(0.003, width)
        for side in range(sides):
            angle = 2 * math.pi * side / sides
            offset = across * (math.cos(angle) * radius) + deep * (math.sin(angle) * depth * min(1, radius / 0.02))
            vertices.append(tuple(point + offset))
    for ring in range(len(samples) - 1):
        for side in range(sides):
            a = ring * sides + side
            b = ring * sides + (side + 1) % sides
            faces.append((a, b, b + sides, a + sides))
    faces.extend((tuple(reversed(range(sides))),
                  tuple((len(samples) - 1) * sides + side for side in range(sides))))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(mat)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    return attach(obj, groups[group])


def curve(name, points, bevel, mat, group="root", taper=False):
    data = bpy.data.curves.new(name, "CURVE")
    data.dimensions = "3D"
    data.resolution_u = 4
    data.bevel_depth = bevel
    data.bevel_resolution = 1
    spline = data.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for index, (point, coordinate) in enumerate(zip(spline.bezier_points, points)):
        point.co = coordinate
        point.handle_left_type = "AUTO"
        point.handle_right_type = "AUTO"
        if taper:
            point.radius = 0.25 if index in (0, len(points) - 1) else 1.0
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    data.materials.append(mat)
    return attach(obj, groups[group])


def skirt(name, mat, z_top, r_top, hem, flare, rows=6, segments=40, folds=9, depth_ratio=0.82):
    """Flared skirt layer. hem(angle) gives the hem height; angle -90deg is the front."""
    vertices, faces = [], []
    for row in range(rows + 1):
        f = row / rows
        for index in range(segments):
            angle = 2 * math.pi * index / segments
            z_hem = hem(angle)
            z = z_top + (z_hem - z_top) * f
            radius = r_top + (flare - r_top) * (f ** 0.8)
            radius *= 1.0 + 0.07 * f * math.cos(angle * folds)
            vertices.append((radius * math.cos(angle), radius * depth_ratio * math.sin(angle), z))
    for row in range(rows):
        for index in range(segments):
            a = row * segments + index
            b = row * segments + (index + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(mat)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return attach(obj, groups["root"])


def front(angle):
    """1 at the front of the body, 0 at the sides, -1 at the back."""
    return -math.sin(angle)



def ellipsoid_front(center, radii, x, z):
    t = 1 - ((x - center[0]) / radii[0]) ** 2 - ((z - center[2]) / radii[2]) ** 2
    return center[1] - radii[1] * math.sqrt(max(t, 0.0))


TORSO = ((0, -0.005, 1.68), (0.165, 0.125, 0.22))
BUST = ((0, -0.025, 1.70), (0.15, 0.118, 0.08))


def torso_pt(x, z, lift=0.004):
    y = min(ellipsoid_front(*TORSO, x, z), ellipsoid_front(*BUST, x, z))
    return (x, y - lift, z)


def create_body():
    # Big rounded Mary Janes with a blue strap and gem, and black knee socks.
    f = FOOT_Z
    for side, label in ((-1, "L"), (1, "R")):
        x = side * 0.12
        sphere(f"Shoe_{label}", (x, -0.045, f + 0.06), (0.082, 0.125, 0.07), SHOE, segments=16, rings=10)
        sphere(f"Shoe_sole_{label}", (x, -0.045, f), (0.086, 0.13, 0.022), JACKET_LIGHT)
        torus(f"Shoe_strap_{label}", (x, -0.06, f + 0.10), 0.066, 0.011, LINING, scale=(1, 0.65, 0.5))
        diamond(f"Shoe_gem_{label}", (x, -0.165, f + 0.085), 0.022, GEM_LIGHT)
        capsule(f"Sock_{label}", (x, 0, f + 0.1), (x, 0, 0.80), 0.064, SOCK)
        torus(f"Sock_band_{label}", (x, 0, 0.79), 0.066, 0.012, LINING)
        capsule(f"Leg_lower_{label}", (x, 0, 0.76), (x, 0, 1.0), 0.062, SKIN)
        capsule(f"Leg_upper_{label}", (x * 0.95, 0, 0.98), (x * 0.8, 0, 1.45), 0.078, SKIN)

    # Neck and the white sleeveless ribbed turtleneck.
    capsule("Neck", (0, 0.015, 1.86), (0, 0.015, 2.12), 0.058, SKIN)
    capsule("Turtleneck_collar", (0, 0.01, 1.86), (0, 0.01, 1.95), 0.072, KNIT, segments=16)
    torus("Collar_fold", (0, 0.01, 1.90), 0.074, 0.007, KNIT_SHADE)
    sphere("Torso", TORSO[0], TORSO[1], KNIT, segments=20, rings=14)
    sphere("Bust", BUST[0], BUST[1], KNIT, segments=20, rings=12)
    sphere("Waist", (0, 0.0, 1.53), (0.13, 0.105, 0.11), KNIT, segments=18, rings=10)
    for i, x in enumerate((-0.1, -0.05, 0.0, 0.05, 0.1)):
        curve(f"Knit_rib_{i}", [torso_pt(x * 0.8, 1.84), torso_pt(x, 1.72), torso_pt(x * 0.9, 1.58)],
              0.004, KNIT_SHADE)
    # Bare shoulders beside the sleeveless top.
    for side in (-1, 1):
        sphere(f"Shoulder_cap_{side}", (side * 0.18, 0.0, 1.83), (0.075, 0.07, 0.055), SKIN)

    # Silver chain and blue diamond pendant.
    for side in (-1, 1):
        curve(f"Necklace_{side}", [(side * 0.075, -0.05, 1.86), (side * 0.06, -0.15, 1.76),
              (side * 0.012, -0.178, 1.665)], 0.0045, SILVER)
    torus("Pendant_frame", (0, -0.185, 1.635), 0.026, 0.005, SILVER, scale=(0.8, 1, 1.3))
    bpy.context.object.rotation_euler = (math.radians(90), 0, 0)
    diamond("Pendant", (0, -0.19, 1.635), 0.038, GEM, scale=(0.62, 0.35, 1.0))
    diamond("Pendant_glint", (-0.008, -0.205, 1.65), 0.01, GEM_LIGHT, scale=(0.6, 0.3, 1))

    # Short pleated navy skirt with a blue hem stripe.
    skirt("Skirt", SKIRT, 1.53, 0.15, lambda a: 1.13 - 0.03 * (1 - max(0, front(a))), 0.36, folds=14)
    sphere("Skirt_waistband", (0, 0.0, 1.52), (0.155, 0.125, 0.035), SKIRT)
    skirt("Skirt_stripe", LINING, 1.17, 0.335, lambda a: 1.145 - 0.03 * (1 - max(0, front(a))), 0.355,
          rows=1, folds=14)

    # Arms: the left rests by her side, the right waves beside her cheek.
    arms = {}
    for side, label, group in ((-1, "L", "arm_l"), (1, "R", "arm_r")):
        shoulder = Vector((side * 0.215, 0.0, 1.84))
        if side < 0:
            elbow = Vector((side * 0.31, -0.01, 1.60))
            wrist = Vector((side * 0.33, -0.05, 1.40))
            hand = Vector((side * 0.33, -0.065, 1.335))
        else:
            elbow = Vector((side * 0.36, -0.16, 1.66))
            wrist = Vector((side * 0.37, -0.42, 1.90))
            hand = Vector((side * 0.37, -0.45, 1.97))
        arms[side] = (shoulder, elbow, wrist, group)
        capsule(f"Upper_arm_{label}", shoulder, elbow, 0.056, SKIN, group)
        capsule(f"Forearm_{label}", elbow, wrist, 0.05, SKIN, group)
        sphere(f"Hand_{label}", tuple(hand), (0.052, 0.038, 0.062), SKIN, group, 12, 8)
        if side > 0:
            capsule("Thumb_R", tuple(hand + Vector((-0.04, -0.01, -0.02))), tuple(hand + Vector((-0.06, -0.015, 0.02))),
                    0.017, SKIN, group, segments=8, rings=6)

    # Black jacket slipped off the shoulders: it hangs from the elbows with
    # its blue lining and white piping showing at the open collar.
    capsule("Jacket_back", (0, 0.13, 1.74), (0, 0.13, 1.22), 0.25, JACKET, depth=0.08, segments=16)
    curve("Jacket_collar", [(-0.36, -0.07, 1.66), (-0.30, 0.12, 1.72), (0, 0.20, 1.76),
                            (0.30, 0.12, 1.72), (0.36, -0.07, 1.66)], 0.04, JACKET)
    curve("Jacket_collar_lining", [(-0.35, -0.105, 1.69), (-0.30, 0.08, 1.765), (0, 0.16, 1.80),
                                   (0.30, 0.08, 1.765), (0.35, -0.105, 1.69)], 0.024, LINING)
    for side in (-1, 1):
        shoulder, elbow, wrist, group = arms[side]
        top = shoulder.lerp(elbow, 0.55)
        capsule(f"Jacket_sleeve_{side}", top + Vector((side * 0.025, 0.01, 0)), wrist.lerp(elbow, 0.1),
                0.085, JACKET, group, segments=14)
        capsule(f"Jacket_fold_{side}", top + Vector((side * 0.06, -0.04, -0.05)),
                elbow + Vector((side * 0.05, -0.05, -0.06)), 0.03, JACKET_LIGHT, group)
        torus(f"Jacket_cuff_{side}", tuple(wrist.lerp(elbow, 0.12)), 0.083, 0.014, LINING, group)
        torus(f"Jacket_cuff_piping_{side}", tuple(wrist.lerp(elbow, 0.2)), 0.085, 0.006, PIPING, group)
        curve(f"Sleeve_piping_{side}", [tuple(top + Vector((side * 0.07, -0.06, 0.0))),
              tuple(elbow + Vector((side * 0.075, -0.06, -0.02))),
              tuple(wrist.lerp(elbow, 0.3) + Vector((side * 0.06, -0.06, 0)))], 0.006, PIPING, group)
        # Front panels drop from the elbows past the hips; lining on the inner edge.
        hair_lock(f"Jacket_panel_{side}", [(side * 0.36, -0.02, 1.62), (side * 0.38, -0.03, 1.40),
                  (side * 0.36, -0.03, 1.18)], [0.07, 0.08, 0.075], JACKET, depth=0.035)
        hair_lock(f"Jacket_lining_{side}", [(side * 0.30, -0.075, 1.60), (side * 0.31, -0.08, 1.40),
                  (side * 0.30, -0.075, 1.19)], [0.012, 0.016, 0.014], LINING, depth=0.01)
        torus(f"Jacket_strap_{side}", (side * 0.40, -0.05, 1.30), 0.025, 0.006, SILVER, scale=(1, 0.4, 0.6))


def create_head():
    sphere("Head", tuple(HEAD_C), tuple(HEAD_R), SKIN, "head", 32, 24)
    for side in (-1, 1):
        decal(f"Blush_{side}", side * 0.30, 2.135, 0.08, 0.038, 0.016, 0.01, BLUSH)
        for i in range(3):
            curve(f"Blush_line_{side}_{i}", [head_pt(side * (0.26 + i * 0.03), 2.155, 0.026),
                  head_pt(side * (0.25 + i * 0.03), 2.125, 0.026)], 0.003, BLUSH_LINE, "head")

    # Viewer-left ear shows where the braid tucks the hair back.
    sphere("Ear", (-0.485, -0.03, 2.33), (0.055, 0.045, 0.085), SKIN, "head")
    sphere("Ear_inner", (-0.505, -0.06, 2.33), (0.03, 0.02, 0.055), SKIN_SHADE, "head", 10, 6)
    sphere("Earring_hook", (-0.49, -0.06, 2.24), (0.012, 0.012, 0.025), SILVER, "head", 8, 6)
    capsule("Earring_chain", (-0.49, -0.065, 2.22), (-0.49, -0.07, 2.16), 0.005, SILVER, "head", segments=6, rings=4)
    diamond("Earring_gem", (-0.49, -0.075, 2.11), 0.045, GEM, "head", (0.55, 0.35, 1.1))
    diamond("Earring_glint", (-0.497, -0.092, 2.125), 0.012, GEM_LIGHT, "head")
    capsule("Earring_drop", (-0.49, -0.07, 2.06), (-0.49, -0.07, 2.02), 0.005, SILVER, "head", segments=6, rings=4)

    # Large layered anime eyes: violet-blue iris with a bright lower glow.
    for side, label in ((-1, "L"), (1, "R")):
        x = side * EYE_X
        tilt = side * math.radians(5)
        decal(f"Eye_white_{label}", x, EYE_Z, 0.122, 0.142, 0.0, 0.03, EYE_WHITE, tilt=tilt)
        decal(f"Iris_rim_{label}", x + side * 0.006, EYE_Z - 0.012, 0.102, 0.132, 0.012, 0.026, IRIS_RIM)
        decal(f"Iris_{label}", x + side * 0.006, EYE_Z - 0.02, 0.088, 0.115, 0.022, 0.022, IRIS)
        decal(f"Iris_low_{label}", x + side * 0.006, EYE_Z - 0.062, 0.066, 0.05, 0.034, 0.016, IRIS_LIGHT)
        decal(f"Pupil_{label}", x + side * 0.006, EYE_Z - 0.008, 0.036, 0.065, 0.036, 0.016, PUPIL)
        decal(f"Glint_{label}", x - 0.035, EYE_Z + 0.045, 0.034, 0.04, 0.05, 0.012, EYE_WHITE)
        decal(f"Glint_small_{label}", x + 0.04, EYE_Z - 0.06, 0.015, 0.017, 0.05, 0.01, EYE_WHITE,
              segments=10, rings=6)
        # Thick upper lash with a winged outer corner, a lid crease, and a soft lower lash.
        lash = [head_pt(x - side * 0.13, EYE_Z + 0.055, 0.035), head_pt(x - side * 0.06, EYE_Z + 0.135, 0.04),
                head_pt(x + side * 0.05, EYE_Z + 0.14, 0.04), head_pt(x + side * 0.13, EYE_Z + 0.075, 0.035),
                head_pt(x + side * 0.17, EYE_Z + 0.085, 0.03)]
        curve(f"Upper_lash_{label}", lash, 0.02, LASH, "head")
        curve(f"Lid_crease_{label}", [head_pt(x - side * 0.09, EYE_Z + 0.16, 0.02),
              head_pt(x + side * 0.02, EYE_Z + 0.185, 0.02), head_pt(x + side * 0.12, EYE_Z + 0.14, 0.02)],
              0.004, SKIN_SHADE, "head")
        curve(f"Lower_lash_{label}", [head_pt(x - side * 0.06, EYE_Z - 0.125, 0.03), head_pt(x, EYE_Z - 0.142, 0.03),
              head_pt(x + side * 0.09, EYE_Z - 0.115, 0.03)], 0.006, SKIN_SHADE, "head")
        curve(f"Brow_{label}", [head_pt(x - side * 0.08, EYE_Z + 0.24, 0.02), head_pt(x, EYE_Z + 0.26, 0.02),
              head_pt(x + side * 0.09, EYE_Z + 0.24, 0.02)], 0.007, HAIR, "head")

    # Wink for the happy expression: a skin lid over the viewer-left eye and a closed-eye arc.
    x = -EYE_X
    head_patch("happy_Wink_lid", x - 0.015, EYE_Z + 0.02, 0.19, 0.17, 0.08, SKIN)
    curve("happy_Wink_arc", [head_pt(x - 0.12, EYE_Z - 0.01, 0.09), head_pt(x - 0.04, EYE_Z + 0.04, 0.09),
          head_pt(x + 0.05, EYE_Z + 0.035, 0.09), head_pt(x + 0.13, EYE_Z - 0.02, 0.09)], 0.018, LASH, "head")
    curve("happy_Wink_lash", [head_pt(x + 0.12, EYE_Z - 0.01, 0.09), head_pt(x + 0.16, EYE_Z + 0.025, 0.09)],
          0.01, LASH, "head")

    # Tiny nose and mouth.
    decal("Nose", 0, 2.2, 0.012, 0.01, 0.005, 0.008, SKIN_SHADE, segments=8, rings=6)
    curve("Mouth", [head_pt(-0.035, MOUTH_Z + 0.006, 0.008), head_pt(0, MOUTH_Z - 0.006, 0.008),
                    head_pt(0.035, MOUTH_Z + 0.006, 0.008)], 0.006, LIPS, "head")


CROWN_C = Vector((0, -0.03, 2.86))
CROWN_R = Vector((0.54, 0.46, 0.40))


def crown_pt(x, z, lift=0.0):
    """Point on the front of the hair crown, pushed out along its normal."""
    t = 1 - ((x - CROWN_C.x) / CROWN_R.x) ** 2 - ((z - CROWN_C.z) / CROWN_R.z) ** 2
    p = Vector((x, CROWN_C.y - CROWN_R.y * math.sqrt(max(t, 0.0)), z))
    n = Vector(((p.x - CROWN_C.x) / CROWN_R.x ** 2, (p.y - CROWN_C.y) / CROWN_R.y ** 2,
                (p.z - CROWN_C.z) / CROWN_R.z ** 2)).normalized()
    return tuple(p + n * lift)


def create_hair():
    # Skull volume: back cap plus a crown that stays behind the face.
    sphere("Hair_back_cap", (0, 0.07, 2.66), (0.57, 0.50, 0.62), HAIR, "head", 28, 18)
    sphere("Hair_crown", tuple(CROWN_C), tuple(CROWN_R), HAIR, "head", 28, 18)
    # Glossy "angel ring" highlight across the crown.
    # Zigzag anime shine across the crown: overlapping downward points.
    band = [crown_pt(x, 3.07 - 0.45 * x * x, 0.012) for x in (-0.42, -0.28, -0.14, 0.0, 0.14, 0.28, 0.42)]
    hair_lock("Crown_shine_band", band, [0.004, 0.02, 0.026, 0.028, 0.026, 0.02, 0.004], HAIR_SHINE, "head", 0.006)
    lengths = (0.05, 0.09, 0.06, 0.12, 0.07, 0.10, 0.06, 0.11, 0.05)
    for i, length in enumerate(lengths):
        x = -0.36 + i * 0.09
        z = 3.06 - 0.45 * x * x
        size = 0.058 * (1 - abs(x) * 1.1)
        hair_lock(f"Crown_sheen_{i}", [crown_pt(x, z + 0.02, 0.012), crown_pt(x + 0.004, z - length, 0.012)],
                  [size, 0.002], HAIR_SHINE, "head", 0.006, steps=3)
    for i, x in enumerate((-0.30, -0.18, -0.06, 0.08, 0.2, 0.32)):
        hair_lock(f"Crown_strand_{i}", [crown_pt(x * 0.2, 3.24, 0.006), crown_pt(x * 0.55, 3.16, 0.006),
                  crown_pt(x * 0.75, 3.10, 0.006)], [0.002, 0.008, 0.002], HAIR_SHADE, "head", 0.004)

    # Ahoge: a springy cowlick on top.
    hair_lock("Ahoge", [crown_pt(0.02, 3.22, -0.01), (0.03, -0.06, 3.38), (0.12, -0.07, 3.44),
              (0.19, -0.05, 3.38), (0.16, -0.04, 3.31)], [0.022, 0.026, 0.02, 0.012, 0.003], HAIR, "head", 0.018)

    # Fringe: soft pointed strands parted slightly off-centre, one wisp between the eyes.
    fringe = (
        (-0.04, -0.06, 2.42, 0.085, HAIR), (-0.18, -0.26, 2.47, 0.095, HAIR),
        (-0.31, -0.40, 2.38, 0.075, HAIR), (0.08, 0.12, 2.49, 0.09, HAIR),
        (0.21, 0.29, 2.46, 0.095, HAIR), (0.34, 0.43, 2.32, 0.065, HAIR),
        (0.0, 0.015, 2.37, 0.03, HAIR),
    )
    for i, (x0, x1, z_end, width, mat) in enumerate(fringe):
        hair_lock(f"Fringe_{i}", [head_pt(x0 * 0.5, 3.12, 0.08), head_pt(x0, 2.92, 0.075),
                  head_pt((x0 + x1) / 2, (2.92 + z_end) / 2, 0.065), head_pt(x1, z_end, 0.055)],
                  [0.01, width, width * 0.8, 0.004], mat, "head", 0.022)

    # Viewer-right: face-framing locks with a bright blue streak underneath.
    s = 1
    hair_lock("Sidelock_streak_R", [(0.44, -0.18, 2.55), (0.48, -0.22, 2.15), (0.42, -0.2, 1.80),
              (0.46, -0.17, 1.50), (0.42, -0.15, 1.30)], [0.03, 0.05, 0.05, 0.04, 0.004], STREAK, "head", 0.03)
    hair_lock("Sidelock_inner_R", [head_pt(s * 0.36, 2.85, 0.07), (s * 0.43, -0.30, 2.45),
              (s * 0.42, -0.26, 2.05), (s * 0.36, -0.23, 1.78), (s * 0.40, -0.21, 1.58)],
              [0.02, 0.06, 0.05, 0.04, 0.005], HAIR, "head", 0.03)
    hair_lock("Sidelock_outer_R", [(s * 0.45, -0.16, 2.80), (s * 0.53, -0.19, 2.35),
              (s * 0.50, -0.16, 1.92), (s * 0.45, -0.14, 1.60), (s * 0.52, -0.12, 1.36),
              (s * 0.48, -0.11, 1.18)], [0.03, 0.08, 0.07, 0.06, 0.05, 0.005], HAIR, "head", 0.035)
    hair_lock("Sidelock_sheen_R", [(0.45, -0.25, 2.55), (0.49, -0.25, 2.2), (0.44, -0.23, 1.85)],
              [0.004, 0.016, 0.003], HAIR_SHEEN, "head", 0.01)
    hair_lock("Sidelock_blue_tip_R", [(0.47, -0.19, 1.62), (0.53, -0.17, 1.38), (0.49, -0.15, 1.20)],
              [0.01, 0.03, 0.004], STREAK_LIGHT, "head", 0.015)

    # Viewer-left: hair tucked behind the ear into a braid that falls over the shoulder.
    hair_lock("Tuck_L", [head_pt(-0.30, 2.92, 0.07), head_pt(-0.42, 2.62, 0.07), (-0.47, 0.02, 2.42)],
              [0.03, 0.07, 0.03], HAIR, "head", 0.03)
    hair_lock("Sidelock_streak_L", [(-0.43, -0.12, 2.45), (-0.47, -0.10, 2.05), (-0.43, -0.10, 1.70),
              (-0.47, -0.08, 1.40)], [0.02, 0.04, 0.04, 0.004], STREAK, "head", 0.025)
    braid = [(-0.36, -0.30, 2.82), (-0.44, -0.22, 2.62), (-0.53, -0.08, 2.40), (-0.55, -0.06, 2.18),
             (-0.50, -0.12, 1.95), (-0.45, -0.17, 1.72), (-0.44, -0.19, 1.52)]
    path = []
    for a, b in zip(braid, braid[1:]):
        for t in (0.0, 0.34, 0.67):
            path.append(Vector(a).lerp(Vector(b), t))
    for i, point in enumerate(path):
        offset = Vector((0.016 if i % 2 else -0.016, 0, 0))
        size = 0.052 - 0.014 * i / len(path)
        sphere(f"Braid_link_{i}", tuple(point + offset), (size, size * 0.75, size * 1.25),
               HAIR, "head", 10, 7)
        hair_lock(f"Braid_shine_{i}", [tuple(point + offset + Vector((-0.02 * (1 if i % 2 else -1), -size * 0.7, 0.03))),
                  tuple(point + offset + Vector((0.02 * (1 if i % 2 else -1), -size * 0.75, -0.02)))],
                  [0.006, 0.003], HAIR_SHEEN, "head", 0.004, steps=2, sides=4)
        if i % 3 == 0 and i >= 3:
            curve(f"Braid_blue_{i}", [tuple(point + Vector((-0.03, -0.035, 0.02))),
                  tuple(point + Vector((0.03, -0.04, -0.02)))], 0.009, STREAK_LIGHT, "head", taper=True)
    end = Vector(braid[-1])
    torus("Braid_tie", tuple(end + Vector((0, 0, -0.02))), 0.025, 0.01, JACKET, "head")
    hair_lock("Braid_tuft", [tuple(end + Vector((0, 0, -0.03))), tuple(end + Vector((-0.02, -0.01, -0.12))),
              tuple(end + Vector((0.01, -0.01, -0.22)))], [0.03, 0.05, 0.004], HAIR, "head", 0.03)
    hair_lock("Braid_tuft_blue", [tuple(end + Vector((0.01, -0.03, -0.05))), tuple(end + Vector((0.0, -0.035, -0.15))),
              tuple(end + Vector((0.03, -0.03, -0.21)))], [0.008, 0.016, 0.003], STREAK, "head", 0.01)

    # Long wavy back hair falling to the hips, with blue underlayers.
    for side, group in ((-1, "hair_l"), (1, "hair_r")):
        s = side
        hair_lock(f"Back_hair_main_{s}", [(s * 0.40 * HAIR_SPREAD, 0.22, 2.90), (s * 0.60 * HAIR_SPREAD, 0.22, 2.35),
                  (s * 0.62 * HAIR_SPREAD, 0.22, 1.85), (s * 0.56 * HAIR_SPREAD, 0.22, 1.45), (s * 0.66 * HAIR_SPREAD, 0.22, 1.10),
                  (s * 0.60 * HAIR_SPREAD, 0.22, 0.88)],
                  [0.08, 0.20, 0.20, 0.19, 0.16, 0.02], HAIR_SHADE, group, 0.06)
        hair_lock(f"Back_hair_blue_{s}", [(s * 0.55 * HAIR_SPREAD, 0.12, 2.20), (s * 0.66 * HAIR_SPREAD, 0.12, 1.75),
                  (s * 0.62 * HAIR_SPREAD, 0.12, 1.35), (s * 0.74 * HAIR_SPREAD, 0.12, 1.05), (s * 0.70 * HAIR_SPREAD, 0.12, 0.90)],
                  [0.03, 0.08, 0.08, 0.06, 0.006], STREAK, group, 0.03)
        hair_lock(f"Back_hair_front_{s}", [(s * 0.50 * HAIR_SPREAD, 0.05, 2.70), (s * 0.60 * HAIR_SPREAD, 0.05, 2.20),
                  (s * 0.56 * HAIR_SPREAD, 0.06, 1.75), (s * 0.60 * HAIR_SPREAD, 0.06, 1.38), (s * 0.70 * HAIR_SPREAD, 0.06, 1.12),
                  (s * 0.64 * HAIR_SPREAD, 0.06, 0.95)],
                  [0.04, 0.11, 0.11, 0.10, 0.08, 0.008], HAIR, group, 0.04)
        hair_lock(f"Back_hair_curl_{s}", [(s * 0.64 * HAIR_SPREAD, 0.0, 1.70), (s * 0.74 * HAIR_SPREAD, 0.0, 1.42),
                  (s * 0.70 * HAIR_SPREAD, 0.0, 1.18), (s * 0.78 * HAIR_SPREAD, 0.0, 1.00), (s * 0.74 * HAIR_SPREAD, 0.0, 0.90)],
                  [0.02, 0.05, 0.05, 0.035, 0.004], HAIR, group, 0.03)
        hair_lock(f"Back_hair_sheen_{s}", [(s * 0.57 * HAIR_SPREAD, 0.0, 2.30), (s * 0.60 * HAIR_SPREAD, 0.0, 1.85),
                  (s * 0.57 * HAIR_SPREAD, 0.0, 1.45), (s * 0.66 * HAIR_SPREAD, 0.0, 1.15)],
                  [0.004, 0.02, 0.018, 0.003], HAIR_SHEEN, group, 0.01)
    hair_lock("Back_hair_center", [(0, 0.30, 2.6), (0, 0.32, 1.9), (0, 0.30, 1.50), (0, 0.28, 1.25)],
              [0.30, 0.38, 0.34, 0.04], HAIR_SHADE, "root", 0.05)


def create_character():
    global groups
    groups = make_rig()
    create_body()
    create_head()
    create_hair()
    groups["head"].scale = (HEAD_SCALE,) * 3


def animate_rig():
    root = groups["root"]
    head = groups["head"]
    arm_l, arm_r = groups["arm_l"], groups["arm_r"]
    hair_l, hair_r = groups["hair_l"], groups["hair_r"]
    for frame, amount in ((1, 0.0), (END_FRAME // 2 + 1, 1.0), (END_FRAME + 1, 0.0)):
        root.location.z = 0.025 * amount
        root.keyframe_insert("location", frame=frame, group="Idle: body sway")
        head.rotation_euler[1] = math.radians(2.5) * amount
        head.keyframe_insert("rotation_euler", frame=frame, group="Idle: head tilt")
        arm_l.rotation_euler[1] = math.radians(-3.0) * amount
        arm_l.keyframe_insert("rotation_euler", frame=frame, group="Idle: left arm")
        arm_r.rotation_euler[1] = math.radians(-9.0) * amount
        arm_r.keyframe_insert("rotation_euler", frame=frame, group="Idle: right arm")
        hair_l.rotation_euler[1] = math.radians(1.5) * amount
        hair_l.keyframe_insert("rotation_euler", frame=frame, group="Idle: hair sway")
        hair_r.rotation_euler[1] = math.radians(1.5) * amount
        hair_r.keyframe_insert("rotation_euler", frame=frame, group="Idle: hair sway")
    bpy.context.scene.frame_end = END_FRAME
    bpy.context.scene.render.fps = FPS
    bpy.context.scene.frame_set(1)


def setup_camera_and_lights():
    bpy.ops.object.camera_add(location=(0, -8.5, 1.8))
    camera = bpy.context.object
    camera.name = "Aiko_Preview_Camera"
    target = Vector((0, 0, 1.8))
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 3.9
    bpy.context.scene.camera = camera

    def area_light(name, location, energy, color, size, target_point):
        bpy.ops.object.light_add(type="AREA", location=location)
        light = bpy.context.object
        light.name = name
        light.data.energy = energy
        light.data.color = color
        light.data.shape = "DISK"
        light.data.size = size
        light.rotation_euler = (Vector(target_point) - light.location).to_track_quat("-Z", "Y").to_euler()

    area_light("Key | softbox", (-3.8, -4.0, 6.0), 470, (1.0, 0.92, 0.86), 4.0, (0, 0, 1.8))
    area_light("Fill | warm", (3.5, -3.0, 3.1), 250, (1.0, 0.93, 0.86), 3.0, (0, 0, 1.8))
    area_light("Rim | cool", (0.0, 2.5, 4.4), 400, (0.7, 0.8, 1.0), 3.0, (0, 0, 2.0))


def export_files():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 32
    scene.render.resolution_x = 640
    scene.render.resolution_y = 800
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "Standard"
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(PREVIEW_PATH)
    if scene.world is None:
        scene.world = bpy.data.worlds.new("World")
    scene.world.color = (0.12, 0.12, 0.12)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
    if not os.environ.get("ZAIKO_NO_RENDER"):
        bpy.ops.render.render(write_still=True)
    # Keep editable curves in the .blend; only the runtime GLB gets tube meshes.
    for obj in list(bpy.data.objects):
        if obj.type != "CURVE":
            continue
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.convert(target="MESH")
    # The runtime rasterizes on the CPU, so trim only the densest meshes.
    for obj in bpy.data.objects:
        if obj.type == "MESH" and len(obj.data.polygons) > 400 and obj.name != "Head":
            modifier = obj.modifiers.new("glTF runtime mesh", "DECIMATE")
            modifier.ratio = 0.6
    bpy.ops.export_scene.gltf(filepath=str(GLB_PATH), export_format="GLB", export_animations=True,
                              export_image_format="AUTO", export_apply=True)


create_character()
animate_rig()
setup_camera_and_lights()
export_files()
print(f"Created {BLEND_PATH} and {GLB_PATH}")
