// Surface interpolation on a solid: the browser version of automation/parametric_attachment.py.
//
// A painted attachment surface is a patch of the solid animal's own mesh. For each one we find
// which solid vertices it covers, measure every vertex's distance from the patch edge (negative
// inside, positive outside), and blend those distance fields between consecutive surfaces. Cutting
// the solid where a blended field crosses zero gives an in-between surface with a smooth edge.
import * as THREE from 'three';
import { loadMesh, weld } from './model-convert.js';

/** Load a mesh file and index it: positions, triangles, vertex adjacency with edge lengths. */
export async function loadSolid(source, name) {
    const raw = await loadMesh(source, name);
    const geometry = weld(raw.positions);
    const V = geometry.attributes.position.array;
    const F = geometry.index.array;
    const nv = V.length / 3, nf = F.length / 3;
    // Adjacency as CSR built from the three directed edges of every triangle (duplicates are harmless).
    const degree = new Uint32Array(nv + 1);
    for (let i = 0; i < F.length; i++) degree[F[i] + 1]++;
    for (let i = 0; i < nv; i++) degree[i + 1] += degree[i];
    const fill = degree.slice(0, nv);
    const neighbour = new Uint32Array(F.length), length = new Float32Array(F.length);
    let total = 0;
    for (let f = 0; f < nf; f++) {
        for (let k = 0; k < 3; k++) {
            const a = F[f * 3 + k], b = F[f * 3 + (k + 1) % 3];
            const d = dist(V, a, b);
            neighbour[fill[a]] = b; length[fill[a]++] = d;
            total += d;
        }
    }
    return { name, V, F, nv, nf, offset: degree, neighbour, length, h: total / F.length, bounds: geometry.computeBoundingBox() || geometry.boundingBox, raw };
}

function dist(V, a, b) {
    const dx = V[a * 3] - V[b * 3], dy = V[a * 3 + 1] - V[b * 3 + 1], dz = V[a * 3 + 2] - V[b * 3 + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Closest point on triangle (a, b, c) to p (Ericson, Real-Time Collision Detection). Writes into out. */
function closestOnTriangle(p, a, b, c, out) {
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
    const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return; }
    const bpx = p[0] - b[0], bpy = p[1] - b[1], bpz = p[2] - b[2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { out[0] = b[0]; out[1] = b[1]; out[2] = b[2]; return; }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); out[0] = a[0] + v * abx; out[1] = a[1] + v * aby; out[2] = a[2] + v * abz; return; }
    const cpx = p[0] - c[0], cpy = p[1] - c[1], cpz = p[2] - c[2];
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) { out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return; }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); out[0] = a[0] + w * acx; out[1] = a[1] + w * acy; out[2] = a[2] + w * acz; return; }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        out[0] = b[0] + w * (c[0] - b[0]); out[1] = b[1] + w * (c[1] - b[1]); out[2] = b[2] + w * (c[2] - b[2]); return;
    }
    const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
    out[0] = a[0] + abx * v + acx * w; out[1] = a[1] + aby * v + acy * w; out[2] = a[2] + abz * v + acz * w;
}

/**
 * Which solid vertices lie on a painted surface (a triangle soup). A vertex counts when it is within
 * a fraction of the surface's own edge length of a triangle and not past the triangle's edge (the
 * offset to the closest point stays along the normal). Returns a Uint8Array mask plus statistics.
 */
