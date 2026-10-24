"""Export a lightweight game level from build/house.blend for the Zombies page.

Run (read-only — this script never saves the .blend):
  /Applications/Blender.app/Contents/MacOS/Blender -b build/house.blend --python zombies/export_level.py

Writes zombies/build/level.glb and zombies/build/level_meta.json (plan metres, Blender Z up).
Node name prefixes tell the game how to treat each mesh:
  S_ structure (collides)   F_ furniture (collides)   G_ glass (render only)
  T_ near terrain (collides near the house)           X_ far terrain (render only)
  W_ water (render only)    E_ fire/flame (emissive)  P_ prototypes (instanced in-game)
"""
import json
import math
import random
import re
from pathlib import Path

import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
PROJ = HERE.parents[2]
OUT = HERE / "build"
OUT.mkdir(exist_ok=True)
random.seed(11)

sc = bpy.context.scene
dg = bpy.context.evaluated_depsgraph_get()

# ---------------------------------------------------------------- materials
NAMED = {  # linear RGB for procedural Blender materials
    "cedar": (0.10, 0.065, 0.04), "limewash": (0.62, 0.58, 0.52), "board_formed": (0.30, 0.29, 0.27),
    "ceiling": (0.42, 0.31, 0.2), "courtyard": (0.36, 0.34, 0.3), "deck": (0.2, 0.13, 0.08),
    "gravel": (0.3, 0.28, 0.25), "louvre": (0.11, 0.075, 0.05), "oak": (0.38, 0.25, 0.14),
    "oak_natural": (0.45, 0.32, 0.19), "schist": (0.22, 0.2, 0.18), "terrain": (0.25, 0.19, 0.09),
    "tile": (0.45, 0.55, 0.52), "boucle": (0.72, 0.69, 0.62), "jute": (0.4, 0.3, 0.17),
    "travertine": (0.6, 0.52, 0.4), "walnut_dark": (0.1, 0.06, 0.035), "water": (0.03, 0.12, 0.14),
    "glass": (0.6, 0.7, 0.72), "flame": (1.0, 0.45, 0.1), "lake": (0.02, 0.05, 0.07),
    "sheer_linen": (0.75, 0.72, 0.65), "aluminium": (0.04, 0.04, 0.04),
}


def upstream(node, kinds, seen=None):
    seen = seen or set()
    if node in seen:
        return None
    seen.add(node)
    if node.type in kinds:
        return node
    for inp in node.inputs:
        for link in inp.links:
            hit = upstream(link.from_node, kinds, seen)
            if hit:
                return hit
    return None


def image_average(img):
    try:
        small = img.copy()
        small.scale(8, 8)
        px = list(small.pixels)
        bpy.data.images.remove(small)
        n = len(px) // 4
        return tuple(sum(px[i * 4 + c] for i in range(n)) / n for c in range(3))
    except Exception:
        return None


def material_colour(m):
    if m.name in NAMED:
        return NAMED[m.name]
    lin = re.match(r"linen_([\d.]+)_([\d.]+)_([\d.]+)", m.name)
    if lin:
        return tuple(float(v) ** 2.2 for v in lin.groups())
    if m.node_tree:
        p = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if p:
            bc = p.inputs["Base Color"]
            if not bc.is_linked:
                return tuple(bc.default_value[:3])
            src = upstream(bc.links[0].from_node, {"TEX_IMAGE", "VALTORGB"})
            if src and src.type == "TEX_IMAGE" and src.image:
                avg = image_average(src.image)
                if avg:
                    return avg
            if src and src.type == "VALTORGB":
                els = src.color_ramp.elements
                return tuple(sum(e.color[c] for e in els) / len(els) for c in range(3))
    return (0.4, 0.38, 0.35)


SIMPLE = {}


def simple_material(m):
    if m.name in SIMPLE:
        return SIMPLE[m.name]
    s = bpy.data.materials.new("z_" + m.name)
    tree = s.node_tree if s.node_tree else None
    if tree is None:
        s.use_nodes = True
        tree = s.node_tree
    p = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    col = material_colour(m)
    p.inputs["Base Color"].default_value = (*col, 1)
    p.inputs["Roughness"].default_value = 0.85
    p.inputs["Metallic"].default_value = 0.0
    if m.name == "flame":
        p.inputs["Emission Color"].default_value = (1.0, 0.45, 0.1, 1)
        p.inputs["Emission Strength"].default_value = 4.0
    if m.name in ("glass", "sheer_linen"):
        p.inputs["Alpha"].default_value = 0.18 if m.name == "glass" else 0.6
        s.surface_render_method = "BLENDED"
    SIMPLE[m.name] = s
    return s


# ---------------------------------------------------------------- meshes
col = bpy.data.collections.new("ZEXPORT")
sc.collection.children.link(col)


