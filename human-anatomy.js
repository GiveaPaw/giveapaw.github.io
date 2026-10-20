// Human anatomy hub (human-anatomy.html): one card per region quiz, grouped
// by body area, with how many structures each can quiz on so far.
(() => {
    'use strict';
    const app = document.getElementById('ha-app');
    if (!app || !window.ANATOMY_REGIONS) return;
    const GROUPS = window.ANATOMY_REGIONS;
    const ALL = [].concat(...GROUPS.map(g => g.regions));
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const isParked = it => !(it.points && it.points.length >= 3) && it.x === 4;

    // how many structures each region can quiz on (labelled so far)
    async function loadRegion(r) {
        const res = await fetch(r.data);
        const w = {};
        new Function('window', await res.text())(w);
        const cfg = w.QUIZ_CONFIG;
        if (window.AnatomyCloud) { try { await window.AnatomyCloud.syncConfig(cfg, r.page, 5000); } catch (e) {} }
        const sets = Object.values(cfg.quizzes);
        return { sets: sets.length, ready: sets.reduce((n, q) => n + q.items.filter(it => !isParked(it)).length, 0),
                 total: sets.reduce((n, q) => n + q.items.length, 0) };
    }
    const counts = {};
    const countsReady = Promise.all(ALL.map(r => loadRegion(r).then(c => { counts[r.slug] = c; }).catch(() => {})));
    const readyText = r => {
        const c = counts[r.slug];
        if (!c) return '&nbsp;';
        return c.sets + ' set' + (c.sets === 1 ? '' : 's') + ' &middot; ' +
            (c.ready ? c.ready + ' structure' + (c.ready === 1 ? '' : 's') + ' to quiz' : 'being labelled');
    };

    // ------------------------------------------------------------ cards
    function renderCards() {
        app.innerHTML = GROUPS.map(g => '<section class="ha-group"><h2>' + esc(g.group) + '</h2><div class="ha-cards">' +
            g.regions.map(r => '<a class="ha-card" href="' + r.page + '" data-slug="' + r.slug + '">' +
                '<span class="ha-thumb"><img src="' + r.thumb + '" alt="" loading="lazy"></span>' +
                '<span class="ha-card-body"><strong>' + esc(r.title) + '</strong><span class="ha-blurb">' + esc(r.blurb) + '</span>' +
                '<span class="ha-count" data-count="' + r.slug + '">&nbsp;</span></span></a>').join('') +
            '</div></section>').join('');
        countsReady.then(fillCounts);
    }
    function fillCounts() {
        app.querySelectorAll('[data-count]').forEach(e => {
            const r = ALL.find(x => x.slug === e.dataset.count);
            e.innerHTML = readyText(r);
            const c = counts[r.slug];
            e.classList.toggle('ha-soon', !!c && !c.ready);
        });
    }

    renderCards();
})();
