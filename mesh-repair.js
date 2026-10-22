// Mesh health check and repair for the Give a Paw site: the engine behind mesh-check.html.
// Takes the raw triangles that model-convert.js reads out of an STL / OBJ / 3MF / GLB, runs the
// sweep of checks students most often trip over in nTop, fixes what can be fixed safely, and reports
// what it found, what it changed and what still needs a human. Everything runs in the browser.
//
// The mesh is kept as two typed arrays: `pos` (Float64, xyz per vertex, in the file's own units and
// frame, nothing is re-oriented or rescaled) and `idx` (Uint32, three vertex numbers per triangle).
// Each stage rebuilds the edge table it needs; students' exports are tens of thousands to a couple
// of million triangles and every stage here is linear or near-linear in that count, except the
// self-intersection sweep, which works cell by cell on a uniform grid and stops at a time budget.
//
// Stages, in the order they run (later stages assume the earlier ones have cleaned up):
//   1. bad numbers      NaN / infinite coordinates             -> triangles dropped
//   2. unwelded seams   coincident vertices stored twice        -> merged (closes pinholes / cracks)
//   3. degenerate       repeated-vertex and duplicate triangles -> dropped
//   4. shells           connected pieces, loose debris          -> tiny debris dropped
//   5. winding          triangles facing the wrong way          -> flipped to match their neighbours
//   6. inverted shells  closed shell with normals pointing in   -> whole shell flipped
//   7. non-manifold     edges with 3+ triangles, bow-tie verts  -> reported (highlighted)
//   8. holes            open boundary loops                     -> small ones filled, big ones reported
//   9. slivers          needle and cap triangles                -> collapsed / edge-flipped
//  10. self-intersect   triangles passing through each other    -> reported; overlapping shells
//                                                                   are merged (Boolean union) when
//                                                                   every shell is a clean solid
//
// Used by mesh-check.js. Pure data in, pure data out; no DOM in here.

import { weld } from './model-convert.js';

const tick = () => new Promise(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0); });

const MANIFOLD_URL = 'https://cdn.jsdelivr.net/npm/manifold-3d@3.0.1/manifold.js';
const MANIFOLD_WASM = 'https://cdn.jsdelivr.net/npm/manifold-3d@3.0.1/manifold.wasm';

export const DEFAULTS = {
    fillHoles: true,          // fill boundary loops that are small next to the model
    removeDebris: true,       // drop shells that are tiny next to the model
    mergeShells: true,        // Boolean-union overlapping closed shells (Manifold, downloaded on demand)
    checkIntersections: true, // the self-intersection sweep (the slow one)
    intersectionBudgetMs: 20000,
    holeMaxEdges: 150,        // a hole is "small" when its loop has at most this many edges...
    holeMaxFraction: 0.10,    // ...and spans at most this fraction of the model diagonal
    debrisMaxFraction: 0.02,  // a shell is debris when it spans at most this fraction of the diagonal...
    debrisMaxFaces: 0.05,     // ...and has at most this fraction of the triangles
    sliverAngleDeg: 3.0,      // a triangle with a corner sharper than this is a sliver
};

/* ------------------------------------------------------------------------------------------------
   Small vector helpers on flat arrays
------------------------------------------------------------------------------------------------ */
function boundsOf(pos) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i], y = pos[i + 1], z = pos[i + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const diagonal = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    return { min: [x0, y0, z0], max: [x1, y1, z1], size: [x1 - x0, y1 - y0, z1 - z0], diagonal };
}

function faceNormal(pos, idx, f, out = [0, 0, 0]) {
    const a = idx[3 * f] * 3, b = idx[3 * f + 1] * 3, c = idx[3 * f + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;   // twice the area, pointing out
    return out;
}

function faceAngles(pos, idx, f, out = [0, 0, 0]) {
    const v = [idx[3 * f] * 3, idx[3 * f + 1] * 3, idx[3 * f + 2] * 3];
    for (let k = 0; k < 3; k++) {
        const a = v[k], b = v[(k + 1) % 3], c = v[(k + 2) % 3];
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
        const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz);
        out[k] = lu && lv ? Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / (lu * lv)))) : 0;
    }
    return out;
}

const dist = (pos, a, b) => Math.hypot(pos[3 * a] - pos[3 * b], pos[3 * a + 1] - pos[3 * b + 1], pos[3 * a + 2] - pos[3 * b + 2]);

/* ------------------------------------------------------------------------------------------------
   Edge table: every undirected edge -> the triangles that use it
------------------------------------------------------------------------------------------------ */
function edgeKey(a, b, nV) { return a < b ? a * nV + b : b * nV + a; }

function buildEdges(idx, nV) {
    // Map key -> face number, or an array of face numbers once an edge has more than one.
    const map = new Map();
    const F = idx.length / 3;
    for (let f = 0; f < F; f++) {
        for (let k = 0; k < 3; k++) {
            const key = edgeKey(idx[3 * f + k], idx[3 * f + (k + 1) % 3], nV);
            const cur = map.get(key);
            if (cur === undefined) map.set(key, f);
            else if (typeof cur === 'number') map.set(key, [cur, f]);
            else cur.push(f);
        }
    }
    return map;
}
const facesOf = v => (v === undefined ? [] : typeof v === 'number' ? [v] : v);

// Which way a face uses the edge a-b: +1 if it goes a->b, -1 if b->a, 0 if it does not contain it.
function edgeDirection(idx, f, a, b) {
    for (let k = 0; k < 3; k++) {
        const p = idx[3 * f + k], q = idx[3 * f + (k + 1) % 3];
        if (p === a && q === b) return 1;
        if (p === b && q === a) return -1;
    }
    return 0;
}

/* ------------------------------------------------------------------------------------------------
   Compaction
------------------------------------------------------------------------------------------------ */
function dropFaces(mesh, alive) {
    let n = 0;
    for (let f = 0; f < alive.length; f++) if (alive[f]) n++;
    const idx = new Uint32Array(n * 3);
    let o = 0;
    for (let f = 0; f < alive.length; f++) if (alive[f]) { idx[o++] = mesh.idx[3 * f]; idx[o++] = mesh.idx[3 * f + 1]; idx[o++] = mesh.idx[3 * f + 2]; }
    mesh.idx = idx;
}

function dropUnusedVertices(mesh) {
    const nV = mesh.pos.length / 3;
    const remap = new Int32Array(nV).fill(-1);
    let n = 0;
    for (let i = 0; i < mesh.idx.length; i++) if (remap[mesh.idx[i]] < 0) remap[mesh.idx[i]] = n++;
    const pos = new Float64Array(n * 3);
    for (let v = 0; v < nV; v++) { const t = remap[v]; if (t >= 0) { pos[3 * t] = mesh.pos[3 * v]; pos[3 * t + 1] = mesh.pos[3 * v + 1]; pos[3 * t + 2] = mesh.pos[3 * v + 2]; } }
    for (let i = 0; i < mesh.idx.length; i++) mesh.idx[i] = remap[mesh.idx[i]];
    mesh.pos = pos;
}

// Highlight geometry for the viewer: a flat triangle soup for faces, flat segment list for edges.
function soupOf(mesh, faces) {
    const out = new Float32Array(faces.length * 9);
    let o = 0;
    for (const f of faces) for (let k = 0; k < 3; k++) { const v = mesh.idx[3 * f + k] * 3; out[o++] = mesh.pos[v]; out[o++] = mesh.pos[v + 1]; out[o++] = mesh.pos[v + 2]; }
    return out;
}
function segmentsOf(pos, pairs) {
    const out = new Float32Array(pairs.length * 3);
    let o = 0;
    for (const v of pairs) { out[o++] = pos[3 * v]; out[o++] = pos[3 * v + 1]; out[o++] = pos[3 * v + 2]; }
    return out;
}

/* ------------------------------------------------------------------------------------------------
   The report
------------------------------------------------------------------------------------------------ */
// status: ok | fixed | warn | fail | skipped.  highlight: { faces: Float32Array soup } and/or { edges: Float32Array segments }
function finding(key, status, summary, extra = {}) { return { key, status, summary, ...extra }; }

/* ------------------------------------------------------------------------------------------------
   1. bad numbers
------------------------------------------------------------------------------------------------ */
function dropNonFinite(positions) {
    const F = positions.length / 9;
    let bad = 0;
    for (let f = 0; f < F; f++) for (let k = 0; k < 9; k++) if (!Number.isFinite(positions[9 * f + k])) { bad++; break; }
    if (!bad) return { positions, bad: 0 };
    const out = new Float32Array((F - bad) * 9);
    let o = 0;
    for (let f = 0; f < F; f++) {
        let ok = true;
        for (let k = 0; k < 9; k++) if (!Number.isFinite(positions[9 * f + k])) { ok = false; break; }
        if (ok) { out.set(positions.subarray(9 * f, 9 * f + 9), o); o += 9; }
    }
    return { positions: out, bad };
}