export function membership(solid, surface) {
    const P = surface.positions, nt = P.length / 9;
    let edgeSum = 0;
    for (let t = 0; t < Math.min(nt, 2000); t++) {
        const i = t * 9;
        edgeSum += Math.hypot(P[i] - P[i + 3], P[i + 1] - P[i + 4], P[i + 2] - P[i + 5]);
    }
    const surfEdge = edgeSum / Math.min(nt, 2000);
    const tolN = Math.max(0.3 * surfEdge, 0.1 * solid.h), tolT = 0.2 * solid.h;
    const cell = Math.max(2 * surfEdge, 4 * tolN);
    const inv = 1 / cell;
    const key = (x, y, z) => (Math.floor(x * inv) * 73856093) ^ (Math.floor(y * inv) * 19349663) ^ (Math.floor(z * inv) * 83492791);
    const grid = new Map();
    const b = surface.bounds;
    for (let t = 0; t < nt; t++) {
        const i = t * 9;
        const x0 = Math.min(P[i], P[i + 3], P[i + 6]) - tolN, x1 = Math.max(P[i], P[i + 3], P[i + 6]) + tolN;
        const y0 = Math.min(P[i + 1], P[i + 4], P[i + 7]) - tolN, y1 = Math.max(P[i + 1], P[i + 4], P[i + 7]) + tolN;
        const z0 = Math.min(P[i + 2], P[i + 5], P[i + 8]) - tolN, z1 = Math.max(P[i + 2], P[i + 5], P[i + 8]) + tolN;
        for (let x = Math.floor(x0 * inv); x <= Math.floor(x1 * inv); x++)
            for (let y = Math.floor(y0 * inv); y <= Math.floor(y1 * inv); y++)
                for (let z = Math.floor(z0 * inv); z <= Math.floor(z1 * inv); z++) {
                    const k = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
                    let list = grid.get(k);
                    if (!list) grid.set(k, list = []);
                    list.push(t);
                }
    }
    const V = solid.V, member = new Uint8Array(solid.nv);
    const p = [0, 0, 0], cp = [0, 0, 0], ta = [0, 0, 0], tb = [0, 0, 0], tc = [0, 0, 0];
    for (let v = 0; v < solid.nv; v++) {
        p[0] = V[v * 3]; p[1] = V[v * 3 + 1]; p[2] = V[v * 3 + 2];
        if (p[0] < b.min.x - tolN || p[0] > b.max.x + tolN || p[1] < b.min.y - tolN || p[1] > b.max.y + tolN || p[2] < b.min.z - tolN || p[2] > b.max.z + tolN) continue;
        const list = grid.get(key(p[0], p[1], p[2]));
        if (!list) continue;
        for (const t of list) {
            const i = t * 9;
            ta[0] = P[i]; ta[1] = P[i + 1]; ta[2] = P[i + 2];
            tb[0] = P[i + 3]; tb[1] = P[i + 4]; tb[2] = P[i + 5];
            tc[0] = P[i + 6]; tc[1] = P[i + 7]; tc[2] = P[i + 8];
            closestOnTriangle(p, ta, tb, tc, cp);
            const ox = p[0] - cp[0], oy = p[1] - cp[1], oz = p[2] - cp[2];
            const d = Math.sqrt(ox * ox + oy * oy + oz * oz);
            if (d > tolN) continue;
            // normal of the triangle
            let nx = (tb[1] - ta[1]) * (tc[2] - ta[2]) - (tb[2] - ta[2]) * (tc[1] - ta[1]);
            let ny = (tb[2] - ta[2]) * (tc[0] - ta[0]) - (tb[0] - ta[0]) * (tc[2] - ta[2]);
            let nz = (tb[0] - ta[0]) * (tc[1] - ta[1]) - (tb[1] - ta[1]) * (tc[0] - ta[0]);
            const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            nx /= nl; ny /= nl; nz /= nl;
            const along = ox * nx + oy * ny + oz * nz;
            const tx = ox - along * nx, ty = oy - along * ny, tz = oz - along * nz;
            if (Math.sqrt(tx * tx + ty * ty + tz * tz) <= tolT) { member[v] = 1; break; }
        }
    }
    // Clean-up: drop painted specks that are not the main patch; fill unpainted specks inside it.
    const painted = components(solid, member, 1);
    const biggest = largestLabel(painted);
    for (let v = 0; v < solid.nv; v++) if (member[v] && painted.label[v] !== biggest) member[v] = 0;
    const unpainted = components(solid, member, 0);
    for (let v = 0; v < solid.nv; v++) if (!member[v] && unpainted.size[unpainted.label[v]] < 200) member[v] = 1;
    let count = 0;
    for (let v = 0; v < solid.nv; v++) count += member[v];
    return { member, count, surfEdge, pieces: unpainted.size.filter(s => s >= 200).length };
}

/** Connected components of the vertices whose mask equals `value`; label -1 elsewhere. */
function components(solid, mask, value) {
    const label = new Int32Array(solid.nv).fill(-1), size = [];
    const stack = new Uint32Array(solid.nv);
    for (let s = 0; s < solid.nv; s++) {
        if (mask[s] !== value || label[s] >= 0) continue;
        const id = size.length;
        let top = 0, n = 0;
        stack[top++] = s; label[s] = id;
        while (top) {
            const v = stack[--top]; n++;
            for (let k = solid.offset[v]; k < solid.offset[v + 1]; k++) {
                const u = solid.neighbour[k];
                if (mask[u] === value && label[u] < 0) { label[u] = id; stack[top++] = u; }
            }
        }
        size.push(n);
    }
    return { label, size };
}

function largestLabel(c) { let best = 0; for (let i = 1; i < c.size.length; i++) if (c.size[i] > c.size[best]) best = i; return best; }

/**
 * Signed distance from the patch edge along the mesh (Dijkstra from both sides of the edge, then a
 * light smoothing away from the edge). Negative inside the patch.
 */