def copy_object(src, name, max_faces=None, faces_target=2500):
    ev = src.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev) if src.modifiers else src.data.copy()
    me.transform(src.matrix_world)
    for i, slot in enumerate(me.materials):
        if slot:
            me.materials[i] = simple_material(slot)
    ob = bpy.data.objects.new(name, me)
    col.objects.link(ob)
    n = len(me.polygons)
    if max_faces and n > max_faces:
        d = ob.modifiers.new("dec", "DECIMATE")
        d.ratio = max(faces_target / n, 0.004)
    return ob


STRUCT = ["walls", "walls.concrete", "walls.infill", "gable.infill", "chimneys", "chimney.caps",
          "colonnade.posts", "glazing.frames", "roofs.x", "roofs.y", "rafters",
          # garage.doors left out: the vehicles team drives the buggy out of the open bays.
          "ground.paving", "ground.courtyards", "ground.gravel", "ground.island", "ground.pool-deck", "pool.shell"]
for o in sc.objects:
    if o.type != "MESH":
        continue
    if o.name.startswith("floor.") or o.name in STRUCT:
        copy_object(o, "S_" + o.name)
    elif o.name in ("glazing", "skylights"):
        copy_object(o, "G_" + o.name)
    elif o.name == "pool.water":
        copy_object(o, "W_" + o.name)
    elif o.name.startswith("fireplace."):
        copy_object(o, "E_" + o.name)
    elif "Furniture" in [c.name for c in o.users_collection]:
        if o.name in ("curtains", "curtain_tracks"):
            copy_object(o, "G_" + o.name)
        else:
            small = max(o.dimensions) < 0.6
            copy_object(o, "F_" + o.name, max_faces=300 if small else 1200, faces_target=200 if small else 900)

# ---------------------------------------------------------------- extended terrain + lake (TEAM WORLD)
# The playable map now runs from the house down the tussock slope to Lake Wakatipu and ~200 m
# out over the water. The DEM is 4 m; inside the play rectangle every quad is kept (and
# collides), outside it the ring is decimated scenery. Under the lake the DEM is flat (the
# surface), so a shelving bed is carved from the distance to the real shoreline (z = water).
import numpy as np

TERR = json.loads((PROJ / "build" / "terrain.json").read_text())
WATER = float(TERR["water"])
PLAY = (-170.0, -120.0, 320.0, 470.0)  # plan x0, y0, x1, y1 (collides, walk/nav area)


def terrain_grid():
    src = sc.objects["terrain.near"]
    n = len(src.data.vertices)
    co = np.empty(n * 3, np.float32)
    src.data.vertices.foreach_get("co", co)
    npz = np.load(PROJ / "build" / "terrain_near.npz")
    rows, cols = npz["z"].shape
    co = co.reshape(rows, cols, 3)
    z = co[..., 2].astype(np.float64)
    # Water: the lake mask plus everything under the lake level that touches it.
    wet = npz["lake"].copy()
    low = (z < WATER) | wet
    for _ in range(400):
        g = wet.copy()
        g[1:] |= wet[:-1]; g[:-1] |= wet[1:]; g[:, 1:] |= wet[:, :-1]; g[:, :-1] |= wet[:, 1:]
        g &= low
        if (g == wet).all():
            break
        wet = g
    # Distance (m) from each wet cell to the nearest dry one (chamfer).
    step = float(npz["step"])
    big = 1e6
    dist = np.where(wet, big, 0.0)
    for _ in range(90):
        d = dist.copy()
        for dr, dc, w in ((1, 0, step), (-1, 0, step), (0, 1, step), (0, -1, step), (1, 1, step * 1.414), (1, -1, step * 1.414), (-1, 1, step * 1.414), (-1, -1, step * 1.414)):
            sh = np.full_like(dist, big)
            sh[max(dr, 0):rows + min(dr, 0), max(dc, 0):cols + min(dc, 0)] = dist[max(-dr, 0):rows + min(-dr, 0), max(-dc, 0):cols + min(-dc, 0)]
            d = np.minimum(d, sh + w)
        d = np.where(wet, d, 0.0)
        if (d == dist).all():
            break
        dist = d
    dist = np.minimum(dist, 400.0)
    depth = np.minimum(9.0, 0.12 + 0.1 * dist + 0.0009 * dist * dist)
    z = np.where(wet, WATER - depth, z)
    return co[..., 0], co[..., 1], z, wet, step


TX, TY, TZ, TWET, TSTEP = terrain_grid()