/* ------------------------------------------------------------------------------------------------
   2. welding
------------------------------------------------------------------------------------------------ */
function indexed(positions, tolerance) {
    const g = weld(positions, tolerance);
    const p = g.attributes.position.array;
    const pos = new Float64Array(p.length);
    for (let i = 0; i < p.length; i++) pos[i] = p[i];
    const idx = new Uint32Array(g.index.array);
    g.dispose();
    return { pos, idx };
}

// Merge every vertex that has another within `tol` (Chebyshev distance), on an already indexed mesh.
// A real tolerance weld: each vertex is checked against the 27 grid cells around it, so two points a
// hair apart never miss each other because they rounded into different cells (which the fast hashed
// weld in model-convert.js can do). Returns the vertices that were merged away.
function weldWithin(mesh, tol, allowed) {
    const { pos, idx } = mesh;
    const nV = pos.length / 3;
    const inv = 1 / tol;
    const cells = new Map();   // cell key -> vertex numbers kept so far in that cell
    const target = new Int32Array(nV);
    const key = (ix, iy, iz) => (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791);
    const merged = [];
    for (let v = 0; v < nV; v++) {
        if (allowed && !allowed[v]) { target[v] = v; continue; }
        const x = pos[3 * v], y = pos[3 * v + 1], z = pos[3 * v + 2];
        const ix = Math.floor(x * inv), iy = Math.floor(y * inv), iz = Math.floor(z * inv);
        let found = -1;
        for (let dx = -1; dx <= 1 && found < 0; dx++) for (let dy = -1; dy <= 1 && found < 0; dy++) for (let dz = -1; dz <= 1 && found < 0; dz++) {
            const list = cells.get(key(ix + dx, iy + dy, iz + dz));
            if (!list) continue;
            for (const u of list) if (Math.abs(pos[3 * u] - x) <= tol && Math.abs(pos[3 * u + 1] - y) <= tol && Math.abs(pos[3 * u + 2] - z) <= tol) { found = u; break; }
        }
        if (found >= 0) { target[v] = found; merged.push(v); }
        else { target[v] = v; const k = key(ix, iy, iz); const list = cells.get(k); if (list) list.push(v); else cells.set(k, [v]); }
    }
    if (merged.length) for (let i = 0; i < idx.length; i++) idx[i] = target[idx[i]];
    return merged;
}

function medianEdge(mesh) {
    const F = mesh.idx.length / 3;
    const step = Math.max(1, Math.floor(F / 20000));   // a sample is plenty for a median
    const lengths = [];
    for (let f = 0; f < F; f += step) lengths.push(dist(mesh.pos, mesh.idx[3 * f], mesh.idx[3 * f + 1]));
    lengths.sort((a, b) => a - b);
    return lengths[Math.floor(lengths.length / 2)] || 0;
}

/* ------------------------------------------------------------------------------------------------
   3. degenerate and duplicate triangles
------------------------------------------------------------------------------------------------ */
function dropDegenerate(mesh) {
    const F = mesh.idx.length / 3;
    const alive = new Uint8Array(F).fill(1);
    const seen = new Set();
    const nV = mesh.pos.length / 3;
    let collapsed = 0, duplicates = 0;
    const dupFaces = [];
    for (let f = 0; f < F; f++) {
        const a = mesh.idx[3 * f], b = mesh.idx[3 * f + 1], c = mesh.idx[3 * f + 2];
        if (a === b || b === c || a === c) { alive[f] = 0; collapsed++; continue; }
        // Same three vertices in any order (so a back-to-back pair counts as a duplicate too).
        const lo = Math.min(a, b, c), hi = Math.max(a, b, c), mid = a + b + c - lo - hi;
        const key = (lo * nV + mid) * nV + hi;   // exact while nV^3 < 2^53, i.e. under ~200,000 vertices...
        const k = nV > 200000 ? `${lo},${mid},${hi}` : key;   // ...otherwise fall back to strings
        if (seen.has(k)) { alive[f] = 0; duplicates++; dupFaces.push(f); } else seen.add(k);
    }
    const soup = dupFaces.length ? soupOf(mesh, dupFaces) : null;
    if (collapsed || duplicates) dropFaces(mesh, alive);
    return { collapsed, duplicates, soup };
}

/* ------------------------------------------------------------------------------------------------
   4-6. shells, winding, inverted shells  (one traversal does all three)
------------------------------------------------------------------------------------------------ */
function orientAndLabel(mesh, edges) {
    const { idx, pos } = mesh;
    const F = idx.length / 3, nV = pos.length / 3;
    const comp = new Int32Array(F).fill(-1);
    const flipped = new Uint8Array(F);
    const stack = new Uint32Array(F);
    const shells = [];
    for (let seed = 0; seed < F; seed++) {
        if (comp[seed] >= 0) continue;
        const id = shells.length;
        let top = 0, size = 0, flips = 0;
        stack[top++] = seed; comp[seed] = id;
        const members = [];
        while (top) {
            const f = stack[--top];
            members.push(f); size++;
            for (let k = 0; k < 3; k++) {
                const a = idx[3 * f + k], b = idx[3 * f + (k + 1) % 3];
                const list = facesOf(edges.get(edgeKey(a, b, nV)));
                for (const g of list) {
                    if (g === f || comp[g] >= 0) continue;
                    comp[g] = id;
                    if (list.length === 2 && edgeDirection(idx, g, a, b) === 1) {
                        // g walks the edge the same way f does: it faces the other way. Turn it round.
                        const t = idx[3 * g + 1]; idx[3 * g + 1] = idx[3 * g + 2]; idx[3 * g + 2] = t;
                        flipped[g] = 1; flips++;
                    }
                    stack[top++] = g;
                }
            }
        }
        // The seed decided which way "right" was. If most triangles had to turn, the seed was the odd one out.
        if (flips * 2 > size) {
            for (const f of members) {
                const t = idx[3 * f + 1]; idx[3 * f + 1] = idx[3 * f + 2]; idx[3 * f + 2] = t;
                flipped[f] ^= 1;
            }
            flips = size - flips;
        }
        shells.push({ id, faces: members, flips });
    }
    // Per shell: bounds, open edges, signed volume.
    for (const s of shells) {
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, vol = 0, open = 0;
        for (const f of s.faces) {
            const a = idx[3 * f] * 3, b = idx[3 * f + 1] * 3, c = idx[3 * f + 2] * 3;
            for (const v of [a, b, c]) {
                const x = pos[v], y = pos[v + 1], z = pos[v + 2];
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
            }
            vol += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
            for (let k = 0; k < 3; k++) if (facesOf(edges.get(edgeKey(idx[3 * f + k], idx[3 * f + (k + 1) % 3], nV))).length === 1) open++;
        }
        s.bounds = { min: [x0, y0, z0], max: [x1, y1, z1], diagonal: Math.hypot(x1 - x0, y1 - y0, z1 - z0) };
        s.volume = vol / 6;
        s.openEdges = open;
        s.closed = open === 0;
    }
    return { comp, flipped, shells };
}

function flipShell(mesh, shell) {
    for (const f of shell.faces) { const t = mesh.idx[3 * f + 1]; mesh.idx[3 * f + 1] = mesh.idx[3 * f + 2]; mesh.idx[3 * f + 2] = t; }
    shell.volume = -shell.volume;
}

/* ------------------------------------------------------------------------------------------------
   7. non-manifold edges and vertices
------------------------------------------------------------------------------------------------ */
function nonManifold(mesh, edges) {
    const { idx, pos } = mesh;
    const nV = pos.length / 3, F = idx.length / 3;
    const badEdges = [];
    for (const [key, v] of edges) if (typeof v !== 'number' && v.length > 2) badEdges.push(Math.floor(key / nV), key % nV);
    // Bow-tie vertices: the triangles around a vertex should form one fan. Union the faces around
    // each vertex through the edges that contain it and count the groups.
    const count = new Uint32Array(nV + 1);
    for (let i = 0; i < idx.length; i++) count[idx[i] + 1]++;
    for (let v = 0; v < nV; v++) count[v + 1] += count[v];
    const faceAt = new Uint32Array(idx.length);
    const fill = count.slice(0, nV);
    for (let f = 0; f < F; f++) for (let k = 0; k < 3; k++) faceAt[fill[idx[3 * f + k]]++] = f;
    const badVerts = [];
    const parent = new Map();
    const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (let v = 0; v < nV; v++) {
        const start = count[v], end = count[v + 1];
        if (end - start < 2) continue;
        parent.clear();
        for (let i = start; i < end; i++) parent.set(faceAt[i], faceAt[i]);
        for (let i = start; i < end; i++) {
            const f = faceAt[i];
            for (let k = 0; k < 3; k++) {
                const a = idx[3 * f + k], b = idx[3 * f + (k + 1) % 3];
                if (a !== v && b !== v) continue;
                for (const g of facesOf(edges.get(edgeKey(a, b, nV)))) if (g !== f && parent.has(g)) { const ra = find(f), rb = find(g); if (ra !== rb) parent.set(ra, rb); }
            }
        }
        let groups = 0;
        for (let i = start; i < end; i++) if (find(faceAt[i]) === faceAt[i]) groups++;
        if (groups > 1) badVerts.push(v);
    }
    return { badEdges, badVerts };
}

