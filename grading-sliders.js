// Every slider in the socket walkthrough that an answer key can give green / caution / critical
// ranges to. Shared by the answer key editor (answer-key-editor.js), which sets the ranges, and the
// comparison (walkthrough-grading.js), which grades against them. Ranges, steps and units are the
// walkthrough's own (socket-walkthrough-sample.html / .js); `step` is the walkthrough step it lives in.
export const SLIDERS = [
    { step: '1', group: 'Step 1 · Import and scale', key: 'scaleFactor', label: 'Scale Factor', unit: '', min: 0.9, max: 1, inc: 0.01 },
    { step: '2d', group: 'Step 2d · Interface positioning', key: 'lateral', label: 'Lateral Angle', unit: '°', min: -180, max: 180, inc: 1, angle: true },
    { step: '2d', group: 'Step 2d · Interface positioning', key: 'medial', label: 'Medial Angle', unit: '°', min: -180, max: 180, inc: 1, angle: true },
    { step: '2d', group: 'Step 2d · Interface positioning', key: 'rotation', label: 'Interface Rotation', unit: '°', min: -180, max: 180, inc: 1, angle: true },
    { step: '2d', group: 'Step 2d · Interface positioning', key: 'adjustX', label: 'Interface X Adjust', unit: 'mm', min: -50, max: 50, inc: 1 },
    { step: '2d', group: 'Step 2d · Interface positioning', key: 'adjustY', label: 'Interface Y Adjust', unit: 'mm', min: -50, max: 50, inc: 1 },
    { step: '2d', group: 'Step 2d · Interface positioning', key: 'adjustZ', label: 'Interface Z Adjust', unit: 'mm', min: -50, max: 50, inc: 1 },
    { step: '3', group: 'Step 3 · Socket latticing', key: 'minThickness', label: 'Min Lattice Thickness', unit: 'mm', min: 0, max: 20, inc: 1 },
    { step: '3', group: 'Step 3 · Socket latticing', key: 'maxThickness', label: 'Max Lattice Thickness', unit: 'mm', min: 0, max: 20, inc: 1 },
    { step: '3', group: 'Step 3 · Socket latticing', key: 'spatialWeighting', label: 'Spatial Weighting', unit: '', min: 0, max: 1, inc: 0.1 },
    { step: '3', group: 'Step 3 · Socket latticing', key: 'pointDensity', label: 'Lattice Point Density', unit: 'pts', min: 1, max: 100, inc: 1 },
    { step: '4b', group: 'Step 4b · Hole parameters', key: 'attachDiameter', label: 'Attachment Diameter', unit: 'mm', min: 6, max: 24, inc: 0.5 },
    { step: '4b', group: 'Step 4b · Hole parameters', key: 'shankDiameter', label: 'Shank Diameter', unit: 'mm', min: 1, max: 7.5, inc: 0.25 },
    { step: '4b', group: 'Step 4b · Hole parameters', key: 'gripLength', label: 'Grip Length', unit: 'mm', min: 0, max: 8, inc: 0.2 },
    { step: '4b', group: 'Step 4b · Hole parameters', key: 'headDiameter', label: 'Head Diameter', unit: 'mm', min: 3, max: 16, inc: 0.25 },
    { step: '4b', group: 'Step 4b · Hole parameters', key: 'headHeight', label: 'Head Height', unit: 'mm', min: 0, max: 6, inc: 0.2 },
    { step: '5', group: 'Step 5 · Blending', key: 'minBlend', label: 'Min Blend', unit: 'mm', min: 0, max: 60, inc: 5 },
    { step: '5', group: 'Step 5 · Blending', key: 'maxBlend', label: 'Max Blend', unit: 'mm', min: 0, max: 60, inc: 5 },
    { step: '5', group: 'Step 5 · Blending', key: 'connectorRadius', label: 'Connector Blend Radius', unit: 'mm', min: 0, max: 30, inc: 1 },
];

