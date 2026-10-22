"""Bring the 10-21 Chihuahua wheelchair case onto the site: surface, both interfaces, blend sockets.

The surface, the interfaces and the 274 blend sockets all share one frame, the 0.95-scaled nTop frame
the sockets were generated in, so they are stored exactly as exported rather than unscaled the
way the 10-15 case is. Keeping the case in its own frame is what lets its sockets sit on it.

    python tools/convert_chi_wheelchair.py             # meshes and sockets
    python tools/convert_chi_wheelchair.py --meshes    # just the surface and the interfaces
    python tools/convert_chi_wheelchair.py --sockets   # just the blend sockets

The sockets arrive already converted (Chihuahua/glb/BlendWCSockets), so they are only copied in and
checked. Everything written here is a sweep file by model-base.js's rules, so it has to be uploaded
to R2 (Upload models to R2.cmd) before the live site can show it.
"""
import argparse
import os
import re
import shutil
import sys
import tempfile

import trimesh

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from convert_ollie_v3_sweeps import SITE, draco  # noqa: E402

SRC = r'C:\Users\mrchi\OneDrive\Desktop\Animals\Chihuahua'
SOCKET_SRC = os.path.join(SRC, 'glb', 'BlendWCSockets')
SOCKET_OUT = os.path.join(SITE, 'sample-models', 'chi-wc-blend')
PREVIEW_FACES = 12000
GREY = [185, 194, 204, 255]

NAME = re.compile(r'^(\d+)Connectors_MinBlend_([\d.]+)_MaxBlend_([\d.]+)_ConnectorBlend_([\d.]+)_?\.glb$')


def num(text):
    value = float(text)
    return int(value) if value.is_integer() else value


def socket_name(connectors, lo, hi, connector):
    """c4-lo10-hi50-cb05.glb: the four things that identify one socket, in the block's order."""
    return f'c{connectors}-lo{num(lo):02}-hi{num(hi):02}-cb{num(connector):02}.glb'


def write_glb(mesh, out, preview=None):
    mesh.visual = trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial(
        baseColorFactor=GREY, metallicFactor=0.0, roughnessFactor=0.85))
    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, 'raw.glb')
        mesh.export(raw, include_normals=True)
        draco(raw, out)
        if preview:
            light = mesh.simplify_quadric_decimation(face_count=PREVIEW_FACES) if len(mesh.faces) > PREVIEW_FACES else mesh
            light.visual = mesh.visual
            light.export(raw, include_normals=True)
            draco(raw, preview)


def meshes():
    previews = os.path.join(SITE, 'sample-models', 'previews')
    interfaces = os.path.join(SITE, 'sample-models', 'interfaces')
    os.makedirs(interfaces, exist_ok=True)

    # Both OBJs in the drop are the same file, and it is the surface: an open shell, 591 boundary
    # edges and 518 cm2, where a solid of this scan is watertight with none. The solid is still to come.
    surface = os.path.join(SRC, 'ScaledSurfaceChihuahua_0.95Scale.obj')
    mesh = trimesh.load(surface, force='mesh')
    if mesh.is_watertight:
        raise SystemExit('That file is watertight, so it is the solid, not the surface: check the drop.')
    out = os.path.join(SITE, 'sample-models', 'chi-wc-surface.glb')
    write_glb(mesh, out, os.path.join(previews, 'chi-wc-surface.glb'))
    print(f'chi-wc-surface.glb: {len(mesh.faces)} faces, {os.path.getsize(out) / 1e6:.2f} MB')

    # The interfaces are served as the STL a student would import, with a GLB only for the preview.
    for src_name, stem in (('Interface Mech_10-21_Small_Interface.stl', 'wheelchair-mechanical'),
                           ('Interface Solid_10-21_Small_Interface.stl', 'wheelchair-solid')):
        src = os.path.join(SRC, src_name)
        stl = os.path.join(interfaces, stem + '.stl')
        shutil.copyfile(src, stl)
        write_glb(trimesh.load(src, force='mesh'), os.path.join(previews, stem + '.glb'))
        print(f'{stem}.stl: {os.path.getsize(stl)} bytes')


def sockets(dry_run=False):
    os.makedirs(SOCKET_OUT, exist_ok=True)
    seen, skipped = {}, []
    for name in sorted(os.listdir(SOCKET_SRC)):
        match = NAME.match(name)
        if not match:
            skipped.append(name)
            continue
        connectors, lo, hi, connector = (num(x) for x in match.groups())
        out = socket_name(connectors, lo, hi, connector)
        seen[out] = os.path.join(SOCKET_SRC, name)
    if skipped:
        print(f'skipped {len(skipped)}: {skipped[:3]}')
    print(f'{len(seen)} sockets')
    if dry_run:
        return
    total = 0
    for out, src in seen.items():
        dst = os.path.join(SOCKET_OUT, out)
        if not os.path.exists(dst) or os.path.getsize(dst) != os.path.getsize(src):
            shutil.copyfile(src, dst)
        total += os.path.getsize(dst)
    print(f'{len(seen)} files, {total / 1e6:.1f} MB in sample-models/chi-wc-blend')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--meshes', action='store_true', help='only the surface and the interfaces')
    parser.add_argument('--sockets', action='store_true', help='only the blend sockets')
    parser.add_argument('--dry-run', action='store_true', help='report only, write no sockets')
    args = parser.parse_args()
    if args.meshes or not args.sockets:
        meshes()
    if args.sockets or not args.meshes:
        sockets(args.dry_run)