/* ------------------------------------------------------------------------------------------------
   8. holes
------------------------------------------------------------------------------------------------ */
function boundaryLoops(mesh, edges) {
    const { idx, pos } = mesh;
    const nV = pos.length / 3, F = idx.length / 3;
    // Directed boundary edges a->b as their single face walks them, keyed by that face and corner.
    const boundary = [];   // [f, k] pairs
    const slot = new Map(); // edge key -> position in `boundary`
    for (let f = 0; f < F; f++) {
        for (let k = 0; k < 3; k++) {
            const a = idx[3 * f + k], b = idx[3 * f + (k + 1) % 3];
            if (facesOf(edges.get(edgeKey(a, b, nV))).length === 1) { slot.set(edgeKey(a, b, nV), boundary.length / 2); boundary.push(f, k); }
        }
    }
    // The boundary edge that follows a->b: rotate around b through the triangles until the fan ends.
    // Walking the fan (instead of just "any boundary edge leaving b") keeps two holes that touch at
    // one vertex apart from each other.
    function follow(f, k) {
        const b = idx[3 * f + (k + 1) % 3];
        let g = f, w = idx[3 * f + (k + 2) % 3];   // edge b->w is the next edge of f at b
        for (let guard = 0; guard < 100000; guard++) {
            const list = facesOf(edges.get(edgeKey(b, w, nV)));
            if (list.length === 1) {
                // b->w is a boundary edge of g: find its corner.
                for (let j = 0; j < 3; j++) if (idx[3 * g + j] === b && idx[3 * g + (j + 1) % 3] === w) return slot.get(edgeKey(b, w, nV));
                return undefined;
            }
            if (list.length !== 2) return undefined;   // non-manifold: give up on this loop
            const h = list[0] === g ? list[1] : list[0];
            // In h the edge runs w->b (consistent winding); the next edge at b is b->x.
            let x = -1;
            for (let j = 0; j < 3; j++) if (idx[3 * h + j] === b) { x = idx[3 * h + (j + 1) % 3]; break; }
            if (x < 0 || x === w) return undefined;
            g = h; w = x;
        }
        return undefined;
    }
    const loops = [];
    const used = new Uint8Array(boundary.length / 2);
    for (let s = 0; s < boundary.length / 2; s++) {
        if (used[s]) continue;
        const loop = [];
        let cur = s, guard = 0;
        while (cur !== undefined && !used[cur] && guard++ < 10000000) {
            used[cur] = 1;
            const f = boundary[2 * cur], k = boundary[2 * cur + 1];
            loop.push(idx[3 * f + k]);
            cur = follow(f, k);
        }
        const closed = cur === s;   // the walk came back to where it started
        if (loop.length >= 2) {
            let perimeter = 0, x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
            for (let i = 0; i < loop.length; i++) {
                perimeter += dist(pos, loop[i], loop[(i + 1) % loop.length]);
                const p = loop[i] * 3;
                if (pos[p] < x0) x0 = pos[p]; if (pos[p] > x1) x1 = pos[p]; if (pos[p + 1] < y0) y0 = pos[p + 1]; if (pos[p + 1] > y1) y1 = pos[p + 1]; if (pos[p + 2] < z0) z0 = pos[p + 2]; if (pos[p + 2] > z1) z1 = pos[p + 2];
            }
            loops.push({ verts: loop, perimeter, diagonal: Math.hypot(x1 - x0, y1 - y0, z1 - z0), closed });
        }
    }
    return loops;
}

// Triangles that close one loop. Ear clipping in the loop's best-fit plane for well-behaved loops,
// otherwise a fan around the centre (which adds one vertex). Returns { tris: number[], centre?: [x,y,z] }.
function fillLoop(pos, loop) {
    const n = loop.length;
    if (n < 3) return null;
    // A loop that passes through the same vertex twice is two holes touching at a point (a figure
    // of eight). Split it there and fill each lobe on its own.
    const seen = new Map();
    for (let i = 0; i < n; i++) {
        const j = seen.get(loop[i]);
        if (j !== undefined) {
            const inner = loop.slice(j, i), outer = loop.slice(0, j).concat(loop.slice(i));
            const a = fillLoop(pos, inner), b = fillLoop(pos, outer);
            if (!a && !b) return null;
            const tris = [...(a?.tris || []), ...(b?.tris || [])];
            // Fans add a centre vertex each; only one centre fits in the return shape, so if both
            // lobes needed one, fill just the first and let the next pass catch the other.
            if (a?.centre && b?.centre) return a;
            return { tris, centre: a?.centre || b?.centre };
        }
        seen.set(loop[i], i);
    }
    // Newell normal of the loop in the direction the surface walks it.
    let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
        const a = loop[i] * 3, b = loop[(i + 1) % n] * 3;
        nx += (pos[a + 1] - pos[b + 1]) * (pos[a + 2] + pos[b + 2]);
        ny += (pos[a + 2] - pos[b + 2]) * (pos[a] + pos[b]);
        nz += (pos[a] - pos[b]) * (pos[a + 1] + pos[b + 1]);
        cx += pos[a]; cy += pos[a + 1]; cz += pos[a + 2];
    }
    cx /= n; cy /= n; cz /= n;
    const len = Math.hypot(nx, ny, nz);
    if (n === 3) return { tris: [loop[2], loop[1], loop[0]] };
    if (len > 0) {
        nx /= len; ny /= len; nz /= len;
        // 2D basis in the plane.
        const ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = ax ? 0 : 1;
        let ux = ay * nz - 0 * ny, uy = 0 * nx - ax * nz, uz = ax * ny - ay * nx;
        const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
        const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
        const P = loop.map(v => [pos[3 * v] * ux + pos[3 * v + 1] * uy + pos[3 * v + 2] * uz, pos[3 * v] * vx + pos[3 * v + 1] * vy + pos[3 * v + 2] * vz]);
        // The fill faces the other way from the loop, so clip the reversed polygon.
        const order = [];
        for (let i = n - 1; i >= 0; i--) order.push(i);
        let area = 0;
        for (let i = 0; i < n; i++) { const p = P[order[i]], q = P[order[(i + 1) % n]]; area += p[0] * q[1] - q[0] * p[1]; }
        const sign = area >= 0 ? 1 : -1;
        const tris = [];
        const ring = order.slice();
        let guard = 0;
        while (ring.length > 3 && guard++ < n * n) {
            let clipped = false;
            for (let i = 0; i < ring.length; i++) {
                const i0 = ring[(i + ring.length - 1) % ring.length], i1 = ring[i], i2 = ring[(i + 1) % ring.length];
                const p0 = P[i0], p1 = P[i1], p2 = P[i2];
                const cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
                if (cross * sign <= 1e-12) continue;   // reflex corner, not an ear
                let inside = false;
                for (const j of ring) {
                    if (j === i0 || j === i1 || j === i2) continue;
                    const q = P[j];
                    const d0 = ((p1[0] - p0[0]) * (q[1] - p0[1]) - (p1[1] - p0[1]) * (q[0] - p0[0])) * sign;
                    const d1 = ((p2[0] - p1[0]) * (q[1] - p1[1]) - (p2[1] - p1[1]) * (q[0] - p1[0])) * sign;
                    const d2 = ((p0[0] - p2[0]) * (q[1] - p2[1]) - (p0[1] - p2[1]) * (q[0] - p2[0])) * sign;
                    if (d0 > 0 && d1 > 0 && d2 > 0) { inside = true; break; }
                }
                if (inside) continue;
                tris.push(loop[i0], loop[i1], loop[i2]);
                ring.splice(i, 1);
                clipped = true;
                break;
            }
            if (!clipped) break;
        }
        if (ring.length === 3) {
            tris.push(loop[ring[0]], loop[ring[1]], loop[ring[2]]);
            return { tris };
        }
    }
    // Fan around the centre: edge v_i -> v_{i+1} on the surface, so the fill goes v_{i+1} -> v_i -> centre.
    const tris = [];
    for (let i = 0; i < n; i++) tris.push(loop[(i + 1) % n], loop[i], -1);
    return { tris, centre: [cx, cy, cz] };
}

