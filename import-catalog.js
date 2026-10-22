// Virtual file system for the import stage. It mirrors how the source meshes would sit on disk
// when a student imports them into nTop. `file` is what the walkthrough really loads; `preview`
// is a decimated Draco GLB in sample-models/previews used only for quick previews.
//
// This walkthrough is Ollie's case, so the browser only carries Ollie's scan. The names shown in the
// explorer are Ollie's; `file` still points at the mesh as it is stored on the site and in the model
// bucket (sample-models/chihuahua-1015-*.glb, the 10-15 scan), so nothing has to be re-uploaded.
// The two interfaces are named by the size they fit, not by the dog they were first cut for:
// the small one is Ollie's, the large one is Billie's.

export const BREEDS = [
    {
        slug: 'ollie', label: 'Ollie', units: 'm',
        solidName: 'ollie-solid.glb', solidFile: 'sample-models/chihuahua-1015-solid.glb',
        solidPreview: 'chihuahua-1015-solid.glb', solidBytes: 134836,
        note: 'Scaled 0.95 in Step 1 · socket sweeps',
        // Three proposal surfaces (10-13), each with its own socket and blend sweeps (surfaceSet picks the
        // model folder: high = sample-models/chi-socket & chi-final, low / standard = the -low / -standard sets).
        surfaces: [{
            name: 'ollie-attachment-surface-high.glb', file: 'sample-models/chihuahua-1015-surface.glb',
            preview: 'chihuahua-1015-surface.glb', bytes: 31924,
            label: 'Ollie · Socket surface (high)', category: 'socket', variation: 1, surfaceSet: 'high',
        }, {
            name: 'ollie-attachment-surface-standard.glb', file: 'sample-models/ollie-surface-standard.glb',
            preview: 'ollie-surface-standard.glb', bytes: 32248,
            label: 'Ollie · Socket surface (standard)', category: 'socket', variation: 2, surfaceSet: 'standard',
        }, {
            name: 'ollie-attachment-surface-low.glb', file: 'sample-models/ollie-surface-low.glb',
            preview: 'ollie-surface-low.glb', bytes: 31460,
            label: 'Ollie · Socket surface (low)', category: 'socket', variation: 3, surfaceSet: 'low',
        }],
    },
    {
        // The 10-21 wheelchair case. Its scan, its two interfaces and its 274 blend sockets were all
        // generated together in the 0.95-scaled nTop frame, so this case is stored in that frame and
        // keeps to itself: the 10-15 sweeps above do not fit it and its sockets do not fit them.
        // Its attachment surface has not been exported yet, so the case cannot be completed in the
        // browser until it arrives.
        slug: 'chi-wc', label: 'Chihuahua (wheelchair)', units: 'm',
        solidName: 'chihuahua-wc-solid.glb', solidFile: 'sample-models/chi-wc-solid.glb',
        solidPreview: 'chi-wc-solid.glb', solidBytes: 347892,
        note: 'Wheelchair case 10-21 · blend sockets',
        blendSet: 'wheelchair',
        surfaces: [{
            name: 'chihuahua-wc-attachment-surface.glb', file: 'sample-models/chi-wc-surface.glb',
            preview: 'chi-wc-surface.glb', bytes: 143176,
            label: 'Chihuahua wheelchair · Socket surface', category: 'socket', variation: 1, surfaceSet: 'high',
        }],
    },
];

export const CATEGORIES = { farback: 'Far back', forward: 'Forward', leghole: 'Leg hole', toolow: 'Too low' };

export const ROLES = {
    solidAnimal: { name: 'Solid Animal Mesh', short: 'Solid animal', color: 0x496b94, opacity: 0.3, units: 'm', start: ['Animals'] },
    attachment: { name: 'Attachment Animal Mesh', short: 'Attachment surface', color: 0x169c8c, opacity: 0.9, units: 'm', start: ['Animals'] },
    mechanical: { name: 'Mechanical Interface', short: 'Mechanical interface', color: 0xdf7544, opacity: 1, units: 'mm', start: ['Interfaces'] },
    solidInterface: { name: 'Solid Interface', short: 'Solid interface', color: 0x6750a4, opacity: 1, units: 'mm', start: ['Interfaces'] },
};

