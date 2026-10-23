// mesh-check.html: pick a file (drop, choose, ?src=<site path>, or the sample), run the repair sweep from
// mesh-repair.js, and show the result as one verdict with the download, a few key numbers, and a short list
// of what was found. Clicking a problem explains it and flies the 3D view to it (showing only that problem).
// Text, viewer and downloads live in mesh-check-core.js.
import { el, icon, icons } from './model-convert-ui.js';
import { fileKind, fmtInt, loadMesh } from './model-convert.js';
import { repairMesh } from './mesh-repair.js';
import { CATALOG, STATUS, COLORS, summarize, hasHighlight, createCheckViewer, saveStl, saveObj, reportText, fileFacts } from './mesh-check-core.js?v=1';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const SAMPLE = 'mesh-check-sample.obj';
const VERDICT_ICON = { needs: 'alert-triangle', fixed: 'wrench', clean: 'check-circle-2' };

let viewer = null, current = null, running = false, toastTimer = 0, selected = null;

function toast(message, { error = false, ms = 3500 } = {}) {
    const box = $('#mk-toast');
    box.textContent = message;
    box.classList.toggle('error', error);
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, ms);
}
const options = () => ({
    fillHoles: $('#opt-holes').checked,
    removeDebris: $('#opt-debris').checked,
    mergeShells: $('#opt-union').checked,
    checkIntersections: $('#opt-intersect').value !== 'off',
    intersectionBudgetMs: $('#opt-intersect').value === 'off' ? 0 : +$('#opt-intersect').value * 1000,
});
const actions = {
    stl: () => saveStl(current.result.mesh, current.name),
    obj: () => saveObj(current.result.mesh, current.name),
    copy: async () => { try { await navigator.clipboard.writeText(reportText(current.name, current.result)); toast('Report copied.'); } catch { toast('Could not copy the report.', { error: true }); } },
};
// replaceChildren() turns a null into the text "null"; leave empty slots out.
const put = (node, ...kids) => node.replaceChildren(...kids.filter(k => k != null && k !== false));
const statusChip = f => el('span', { class: `pm-chip pm-${f.status}` }, icon(STATUS[f.status].icon), STATUS[f.status].label);
const dot = f => el('span', { class: 'pm-dot', style: `background:${COLORS[f.key] || '#94a3b8'}`, 'aria-hidden': 'true' });