def grid_mesh(name, keep, mat):
    rows, cols = TZ.shape
    verts = np.stack([TX, TY, TZ], -1).reshape(-1, 3).astype(np.float32)
    idx = np.arange(rows * cols).reshape(rows, cols)
    quads = np.stack([idx[:-1, :-1], idx[:-1, 1:], idx[1:, 1:], idx[1:, :-1]], -1)[keep]
    used = np.unique(quads)
    remap = np.full(rows * cols, -1, np.int64)
    remap[used] = np.arange(len(used))
    verts, quads = verts[used], remap[quads].reshape(-1, 4)
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(verts))
    me.vertices.foreach_set("co", verts.ravel())
    me.loops.add(quads.size)
    me.loops.foreach_set("vertex_index", quads.ravel())
    me.polygons.add(len(quads))
    me.polygons.foreach_set("loop_start", np.arange(0, quads.size, 4))
    me.polygons.foreach_set("loop_total", np.full(len(quads), 4))
    me.update()
    me.validate()
    me.polygons.foreach_set("use_smooth", np.ones(len(quads), bool))
    me.materials.append(simple_material(bpy.data.materials[mat]))
    ob = bpy.data.objects.new(name, me)
    col.objects.link(ob)
    return ob


def build_terrain():
    cx = (TX[:-1, :-1] + TX[1:, 1:]) / 2
    cy = (TY[:-1, :-1] + TY[1:, 1:]) / 2
    corners = np.stack([TZ[:-1, :-1], TZ[:-1, 1:], TZ[1:, 1:], TZ[1:, :-1]], -1)
    zmin, zmax = corners.min(-1), corners.max(-1)
    inside = (cx > PLAY[0]) & (cx < PLAY[2]) & (cy > PLAY[1]) & (cy < PLAY[3])
    beach = zmin < WATER + 0.5
    grid_mesh("T_terrain.play", inside & ~beach, "terrain")
    grid_mesh("T_beach.play", inside & beach, "gravel")
    # Scenery ring: drop lake bed nobody can see (well under the opaque offshore water).
    ring = grid_mesh("X_terrain.ring", ~inside & (zmax > WATER - 1.5), "terrain")
    d = ring.modifiers.new("dec", "DECIMATE")
    d.ratio = 0.15


build_terrain()


def sample(px, py):
    """Bilinear terrain height at plan (px, py) on the rotated DEM grid."""
    phi = math.radians(TERR["north_deg"])
    ax_, ay_ = TERR["anchor_plan"]
    dx, dy = px - ax_, py - ay_
    dn = dx * math.sin(phi) + dy * math.cos(phi)
    de = dx * math.cos(phi) - dy * math.sin(phi)
    half = 600.0
    fi, fj = (dn + half) / TSTEP, (de + half) / TSTEP
    i, j = int(math.floor(fi)), int(math.floor(fj))
    u, v = fi - i, fj - j
    return (TZ[i, j] * (1 - u) * (1 - v) + TZ[i + 1, j] * u * (1 - v) + TZ[i, j + 1] * (1 - u) * v + TZ[i + 1, j + 1] * u * v)


# ---------------------------------------------------------------- the jetty
def build_jetty():
    import bmesh
    # Shore straight down the slope from the terrace (plan bearing ~66 deg from the house).
    a = math.radians(66)
    ox, oy = 30.0, 17.0
    s = 0.0
    while sample(ox + s * math.cos(a), oy + s * math.sin(a)) > WATER:
        s += 0.5
    sx, sy = ox + s * math.cos(a), oy + s * math.sin(a)
    # Out into the lake: average direction to the wet cells within 40 m.
    m = TWET & (np.hypot(TX - sx, TY - sy) < 40)
    dx, dy = TX[m].mean() - sx, TY[m].mean() - sy
    L = math.hypot(dx, dy)
    dx, dy = dx / L, dy / L
    deck = WATER + 0.95
    k = 0.0
    while sample(sx - dx * k, sy - dy * k) < deck - 0.08 and k < 30:
        k += 0.25
    x0, y0 = sx - dx * k, sy - dy * k
    length = k + 30.0
    x1, y1 = x0 + dx * length, y0 + dy * length
    px, py = -dy, dx  # sideways
    bm_deck, bm_post = bmesh.new(), bmesh.new()

    def box(bm, cx, cy, cz, lx, ly, lz, ang):
        ca, sa = math.cos(ang), math.sin(ang)
        vs = []
        for ix in (-1, 1):
            for iy in (-1, 1):
                for iz in (-1, 1):
                    u, v = ix * lx / 2, iy * ly / 2
                    vs.append(bm.verts.new((cx + u * ca - v * sa, cy + u * sa + v * ca, cz + iz * lz / 2)))
        for f in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            bm.faces.new([vs[i] for i in f])

    ang = math.atan2(dy, dx)
    width = 2.4
    # Deck: planks across the jetty with thin gaps (one box per plank, 0.2 m wide).
    n = int(length / 0.22)
    for i in range(n):
        t = (i + 0.5) * length / n
        box(bm_deck, x0 + dx * t, y0 + dy * t, deck - 0.05, 0.2, width, 0.1, ang)
    # Bearers under the planks and posts down to the bed every 3 m.
    for side in (-1, 1):
        ox_, oy_ = px * side * (width / 2 - 0.15), py * side * (width / 2 - 0.15)
        box(bm_post, x0 + dx * length / 2 + ox_, y0 + dy * length / 2 + oy_, deck - 0.2, length, 0.18, 0.2, ang)
        t = 1.5
        while t <= length + 0.01:
            cx, cy = x0 + dx * t + px * side * (width / 2 + 0.05), y0 + dy * t + py * side * (width / 2 + 0.05)
            bed = sample(cx, cy)
            top = deck + (0.75 if t > length - 1 else 0.12)
            box(bm_post, cx, cy, (bed - 0.3 + top) / 2, 0.24, 0.24, top - bed + 0.3, ang)
            t += 3.0
    for bm, name, mat in ((bm_deck, "S_jetty.deck", "deck"), (bm_post, "S_jetty.posts", "walnut_dark")):
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        me.materials.append(simple_material(bpy.data.materials[mat]))
        col.objects.link(bpy.data.objects.new(name, me))
    return {"a": [round(float(x0), 2), round(float(y0), 2)], "b": [round(float(x1), 2), round(float(y1), 2)], "dir": [round(float(dx), 4), round(float(dy), 4)],
            "width": width, "deck": round(float(deck), 3), "shore": [round(float(sx), 2), round(float(sy), 2)]}


