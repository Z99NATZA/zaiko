# Aiko 3D model

`aiko.blend` is the editable Blender source. `aiko.glb` is its runtime mesh with
materials and idle animation tracks (body, head, arms, hair sway). Zaiko loads the GLB and projects its
live triangles into the existing GNOME Shell actor; it does not display the
Blender preview PNG.

Rebuild both model files with Blender 5.2 or later:

```sh
blender --background --python build_aiko.py
```

The script writes a temporary render preview to `/tmp/zaiko-aiko-preview.png`.
