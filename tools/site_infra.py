"""Cross-file infrastructure pass for the Give a Paw site.

Rewrites, in every page: the sidebar nav (one canonical block, active state
per page), the footer credits (adds the required model attribution link),
and the head metadata (description, Open Graph, favicon).

Idempotent: re-running replaces the same regions rather than stacking.
"""
import re
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE_URL = "https://giveapaw.github.io/"

# ---- canonical sidebar -------------------------------------------------
NAV_GROUPS = [
    ("Our Patients", [
        ("max-case-study.html", "Max"),
        ("billie-case-study.html", "Billie"),
        ("yana-case-study.html", "Yana"),
        ("ollie-case-study.html", "Ollie"),
        ("kiki-case-study.html", "Kiki"),
    ]),
    ("Earlier Projects", [
        ("full-limb.html", "Full Limb"),
        ("wheel-chair.html", "Wheel Chair"),
    ]),
    ("How We Build", [
        ("3d-scanning.html", "3D Scanning"),
        ("preparing-ntop-input.html", "Preparing nTop Input"),
        ("socket-walkthrough.html", "Socket Walkthrough"),
        ("ntop-socket-creation.html", "nTop Socket Creation"),
        ("implicit-viewer.html", "Implicit Field Viewer"),
        ("pelvic-plane-locator.html", "Pelvic Plane Locator"),
        ("interface-plane-locator.html", "Interface Plane Locator"),
        ("materials.html", "Materials"),
        ("3d-printing.html", "3D Printing"),
    ]),
    ("Learn &amp; Try", [
        ("anatomy-quiz.html", "Canine Anatomy Quiz"),
        ("human-anatomy-quiz.html", "Human Anatomy Quiz"),
        ("downloads.html", "Downloads"),
    ]),
    ("About", [
        ("meet-the-team.html", "Meet the Team"),
        ("credits.html", "Credits"),
    ]),
]


def build_nav(current):
    out = ['<nav class="sidebar-nav">']
    for title, links in NAV_GROUPS:
        out.append('            <p class="sidebar-nav-title">%s</p>' % title)
        out.append('            <ul>')
        for href, label in links:
            cls = ' class="active"' if href == current else ''
            out.append('                <li%s><a href="%s">%s</a></li>'
                       % (cls, href, label))
        out.append('            </ul>')
    out.append('        </nav>')
    return '\n'.join(out)


# ---- footer credits ----------------------------------------------------
FOOTER = """<div class="footer-credits">
                    <p>&copy; 2026 Give a Paw &middot; Bioprinting@Berkeley</p>
                    <p>Animal prosthetics documentation and open design records.</p>
                    <p class="footer-attrib">Canine reference meshes by kenchoo and Gert-Jan van den Boom, used under Creative Commons. <a href="credits.html">Full credits and licenses</a>.</p>
                </div>"""


