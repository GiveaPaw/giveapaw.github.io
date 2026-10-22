// convert.html: pick a file (drop, choose, ?src=<site path>, or the sample), run the shared converter
// panel, and offer the GLB and a one-screen deck file for download.
import { createConvertPanel, el, icon, icons } from './model-convert-ui.js';
import { deckFor, fileKind, fmtBytes, outputName } from './model-convert.js';

// Sweep Studio runs nTop on this computer, so its link shows only on a local copy of the site.
if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) document.querySelectorAll('[data-local-only]').forEach(n => { n.hidden = false; });

const $ = s => document.querySelector(s);
const SAMPLE = 'ollie-socket.glb';
let panel = null;
let toastTimer = 0;

function toast(message, { error = false, ms = 4000 } = {}) {
    const box = $('#cv-toast');
    box.textContent = message;
    box.classList.toggle('error', error);
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, ms);
}

function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function start(source, name) {
    if (!fileKind(name)) { toast('Choose an STL, OBJ, 3MF or GLB file.', { error: true }); return; }
    panel?.dispose();
    $('#cv-drop').hidden = true;
    $('#cv-work').hidden = false;
    $('#cv-work-title').textContent = name;
    let latest = null;
    const glbBtn = el('button', { type: 'button', class: 'mc-btn mc-gold', disabled: true, title: 'Plain GLB: opens in PowerPoint, Blender and every viewer',
        onclick: () => latest && download(latest.plain, latest.name) }, icon('download'), ' Download GLB');
    const siteBtn = el('button', { type: 'button', class: 'mc-btn', disabled: true, title: 'Draco-compressed GLB, about a tenth of the size: what the website uses. PowerPoint cannot open this one.',
        onclick: () => latest && download(latest.glb, latest.name.replace(/\.glb$/, '-draco.glb')) }, icon('globe'), ' Download for the website');
    const deckBtn = el('button', { type: 'button', class: 'mc-btn', disabled: true, title: 'A one-screen presentation file for design-review.html that shows this model',
        onclick: () => { if (!latest) return; const deck = deckFor(latest.name, name.replace(/\.[^.]+$/, '')); download(new Blob([JSON.stringify(deck, null, 2)], { type: 'application/json' }), `${deck.id}-deck.json`); toast('Deck file downloaded. Keep it next to the GLB; the editor can open it once both are in the site.'); } },
        icon('clipboard-list'), ' Download deck file');
    panel = createConvertPanel($('#cv-panel'), {
        source, name, actions: [glbBtn, siteBtn, deckBtn],
        onResult: result => {
            latest = result;
            glbBtn.disabled = siteBtn.disabled = deckBtn.disabled = !result;
            if (result) {
                glbBtn.replaceChildren(icon('download'), ` Download GLB (${fmtBytes(result.stats.bytesPlain)})`);
                siteBtn.replaceChildren(icon('globe'), ` Download for the website (${fmtBytes(result.stats.bytesOut)})`);
                icons();
            }
        },
    });
    icons();
    window.scrollTo({ top: $('#cv-work').offsetTop - 12, behavior: 'smooth' });
}

function restart() {
    panel?.dispose();
    panel = null;
    $('#cv-work').hidden = true;
    $('#cv-drop').hidden = false;
    $('#cv-file').value = '';
    history.replaceState(null, '', location.pathname);
}

const drop = $('#cv-drop');
const fileInput = $('#cv-file');
$('#cv-choose').addEventListener('click', event => { event.stopPropagation(); fileInput.click(); });
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) start(file, file.name); });
$('#cv-sample').addEventListener('click', event => { event.stopPropagation(); start(SAMPLE, SAMPLE); });
$('#cv-restart').addEventListener('click', restart);
for (const target of [drop, document.body]) {
    target.addEventListener('dragover', event => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); drop.classList.add('over'); } });
    target.addEventListener('dragleave', () => drop.classList.remove('over'));
    target.addEventListener('drop', event => {
        if (!event.dataTransfer?.files?.length) return;
        event.preventDefault();
        drop.classList.remove('over');
        const file = event.dataTransfer.files[0];
        start(file, file.name);
    });
}

// ?src=<same-origin path> opens a file from the site (used for testing and for linking to a model).
const src = new URLSearchParams(location.search).get('src');
if (src && !/^[a-z]+:|^\/\//i.test(src) && fileKind(src)) start(src, src.split('/').pop());
icons();
export { outputName };
