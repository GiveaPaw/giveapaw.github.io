// Three wider arrangements of the hub + tabs case-study page (prototype, ?view=wide|split|bento).
// case-history.js builds the page and calls applyView() with its parts; everything here only moves
// existing nodes and adds classes, so turning a view off is just leaving ?view out.
//
//   wide   Up to 1280 px. A short summary band; Design history in three columns (versions | 3D | notes);
//          the 3D models beside their files; report figures grouped in rows and capped in height.
//   split  A fixed stage on the left (the 3D viewer in Design history, the photos elsewhere) and a
//          scrolling column on the right for the notes and the report.
//   bento  An overview grid of tiles instead of the summary card; the report as a two-column set of
//          cards; photos as a masonry wall with a lightbox.

export const VIEWS = { wide: 'Wide', split: 'Split', bento: 'Dashboard' };

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function applyView(view, ctx) {
    if (!VIEWS[view]) return;
    document.body.classList.add('chv', 'chv-' + view + '-page');
    if (!document.querySelector('link[href^="case-views.css"]')) document.head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="case-views.css?v=9">');
    groupFigures(ctx.panels.report);
    addLightbox();
    ({ wide: viewWide, split: viewSplit, bento: viewBento })[view](ctx);
    if (new URLSearchParams(location.search).has('view')) addViewSwitcher(view);
}

// Consecutive figures become one row of 2-3, so pairs like "first design / revised design" sit together.
function groupFigures(root) {
    if (!root) return;
    const figs = [...root.querySelectorAll('figure:not(.model-viewer-figure)')];
    const done = new Set();
    figs.forEach(f => {
        if (done.has(f)) return;
        const run = [f];
        let n = f.nextElementSibling;
        while (n && n.tagName === 'FIGURE' && !n.classList.contains('model-viewer-figure')) { run.push(n); n = n.nextElementSibling; }
        run.forEach(x => done.add(x));
        const row = document.createElement('div');
        row.className = 'chv-figrow' + (run.length === 1 ? ' is-single' : '');
        row.style.setProperty('--n', Math.min(run.length, 3));
        f.before(row);
        run.forEach(x => { row.appendChild(x); x.classList.add('chv-zoom'); });
    });
    root.querySelectorAll('#files figure:not(.model-viewer-figure)').forEach(x => x.classList.add('chv-zoom'));
}

// Click any figure image (or a photo tile in the dashboard) to see it large.
let lightbox = null;
function addLightbox() {
    if (lightbox) return;
    lightbox = document.createElement('div');
    lightbox.className = 'chv-lightbox';
    lightbox.hidden = true;
    lightbox.innerHTML = '<button type="button" class="chv-lb-close" aria-label="Close">×</button><figure><img alt=""><figcaption></figcaption></figure>';
    document.body.appendChild(lightbox);
    const close = () => { lightbox.hidden = true; document.body.classList.remove('chv-lb-open'); };
    lightbox.addEventListener('click', e => { if (!e.target.closest('img')) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !lightbox.hidden) close(); });
    document.addEventListener('click', e => {
        const img = e.target.closest('.chv-zoom img, .chv-wall img');
        if (!img || img.closest('.chv-lightbox')) return;
        e.preventDefault();
        $('img', lightbox).src = img.currentSrc || img.src;
        $('img', lightbox).alt = img.alt;
        $('figcaption', lightbox).textContent = img.closest('figure')?.querySelector('figcaption')?.textContent || img.alt || '';
        lightbox.hidden = false;
        document.body.classList.add('chv-lb-open');
    });
}

// ------------------------------------------------------------------ wide
function viewWide({ panels }) {
    // 3D models beside their downloads and drawings.
    const files = $('#files', panels.history);
    if (files) files.classList.add('chv-files');
    // Photos tab: carousel and tiles side by side.
    const media = panels.media;
    const carousel = media && $('.carousel', media);
    const tiles = media && $('.ch-tiles', media);
    if (carousel && tiles) {
        const row = document.createElement('div');
        row.className = 'chv-media-row';
        carousel.before(row);
        row.append(carousel, tiles);
    }
}