export function signedDistance(solid, member) {
    const { nv, offset, neighbour, length, h } = solid;
    const d = new Float64Array(nv).fill(Infinity);
    const heap = new MinHeap(nv);
    for (let v = 0; v < nv; v++) {
        let boundary = false;
        for (let k = offset[v]; k < offset[v + 1] && !boundary; k++) boundary = member[neighbour[k]] !== member[v];
        if (boundary) { d[v] = 0; heap.push(v, 0); }
    }
    while (heap.size) {
        const v = heap.pop(), dv = heap.poppedKey;
        if (dv > d[v]) continue;          // a stale entry; this vertex was already settled with a shorter path
        for (let k = offset[v]; k < offset[v + 1]; k++) {
            const u = neighbour[k], du = dv + length[k];
            if (du < d[u]) { d[u] = du; heap.push(u, du); }
        }
    }
    // vertices the edge cannot reach along the mesh (separate shells) get a large finite distance
    const far = solid.bounds.getSize(new THREE.Vector3()).length() * 2;
    let phi = new Float32Array(nv);
    for (let v = 0; v < nv; v++) phi[v] = (member[v] ? -1 : 1) * (Math.min(d[v], far) + h / 2);
    // Graph distances zigzag; a few averaging passes away from the edge smooth the contours.
    for (let pass = 0; pass < 4; pass++) {
        const next = phi.slice();
        for (let v = 0; v < nv; v++) {
            if (Math.abs(phi[v]) < 1.5 * h) continue;
            let sum = phi[v], n = 1;
            for (let k = offset[v]; k < offset[v + 1]; k++) { sum += phi[neighbour[k]]; n++; }
            next[v] = sum / n;
        }
        phi = next;
    }
    return phi;
}

export class MinHeap {
    constructor(capacity) { this.keys = new Float64Array(capacity * 4); this.vals = new Uint32Array(capacity * 4); this.size = 0; this.poppedKey = 0; }
    push(v, key) {
        if (this.size === this.keys.length) {
            const k2 = new Float64Array(this.size * 2), v2 = new Uint32Array(this.size * 2);
            k2.set(this.keys); v2.set(this.vals); this.keys = k2; this.vals = v2;
        }
        let i = this.size++;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.keys[p] <= key) break;
            this.keys[i] = this.keys[p]; this.vals[i] = this.vals[p]; i = p;
        }
        this.keys[i] = key; this.vals[i] = v;
    }
    pop() {
        const top = this.vals[0];
        this.poppedKey = this.keys[0];
        const key = this.keys[--this.size], val = this.vals[this.size];
        let i = 0;
        for (;;) {
            let c = i * 2 + 1;
            if (c >= this.size) break;
            if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
            if (this.keys[c] >= key) break;
            this.keys[i] = this.keys[c]; this.vals[i] = this.vals[c]; i = c;
        }
        if (this.size) { this.keys[i] = key; this.vals[i] = val; }
        return top;
    }
}

/** (1 - t) * a + t * b, as a new field. */
export function blend(a, b, t, out) {
    out = out || new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] + t * (b[i] - a[i]);
    return out;
}

/**
 * The part of the solid where phi < 0, with triangles split along phi = 0, reduced to its largest
 * connected piece. Returns a triangle soup (Float32Array of xyz triples) plus simple measurements.
 */