/* ---- flow ------------------------------------------------------------------------------------------ */
async function start(source, name) {
    if (!fileKind(name)) { toast('Choose an STL, OBJ, 3MF or GLB file.', { error: true }); return; }
    if (running) return;
    current = { source, name, raw: null, result: null };
    $('#mk-drop').hidden = true;
    $('#mk-work').hidden = false;
    $$('[data-name]').forEach(n => { n.textContent = name; });
    $$('[data-facts]').forEach(n => { n.textContent = 'Checking…'; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await run();
}

async function run() {
    if (!current || running) return;
    running = true;
    selected = null;
    const progress = $('#mk-progress'), bar = $('#mk-bar'), msg = $('#mk-msg');
    progress.hidden = false;
    $('#mk-result').hidden = true;
    $$('[data-needs-result]').forEach(n => { n.hidden = true; });
    $('#mk-rerun').disabled = true;
    const update = (text, frac) => { msg.textContent = text; bar.style.width = `${Math.round(100 * Math.max(0, Math.min(1, frac)))}%`; };
    try {
        if (!current.raw) { update('Reading the file', 0.01); current.raw = await loadMesh(current.source, current.name); }
        current.result = await repairMesh(current.raw, options(), update);
        progress.hidden = true;
        showInViewer();
        renderReport(summarize(current.result));
        $('#mk-result').hidden = false;
        $$('[data-needs-result]').forEach(n => { n.hidden = false; });
        $$('[data-facts]').forEach(n => { n.textContent = fileFacts(current.raw, current.result); });
    } catch (error) {
        console.warn('Mesh check failed:', error);
        progress.hidden = true;
        $('#mk-result').hidden = false;
        $$('[data-facts]').forEach(n => { n.textContent = ''; });
        put($('#mk-result'), el('div', { class: 'pm-error', role: 'alert' }, icon('alert-triangle'),
            el('span', {}, `This file could not be checked: ${error?.message || error}. If it opens in another program, export it again as a binary STL and try that.`)));
    } finally {
        running = false;
        $('#mk-rerun').disabled = false;
        icons();
    }
}

function showInViewer() {
    if (!viewer) viewer = createCheckViewer($('#mk-stage'));
    viewer.showAll();   // a problem picked before a re-run must not keep the others hidden
    const after = !$('#mk-view-before').classList.contains('active');
    viewer.setBase(after ? current.result.mesh : current.result.original);
    viewer.setOverlays(current.result.findings.filter(hasHighlight).map(f => ({ key: f.key, color: COLORS[f.key] || '#999', ...f.highlight })));
    viewer.fit();
}

/** Pick a problem (again to put it away): it opens in the list, and the view flies to it showing only it. */
function select(key) {
    selected = selected === key ? null : key;
    const f = current?.result?.findings.find(x => x.key === selected);
    if (f && hasHighlight(f)) viewer?.focus(f.key);
    else { viewer?.showAll(); if (!selected) viewer?.reset(); }
    $$('.a-issue').forEach(li => {
        const on = li.dataset.key === selected;
        li.classList.toggle('is-open', on);
        li.querySelector('.a-issue-head').setAttribute('aria-expanded', String(on));
    });
    $$('[data-reset-view]').forEach(n => { n.hidden = !selected; });
}

function restart() {
    current = null; selected = null;
    $('#mk-work').hidden = true;
    $('#mk-drop').hidden = false;
    $('#mk-file').value = '';
    history.replaceState(null, '', location.pathname);
    $('#mk-drop').focus();
}

/* ---- the report ------------------------------------------------------------------------------------ */
function issueDetail(f) {
    const cat = CATALOG[f.key] || {};
    return el('div', { class: 'pm-detail', id: `detail-${f.key}` },
        el('p', { class: 'pm-found' }, f.summary),
        cat.ntop ? el('p', {}, el('strong', {}, 'Why it matters: '), cat.ntop) : null,
        cat.what ? el('details', { class: 'pm-more' }, el('summary', {}, 'What is this?'), el('p', {}, cat.what)) : null,
        hasHighlight(f) ? null : el('p', { class: 'pm-nothing' }, 'There is nothing to point at in 3D for this one.'));
}

function renderReport(s) {
    const list = el('ul', { class: 'a-issues' });
    for (const f of s.issues) {
        const cat = CATALOG[f.key] || { title: f.key };
        list.append(el('li', { class: `a-issue pm-${f.status}`, dataset: { key: f.key } },
            el('button', { type: 'button', class: 'a-issue-head', 'aria-expanded': 'false', 'aria-controls': `detail-${f.key}`, onclick: () => select(f.key) },
                dot(f), el('span', { class: 'a-issue-title' }, cat.title), f.count ? el('span', { class: 'pm-count', title: 'How many' }, fmtInt(f.count)) : null, statusChip(f), icon('chevron-down')),
            issueDetail(f)));
    }
    put($('#mk-result'),
        el('section', { class: `a-verdict pm-v-${s.verdict}`, 'aria-label': 'Result' },
            el('span', { class: 'a-verdict-icon' }, icon(VERDICT_ICON[s.verdict])),
            el('div', {}, el('h2', {}, s.headline), el('p', {}, s.sub)),
            el('div', { class: 'a-verdict-actions' },
                el('button', { type: 'button', class: 'pm-btn pm-primary', id: 'mk-stl', onclick: actions.stl }, icon('download'), s.verdict === 'clean' ? ' Download STL' : ' Download repaired STL'),
                el('span', { class: 'a-alt' }, el('button', { type: 'button', class: 'pm-link', id: 'mk-obj', onclick: actions.obj }, 'OBJ instead'), ' · ', el('button', { type: 'button', class: 'pm-link', id: 'mk-copy', onclick: actions.copy }, 'Copy report')))),
        el('div', { class: 'a-stats' }, ...s.stats.slice(1).map(st => el('div', { class: `a-stat ${st.good ? 'good' : 'bad'}` },
            el('span', {}, st.label), el('strong', {}, st.before === st.after ? st.after : `${st.before} → ${st.after}`)))),
        s.issues.length ? el('h3', { class: 'a-h' }, 'What we found') : null,
        s.issues.length ? list : null,
        s.passed.length ? el('details', { class: 'a-passed' }, el('summary', {}, icon('check'), ` ${s.passed.length} ${s.issues.length ? 'other ' : ''}checks passed`),
            el('ul', {}, ...s.passed.map(f => el('li', {}, (CATALOG[f.key] || {}).title || f.key)))) : null);
}

/* ---- wiring ------------------------------------------------------------------------------------- */
const drop = $('#mk-drop');
const fileInput = $('#mk-file');
$('#mk-choose').addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) start(file, file.name); });
$('#mk-sample').addEventListener('click', e => { e.stopPropagation(); start(SAMPLE, SAMPLE); });
$('#mk-restart').addEventListener('click', restart);
$('#mk-rerun').addEventListener('click', () => { $('#mk-settings').removeAttribute('open'); run(); });
$$('[data-reset-view]').forEach(b => b.addEventListener('click', () => select(selected)));
for (const id of ['#mk-view-before', '#mk-view-after']) {
    $(id).addEventListener('click', () => {
        for (const other of ['#mk-view-before', '#mk-view-after']) {
            $(other).classList.toggle('active', other === id);
            $(other).setAttribute('aria-pressed', String(other === id));
        }
        if (current?.result && viewer) viewer.setBase(id === '#mk-view-after' ? current.result.mesh : current.result.original);
    });
}
for (const target of [drop, document.body]) {
    target.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); drop.classList.add('over'); } });
    target.addEventListener('dragleave', () => drop.classList.remove('over'));
    target.addEventListener('drop', e => {
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        drop.classList.remove('over');
        start(e.dataTransfer.files[0], e.dataTransfer.files[0].name);
    });
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && selected) select(selected); });
// "What the checks mean": every check, from the same text the report uses.
put($('#mk-glossary'), ...Object.values(CATALOG).map(c => el('details', { class: 'pm-gloss' }, el('summary', {}, icon(c.icon), ` ${c.title}`), el('p', {}, c.what), el('p', {}, el('strong', {}, 'In nTop: '), c.ntop))));
// ?src=<same-origin path> opens a file from the site (testing, or linking straight to a model).
const src = new URLSearchParams(location.search).get('src');
if (src && !/^[a-z]+:|^\/\//i.test(src) && fileKind(src)) start(src, src.split('/').pop());
icons();
window.mkDebug = { get selected() { return selected; }, get current() { return current; } };
