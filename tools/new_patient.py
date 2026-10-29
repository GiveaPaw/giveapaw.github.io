"""Scaffold a new patient case study.

    python tools/new_patient.py "Name" [--group "Fall 2026 Patients"] [--year 2026] [--card]

Creates <slug>-case-study.html from tools/patient-template.html, registers
the page in site_infra.py (a patients group in the menu, default "Fall 2026
Patients", + META), regenerates the shared regions across all pages and the
developer hub's page list, and prints the asset checklist. --card also
appends the patient card to the home page's patient row (do this once
<slug>-photo.jpg is in the folder, or the card shows a broken image).

A new semester gets its own group: add ("Spring 2027 Patients", []), to
NAV_GROUPS in tools/site_infra.py, then pass --group "Spring 2027 Patients".

Everything degrades gracefully before assets exist: the 3D figure shows a
"models are still being prepared" note until the first GLB is committed, and
download entries are styled "coming soon" until real links replace them.
"""
import argparse
import pathlib
import re
import subprocess
import sys

TOOLS = pathlib.Path(__file__).resolve().parent
ROOT = TOOLS.parent
NL = "\n"


def add_to_menu(src, group, page, name):
    """Add (page, name) to the NAV_GROUPS entry called `group`. Returns the new source or exits."""
    title = re.escape(group.replace("&", "&amp;"))
    line = '        ("%s", "%s"),' % (page, name) + NL
    empty = re.compile(r'\("%s", \[\]\),' % title)          # ("Fall 2026 Patients", []),
    if empty.search(src):
        return empty.sub(lambda m: '("%s", [' % group + NL + line + "    ]),", src, count=1)
    filled = re.compile(r'(\("%s", \[\n(?:.*?\n)*?)(    \]\),)' % title)
    src2, n = filled.subn(lambda m: m.group(1) + line + m.group(2), src, count=1)
    if n != 1:
        sys.exit('Could not find the menu group "%s" in tools/site_infra.py NAV_GROUPS. '
                 'Add it there first, e.g. ("%s", []),' % (group, group))
    return src2


def add_card(index_html, page, slug, name):
    """Insert a patient card at the end of the home page's patient row. Returns new text or None."""
    card = (
        '                            <a class="patient-card" href="%s">' % page + NL
        + '                                <img src="%s-photo.jpg" alt="%s">' % (slug, name) + NL
        + '                                <span class="patient-caption">' + NL
        + '                                    <span class="patient-name">%s</span>' % name + NL
        + '                                    <span class="patient-cta">View case study &rarr;</span>' + NL
        + '                                </span>' + NL
        + '                            </a>' + NL)
    # The cards sit in <section id="patients">; the row ends with two </div> right before </section>.
    start = index_html.find('id="patients"')
    end_marker = ('                        </div>' + NL + '                    </div>' + NL
                  + '                </section>')
    at = index_html.find(end_marker, start) if start >= 0 else -1
    if at < 0:
        return None
    return index_html[:at] + card + index_html[at:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('name', help='Patient name, e.g. "Biscuit"')
    ap.add_argument('--group', default='Fall 2026 Patients', help='Menu group in tools/site_infra.py NAV_GROUPS')
    ap.add_argument('--year', default='2026', help='Cohort year for the meta description')
    ap.add_argument('--card', action='store_true',
                    help='Also add the home-page patient card (needs <slug>-photo.jpg)')
    args = ap.parse_args()

    name = args.name.strip()
    slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    if not slug:
        sys.exit('Could not derive a slug from that name.')
    page = '%s-case-study.html' % slug
    target = ROOT / page
    if target.exists():
        sys.exit('%s already exists; refusing to overwrite.' % page)

    infra = TOOLS / 'site_infra.py'
    src = infra.read_text(encoding='utf-8')
    changed = False
    if page not in src:
        src = add_to_menu(src, args.group, page, name)      # exits before anything is written if the group is missing
        changed = True
    if '"%s": (' % page not in src:
        desc = ("%s's case study: scan, socket design, and build progress for a "
                "custom 3D-printed prosthetic from the %s cohort.") % (name, args.year)
        meta_entry = ('    "%s": (' % page + NL + '        "%s Case Study",' % name + NL
                      + '        "%s"),' % desc + NL)
        anchor = '    "credits.html": ('
        if anchor not in src:
            sys.exit('Could not find the credits.html META anchor in site_infra.py.')
        src = src.replace(anchor, meta_entry + anchor, 1)
        changed = True

    html = (TOOLS / 'patient-template.html').read_text(encoding='utf-8')
    target.write_text(html.replace('{{NAME}}', name).replace('{{SLUG}}', slug), encoding='utf-8', newline=NL)
    if changed:
        infra.write_text(src, encoding='utf-8', newline=NL)

    if args.card:
        index = ROOT / 'index.html'
        t = index.read_text(encoding='utf-8')
        if page not in t:
            t2 = add_card(t, page, slug, name)
            if t2 is None:
                print('WARNING: could not find the end of the patient row in index.html; add the card by hand.')
            else:
                index.write_text(t2, encoding='utf-8', newline=NL)
                if not (ROOT / ('%s-photo.jpg' % slug)).exists():
                    print('NOTE: %s-photo.jpg is not in the folder yet; the new card will '
                          'show a broken image until it is.' % slug)

    subprocess.run([sys.executable, str(infra)], check=True, cwd=str(ROOT), stdout=subprocess.DEVNULL)
    if (TOOLS / 'dev_pages.py').exists():
        subprocess.run([sys.executable, str(TOOLS / 'dev_pages.py')], check=True, cwd=str(ROOT))

    print()
    print('Created %s and added it to the "%s" menu group and the metadata.' % (page, args.group))
    print()
    print('Asset checklist for %s (add any of these and the page picks them up):' % name)
    print('  %s-photo.jpg              home-page card portrait (square-ish)' % slug)
    print('  %s-gallery-01..04.jpg     carousel (then uncomment it in the page)' % slug)
    print('  %s-full-prosthetic.glb    3D tabs appear per component that exists:' % slug)
    print('  %s-solid-animal.glb       run each export through the usual' % slug)
    print('  %s-attachment-surface.glb 3MF->GLB pipeline (decimate, normals,' % slug)
    print('  %s-mechanical-interface.glb  draco) first' % slug)
    print('  %s-solid-interface.glb' % slug)
    print()
    print('Then fill the TODO stats and copy in the page%s.'
          % ('' if args.card else ', and run with --card once the photo exists'))
    print('Publish the new page, its assets, index.html (if --card) and every page whose menu changed.')


if __name__ == '__main__':
    main()