# ---- per-page metadata -------------------------------------------------
# (title used for og:title, description used for both meta and og)
META = {
    "index.html": (
        "Give a Paw",
        "No-cost, custom 3D-printed prosthetics for shelter animals in the Bay Area. Explore the patients, the build process, and interactive 3D socket models you can shape in your browser."),
    "max-case-study.html": (
        "Max Case Study",
        "How the Give a Paw team designed and built a custom 3D-printed prosthetic for Max, from 3D scan through printed assembly."),
    "billie-case-study.html": (
        "Billie Case Study",
        "Billie's custom prosthetic: scan cleanup, socket generation, paw lattice design, and the printed device, with interactive 3D models."),
    "yana-case-study.html": (
        "Yana Case Study",
        "Yana's case study: harness lattice design, leg assembly, and the fitting process for a custom 3D-printed prosthetic."),
    "ollie-case-study.html": (
        "Ollie Case Study",
        "Ollie's prosthetic in progress: layered 3D models of the body scan, generated socket, and mapped attachment area."),
    "kiki-case-study.html": (
        "Kiki Case Study",
        "Kiki's custom mobility device, from measurement and CAD through the current wheelchair build."),
    "full-limb.html": (
        "Full Limb Prosthetics",
        "Design notes and reference material for full limb prosthetics built by the Give a Paw program."),
    "wheel-chair.html": (
        "Animal Wheelchairs",
        "Design notes and reference material for animal wheelchairs and mobility carts built by the Give a Paw program."),
    "3d-scanning.html": (
        "3D Scanning",
        "How we capture an animal's anatomy with a 3D scanner to produce an accurate digital model to design around."),
    "preparing-ntop-input.html": (
        "Preparing nTop Input",
        "Cleaning and preparing a raw 3D scan so it can drive the nTop socket generation workflow."),
    "ntop-socket-creation.html": (
        "nTop Socket Creation",
        "Interactive nTop socket design: 40+ live parameters across lattice, interface, attachment, and paw blocks, each driving a real 3D model in your browser."),
    "socket-walkthrough.html": (
        "Socket Workflow Walkthrough",
        "A guided, interactive walkthrough of the Give a Paw nTop socket workflow, from importing source meshes to locating the pelvic plane."),
    "implicit-viewer.html": (
        "Implicit Field Viewer",
        "Render nTop socket designs as signed distance fields in your browser: live wall offset, section cuts, a distance-field view, and in-shader lattices. No pre-baked mesh sweeps."),
    "pelvic-plane-locator.html": (
        "Pelvic Plane Locator",
        "Interactive 3D explainer for the nTop Pelvic Plane Locator block: pick Min, Centroid or Max on each axis of the attachment surface bounding box, set the normal, and watch the plane move on a real scan."),
    "interface-plane-locator.html": (
        "Interface Plane Locator",
        "Place a construction plane on Billie and Ollie's socket interfaces by choosing Min, Centroid or Max on each bounding-box axis and setting the plane normal."),
    "materials.html": (
        "Materials",
        "Material selection for animal prosthetics: TPU, PETG, aluminum, and foam linings, and where each belongs in the device."),
    "3d-printing.html": (
        "3D Printing",
        "Printing considerations for animal prosthetics: materials, infill, orientation, and post-processing."),
    "anatomy-quiz.html": (
        "Canine Anatomy Quiz",
        "Quiz yourself on canine skeletal anatomy in four modes: multiple choice, find-and-click, typed answers, and matching. Build a custom quiz from 28 traced bones and 16 joints and share it as a link."),
    "human-anatomy-quiz.html": (
        "Human Anatomy Quiz",
        "Quiz yourself on human skeletal anatomy in four modes: multiple choice, find-and-click, typed answers, and matching, across the full skeleton and a zoomed upper limb, covering 23 traced bones and 15 joints. Build a custom quiz and share it as a link."),
    "downloads.html": (
        "Downloads",
        "Reference files from the Give a Paw program: example scans, measurements, and CAD source for each build."),
    "meet-the-team.html": (
        "Meet the Team",
        "The students and mentors behind Give a Paw, a UC Berkeley program building no-cost prosthetics for shelter animals."),
    "credits.html": (
        "Credits and Licenses",
        "Attribution and license information for the 3D models, illustrations, and reference material used across the Give a Paw site."),
}

META_START = "<!-- meta:start -->"
META_END = "<!-- meta:end -->"


def build_meta(page):
    title, desc = META[page]
    url = BASE_URL + ("" if page == "index.html" else page)
    lines = [
        '    ' + META_START,
        '    <meta name="description" content="%s">' % desc,
        '    <link rel="icon" href="favicon.ico" sizes="any">',
        '    <link rel="apple-touch-icon" href="apple-touch-icon.png">',
        '    <meta property="og:type" content="website">',
        '    <meta property="og:site_name" content="Give a Paw">',
        '    <meta property="og:title" content="%s">' % title,
        '    <meta property="og:description" content="%s">' % desc,
        '    <meta property="og:image" content="%ssocial-card.jpg">' % BASE_URL,
        '    <meta property="og:url" content="%s">' % url,
        '    <meta name="twitter:card" content="summary_large_image">',
        '    ' + META_END,
    ]
    return '\n'.join(lines)


def process(path):
    page = path.name
    if page not in META:
        return "skipped (no metadata entry)"
    text = path.read_text(encoding="utf-8")
    orig = text
    notes = []

    # 1. sidebar nav
    new_nav = build_nav(page)
    text, n = re.subn(r'<nav class="sidebar-nav">.*?</nav>', lambda m: new_nav,
                      text, flags=re.S)
    if n:
        notes.append("nav")

    # 2. footer credits
    text, n = re.subn(r'<div class="footer-credits">.*?</div>',
                      lambda m: FOOTER, text, flags=re.S)
    if n:
        notes.append("footer")

    # 3. head metadata (replace prior block, else insert after <title>)
    if META_START in text:
        text = re.sub(re.escape(META_START) + r'.*?' + re.escape(META_END),
                      lambda m: build_meta(page).strip(), text, flags=re.S)
        notes.append("meta(updated)")
    else:
        text, n = re.subn(r'(^[ \t]*<title>.*?</title>[ \t]*$)',
                          lambda m: m.group(1) + '\n' + build_meta(page),
                          text, count=1, flags=re.M)
        if n:
            notes.append("meta(added)")

    if text != orig:
        path.write_text(text, encoding="utf-8")
        return ", ".join(notes)
    return "no change"


if __name__ == "__main__":
    for p in sorted(ROOT.glob("*.html")):
        print("%-32s %s" % (p.name, process(p)))
