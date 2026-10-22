// surface-interpolator.html: mount the interpolator panel full-width. ?solid=<site path>&surfaces=<p1>,<p2>,...
// loads files from the site (testing, and linking to a set).
import { createInterpolatorPanel } from './surface-interpolate-ui.js';
import { modelUrl } from './model-base.js?v=2';

// sample-models/ files live in the model bucket (model-base.js), not on GitHub Pages.
const SAMPLE = 'sample-models/interpolate-sample/';
const panel = createInterpolatorPanel(document.getElementById('si-root'), {
    sample: { solid: modelUrl(SAMPLE + 'ollie-solid.obj'),
        surfaces: ['ollie-surface-1.stl', 'ollie-surface-2.obj', 'ollie-surface-3.stl'].map(f => modelUrl(SAMPLE + f)) },
});

const params = new URLSearchParams(location.search);
if (params.get('solid')) {
    const solid = params.get('solid');
    const surfaces = (params.get('surfaces') || '').split(',').filter(Boolean);
    panel.load(modelUrl(solid), solid.split('/').pop(), surfaces.map(p => ({ source: modelUrl(p), name: p.split('/').pop() })));
}
window.__si = panel;
