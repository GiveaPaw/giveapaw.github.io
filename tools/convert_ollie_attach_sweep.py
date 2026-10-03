"""Convert Ollie's attachment sweep (nTop 3MF exports) into Draco GLBs for the design review.

    python tools/convert_ollie_attach_sweep.py ["<Attachment Sweep Files folder>"] [--faces 150000] [--jobs 6] [--force]

Input names:  Ollie_Reach_<R>_LegHole_<H>.3mf
    R  how far down the chest the socket reaches, mm (negative = shorter than the current socket, 0 = current)
    H  leg hole size, mm

Outputs, in the site root:  ollie-attach-r<R>-h<H*10>.glb
    R written as m24 / 0 / p33 (minus / plus), H as tenths of a mm with four digits: 62.5 -> 0625.
    e.g. Ollie_Reach_-24_LegHole_62.5.3mf -> ollie-attach-rm24-h0625.glb

Same steps as convert_ollie_v3_sweeps.py (decimate to ~150K faces, matte grey, normals, Draco). The
exports are already in Ollie's scan frame (Reach 0 has the same bounds as ollie-socket.glb).
"""
import argparse
import os
import re
import sys

from convert_ollie_v3_sweeps import SITE, job

DEFAULT_SRC = r'C:\Users\mrchi\OneDrive\Desktop\Animals\Ollie\Ollie Bionic Pets\Attachment Sweep Files'
NAME = re.compile(r'^Ollie_Reach_(-?[\d.]+)_LegHole_([\d.]+)\.3mf$', re.I)


def reach_code(reach):
    r = int(round(reach))
    return '0' if r == 0 else ('m' if r < 0 else 'p') + str(abs(r))


def output_name(reach, hole):
    return f'ollie-attach-r{reach_code(reach)}-h{int(round(hole * 10)):04d}.glb'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('src', nargs='?', default=DEFAULT_SRC)
    parser.add_argument('--faces', type=int, default=150000)
    parser.add_argument('--jobs', type=int, default=1, help='convert this many files at once')
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    tasks = []
    for name in sorted(os.listdir(args.src)):
        match = NAME.match(name)
        if not match:
            print(f'skip (name not recognised): {name}', flush=True)
            continue
        out = os.path.join(SITE, output_name(float(match.group(1)), float(match.group(2))))
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