// ------------------------------------------------------------------ split
function viewSplit({ panels, H }) {
    const tabsNav = $('.ch-tabs');
    const shell = document.createElement('div');
    shell.className = 'chv-split';
    const stage = document.createElement('div');
    stage.className = 'chv-stage';
    const col = document.createElement('div');
    col.className = 'chv-col';
    tabsNav.after(shell);
    shell.append(stage, col);
    Object.values(panels).forEach(p => col.appendChild(p));

    const viewerHost = $('[data-viewer]', panels.history);
    const carousel = $('.carousel', panels.media);
    const files = $('#files', panels.history);
    const placeholder = document.createElement('div');
    const place = tab => {
        stage.replaceChildren();
        if (tab === 'history' && viewerHost) {
            stage.appendChild(viewerHost);
            stage.dataset.kind = '3d';
        } else if (tab === 'history' && files) {
            // No versions yet: the stage shows the interactive model instead.
            const fig = $('.model-viewer-figure', files);
            if (fig) { fig.before(placeholder); stage.appendChild(fig); }
            stage.dataset.kind = 'model';
        } else if (carousel) {
            stage.appendChild(carousel);
            stage.dataset.kind = 'photos';
        }
        if (tab !== 'history' && placeholder.isConnected) {
            const fig = stage.querySelector('.model-viewer-figure');
            if (fig) placeholder.replaceWith(fig);
        }
        if (tab !== 'history' && viewerHost && !viewerHost.isConnected) $('.ch-main', panels.history)?.prepend(viewerHost);
    };
    document.addEventListener('ch-tab', e => place(e.detail));
    place(document.querySelector('.ch-tabs [aria-selected="true"]')?.dataset.tab || 'report');
    // The photos tab keeps the tiles and report photos in the column; the carousel lives on the stage.
    if (H.versions.length === 0 && !files) stage.hidden = true;
}

// ------------------------------------------------------------------ bento (dashboard)
// The overview at the top comes in four arrangements (?dash=):
//   steps (default, Tyler's pick 2026-10-18)
//   spotlight  one big card (photo + where things stand + one button), three small facts under it
//   cover      no tiles: a photo beside a headline, a line of facts and three buttons
//   steps      three cards read left to right: 1 meet the dog, 2 what we are building, 3 where it stands
//   tiles      the first dashboard: seven tiles
export const DASHES = { spotlight: 'Spotlight', cover: 'Cover', steps: 'Three steps', tiles: 'All tiles' };

