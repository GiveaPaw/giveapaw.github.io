// Design history on the case-study pages.
//
//   default    Hub + tabs (Tyler's pick, 2026-10-18): B's summary card under the title, then tabs
//              Report | Design history (with the 3D models, files and team log) | Photos & videos.
//   ?layout=a  Tabs:     Report | Design history | 3D & files, with a two-column history browser.
//   ?layout=b  Hub:      a patient summary card and a version strip at the top; a version opens in a drawer.
//   ?layout=c  Timeline: "where they are now" and a dated timeline of versions; the 3D view opens in place.
//
// ?layout=off leaves the page exactly as it was before the history was added.
// History comes from the curated, public iterations/<animal>.json files (the same shape the design
// log uses); the private team log in Firebase is never read here. Example pins and comments in
// sample data are not shown.
import { modelUrl } from './model-base.js?v=2';

const LAYOUTS = { d: 'Hub + tabs', a: 'Tabs', b: 'Hub', c: 'Timeline' };
const DEFAULT_LAYOUT = 'd';
// Tyler's pick (2026-10-18): the dashboard with the three-step overview. ?view=none shows plain hub + tabs.
const DEFAULT_VIEW = 'bento';
const params = new URLSearchParams(location.search);
const LAYOUT = (params.get('layout') || document.body.dataset.historyLayout || DEFAULT_LAYOUT).toLowerCase();
const STATUS = { 'Idea (not modelled)': 'idea', 'Candidate (not printed)': 'candidate', 'Printed': 'printed', 'Printed and fitted': 'fitted', 'Retired': 'retired' };
const COLORS = { current: 0x2f7fc1, other: 0xe8893a };

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => { const t = new Date(String(d) + 'T12:00:00'); return isNaN(t) ? String(d ?? '') : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const rich = text => String(text ?? '').split(/(https?:\/\/[^\s<>"]+)/g).map((p, i) => i % 2 ? `<a href="${esc(p)}" target="_blank" rel="noopener noreferrer">${esc(p)}</a>` : esc(p)).join('');

if (LAYOUTS[LAYOUT]) init(LAYOUT).catch(error => console.error('Design history could not be added.', error));

async function init(layout) {
    const animalId = (document.body.dataset.animal || (location.pathname.match(/([a-z0-9]+)-case-study\.html$/i) || [])[1] || '').toLowerCase();
    const manifest = await fetch('iterations/animals.json', { cache: 'no-cache' }).then(r => r.json());
    const A = manifest.animals.find(a => a.id === animalId);
    if (!A) return;
    const data = A.sample ? await fetch(A.sample, { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null) : null;
    const H = buildHistory(A, data);
    const page = pageParts(A);
    if (!page.article) return;
    document.body.classList.add('ch-on', 'ch-' + layout);
    const ctx = ({ a: layoutTabs, b: layoutHub, c: layoutTimeline, d: (h, p) => layoutTabs(h, p, { hub: true }) })[layout](H, page);
    // ?view=wide|split|bento: wider arrangements of the hub + tabs page (prototype, case-views.js).
    const view = params.get('view') ?? (params.has('layout') ? '' : DEFAULT_VIEW);
    if (layout === 'd' && view && view !== 'none') (await import('./case-views.js?v=9')).applyView(view, ctx);
    if (params.has('layout')) addSwitcher(layout);
    // Team updates and "Team sign in" (case-updates.js, Firebase cases/pages/<animal>).
    if (layout === 'd') import('./case-updates.js?v=10').then(m => m.initUpdates(ctx, manifest)).catch(error => console.error('Team updates could not be added.', error));
}

// ------------------------------------------------------------------ data
function buildHistory(A, data) {
    const list = (data?.iterations || []).map(v => ({
        ...v,
        pins: data.sample ? [] : (v.pins || []),
        thumb: `iterations/thumbs/${A.id}-${v.id}.jpg`,
        statusKey: STATUS[v.status] || 'other',
    }));
    const byId = Object.fromEntries(list.map(v => [v.id, v]));
    const kids = new Map();
    list.forEach(v => { const p = byId[v.parent] ? v.parent : ''; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(v); });
    const ordered = [];
    const walk = (p, depth) => (kids.get(p) || []).sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach(v => { ordered.push(Object.assign(v, { depth })); walk(v.id, depth + 1); });
    walk('', 0);
    list.filter(v => !ordered.includes(v)).forEach(v => ordered.push(Object.assign(v, { depth: 0 })));
    ordered.forEach(v => { v.children = (kids.get(v.id) || []).map(k => k.id); });
    const latest = ordered.reduce((d, v) => (String(v.date) > d ? String(v.date) : d), '');
    const current = ordered.filter(v => String(v.date) === latest && v.statusKey !== 'retired');
    return { A, name: A.name, versions: ordered, byId, current, latest, body: A.body || data?.body || null, up: A.up || 'z', sameFrame: !!A.sameFrame, sample: !!data?.sample };
}

function currentText(H) {
    if (!H.current.length) return { title: 'No design history logged yet', detail: 'Versions will appear here as the team logs them.' };
    const c = H.current;
    if (c.length === 1) return { title: `${c[0].label}: ${c[0].title}`, detail: `${c[0].status} · ${fmtDate(c[0].date)}` };
    const all = new Set(c.map(v => v.status));
    return {
        title: `${c.length} ${c.every(v => v.statusKey === 'candidate') ? 'candidates under review' : 'current versions'}: ${c.map(v => v.label).join(' and ')}`,
        detail: `${all.size === 1 ? c[0].status : 'Mixed status'} · ${fmtDate(H.latest)}`,
    };
}

function pageParts(A) {
    const article = $('.content article');
    if (!article) return {};
    const sections = [...article.children].filter(n => n.tagName === 'SECTION');
    const hero = article.querySelector(`#${CSS.escape(A.id)}-case-study`) || sections[0];
    return {
        article, hero, sections,
        files: $('#files', article), iteration: $('#iteration-design', article), summary: $('#brief-summary', article),
        facts: [...(hero?.querySelectorAll(':scope > ul li') || [])].map(li => li.innerHTML),
        photo: hero?.querySelector('.carousel img')?.getAttribute('src') || '',
        reportSections: sections.filter(s => s !== hero && s.id !== 'files'),
    };
}

// ------------------------------------------------------------------ shared pieces
const thumbImg = (v, cls = 'ch-thumb') => `<span class="${cls}">${v.model ? `<img src="${esc(v.thumb)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<i aria-hidden="true">${v.model ? '3D' : 'No 3D'}</i></span>`;
const statusPill = v => `<span class="ch-status" data-s="${v.statusKey}">${esc(v.status || 'No status')}</span>`;

function versionCard(v, H, { active = false, button = true } = {}) {
    const tag = button ? 'button type="button"' : 'div';
    const first = v.changes?.[0];
    return `<${tag} class="ch-card${active ? ' active' : ''}" data-version="${esc(v.id)}"${button ? ` aria-pressed="${active}"` : ''}>
        ${thumbImg(v)}
        <span class="ch-card-body"><span class="ch-card-top"><b class="ch-label">${esc(v.label)}</b><span>${esc(fmtDate(v.date))}</span></span>
        <strong>${esc(v.title)}</strong>${statusPill(v)}
        ${first ? `<small>${esc(first.text)}</small>` : ''}
        ${v.parent && H.byId[v.parent] ? `<small class="ch-from">From ${esc(H.byId[v.parent].label)}</small>` : ''}</span>
    </${button ? 'button' : 'div'}>`;
}

function versionDetail(v, H, { heading = 'h3' } = {}) {
    const parent = v.parent && H.byId[v.parent];
    const kids = (v.children || []).map(id => H.byId[id]).filter(Boolean);
    const links = Object.values(v.links || {});
    return `<div class="ch-detail" data-detail="${esc(v.id)}">
        <${heading} class="ch-detail-title"><span class="ch-label">${esc(v.label)}</span> ${esc(v.title)}</${heading}>
        <p class="ch-meta">${esc(fmtDate(v.date))} · ${statusPill(v)}${parent ? ` · based on <a href="#" data-goto="${esc(parent.id)}">${esc(parent.label)}</a>` : ''}${kids.length ? ` · led to ${kids.map(k => `<a href="#" data-goto="${esc(k.id)}">${esc(k.label)}</a>`).join(', ')}` : ''}</p>
        ${v.summary ? `<p>${rich(v.summary)}</p>` : ''}
        ${v.changes?.length ? `<h4>What changed</h4><ul class="ch-changes">${v.changes.map(c => `<li><span class="ch-tag" data-tag="${esc(c.tag)}">${esc(c.tag)}</span>${rich(c.text)}${c.why ? `<span class="ch-why">Why: ${rich(c.why)}</span>` : ''}</li>`).join('')}</ul>` : ''}
        ${v.outcome ? `<div class="ch-outcome"><b>Result</b>${rich(v.outcome)}</div>` : ''}
        ${links.length ? `<h4>Files &amp; links</h4><ul class="ch-links">${links.map(l => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label || l.url)}</a></li>`).join('')}</ul>` : ''}
        <p class="ch-team team-only"><a href="design-log.html#${esc(H.A.id)}/${esc(v.id)}">Open in the team design log ↗</a></p>
    </div>`;
}

function emptyHistory(H) {
    return `<div class="ch-empty"><strong>No design history logged for ${esc(H.name)} yet.</strong>
        <span>Each version of the prosthetic, with what changed and why, will appear here as the team logs it<span class="team-only"> in the <a href="design-log.html#${esc(H.A.id)}">design log</a></span>.</span></div>`;
}

// One 3D area for the history: a version on its own, or two versions side by side or overlaid.
function historyViewer(host, H) {
    let mode = 'overlay';
    try { mode = localStorage.getItem('gap-history-compare') === 'side' ? 'side' : 'overlay'; } catch {}
    const state = { id: null, cmp: '', body: false };
    let viewers = [];
    let token = 0;
    host.classList.add('ch-viewer');
    host.innerHTML = `<div class="ch-vtools">
            <label class="ch-vsel">Compare with <select data-cmp aria-label="Compare with"></select></label>
            <span class="ch-seg" data-modes hidden><button type="button" data-mode="overlay">Overlay</button><button type="button" data-mode="side">Side by side</button></span>
            ${H.body ? `<button type="button" class="ch-tbtn" data-body aria-pressed="false">${esc(H.body.label || 'Body')}</button>` : ''}
            <button type="button" class="ch-tbtn" data-fit>Fit</button>
        </div>
        <div class="ch-stage" data-stage></div>
        <div class="ch-vviews" data-views></div>`;
    const stage = $('[data-stage]', host), sel = $('[data-cmp]', host), modes = $('[data-modes]', host), viewsBar = $('[data-views]', host);
    sel.addEventListener('change', () => set(state.id, sel.value));
    modes.addEventListener('click', e => {
        const m = e.target.closest('[data-mode]')?.dataset.mode;
        if (!m || m === mode) return;
        mode = m;
        try { localStorage.setItem('gap-history-compare', m); } catch {}
        build();
    });
    $('[data-body]', host)?.addEventListener('click', e => {
        state.body = !state.body;
        e.currentTarget.setAttribute('aria-pressed', String(state.body));
        viewers.forEach(w => w.api?.setVisible('body', state.body));
    });
    $('[data-fit]', host).addEventListener('click', () => viewers.forEach(w => w.api?.frame('main')));
    viewsBar.addEventListener('click', e => {
        const id = e.target.closest('[data-view]')?.dataset.view;
        const v = H.byId[state.id];
        const view = v?.views?.find(x => x.id === id);
        if (view) viewers.find(w => w.id === state.id)?.api?.flyTo(view.camera);
    });

    async function loadInto(api, slot, file, opts) {
        try { return await api.setModel(slot, modelUrl(file), opts); }
        catch { return await api.setModel(slot, file, opts); }
    }

    async function build() {
        const my = ++token;
        viewers.forEach(w => w.api?.dispose());
        viewers = [];
        stage.replaceChildren();
        const v = H.byId[state.id];
        const other = state.cmp && H.byId[state.cmp];
        const overlay = other && mode === 'overlay' && v?.model && other.model;
        const shown = other && !overlay ? [other, v] : [v];
        stage.classList.toggle('is-side', !!other && !overlay);
        modes.hidden = !other;
        modes.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
        viewsBar.innerHTML = (v?.views || []).length && v.model ? `<span>Views</span>${v.views.map(w => `<button type="button" data-view="${esc(w.id)}">${esc(w.name)}</button>`).join('')}` : '';
        const { createViewer } = await import('./iteration-viewer.js?v=4');
        if (my !== token) return;
        for (const x of shown) {
            const box = document.createElement('div');
            box.className = 'ch-pane';
            box.innerHTML = overlay
                ? `<span class="ch-badge"><i style="--c:#2f7fc1"></i>${esc(v.label)}<i style="--c:#e8893a"></i>${esc(other.label)}</span>`
                : `<span class="ch-badge">${esc(x.label)} · ${esc(x.title)}</span>`;
            stage.appendChild(box);
            if (!x.model) { box.insertAdjacentHTML('beforeend', '<div class="ch-pane-msg">No 3D model for this version</div>'); viewers.push({ id: x.id, api: null }); continue; }
            box.insertAdjacentHTML('beforeend', '<div class="ch-pane-msg" data-loading>Loading 3D model…</div>');
            viewers.push({ id: x.id, api: createViewer(box, { up: H.up }), box });
        }
        await Promise.all(viewers.map(async w => {
            if (!w.api) return;
            const x = H.byId[w.id];
            try {
                if (overlay) {
                    await loadInto(w.api, 'main', x.model, { color: COLORS.current });
                    const o = await loadInto(w.api, 'other', other.model, { color: COLORS.other, opacity: 0.6 });
                    // Pushed slightly back: where the two surfaces coincide the current version shows,
                    // so the orange only appears where the compared version really differs.
                    if (o) Object.assign(o.material, { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4, needsUpdate: true });
                } else await loadInto(w.api, 'main', x.model);
                if (H.body) await loadInto(w.api, 'body', H.body.file, { color: 0x6f8fb5, opacity: 0.28, visible: state.body }).catch(() => {});
                if (my !== token) return;
                w.box.querySelector('[data-loading]')?.remove();
                w.api.frame('main');
            } catch {
                const m = w.box.querySelector('[data-loading]');
                if (m) m.textContent = 'The 3D model could not be loaded.';
            }
        }));
        const live = viewers.filter(w => w.api);
        if (live.length === 2 && H.sameFrame) live[0].api.link(live[1].api);
    }

    function set(id, cmp = '') {
        state.id = id;
        state.cmp = cmp && cmp !== id ? cmp : '';
        const others = H.versions.filter(x => x.id !== id && x.model);
        const v = H.byId[id];
        sel.innerHTML = `<option value="">Off</option>` + others.map(x => `<option value="${esc(x.id)}" ${x.id === state.cmp ? 'selected' : ''}>${esc(x.label)}${x.id === v?.parent ? ' (based on)' : ''}: ${esc(x.title)}</option>`).join('');
        sel.disabled = !others.length || !v?.model;
        build();
    }

    return { set, dispose() { token++; viewers.forEach(w => w.api?.dispose()); viewers = []; }, get state() { return { ...state, mode }; } };
}

function onGoto(root, fn) {
    root.addEventListener('click', e => {
        const a = e.target.closest('[data-goto]');
        if (!a) return;
        e.preventDefault();
        fn(a.dataset.goto);
    });
}

// ------------------------------------------------------------------ A: tabs
function layoutTabs(H, P, { hub = false } = {}) {
    // Hub mode (the default): Report | Design history (with the 3D models, files and team log) | Photos & videos.
    const carousel = P.hero.querySelector('.carousel');
    const slides = carousel ? [...carousel.querySelectorAll('.carousel-slide')] : [];
    const reportPhotos = hub ? P.reportSections.flatMap(s => [...s.querySelectorAll('figure')]).filter(f => /\.jpe?g$/i.test(f.querySelector('img')?.getAttribute('src') || '')) : [];
    const tabs = hub
        ? [
            { id: 'media', label: 'Photos & videos', count: slides.length + reportPhotos.length },
            { id: 'report', label: 'Report' },
            { id: 'history', label: 'Design history', count: H.versions.length },
        ]
        : [
            { id: 'report', label: 'Report' },
            { id: 'history', label: 'Design history', count: H.versions.length },
            { id: 'files', label: '3D models & files' },
        ];
    const nav = document.createElement('nav');
    nav.className = 'ch-tabs';
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', `${H.name}'s case study`);
    nav.innerHTML = tabs.map(t => `<button type="button" role="tab" id="ch-tab-${t.id}" aria-controls="ch-panel-${t.id}" data-tab="${t.id}">${t.label}${t.count ? ` <span class="ch-count">${t.count}</span>` : ''}</button>`).join('');
    const panels = Object.fromEntries(tabs.map(t => {
        const p = document.createElement('div');
        p.className = 'ch-panel';
        p.id = 'ch-panel-' + t.id;
        p.setAttribute('role', 'tabpanel');
        p.setAttribute('aria-labelledby', 'ch-tab-' + t.id);
        return [t.id, p];
    }));
    const now = currentText(H);
    if (hub) {
        P.hero.querySelector(':scope > ul')?.classList.add('ch-hide');
        (P.hero.querySelector('h1') || P.hero.firstElementChild).after(hubCard(H, P, {
            action: `<button type="button" class="ch-link" data-tab-go="history">${H.current.length ? 'See it in 3D and compare →' : 'See the 3D models →'}</button>`,
        }));
        nav.classList.add('ch-tabs-hub');
    } else {
        const banner = `<div class="ch-now"><span class="ch-now-k">Current design</span><strong>${esc(now.title)}</strong><span>${esc(now.detail)}</span>${H.current.length ? '<button type="button" class="ch-link" data-tab-go="history">See the design history →</button>' : ''}</div>`;
        P.hero.insertAdjacentHTML('beforeend', banner);
    }
    P.hero.after(nav);
    nav.after(...tabs.map(t => panels[t.id]));
    P.reportSections.forEach(s => panels.report.appendChild(s));

    const hp = panels.history;
    let viewer = null, selected = H.current[0]?.id || H.versions.at(-1)?.id;
    const teamLog = `<a href="design-log.html#${esc(H.A.id)}">team design log ↗</a>`;
    if (!H.versions.length) hp.innerHTML = `<h2>Design history</h2>${emptyHistory(H)}`;
    else {
        hp.innerHTML = `<h2>Design history</h2>
            <p class="ch-intro">Every version of ${esc(H.name)}'s prosthetic, newest at the bottom. Pick one to see it in 3D, compare it with another, and read what changed and why.${hub ? `<span class="team-only"> Pins, threads and working notes are in the ${teamLog}.</span>` : ''}</p>
            <div class="ch-browser"><ol class="ch-tree" aria-label="Versions"></ol><div class="ch-main"><div data-viewer></div><div data-detail-host></div></div></div>`;
        const tree = $('.ch-tree', hp);
        const renderTree = () => {
            tree.innerHTML = H.versions.map(v => `<li style="--d:${Math.min(v.depth, 3)}" class="${v.depth ? 'child' : ''}"><button type="button" data-version="${esc(v.id)}" aria-current="${v.id === selected}">
                <span class="ch-card-top"><b class="ch-label">${esc(v.label)}</b><span>${esc(fmtDate(v.date))}</span></span><strong>${esc(v.title)}</strong>${statusPill(v)}${H.current.includes(v) ? '<span class="ch-now-tag">Current</span>' : ''}</button></li>`).join('');
        };
        const select = id => {
            selected = id;
            renderTree();
            $('[data-detail-host]', hp).innerHTML = versionDetail(H.byId[id], H);
            viewer.set(id, '');
            history.replaceState(null, '', '#history/' + id);
        };
        tree.addEventListener('click', e => { const b = e.target.closest('[data-version]'); if (b) select(b.dataset.version); });
        onGoto(hp, id => select(id));
        viewer = historyViewer($('[data-viewer]', hp), H);
        panels.history.select = select;
        renderTree();
    }
    if (hub) {
        // The interactive models and downloads sit under the history, renamed to say what they are.
        if (P.files) {
            const h2 = P.files.querySelector('h2');
            if (h2?.firstChild?.nodeType === 3) h2.firstChild.textContent = '3D models & files';
            P.files.classList.add('ch-files-in-history');
            hp.appendChild(P.files);
        }
        if (!H.versions.length) hp.insertAdjacentHTML('beforeend', `<p class="ch-team ch-team-end">Working notes for ${esc(H.name)} go in the ${teamLog}.</p>`);
        buildMedia(panels.media, carousel, slides, reportPhotos, H);
    } else {
        if (carousel) { /* stays in the hero */ }
        if (P.files) panels.files.appendChild(P.files);
    }

    let shown = null;
    function show(id, { focus = false } = {}) {
        if (shown === id) return;
        if (shown === 'media') panels.media?.querySelectorAll('video').forEach(v => v.pause());
        shown = id;
        tabs.forEach(t => {
            const on = t.id === id;
            panels[t.id].hidden = !on;
            const b = $(`[data-tab="${t.id}"]`, nav);
            b.setAttribute('aria-selected', String(on));
            b.tabIndex = on ? 0 : -1;
        });
        if (id === 'history' && panels.history.select && !$('[data-detail-host] .ch-detail', panels.history)) {
            const want = location.hash.match(/^#history\/(.+)$/)?.[1];
            panels.history.select(H.byId[want] ? want : selected);
        }
        if (focus) $(`[data-tab="${id}"]`, nav).focus();
        document.dispatchEvent(new CustomEvent('ch-tab', { detail: id }));
    }
    nav.addEventListener('click', e => {
        const t = e.target.closest('[data-tab]')?.dataset.tab;
        if (!t) return;
        show(t);
        history.replaceState(null, '', '#' + t);
    });
    nav.addEventListener('keydown', e => {
        if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        const i = tabs.findIndex(t => t.id === shown);
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].id;
        show(next, { focus: true });
        history.replaceState(null, '', '#' + next);
    });
    P.hero.addEventListener('click', e => {
        const go = e.target.closest('[data-tab-go]')?.dataset.tabGo;
        if (!go) return;
        show(go);
        if (go === 'history' && H.current[0] && panels.history.select) panels.history.select(H.current[0].id);
        else history.replaceState(null, '', '#' + go);
        nav.scrollIntoView({ behavior: 'smooth' });
    });
    // "See in the report" links from the photo grid.
    panels.media?.addEventListener('click', e => {
        const id = e.target.closest('[data-report-figure]')?.dataset.reportFigure;
        if (!id) return;
        e.preventDefault();
        show('report');
        history.replaceState(null, '', '#report');
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    // Deep links: #history, #history/<version>, #media, #files, and the old section anchors (#materials, ...).
    const route = () => {
        const h = decodeURIComponent(location.hash.slice(1));
        const owner = id => tabs.find(t => panels[t.id].querySelector('#' + CSS.escape(id)))?.id;
        if (h.startsWith('history')) {
            show('history');
            const id = h.split('/')[1];
            if (id && H.byId[id] && panels.history.select && id !== selected) panels.history.select(id);
            return;
        }
        if (panels[h]) { show(h); return; }
        const tab = h && (owner(h) || (h === 'files' ? 'history' : null));
        show(tab || tabs[0].id); // the first tab opens by default
        if (h) document.getElementById(h)?.scrollIntoView();
    };
    window.addEventListener('hashchange', route);
    route();
    return { H, P, panels, nav, show };
}

// Photos & videos tab: the photo carousel, a grid of everything in it, and the photos used in the report.
function buildMedia(panel, carousel, slides, reportPhotos, H) {
    if (!panel) return;
    panel.innerHTML = `<h2>Photos &amp; videos</h2>`;
    if (!carousel && !reportPhotos.length) {
        panel.insertAdjacentHTML('beforeend', `<div class="ch-empty"><strong>No photos or videos for ${esc(H.name)} yet.</strong></div>`);
        return;
    }
    if (carousel) {
        panel.appendChild(carousel);
        const tiles = slides.map((s, i) => {
            const img = s.querySelector('img');
            const video = s.querySelector('video');
            const src = img?.getAttribute('src') || '';
            const vsrc = video?.querySelector('source')?.getAttribute('src') || video?.getAttribute('src') || '';
            return `<button type="button" class="ch-tile${video ? ' is-video' : ''}" data-slide="${i}" aria-label="Show ${video ? 'video' : 'photo'} ${i + 1}">
                ${img ? `<img src="${esc(src)}" alt="" loading="lazy">` : `<video src="${esc(vsrc)}#t=0.5" muted preload="metadata" tabindex="-1"></video>`}${video ? '<i aria-hidden="true">▶</i>' : ''}</button>`;
        }).join('');
        panel.insertAdjacentHTML('beforeend', `<div class="ch-tiles" aria-label="All photos and videos">${tiles}</div>`);
        panel.addEventListener('click', e => {
            const t = e.target.closest('[data-slide]');
            if (!t) return;
            carousel.querySelectorAll('.carousel-dot')[+t.dataset.slide]?.click();
            carousel.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    }
    if (reportPhotos.length) {
        reportPhotos.forEach((f, i) => { if (!f.id) f.id = 'ch-fig-' + i; });
        panel.insertAdjacentHTML('beforeend', `<h3>From the report</h3><div class="ch-figs">${reportPhotos.map(f => {
            const img = f.querySelector('img');
            const cap = f.querySelector('figcaption')?.textContent.trim() || img.getAttribute('alt') || '';
            return `<a class="ch-fig" href="#report" data-report-figure="${esc(f.id)}"><img src="${esc(img.getAttribute('src'))}" alt="${esc(img.getAttribute('alt') || '')}" loading="lazy"><span>${esc(cap)}</span><small>See in the report →</small></a>`;
        }).join('')}</div>`);
    }
}

// The summary card: photo, current design, facts (used by B and by the hub + tabs default).
function hubCard(H, P, { action = '', after = '' } = {}) {
    const now = currentText(H);
    const hub = document.createElement('section');
    hub.className = 'ch-hub';
    hub.setAttribute('aria-label', `${H.name} at a glance`);
    hub.innerHTML = `<div class="ch-hub-card">
            ${P.photo ? `<img class="ch-hub-photo" src="${esc(P.photo)}" alt="">` : ''}
            <div class="ch-hub-body">
                <span class="ch-now-k">Current design</span>
                <strong class="ch-hub-now">${esc(now.title)}</strong>
                <span class="ch-hub-sub">${esc(now.detail)}</span>
                ${action}
            </div>
            ${P.facts.length ? `<ul class="ch-facts">${P.facts.slice(0, 6).map(f => `<li>${f}</li>`).join('')}</ul>` : ''}
        </div>${after}`;
    return hub;
}

// ------------------------------------------------------------------ B: hub + strip + drawer
function layoutHub(H, P) {
    const jump = [
        ['ch-strip', 'Design history', H.versions.length ? plural(H.versions.length, 'version') : 'none yet'],
        [P.summary?.id || 'brief-summary', 'The report', 'goals, materials, assembly'],
        ['files', '3D models & files', 'interactive models, downloads'],
    ];
    const hub = hubCard(H, P, {
        after: `<nav class="ch-jump" aria-label="Jump to">${jump.map(([id, t, s]) => `<a href="#${esc(id)}"><strong>${esc(t)}</strong><span>${esc(s)}</span></a>`).join('')}<a class="team-only" href="design-log.html#${esc(H.A.id)}"><strong>Team design log ↗</strong><span>pins, threads, all notes</span></a></nav>`,
    });
    // The hub replaces the bullet list of facts under the photos; the carousel stays.
    P.hero.querySelector(':scope > ul')?.classList.add('ch-hide');
    (P.hero.querySelector('h1') || P.hero.firstElementChild).after(hub);

    const strip = document.createElement('section');
    strip.className = 'ch-strip-sec';
    strip.id = 'ch-strip';
    strip.innerHTML = `<h2>Design history</h2>${H.versions.length
        ? `<p class="ch-intro">Oldest on the left. Open a version to see it in 3D, compare it, and read what changed.</p><div class="ch-strip" role="list">${H.versions.map(v => `<div role="listitem">${versionCard(v, H)}</div>`).join('')}</div>`
        : emptyHistory(H)}`;
    P.hero.after(strip);

    // Drawer
    const drawer = document.createElement('div');
    drawer.className = 'ch-drawer';
    drawer.hidden = true;
    drawer.innerHTML = `<div class="ch-drawer-back" data-close></div><aside class="ch-drawer-panel" role="dialog" aria-modal="true" aria-label="Version details">
        <div class="ch-drawer-head"><span class="ch-drawer-nav"><button type="button" data-step="-1" aria-label="Previous version">‹</button><button type="button" data-step="1" aria-label="Next version">›</button></span><button type="button" class="ch-close" data-close aria-label="Close">×</button></div>
        <div data-viewer></div><div data-detail-host></div></aside>`;
    document.body.appendChild(drawer);
    let viewer = null, openId = null, lastFocus = null;
    const open = id => {
        if (!H.byId[id]) return;
        if (drawer.hidden) lastFocus = document.activeElement;
        openId = id;
        drawer.hidden = false;
        document.body.classList.add('ch-drawer-open');
        viewer ||= historyViewer($('[data-viewer]', drawer), H);
        const v = H.byId[id];
        viewer.set(id, v.parent && H.byId[v.parent]?.model ? v.parent : '');
        $('[data-detail-host]', drawer).innerHTML = versionDetail(v, H, { heading: 'h2' });
        strip.querySelectorAll('[data-version]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.version === id)));
        history.replaceState(null, '', '#v/' + id);
        $('.ch-close', drawer).focus({ preventScroll: true });
    };
    const close = () => {
        if (drawer.hidden) return;
        drawer.hidden = true;
        document.body.classList.remove('ch-drawer-open');
        viewer?.dispose();
        viewer = null;
        $('[data-viewer]', drawer).replaceChildren();
        history.replaceState(null, '', location.pathname + location.search);
        lastFocus?.focus?.({ preventScroll: true });
    };
    strip.addEventListener('click', e => { const b = e.target.closest('[data-version]'); if (b) open(b.dataset.version); });
    drawer.addEventListener('click', e => {
        if (e.target.closest('[data-close]')) return close();
        const s = e.target.closest('[data-step]');
        if (s) { const i = H.versions.findIndex(v => v.id === openId); const n = H.versions[i + +s.dataset.step]; if (n) open(n.id); }
    });
    onGoto(drawer, open);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !drawer.hidden) close(); });
    const want = location.hash.match(/^#v\/(.+)$/)?.[1];
    if (want) open(decodeURIComponent(want));
}

// ------------------------------------------------------------------ C: now + timeline
function layoutTimeline(H, P) {
    const now = currentText(H);
    // Contents chips under the title: where they are now, the timeline, then the report's sections.
    const toc = document.createElement('nav');
    toc.className = 'ch-toc';
    toc.setAttribute('aria-label', 'On this page');
    const sectionLinks = P.sections.filter(s => s !== P.hero).map(s => [s.id, (s.querySelector('h2')?.firstChild?.textContent || s.id).trim()]);
    toc.innerHTML = `<a href="#ch-now" class="is-now">Now</a><a href="#ch-timeline">Design timeline</a>${sectionLinks.map(([id, t]) => `<a href="#${esc(id)}">${esc(t.replace(/^Brief Summary of Animal Goals$/, 'Goals').replace(/^Iteration in Design Process and Challenges Faced$/, 'Design notes').replace(/^Referenced Papers\/Sources$/, 'References').replace(/^Assembly of Full Design$/, 'Assembly'))}</a>`).join('')}`;
    P.hero.querySelector('h1')?.after(toc);
    toc.insertAdjacentHTML('afterend', `<div class="ch-now ch-now-big" id="ch-now"><span class="ch-now-k">Where ${esc(H.name)} is now</span><strong>${esc(now.title)}</strong><span>${esc(now.detail)}</span>${H.versions.length ? '<a class="ch-link" href="#ch-timeline">Design timeline ↓</a>' : ''}</div>`);

    const sec = document.createElement('section');
    sec.className = 'ch-timeline-sec';
    sec.id = 'ch-timeline';
    const groups = [];
    [...H.versions].sort((a, b) => String(b.date).localeCompare(String(a.date))).forEach(v => {
        const g = groups.find(x => x.date === v.date && x.parent === (v.parent || ''));
        if (g) g.items.push(v); else groups.push({ date: v.date, parent: v.parent || '', items: [v] });
    });
    sec.innerHTML = `<h2>Design timeline</h2>
        ${H.versions.length ? `<p class="ch-intro">Newest first. Each version shows what changed and why; open it in 3D to look closer or compare.</p>
        <ol class="ch-timeline">${groups.map((g, gi) => `<li class="ch-node${gi === 0 ? ' is-now' : ''}">
            <div class="ch-node-date"><span>${esc(fmtDate(g.date))}</span>${gi === 0 ? '<b>Now</b>' : ''}</div>
            <div class="ch-node-body">
                ${g.items.length > 1 ? `<p class="ch-group-note">${g.items.length} candidates from the same day${g.parent && H.byId[g.parent] ? `, both based on ${esc(H.byId[g.parent].label)}` : ''}.</p>` : ''}
                <div class="ch-node-cards${g.items.length > 1 ? ' is-pair' : ''}">${g.items.map(v => `<article class="ch-tcard" data-tcard="${esc(v.id)}">
                    ${thumbImg(v, 'ch-thumb ch-thumb-lg')}
                    <div class="ch-tcard-body">${versionDetail(v, H, { heading: 'h3' }).replace('<p class="ch-team">', `<p class="ch-actions">${v.model ? `<button type="button" class="ch-btn" data-open3d="${esc(v.id)}">View in 3D</button>` : ''}${compareTarget(v, g, H) ? `<button type="button" class="ch-btn ch-btn-2" data-open3d="${esc(v.id)}" data-cmp="${esc(compareTarget(v, g, H).id)}">Compare with ${esc(compareTarget(v, g, H).label)}</button>` : ''}</p><p class="ch-team">`)}</div>
                </article>`).join('')}</div>
                <div class="ch-inline" data-inline hidden></div>
            </div></li>`).join('')}</ol>` : emptyHistory(H)}
        ${P.iteration ? '<p class="ch-older">Earlier notes, photos and challenges: <a href="#iteration-design">design notes</a>.</p>' : ''}`;
    (P.summary || P.hero).after(sec);

    let viewer = null, host = null;
    const open3d = (id, cmp, node) => {
        const target = node.querySelector('[data-inline]');
        if (host && host !== target) { viewer?.dispose(); host.hidden = true; host.replaceChildren(); viewer = null; }
        host = target;
        host.hidden = false;
        if (!viewer) {
            host.innerHTML = '<div class="ch-inline-head"><span></span><button type="button" class="ch-close" data-close3d aria-label="Close 3D view">×</button></div><div data-viewer></div>';
            viewer = historyViewer($('[data-viewer]', host), H);
        }
        $('.ch-inline-head span', host).textContent = cmp ? `${H.byId[id].label} compared with ${H.byId[cmp].label}` : `${H.byId[id].label} in 3D`;
        viewer.set(id, cmp || '');
        host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        history.replaceState(null, '', '#t/' + id + (cmp ? '/' + cmp : ''));
    };
    sec.addEventListener('click', e => {
        const b = e.target.closest('[data-open3d]');
        if (b) return open3d(b.dataset.open3d, b.dataset.cmp, b.closest('.ch-node'));
        const thumb = e.target.closest('.ch-thumb');
        const card = thumb?.closest('[data-tcard]');
        if (card && H.byId[card.dataset.tcard]?.model) return open3d(card.dataset.tcard, '', card.closest('.ch-node'));
        if (e.target.closest('[data-close3d]')) { viewer?.dispose(); viewer = null; host.hidden = true; host.replaceChildren(); host = null; }
    });
    onGoto(sec, id => sec.querySelector(`[data-tcard="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    const want = location.hash.match(/^#t\/([^/]+)(?:\/(.+))?$/);
    if (want && H.byId[want[1]]) open3d(want[1], want[2] && H.byId[want[2]] ? want[2] : '', sec.querySelector(`[data-tcard="${CSS.escape(want[1])}"]`).closest('.ch-node'));
}

function compareTarget(v, g, H) {
    if (g.items.length > 1) return g.items.find(x => x.id !== v.id && x.model) || null;
    const p = v.parent && H.byId[v.parent];
    return p?.model ? p : null;
}

// ------------------------------------------------------------------ prototype switcher
function addSwitcher(layout) {
    const box = document.createElement('div');
    box.className = 'ch-switcher';
    const link = l => { const u = new URL(location.href); u.hash = ''; if (l) u.searchParams.set('layout', l); else u.searchParams.delete('layout'); return u.pathname.split('/').pop() + u.search; };
    box.innerHTML = `<span>Layout</span>${Object.entries(LAYOUTS).map(([k, n]) => `<a href="${esc(link(k))}" aria-current="${k === layout}">${k === DEFAULT_LAYOUT ? n : k.toUpperCase() + ' · ' + n}</a>`).join('')}<a href="${esc(link('off'))}">Original</a><a href="case-history-options.html">All options</a>`;
    document.body.appendChild(box);
}