// A patch must not give any edge a third triangle. Counts the new triangles' edges against the
// existing edge table (the centre vertex, -1, is new and cannot clash with anything).
function fillIsSafe(mesh, edges, fill) {
    const nV = mesh.pos.length / 3;
    const centre = nV;   // the number the centre vertex will get
    const counts = new Map();
    for (let i = 0; i < fill.tris.length; i += 3) {
        const t = [fill.tris[i], fill.tris[i + 1], fill.tris[i + 2]].map(v => v < 0 ? centre : v);
        if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) return false;
        for (let k = 0; k < 3; k++) {
            const key = edgeKey(t[k], t[(k + 1) % 3], nV + 1);
            const existing = t[k] === centre || t[(k + 1) % 3] === centre ? 0 : facesOf(edges.get(edgeKey(t[k], t[(k + 1) % 3], nV))).length;
            const n = (counts.get(key) || existing) + 1;
            if (n > 2) return false;
            counts.set(key, n);
        }
    }
    return true;
}

function appendFaces(mesh, tris, centre) {
    let pos = mesh.pos;
    let centreIndex = -1;
    if (centre) {
        centreIndex = pos.length / 3;
        const grown = new Float64Array(pos.length + 3);
        grown.set(pos); grown.set(centre, pos.length);
        pos = grown;
    }
    const idx = new Uint32Array(mesh.idx.length + tris.length);
    idx.set(mesh.idx);
    for (let i = 0; i < tris.length; i++) idx[mesh.idx.length + i] = tris[i] < 0 ? centreIndex : tris[i];
    mesh.pos = pos; mesh.idx = idx;
}

/* ------------------------------------------------------------------------------------------------
   9. slivers
------------------------------------------------------------------------------------------------ */
function fixSlivers(mesh, edges, minAngle) {
    const { pos, idx } = mesh;
    const nV = pos.length / 3;
    const F = idx.length / 3;
    // Faces around each vertex (CSR), for the link condition and the fold checks below.
    const start = new Uint32Array(nV + 1);
    for (let i = 0; i < idx.length; i++) start[idx[i] + 1]++;
    for (let v = 0; v < nV; v++) start[v + 1] += start[v];
    const faceAt = new Uint32Array(idx.length);
    const fillPos = start.slice(0, nV);
    for (let f = 0; f < F; f++) for (let k = 0; k < 3; k++) faceAt[fillPos[idx[3 * f + k]]++] = f;
    const facesAround = v => faceAt.subarray(start[v], start[v + 1]);
    const neighbours = v => { const s = new Set(); for (const f of facesAround(v)) for (let k = 0; k < 3; k++) if (idx[3 * f + k] !== v) s.add(idx[3 * f + k]); return s; };

    const alive = new Uint8Array(F).fill(1);
    const locked = new Uint8Array(nV);   // one change per neighbourhood per pass; the edge table is not updated in between
    const ang = [0, 0, 0], n0 = [0, 0, 0], n1 = [0, 0, 0];
    let collapsed = 0, flippedEdges = 0, removed = 0;
    const touched = [];
    const lockAround = v => { locked[v] = 1; for (const f of facesAround(v)) for (let k = 0; k < 3; k++) locked[idx[3 * f + k]] = 1; };
    const normalOf = (a, b, c, out) => {
        const ux = pos[3 * b] - pos[3 * a], uy = pos[3 * b + 1] - pos[3 * a + 1], uz = pos[3 * b + 2] - pos[3 * a + 2];
        const vx = pos[3 * c] - pos[3 * a], vy = pos[3 * c + 1] - pos[3 * a + 1], vz = pos[3 * c + 2] - pos[3 * a + 2];
        out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx; return out;
    };
    const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

    for (let f = 0; f < F; f++) {
        if (!alive[f]) continue;
        const v = [idx[3 * f], idx[3 * f + 1], idx[3 * f + 2]];
        if (locked[v[0]] || locked[v[1]] || locked[v[2]]) continue;
        faceAngles(pos, idx, f, ang);
        const kMin = ang[0] <= ang[1] && ang[0] <= ang[2] ? 0 : ang[1] <= ang[2] ? 1 : 2;
        if (ang[kMin] >= minAngle) continue;
        const kMax = ang[0] >= ang[1] && ang[0] >= ang[2] ? 0 : ang[1] >= ang[2] ? 1 : 2;
        if (ang[kMax] > Math.PI - 2 * minAngle) {
            // Cap: the corner at kMax sits almost on the opposite edge p-q. Flip that edge with the
            // neighbour across it (the two new triangles must face the way the neighbour did); with
            // no neighbour (an open edge) just drop the triangle.
            const tip = v[kMax], p = v[(kMax + 1) % 3], q = v[(kMax + 2) % 3];
            const across = facesOf(edges.get(edgeKey(p, q, nV))).filter(g => g !== f && alive[g]);
            if (across.length === 1) {
                const g = across[0];
                const gv = [idx[3 * g], idx[3 * g + 1], idx[3 * g + 2]];
                const other = gv.find(x => x !== p && x !== q);
                if (other !== undefined && other !== tip && !locked[other] && edges.get(edgeKey(tip, other, nV)) === undefined && !neighbours(tip).has(other)) {
                    normalOf(gv[0], gv[1], gv[2], n0);
                    // f was (tip, p, q); the new pair is (tip, p, other) and (tip, other, q).
                    if (dot3(normalOf(tip, p, other, n1), n0) > 0 && dot3(normalOf(tip, other, q, n1), n0) > 0) {
                        idx[3 * f] = tip; idx[3 * f + 1] = p; idx[3 * f + 2] = other;
                        idx[3 * g] = tip; idx[3 * g + 1] = other; idx[3 * g + 2] = q;
                        touched.push(tip, p, q, other);
                        lockAround(tip); lockAround(other); locked[p] = locked[q] = 1;
                        flippedEdges++;
                        continue;
                    }
                }
            } else if (across.length === 0) { alive[f] = 0; removed++; touched.push(tip, p, q); lockAround(tip); continue; }
        }
        // Needle: the edge opposite the sharp corner is very short. Merge its ends (t into s) when
        // that keeps the surface a surface: s and t may only share the corners of the triangles on
        // the edge s-t (the link condition), and no triangle around t may fold over.
        const s = v[(kMin + 1) % 3], t = v[(kMin + 2) % 3];
        const ls = dist(pos, s, t), lmax = Math.max(dist(pos, v[kMin], s), dist(pos, v[kMin], t));
        if (!(ls < 0.05 * lmax)) continue;
        const onEdge = facesOf(edges.get(edgeKey(s, t, nV))).filter(g => alive[g]);
        const apexes = new Set();
        for (const g of onEdge) for (let k = 0; k < 3; k++) if (idx[3 * g + k] !== s && idx[3 * g + k] !== t) apexes.add(idx[3 * g + k]);
        const ns = neighbours(s);
        let ok = true;
        for (const u of neighbours(t)) if (u !== s && ns.has(u) && !apexes.has(u)) { ok = false; break; }
        if (!ok) continue;
        for (const g of facesAround(t)) {
            if (!alive[g] || onEdge.includes(g)) continue;
            const a = idx[3 * g], b = idx[3 * g + 1], c = idx[3 * g + 2];
            normalOf(a, b, c, n0);
            normalOf(a === t ? s : a, b === t ? s : b, c === t ? s : c, n1);
            if (dot3(n0, n1) <= 0) { ok = false; break; }
        }
        if (!ok) continue;
        for (const g of facesAround(t)) if (alive[g]) for (let k = 0; k < 3; k++) if (idx[3 * g + k] === t) idx[3 * g + k] = s;
        for (const g of onEdge) { alive[g] = 0; collapsed++; }
        touched.push(s, t);
        lockAround(s); lockAround(t);
    }
    dropFaces(mesh, alive);
    return { collapsed, flippedEdges, removed, touched };
}

