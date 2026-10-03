"""Convert the Chihuahua "over the back" socket sweep (nTop 3MF exports) into Draco GLBs.

    python tools/convert_chihuahua_top_sweep.py ["<top-sockets folder>"] [--faces 150000] [--jobs 6] [--force]

Input names:  C_top_<+-T>mm_Chihuahua_Index_..._.3mf
    T  how far the top line of the attachment surface moves over the back, mm (0 = the painted Normal
       surface; reach 15.5 mm and leg hole 87.5 mm held at Normal). Made by automation/parametric_attachment.py
       --top-sweep and nTop 9-19/ExportSocket.ntop.

Outputs, in the site root:  chi-top-<m|p><T*10, 3 digits>.glb   e.g. C_top_-16.5mm -> chi-top-m165.glb,
C_top_+00.6mm -> chi-top-p006.glb. Same steps as convert_ollie_v3_sweeps.py; already in the Chihuahua scan
frame (same as chihuahua-solid.glb), so nothing is moved.
"""
import argparse
import os
import re
import sys

from convert_ollie_v3_sweeps import SITE, job

DEFAULT_SRC = r'C:\Users\mrchi\OneDrive\Desktop\Animals\9-19\Chihuahua-parametric\top-sockets'
NAME = re.compile(r'^C_top_([+-][\d.]+)mm_.*\.3mf$', re.I)


def output_name(top):
    tenth = int(round(abs(top) * 10))
    return f'chi-top-{"m" if top < 0 else "p"}{tenth:03d}.glb'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('src', nargs='?', default=DEFAULT_SRC)
    parser.add_argument('--faces', type=int, default=150000)
    parser.add_argument('--jobs', type=int, default=1)
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    tasks = []
    for name in sorted(os.listdir(args.src)):
        match = NAME.match(name)
        if not match:
            print(f'skip (name not recognised): {name}', flush=True)
            continue
        out = os.path.join(SITE, output_name(float(match.group(1))))
        if os.path.exists(out) and not args.force:
            continue
        tasks.append((os.path.join(args.src, name), out, args.faces))
    print(f'{len(tasks)} to convert', flush=True)
    if args.jobs > 1:
        from concurrent.futures import ProcessPoolExecutor
        with ProcessPoolExecutor(max_workers=args.jobs) as pool:
            for line in pool.map(job, tasks):
                print(line, flush=True)
    else:
        for task in tasks:
            print(job(task), flush=True)
    print(f'done: {len(tasks)} converted', flush=True)


if __name__ == '__main__':
    sys.exit(main())
