"""Convert named attachment tools, preserving their local axes.

Usage: python prepare_attachment_assets.py Capsule [AttachBdry]
"""
from pathlib import Path
import json
import sys
import trimesh

SOURCE = Path(r"C:\Users\mrchi\OneDrive\Desktop\Animals\9-19")
DEST = Path(__file__).resolve().parents[1] / "sample-models" / "attachment-holes"
DEST.mkdir(parents=True, exist_ok=True)
manifest_path = DEST / "assets.json"
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
valid_names = {"Capsule", "AttachBdry"}
names = sys.argv[1:]
if not names:
    raise ValueError("Choose at least one asset: Capsule or AttachBdry")
unknown_names = set(names) - valid_names
if unknown_names:
    raise ValueError(f"Unknown attachment asset(s): {', '.join(sorted(unknown_names))}")

for name in names:
    mesh = trimesh.load(SOURCE / f"{name}.3mf", force="mesh")
    if not mesh.is_watertight or abs(mesh.volume) < 1e-9:
        raise ValueError(f"{name} must be a closed solid to use its volume centroid")
    center = mesh.center_mass.copy()
    source_units = mesh.units
    mesh.apply_translation(-center)
    mesh.convert_units("meters")
    mesh.export(DEST / f"{name}.glb")
    manifest[name] = {"source": f"{name}.3mf", "sourceUnits": source_units,
                      "sourceCentroid": center.tolist(), "outwardAxis": "+Z",
                      "units": "meters", "faces": len(mesh.faces)}
    print(f"{name}: {len(mesh.faces)} faces; centered at {center.tolist()}")
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