/* ------------------------------------------------------------------------------------------------
   10. self-intersections
------------------------------------------------------------------------------------------------ */
// Möller's triangle-triangle test on flat arrays; p and q are offsets (x index) of the three corners.
// Touching (sharing a point or an edge within eps) does not count: students' meshes are full of
// T-junctions and we only want triangles that actually pass through each other.
function triTri(pos, p0, p1, p2, q0, q1, q2, eps) {
    const E1x = pos[p1] - pos[p0], E1y = pos[p1 + 1] - pos[p0 + 1], E1z = pos[p1 + 2] - pos[p0 + 2];
    const E2x = pos[p2] - pos[p0], E2y = pos[p2 + 1] - pos[p0 + 1], E2z = pos[p2 + 2] - pos[p0 + 2];
    let N1x = E1y * E2z - E1z * E2y, N1y = E1z * E2x - E1x * E2z, N1z = E1x * E2y - E1y * E2x;
    const n1 = Math.hypot(N1x, N1y, N1z);
    if (!n1) return false;
    N1x /= n1; N1y /= n1; N1z /= n1;
    const d1 = -(N1x * pos[p0] + N1y * pos[p0 + 1] + N1z * pos[p0 + 2]);
    let dq0 = N1x * pos[q0] + N1y * pos[q0 + 1] + N1z * pos[q0 + 2] + d1;
    let dq1 = N1x * pos[q1] + N1y * pos[q1 + 1] + N1z * pos[q1 + 2] + d1;
    let dq2 = N1x * pos[q2] + N1y * pos[q2 + 1] + N1z * pos[q2 + 2] + d1;
    if (Math.abs(dq0) < eps) dq0 = 0; if (Math.abs(dq1) < eps) dq1 = 0; if (Math.abs(dq2) < eps) dq2 = 0;
    if ((dq0 > 0 && dq1 > 0 && dq2 > 0) || (dq0 < 0 && dq1 < 0 && dq2 < 0)) return false;
    if (dq0 === 0 && dq1 === 0 && dq2 === 0) return false;   // coplanar: not counted
    // Two corners on the plane and the third off it: q only touches the plane along an edge.
    if ((dq0 === 0) + (dq1 === 0) + (dq2 === 0) >= 2) return false;

    const F1x = pos[q1] - pos[q0], F1y = pos[q1 + 1] - pos[q0 + 1], F1z = pos[q1 + 2] - pos[q0 + 2];
    const F2x = pos[q2] - pos[q0], F2y = pos[q2 + 1] - pos[q0 + 1], F2z = pos[q2 + 2] - pos[q0 + 2];
    let N2x = F1y * F2z - F1z * F2y, N2y = F1z * F2x - F1x * F2z, N2z = F1x * F2y - F1y * F2x;
    const n2 = Math.hypot(N2x, N2y, N2z);
    if (!n2) return false;
    N2x /= n2; N2y /= n2; N2z /= n2;
    const d2 = -(N2x * pos[q0] + N2y * pos[q0 + 1] + N2z * pos[q0 + 2]);
    let dp0 = N2x * pos[p0] + N2y * pos[p0 + 1] + N2z * pos[p0 + 2] + d2;
    let dp1 = N2x * pos[p1] + N2y * pos[p1 + 1] + N2z * pos[p1 + 2] + d2;
    let dp2 = N2x * pos[p2] + N2y * pos[p2 + 1] + N2z * pos[p2 + 2] + d2;
    if (Math.abs(dp0) < eps) dp0 = 0; if (Math.abs(dp1) < eps) dp1 = 0; if (Math.abs(dp2) < eps) dp2 = 0;
    if ((dp0 > 0 && dp1 > 0 && dp2 > 0) || (dp0 < 0 && dp1 < 0 && dp2 < 0)) return false;
    if ((dp0 === 0) + (dp1 === 0) + (dp2 === 0) >= 2) return false;

    // Direction of the intersection line; project onto its largest axis.
    const Dx = N1y * N2z - N1z * N2y, Dy = N1z * N2x - N1x * N2z, Dz = N1x * N2y - N1y * N2x;
    const ax = Math.abs(Dx), ay = Math.abs(Dy), az = Math.abs(Dz);
    const axis = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    const vp0 = pos[p0 + axis], vp1 = pos[p1 + axis], vp2 = pos[p2 + axis];
    const vq0 = pos[q0 + axis], vq1 = pos[q1 + axis], vq2 = pos[q2 + axis];
    const ip = interval(vp0, vp1, vp2, dp0, dp1, dp2);
    const iq = interval(vq0, vq1, vq2, dq0, dq1, dq2);
    if (!ip || !iq) return false;
    const a0 = Math.min(ip[0], ip[1]), a1 = Math.max(ip[0], ip[1]);
    const b0 = Math.min(iq[0], iq[1]), b1 = Math.max(iq[0], iq[1]);
    return !(a1 < b0 + eps || b1 < a0 + eps);
}
// Where a triangle crosses the other plane, as two coordinates along the chosen axis.
function interval(v0, v1, v2, d0, d1, d2) {
    const cross = (va, da, vb, db) => va + (vb - va) * da / (da - db);
    if (d0 * d1 > 0) return [cross(v0, d0, v2, d2), cross(v1, d1, v2, d2)];           // 2 is alone
    if (d0 * d2 > 0) return [cross(v0, d0, v1, d1), cross(v2, d2, v1, d1)];           // 1 is alone
    if (d1 * d2 > 0 || d0 !== 0) return [cross(v1, d1, v0, d0), cross(v2, d2, v0, d0)]; // 0 is alone
    if (d1 !== 0) return [cross(v0, d0, v1, d1), cross(v2, d2, v1, d1)];
    if (d2 !== 0) return [cross(v0, d0, v2, d2), cross(v1, d1, v2, d2)];
    return null;
}

async function selfIntersections(mesh, comp, budgetMs, progress) {
    const { pos, idx } = mesh;
    const F = idx.length / 3;
    const b = boundsOf(pos);
    const eps = Math.max(1e-12, b.diagonal * 1e-7);
    // Triangle boxes.
    const lo = new Float32Array(F * 3), hi = new Float32Array(F * 3);
    let meanExtent = 0;
    for (let f = 0; f < F; f++) {
        for (let k = 0; k < 3; k++) {
            const a = pos[idx[3 * f] * 3 + k], bb = pos[idx[3 * f + 1] * 3 + k], c = pos[idx[3 * f + 2] * 3 + k];
            lo[3 * f + k] = Math.min(a, bb, c); hi[3 * f + k] = Math.max(a, bb, c);
            meanExtent += hi[3 * f + k] - lo[3 * f + k];
        }
    }
    meanExtent /= 3 * F;
    const cell = Math.max(meanExtent * 2.5, b.diagonal / 400) || 1;
    const nx = Math.max(1, Math.ceil(b.size[0] / cell) + 1), ny = Math.max(1, Math.ceil(b.size[1] / cell) + 1), nz = Math.max(1, Math.ceil(b.size[2] / cell) + 1);
    const cellOf = (x, y, z) => (Math.floor((x - b.min[0]) / cell) * ny + Math.floor((y - b.min[1]) / cell)) * nz + Math.floor((z - b.min[2]) / cell);
    // Fill the grid: counting sort of (cell, face) pairs so there is no Map of arrays.
    let total = 0;
    for (let f = 0; f < F; f++) {
        const i0 = Math.floor((lo[3 * f] - b.min[0]) / cell), i1 = Math.floor((hi[3 * f] - b.min[0]) / cell);
        const j0 = Math.floor((lo[3 * f + 1] - b.min[1]) / cell), j1 = Math.floor((hi[3 * f + 1] - b.min[1]) / cell);
        const k0 = Math.floor((lo[3 * f + 2] - b.min[2]) / cell), k1 = Math.floor((hi[3 * f + 2] - b.min[2]) / cell);
        total += (i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1);
    }
    const cellIds = new Float64Array(total), faceIds = new Uint32Array(total);
    let o = 0;
    for (let f = 0; f < F; f++) {
        const i0 = Math.floor((lo[3 * f] - b.min[0]) / cell), i1 = Math.floor((hi[3 * f] - b.min[0]) / cell);
        const j0 = Math.floor((lo[3 * f + 1] - b.min[1]) / cell), j1 = Math.floor((hi[3 * f + 1] - b.min[1]) / cell);
        const k0 = Math.floor((lo[3 * f + 2] - b.min[2]) / cell), k1 = Math.floor((hi[3 * f + 2] - b.min[2]) / cell);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) { cellIds[o] = (i * ny + j) * nz + k; faceIds[o] = f; o++; }
    }
    const order = new Uint32Array(total);
    for (let i = 0; i < total; i++) order[i] = i;
    order.sort((x, y) => cellIds[x] - cellIds[y]);
    const started = performance.now();
    let lastYield = started;
    const hits = new Set();
    const pairs = [];
    let crossShell = 0, sameShell = 0;
    let i = 0, cellsDone = 0, cellsTotal = 0;
    for (let s = 0; s < total;) { let e = s; while (e < total && cellIds[order[e]] === cellIds[order[s]]) e++; cellsTotal++; s = e; }
    let timedOut = false;
    while (i < total) {
        let e = i;
        const c = cellIds[order[i]];
        while (e < total && cellIds[order[e]] === c) e++;
        for (let x = i; x < e; x++) {
            const f = faceIds[order[x]];
            for (let y = x + 1; y < e; y++) {
                const g = faceIds[order[y]];
                // Box overlap, and only in the cell that holds the overlap's low corner (so each pair is tested once).
                const ox = Math.max(lo[3 * f], lo[3 * g]), oy = Math.max(lo[3 * f + 1], lo[3 * g + 1]), oz = Math.max(lo[3 * f + 2], lo[3 * g + 2]);
                if (ox > Math.min(hi[3 * f], hi[3 * g]) || oy > Math.min(hi[3 * f + 1], hi[3 * g + 1]) || oz > Math.min(hi[3 * f + 2], hi[3 * g + 2])) continue;
                if (cellOf(ox, oy, oz) !== c) continue;
                const a0 = idx[3 * f], a1 = idx[3 * f + 1], a2 = idx[3 * f + 2], b0 = idx[3 * g], b1 = idx[3 * g + 1], b2 = idx[3 * g + 2];
                if (a0 === b0 || a0 === b1 || a0 === b2 || a1 === b0 || a1 === b1 || a1 === b2 || a2 === b0 || a2 === b1 || a2 === b2) continue;
                if (triTri(pos, a0 * 3, a1 * 3, a2 * 3, b0 * 3, b1 * 3, b2 * 3, eps)) {
                    hits.add(f); hits.add(g);
                    if (pairs.length < 200000) pairs.push(f, g);
                    if (comp[f] === comp[g]) sameShell++; else crossShell++;
                }
            }
        }
        i = e; cellsDone++;
        const now = performance.now();
        if (now - lastYield > 40) {
            lastYield = now;
            progress(`Looking for triangles that cross each other (${Math.round(100 * cellsDone / cellsTotal)}%)`, cellsDone / cellsTotal);
            await tick();
            if (now - started > budgetMs) { timedOut = true; break; }
        }
    }
    return { faces: [...hits], pairs, crossShell, sameShell, coverage: cellsDone / cellsTotal, timedOut, ms: performance.now() - started };
}

