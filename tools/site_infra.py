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
    ("Spring 2026 Patients", [
        ("max-case-study.html", "Max"),
        ("billie-case-study.html", "Billie"),
        ("yana-case-study.html", "Yana"),
        ("ollie-case-study.html", "Ollie"),
        ("kiki-case-study.html", "Kiki"),
    ]),
    # Empty until the fall patients have pages; the menu shows "Coming soon" under the title.
    ("Fall 2026 Patients", []),
    # Full Limb, Wheel Chair, Preparing nTop Input, nTop Socket Creation, the plane locators, Screw
    # Attachment, Implicit Field Viewer and Mesh Tolerance left the menu on 2026-10-23 (Tyler: the
    # walkthrough covers them). The pages still exist and are still generated if they have META entries.
    ("How We Build", [
        ("3d-scanning.html", "3D Scanning"),
        ("socket-walkthrough-sample.html", "Socket Walkthrough"),
        ("materials.html", "Materials"),
        ("3d-printing.html", "3D Printing"),
    ]),
    # Standalone browser tools (their own page layout, no sidebar; not in META, so the pass skips them).
    ("Tools", [
        ("mesh-check.html", "Mesh Check &amp; Repair"),
        ("convert.html", "Model Converter"),
        ("surface-interpolator.html", "Surface Interpolator"),
        ("review-builder.html", "Review Builder"),
    ]),
    ("Learn &amp; Try", [
        ("anatomy-quiz.html", "Canine Anatomy Quiz"),
        ("human-anatomy.html", "Human Anatomy"),
        ("anatomy-learning-lab.html", "Anatomy Learning Lab"),
    ]),
    ("About", [
        ("meet-the-team.html", "Meet the Team"),
        ("credits.html", "Credits"),
    ]),
]


# The human anatomy region quizzes are reached from human-anatomy.html and
# the region bar at the top of each quiz, not listed one by one in the menu.
# Keep in step with anatomy-regions.js (the hub page's cards).
HUMAN_REGIONS = [
    ("Whole body", [("human-anatomy-quiz.html", "Full Skeleton")]),
    ("Head", [("head-anatomy-quiz.html", "Head &amp; Neck"), ("ear-anatomy-quiz.html", "Ear")]),
    ("Trunk", [("chest-anatomy-quiz.html", "Chest &amp; Lungs"), ("heart-anatomy-quiz.html", "Heart"),
               ("organs-anatomy-quiz.html", "Abdominal Organs"), ("spine-anatomy-quiz.html", "Spine &amp; Pelvis")]),
    ("Limbs", [("arm-anatomy-quiz.html", "Shoulder &amp; Arm"), ("hand-anatomy-quiz.html", "Hand &amp; Forearm"),
               ("knee-anatomy-quiz.html", "Knee"), ("foot-anatomy-quiz.html", "Foot &amp; Ankle")]),
]
HUMAN_HUB = "human-anatomy.html"
HUMAN_PAGES = [link for _, links in HUMAN_REGIONS for link in links]


def nav_section(page):
    """The menu entry a page belongs to: region quizzes light up Human Anatomy."""
    return HUMAN_HUB if page in dict(HUMAN_PAGES) else page


def build_nav(current):
    out = ['<nav class="sidebar-nav">']
    for title, links in NAV_GROUPS:
        out.append('            <p class="sidebar-nav-title">%s</p>' % title)
        out.append('            <ul>')
        for href, label in links:
            cls = ' class="active"' if href == nav_section(current) else ''
            out.append('                <li%s><a href="%s">%s</a></li>'
                       % (cls, href, label))
        if not links:
            out.append('                <li><span class="sidebar-nav-soon" style="display:block;padding:0.5rem 1.5rem;'
                       'color:var(--color-sidebar-text);opacity:0.78;font-size:0.95rem;font-style:italic">Coming soon</span></li>')
        out.append('            </ul>')
    out.append('        </nav>')
    return '\n'.join(out)


# ---- footer previous / next ----------------------------------------------
# One reading order: Home, then every nav page in nav order. Pages with a
# <footer> get the links generated; hand edits are overwritten.
READING_ORDER = [("index.html", "Home")] + [
    link for title, links in NAV_GROUPS if title != "Tools" for link in links]   # the tools have no footer


