// Content for the design review page. Edit this file to change what a reviewer sees.
// Every item needs a unique, stable `id`: the reviewer's notes, pins, and picks are stored against it.
//
// kinds:
//   video    { src, poster?, question }
//   sweep    { param, unit, values[], file(value) -> path, question }   one slider, one model per value
//   assembly { layers: [{ key, label, file, color, opacity }], question } several co-registered meshes
//
// Model files must share one frame (millimetres from the same nTop export) to overlay correctly.
// Sweep filenames must be predictable so `file(value)` can build them (zero-padded, like the rest of the site).

const pad = (value, width) => String(value).padStart(width, '0');

export const review = {
    id: 'bionic-pets-2026-10',
    title: 'Socket design review',
    subtitle: 'Give a Paw × Bionic Pets',
    intro: 'We build canine prosthetic sockets with nTop from 3D scans. We would like your read on a few open questions. Scroll, play, scrub, and mark up anything you notice. Your notes save in this browser as you go; use "Copy link" at the top to send them back to us.',
    reviewerDefault: 'Derrick Campana',
    // Set this to receive a "Send by email" button that opens a message containing the share link.
    returnEmail: '',
    items: [
        {
            id: 'lattice-density',
            kind: 'sweep',
            title: 'Socket lattice density',
            param: 'Attachment point count',
            unit: 'points',
            values: [10, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300, 320, 340, 360, 380, 400],
            // Scan-frame exports (Step 2b set), so the Chihuahua body overlays correctly.
            file: value => `ntop-chi-pointcount-scan-${pad(value, 3)}.glb`,
            defaultValue: 120,
            animal: { file: 'chihuahua-solid.glb', label: 'Solid animal', color: '#496b94', opacity: 0.35, visible: true },
            context: 'Chihuahua hind-limb socket. The lattice is generated from a set of attachment points on the scan; more points means a denser, stiffer lattice.',
            question: 'Scrub the density. Tag each one you stop on as too open, about right, or too dense, then star the one you would print first.',
        },
        {
            id: 'wall-thickness',
            kind: 'sweep',
            title: 'Socket wall thickness',
            param: 'Wall thickness',
            unit: 'mm',
            values: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
            file: value => `ntop-chi-wallthick-scan-${pad(value, 3)}.glb`,
            defaultValue: 6,
            animal: { file: 'chihuahua-solid.glb', label: 'Solid animal', color: '#496b94', opacity: 0.35, visible: true },
            context: 'Same Chihuahua socket with the solid wall thickened from 0 mm to 20 mm.',
            question: 'Where does the wall start to look strong enough for a dog this size, and where does it become too bulky against the skin?',
        },
        {
            id: 'ollie-assembly',
            kind: 'assembly',
            title: 'Ollie: socket on the scan',
            layers: [
                { key: 'animal', label: 'Solid animal', file: 'ollie-solid-animal.glb', color: '#496b94', opacity: 0.38 },
                { key: 'socket', label: 'Socket', file: 'ollie-socket.glb', color: '#b9c2cc', opacity: 1 },
                { key: 'attach', label: 'Attachment surface', file: 'ollie-attachment-surface.glb', color: '#169c8c', opacity: 0.9, visible: false },
            ],
            context: 'Ollie is a partial forelimb amputee. The socket was generated over the attachment surface we painted on the scan. Use the section cut to look inside and the ruler to check clearances.',
            question: 'Drop pins where you would expect pressure points or rubbing, and where you would move the trim line.',
        },
        {
            id: 'paw-cellsize',
            kind: 'sweep',
            title: 'Paw lattice cell size',
            param: 'Cell size',
            unit: 'mm',
            values: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            file: value => `ntop-paw-cellsize-${pad(value, 2)}.glb`,
            defaultValue: 10,
            context: 'The printed paw is a lattice so it can flex. Smaller cells are stiffer and heavier; larger cells flex more but wear faster.',
            question: 'Which cell size would you trust for traction and durability on a medium dog?',
        },
        {
            id: 'yana-video-1',
            kind: 'video',
            title: 'Yana: fitting video 1',
            src: 'yana-video-1.mp4',
            context: 'First walk in the printed prosthetic.',
            question: 'Pause and mark anything in the gait that tells you the fit or alignment is off.',
        },
        {
            id: 'yana-video-2',
            kind: 'video',
            title: 'Yana: fitting video 2',
            src: 'yana-video-2.mp4',
            context: 'Second session after adjustments.',
            question: 'Does this look better or worse than the first video? Mark the moments that convince you.',
        },
        {
            id: 'max-video',
            kind: 'video',
            title: 'Max: prosthetic in use',
            src: 'max-video.mp4',
            context: 'Max with the clip adapter and foot.',
            question: 'What would you change about the foot or the adapter?',
        },
    ],
};