/* ------------------------------------------------------------------------------------------------
   Boolean union of overlapping shells (Manifold, loaded on demand)
------------------------------------------------------------------------------------------------ */
let manifoldPromise;
async function manifold() {
    manifoldPromise ||= (async () => {
        const mod = await import(MANIFOLD_URL);
        const factory = mod.default || mod;
        const wasm = await factory({ locateFile: () => MANIFOLD_WASM });
        wasm.setup();
        return wasm;
    })();
    manifoldPromise.catch(() => { manifoldPromise = null; });
    return manifoldPromise;
}

async function unionShells(mesh, shells) {
    const wasm = await manifold();
    const { Manifold, Mesh } = wasm;
    const parts = [];
    try {
        for (const s of shells) {
            const remap = new Map();
            const verts = [];
            const tris = new Uint32Array(s.faces.length * 3);
            let o = 0;
            for (const f of s.faces) for (let k = 0; k < 3; k++) {
                const v = mesh.idx[3 * f + k];
                let n = remap.get(v);
                if (n === undefined) { n = verts.length / 3; remap.set(v, n); verts.push(mesh.pos[3 * v], mesh.pos[3 * v + 1], mesh.pos[3 * v + 2]); }
                tris[o++] = n;
            }
            const m = new Manifold(new Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: tris }));
            const status = m.status ? m.status() : 'NoError';
            if (status !== 'NoError' && status?.value !== 0) { m.delete(); parts.forEach(p => p.delete()); return { ok: false, reason: `shell ${s.id + 1}: ${status}` }; }
            parts.push(m);
        }
        const result = Manifold.union(parts);
        const out = result.getMesh();
        const pos = new Float64Array(out.numVert * 3);
        for (let v = 0; v < out.numVert; v++) for (let k = 0; k < 3; k++) pos[3 * v + k] = out.vertProperties[v * out.numProp + k];
        const idx = new Uint32Array(out.triVerts);
        result.delete(); parts.forEach(p => p.delete());
        return { ok: true, pos, idx };
    } catch (error) {
        parts.forEach(p => { try { p.delete(); } catch {} });
        return { ok: false, reason: error?.message || String(error) };
    }
}

/* ------------------------------------------------------------------------------------------------
   The sweep
------------------------------------------------------------------------------------------------ */
/**
 * raw: { positions: Float32Array soup, faces, bytes, kind, name, parts } from loadMesh.
 * Returns { findings, before: { faces, vertices, shells, openEdges, ... }, after: {...}, mesh: { pos, idx }, original: { pos, idx }, ms }.
 */