function overviewData(H, P, panels) {
    const facts = P.facts.map(html => {
        const d = document.createElement('div');
        d.innerHTML = html;
        const k = (d.querySelector('strong')?.textContent || '').replace(/:\s*$/, '').trim();
        d.querySelector('strong')?.remove();
        return { k, v: d.textContent.trim() };
    });
    const fact = k => facts.find(f => f.k.toLowerCase() === k)?.v || '';
    const cur = H.current;
    const fmt = (d, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', opts) : '');
    const headline = !cur.length ? 'Design history coming soon'
        : cur.length > 1 ? `${cur.length} socket candidates under review`
            : cur[0].title;
    const sub = !cur.length ? 'Versions appear here as the team logs them.'
        : cur.length > 1 ? `${cur.map(v => v.label).join(' and ')} · ${cur[0].status} · ${fmt(cur[0].date)}`
            : `${cur[0].label} · ${cur[0].status} · ${fmt(cur[0].date)}`;
    const slides = [...(panels.media?.querySelectorAll('.carousel-slide') || [])];
    return {
        facts, fact, cur, headline, sub, slides,
        photoCount: slides.length + (panels.media?.querySelectorAll('.ch-fig').length || 0),
        goals: fact('goals') || P.summary?.querySelector('p')?.textContent.trim() || '',
        limb: fact('prosthetic'),
        latest: cur.flatMap(v => (v.changes || []).slice(0, 1).map(c => ({ v, c })))[0],
        thumbs: cur.filter(v => v.model).slice(0, 2).map(v => `<figure class="chv-cand"><img src="${esc(v.thumb)}" alt="" onerror="this.parentNode.classList.add('no-img')"><figcaption>${esc(v.label)}</figcaption></figure>`).join(''),
        cta: cur.length ? (cur.length > 1 ? 'Compare them in 3D' : 'See it in 3D') : 'See the 3D models',
        fmt,
    };
}

function overviewHTML(dash, H, P, D) {
    const quick = ['age', 'weight', 'reason'].map(k => D.fact(k) && `<span><b>${esc(k[0].toUpperCase() + k.slice(1))}</b> ${esc(D.fact(k))}</span>`).filter(Boolean).join('');
    if (dash === 'cover') {
        return `<div class="chv-cover">
            ${P.photo ? `<button type="button" class="chv-cover-photo" data-go="media" aria-label="Photos and videos">${`<img src="${esc(P.photo)}" alt="">`}<span>${D.photoCount} photos &amp; videos</span></button>` : ''}
            <div class="chv-cover-text">
                <span class="chv-eyebrow">${esc(H.name)}${D.limb ? ' · ' + esc(D.limb) : ''}</span>
                <strong class="chv-headline">${esc(D.headline)}</strong>
                <span class="chv-sub">${esc(D.sub)}</span>
                ${quick ? `<div class="chv-inline-facts">${quick}${D.goals ? `<span><b>Goals</b> ${esc(D.goals)}</span>` : ''}</div>` : ''}
                <div class="chv-actions"><button type="button" class="chv-primary" data-go="history">${esc(D.cta)} →</button><button type="button" class="chv-secondary" data-go="report">Read the report</button></div>
            </div></div>`;
    }
    if (dash === 'steps') {
        return `<div class="chv-steps">
            <button type="button" class="chv-step" data-go="media"><span class="chv-num">1</span><span class="chv-step-k">Meet ${esc(H.name)}</span>
                ${P.photo ? `<img class="chv-step-photo" src="${esc(P.photo)}" alt="">` : ''}
                <span class="chv-step-facts">${quick}</span><span class="chv-go">${D.photoCount} photos &amp; videos →</span></button>
            <button type="button" class="chv-step" data-go="report"><span class="chv-num">2</span><span class="chv-step-k">What we are building</span>
                <strong class="chv-step-big">${esc(D.limb || 'A custom prosthetic')}</strong>
                ${D.goals ? `<span class="chv-step-text">For ${esc(D.goals.charAt(0).toLowerCase() + D.goals.slice(1))}.</span>` : ''}
                <span class="chv-go">Read the report →</span></button>
            <div class="chv-step-stats" role="group" aria-label="${esc(H.name)} in numbers"><span><b>${H.versions.length}</b>versions</span><span><b>${D.photoCount}</b>photos &amp; videos</span><span><b>${esc(H.latest ? D.fmt(H.latest, { month: 'short', day: 'numeric' }) : '—')}</b>last update</span></div>
            <button type="button" class="chv-step is-now" data-go="history"><span class="chv-num">3</span><span class="chv-step-k">Where it stands</span>
                <strong class="chv-step-big">${esc(D.headline)}</strong><span class="chv-sub">${esc(D.sub)}</span>
                ${D.thumbs ? `<span class="chv-cands">${D.thumbs}</span>` : ''}
                <span class="chv-go">${esc(D.cta)} →</span></button>
        </div>`;
    }
    // spotlight
    return `<div class="chv-spot">
        <div class="chv-spot-hero">
            ${P.photo ? `<button type="button" class="chv-spot-photo" data-go="media" aria-label="Photos and videos"><img src="${esc(P.photo)}" alt=""><span>${D.photoCount} photos &amp; videos</span></button>` : ''}
            <div class="chv-spot-text">
                <span class="chv-eyebrow">Where ${esc(H.name)}'s prosthetic stands</span>
                <strong class="chv-headline">${esc(D.headline)}</strong>
                <span class="chv-sub">${esc(D.sub)}</span>
                ${D.thumbs ? `<span class="chv-cands">${D.thumbs}</span>` : ''}
                <div class="chv-actions"><button type="button" class="chv-primary" data-go="history">${esc(D.cta)} →</button></div>
            </div>
        </div>
        <div class="chv-spot-row">
            <div class="chv-mini"><span class="chv-mini-k">Prosthetic</span><strong>${esc(D.limb || '—')}</strong></div>
            <div class="chv-mini"><span class="chv-mini-k">Goals</span><strong>${esc(D.goals || '—')}</strong></div>
            <div class="chv-mini"><span class="chv-mini-k">About ${esc(H.name)}</span><strong>${esc(['age', 'weight', 'reason'].map(D.fact).filter(Boolean).join(' · ') || '—')}</strong></div>
        </div>
    </div>`;
}

function tilesHTML(H, P, D) {
    const cur = D.cur[0];
    return `<div class="chv-bento">
        <button type="button" class="chv-tile chv-t-photo" data-go="media">${P.photo ? `<img src="${esc(P.photo)}" alt="">` : ''}<span>${D.photoCount} photos &amp; videos →</span></button>
        <button type="button" class="chv-tile chv-t-now" data-go="history">
            <span class="ch-now-k">Current design</span>
            <strong>${esc(cur ? (D.cur.length > 1 ? `${D.cur.length} candidates: ${D.cur.map(v => v.label).join(' and ')}` : `${cur.label}: ${cur.title}`) : 'No design history yet')}</strong>
            <span class="chv-sub">${esc(cur ? `${cur.status} · ${D.fmt(cur.date)}` : 'Versions appear here as the team logs them')}</span>
            ${cur?.model ? `<span class="chv-thumbs">${D.cur.slice(0, 2).map(v => `<img src="${esc(v.thumb)}" alt="" onerror="this.remove()">`).join('')}</span>` : ''}
            <span class="chv-go">${cur ? 'See it in 3D and compare →' : 'See the 3D models →'}</span>
        </button>
        <div class="chv-tile chv-t-facts"><ul>${P.facts.map(f => `<li>${f}</li>`).join('')}</ul></div>
        ${P.summary?.querySelector('p') ? `<div class="chv-tile chv-t-goals"><span class="ch-now-k">Goals</span><p>${esc(P.summary.querySelector('p').textContent.trim())}</p></div>` : ''}
        ${D.latest ? `<button type="button" class="chv-tile chv-t-change" data-go="history"><span class="ch-now-k">Latest change · ${esc(D.latest.v.label)}</span><p><span class="ch-tag" data-tag="${esc(D.latest.c.tag)}">${esc(D.latest.c.tag)}</span>${esc(D.latest.c.text)}</p></button>` : ''}
        <div class="chv-tile chv-t-stats">
            <div><b>${H.versions.length}</b><span>versions</span></div>
            <div><b>${D.photoCount}</b><span>photos &amp; videos</span></div>
            <div><b>${esc(H.latest ? D.fmt(H.latest, { month: 'short', day: 'numeric' }) : '—')}</b><span>last update</span></div>
        </div>
        <a class="chv-tile chv-t-log team-only" href="design-log.html#${esc(H.A.id)}"><span class="ch-now-k">Team</span><strong>Design log ↗</strong><span class="chv-sub">pins, threads, working notes</span></a>
    </div>`;
}

function viewBento({ H, P, panels, show }) {
    const dash = DASHES[params().get('dash')] ? params().get('dash') : 'steps';
    document.body.classList.add('chv-dash-' + dash);
    const hub = $('.ch-hub');
    const D = overviewData(H, P, panels);
    const box = document.createElement('section');
    box.className = 'chv-overview';
    box.setAttribute('aria-label', `${H.name} at a glance`);
    box.innerHTML = dash === 'tiles' ? tilesHTML(H, P, D) : overviewHTML(dash, H, P, D);
    hub.replaceWith(box);
    box.addEventListener('click', e => {
        const go = e.target.closest('[data-go]')?.dataset.go;
        if (!go) return;
        show(go);
        if (go === 'history' && D.cur[0] && panels.history.select) panels.history.select(D.cur[0].id);
        else history.replaceState(null, '', '#' + go);
        $('.ch-tabs').scrollIntoView({ behavior: 'smooth' });
    });
    // The brief summary only repeats the goals once they are in the overview.
    if (dash === 'tiles') P.summary?.classList.add('ch-hide');
    // Report sections become cards; the team spans both columns.
    panels.report.classList.add('chv-cards');
    const files = $('#files', panels.history);
    if (files) files.classList.add('chv-files');
    // Photos: a masonry wall replaces the carousel and tiles.
    const media = panels.media;
    if (media && D.slides.length) {
        const wall = document.createElement('div');
        wall.className = 'chv-wall';
        wall.innerHTML = D.slides.map(s => {
            const img = s.querySelector('img');
            const video = s.querySelector('video');
            if (img) return `<figure><img src="${esc(img.getAttribute('src'))}" alt="${esc(img.alt || '')}" loading="lazy"></figure>`;
            const src = video?.querySelector('source')?.getAttribute('src') || video?.getAttribute('src') || '';
            return `<figure class="is-video"><video src="${esc(src)}" controls muted playsinline preload="metadata"></video></figure>`;
        }).join('');
        $('.carousel', media)?.classList.add('ch-hide');
        $('.ch-tiles', media)?.classList.add('ch-hide');
        $('h2', media).after(wall);
    }
}
const params = () => new URLSearchParams(location.search);

function addViewSwitcher(view) {
    const box = document.createElement('div');
    box.className = 'ch-switcher';
    const link = (v, d) => { const u = new URL(location.href); u.hash = ''; if (v) u.searchParams.set('view', v); else u.searchParams.delete('view'); if (d) u.searchParams.set('dash', d); else u.searchParams.delete('dash'); return u.pathname.split('/').pop() + u.search; };
    const dash = params().get('dash') || 'steps';
    box.innerHTML = view === 'bento'
        ? `<span>Dashboard</span>${Object.entries(DASHES).map(([k, n]) => `<a href="${esc(link('bento', k))}" aria-current="${k === dash}">${n}</a>`).join('')}<a href="case-history-options.html#dash">Compare</a>`
        : `<span>View</span><a href="${esc(link(''))}">Current</a>${Object.entries(VIEWS).map(([k, n]) => `<a href="${esc(link(k))}" aria-current="${k === view}">${n}</a>`).join('')}<a href="case-history-options.html#views">Compare</a>`;
    document.body.appendChild(box);
}