def build_footer_nav(current):
    order = READING_ORDER
    if current in dict(HUMAN_PAGES):
        # hub, then the regions head to toe, then back to the hub
        order = [(HUMAN_HUB, "All Human Anatomy")] + HUMAN_PAGES + [(HUMAN_HUB, "All Human Anatomy")]
    hrefs = [h for h, _ in order]
    if current not in hrefs or current == "index.html":
        return None
    i = hrefs.index(current)
    READING = order
    out = ['<div class="footer-navigation">']
    for j, kind, label in ((i - 1, "prev", "Previous"), (i + 1, "next", "Next")):
        if 0 <= j < len(READING):
            href, title = READING[j]
            out += [
                '                    <a href="%s" class="footer-%s">' % (href, kind),
                '                        <div class="footer-%s-label">%s</div>' % (kind, label),
                '                        <div class="footer-%s-title">%s</div>' % (kind, title),
                '                    </a>',
            ]
    out.append('                </div>')
    return '\n'.join(out)


# ---- related links -------------------------------------------------------
# Connects each case study to the build pages behind it and each build page
# to the patients it was used on. Generated between related:start/end
# markers, before Referenced Papers on case studies, else at the article end.
RELATED = {
    "max-case-study.html": [("How We Built It", [
        ("full-limb.html", "Full limb prosthetics", "Max's project next to the team's other full-limb builds"),
        ("3d-scanning.html", "3D Scanning", "how the scan in the Files tab is captured"),
        ("preparing-ntop-input.html", "Preparing nTop Input", "cleaning a scan before it goes into nTop"),
        ("ntop-socket-creation.html", "nTop Socket Creation", "the blocks behind the nTop files"),
        ("materials.html", "Materials", "where each material belongs in a device"),
        ("3d-printing.html", "3D Printing", "printing the parts"),
    ])],
    "billie-case-study.html": [("How We Built It", [
        ("full-limb.html", "Full limb prosthetics", "Billie's project next to the team's other full-limb builds"),
        ("3d-scanning.html", "3D Scanning", "how both of Billie's scans were captured"),
        ("preparing-ntop-input.html", "Preparing nTop Input", "getting the Onshape file ready for nTop"),
        ("ntop-socket-creation.html", "nTop Socket Creation", "the socket and lattice blocks"),
        ("pelvic-plane-locator.html", "Pelvic Plane Locator", "place the pelvic plane on Billie's scan"),
        ("interface-plane-locator.html", "Interface Plane Locator", "place the interface plane on Billie's socket"),
        ("implicit-viewer.html", "Implicit Field Viewer", "Billie's full prosthetic as a live distance field"),
        ("materials.html", "Materials", "PETG, aluminum and TPU, and why"),
        ("3d-printing.html", "3D Printing", "printing the socket and the lattice paw"),
    ])],
    "yana-case-study.html": [("How We Built It", [
        ("full-limb.html", "Full limb prosthetics", "Yana's project next to the team's other full-limb builds"),
        ("3d-scanning.html", "3D Scanning", "how the scan in the Files tab is captured"),
        ("ntop-socket-creation.html", "nTop Socket Creation", "how the lattice harness is generated"),
        ("materials.html", "Materials", "TPU for the harness and paw, aluminum for the leg"),
        ("3d-printing.html", "3D Printing", "printing the harness and paw"),
    ])],
    "ollie-case-study.html": [("How We Built It", [
        ("full-limb.html", "Full limb prosthetics", "Ollie's project next to the team's other full-limb builds"),
        ("socket-walkthrough-sample.html", "Socket Walkthrough", "build Ollie's socket yourself, step by step"),
        ("3d-scanning.html", "3D Scanning", "how Ollie's scan was captured"),
        ("ntop-socket-creation.html", "nTop Socket Creation", "the blocks that generate the socket"),
        ("interface-plane-locator.html", "Interface Plane Locator", "place the interface plane on Ollie's socket"),
        ("implicit-viewer.html", "Implicit Field Viewer", "Ollie's socket as a live distance field"),
        ("mesh-tolerance.html", "Mesh Tolerance", "how export settings change Ollie's socket file"),
        ("materials.html", "Materials", "where each material belongs in a device"),
    ])],
    "kiki-case-study.html": [("How We Built It", [
        ("wheel-chair.html", "Wheelchairs", "Kiki's project with the team's wheelchair builds"),
        ("3d-scanning.html", "3D Scanning", "how scans like Kiki's lidar scan are captured"),
        ("ntop-socket-creation.html", "nTop Socket Creation", "the nTop workflow used for the first prototype"),
        ("materials.html", "Materials", "where each material belongs in a device"),
        ("3d-printing.html", "3D Printing", "printing the parts"),
    ])],
    "3d-scanning.html": [("See It on Our Patients", [
        ("billie-case-study.html#files", "Billie", "two scans, the second taken to improve the fit"),
        ("ollie-case-study.html#files", "Ollie", "the scan used in the socket walkthrough"),
        ("kiki-case-study.html#files", "Kiki", "a lidar scan"),
        ("max-case-study.html#files", "Max", "scan files"),
        ("yana-case-study.html#files", "Yana", "scan files"),
    ])],
    "preparing-ntop-input.html": [("See It on Our Patients", [
        ("billie-case-study.html#iteration-design", "Billie", "the Onshape file that was imported into nTop"),
        ("ollie-case-study.html", "Ollie", "the cleaned scan and attachment surface"),
        ("socket-walkthrough-sample.html", "Socket Walkthrough", "import Ollie's prepared meshes in Step 1"),
    ])],
    "ntop-socket-creation.html": [
        ("Try It Yourself", [
            ("socket-walkthrough-sample.html", "Socket Walkthrough", "build Ollie's socket block by block"),
            ("pelvic-plane-locator.html", "Pelvic Plane Locator", "the pelvic plane block on a real scan"),
            ("interface-plane-locator.html", "Interface Plane Locator", "the interface plane block"),
            ("implicit-viewer.html", "Implicit Field Viewer", "sockets as live distance fields"),
            ("mesh-tolerance.html", "Mesh Tolerance", "what the export tolerance does to the file"),
        ]),
        ("See It on Our Patients", [
            ("ollie-case-study.html", "Ollie", "the socket in the walkthrough"),
            ("billie-case-study.html", "Billie", "socket and gyroid lattice paw"),
            ("yana-case-study.html", "Yana", "lattice harness"),
            ("max-case-study.html#files", "Max", "nTop files"),
            ("kiki-case-study.html#iteration-design", "Kiki", "what changed after the first nTop prototype"),
        ]),
    ],
    "materials.html": [("See It on Our Patients", [
        ("max-case-study.html#materials", "Max", "materials chosen for water resistance"),
        ("billie-case-study.html#materials", "Billie", "PETG socket, aluminum leg, TPU paw"),
        ("yana-case-study.html#materials", "Yana", "TPU harness and paw"),
        ("ollie-case-study.html#materials", "Ollie", "hollow aluminum leg"),
        ("kiki-case-study.html#materials", "Kiki", "wheelchair materials"),
    ])],
    "3d-printing.html": [("See It on Our Patients", [
        ("billie-case-study.html#iteration-design", "Billie", "changing shell and infill to make the paw compress"),
        ("yana-case-study.html#iteration-design", "Yana", "a harness too large to print in one piece"),
        ("max-case-study.html#files", "Max", "print files"),
        ("kiki-case-study.html#files", "Kiki", "STL files"),
    ])],
    "pelvic-plane-locator.html": [("Related", [
        ("ntop-socket-creation.html", "nTop Socket Creation", "where this block fits in the socket workflow"),
        ("socket-walkthrough-sample.html", "Socket Walkthrough", "place the pelvic plane on Ollie in Step 2a"),
        ("billie-case-study.html", "Billie", "the patient whose scan is shown here"),
    ])],
    "interface-plane-locator.html": [("Related", [
        ("ntop-socket-creation.html", "nTop Socket Creation", "where this block fits in the socket workflow"),
        ("socket-walkthrough-sample.html", "Socket Walkthrough", "place the interface plane on Ollie in Step 2b"),
        ("billie-case-study.html", "Billie", "one of the two interfaces shown here"),
        ("ollie-case-study.html", "Ollie", "the other interface shown here"),
    ])],
    "implicit-viewer.html": [("Related", [
        ("ntop-socket-creation.html", "nTop Socket Creation", "the blocks that build these shapes"),
        ("mesh-tolerance.html", "Mesh Tolerance", "the same socket as an exported mesh"),
        ("ollie-case-study.html", "Ollie", "the patient behind the socket field"),
        ("billie-case-study.html", "Billie", "the patient behind the full prosthetic field"),
    ])],
    "screw-attachment.html": [("Related", [
        ("ntop-socket-creation.html", "nTop Socket Creation", "the socket the attachments are built onto"),
        ("socket-walkthrough-sample.html", "Socket Walkthrough", "where the attachment points are placed on Ollie's socket"),
        ("3d-printing.html", "3D Printing", "printing the attachment and its screw holes"),
    ])],
    "mesh-tolerance.html": [("Related", [
        ("ollie-case-study.html", "Ollie", "the patient whose socket is compared here"),
        ("ntop-socket-creation.html", "nTop Socket Creation", "the export block and its settings"),
        ("implicit-viewer.html", "Implicit Field Viewer", "the socket with no mesh at all"),
        ("3d-printing.html", "3D Printing", "what happens to the file next"),
    ])],
}

