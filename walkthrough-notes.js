// Notes on the walkthrough, built the way the design review page does them: a written note or a
// drawing belongs to the step and the camera angle it was made from, so a drawing only shows while
// you are looking from roughly that angle, and the history flies you back to the rest.
// Everything is kept in this browser (localStorage); nothing is sent anywhere.

export const PEN_COLORS = ['#ff3fa4', '#ffd400', '#00c2ff', '#3ddc84', '#1b2530'];
const SKETCH_WIDTH = 2.5;
const STORE_KEY = 'gap-walkthrough-notes-v1';
const OPEN_KEY = 'gap-walkthrough-notes-open';

const uid = () => Math.random().toString(36).slice(2, 10);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function when(iso) {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    const today = new Date();
    const sameDay = at.toDateString() === today.toDateString();
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return sameDay ? time : `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
}

export function createWalkthroughNotes({ THREE, camera, controls, stage, currentStep, goToStep, onDrawingChange }) {
    const app = document.getElementById('workflow-app');
    const panel = document.getElementById('notes-panel');
    const listEl = document.getElementById('notes-list');
    const countEl = document.getElementById('notes-count');
    const formEl = document.getElementById('notes-add');
    const textEl = document.getElementById('notes-text');
    const stepTagEl = document.getElementById('notes-step-tag');
    const toolButton = document.getElementById('notes-tool');
    const drawButton = document.getElementById('notes-draw');
    const drawPanel = document.getElementById('notes-draw-panel');
    const sketchCanvas = document.getElementById('notes-sketch');
    const chipEl = document.getElementById('notes-sketch-chip');
    if (!panel || !sketchCanvas) return { tick() {}, setStep() {}, isDrawing: () => false };

    const context = sketchCanvas.getContext('2d');
    let notes = [];
    let drawing = false;
    let stroke = null;
    let penColor = PEN_COLORS[0];
    let dirty = true;
    let signature = '';
    let chipCycle = 0;
    let controlsWereEnabled = true;

    // ---- the notes themselves ------------------------------------------------------------
    function load() {
        try {
            const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
            notes = Array.isArray(raw) ? raw.filter(note => note && note.id) : [];
        } catch { notes = []; }
    }
    function save() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(notes)); } catch { /* private window */ }
    }
    const cameraNow = () => ({
        p: camera.position.toArray().map(v => +v.toFixed(4)),
        t: controls.target.toArray().map(v => +v.toFixed(4)),
    });

    // A drawing belongs to the angle it was made from, so it shows only from near that angle.
    function viewMatches(note) {
        if (!note?.camera?.p || !note.camera.t) return false;
        if (note.step !== currentStep()) return false;
        const p = new THREE.Vector3().fromArray(note.camera.p);
        const t = new THREE.Vector3().fromArray(note.camera.t);
        const reach = Math.max(1e-6, p.distanceTo(t)) * 0.05;
        return camera.position.distanceTo(p) < reach && controls.target.distanceTo(t) < reach;
    }
    const sketches = () => notes.filter(note => note.kind === 'sketch');

    // ---- the panel -------------------------------------------------------------------------
    // The notes are a column of the app grid, so opening them narrows the viewer rather than
    // covering it. The viewer's own ResizeObserver picks up the new width.
    const isOpen = () => !app?.classList.contains('notes-hidden');
    function setOpen(on, stopDrawing = true) {
        app?.classList.toggle('notes-hidden', !on);
        panel.setAttribute('aria-hidden', String(!on));
        toolButton?.classList.toggle('active', on);
        toolButton?.setAttribute('aria-pressed', String(on));
        toolButton?.setAttribute('aria-label', on ? 'Hide notes' : 'Show notes');
        toolButton?.setAttribute('title', on ? 'Hide the notes column' : 'Show the notes column');
        const closeIcon = panel.querySelector('[data-notes-close] svg');
        if (closeIcon) closeIcon.style.opacity = '1';
        try { localStorage.setItem(OPEN_KEY, on ? '1' : '0'); } catch { /* private window */ }
        // Closing the sheet to make room for a drawing must not also end the drawing.
        if (!on && drawing && stopDrawing) setDrawing(false);
        dirty = true;
    }

    const TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

    function render() {
        const step = currentStep();
        if (stepTagEl) stepTagEl.textContent = 'Step ' + step;
        if (countEl) countEl.textContent = notes.length ? String(notes.length) : '';
        listEl.innerHTML = notes.length
            ? notes.map((note, index) => {
                const where = note.kind === 'sketch'
                    ? `drawing on Step ${escapeHTML(note.step)}`
                    : `Step ${escapeHTML(note.step)}`;
                const colour = note.kind === 'sketch' ? escapeHTML(note.color || PEN_COLORS[0]) : '#003262';
                return `<li class="notes-anno-row${note.step === step ? ' is-here' : ''}" data-note="${note.id}">
                    <button type="button" class="notes-anno-jump" data-go="${note.id}" title="Go back to this step and view">
                        <span class="notes-anno-num" style="--num:${colour}">${index + 1}</span>
                        <span class="notes-anno-where">${where}</span>
                    </button>
                    <span class="notes-anno-when">${escapeHTML(when(note.at))}</span>
                    <button type="button" class="notes-anno-del" data-remove="${note.id}" aria-label="Delete this note" title="Delete">${TRASH}</button>
                    <textarea class="notes-anno-note" data-edit="${note.id}" rows="2" placeholder="${note.kind === 'sketch' ? 'What is this drawing about?' : 'Your note'}">${escapeHTML(note.text || '')}</textarea>
                </li>`;
            }).join('')
            : '<li class="notes-anno-empty">Nothing yet. Write a note about the step you are on, or press the pencil and draw on the view.</li>';
        dirty = true;
    }

    // ---- flying back to a note ---------------------------------------------------------------
    let flight = null;
    function flyTo(target) {
        if (!target?.camera?.p) return;
        flight = {
            fromP: camera.position.clone(), fromT: controls.target.clone(),
            toP: new THREE.Vector3().fromArray(target.camera.p),
            toT: new THREE.Vector3().fromArray(target.camera.t),
            start: performance.now(), ms: 420,
        };
    }
    function stepFlight(now) {
        if (!flight) return;
        const k = Math.min(1, (now - flight.start) / flight.ms);
        const ease = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;
        camera.position.lerpVectors(flight.fromP, flight.toP, ease);
        controls.target.lerpVectors(flight.fromT, flight.toT, ease);
        controls.update();
        dirty = true;
        if (k >= 1) flight = null;
    }

    function goToNote(id) {
        const note = notes.find(n => n.id === id);
        if (!note) return;
        if (note.step !== currentStep()) {
            goToStep(note.step);
            setTimeout(() => flyTo(note), 160);
        } else {
            flyTo(note);
        }
    }

    // ---- drawing -----------------------------------------------------------------------------
    // On a phone the notes sheet covers the view, so it steps aside while a line is drawn.
    const narrow = matchMedia('(max-width: 880px)');
    let reopenAfterDrawing = false;

    function setDrawing(on) {
        drawing = !!on;
        if (narrow.matches) {
            if (drawing && isOpen()) { reopenAfterDrawing = true; setOpen(false, false); }
            else if (!drawing && reopenAfterDrawing) { reopenAfterDrawing = false; setOpen(true, false); }
        }
        stage.classList.toggle('is-sketching', drawing);
        sketchCanvas.classList.toggle('is-live', drawing);
        drawButton?.classList.toggle('active', drawing);
        drawButton?.setAttribute('aria-pressed', String(drawing));
        if (drawPanel) drawPanel.hidden = !drawing;
        if (drawing) {
            controlsWereEnabled = controls.enabled;
            controls.enabled = false;
        } else {
            controls.enabled = controlsWereEnabled;
            stroke = null;
        }
        onDrawingChange?.(drawing);
        dirty = true;
    }

    function pointAt(event) {
        const rect = sketchCanvas.getBoundingClientRect();
        return [
            Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
            Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
        ].map(v => +v.toFixed(4));
    }

    sketchCanvas.addEventListener('pointerdown', event => {
        if (!drawing || event.button !== 0) return;
        event.preventDefault();
        try { sketchCanvas.setPointerCapture(event.pointerId); } catch { /* synthetic events */ }
        stroke = { pts: [pointAt(event)], color: penColor, width: SKETCH_WIDTH };
        dirty = true;
    });
    sketchCanvas.addEventListener('pointermove', event => {
        if (!stroke) return;
        const point = pointAt(event);
        const last = stroke.pts[stroke.pts.length - 1];
        if (Math.hypot(point[0] - last[0], point[1] - last[1]) > 0.003) { stroke.pts.push(point); dirty = true; }
    });
    function endStroke() {
        if (!stroke) return;
        const shape = stroke;
        stroke = null;
        dirty = true;
        if (shape.pts.length < 2) shape.pts.push([shape.pts[0][0] + 0.002, shape.pts[0][1]]);
        // Lines drawn from the same angle on the same step join one note.
        const here = sketches().find(viewMatches);
        if (here) {
            here.shapes.push(shape);
            here.color = shape.color;
            here.at = new Date().toISOString();
        } else {
            notes.push({
                id: uid(), kind: 'sketch', step: currentStep(), text: '',
                color: shape.color, shapes: [shape], camera: cameraNow(), at: new Date().toISOString(),
            });
        }
        save();
        render();
    }
    sketchCanvas.addEventListener('pointerup', endStroke);
    sketchCanvas.addEventListener('pointercancel', endStroke);

    drawPanel?.querySelectorAll('[data-pen]').forEach(swatch => swatch.addEventListener('click', () => {
        penColor = swatch.dataset.pen;
        drawPanel.querySelectorAll('[data-pen]').forEach(other => other.classList.toggle('active', other === swatch));
    }));
    drawPanel?.querySelector('[data-pen-undo]')?.addEventListener('click', () => {
        const here = sketches().find(viewMatches);
        if (!here) return;
        here.shapes.pop();
        if (!here.shapes.length && !here.text) notes.splice(notes.indexOf(here), 1);
        save();
        render();
    });
    drawPanel?.querySelector('[data-pen-done]')?.addEventListener('click', () => setDrawing(false));
    drawButton?.addEventListener('click', () => setDrawing(!drawing));
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && drawing && !event.target.closest?.('input, textarea, select')) setDrawing(false);
    });

    // ---- painting the drawings ----------------------------------------------------------------
    function paint() {
        const w = sketchCanvas.clientWidth;
        const h = sketchCanvas.clientHeight;
        if (!w || !h) return;
        const sig = `${w}x${h}|${currentStep()}|${camera.position.toArray().map(v => v.toFixed(3))}|${controls.target.toArray().map(v => v.toFixed(3))}|${notes.length}|${drawing}`;
        if (!dirty && sig === signature) return;
        signature = sig;
        dirty = false;
        const dpr = Math.min(window.devicePixelRatio, 2);
        if (sketchCanvas.width !== Math.round(w * dpr) || sketchCanvas.height !== Math.round(h * dpr)) {
            sketchCanvas.width = Math.round(w * dpr);
            sketchCanvas.height = Math.round(h * dpr);
        }
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, w, h);
        const line = shape => {
            const pts = shape.pts || [];
            if (pts.length < 2) return;
            context.strokeStyle = shape.color || PEN_COLORS[0];
            context.lineWidth = shape.width || SKETCH_WIDTH;
            context.lineJoin = 'round';
            context.lineCap = 'round';
            context.shadowColor = 'rgba(255, 255, 255, 0.75)';
            context.shadowBlur = 2;
            context.beginPath();
            pts.forEach(([x, y], index) => (index ? context.lineTo(x * w, y * h) : context.moveTo(x * w, y * h)));
            context.stroke();
            context.shadowBlur = 0;
        };
        sketches().filter(viewMatches).forEach(note => note.shapes.forEach(line));
        if (stroke) line(stroke);

        const away = sketches().filter(note => !viewMatches(note));
        if (chipEl) {
            chipEl.hidden = away.length === 0 || drawing;
            chipEl.textContent = away.length ? `${away.length} drawing${away.length === 1 ? '' : 's'} on another view` : '';
        }
    }

    // ---- wiring ---------------------------------------------------------------------------------
    formEl?.addEventListener('submit', event => {
        event.preventDefault();
        const text = textEl.value.trim();
        if (!text) return;
        notes.push({ id: uid(), kind: 'text', step: currentStep(), text, camera: cameraNow(), at: new Date().toISOString() });
        textEl.value = '';
        save();
        render();
    });
    textEl?.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) formEl.requestSubmit();
    });
    listEl.addEventListener('input', event => {
        const field = event.target.closest('[data-edit]');
        if (!field) return;
        const note = notes.find(n => n.id === field.dataset.edit);
        if (!note) return;
        note.text = field.value;
        save();
    });
    listEl.addEventListener('click', event => {
        const remove = event.target.closest('[data-remove]');
        if (remove) {
            notes = notes.filter(note => note.id !== remove.dataset.remove);
            save();
            render();
            return;
        }
        const go = event.target.closest('[data-go]');
        if (go) goToNote(go.dataset.go);
    });
    chipEl?.addEventListener('click', () => {
        const away = sketches().filter(note => !viewMatches(note));
        if (!away.length) return;
        goToNote(away[chipCycle++ % away.length].id);
    });
    panel.querySelector('[data-notes-close]')?.addEventListener('click', () => setOpen(false));
    toolButton?.addEventListener('click', () => setOpen(!isOpen()));

    load();
    render();
    // Closed until it is asked for, like the review page's notes column.
    let open = false;
    try { open = localStorage.getItem(OPEN_KEY) === '1'; } catch { /* private window */ }
    setOpen(open);

    return {
        tick(now = performance.now()) { stepFlight(now); paint(); },
        setStep() { render(); dirty = true; },
        isDrawing: () => drawing,
        isOpen,
        setOpen,
        all: () => notes.map(note => ({ ...note })),
        clear() { notes = []; save(); render(); },
    };
}