export async function repairMesh(raw, options = {}, progress = () => {}) {
    const opt = { ...DEFAULTS, ...options };
    const started = performance.now();
    const findings = [];
    const step = async (msg, frac) => { progress(msg, frac); await tick(); };

    // 1. bad numbers
    await step('Checking the numbers', 0.02);
    const clean = dropNonFinite(raw.positions);
    findings.push(clean.bad
        ? finding('numbers', 'fixed', `${fmt(clean.bad)} triangle${clean.bad === 1 ? '' : 's'} had corrupt coordinates (NaN or infinity) and were removed.`, { count: clean.bad })
        : finding('numbers', 'ok', 'Every coordinate is a real number.'));
    if (!clean.positions.length) throw new Error('Nothing usable was left after removing the corrupt triangles.');

    // 2. weld
    await step('Joining shared vertices', 0.06);
    const bounds = boundsOf(clean.positions);
    const exact = indexed(clean.positions, Math.max(1e-9, bounds.diagonal * 1e-7));
    const median = medianEdge(exact);
    // The file as it came in (exactly welded, nothing else), for the "before" view and numbers.
    const original = exact;
    await step('Taking stock of the file as it is', 0.08);
    const onBoundary = new Uint8Array(exact.pos.length / 3);
    const before = (() => {
        const copy = { pos: exact.pos, idx: Uint32Array.from(exact.idx) };   // orientAndLabel turns faces round; keep the original intact
        const e = buildEdges(copy.idx, copy.pos.length / 3);
        const nV = copy.pos.length / 3;
        for (const [key, v] of e) if (typeof v === 'number') { onBoundary[Math.floor(key / nV)] = 1; onBoundary[key % nV] = 1; }
        return describe(copy, e, orientAndLabel(copy, e).shells);
    })();
    before.bounds = bounds; before.medianEdge = median;
    // A pinhole or a crack is a pair of vertices a hair apart that both sit on an open edge, so only
    // boundary vertices are candidates: a healthy closed mesh (an nTop lattice, say) can have
    // legitimate vertices that close together, and welding those would tear it.
    const loose = Math.min(bounds.diagonal * 1e-4, median * 0.05) || bounds.diagonal * 1e-5;
    let mesh = { pos: Float64Array.from(exact.pos), idx: Uint32Array.from(exact.idx) };
    const mergedVerts = weldWithin(mesh, loose, onBoundary);
    const merged = mergedVerts.length;
    if (merged > 0) {
        findings.push(finding('weld', 'fixed', `${fmt(merged)} vert${merged === 1 ? 'ex was' : 'ices were'} stored twice within ${fmtLen(loose, bounds)} of another and ${merged === 1 ? 'has' : 'have'} been merged.`,
            { count: merged, highlight: { points: segmentsOf(exact.pos, mergedVerts) } }));
    } else findings.push(finding('weld', 'ok', 'No split vertices: neighbouring triangles share their corners.'));

    // 3. degenerate / duplicate
    await step('Removing collapsed and duplicate triangles', 0.10);
    const deg = dropDegenerate(mesh);
    if (deg.collapsed || deg.duplicates) {
        const bits = [];
        if (deg.collapsed) bits.push(`${fmt(deg.collapsed)} zero-area triangle${deg.collapsed === 1 ? '' : 's'}`);
        if (deg.duplicates) bits.push(`${fmt(deg.duplicates)} duplicate triangle${deg.duplicates === 1 ? '' : 's'} (the same three corners twice)`);
        findings.push(finding('degenerate', 'fixed', `${bits.join(' and ')} removed.`, { count: deg.collapsed + deg.duplicates, highlight: deg.soup ? { faces: deg.soup } : undefined }));
    } else findings.push(finding('degenerate', 'ok', 'No collapsed or duplicate triangles.'));

    // 4-6. shells, winding, inverted shells
    await step('Sorting the triangles into shells and checking which way they face', 0.16);
    let edges = buildEdges(mesh.idx, mesh.pos.length / 3);
    let { comp, flipped, shells } = orientAndLabel(mesh, edges);
    const flippedFaces = [];
    for (let f = 0; f < flipped.length; f++) if (flipped[f]) flippedFaces.push(f);
    findings.push(flippedFaces.length
        ? finding('winding', 'fixed', `${fmt(flippedFaces.length)} triangle${flippedFaces.length === 1 ? ' was' : 's were'} facing the opposite way from ${flippedFaces.length === 1 ? 'its' : 'their'} neighbours and ${flippedFaces.length === 1 ? 'has' : 'have'} been turned round.`,
            { count: flippedFaces.length, highlight: { faces: soupOf(mesh, flippedFaces) } })
        : finding('winding', 'ok', 'All triangles face the same way as their neighbours.'));

    // debris is decided first so an inside-out speck is not reported as an inside-out shell
    const totalFaces = mesh.idx.length / 3;
    const debris = shells.filter(s => s.bounds.diagonal <= opt.debrisMaxFraction * bounds.diagonal && s.faces.length <= Math.max(200, opt.debrisMaxFaces * totalFaces));
    const inverted = shells.filter(s => s.closed && s.volume < 0 && !(opt.removeDebris && debris.includes(s) && shells.length > debris.length));
    for (const s of inverted) flipShell(mesh, s);
    findings.push(inverted.length
        ? finding('inverted', 'fixed', `${inverted.length} closed shell${inverted.length === 1 ? ' was' : 's were'} inside-out (every normal pointed into the solid) and ${inverted.length === 1 ? 'has' : 'have'} been flipped.`,
            { count: inverted.length, highlight: { faces: soupOf(mesh, inverted.flatMap(s => s.faces)) } })
        : finding('inverted', 'ok', shells.some(s => s.closed) ? 'Closed shells have their normals pointing outwards.' : 'No closed shells to check for inside-out normals.'));

    // debris
    let keptShells = shells;
    if (debris.length && shells.length > debris.length) {
        const debrisFaces = debris.flatMap(s => s.faces);
        const soup = soupOf(mesh, debrisFaces);
        if (opt.removeDebris) {
            const alive = new Uint8Array(totalFaces).fill(1);
            for (const f of debrisFaces) alive[f] = 0;
            dropFaces(mesh, alive);
            keptShells = shells.filter(s => !debris.includes(s));
            findings.push(finding('debris', 'fixed', `${debris.length} tiny loose piece${debris.length === 1 ? '' : 's'} (${fmt(debrisFaces.length)} triangle${debrisFaces.length === 1 ? '' : 's'} in total, each smaller than ${Math.round(opt.debrisMaxFraction * 100)}% of the model) removed.`,
                { count: debris.length, highlight: { faces: soup } }));
        } else {
            findings.push(finding('debris', 'warn', `${debris.length} tiny loose piece${debris.length === 1 ? '' : 's'} (${fmt(debrisFaces.length)} triangles) left in place because debris removal is off.`, { count: debris.length, highlight: { faces: soup } }));
        }
        // Everything below works on a fresh edge table.
        edges = buildEdges(mesh.idx, mesh.pos.length / 3);
        ({ comp, shells } = orientAndLabel(mesh, edges));
        keptShells = shells;
    } else findings.push(finding('debris', 'ok', 'No loose debris.'));

    // 8. holes
    await step('Looking for holes', 0.26);
    let loops = boundaryLoops(mesh, edges);
    const broken = loops.filter(l => !l.closed);   // a boundary that runs into a non-manifold edge: reported with those
    loops = loops.filter(l => l.closed);
    const small = loops.filter(l => l.verts.length <= opt.holeMaxEdges && l.diagonal <= opt.holeMaxFraction * bounds.diagonal);
    const big = loops.filter(l => !small.includes(l));
    let filledTris = 0, filledCount = 0;
    const filledSoupParts = [];
    if (small.length && opt.fillHoles) {
        for (const l of small) {
            const fill = fillLoop(mesh.pos, l.verts);
            if (!fill || !fillIsSafe(mesh, edges, fill)) continue;
            const start = mesh.idx.length;
            appendFaces(mesh, fill.tris, fill.centre);
            const added = [];
            for (let f = start / 3; f < mesh.idx.length / 3; f++) added.push(f);
            filledSoupParts.push(soupOf(mesh, added));
            filledTris += added.length; filledCount++;
        }
        edges = buildEdges(mesh.idx, mesh.pos.length / 3);
        ({ comp, shells } = orientAndLabel(mesh, edges));
    }
    if (filledCount) {
        const soup = concat(filledSoupParts);
        findings.push(finding('holes', 'fixed', `${filledCount} small hole${filledCount === 1 ? '' : 's'} (each at most ${opt.holeMaxEdges} edges and under ${Math.round(opt.holeMaxFraction * 100)}% of the model across) filled with ${fmt(filledTris)} new triangle${filledTris === 1 ? '' : 's'}.`,
            { count: filledCount, highlight: { faces: soup } }));
    } else if (small.length) {
        findings.push(finding('holes', 'warn', opt.fillHoles
            ? `${small.length} small hole${small.length === 1 ? '' : 's'} could not be patched (${small.length === 1 ? 'its' : 'their'} boundary could not be triangulated).`
            : `${small.length} small hole${small.length === 1 ? '' : 's'} left open because hole filling is off.`, { count: small.length, highlight: { edges: loopSegments(mesh.pos, small) } }));
    } else findings.push(finding('holes', 'ok', 'No small holes.'));
    if (big.length) {
        const longest = big.reduce((m, l) => Math.max(m, l.perimeter), 0);
        findings.push(finding('open', 'warn', `${big.length} large open edge${big.length === 1 ? '' : 's'} (the longest runs ${fmtNum(longest)} units around; the whole model is ${fmtNum(bounds.diagonal)} units across). The surface is not a closed solid: nTop can read it as a surface but not as a body. If this is a scan or a socket surface, that may be exactly what you want.`,
            { count: big.length, highlight: { edges: loopSegments(mesh.pos, big) } }));
    } else findings.push(finding('open', 'ok', loops.length || broken.length ? 'No large openings.' : 'The surface is closed: no open edges at all.'));

    // 9. slivers
    await step('Cleaning up needle and cap triangles', 0.32);
    // A few passes: each pass changes at most one thing per neighbourhood and works from a fresh edge table.
    const sl = { collapsed: 0, flippedEdges: 0, removed: 0, touched: [] };
    for (let pass = 0; pass < 4; pass++) {
        const r = fixSlivers(mesh, edges, opt.sliverAngleDeg * Math.PI / 180);
        if (!(r.collapsed + r.flippedEdges + r.removed)) break;
        sl.collapsed += r.collapsed; sl.flippedEdges += r.flippedEdges; sl.removed += r.removed;
        for (const x of r.touched) sl.touched.push(x);
        edges = buildEdges(mesh.idx, mesh.pos.length / 3);
    }
    const sliverTotal = sl.collapsed + sl.flippedEdges + sl.removed;
    if (sliverTotal) {
        ({ comp, shells } = orientAndLabel(mesh, edges));
        const bits = [];
        if (sl.flippedEdges) bits.push(`${fmt(sl.flippedEdges)} flattened (cap) triangle${sl.flippedEdges === 1 ? '' : 's'} re-split with ${sl.flippedEdges === 1 ? 'its' : 'their'} neighbour`);
        if (sl.collapsed) bits.push(`${fmt(sl.collapsed)} needle triangle${sl.collapsed === 1 ? '' : 's'} collapsed`);
        if (sl.removed) bits.push(`${fmt(sl.removed)} flat triangle${sl.removed === 1 ? '' : 's'} on an open edge removed`);
        findings.push(finding('slivers', 'fixed', `${bits.join('; ')}. Corners sharper than ${opt.sliverAngleDeg}° break remeshers and quad conversion.`, { count: sliverTotal, highlight: { points: segmentsOf(mesh.pos, dedupe(sl.touched).filter(v => v < mesh.pos.length / 3)) } }));
    } else findings.push(finding('slivers', 'ok', `No triangles with corners sharper than ${opt.sliverAngleDeg}°.`));

    // 7. non-manifold (checked after the holes, because two holes touching at one vertex look like a
    // bow tie until they are filled)
    await step('Checking for non-manifold edges', 0.38);
    const nm = nonManifold(mesh, edges);
    const nmEdgeCount = nm.badEdges.length / 2;
    if (nmEdgeCount || nm.badVerts.length) {
        const bits = [];
        if (nmEdgeCount) bits.push(`${fmt(nmEdgeCount)} edge${nmEdgeCount === 1 ? ' is' : 's are'} shared by three or more triangles`);
        if (nm.badVerts.length) bits.push(`${fmt(nm.badVerts.length)} ${nm.badVerts.length === 1 ? 'vertex joins' : 'vertices join'} two separate fans of triangles (a bow tie)`);
        if (broken.length) bits.push(`${broken.length} open edge${broken.length === 1 ? '' : 's'} run${broken.length === 1 ? 's' : ''} into them`);
        findings.push(finding('nonmanifold', 'fail', `${bits.join('; ')}. These cannot be fixed automatically without guessing which surface you meant.`,
            { count: nmEdgeCount + nm.badVerts.length, highlight: { edges: concat([nmEdgeCount ? segmentsOf(mesh.pos, nm.badEdges) : new Float32Array(0), broken.length ? loopSegments(mesh.pos, broken) : new Float32Array(0)]), points: nm.badVerts.length ? segmentsOf(mesh.pos, nm.badVerts) : undefined } }));
    } else findings.push(finding('nonmanifold', 'ok', 'Every edge is shared by at most two triangles.'));

    // 10. self-intersections
    let inter = null;
    if (opt.checkIntersections) {
        await step('Looking for triangles that cross each other', 0.42);
        inter = await selfIntersections(mesh, comp, opt.intersectionBudgetMs, (m, frac) => progress(m, 0.42 + 0.5 * frac));
        if (!inter.faces.length) {
            findings.push(finding('intersections', inter.timedOut ? 'warn' : 'ok', inter.timedOut
                ? `No crossing triangles found in the ${Math.round(inter.coverage * 100)}% of the model checked before the ${Math.round(opt.intersectionBudgetMs / 1000)} s time limit.`
                : 'No triangles pass through each other.', { coverage: inter.coverage }));
        } else {
            const soup = soupOf(mesh, inter.faces);
            const partial = inter.timedOut ? ` (only ${Math.round(inter.coverage * 100)}% of the model was checked before the time limit)` : '';
            let unionNote = '';
            // Overlapping shells: if every shell is a clean closed solid, a Boolean union makes one body.
            if (opt.mergeShells && inter.crossShell && shells.length > 1 && shells.every(s => s.closed) && !nmEdgeCount && !nm.badVerts.length) {
                await step('Merging the overlapping shells into one solid', 0.93);
                const u = await unionShells(mesh, shells);
                if (u.ok) {
                    mesh = { pos: u.pos, idx: u.idx };
                    edges = buildEdges(mesh.idx, mesh.pos.length / 3);
                    ({ comp, shells } = orientAndLabel(mesh, edges));
                    findings.push(finding('intersections', 'fixed', `${fmt(inter.faces.length)} triangles crossed each other where ${inter.sameShell ? 'mostly ' : ''}separate shells overlapped${partial}. The shells were merged with a Boolean union into ${shells.length === 1 ? 'one solid' : `${shells.length} solids`}, the same thing Boolean Union does in nTop.`,
                        { count: inter.faces.length, highlight: { faces: soup } }));
                    unionNote = 'done';
                } else unionNote = u.reason;
            }
            if (unionNote !== 'done') {
                const why = inter.crossShell && shells.length > 1
                    ? (shells.every(s => s.closed) ? `They could not be merged automatically${unionNote ? ` (${unionNote})` : ''}.` : 'The overlapping shells are not all closed, so they cannot be merged by a Boolean union until the holes are fixed.')
                    : 'They are within one shell, which means the surface folds through itself; only remeshing or rebuilding that area will fix it.';
                const crossings = inter.crossShell + inter.sameShell;
                const where = inter.crossShell && inter.sameShell ? `${fmt(inter.crossShell)} between separate shells and ${fmt(inter.sameShell)} within one shell` : inter.crossShell ? 'all between separate shells' : 'all within one shell';
                findings.push(finding('intersections', 'fail', `${fmt(inter.faces.length)} triangle${inter.faces.length === 1 ? '' : 's'} pass through other triangles (${fmt(crossings)} crossing${crossings === 1 ? '' : 's'}, ${where})${partial}. ${why}`,
                    { count: inter.faces.length, highlight: { faces: soup } }));
            }
        }
    } else findings.push(finding('intersections', 'skipped', 'Self-intersection check turned off.'));

    // shells summary (after everything)
    if (shells.length > 1) {
        const overlapping = shells.some((a, i) => shells.some((b, j) => j > i && boxesOverlap(a.bounds, b.bounds)));
        findings.push(finding('shells', 'warn', `The file holds ${shells.length} separate shells${overlapping ? ' whose bounding boxes overlap' : ''}. nTop imports them as one mesh; if they should be one part, use Boolean Union (implicit bodies) or Merge in your mesh tool${inter?.crossShell ? ', or fix the crossings above first' : ''}.`, { count: shells.length }));
    } else findings.push(finding('shells', 'ok', 'One shell.'));

    await step('Finishing', 0.97);
    dropUnusedVertices(mesh);
    const after = describe(mesh, edges, shells);
    after.bounds = boundsOf(mesh.pos);
    const order = ['numbers', 'weld', 'degenerate', 'winding', 'inverted', 'debris', 'nonmanifold', 'holes', 'open', 'slivers', 'intersections', 'shells'];
    findings.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    return { findings, before, after, mesh, original, ms: performance.now() - started, intersections: inter };
}