function folder(name, children) { return { kind: 'folder', name, children }; }
function file(name, role, bytes, preview, realFile, extra = {}) {
    const ext = name.split('.').pop().toLowerCase();
    return {
        kind: 'file', name, role, bytes, ext: ext.toUpperCase(), type: ext === 'glb' ? 'glb' : ext,
        preview: 'sample-models/previews/' + preview, file: realFile, units: ROLES[role].units, ...extra,
    };
}

export const FS = folder('Give a Paw', [
    folder('Animals', BREEDS.map(breed => folder(breed.label, [
        ...(breed.solidFile ? [file(breed.solidName, 'solidAnimal', breed.solidBytes, breed.solidPreview, breed.solidFile,
            { label: breed.label + ' scan', note: breed.note, breed: breed.slug, units: breed.units, blendSet: breed.blendSet })] : []),
        ...breed.surfaces.map(surface => file(
            surface.name, 'attachment', surface.bytes, surface.preview, surface.file,
            { label: surface.label, breed: breed.slug, category: surface.category, variation: surface.variation, surfaceSet: surface.surfaceSet, units: breed.units, blendSet: breed.blendSet },
        )),
    ]))),
    folder('Interfaces', [
        folder('Mechanical', [
            file('wheelchair-mechanical-interface.stl', 'mechanical', 116284, 'wheelchair-mechanical.glb', 'sample-models/interfaces/wheelchair-mechanical.stl', { label: 'Wheelchair Mechanical Interface', sizeClass: 'wheelchair' }),
            file('small-mechanical-interface.stl', 'mechanical', 87584, 'small-mechanical.glb', 'sample-models/interfaces/small-mechanical.stl', { label: 'Small Mechanical Interface', sizeClass: 'small' }),
            file('large-mechanical-interface.glb', 'mechanical', 37832, 'large-mechanical.glb', 'billie-mechanical-interface.glb', { label: 'Large Mechanical Interface', sizeClass: 'large' }),
        ]),
        folder('Solid', [
            file('wheelchair-solid-interface.stl', 'solidInterface', 684, 'wheelchair-solid.glb', 'sample-models/interfaces/wheelchair-solid.stl', { label: 'Wheelchair Solid Interface', sizeClass: 'wheelchair' }),
            file('small-solid-interface.stl', 'solidInterface', 23784, 'small-solid.glb', 'sample-models/interfaces/small-solid.stl', { label: 'Small Solid Interface', sizeClass: 'small' }),
            file('large-solid-interface.stl', 'solidInterface', 14884, 'large-solid.glb', 'billie-solid-interface.stl', { label: 'Large Solid Interface', sizeClass: 'large' }),
        ]),
    ]),
]);

(function assignPaths(node, path) {
    node.path = path;
    node.pathLabel = path.join(' / ');
    if (node.kind === 'folder') node.children.forEach(child => assignPaths(child, [...path, child.name]));
})(FS, [FS.name]);

export function resolve(path) {
    let node = FS;
    for (const name of path.slice(1)) node = node.children.find(child => child.name === name);
    return node;
}

export function allFiles(node = FS) {
    return node.kind === 'file' ? [node] : node.children.flatMap(allFiles);
}

export function filesForRole(role) {
    return allFiles().filter(entry => entry.role === role);
}

export function folderEntries(folderNode) {
    return [...folderNode.children.filter(child => child.kind === 'folder'), ...folderNode.children.filter(child => child.kind === 'file')];
}

export function startFolder(role) {
    return resolve([FS.name, ...ROLES[role].start]);
}

export function formatBytes(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    return Math.round(bytes / 1024) + ' KB';
}
