// Shared anatomy quiz engine (canine, human, knee, ear).
// The page supplies window.QUIZ_CONFIG = { appId, quizzes, aliases } before
// loading this file; everything below is data-driven from that.
(() => {
    const CONFIG = window.QUIZ_CONFIG;
    if (!CONFIG) return;
    const app = document.getElementById(CONFIG.appId);
    if (!app) return;

    const QUIZZES = CONFIG.quizzes;

    // Closed Catmull-Rom spline rendered as cubic beziers. `smooth` 0..1:
    // 0 gives straight polygon edges, 1 a fully rounded curve through the
    // same control points.
    function smoothPath(pts, smooth) {
        if (!pts || pts.length < 3) return '';
        const s = Math.max(0, Math.min(1, smooth == null ? 0.6 : smooth)) / 6 * 4;
        const n = pts.length;
        const at = i => pts[(i + n) % n];
        let d = 'M ' + at(0)[0] + ' ' + at(0)[1];
        for (let i = 0; i < n; i++) {
            const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
            const c1x = p1[0] + (p2[0] - p0[0]) * s / 4;
            const c1y = p1[1] + (p2[1] - p0[1]) * s / 4;
            const c2x = p2[0] - (p3[0] - p1[0]) * s / 4;
            const c2y = p2[1] - (p3[1] - p1[1]) * s / 4;
            d += ' C ' + c1x.toFixed(2) + ' ' + c1y.toFixed(2) +
                 ', ' + c2x.toFixed(2) + ' ' + c2y.toFixed(2) +
                 ', ' + p2[0] + ' ' + p2[1];
        }
        return d + ' Z';
    }

    const imageEl = document.getElementById('quiz-image');
    const marker = document.getElementById('quiz-marker');
    const highlight = document.getElementById('quiz-highlight');
    const promptEl = document.getElementById('quiz-prompt');
    const optionsEl = document.getElementById('quiz-options');
    const feedbackEl = document.getElementById('quiz-feedback');
    const nextBtn = document.getElementById('quiz-next');
    const numEl = document.getElementById('quiz-num');
    const totalEl = document.getElementById('quiz-total');
    const scoreEl = document.getElementById('quiz-score');
    const resultEl = document.getElementById('quiz-result');
    const resultScoreEl = document.getElementById('quiz-result-score');
    const restartBtn = document.getElementById('quiz-restart');
    const tabs = [...document.querySelectorAll('.quiz-tab')];

    // Labelling saved from the editor lives in the cloud (anatomy-cloud.js)
    // as well as in the data file; whichever is newer is used. Reading it is
    // one small public request, capped so a slow network never blocks play.
    const loadScript = src => new Promise(done => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = s.onerror = done;
        document.head.appendChild(s);
    });
    if (promptEl) promptEl.textContent = 'Loading…';
    const cloudReady = loadScript('anatomy-cloud.js?v=3')
        .then(() => window.AnatomyCloud && window.AnatomyCloud.syncConfig(CONFIG, null, 4000))
        .catch(() => null);

    // Shape editor (?dev=1). It lives in quiz-editor.js and is loaded only
    // on demand, so quiz visitors never download it.
    if (new URLSearchParams(window.location.search).has('dev')) {
        app.querySelector('.quiz-panel').hidden = true;
        cloudReady.then(() => loadScript('quiz-editor.js?v=8')).then(() => window.QuizEditor({
            CONFIG, QUIZZES, app, imageEl, marker, tabs, smoothPath,
        }));
        return;
    }

    // ---- Gameplay ----
    // Four modes over the same item pools. Custom quizzes are addressed by
    // URL (?quiz=bones&mode=click&parts=slug,slug) so any selection of
    // parts and mode is shareable as a link; the customize panel below the
    // quiz builds those URLs. Slugs derive from item names, so links keep
    // working when items are reordered (renaming a bone breaks its links).
    const MODES = {
        identify: 'Multiple choice',
        click: 'Find it',
        type: 'Type the name',
        match: 'Matching',
    };
    // Percent coordinates are anisotropic: one x-percent spans imageW/100
    // pixels and one y-percent imageH/100, so x must be scaled by the
    // image's aspect before percent distances can be compared. Read it from
    // the image actually loaded - the quiz sets on one page can use images
    // of very different shapes (a landscape skeleton and a tall limb).
    const xscale = () => {
        const w = imageEl.naturalWidth, h = imageEl.naturalHeight;
        return (w && h) ? w / h : 1;
    };
    const MATCH_SIZE = 5;
    const MATCH_LETTERS = 'ABCDE';

    // Accepted answers in type mode beyond the display name (the
    // parenthetical part of a name is always accepted on its own).
    const BASE_ALIASES = {
        'Cranium (skull)': ['head bone'],
        'Mandible': ['lower jaw', 'jaw', 'jaw bone', 'jawbone'],
        'Scapula': ['shoulder blade', 'shoulderblade'],
        'Patella': ['kneecap', 'knee cap'],
        'Pelvis': ['hip bone', 'hipbone', 'pelvic bone'],
        'Sternum': ['breastbone', 'breast bone'],
        'Tibia': ['shinbone', 'shin bone'],
        'Femur': ['thigh bone', 'thighbone'],
        'Calcaneus': ['heel bone', 'heelbone'],
        'Ribs': ['rib', 'ribcage', 'rib cage'],
        'Carpal bones': ['carpals', 'carpus', 'wrist bones'],
        'Tarsal bones': ['tarsals', 'tarsus', 'ankle bones'],
        'Metacarpal bones': ['metacarpals'],
        'Metatarsal bones': ['metatarsals'],
        'Phalanges (front paw)': ['phalanges', 'toes', 'digits', 'toe bones'],
        'Phalanges (hind paw)': ['phalanges', 'toes', 'digits', 'toe bones'],
        'Caudal vertebrae (tail)': ['tail bones', 'coccygeal vertebrae'],
        'Cervical vertebrae': ['cervical', 'neck vertebrae', 'neck bones'],
        'Thoracic vertebrae': ['thoracic'],
        'Lumbar vertebrae': ['lumbar'],
        'Temporomandibular joint': ['tmj', 'jaw joint'],
        'Metacarpophalangeal joint': ['mcp joint', 'knuckle'],
        'Teeth': ['tooth', 'dentition'],
        'Manubrium': ['manubrium of sternum', 'sternal manubrium'],
        'Atlanto-occipital joint': ['atlantooccipital joint', 'atlanto occipital'],
        'Atlantoaxial joint': ['atlanto axial joint'],
        'Costovertebral joints': ['costovertebral', 'rib vertebra joints'],
        'Sternocostal joints': ['sternocostal', 'costosternal joints'],
        'Lumbosacral joint': ['lumbosacral', 'l5 s1 joint'],
        'Sacroiliac joint': ['sacroiliac', 'si joint'],
        'Sternoclavicular joint': ['sternoclavicular', 'sc joint'],
        'Acromioclavicular joint': ['acromioclavicular', 'ac joint'],
        'Radioulnar joint': ['radioulnar', 'radio ulnar joint'],
        'Proximal radioulnar joint': ['proximal radioulnar'],
        'Distal radioulnar joint': ['distal radioulnar'],
        'Carpometacarpal joint': ['carpometacarpal', 'cmc joint'],
        'Metatarsophalangeal joint': ['metatarsophalangeal', 'mtp joint'],
    };
    const ALIASES = Object.assign({}, BASE_ALIASES, CONFIG.aliases || {});

    // Items the editor parks down the left edge (x = 4, no outline) have
    // not been labelled yet, so they are left out of play.
    const isParked = it => !(it.points && it.points.length >= 3) && it.x === 4;
    const playable = key => QUIZZES[key].items.filter(it => !isParked(it));

    const slug = name => name.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    let currentKey = 'bones', mode = 'identify', partsFilter = null;
    let pool = [], noun = 'bone';
    let order = [], idx = 0, score = 0, answered = false;
    let matchPairs = {}, matchSel = null;

    const shuffle = (arr) => {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    };

    // Sampled points along the same curve smoothPath renders, for hit
    // testing and area comparison. Cached per item.
    const outlineCache = new WeakMap();
    function sampledOutline(item) {
        if (!item.points || item.points.length < 3) return null;
        let pts = outlineCache.get(item);
        if (pts) return pts;
        const src = item.points;
        const s = Math.max(0, Math.min(1, item.smooth == null ? 0.6 : item.smooth)) / 6 * 4;
        const n = src.length;
        const at = i => src[(i + n) % n];
        pts = [];
        for (let i = 0; i < n; i++) {
            const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
            const c1x = p1[0] + (p2[0] - p0[0]) * s / 4;
            const c1y = p1[1] + (p2[1] - p0[1]) * s / 4;
            const c2x = p2[0] - (p3[0] - p1[0]) * s / 4;
            const c2y = p2[1] - (p3[1] - p1[1]) * s / 4;
            for (let k = 0; k < 8; k++) {
                const u = k / 8, v = 1 - u;
                pts.push([
                    v * v * v * p1[0] + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * p2[0],
                    v * v * v * p1[1] + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * p2[1],
                ]);
            }
        }
        outlineCache.set(item, pts);
        return pts;
    }

    function pointInOutline(pts, x, y) {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const [xi, yi] = pts[i], [xj, yj] = pts[j];
            if ((yi > y) !== (yj > y) &&
                x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
        return inside;
    }

    function outlineArea(pts) {
        let a = 0;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
        }
        return Math.abs(a / 2);
    }

    // Which item does a click at (x, y) land on? Traced shapes win over
    // marker dots, and the smallest containing shape wins so small bones
    // are clickable inside larger neighbours.
    function hitItem(items, x, y) {
        let best = null, bestArea = Infinity;
        items.forEach(item => {
            const pts = sampledOutline(item);
            if (pts) {
                if (pointInOutline(pts, x, y)) {
                    const a = outlineArea(pts);
                    if (a < bestArea) { best = item; bestArea = a; }
                }
            }
        });
        if (best) return best;
        let bestD = Infinity;
        items.forEach(item => {
            if (sampledOutline(item)) return;
            const d = Math.hypot((x - item.x) * xscale(), y - item.y);
            if (d < 6 && d < bestD) { best = item; bestD = d; }
        });
        return best;
    }

    // ---- type-mode answer matching ----
    const normalize = s => s.toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const depluralize = s => s.split(' ')
        .map(w => w.length > 3 ? w.replace(/s$/, '') : w).join(' ');

    function editDistance(a, b) {
        if (Math.abs(a.length - b.length) > 2) return 99;
        const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
        for (let j = 1; j <= b.length; j++) dp[0][j] = j;
        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1, dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
        }
        return dp[a.length][b.length];
    }

    function acceptedAnswers(item) {
        const out = [normalize(item.name)];
        const par = item.name.match(/\(([^)]+)\)/);
        if (par) {
            out.push(normalize(item.name.replace(/\([^)]*\)/g, '')));
            out.push(normalize(par[1]));
        }
        (ALIASES[item.name] || []).forEach(a => out.push(normalize(a)));
        return out.filter(Boolean);
    }

    function answerMatches(input, item) {
        const guess = normalize(input);
        if (!guess) return false;
        const guessDe = depluralize(guess);
        return acceptedAnswers(item).some(t => {
            if (guess === t || guessDe === depluralize(t)) return true;
            const tol = t.length >= 10 ? 2 : (t.length >= 6 ? 1 : 0);
            return tol > 0 && editDistance(guessDe, depluralize(t)) <= tol;
        });
    }

    // ---- extra UI the modes need (built once, plain DOM) ----
    const figureFrame = imageEl.parentElement;
    const pinsLayer = document.createElement('div');
    pinsLayer.id = 'quiz-pins';
    figureFrame.appendChild(pinsLayer);

    const answerForm = document.createElement('form');
    answerForm.id = 'quiz-answer-form';
    answerForm.hidden = true;
    answerForm.innerHTML =
        '<input type="text" id="quiz-answer-input" autocomplete="off" ' +
        'autocapitalize="off" spellcheck="false" placeholder="Name the ' +
        'highlighted part">' +
        '<button type="submit" class="quiz-next">Answer</button>';
    optionsEl.after(answerForm);
    const answerInput = answerForm.querySelector('input');

    const matchList = document.createElement('div');
    matchList.id = 'quiz-match';
    matchList.hidden = true;
    answerForm.after(matchList);

    const modeBar = document.createElement('div');
    modeBar.className = 'quiz-tabs quiz-modes';
    modeBar.setAttribute('role', 'tablist');
    modeBar.setAttribute('aria-label', 'Quiz mode');
    const modeLabel = document.createElement('span');
    modeLabel.className = 'quiz-bar-label';
    modeLabel.textContent = 'Mode';
    modeBar.appendChild(modeLabel);
    Object.keys(MODES).forEach(m => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'quiz-tab quiz-mode-btn' + (m === mode ? ' active' : '');
        b.dataset.mode = m;
        b.textContent = MODES[m];
        b.addEventListener('click', () => {
            mode = m;
            syncModeBar();
            start(currentKey);
        });
        modeBar.appendChild(b);
    });
    const tabBar = document.querySelector('.quiz-tabs');
    tabBar.after(modeBar);
    function syncModeBar() {
        [...modeBar.children].forEach(b =>
            b.classList.toggle('active', b.dataset.mode === mode));
    }

    function clearMarks() {
        highlight.setAttribute('d', '');
        highlight.className.baseVal = '';
        marker.hidden = true;
        pinsLayer.innerHTML = '';
        figureFrame.classList.remove('quiz-clickable');
        if (typeof clearHover === 'function') clearHover();
    }

    function renderShape(q, cls) {
        if (q.points && q.points.length >= 3) {
            highlight.setAttribute('d', smoothPath(q.points, q.smooth));
            highlight.className.baseVal = cls || '';
            marker.hidden = true;
        } else {
            highlight.setAttribute('d', '');
            marker.hidden = false;
            marker.style.left = q.x + '%';
            marker.style.top = q.y + '%';
            marker.style.width = q.w ? q.w + '%' : '';
            marker.style.height = q.h ? q.h + '%' : '';
            marker.style.setProperty('--marker-rot', (q.rot || 0) + 'deg');
        }
    }

    function start(quiz) {
        const cfg = QUIZZES[quiz] || QUIZZES['bones'];
        currentKey = QUIZZES[quiz] ? quiz : 'bones';
        noun = cfg.noun;
        const ready = playable(currentKey);
        pool = ready;
        if (partsFilter && partsFilter.length) {
            const wanted = new Set(partsFilter);
            const filtered = ready.filter(it => wanted.has(slug(it.name)));
            if (filtered.length) pool = filtered;
        } else if (partsFilter && !partsFilter.length) {
            pool = [];
        }
        if (imageEl.getAttribute('src') !== cfg.image) {
            imageEl.setAttribute('src', cfg.image);
        }
        idx = 0;
        score = 0;
        scoreEl.textContent = '0';
        resultEl.hidden = true;
        updateUrl();
        renderCustomPanel();
        if (!pool.length) {
            // "Select none" state: parked until a part is ticked
            order = [];
            resetQuestionUI();
            setProgress('Question', 0, 0);
            promptEl.textContent = ready.length
                ? 'Select at least one part in Customize below to start.'
                : 'No ' + noun + 's in this set have been labelled yet. Try another set.';
            return;
        }
        if (mode === 'match' && pool.length < 2) {
            mode = 'identify';
            syncModeBar();
        }
        order = shuffle(pool);
        totalEl.textContent = String(order.length);
        showQuestion();
    }

    const progressLabelEl = document.getElementById('quiz-progress-label');
    function setProgress(label, num, total) {
        if (progressLabelEl) progressLabelEl.textContent = label;
        numEl.textContent = String(num);
        totalEl.textContent = String(total);
    }

    function resetQuestionUI() {
        answered = false;
        feedbackEl.textContent = '';
        feedbackEl.className = 'quiz-feedback';
        nextBtn.hidden = true;
        optionsEl.innerHTML = '';
        answerForm.hidden = true;
        matchList.hidden = true;
        matchList.innerHTML = '';
        clearMarks();
    }

    function showQuestion() {
        resetQuestionUI();
        const q = order[idx];
        setProgress('Question', idx + 1, order.length);
        if (mode === 'identify') {
            renderShape(q);
            promptEl.textContent = 'Which ' + noun + ' is marked?';
            const distractors = shuffle(QUIZZES[currentKey].items
                .filter(o => o.name !== q.name)).slice(0, 3);
            shuffle([q, ...distractors]).forEach(o => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'quiz-option';
                btn.textContent = o.name;
                btn.addEventListener('click', () => chooseOption(btn, o.name, q.name));
                optionsEl.appendChild(btn);
            });
        } else if (mode === 'type') {
            renderShape(q);
            promptEl.textContent = 'Name the highlighted ' + noun + '.';
            answerForm.hidden = false;
            answerInput.disabled = false;
            answerInput.value = '';
            answerForm.querySelector('button').disabled = false;
            answerInput.focus();
        } else if (mode === 'click') {
            promptEl.textContent = 'Click the ' + q.name + '.';
            figureFrame.classList.add('quiz-clickable');
        } else if (mode === 'match') {
            showMatchRound();
        }
    }

    function afterAnswer(correct, message) {
        answered = true;
        if (correct) {
            score++;
            scoreEl.textContent = String(score);
        }
        feedbackEl.textContent = message;
        feedbackEl.className = 'quiz-feedback ' + (correct ? 'correct' : 'wrong');
        nextBtn.hidden = false;
        nextBtn.focus({ preventScroll: true });
    }

    function chooseOption(btn, picked, correct) {
        if (answered) return;
        [...optionsEl.querySelectorAll('.quiz-option')].forEach(b => {
            b.disabled = true;
            if (b.textContent === correct) b.classList.add('correct');
        });
        if (picked !== correct) btn.classList.add('wrong');
        afterAnswer(picked === correct,
            picked === correct ? 'Correct!' : 'Not quite. It is the ' + correct + '.');
    }

    answerForm.addEventListener('submit', e => {
        e.preventDefault();
        if (answered || answerForm.hidden) return;
        const q = order[idx];
        const ok = answerMatches(answerInput.value, q);
        answerInput.disabled = true;
        answerForm.querySelector('button').disabled = true;
        renderShape(q, ok ? 'quiz-hl-correct' : 'quiz-hl-wrong');
        afterAnswer(ok, ok
            ? 'Correct! ' + q.name + '.'
            : 'Not quite. It is the ' + q.name + '.');
    });

    figureFrame.addEventListener('click', e => {
        if (mode !== 'click' || answered || !order.length) return;
        const rect = imageEl.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width * 100;
        const y = (e.clientY - rect.top) / rect.height * 100;
        if (x < 0 || x > 100 || y < 0 || y > 100) return;
        const q = order[idx];
        const hit = hitItem(playable(currentKey), x, y);
        const ok = !!hit && hit.name === q.name;
        clearHover();
        renderShape(q, ok ? 'quiz-hl-correct' : 'quiz-hl-wrong');
        figureFrame.classList.remove('quiz-clickable');
        afterAnswer(ok, ok
            ? 'Correct! That is the ' + q.name + '.'
            : (hit ? 'That is the ' + hit.name + '. The ' + q.name +
                     ' is highlighted now.'
                   : 'Not quite. The ' + q.name + ' is highlighted now.'));
    });

    // Hover preview in find-and-click mode: outline whatever part is under
    // the cursor so clusters (carpals, sesamoids, overlapping tibia/fibula)
    // are aimable. Shows the shape only, never the name, so it aids the
    // hand without answering the question. Marker-only items (the joint
    // quizzes) preview as their true clickable ellipse.
    const hoverPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hoverPath.id = 'quiz-hover';
    const overlayEl = document.getElementById('quiz-overlay');
    overlayEl.insertBefore(hoverPath, overlayEl.firstChild);
    let hoverItem = null, hoverRaf = 0, hoverEvent = null;

    function clearHover() {
        hoverItem = null;
        hoverPath.setAttribute('d', '');
    }

    function markerEllipsePath(item) {
        const rx = 6 / xscale(), ry = 6;
        return 'M ' + (item.x - rx) + ' ' + item.y +
            ' a ' + rx + ' ' + ry + ' 0 1 0 ' + (rx * 2) + ' 0' +
            ' a ' + rx + ' ' + ry + ' 0 1 0 ' + (-rx * 2) + ' 0 Z';
    }

    figureFrame.addEventListener('mousemove', e => {
        hoverEvent = e;
        if (mode !== 'click' || answered) {
            if (hoverItem) clearHover();
            return;
        }
        if (hoverRaf) return;
        hoverRaf = requestAnimationFrame(() => {
            hoverRaf = 0;
            const ev = hoverEvent;
            const rect = imageEl.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            const x = (ev.clientX - rect.left) / rect.width * 100;
            const y = (ev.clientY - rect.top) / rect.height * 100;
            const hit = (x < 0 || x > 100 || y < 0 || y > 100)
                ? null : hitItem(playable(currentKey), x, y);
            if (hit === hoverItem) return;
            hoverItem = hit;
            if (!hit) {
                hoverPath.setAttribute('d', '');
            } else if (hit.points && hit.points.length >= 3) {
                hoverPath.setAttribute('d', smoothPath(hit.points, hit.smooth));
            } else {
                hoverPath.setAttribute('d', markerEllipsePath(hit));
            }
        });
    });

    figureFrame.addEventListener('mouseleave', clearHover);

    // ---- match mode ----
    function currentRound() {
        return order.slice(idx, idx + MATCH_SIZE);
    }

    function showMatchRound() {
        const round = currentRound();
        matchPairs = {};
        matchSel = null;
        const rounds = Math.ceil(order.length / MATCH_SIZE);
        const roundNo = Math.floor(idx / MATCH_SIZE) + 1;
        setProgress('Round', roundNo, rounds);
        promptEl.textContent = 'Match each letter to its ' + noun + '.';
        round.forEach((item, i) => {
            const pin = document.createElement('button');
            pin.type = 'button';
            pin.className = 'quiz-pin';
            pin.textContent = MATCH_LETTERS[i];
            pin.dataset.letter = MATCH_LETTERS[i];
            pin.style.left = item.x + '%';
            pin.style.top = item.y + '%';
            pin.addEventListener('click', () => selectPin(pin, item));
            pinsLayer.appendChild(pin);
        });
        matchList.hidden = false;
        shuffle(round).forEach(item => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'quiz-option quiz-match-name';
            btn.dataset.name = item.name;
            btn.innerHTML = '<span class="quiz-match-slot"></span>' + item.name;
            btn.addEventListener('click', () => selectName(btn));
            matchList.appendChild(btn);
        });
        const check = document.createElement('button');
        check.type = 'button';
        check.className = 'quiz-next';
        check.id = 'quiz-match-check';
        check.textContent = 'Check answers';
        check.disabled = true;
        check.addEventListener('click', checkMatchRound);
        matchList.appendChild(check);
    }

    function pairUp(letter, nameBtn) {
        // undo any existing use of this letter or this name
        Object.keys(matchPairs).forEach(l => {
            if (matchPairs[l] === nameBtn.dataset.name) delete matchPairs[l];
        });
        delete matchPairs[letter];
        matchPairs[letter] = nameBtn.dataset.name;
        renderMatchState();
    }

    function selectPin(pin, item) {
        if (answered) return;
        if (matchSel && matchSel.kind === 'name') {
            pairUp(pin.dataset.letter, matchSel.el);
            matchSel = null;
        } else {
            matchSel = { kind: 'pin', el: pin };
            renderShape(item);
        }
        renderMatchState();
    }

    function selectName(btn) {
        if (answered) return;
        if (matchSel && matchSel.kind === 'pin') {
            pairUp(matchSel.el.dataset.letter, btn);
            matchSel = null;
        } else {
            matchSel = { kind: 'name', el: btn };
        }
        renderMatchState();
    }

    function renderMatchState() {
        const nameOf = {};
        Object.keys(matchPairs).forEach(l => { nameOf[matchPairs[l]] = l; });
        [...pinsLayer.children].forEach(pin => {
            pin.classList.toggle('sel',
                !!matchSel && matchSel.kind === 'pin' && matchSel.el === pin);
            pin.classList.toggle('paired', pin.dataset.letter in matchPairs);
        });
        [...matchList.querySelectorAll('.quiz-match-name')].forEach(btn => {
            btn.classList.toggle('sel',
                !!matchSel && matchSel.kind === 'name' && matchSel.el === btn);
            const slot = btn.querySelector('.quiz-match-slot');
            slot.textContent = nameOf[btn.dataset.name] || '';
            btn.classList.toggle('paired', btn.dataset.name in nameOf);
        });
        const check = document.getElementById('quiz-match-check');
        if (check) {
            check.disabled =
                Object.keys(matchPairs).length !== currentRound().length;
        }
    }

    function checkMatchRound() {
        if (answered) return;
        const round = currentRound();
        let right = 0;
        round.forEach((item, i) => {
            const letter = MATCH_LETTERS[i];
            const ok = matchPairs[letter] === item.name;
            if (ok) right++;
            const pin = pinsLayer.querySelector('[data-letter="' + letter + '"]');
            if (pin) pin.classList.add(ok ? 'ok' : 'bad');
            const btn = matchList.querySelector(
                '.quiz-match-name[data-name="' + CSS.escape(matchPairs[letter] || '') + '"]');
            if (btn) btn.classList.add(ok ? 'correct' : 'wrong');
        });
        answered = true;
        score += right;
        scoreEl.textContent = String(score);
        feedbackEl.textContent = right === round.length
            ? 'All ' + round.length + ' correct!'
            : right + ' of ' + round.length + ' correct. Wrong pairs show the letter they were given.';
        feedbackEl.className = 'quiz-feedback ' +
            (right === round.length ? 'correct' : 'wrong');
        const check = document.getElementById('quiz-match-check');
        if (check) check.hidden = true;
        nextBtn.hidden = false;
        nextBtn.textContent = idx + MATCH_SIZE >= order.length
            ? 'See result' : 'Next round';
    }

    function next() {
        idx += (mode === 'match') ? MATCH_SIZE : 1;
        nextBtn.textContent = 'Next →';
        if (idx >= order.length) {
            resetQuestionUI();
            promptEl.textContent = '';
            resultScoreEl.textContent =
                'You scored ' + score + ' / ' + order.length + '.';
            resultEl.hidden = false;
        } else {
            showQuestion();
        }
    }

    nextBtn.addEventListener('click', next);
    restartBtn.addEventListener('click', () => start(currentKey));
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.toggle('active', t === tab));
            partsFilter = null;
            start(tab.dataset.quiz);
        });
    });

    // ---- custom quiz builder ----
    const customWrap = document.getElementById('quiz-custom');
    const partsBox = customWrap && customWrap.querySelector('#quiz-parts');
    const linkBox = customWrap && customWrap.querySelector('#quiz-link');
    const copyLinkBtn = customWrap && customWrap.querySelector('#quiz-copy-link');

    function updateUrl() {
        const p = new URLSearchParams();
        if (currentKey !== 'bones') p.set('quiz', currentKey);
        if (mode !== 'identify') p.set('mode', mode);
        if (partsFilter && partsFilter.length &&
            partsFilter.length < playable(currentKey).length) {
            p.set('parts', partsFilter.join(','));
        }
        const qs = p.toString();
        const url = location.pathname + (qs ? '?' + qs : '') + location.hash;
        history.replaceState(null, '', url);
        if (linkBox) linkBox.value = location.origin + url;
    }

    function renderCustomPanel() {
        if (!partsBox) return;
        const cfg = { items: playable(currentKey) };
        const active = new Set(pool.map(it => slug(it.name)));
        const summary = customWrap.querySelector('summary');
        if (summary) {
            summary.textContent = 'Customize this quiz' +
                (partsFilter === null || pool.length === cfg.items.length
                    ? '' : ' (' + pool.length + ' of ' + cfg.items.length +
                      ' parts selected)');
        }
        // Ticking a box re-runs start(), which lands here. Rebuilding the
        // list would destroy the checkbox the user just clicked; focus then
        // falls back to <body> and the browser jumps to the top of the page.
        // The list only needs rebuilding when the quiz set itself changed,
        // so otherwise just sync the checked state in place.
        const existing = [...partsBox.querySelectorAll('input')];
        const sameSet = existing.length === cfg.items.length &&
            existing.every((inp, i) => inp.value === slug(cfg.items[i].name));
        if (sameSet) {
            existing.forEach(inp => { inp.checked = active.has(inp.value); });
            return;
        }
        partsBox.innerHTML = '';
        cfg.items.forEach(item => {
            const id = 'part-' + slug(item.name);
            const label = document.createElement('label');
            label.className = 'quiz-part';
            label.innerHTML = '<input type="checkbox" id="' + id + '" value="' +
                slug(item.name) + '"' +
                (active.has(slug(item.name)) ? ' checked' : '') + '> ' + item.name;
            label.querySelector('input').addEventListener('change', () => {
                const checked = [...partsBox.querySelectorAll('input:checked')]
                    .map(i => i.value);
                partsFilter = checked.length === cfg.items.length ? null : checked;
                start(currentKey);
            });
            partsBox.appendChild(label);
        });
    }

    if (customWrap) {
        customWrap.querySelector('#quiz-parts-all').addEventListener('click', () => {
            partsFilter = null;
            start(currentKey);
        });
        customWrap.querySelector('#quiz-parts-none').addEventListener('click', () => {
            partsFilter = [];
            start(currentKey);
        });
        if (copyLinkBtn) {
            copyLinkBtn.addEventListener('click', () => {
                const done = () => {
                    copyLinkBtn.textContent = 'Copied!';
                    setTimeout(() => { copyLinkBtn.textContent = 'Copy link'; }, 1500);
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(linkBox.value).then(done);
                } else {
                    linkBox.select();
                    document.execCommand('copy');
                    done();
                }
            });
        }
    }

    // ---- boot from URL ----
    (() => {
        const p = new URLSearchParams(location.search);
        const q = p.get('quiz');
        if (q && QUIZZES[q]) currentKey = q;
        const m = p.get('mode');
        if (m && MODES[m]) mode = m;
        const parts = (p.get('parts') || '').split(',').map(s => s.trim())
            .filter(Boolean);
        if (parts.length) partsFilter = parts;
        tabs.forEach(t => t.classList.toggle('active', t.dataset.quiz === currentKey));
        syncModeBar();
        if (customWrap && (partsFilter || (m && m !== 'identify'))) {
            customWrap.open = true;
        }
    })();

    cloudReady.then(() => start(currentKey));
})();