RB_START = "<!-- regionbar:start -->"
RB_END = "<!-- regionbar:end -->"


def build_region_bar(page):
    opts = []
    for group, links in HUMAN_REGIONS:
        opts.append('                            <optgroup label="%s">' % group)
        for href, label in links:
            sel = ' selected' if href == page else ''
            opts.append('                                <option value="%s"%s>%s</option>' % (href, sel, label))
        opts.append('                            </optgroup>')
    return '\n'.join([
        '                    ' + RB_START,
        '                    <div class="region-bar">',
        '                        <a href="%s">&lsaquo; All human anatomy</a>' % HUMAN_HUB,
        '                        <label>Region',
        '                        <select aria-label="Go to another region" onchange="location.href = this.value">',
    ] + opts + [
        '                        </select></label>',
        '                    </div>',
        '                    ' + RB_END,
    ]) + '\n'


REL_START = "<!-- related:start -->"
REL_END = "<!-- related:end -->"


def build_related(page):
    out = [REL_START]
    for k, (heading, items) in enumerate(RELATED[page]):
        sid = "related" if k == 0 else "related-%d" % (k + 1)
        out += [
            '<section id="%s" class="related-links">' % sid,
            '    <h2>%s<a class="headerlink" href="#%s" title="Permalink to this heading">&para;</a></h2>' % (heading, sid),
            '    <ul>',
        ] + ['        <li><a href="%s">%s</a> &mdash; %s</li>' % it for it in items] + [
            '    </ul>',
            '</section>',
        ]
    out.append(REL_END)
    return '\n'.join(' ' * 16 + line for line in out) + '\n'