JETTY = build_jetty()
# Heightfield for the game (NZ.terrainAt, water depth, nav, minimap), cm as int16.
(OUT / "world_terrain.json").write_text(json.dumps({
    "water": WATER, "north_deg": TERR["north_deg"], "anchor": TERR["anchor_plan"], "half": 600, "step": TSTEP,
    "rows": TZ.shape[0], "cols": TZ.shape[1], "play": PLAY, "jetty": JETTY,
    "z_cm": np.round(TZ * 100).astype(np.int16).ravel().tolist(),
}))
print("JETTY", JETTY)
# Far terrain: the real Remarkables/Wakatipu skyline, heavily decimated, render-only.
far = copy_object(sc.objects["terrain.far"], "X_terrain.far", max_faces=1000, faces_target=24000)
# The 50 m skyline grid is only sunk 8 m under the near patch, which pokes through in every
# gully once the slope down to the lake is in view: drop it well clear inside the near grid.
_phi = math.radians(TERR["north_deg"])
for v in far.data.vertices:
    _dx, _dy = v.co.x - 30.0, v.co.y - 17.0
    if max(abs(_dx * math.sin(_phi) + _dy * math.cos(_phi)), abs(_dx * math.cos(_phi) - _dy * math.sin(_phi))) < 560:
        v.co.z -= 80.0
boulder = copy_object(sc.objects["proto.boulder"], "P_boulder", max_faces=500, faces_target=260)
boulder.matrix_world.identity()

bpy.ops.object.select_all(action="DESELECT")
for o in col.objects:
    o.select_set(True)
bpy.context.view_layer.objects.active = col.objects[0]
bpy.ops.export_scene.gltf(
    filepath=str(OUT / "level.glb"), use_selection=True, export_apply=True, export_yup=True,
    export_materials="EXPORT", export_image_format="NONE", export_normals=True, export_texcoords=False, export_tangents=False,
    export_cameras=False, export_lights=False, export_animations=False,
    export_extras=False,
)

# ---------------------------------------------------------------- metadata
ax, ay = 30.0, 17.0


def points(name, radius, keep, inner=0.0):
    pts = [tuple(v.co) for v in sc.objects[name].data.vertices]
    pts = [p for p in pts if inner <= math.hypot(p[0] - ax, p[1] - ay) <= radius]
    random.shuffle(pts)
    return [[round(p[0], 2), round(p[1], 2), round(p[2], 2), round(random.uniform(0.7, 1.35), 2)] for p in pts[:keep]]


meta = {
    "fires": [[round(v, 2) for v in o.location] for o in sc.objects if o.name.startswith("fire.") and o.type == "LIGHT"],
    "lamps": [[round(v, 2) for v in o.location] for o in sc.objects if o.name.startswith("lamp") and o.type == "LIGHT"],
    "tussock": points("tussock", 95, 4200),
    "garden": points("garden", 999, 300),
    "boulders": points("boulders", 999, 40),
    "pines": points("pines", 999, 40),
    "rooms": json.loads((PROJ / "build" / "model.json").read_text())["rooms"],
}
(OUT / "level_meta.json").write_text(json.dumps(meta))
print("EXPORTED", (OUT / "level.glb").stat().st_size, {k: len(v) for k, v in meta.items()})
# Deliberately no save: house.blend stays untouched.