function describe(mesh, edges, shells) {
    const out = { faces: mesh.idx.length / 3, vertices: mesh.pos.length / 3 };
    if (edges) {
        let open = 0, nonmanifold = 0;
        for (const v of edges.values()) { if (typeof v === 'number') open++; else if (v.length > 2) nonmanifold++; }
        out.openEdges = open; out.nonManifoldEdges = nonmanifold; out.edges = edges.size;
    }
    if (shells) {
        out.shells = shells.length;
        out.closedShells = shells.filter(s => s.closed).length;
        out.volume = shells.reduce((v, s) => v + (s.closed ? Math.abs(s.volume) : 0), 0);
    }
    return out;
}

function loopSegments(pos, loops) {
    let n = 0;
    for (const l of loops) n += (l.closed ? l.verts.length : l.verts.length - 1) * 2;
    const out = new Float32Array(n * 3);
    let o = 0;
    for (const l of loops) for (let i = 0; i < (l.closed ? l.verts.length : l.verts.length - 1); i++) {
        const a = l.verts[i] * 3, b = l.verts[(i + 1) % l.verts.length] * 3;
        out[o++] = pos[a]; out[o++] = pos[a + 1]; out[o++] = pos[a + 2]; out[o++] = pos[b]; out[o++] = pos[b + 1]; out[o++] = pos[b + 2];
    }
    return out;
}

function concat(parts) {
    const n = parts.reduce((s, p) => s + p.length, 0);
    const out = new Float32Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}
const dedupe = list => [...new Set(list)];
const boxesOverlap = (a, b) => a.min[0] <= b.max[0] && b.min[0] <= a.max[0] && a.min[1] <= b.max[1] && b.min[1] <= a.max[1] && a.min[2] <= b.max[2] && b.min[2] <= a.max[2];
const fmt = n => Math.round(n).toLocaleString('en-US');
const fmtNum = v => v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(3);
// Lengths are shown in the file's own units; we do not know what they are, so use the model as the ruler.
function fmtLen(v, bounds) {
    const pct = 100 * v / (bounds.diagonal || 1);
    const num = v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(3);
    return `${num} units (${pct < 0.01 ? '<0.01' : pct.toFixed(pct < 1 ? 2 : 0)}% of the model)`;
}

/* ------------------------------------------------------------------------------------------------
   Writers
------------------------------------------------------------------------------------------------ */
/** Binary STL of the mesh (per-triangle normals from the winding). */
export function toStl(mesh, header = 'Give a Paw mesh check') {
    const F = mesh.idx.length / 3;
    const buffer = new ArrayBuffer(84 + F * 50);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const text = new TextEncoder().encode(header.slice(0, 79));
    bytes.set(text, 0);
    view.setUint32(80, F, true);
    const n = [0, 0, 0];
    let o = 84;
    for (let f = 0; f < F; f++) {
        faceNormal(mesh.pos, mesh.idx, f, n);
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        view.setFloat32(o, n[0] / l, true); view.setFloat32(o + 4, n[1] / l, true); view.setFloat32(o + 8, n[2] / l, true); o += 12;
        for (let k = 0; k < 3; k++) {
            const v = mesh.idx[3 * f + k] * 3;
            view.setFloat32(o, mesh.pos[v], true); view.setFloat32(o + 4, mesh.pos[v + 1], true); view.setFloat32(o + 8, mesh.pos[v + 2], true); o += 12;
        }
        view.setUint16(o, 0, true); o += 2;
    }
    return buffer;
}

/** Wavefront OBJ of the mesh (positions and faces; viewers compute their own normals). */
export function toObj(mesh, name = 'mesh') {
    const parts = [`# Give a Paw mesh check\no ${name}\n`];
    const nV = mesh.pos.length / 3;
    const lines = new Array(nV);
    for (let v = 0; v < nV; v++) lines[v] = `v ${num(mesh.pos[3 * v])} ${num(mesh.pos[3 * v + 1])} ${num(mesh.pos[3 * v + 2])}`;
    parts.push(lines.join('\n'), '\n');
    const F = mesh.idx.length / 3;
    const faces = new Array(F);
    for (let f = 0; f < F; f++) faces[f] = `f ${mesh.idx[3 * f] + 1} ${mesh.idx[3 * f + 1] + 1} ${mesh.idx[3 * f + 2] + 1}`;
    parts.push(faces.join('\n'), '\n');
    return parts.join('');
}
const num = v => (Math.abs(v) < 1e-12 ? '0' : +v.toPrecision(10)).toString();