export const sliderByKey = Object.fromEntries(SLIDERS.map(slider => [slider.key, slider]));

// Where a value sits against a band { green: [lo, hi], yellow: [lo, hi] }: 'match' inside green,
// 'close' inside yellow, 'off' outside both. Angles are wrapped to -180..180 first.
export function bandStatus(band, value) {
    const v = Number(value);
    if (!band || !Number.isFinite(v)) return null;
    const [g0, g1] = band.green;
    const [y0, y1] = band.yellow;
    if (v >= g0 - 1e-9 && v <= g1 + 1e-9) return 'match';
    if (v >= y0 - 1e-9 && v <= y1 + 1e-9) return 'close';
    return 'off';
}

// Painted regions are lists of brush dabs { p: [x, y, z] mm, r: mm }; a point is inside when it is
// within some dab's radius. Returns how far outside the nearest dab's edge the point is (0 inside).
export function regionDistance(dabs, point) {
    let best = Infinity;
    for (const dab of dabs || []) {
        const d = Math.hypot(point[0] - dab.p[0], point[1] - dab.p[1], point[2] - dab.p[2]) - dab.r;
        if (d < best) best = d;
    }
    return best <= 0 ? 0 : best;
}

// Pair every painted zone with a different point inside it, as many as possible (a point can only
// fill one hole). Returns { zoneToPoint: [index or -1], filled } via augmenting paths; the lists are tiny.
export function matchZones(zones, points) {
    const inside = zones.map(zone => points.map((point, j) => regionDistance(zone.dabs, point) === 0 ? j : -1).filter(j => j >= 0));
    const pointToZone = new Array(points.length).fill(-1);
    const tryZone = (z, seen) => {
        for (const j of inside[z]) {
            if (seen.has(j)) continue;
            seen.add(j);
            if (pointToZone[j] === -1 || tryZone(pointToZone[j], seen)) { pointToZone[j] = z; return true; }
        }
        return false;
    };
    zones.forEach((_, z) => tryZone(z, new Set()));
    const zoneToPoint = zones.map((_, z) => pointToZone.indexOf(z));
    return { zoneToPoint, filled: zoneToPoint.filter(j => j >= 0).length };
}

// A plane against an acceptance rule. { axis, spot, normalAxis }: that one bounding-box pick, the
// others free (a plane facing along an axis does not move with the other two picks). { pick, normalAxis }:
// all three picks. Either way the normal has to lie along normalAxis, pointing either way unless the rule
// gives `normal`, whose direction then has to match.
// Returns which fields are right: { pick: [x, y, z], normal }.
export function planeFieldChecks(rule, state) {
    const pick = (state?.pick || []).map(Number);
    const normal = (state?.normal || [0, 0, 0]).map(Number);
    const pickOk = [0, 1, 2].map(i => (rule.pick ? pick[i] === rule.pick[i] : i !== rule.axis || pick[i] === rule.spot));
    const along = normal[rule.normalAxis];
    // rule.normal, when given, fixes the direction too (the interface plane's normal points into the part).
    const wantSign = rule.normal ? Math.sign(rule.normal[rule.normalAxis]) : 0;
    const normalOk = Number.isFinite(along) && Math.abs(along) > 1e-6 && (!wantSign || Math.sign(along) === wantSign)
        && normal.every((n, i) => i === rule.normalAxis || Math.abs(n) < 1e-6);
    return { pick: pickOk, normal: normalOk };
}
export function planeAccepted(rule, state) {
    if (!rule) return true;
    const checks = planeFieldChecks(rule, state);
    return checks.pick.every(Boolean) && checks.normal;
}

// Every painted area of an answer key's attachment designs, as one list: a point is fine when it is
// inside any of them.
export function allAttachmentZones(key) {
    return Object.values(key?.attachmentZones || {}).flatMap(set => set.zones || []).filter(zone => zone.dabs?.length);
}
