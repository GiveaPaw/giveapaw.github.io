"""Convert Ollie's paw-shape sweep (nTop "Paw shape", input Semi Circle Percent) into Draco GLBs.

    python tools/convert_ollie_paw_sweep.py ["<Paw Sweep Files folder>"] [--faces 150000] [--force]

Input names:  _Paw_SemiCirclePercent_<P>_.3mf   (P = 1, 5, 10 ... 100: 21 shapes)
Outputs:      ollie-paw-shape-<PPP>.glb in the site root.

The Paw.ntop exports have the paw's height along +Y (the curved sole grows toward -Y as the percent rises).
The site's viewers are Z-up like nTop's default view, so each mesh is turned +90 degrees about X
(Y becomes Z) before export, then a quarter turn about Z so the paw's long (toe-to-heel) side runs along
+-Y like the paw worn at the fitting (ollie-paw-140.glb); without it the sweep paws sit sideways next to
it on the slider and in the leg finder. Same pipeline as the socket sweeps: decimate, matte material, normals, Draco.
"""
import argparse
import os
import re
import sys

import numpy as np
import trimesh

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from convert_ollie_v3_sweeps import SITE, draco  # noqa: E402  (shared Draco step and site path)

DEFAULT_SRC = r'C:\Users\mrchi\OneDrive\Desktop\Animals\Ollie\Ollie Bionic Pets\Paw Sweep Files'
NAME = re.compile(r'^_Paw_SemiCirclePercent_([\d.]+)_\.3mf$', re.I)
Y_UP_TO_Z_UP = trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0])
QUARTER_TURN_Z = trimesh.transformations.rotation_matrix(np.pi / 2, [0, 0, 1])


def convert(path, out, faces):
    import tempfile
    mesh = trimesh.load(path, force='mesh')
    before = len(mesh.faces)
    if before > faces:
        mesh = mesh.simplify_quadric_decimation(face_count=faces)
    mesh.apply_transform(Y_UP_TO_Z_UP)
    mesh.apply_transform(QUARTER_TURN_Z)
    mesh.visual = trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(
        baseColorFactor=[201, 167, 107, 255], metallicFactor=0.0, roughnessFactor=0.85))
    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, 'raw.glb')
        mesh.export(raw, include_normals=True)
        draco(raw, out)
    return before, len(mesh.faces), np.round(mesh.bounds, 1).tolist()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('src', nargs='?', default=DEFAULT_SRC)
    parser.add_argument('--faces', type=int, default=150000)
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    done = 0
    for name in sorted(os.listdir(args.src)):
        match = NAME.match(name)
        if not match:
            continue
        value = float(match.group(1))
        if not value.is_integer():
            print(f'skip (fractional percent): {name}')
            continue
        out = os.path.join(SITE, f'ollie-paw-shape-{int(value):03d}.glb')
        if os.path.exists(out) and not args.force:
            continue
        before, after, bounds = convert(os.path.join(args.src, name), out, args.faces)
        done += 1
        print(f'{os.path.basename(out)}: {before} -> {after} faces, {os.path.getsize(out) / 1e6:.2f} MB, bounds {bounds}', flush=True)
    print(f'done: {done} converted', flush=True)


if __name__ == '__main__':
    sys.exit(main())