export function cut(solid, phi, snap = 0.08) {
    const { V, F, nf } = solid;
    const pts = [];          // intersection points, keyed by edge
    const edgeIndex = new Map();
    const tris = [];         // vertex ids: solid vertex v, or -(1 + pointIndex) for an edge point
    const edgePoint = (i, j) => {
        const lo = Math.min(i, j), hi = Math.max(i, j), k = lo * solid.nv + hi;
        let n = edgeIndex.get(k);
        if (n === undefined) {
            let s = phi[lo] / (phi[lo] - phi[hi]);
            s = Math.min(1 - snap, Math.max(snap, s));
            pts.push(V[lo * 3] + s * (V[hi * 3] - V[lo * 3]), V[lo * 3 + 1] + s * (V[hi * 3 + 1] - V[lo * 3 + 1]), V[lo * 3 + 2] + s * (V[hi * 3 + 2] - V[lo * 3 + 2]));
            n = pts.length / 3 - 1;
            edgeIndex.set(k, n);
        }
        return -(1 + n);
    };
    for (let f = 0; f < nf; f++) {
        const ids = [F[f * 3], F[f * 3 + 1], F[f * 3 + 2]];
        const neg = ids.map(v => phi[v] < 0);
        const count = neg[0] + neg[1] + neg[2];
        if (count === 0) continue;
        if (count === 3) { tris.push(ids[0], ids[1], ids[2]); continue; }
        // rotate so the vertex alone on its side comes first
        const odd = count === 1;
        let first = 0;
        while (neg[first] !== odd) first++;
        const a = ids[first], b = ids[(first + 1) % 3], c = ids[(first + 2) % 3];
        const pab = edgePoint(a, b), pac = edgePoint(a, c);
        if (odd) tris.push(a, pab, pac);
        else { tris.push(pab, b, c); tris.push(pab, c, pac); }
    }
    // keep the largest connected piece (union-find over shared vertex ids)
    const ids = new Map();
    const idOf = v => { let n = ids.get(v); if (n === undefined) { n = ids.size; ids.set(v, n); } return n; };
    const nt = tris.length / 3, triIds = new Int32Array(tris.length);
    for (let i = 0; i < tris.length; i++) triIds[i] = idOf(tris[i]);
    const parent = new Int32Array(ids.size);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let t = 0; t < nt; t++) {
        const r0 = find(triIds[t * 3]), r1 = find(triIds[t * 3 + 1]), r2 = find(triIds[t * 3 + 2]);
        parent[r1] = r0; parent[find(r2)] = find(r0);
    }
    const faceCount = new Map();
    for (let t = 0; t < nt; t++) { const r = find(triIds[t * 3]); faceCount.set(r, (faceCount.get(r) || 0) + 1); }
    let keep = -1, best = 0;
    for (const [r, n] of faceCount) if (n > best) { best = n; keep = r; }
    const out = new Float32Array(best * 9);
    let o = 0, area = 0;
    const edges = new Map();
    const x = [0, 0, 0], y = [0, 0, 0], z = [0, 0, 0];
    for (let t = 0; t < nt; t++) {
        if (find(triIds[t * 3]) !== keep) continue;
        for (let k = 0; k < 3; k++) {
            const id = tris[t * 3 + k];
            if (id >= 0) { x[k] = V[id * 3]; y[k] = V[id * 3 + 1]; z[k] = V[id * 3 + 2]; }
            else { const n = -1 - id; x[k] = pts[n * 3]; y[k] = pts[n * 3 + 1]; z[k] = pts[n * 3 + 2]; }
            out[o++] = x[k]; out[o++] = y[k]; out[o++] = z[k];
            const u = tris[t * 3 + k], w = tris[t * 3 + (k + 1) % 3];
            const ek = u < w ? `${u},${w}` : `${w},${u}`;
            edges.set(ek, (edges.get(ek) || 0) + 1);
        }
        const ux = x[1] - x[0], uy = y[1] - y[0], uz = z[1] - z[0], vx = x[2] - x[0], vy = y[2] - y[0], vz = z[2] - z[0];
        area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    }
    // boundary loops: open edges joined into rings
    const open = [];
    for (const [ek, n] of edges) if (n === 1) open.push(ek.split(',').map(Number));
    const lp = new Map();
    const lfind = v => { let r = v; while (lp.get(r) !== r) r = lp.get(r); return r; };
    for (const [u, w] of open) { if (!lp.has(u)) lp.set(u, u); if (!lp.has(w)) lp.set(w, w); lp.set(lfind(u), lfind(w)); }
    const loops = new Set();
    for (const v of lp.keys()) loops.add(lfind(v));
    return { positions: out, faces: best, pieces: faceCount.size, area, loops: loops.size };
}

/** Binary STL of a triangle soup. */
export function toStl(positions, name = 'surface') {
    const nt = positions.length / 9;
    const buffer = new ArrayBuffer(84 + nt * 50);
    const view = new DataView(buffer);
    new Uint8Array(buffer, 0, 80).set(new TextEncoder().encode(`Give a Paw surface interpolator: ${name}`.slice(0, 79)));
    view.setUint32(80, nt, true);
    let o = 84;
    for (let t = 0; t < nt; t++) {
        const i = t * 9;
        const ux = positions[i + 3] - positions[i], uy = positions[i + 4] - positions[i + 1], uz = positions[i + 5] - positions[i + 2];
        const vx = positions[i + 6] - positions[i], vy = positions[i + 7] - positions[i + 1], vz = positions[i + 8] - positions[i + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        view.setFloat32(o, nx / nl, true); view.setFloat32(o + 4, ny / nl, true); view.setFloat32(o + 8, nz / nl, true);
        for (let k = 0; k < 9; k++) view.setFloat32(o + 12 + k * 4, positions[i + k], true);
        view.setUint16(o + 48, 0, true);
        o += 50;
    }
    return new Blob([buffer], { type: 'model/stl' });
}

/** Sort surface files by the first number in their names, so "surface-2" comes before "surface-10". */
export function sortByNumber(files) {
    const num = name => { const m = name.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : NaN; };
    const numbers = files.map(f => num(f.name));
    // only when every name has its own number; otherwise the order they were given in stands
    if (numbers.some(Number.isNaN) || new Set(numbers).size !== numbers.length) return [...files];
    return [...files].sort((a, b) => num(a.name) - num(b.name));
}

export { THREE };