# ---- footer credits ----------------------------------------------------
FOOTER = """<div class="footer-credits">
                    <p>&copy; 2026 Give a Paw &middot; Bioprinting@Berkeley &middot; <a href="dev.html" style="color:#003262;text-decoration:underline">For developers</a></p>
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
        "A guided, interactive walkthrough of the Give a Paw nTop socket workflow, from source meshes through pelvic and mechanical-interface placement."),
    "socket-walkthrough-sample.html": (
        "Socket Workflow Walkthrough",
        "Build Ollie's socket yourself, step by step as in nTop: import and scale the scan, place the pelvic and interface planes, lattice the socket, add attachment points, blend, and export, then compare your answers with the team's."),
    "ntop-blocks.html": (
        "How the nTop Blocks Work",
        "A maintainer's reference for the Give a Paw nTop socket notebook: every custom block with its inputs, outputs, the blocks inside it in order, and its shape as an implicit field."),
    "implicit-viewer.html": (
        "Implicit Field Viewer",
        "Render nTop socket designs as signed distance fields in your browser: live wall offset, section cuts, a distance-field view, and in-shader lattices. No pre-baked mesh sweeps."),
    "mesh-tolerance.html": (
        "Mesh Tolerance",
        "How nTop's mesh tolerance changes the socket file the website shows: 20 exports of Ollie's blended socket from 0.1 to 3.9 mm, compressed the way the site compresses models, with file size, shape error and lost lattice side by side."),
    "screw-attachment.html": (
        "Screw Attachment",
        "What each number in the nTop screw attachment block does: attachment diameter, shank diameter, grip length, head diameter and head height, shown on 2,498 real nTop exports with a see-through screw, real M2 to M6 screw sizes, and a five-slider explorer."),
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
    "knee-anatomy-quiz.html": (
        "Knee Anatomy Quiz",
        "Quiz yourself on the human knee in four modes: multiple choice, find-and-click, typed answers, and matching, on textbook illustrations of the joint and of the thigh and calf muscles that move it. Build a custom quiz and share it as a link."),
    "ear-anatomy-quiz.html": (
        "Ear Anatomy Quiz",
        "Quiz yourself on the human ear in four modes: multiple choice, find-and-click, typed answers, and matching. Learn the landmarks of the external ear (helix, antihelix, tragus, concha and more) and the structures of the middle and inner ear. Build a custom quiz and share it as a link."),
    "heart-anatomy-quiz.html": (
        "Heart Anatomy Quiz",
        "Quiz yourself on the human heart in four modes: multiple choice, find-and-click, typed answers, and matching, on textbook illustrations of the outside, the inside, and the blood flow through its chambers. Build a custom quiz and share it as a link."),
    "hand-anatomy-quiz.html": (
        "Hand &amp; Forearm Anatomy Quiz",
        "Quiz yourself on the human hand and forearm in four modes: multiple choice, find-and-click, typed answers, and matching, on OpenStax textbook illustrations. Build a custom quiz and share it as a link."),
    "arm-anatomy-quiz.html": (
        "Shoulder &amp; Arm Anatomy Quiz",
        "Quiz yourself on the human shoulder and arm in four modes: multiple choice, find-and-click, typed answers, and matching, on OpenStax textbook illustrations. Build a custom quiz and share it as a link."),
    "chest-anatomy-quiz.html": (
        "Chest &amp; Lungs Anatomy Quiz",
        "Quiz yourself on the human chest in four modes: multiple choice, find-and-click, typed answers, and matching, on OpenStax textbook illustrations. Build a custom quiz and share it as a link."),
    "organs-anatomy-quiz.html": (
        "Abdominal Organs Anatomy Quiz",
        "Quiz yourself on the human abdominal organs in four modes: multiple choice, find-and-click, typed answers, and matching, on OpenStax textbook illustrations. Build a custom quiz and share it as a link."),
    "foot-anatomy-quiz.html": (
        "Foot &amp; Ankle Anatomy Quiz",
        "Quiz yourself on the human foot and ankle in four modes: multiple choice, find-and-click, typed answers, and matching, on OpenStax textbook illustrations. Build a custom quiz and share it as a link."),
    "head-anatomy-quiz.html": (
        "Head &amp; Neck Anatomy Quiz",
        "Quiz yourself on the human head in four modes: multiple choice, find-and-click, typed answers, and matching, on OpenStax textbook illustrations. Build a custom quiz and share it as a link."),
    "spine-anatomy-quiz.html": (
        "Spine &amp; Pelvis Anatomy Quiz",
        "Quiz yourself on the human spine and pelvis in four modes: multiple choice, find-and-click, typed answers, and matching, on OpenStax textbook illustrations. Build a custom quiz and share it as a link."),
    "human-anatomy.html": (
        "Human Anatomy Quizzes",
        "Pick a human anatomy quiz by body region: skeleton, head and neck, ear, chest, heart, abdominal organs, spine, arm, hand, knee and foot."),
    "anatomy-learning-lab.html": (
        "Anatomy Learning Lab",
        "Five research-backed ways to study anatomy, as interactive demos on the site's dog, human and ear outlines: spaced review, drawing from memory, confidence checks, dog vs human comparison and step-by-step learning."),
    "anatomy-labelling.html": (
        "Anatomy Labelling Hub",
        "Progress checklist for labelling the human anatomy quiz sets in the shape editor."),
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

    # 2b. footer previous / next (only on pages that have a footer)
    fnav = build_footer_nav(page)
    if fnav and "<footer>" in text:
        text = re.sub(r'[ \t]*<div class="footer-navigation">.*?</a>\s*</div>'
                      r'[ \t]*\n(?:[ \t]*\n)*', '', text, count=1, flags=re.S)
        pad = ' ' * 16
        text, n = re.subn(r'^[ \t]*<div class="footer-credits">',
                          lambda m: pad + fnav + '\n' + pad + '<div class="footer-credits">',
                          text, count=1, flags=re.M)
        if n:
            notes.append("footer-nav")

    # 2c. related links (case studies <-> build pages)
    if page in RELATED:
        text = re.sub(r'[ \t]*' + re.escape(REL_START) + r'.*?' + re.escape(REL_END)
                      + r'[ \t]*\n', '', text, count=1, flags=re.S)
        anchor = (r'^[ \t]*<section id="referenced-papers">' if page.endswith("case-study.html")
                  else r'^[ \t]*</article>')
        text, n = re.subn(anchor, lambda m: build_related(page) + m.group(0),
                          text, count=1, flags=re.M)
        if n:
            notes.append("related")

    # 2d. region bar on the human anatomy region quizzes
    text = re.sub(r'[ \t]*' + re.escape(RB_START) + r'.*?' + re.escape(RB_END) + r'[ \t]*\n', '',
                  text, count=1, flags=re.S)
    if page in dict(HUMAN_PAGES):
        text, n = re.subn(r'^[ \t]*<h1>', lambda m: build_region_bar(page) + m.group(0),
                          text, count=1, flags=re.M)
        if n:
            notes.append("region-bar")

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
