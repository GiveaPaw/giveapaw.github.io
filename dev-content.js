// The developer hub's snapshot (dev.html). Edit freely: it is what everyone sees before the live board
// (Firebase devboard/) loads or if it cannot. Status: live | live-with-local-changes | local-only | paused | private | retired.
// Health: good | needs-work | blocked. Keep notes short and never put passwords or keys here: the page is public.
export const content = {
 "snapshotDate": "2026-10-28",
 "notice": "Tyler built most of this site in 2026 and is handing it off. The cards below show where each part stood on 28 October 2026; anyone on the team can update them after signing in, so the board stays the place to check first. Things waiting on a decision or on an account owner are marked Blocked and listed under Needs attention.",
 "startSteps": [
  "Read How the site works below (five minutes). The site is plain files on GitHub Pages; 3D models, live data and uploads live in three other services.",
  "Get access: write access to the GiveaPaw GitHub organisation, a place on the team list (see Team access), and, if you will own the site, the Firebase, Google Cloud and Cloudflare accounts from the current owner.",
  "Get the full working folder (see How to…) and run it locally with python tools/range_server.py 8765.",
  "Pick a card with Needs work or a What's next item, and update the card when you start and when you stop.",
  "Read Rules & gotchas before publishing anything."
 ],
 "architecture": [
  {
   "name": "Pages",
   "service": "GitHub Pages",
   "icon": "layout-template",
   "check": "pages",
   "what": "Every page is an HTML file with its own JavaScript and CSS. Pushing to the main branch of GiveaPaw/giveapaw.github.io publishes it in about a minute. No build step.",
   "files": [
    "*.html",
    "style.css",
    "script.js",
    "tools/site_infra.py"
   ],
   "link": "https://github.com/GiveaPaw/giveapaw.github.io",
   "linkLabel": "Repository"
  },
  {
   "name": "3D models",
   "service": "Cloudflare R2 bucket",
   "icon": "boxes",
   "check": "models",
   "what": "Thousands of slider models (nTop sweeps) are too big for GitHub, so they sit in a free bucket. Pages ask model-base.js where a file lives and fall back to the site copy.",
   "files": [
    "model-base.js",
    "tools/r2_upload.py",
    "sample-models/"
   ],
   "link": "https://dash.cloudflare.com/",
   "linkLabel": "Cloudflare"
  },
  {
   "name": "Live data and team sign-in",
   "service": "Firebase Realtime Database",
   "icon": "flame",
   "check": "database",
   "what": "Everything that changes while the site runs: live review sessions, the design log, case-study updates, anatomy labelling and this board. Access rules are in database.rules.json.",
   "files": [
    "firebase-config.js",
    "database.rules.json"
   ],
   "link": "https://console.firebase.google.com/project/give-a-paw/database",
   "linkLabel": "Firebase console"
  },
  {
   "name": "Uploads and presentations",
   "service": "Google Drive + Google Cloud",
   "icon": "hard-drive",
   "check": "google",
   "what": "Photos, videos and design files go to the club's Drive; Review Builder presentations go to each person's own Drive. Google sign-in and the Drive picker are set up in the Google Cloud project.",
   "files": [
    "drive-config.js",
    "google-session.js",
    "drive-store.js"
   ],
   "link": "https://console.cloud.google.com/apis/credentials?project=give-a-paw",
   "linkLabel": "Google Cloud"
  },
  {
   "name": "Outside libraries",
   "service": "CDNs (unpkg, jsDelivr, gstatic)",
   "icon": "package",
   "check": "libraries",
   "what": "three.js for every 3D view, the Firebase SDK, Lucide icons and the Draco decoder load from public CDNs at fixed versions. If a CDN is down, those parts stop working.",
   "files": [
    "three@0.170.0",
    "firebase 10.14.1",
    "lucide@0.468.0"
   ]
  },
  {
   "name": "Publishing",
   "service": "GitHub",
   "icon": "rocket",
   "check": "github",
   "what": "Changes are published from a fresh copy of the live site with a PowerShell script per change (publish-*.ps1), listing exactly which files go up.",
   "files": [
    "publish-*.ps1"
   ],
   "link": "https://github.com/GiveaPaw/giveapaw.github.io/commits/main",
   "linkLabel": "History"
  },
  {
   "name": "Making the models",
   "service": "nTop + Python on a team computer",
   "icon": "cpu",
   "check": "local",
   "what": "Sockets come from nTop notebooks run over grids of settings with ntopcl, then the converters in tools/ shrink each export to a small GLB. This needs nTop with an Automate licence.",
   "files": [
    "tools/convert_*.py",
    "sweep-monitor/",
    "automation/"
   ]
  }
 ],
 "modelProbe": "sample-models/interpolate-sample/ollie-surface-2.obj",
 "libraries": [
  {
   "name": "three.js",
   "url": "https://unpkg.com/three@0.170.0/build/three.module.js"
  },
  {
   "name": "Firebase SDK",
   "url": "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js"
  },
  {
   "name": "Lucide icons",
   "url": "https://unpkg.com/lucide@0.468.0/dist/umd/lucide.min.js"
  },
  {
   "name": "Draco decoder",
   "url": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/draco_decoder.wasm"
  }
 ],
 "projects": [
  {
   "id": "home-page",
   "area": "Public site",
   "name": "Home page",
   "pages": [
    "index.html"
   ],
   "status": "live",
   "health": "needs-work",
   "progress": 85,
   "lastLive": "10cfef4 2026-10-25",
   "summary": "The landing page. The hero shows two slow turntable videos (sockets first, then scans) beside the title, and its main button opens the socket walkthrough.",
   "howItWorks": "Hero videos are media/home/hero-sockets.mp4 and hero-scans.mp4, played and crossfaded by home-hero.js / home-hero.css (click the video to pause). Other sections and the patient card conveyor use the shared style.css and script.js.",
   "notes": [
    "The hero videos were rendered in Blender at 720x900 on the page's navy background; re-render rather than re-time them (a speed-up/slow-down blend looked choppy).",
    "The old 'Design a socket in your browser' playground section was removed; script.js skips that block when its element is missing.",
    "Locally the menu has one extra link (My Presentations) that is not live yet."
   ],
   "next": [
    "Tyler to decide: the 'Socket Creation' process card and the Try It Yourself cards still point at pages that left the menu (plane locators, Implicit Field Viewer, Mesh Tolerance)."
   ],
   "owner_actions": []
  },
  {
   "id": "dev-hub",
   "area": "Public site",
   "name": "Developer hub (this page)",
   "pages": [
    "dev.html"
   ],
   "status": "local-only",
   "health": "blocked",
   "progress": 85,
   "lastLive": null,
   "summary": "This page: project board, live checks, recent changes, accounts and how-tos for whoever picks up the site.",
   "howItWorks": "dev.js reads the snapshot in dev-content.js and the page list in dev-pages.js (made by tools/dev_pages.py), then lays the live board from Firebase devboard/ on top. Edits need Google sign-in with an account on designlog/team. ?demo=1 keeps edits in the browser.",
   "notes": [
    "The snapshot is what everyone sees if the database is unreachable; update dev-content.js now and then so it does not drift far from the board.",
    "Anyone can read the board; keep notes short and never put passwords or keys in them.",
    "Linked from the footer of every page with a sidebar (tools/site_infra.py FOOTER)."
   ],
   "next": [
    "Tyler to publish the devboard database rules (DEV-BOARD-SETUP.md), then publish the page."
   ],
   "owner_actions": [
    "Publish the devboard rules in the Firebase console"
   ]
  },
  {
   "id": "case-studies",
   "area": "Patient case studies",
   "name": "Patient case studies (Billie, Ollie, Kiki, Max, Yana)",
   "pages": [
    "billie-case-study.html",
    "ollie-case-study.html",
    "kiki-case-study.html",
    "max-case-study.html",
    "yana-case-study.html"
   ],
   "status": "live",
   "health": "good",
   "progress": 85,
   "lastLive": "dc8f454 2026-10-18 (layout); later script bumps up to c91d357 2026-10-20",
   "summary": "One page per animal patient. Each opens on a 'Three steps' overview (Meet the animal, What we are building, Where it stands) with tabs Photos & videos | Report | Design history.",
   "howItWorks": "case-history.js + case-views.js (and their CSS) build the dashboard and tabs on top of the original page; ?layout=off shows the original. Design history reads iterations/animals.json and iterations/<animal>.json; thumbnails come from tools/render_iteration_thumbs.py. Download lists link to files in the club Google Drive.",
   "notes": [
    "Only Billie and Ollie have a design history so far; others say 'Design history coming soon'.",
    "Missing 3D component files are expected: script.js checks which GLBs exist and hides the others. Do not delete those references.",
    "Drive links go to single files or the Scans / Measurement session folders, never to an animal's root folder (owner names and documents).",
    "Old prototype layouts still exist behind ?view= / ?layout=a|b|c and on case-history-options.html (local)."
   ],
   "next": [
    "Fall 2026 patients have no pages yet (menu group shows 'Coming soon'); Charlie and Doja have Drive folders but no pages.",
    "tools/new_patient.py must be updated first: it still looks for an 'Our Patients' menu group that no longer exists."
   ],
   "owner_actions": []
  },
  {
   "id": "team-updates",
   "area": "Patient case studies",
   "name": "Team updates on case studies (full-screen update studio + update editor)",
   "pages": [
    "billie-case-study.html",
    "ollie-case-study.html",
    "kiki-case-study.html",
    "max-case-study.html",
    "yana-case-study.html"
   ],
   "status": "live",
   "health": "good",
   "progress": 85,
   "lastLive": "c91d357 2026-10-20",
   "summary": "Signed-in team members post dated updates on an animal's page, with photos, videos, 3D models and design files that open full screen with pins, drawings and notes. Visitors just read them.",
   "howItWorks": "case-updates.js reads cases/pages/<animal> from Firebase with one REST request; 'Team sign in' (Google) loads the editing code. update-editor.js is the post/edit window, update-studio.js the full-screen viewer, drive-store.js + drive-gallery.js upload to or pick from each animal's 'Website uploads' Drive folder (folder ids in iterations/animals.json).",
   "notes": [
    "Who can write is set by Firebase rules: admins are cases/admins/<email key> (set in the console), editors are added on the site by an admin.",
    "Email keys are lowercase with every '.' replaced by ','.",
    "Any rule change (new media kinds, fields) must be published in the Firebase console before the pages that use it go live, or posts are refused.",
    "?casedemo=1 runs a browser-only demo signed in as admin; demo-update-view.html is a local test page and must never be published."
   ],
   "next": [
    "Tyler still needs to fix Ollie's top-down notes 4 and 5 with 'Save current angle' (they were saved before an angle-rounding fix)."
   ],
   "owner_actions": [
    "Add or remove admins under cases/admins in the Firebase console",
    "Republish database.rules.json when the cases rules change"
   ]
  },
  {
   "id": "socket-walkthrough",
   "area": "Socket walkthrough",
   "name": "Socket walkthrough (nTop workflow in the browser)",
   "pages": [
    "socket-walkthrough-sample.html",
    "socket-walkthrough.html"
   ],
   "status": "live",
   "health": "good",
   "progress": 85,
   "lastLive": "e25b67c 2026-10-28",
   "summary": "The main teaching tool: students go through the nTop socket workflow step by step (import and scale, planes and interface placement, lattice, attachment points, blending, export) on a 3D view, using real nTop results. Cases: Ollie and a wheelchair Chihuahua.",
   "howItWorks": "socket-walkthrough-sample.html/.js/.css plus import-catalog.js (cases, files, plane answers), attachment-holes.js, attachment-demo.js, viewer-controls.js (nTop-style navigation and view cube) and walkthrough-notes.js (notes saved in localStorage). Slider values pick pre-made nTop sweep GLBs from sample-models/ folders, loaded from the R2 bucket through model-base.js with the site copy as fallback.",
   "notes": [
    "Sliders only choose between exported sweep files; the browser never builds socket geometry. Moving one linked slider pair resets the other because only those combinations were exported.",
    "Step ids are 1, 2a-2d, 3, 4a, 4b, 5, 6; they have been renamed twice, and the answer keys use them.",
    "socket-walkthrough.html is now only a redirect to the -sample page (the old page was a smaller copy). Swapping the two file names is a nice-to-have.",
    "Bump the ?v= numbers on every JS/CSS import you edit, or browsers show the old file.",
    "Use timers, not requestAnimationFrame, for 'once the view has settled' code: rAF never fires in a window that is not painting.",
    "Step 4b uses the 10-23 screw attachment sweep (sample-models/attachment-screw-1023/, live since e336e4b 2026-10-24) with screw presets; the older attachment sweeps were archived to Desktop/Animals/site-archive-2026-10-23."
   ],
   "next": [
    "The Billie (large) interface has no recorded plane answer, so practice/grading cannot check it.",
    "The scan's mild ripples were smoothed (tools/smooth_chi_imports.py); confirm the smoothed copies are the ones on R2 and live."
   ],
   "owner_actions": []
  },
  {
   "id": "walkthrough-grading",
   "area": "Socket walkthrough",
   "name": "Walkthrough grading and answer key editor",
   "pages": [
    "socket-walkthrough-sample.html",
    "answer-key-editor.html",
    "grading-editor.html"
   ],
   "status": "live",
   "health": "needs-work",
   "progress": 70,
   "lastLive": "c6b672f 2026-10-27 (grading); editors are local-only by design",
   "summary": "'Compare with the answer key' at the end of the walkthrough splits the view into Yours vs the answer and marks each decision as match, close or off. The answer key editor is a private tool for painting acceptable areas and setting slider ranges.",
   "howItWorks": "walkthrough-grading.js + grading-sliders.js load grading/<case>-answer-key.json (ollie, chi-wc) and read its params, bands (green/caution ranges), interfaceRegion and attachmentZones (painted areas stored as brush dabs). answer-key-editor.html writes those files through tools/range_server.py (/__grading/save, backups in grading/_backups); start it with 'Open answer key editor.cmd' (port 8765).",
   "notes": [
    "Grading compares with one worked solution (Tyler's), not a spread of experts. Ollie's planes: pelvic X max / Y centroid / Z centroid, normal -1,0,0; small interface X/Y centroid, Z min, normal 0,0,1. Do not mix them up with the wheelchair answers.",
    "grading-editor.html is the older editor (Chihuahua key, cannot edit the newer decision types); answer-key-editor.html replaces it.",
    "Painted areas are in the 0.95-scaled frame, in millimetres."
   ],
   "next": [
    "Paint and set the wheelchair Chihuahua key (grading/chi-wc-answer-key.json only has imports and planes).",
    "Decide whether to delete grading-editor.html.",
    "Real expert answers could later replace or supplement the single solution (Tyler to decide)."
   ],
   "owner_actions": []
  },
  {
   "id": "design-review",
   "area": "Design review + live sessions",
   "name": "Design review page and live sessions",
   "pages": [
    "design-review.html"
   ],
   "status": "live-with-local-changes",
   "health": "good",
   "progress": 85,
   "lastLive": "3ed3e7b 2026-10-15 (page code); Ollie deck ffca812 2026-10-14",
   "summary": "A guided, screen-by-screen presentation for outside experts (first used with Derrick Campana of Bionic Pets on Ollie): videos with drawing tools, 3D models, sweep sliders, pins and notes. A presenter can run a live session that everyone's screen follows.",
   "howItWorks": "design-review.js/.css read a review file: ?review=reviews/<name>.json, drive:<id> (from the review builder) or draft:<key>. review-tools.js adds paint and leg tools; live-session.js syncs through Firebase sessions/<PAW-code> with anonymous sign-in. Reviewer notes autosave to that browser's localStorage and can be shared as a link or .json.",
   "notes": [
    "Main deck: design-review.html?review=reviews/ollie-fit-review.json (add &host for the presenter view).",
    "Never rename a screen id: reviewers' notes are stored under it.",
    "Notes typed while presenting live only in that browser; bring them into the file as presenterNotes with the editor.",
    "Each 3D view uses 2 WebGL contexts and browsers allow about 16, so stage viewers are built only for the screen on show.",
    "Local copy is v96 (per-screen tools and steps for Review Builder v3); live is v95."
   ],
   "next": [
    "Publish v96 together with Review Builder v3 when Tyler approves.",
    "Not yet checked on a real iPhone/iPad."
   ],
   "owner_actions": [
    "Firebase rules for sessions are already published (2026-10-01); republish only if they change"
   ]
  },
  {
   "id": "presentation-editor",
   "area": "Presentation editor",
   "name": "Presentation editor (local)",
   "pages": [
    "review-editor.html"
   ],
   "status": "live-with-local-changes",
   "health": "good",
   "progress": 85,
   "lastLive": "c6a599e 2026-10-03 (page is on the site but only works with the local server)",
   "summary": "Edits a site review file such as reviews/ollie-fit-review.json: reorder, hide and add screens, tabs and materials, trim clips, presenter notes, with a live preview and Present mode.",
   "howItWorks": "review-editor.js saves through tools/range_server.py (POST /__editor/save, previous version copied to reviews/_backups/). review-gallery.js + tools/media_library.py browse this PC (site, Google Drive for desktop, Downloads...) and import web-ready copies into media/<folder>.",
   "notes": [
    "Run the server as its own process: python tools/range_server.py 8131 (plain http.server cannot seek video). A server started by a preview pane dies when the pane closes.",
    "Saves are refused if the file changed on disk since the editor loaded it (409), so an old tab cannot wipe newer edits; check reviews/_backups/ if something vanished.",
    "HEIC photos need pillow-heif; ffmpeg 7.0 decodes iPhone HEIC wrongly.",
    "Restart the range server after changing tools/media_library.py."
   ],
   "next": [
    "Local has unpublished 3D-model support in the gallery (review-editor.js, review-gallery.js); publishing it is optional since the editor is a local tool."
   ],
   "owner_actions": []
  },
  {
   "id": "review-builder",
   "area": "Review builder",
   "name": "Review Builder",
   "pages": [
    "review-builder.html"
   ],
   "status": "live-with-local-changes",
   "health": "blocked",
   "progress": 75,
   "lastLive": "b765620 2026-10-22 (v2)",
   "summary": "A web page for anyone on the team to build a design review from files in their Google Drive and save it there, without the local server. The local v3 rewrite looks like the presentation editor.",
   "howItWorks": "review-builder.js signs in with Google (drive.file scope; config in drive-config.js; shared sign-in in google-session.js), saves the review JSON into a 'Give a Paw Reviews' Drive folder with appProperties gapReview=1, and previews via design-review.html?review=draft:<id>. Meshes are converted in the browser with model-convert.js before upload; 'Slider from surfaces' uses surface-interpolate-ui.js.",
   "notes": [
    "Live is v2; local v3/v4 is a full rewrite plus My Presentations integration.",
    "Its tests fake Google sign-in (Playwright); real Drive sign-in by another account has not been checked end to end.",
    "Testing on a port other than 8765 gets R2 CORS refusals; add ?modelBase= or use 8765."
   ],
   "next": [
    "Waiting on Tyler's go-ahead to publish v3 (publish-review-builder.ps1), together with design-review v96 and My Presentations."
   ],
   "owner_actions": [
    "OAuth consent screen 'In production' and the site in Authorized JavaScript origins (see google-oauth-drive)"
   ]
  },
  {
   "id": "my-presentations",
   "area": "Review builder",
   "name": "My Presentations",
   "pages": [
    "my-presentations.html"
   ],
   "status": "local-only",
   "health": "blocked",
   "progress": 80,
   "lastLive": null,
   "summary": "A sign-in page listing the design reviews a person saved with the Review Builder, with Present, Edit, Copy link, Rename, Duplicate, Share and Trash.",
   "howItWorks": "my-presentations.js lists the person's own Drive files with appProperties gapReview=1 and reads each review JSON for its title and cover. google-session.js keeps the Google token in sessionStorage for an hour so moving to the builder does not ask again.",
   "notes": [
    "Only builder-saved Drive reviews appear; site files such as reviews/ollie-fit-review.json do not.",
    "Nothing is stored on a server: each person's presentations live in their own Drive.",
    "The local menu already links to it (tools/site_infra.py), so pages published from local will carry that link."
   ],
   "next": [
    "Publish together with Review Builder v3 once Tyler approves."
   ],
   "owner_actions": [
    "Google Cloud console: set the OAuth consent screen to 'In production' (in Testing only listed test users can sign in)",
    "Make sure https://giveapaw.github.io and http://localhost:8131 are Authorized JavaScript origins on the OAuth client"
   ]
  },
  {
   "id": "expert-judges",
   "area": "Expert judges / grading",
   "name": "Expert judges page (private)",
   "pages": [
    "judges.html"
   ],
   "status": "private",
   "health": "good",
   "progress": 80,
   "lastLive": null,
   "summary": "A local data-collection page that stores each expert judge's slider picks, notes and marks from a design review, and compares all judges per slider. Exports CSV/JSON for a future grading system.",
   "howItWorks": "judges.js talks to tools/range_server.py (/__judges/list, /__judges/save, /__judges/remove), which stores judges/<review id>/<judge id>.json with backups in judges/_backups/. Responses come from the Live session 'Save' button, a judge's share link, or their downloaded .json.",
   "notes": [
    "judges/ is private research data: never copy it into a publish clone. The server never serves it as files.",
    "The Ollie judges answered a different dog than the walkthrough cases, so their picks are not an answer key as-is."
   ],
   "next": [
    "How judge data feeds grading is not decided (Tyler)."
   ],
   "owner_actions": []
  },
  {
   "id": "design-log",
   "area": "Design log / design history",
   "name": "Design log (team log of socket versions)",
   "pages": [
    "design-log.html"
   ],
   "status": "live",
   "health": "blocked",
   "progress": 85,
   "lastLive": "3f8fafd 2026-10-28",
   "summary": "The team's record of every prosthetic version per animal: what changed and why, pins with reply threads on the 3D model, drawings, section cuts, saved views, notes and to-dos. Google sign-in; only accounts on the team list can open it.",
   "howItWorks": "design-log.js/.css with design-log-store.js and the shared iteration-viewer.js; sketch.js holds the drawing format. Cloud data lives at designlog/logs/<animal>/iterations/<id>/... in Firebase; ?demo=1 uses localStorage seeded from iterations/ollie.json. The animal list is iterations/animals.json from tools/design_log_manifest.py.",
   "notes": [
    "Team access is designlog/team/<uid> = true, added by hand in the Firebase console (the page shows the person's ID to copy).",
    "Never use 'Import JSON' on the database root: it replaces everything, including other features' data.",
    "The case-study Design history tab shows only the public iterations/<animal>.json files, never the team log."
   ],
   "next": [
    "Blocked on Tyler: publish the 2026-10-28 rules (drawings, notes, pin tags, section) in the Firebase console; until then those saves fail with 'Not saved'.",
    "Cloud rules have never been tested with an emulator."
   ],
   "owner_actions": [
    "Publish database.rules.json in the Firebase console",
    "Add teammates' uids under designlog/team"
   ]
  },
  {
   "id": "anatomy-quizzes",
   "area": "Anatomy quizzes & learning lab",
   "name": "Anatomy quizzes, labelling editor and Learning Lab",
   "pages": [
    "anatomy-quiz.html",
    "human-anatomy.html",
    "human-anatomy-quiz.html",
    "head-anatomy-quiz.html",
    "ear-anatomy-quiz.html",
    "chest-anatomy-quiz.html",
    "heart-anatomy-quiz.html",
    "organs-anatomy-quiz.html",
    "spine-anatomy-quiz.html",
    "arm-anatomy-quiz.html",
    "hand-anatomy-quiz.html",
    "knee-anatomy-quiz.html",
    "foot-anatomy-quiz.html",
    "anatomy-labelling.html",
    "anatomy-learning-lab.html"
   ],
   "status": "live",
   "health": "good",
   "progress": 70,
   "lastLive": "quiz engine 8886e50 2026-10-19; Learning Lab 5d699ce 2026-10-20; hub/menu 2b05f07 2026-10-20",
   "summary": "Canine and human anatomy quizzes in four modes (multiple choice, click to find, type the name, matching) on textbook illustrations. Tyler traces the structures himself in a ?dev=1 editor, including on an iPad, and the quizzes use them straight away. The Learning Lab adds five study demos (spaced review, draw from memory, confidence check, dog vs human, one structure at a time) on the traced sets.",
   "howItWorks": "One engine, quiz-engine.js; each page loads its quiz-data-*.js. ?dev=1 loads quiz-editor.js. anatomy-cloud.js saves labelling to Firebase anatomy/pages/<page> (public read, writes only by anatomy/editors uids) with daily backups; tools/anatomy/pull_cloud.py copies the cloud copy into the data files. The region pages and images come from tools/anatomy/build_atlas.py (OpenStax figures). Learning Lab: learning-lab.js/.css, progress in localStorage (ll-* keys), needs sets with at least 4 traced outlines.",
   "notes": [
    "Quiz links use slugs of item names, so renaming an item breaks existing custom-quiz links.",
    "Most of the 895 human structures are still unplaced; quizzes skip unlabelled items.",
    "Image credits (Wikimedia/OpenStax licences) must stay with the images.",
    "When the editor JS changes, bump its ?v= inside quiz-engine.js."
   ],
   "next": [
    "Ongoing hand labelling by Tyler (or a successor added under anatomy/editors)."
   ],
   "owner_actions": [
    "Add editor uids under anatomy/editors in the Firebase console"
   ]
  },
  {
   "id": "mesh-check",
   "area": "Tools",
   "name": "Mesh Check & Repair",
   "pages": [
    "mesh-check.html",
    "mesh-check-a.html",
    "mesh-check-b.html",
    "mesh-check-c.html"
   ],
   "status": "live",
   "health": "good",
   "progress": 90,
   "lastLive": "6778cb6 2026-10-23",
   "summary": "Drop an STL/OBJ/3MF/GLB and get a plain report of problems nTop will reject (holes, flipped faces, self-intersections, non-manifold edges), a 3D view of each, and a repaired STL or OBJ. Everything runs in the browser.",
   "howItWorks": "mesh-check.js + mesh-check-core.js (texts, viewer, downloads) on the engine mesh-repair.js; files are read with model-convert.js. Overlapping closed shells are merged with manifold-3d (WebAssembly from jsdelivr).",
   "notes": [
    "After any engine change, re-run tools/make_mesh_check_tests.py cases, mesh-check-sample.obj and a real nTop socket (must stay 0 open / 0 non-manifold edges).",
    "The loose weld only touches vertices on open edges; welding everything tore healthy nTop sockets.",
    "mesh-check-a/b/c.html are local design prototypes (A was chosen); do not publish them."
   ],
   "next": [
    "No web worker yet, so the tab is busy during a check."
   ],
   "owner_actions": []
  },
  {
   "id": "model-converter",
   "area": "Tools",
   "name": "Model Converter",
   "pages": [
    "convert.html"
   ],
   "status": "live",
   "health": "good",
   "progress": 90,
   "lastLive": "94926a5 2026-10-21",
   "summary": "Turns an STL/OBJ/3MF/GLB into a web-ready GLB in the browser, with quality levels to compare. Gives a plain GLB for PowerPoint and a compressed (Draco) one for the website.",
   "howItWorks": "convert.js on the shared model-convert.js (loading, welding, simplifying with meshoptimizer, GLB writing with gltf-transform + Draco WebAssembly) and model-convert-ui.js. Matches the Python pipeline: Z-up, millimetres, 150K-triangle 'Presentation' tier.",
   "notes": [
    "PowerPoint/Office cannot read Draco GLBs; use the plain download there.",
    "Use the WebAssembly Draco encoder (draco3d@1.5.7); three.js's bundled asm.js encoder is about 250 times slower.",
    "For bulk nTop sweeps use the Python tools/convert_*.py scripts instead."
   ],
   "next": [
    "PowerPoint itself was never tested with the plain GLB."
   ],
   "owner_actions": []
  },
  {
   "id": "surface-interpolator",
   "area": "Tools",
   "name": "Surface Interpolator",
   "pages": [
    "surface-interpolator.html"
   ],
   "status": "live",
   "health": "good",
   "progress": 75,
   "lastLive": "b765620 2026-10-22",
   "summary": "Load a solid animal and two or more painted attachment surfaces, scrub a blend between them, and download in-between surfaces as STLs (zip with a manifest) to feed nTop.",
   "howItWorks": "surface-interpolate.js (distance fields on the mesh, cut along the blended contour) with the reusable panel surface-interpolate-ui.js and the thin page script surface-interpolator.js. The sample loads from sample-models/interpolate-sample/ via modelUrl() (R2).",
   "notes": [
    "One parameter only (keyframes in order); the Python automation/parametric_attachment.py handles more.",
    "Distances must stay float64; float32 silently broke the blends."
   ],
   "next": [
    "Plan: use it inside the editors as a 'Surface sweep' source (the local Review Builder v3 already has 'Slider from surfaces')."
   ],
   "owner_actions": []
  },
  {
   "id": "sweep-studio",
   "area": "Tools",
   "name": "Sweep Studio",
   "pages": [
    "sweep-studio.html"
   ],
   "status": "local-only",
   "health": "good",
   "progress": 75,
   "lastLive": null,
   "summary": "A three-step wizard: plan an nTop parameter sweep (writes the ntopcl input file and the command to run), run it in nTop, then drop the export folder to get a slider presentation.",
   "howItWorks": "sweep-studio.js reads a notebook's input template (from ntopcl -t), turns value ranges into the input JSON + run-<name>.cmd, then converts every exported file with model-convert.js and writes a one- or two-bar sweep deck. 'Add to this site' uploads through the local range server; otherwise it gives a zip.",
   "notes": [
    "Stays local on purpose: ntopcl can only run on a PC with nTop Automate.",
    "The sample template templates/ollie-socket-input-template.json is the older 3-input schema.",
    "?tour=1 walks through a full example with Ollie's files."
   ],
   "next": [
    "No web worker (336 files takes about 4 minutes and freezes the tab).",
    "Original/extra stops and the animal overlay must be added in the editor afterwards."
   ],
   "owner_actions": []
  },
  {
   "id": "ntop-explainers",
   "area": "nTop explainers",
   "name": "nTop explainer pages (plane locators, implicit viewer, mesh tolerance, screw attachment)",
   "pages": [
    "pelvic-plane-locator.html",
    "interface-plane-locator.html",
    "implicit-viewer.html",
    "mesh-tolerance.html",
    "screw-attachment.html"
   ],
   "status": "live",
   "health": "needs-work",
   "progress": 80,
   "lastLive": "screw-attachment 9434bed 2026-10-23; mesh-tolerance d37806b 2026-10-19; others earlier",
   "summary": "Interactive pages that explain single nTop blocks or settings: how the pelvic and interface planes are picked, an implicit (distance-field) viewer, how mesh export tolerance affects the socket, and what each screw attachment number does.",
   "howItWorks": "Each page has its own three.js viewer. implicit-viewer.html uses sdf-viewer.js to ray-march .sdf files baked by tools/bake_sdf.py. screw-attachment.html loads sample-models/attachment-screw-1023/ GLBs (2,498 files) from R2.",
   "notes": [
    "Since 2026-10-23 none of these are in the menu (Tyler: the walkthrough covers them), but the pages are live and still generated by site_infra.py.",
    "nTop's own .implicit export cannot be shown in a browser; visuals are baked from mesh exports.",
    "The Billie plane-locator models are in the July 8 scan frame (mm) and must not be mixed with older re-centred Billie files."
   ],
   "next": [
    "Tyler to decide whether these stay reachable from the home page cards or are retired."
   ],
   "owner_actions": []
  },
  {
   "id": "ntop-guide-pages",
   "area": "nTop explainers",
   "name": "Preparing nTop Input and nTop Socket Creation guides",
   "pages": [
    "preparing-ntop-input.html",
    "ntop-socket-creation.html"
   ],
   "status": "live-with-local-changes",
   "health": "needs-work",
   "progress": 70,
   "lastLive": "unknown exact commit (page live; FAQ not yet published)",
   "summary": "Written guides to preparing meshes for nTop and building the socket, with older interactive slider demos of the lattice blocks.",
   "howItWorks": "Slider demos use the config-driven initBlock engine in script.js: each slider value builds a predictable, zero-padded GLB filename. A Socket Creation FAQ (11 questions with fixes) exists locally at ntop-socket-creation.html#faq, with a pointer on preparing-ntop-input.html.",
   "notes": [
    "In script.js initBlock configs, a straight apostrophe in user text breaks the whole file; reword instead.",
    "Both pages left the menu on 2026-10-23 but are live."
   ],
   "next": [
    "Publish the FAQ if Tyler wants it (local-only so far)."
   ],
   "owner_actions": []
  },
  {
   "id": "ntop-blocks",
   "area": "nTop explainers",
   "name": "How the nTop Blocks Work (maintainer reference)",
   "pages": [
    "ntop-blocks.html"
   ],
   "status": "local-only",
   "health": "needs-work",
   "progress": 60,
   "lastLive": null,
   "summary": "A reference for whoever changes the nTop notebook later: each custom block's inputs, outputs, the blocks inside it in order, and how they connect, following the 10-17 workflow notebook.",
   "howItWorks": "Content is in ntop-blocks-content.js (explanations) and ntop-blocks-structure.js (generated by tools/ntop/ntop_structure.py from the .ntop file, which is readable JSON chunks). Visuals are .sdf files in ntop-blocks/ baked with tools/bake_sdf.py.",
   "notes": [
    "Text written by Claude carries draft: true and shows a Draft tag until Tyler replaces it.",
    "Renaming a block in nTop orphans its explanation; the page counts 'N of M steps explained'.",
    "Tests: tools/ntop/test_ntop_blocks_page.py and audit_ntop_blocks_page.py (serve on port 8790)."
   ],
   "next": [
    "Tyler to review/replace the draft explanations and supply block visuals.",
    "Then decide whether to add it to the menu and publish (noindex)."
   ],
   "owner_actions": []
  },
  {
   "id": "ntop-sweeps",
   "area": "nTop sweeps & automation",
   "name": "nTop sweeps, Sweep Monitor and GLB converters",
   "pages": [],
   "status": "local-only",
   "health": "good",
   "progress": 75,
   "lastLive": null,
   "summary": "How the slider models are made: nTop notebooks are run headless with ntopcl over a grid of input values, then each export is converted to a small compressed GLB for the site.",
   "howItWorks": "Sweep input files sit next to each notebook under Desktop/Animals/<date>/. Claude Code/sweep-monitor (sweep_monitor.py, port 8150) queues ntopcl jobs and shows progress. tools/convert_*.py (one per sweep family, e.g. convert_1022_sweeps.py, convert_attachment_1023.py) decimate to 150K faces, apply the matte grey material, export with normals and Draco-compress into sample-models/<new folder>/, then they go to R2.",
   "notes": [
    "Never convert while nTop is still exporting; converters skip files written in the last 90 s.",
    "If a notebook's imported meshes moved, ntopcl exits in seconds and exports nothing; the monitor flags very short jobs as failed.",
    "Known notebook quirks: some inputs have trailing spaces ('Tolerance '), some export names round to 3 significant figures or put values in the wrong slot; read the memory notes per notebook.",
    "Two parallel ntopcl processes give only about 1.3x on this laptop.",
    "The September Chihuahua sweep runner (automation/chihuahua_sweeps.py) is paused and superseded; do not restart it.",
    "automation/parametric_attachment.py (paused, Python) generates families of attachment surfaces from hand-painted ones; its outputs fed the Ollie reach x leg-hole and Chihuahua over-the-back sweeps. The browser Surface Interpolator is the one-axis version."
   ],
   "next": [
    "Ask Tyler to give blend notebooks a Path input so exports do not overwrite each other.",
    "5 screw-attachment cases (A10 G5 HD8 HH5) fail repeatably with an nTop memory error; do not re-queue them blindly."
   ],
   "owner_actions": [
    "nTop with an Automate licence is needed to run ntopcl (on Tyler's PC)"
   ]
  },
  {
   "id": "site-infrastructure",
   "area": "Site infrastructure",
   "name": "Menu, footer and page metadata generator",
   "pages": [],
   "status": "live-with-local-changes",
   "health": "good",
   "progress": 90,
   "lastLive": "502f1f8 2026-10-24 (menu reorganisation)",
   "summary": "The site has no build step, so the side menu, footer credits, page metadata, Previous/Next links and 'related pages' blocks are written into every page by one script.",
   "howItWorks": "tools/site_infra.py: NAV_GROUPS (menu), META (head metadata), READING_ORDER (prev/next), RELATED, HUMAN_REGIONS (anatomy region bar). It rewrites the marked regions in every page and is safe to re-run. tools/check_links.py reports missing files and dead links.",
   "notes": [
    "A new page must be added to NAV_GROUPS and META or the script skips it; Tools pages have their own layout and no META.",
    "The footer carries the Creative Commons credit for the reference meshes; keep it.",
    "Local site_infra.py adds 'My Presentations' to the Tools menu, so most local pages differ from live by that one line.",
    "To publish only a menu change, run site_infra.py on a fresh clone of the live site and check only menu lines changed.",
    "tools/dev_pages.py writes dev-pages.js, the page list on this hub; re-run it after adding or removing a page."
   ],
   "next": [
    "Fix tools/new_patient.py, which still targets the removed 'Our Patients' group."
   ],
   "owner_actions": []
  },
  {
   "id": "r2-model-hosting",
   "area": "Site infrastructure",
   "name": "Model hosting on Cloudflare R2",
   "pages": [],
   "status": "live",
   "health": "good",
   "progress": 90,
   "lastLive": "3ed3e7b 2026-10-15 (switched on)",
   "summary": "GitHub Pages allows about 1 GB per site, so the thousands of sweep models live in a free Cloudflare R2 bucket and pages load them from there, falling back to the site copy.",
   "howItWorks": "model-base.js holds MODEL_BASE (the bucket's public URL) and REMOTE_RULES (which paths live on R2: sample-models/**, ollie-attach-*, ollie-v3-*, ollie-paw-shape-*, ntop-chi-*, chi-top-*); withModelFallback / modelUrl wrap the loaders. tools/r2_upload.py (same rules) uploads, verifies and reports usage; tools/r2_cleanup.py removes old sets.",
   "notes": [
    "Bucket files are cached for a year, so new versions of a sweep go in a new folder name rather than overwriting.",
    "Upload before publishing pages that need the files; delete old sets only after the live pages stop using them (this went wrong once on 2026-10-23).",
    "CORS allows giveapaw.github.io and localhost:8765 / 8131; other local ports fall back to site copies.",
    "Bucket was 2.04 GB of the 10 GB free allowance after 2026-10-23; the uploader refuses to go past 9 GB."
   ],
   "next": [
    "Optional: remove the sweep GLBs from the GitHub repo (needs a careful history clean-up to actually shrink it)."
   ],
   "owner_actions": [
    "R2 API keys live only in Tyler's Windows environment variables; a successor needs their own token from the Cloudflare account owner"
   ]
  },
  {
   "id": "firebase-backend",
   "area": "Site infrastructure",
   "name": "Firebase (Realtime Database + sign-in)",
   "pages": [
    "design-review.html",
    "design-log.html"
   ],
   "status": "live",
   "health": "blocked",
   "progress": 85,
   "lastLive": "rules last published by Tyler 2026-10-20; the 2026-10-28 design-log rules are not yet confirmed published",
   "summary": "One free Firebase project stores everything that changes on the static site: live review sessions, anatomy labelling, the team design log and case-study updates.",
   "howItWorks": "firebase-config.js has the public web config. Database sections: sessions/<code> (live reviews, anonymous sign-in, 12 h expiry), anatomy/{pages,backups,editors}, designlog/{team,logs}, cases/{pages,admins,editors,people,team}. Access rules are in database.rules.json in the local folder (not in the live repo) and are pasted into the console by hand.",
   "notes": [
    "Before replacing the rules, check the console's current top-level sections match the file, or data access for a feature may be dropped.",
    "Never 'Import JSON' at the database root.",
    "The Firebase apiKey is a public identifier; the rules are what protect the data."
   ],
   "next": [
    "Tyler to publish the latest database.rules.json: the 2026-10-28 design log rules and the devboard rules this hub needs (see DEV-BOARD-SETUP.md)."
   ],
   "owner_actions": [
    "Publish rules in the Firebase console",
    "Maintain anatomy/editors, designlog/team, cases/admins by hand"
   ]
  },
  {
   "id": "google-oauth-drive",
   "area": "Site infrastructure",
   "name": "Google sign-in, Drive API and the club Drive",
   "pages": [
    "review-builder.html",
    "my-presentations.html"
   ],
   "status": "live",
   "health": "needs-work",
   "progress": 80,
   "lastLive": "5c70ba4 2026-10-19 (drive-config.js filled in)",
   "summary": "Uploads and presentations are stored in Google Drive instead of paid hosting. The club account owns the 'Give a Paw' Drive folder with one folder per animal.",
   "howItWorks": "drive-config.js holds the restricted browser API key and OAuth client id (public identifiers) for the Google Cloud project behind Firebase. drive-store.js / google-session.js use the drive.file scope (the site only sees files it created or the user picked). Club Drive: Give a Paw / Animals Spring 2026 / <Animal (Owner)> / Scans, Photos and videos, Design files, Print files, Documents, Website uploads.",
   "notes": [
    "Animals Spring 2026 is shared 'anyone with the link' (Tyler, 2026-10-19); Admin stays private.",
    "Per-animal Documents folders and folder names contain owner names; never link them from the site. Moving intake docs into Admin was suggested.",
    "Uploads count against whoever uploads (club account 200 GB or a teammate's own Drive)."
   ],
   "next": [
    "Confirm the OAuth consent screen is 'In production' so people outside the test list can sign in."
   ],
   "owner_actions": [
    "Google Cloud console: consent screen, authorized origins, API key restrictions",
    "Drive sharing settings (only the club account can change them)"
   ]
  },
  {
   "id": "info-pages",
   "area": "Public site",
   "name": "Build guide and info pages",
   "pages": [
    "3d-scanning.html",
    "materials.html",
    "3d-printing.html",
    "meet-the-team.html",
    "credits.html",
    "full-limb.html",
    "wheel-chair.html"
   ],
   "status": "live",
   "health": "needs-work",
   "progress": 60,
   "lastLive": "unknown (no specific entry in the notes)",
   "summary": "Plain content pages: how the club scans, which materials and printers it uses, the team, and credits. Full Limb and Wheel Chair are earlier projects, live but out of the menu.",
   "howItWorks": "Static HTML with the shared style.css/script.js; menu, footer and metadata come from tools/site_infra.py.",
   "notes": [
    "A 2026-10-06 site review found placeholder content on several live pages and left 18 proposed patches plus a decision page in the give-a-paw-site-review-2026-10 folder on Tyler's PC for Tyler; whether he acted on them is not recorded.",
    "credits.html holds licence credits that must stay."
   ],
   "next": [
    "Check which of the 2026-10-06 review patches are still relevant (unknown)."
   ],
   "owner_actions": []
  },
  {
   "id": "prototype-pages",
   "area": "Prototypes and test pages",
   "name": "Design prototypes and test pages (local)",
   "pages": [
    "case-history-options.html",
    "iteration-a.html",
    "iteration-b.html",
    "iteration-c.html",
    "iteration-options.html",
    "mesh-check-a.html",
    "mesh-check-b.html",
    "mesh-check-c.html",
    "walkthrough-guide-options.html",
    "import-browser-samples.html",
    "demo-update-view.html"
   ],
   "status": "retired",
   "health": "good",
   "progress": 100,
   "lastLive": null,
   "summary": "Side-by-side design options Tyler chose between, plus local test pages. Each choice has been built into the real page; these remain for reference.",
   "howItWorks": "Standalone local pages; some share code with the real pages (e.g. mesh-check-core.js), so check before deleting shared files.",
   "notes": [
    "demo-update-view.html copies a real update into demo storage: never publish it.",
    "Safe to delete once nobody needs the comparisons."
   ],
   "next": [],
   "owner_actions": []
  }
 ],
 "accounts": [
  {
   "name": "GitHub: live site repo",
   "what": "GitHub Pages repo that IS the public site (branch main deploys automatically to https://giveapaw.github.io). A successor needs write access from the GiveaPaw organisation owner.",
   "url": "https://github.com/GiveaPaw/giveapaw.github.io",
   "icon": "github",
   "owner": null
  },
  {
   "name": "GitHub: old local origin (do not push)",
   "what": "The local folder's git origin points to a different, older repo. Publishing always targets GiveaPaw explicitly.",
   "url": null,
   "icon": "git-branch",
   "owner": "areebairizvi/give-a-paw"
  },
  {
   "name": "Firebase project give-a-paw",
   "what": "Realtime Database (US) for live review sessions, anatomy labelling, the design log and case-study updates; Anonymous + Google sign-in; giveapaw.github.io and localhost are authorized domains. Web config in firebase-config.js; access rules in database.rules.json (local file, pasted into the console).",
   "url": "https://console.firebase.google.com/project/give-a-paw",
   "icon": "flame",
   "owner": null
  },
  {
   "name": "Google Cloud project behind Firebase (give-a-paw)",
   "what": "Google Drive API + Picker API, the restricted browser API key and the OAuth web client used for Google sign-in and Drive uploads (both referenced in drive-config.js), and the OAuth consent screen (must be 'In production' for people outside the test list).",
   "url": "https://console.cloud.google.com/apis/credentials?project=give-a-paw",
   "icon": "cloud-cog",
   "owner": null
  },
  {
   "name": "Cloudflare R2 bucket giveapaw-models",
   "what": "Free 10 GB bucket serving the sweep GLBs. Public URL is MODEL_BASE in model-base.js; CORS policy in tools/r2-cors.json. Upload keys are kept only as Windows environment variables (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL) on the uploader's PC, never in files.",
   "url": "https://dash.cloudflare.com/",
   "icon": "hard-drive",
   "owner": "Account owner: Tyler (ask for your own upload token)"
  },
  {
   "name": "Club Google Drive folder 'Give a Paw'",
   "what": "The club's Google account owns the Give a Paw Drive folder (200 GB): Animals Spring 2026/<Animal>/ with Scans, Photos and videos, Design files, Print files, Documents, Website uploads; also Animals Fall 2026, Admin (private), Resources, Website and media. It is also the permanent owner of Firebase, Cloudflare and the GitHub organisation (through the club's GitHub account). It has no 2-step verification, so its password lives only in the club password manager. Ask a club officer for access.",
   "url": null,
   "icon": "folder",
   "owner": null
  },
  {
   "name": "'Give a Paw Reviews' folders",
   "what": "Each Review Builder user's own Drive folder where their presentations are saved (files tagged gapReview=1). Not a shared folder.",
   "url": null,
   "icon": "folders",
   "owner": "Each user's own Google Drive"
  },
  {
   "name": "Firebase access lists",
   "what": "Hand-kept lists in the database: anatomy/editors/<uid> (anatomy labelling), designlog/team/<uid> (design log), cases/admins/<email key> (case updates; Tyler's 3 Google accounts). Editors for case updates are added on the site by an admin.",
   "url": null,
   "icon": "list-checks",
   "owner": "Firebase console -> Realtime Database -> Data"
  },
  {
   "name": "nTop with Automate licence",
   "what": "Needed to run ntopcl sweeps. Installed on Tyler's PC at C:/Program Files/nTopology/nTopology/ntopcl.exe.",
   "url": null,
   "icon": "box",
   "owner": "nTop desktop app (licence holder: not recorded)"
  }
 ],
 "howTo": [
  {
   "task": "Get the full working folder",
   "icon": "folder-down",
   "steps": [
    "The GitHub repository has every page, but not all of the helper scripts (for example tools/r2_upload.py, the sweep converters, the Sweep Monitor) or the source meshes.",
    "Ask Tyler for a copy of his give-a-paw working folder (it is in his OneDrive), or clone https://github.com/GiveaPaw/giveapaw.github.io for the pages only.",
    "The handoff log DEVELOPMENT-HANDOFF.md and the *-SETUP.md files in that folder explain each feature in more detail than this page."
   ]
  },
  {
   "task": "Publish a change to the live site",
   "steps": [
    "Get Tyler's (or the current owner's) OK first; nothing goes live without it.",
    "Copy one of the Claude Code/publish-*.ps1 scripts (e.g. publish-design-log.ps1) and set its $files list to exactly the files you changed.",
    "Run it in PowerShell: it makes a fresh sparse clone of GiveaPaw/giveapaw.github.io, copies those files (text converted to LF, GLB/images copied byte for byte), refuses deletions or unexpected files, commits and pushes.",
    "Wait for GitHub Pages to build, hard-refresh the live page and check it (Pages can serve old HTML for about 10 minutes)."
   ],
   "icon": "rocket"
  },
  {
   "task": "Run the site locally (pages, editor, judges, answer keys)",
   "steps": [
    "From the give-a-paw folder: python tools/range_server.py 8131 (supports video seeking and the editor's save endpoints).",
    "Use port 8765 instead when you need models from the R2 bucket (its CORS allows 8765 and 8131).",
    "Answer key editor: double-click 'Open answer key editor.cmd' (server on 8765, opens the page).",
    "Start the server as its own window/process; a server tied to a preview pane dies when the pane closes."
   ],
   "icon": "server"
  },
  {
   "task": "Add a new patient page",
   "steps": [
    "First fix tools/new_patient.py: it still looks for an 'Our Patients' menu group; point it at 'Fall 2026 Patients' in tools/site_infra.py.",
    "Run python tools/new_patient.py \"Name\" [--card] to create <slug>-case-study.html from tools/patient-template.html and regenerate the menu.",
    "Add photos and models as they arrive; missing pieces show 'coming soon' notes.",
    "Optionally add the animal to tools/design_log_manifest.py and re-run it for the design log / design history."
   ],
   "icon": "user-plus"
  },
  {
   "task": "Change the menu, footer or page metadata",
   "steps": [
    "Edit NAV_GROUPS, META, READING_ORDER or RELATED in tools/site_infra.py (never the page HTML regions).",
    "Run python tools/site_infra.py, then python tools/check_links.py.",
    "To publish only the menu, run the script on a fresh clone of the live site (publish-tools-menu.ps1 pattern) and check only menu lines changed."
   ],
   "icon": "menu"
  },
  {
   "task": "Upload sweep models to R2",
   "steps": [
    "Convert first (see 'Convert an nTop sweep'), into a NEW folder name under sample-models/ (bucket files are cached for a year).",
    "Double-click 'Upload models to R2.cmd' (asks for R2 keys once, then uploads, verifies and shows usage), or run python tools/r2_upload.py --list, then without flags, then --verify.",
    "Publish the pages that use the new files only after the upload finishes.",
    "Remove old sets with 'Remove old sweeps from R2.cmd' (tools/r2_cleanup.py, type DELETE) only after the live pages no longer load them."
   ],
   "icon": "cloud-upload"
  },
  {
   "task": "Convert an nTop sweep to website GLBs",
   "steps": [
    "Make sure nTop has completely finished exporting.",
    "Run the matching converter, e.g. python tools/convert_1022_sweeps.py --jobs 4 (it skips files already converted).",
    "The pipeline: drop specks, decimate to 150K faces, matte grey, normals, Draco via the gltf-transform toolchain in %LOCALAPPDATA%\\gltf-tools.",
    "Keep millimetres and the scan frame; never re-centre models that must line up with the scan."
   ],
   "icon": "boxes"
  },
  {
   "task": "Convert or check a single mesh",
   "steps": [
    "Open convert.html for a web GLB (plain for PowerPoint, Draco for the site).",
    "Open mesh-check.html to find and fix holes, flipped faces and self-intersections before nTop."
   ],
   "icon": "file-box"
  },
  {
   "task": "Run an nTop sweep",
   "steps": [
    "Plan the input file with sweep-studio.html (local) or the ntopcl-sweeps skill; get the template with ntopcl -t.",
    "Check the notebook's imported meshes still exist at their saved paths (otherwise ntopcl exports nothing).",
    "Queue it in the Sweep Monitor (Claude Code/sweep-monitor, 'Open Sweep Monitor.cmd', http://127.0.0.1:8150); run a 2-case test first.",
    "Count the output files against the expected number before converting."
   ],
   "icon": "repeat"
  },
  {
   "task": "Bump cache numbers after editing",
   "steps": [
    "Every page imports its JS/CSS with ?v=<n>; increase n wherever you changed that file (including imports inside other JS files).",
    "Without this, browsers and the preview keep showing the old file."
   ],
   "icon": "refresh-cw"
  },
  {
   "task": "Publish Firebase database rules",
   "steps": [
    "Firebase console -> Realtime Database -> Rules.",
    "The file database.rules.json is in the working folder, not in the GitHub repository.",
    "Check the current top-level sections match those in database.rules.json (sessions, anatomy, designlog, cases).",
    "Replace everything with database.rules.json and press Publish.",
    "Do this BEFORE pushing pages that need the new rules."
   ],
   "icon": "shield-check"
  },
  {
   "task": "Give a teammate access",
   "steps": [
    "Design log / anatomy editor: they sign in on the page, copy the account ID it shows, and the owner adds designlog/team/<id> = true or anatomy/editors/<id> = true in the console (use +, never Import JSON).",
    "Case updates: an admin opens any case study, Team sign in -> Editors, and adds their email and animals.",
    "Review Builder / My Presentations: works for any Google account once the consent screen is In production."
   ],
   "icon": "users"
  },
  {
   "task": "Present a design review live",
   "steps": [
    "Open design-review.html?review=reviews/ollie-fit-review.json&host.",
    "Press Live session -> Start a session, then Copy invite link and send it to the meeting only.",
    "Afterwards bring your notes into the file with the presentation editor (Presenter notes) and save judges' answers on judges.html (local)."
   ],
   "icon": "presentation"
  },
  {
   "task": "Copy anatomy labelling into the site files",
   "steps": [
    "python tools/anatomy/pull_cloud.py --dry-run to see what changed.",
    "python tools/anatomy/pull_cloud.py to rewrite the quiz-data-*.js files, then publish them."
   ],
   "icon": "pencil-ruler"
  },
  {
   "task": "Run tests",
   "steps": [
    "Mesh check: python tools/make_mesh_check_tests.py, then open mesh-check.html?src=tmp-meshcheck/<file> and compare with the expected results in the script's docstring.",
    "nTop blocks page: serve on port 8790, then python tools/ntop/test_ntop_blocks_page.py and audit_ntop_blocks_page.py.",
    "Most other test suites (test_*.py, Playwright) were written in Claude session scratch folders and are NOT in the repo; they would need to be recovered or rewritten."
   ],
   "icon": "flask-conical"
  }
 ],
 "rules": [
  "The club Google account is the permanent owner of every service (GitHub organisation, Firebase, Cloudflare, Drive), and at least one current officer is a second owner with their own account and 2-step verification. Never leave the club account as the only owner, keep its password only in the club password manager, and point its recovery phone and email at current officers.",
  "Publish only to GiveaPaw/giveapaw.github.io (main), never to the local origin (areebairizvi/give-a-paw), and only with the owner's explicit OK.",
  "Publish an explicit list of files from a fresh clone of the live site; never push the whole local folder (it holds other unpublished work, private data and big source files).",
  "Copy GLB, image and video files byte for byte; a text round trip corrupted live GLBs once.",
  "Never hand-edit the menu, footer credits, page metadata, prev/next or related-pages regions; change tools/site_infra.py and re-run it.",
  "Keep the footer's Creative Commons credit and credits.html: they are licence requirements.",
  "judges/ is private research data and judges.html, answer-key-editor.html, grading-editor.html, sweep-studio.html and the prototype pages stay local. Never publish demo-update-view.html.",
  "Publish Firebase rules before the pages that depend on them; never use Import JSON on the database root.",
  "Upload models to R2 before publishing pages that use them; delete old sets only after nothing live loads them. Use new folder names for changed sweeps.",
  "No secrets in any file: R2 keys stay in environment variables. drive-config.js and firebase-config.js hold only public, restricted identifiers.",
  "Never link or share an animal's root Drive folder, its Documents folder, or Admin: they contain owner names and records.",
  "Socket and lattice geometry must come from nTop exports, never from browser-made substitutes. Keep exports in millimetres and their scan frame.",
  "Never rename a review screen id or a quiz item name once people use them: notes and links are keyed on them.",
  "Bump the ?v= cache number of every JS/CSS file you change.",
  "Do not start nTop sweeps without the owner asking; the old September Chihuahua runner stays paused.",
  "On this PC use C:/Program Files/Git/cmd/git.exe (the PowerShell git is a broken stub), and compare files ignoring line endings (the local copy is CRLF, the repo LF).",
  "In script.js initBlock texts, avoid straight apostrophes; they break the whole file.",
  "After writing new files in the give-a-paw folder, check they still exist (files were silently reverted once, probably by OneDrive)."
 ],
 "ownerChecklist": [
  {
   "id": "club-account",
   "title": "Secure the club Google account (the permanent owner)",
   "icon": "key-round",
   "time": "20 min",
   "why": "The club account will own the Drive folder, Firebase and Cloudflare for good. It is shared and has no 2-step verification, so its password, recovery details and who knows them are what protect the whole site.",
   "steps": [
    "Make a shared password manager for the club, so the password never sits in a document or chat. Bitwarden has a free plan for two people (https://bitwarden.com); 1Password and others work too.",
    "Sign in to the club account, open https://myaccount.google.com/security and change the password to a long random one generated by the password manager. Save it there.",
    "Set the **recovery phone** and **recovery email** to current officers (not you, not someone graduating). Google sends its “is this you?” checks there, so whoever holds them can get the club back in.",
    "Try 2-step verification once more at https://myaccount.google.com/signinoptions/twosv. It does not have to be a phone: a **security key**, a **passkey**, or an **authenticator app** whose setup key is stored in the password manager all work. If one of these goes through, also save the backup codes in the password manager.",
    "Check https://myaccount.google.com/device-activity and sign out any device nobody recognises.",
    "In Google Drive, open the **Give a Paw** folder → **Share** and check the owner is the club account.",
    "Write in the **Who has it now** box who can open the password manager and whose phone and email are the recovery details."
   ],
   "doneWhen": "Two officers can open the password manager and sign in to the club account without you, and the recovery phone and email are theirs."
  },
  {
   "id": "github-owner",
   "title": "Make the club account and a current officer owners of the GiveaPaw GitHub organisation",
   "icon": "github",
   "time": "15 min",
   "why": "Every service gets **two owners**: the **club Google account** (permanent, outlives any student) and **one current officer with their own account** (a named person, with 2-step verification). Never make the club account the only owner: it is shared and has no 2-step verification, so it is the easiest account to lose or break into. GitHub only accepts GitHub accounts as owners, not email addresses, so the club needs its own GitHub account.",
   "steps": [
    "If the club has no GitHub account yet, sign up at https://github.com/signup with the club Google account's email and a password from the password manager.",
    "GitHub will ask the club account to turn on 2-step verification. Choose an **authenticator app**: save the setup key and the recovery codes in the club password manager, so any officer can produce the code. No phone is needed.",
    "Ask your successor for their own GitHub username.",
    "Open https://github.com/orgs/GiveaPaw/people → **Invite member**, invite the club GitHub account and your successor, both with the role **Owner**.",
    "Accept the club account's invitation (sign in as the club on GitHub, or open the email in the club inbox); your successor accepts theirs.",
    "On the People page, check both show **Owner**."
   ],
   "doneWhen": "The club GitHub account and one current officer are both listed as Owner."
  },
  {
   "id": "firebase-owner",
   "title": "Add the club account and a current officer as Firebase Owners",
   "icon": "flame",
   "time": "5 min",
   "why": "Firebase holds the live sessions, the design log, case-study updates, anatomy labelling and this board. Only Owners can publish database rules, and Firebase support only talks to Owners. The same role covers the Google Cloud side (Google sign-in, the Drive picker, API keys). Every service gets **two owners**: the **club Google account** (permanent, outlives any student) and **one current officer with their own account** (a named person, with 2-step verification). Never make the club account the only owner: it is shared and has no 2-step verification, so it is the easiest account to lose or break into.",
   "steps": [
    "Open https://console.firebase.google.com/project/give-a-paw/settings/iam (Project settings → Users and permissions).",
    "Press **Add member**, enter the club Google account's email, choose **Owner**, and press **Add member**. Do the same with your successor's own Google email.",
    "Accept both invitations (the club one from the club inbox).",
    "Ask your successor to open **Realtime Database → Rules** to confirm they can see it."
   ],
   "doneWhen": "The club account and your successor are both Owners, and your successor can open Realtime Database → Rules."
  },
  {
   "id": "oauth-production",
   "title": "Set Google sign-in to “In production”",
   "icon": "shield-check",
   "time": "5 min",
   "why": "While the app is in “Testing”, only the test users you listed can sign in to the Review Builder and My Presentations, and sign-ins expire after 7 days.",
   "steps": [
    "Open https://console.cloud.google.com/auth/audience?project=give-a-paw (Google Auth Platform → Audience). On the older console it is APIs & Services → OAuth consent screen.",
    "If **Publishing status** says **Testing**, press **Publish app** and confirm. The site only asks for the `drive.file` permission, so Google does not need to review it.",
    "Open https://console.cloud.google.com/auth/clients?project=give-a-paw, open the web client, and check **Authorized JavaScript origins** lists `https://giveapaw.github.io`, `http://localhost:8131` and `http://localhost:8765`.",
    "Ask someone who was never a test user to sign in on https://giveapaw.github.io/review-builder.html."
   ],
   "doneWhen": "Someone outside the test list can sign in to the Review Builder."
  },
  {
   "id": "cloudflare",
   "title": "Give the club account and your successor the 3D model bucket (Cloudflare R2)",
   "icon": "boxes",
   "time": "10 min",
   "why": "Every slider model on the site comes from the giveapaw-models bucket. The upload keys exist only on your computer, so nobody else can add or remove models. Every service gets **two owners**: the **club Google account** (permanent, outlives any student) and **one current officer with their own account** (a named person, with 2-step verification). Never make the club account the only owner: it is shared and has no 2-step verification, so it is the easiest account to lose or break into.",
   "steps": [
    "Sign in at https://dash.cloudflare.com and choose the account that owns the bucket.",
    "Go to **Manage account → Members** and invite the club Google account's email as **Super Administrator** (the permanent owner), then your successor as **Administrator**.",
    "Accept the club account's invitation from the club inbox, and add its Cloudflare password to the club password manager.",
    "Your successor opens **R2 Object Storage → Manage API tokens → Create API token**, with **Object Read & Write** on `giveapaw-models` only, saves it as environment variables on their own computer as `R2-SETUP.md` describes, and runs `python tools/r2_upload.py --list` to test it.",
    "Then delete your own token under the same Manage API tokens page."
   ],
   "doneWhen": "The club account and your successor are members, they can list the bucket with their own token, and yours is deleted."
  },
  {
   "id": "yearly-routine",
   "title": "Set up the yearly handoff routine for the club account",
   "icon": "repeat",
   "time": "10 min",
   "why": "A shared password that passes between students every year eventually leaks, and recovery details pointing at graduates lock the club out. A short routine each spring keeps the club account safe.",
   "steps": [
    "On the board, add a task “Yearly handoff: club account and owners” in the Handoff lane, assigned to next year's web lead, due next April.",
    "Put these steps in its details: change the club account password (generate it in the password manager); set the recovery phone and email to the new officers; add the new officers as owners on GitHub, Firebase and Cloudflare with their own accounts; remove graduating officers from those and from the password manager; re-read the owner checklist.",
    "Tell your successor about the task in person."
   ],
   "doneWhen": "The routine is a task on the board, assigned and dated for next spring."
  },
  {
   "id": "working-folder",
   "title": "Put the working folder in a club-owned private repository",
   "icon": "folder-git-2",
   "time": "15 min",
   "why": "The public repository has the pages, but not the database rules, the model upload and conversion scripts, the publish scripts, the tests, or the notes. Today they exist only in your OneDrive.",
   "steps": [
    "In PowerShell, run `& \"C:\\Users\\mrchi\\OneDrive\\Documents\\Claude Code\\make-workshop-repo.ps1\"`. It only lists what it would copy, the total size and a secret scan, and copies nothing.",
    "Read the list. If it looks right, run it again with `-Create`. It makes the private repository GiveaPaw/giveapaw-workshop and pushes the files.",
    "Open https://github.com/GiveaPaw/giveapaw-workshop and check it says **Private**.",
    "Tell your successor to clone it next to the public repository. Its README explains how the two fit together."
   ],
   "doneWhen": "giveapaw-workshop exists on GitHub, private, with the tools/ folder in it."
  },
  {
   "id": "team-lists",
   "title": "Add your successor to the team lists",
   "icon": "users",
   "time": "5 min",
   "why": "The board, the design log, case-study updates and the anatomy editor each check a list in the database before letting someone edit. Add **people**, each with their own Google account, so the board shows who did what. Don't add the club account here: its edits would all read “club”.",
   "steps": [
    "They open https://giveapaw.github.io/dev.html, press **Sign in to edit**, then **Copy account ID** under Team access, and send you the ID.",
    "In https://console.firebase.google.com/project/give-a-paw/database, open **Data**. Next to `designlog` → `team`, press **+**, paste the ID as the key and type `true` as the value. Never use **Import JSON** on the top level.",
    "If they will label anatomy, add the same ID under `anatomy` → `editors`.",
    "For case-study updates, add their email under `cases` → `admins`: lowercase, with every `.` replaced by `,` (`jane,doe@berkeley,edu`), value `true`.",
    "They reload dev.html: Team access should say **on the team list**."
   ],
   "doneWhen": "Your successor sees “on the team list” on this page."
  },
  {
   "id": "ntop-licence",
   "title": "Write down how the club gets nTop",
   "icon": "cpu",
   "time": "10 min",
   "why": "The socket sweeps need nTop with an Automate licence. Nobody has recorded whose licence it is or how the next team gets one.",
   "steps": [
    "In nTop, open your account or licence page and note whose licence it is and when it ends.",
    "If it's tied to your personal or class account, ask nTop (through ntop.com's education / academic programme) how the club can get its own seats, ideally registered to the club Google account so the licence outlives any student.",
    "Write the answer in the **Who has it now** box on this item."
   ],
   "doneWhen": "The licence holder and how to renew it are written here."
  },
  {
   "id": "unpublished-work",
   "title": "Decide what happens to unpublished work",
   "icon": "upload-cloud",
   "time": "20 min",
   "why": "Several finished features exist only on your computer. If they're not published or written down, they'll be lost or redone.",
   "steps": [
    "Filter the board by **Live, update waiting** and **Not published**.",
    "For each card, either publish it (most have a ready `publish-*.ps1` script; ask Claude to run it), or press **Update**, set it to **Paused** and say why in the note.",
    "Known ones: Review Builder v3 with My Presentations (publish-review-builder.ps1), this hub (publish-dev-hub.ps1), the nTop Socket Creation FAQ, and 3D models in the presentation editor's gallery."
   ],
   "doneWhen": "No card says “Live, update waiting” or “Not published” without a note."
  },
  {
   "id": "board-review",
   "title": "Read the board once and write the handoff note yourself",
   "icon": "pencil-line",
   "time": "30 min",
   "why": "The cards were written from the project logs. You know where they're wrong, what matters most, and who the next team should talk to.",
   "steps": [
    "Sign in, open each area, and press **Update** on any card whose status, health or next steps are wrong.",
    "Edit the **Handoff note** at the top: who to contact (Bionic Pets, the shelters, faculty), what you would do next, and what to leave alone.",
    "Tick this item."
   ],
   "doneWhen": "The handoff note is signed by you."
  },
  {
   "id": "remove-own-access",
   "title": "After the handoff, remove your personal access",
   "icon": "log-out",
   "time": "10 min",
   "why": "Personal tokens and admin rights left behind are a security risk and confuse who is in charge. Do this last.",
   "steps": [
    "Delete your personal R2 API token in Cloudflare (if not done in the Cloudflare step).",
    "Remove your personal emails from `cases` → `admins` in the Firebase database, unless you still help out.",
    "Step down from owner to member on GitHub, Firebase and Cloudflare, but only once the club account **and** a current officer are owners on each.",
    "Sign out of the club Google account on your own devices, and make sure your phone and email are no longer its recovery details."
   ],
   "doneWhen": "The site runs for a week without needing your accounts."
  }
 ]
};
