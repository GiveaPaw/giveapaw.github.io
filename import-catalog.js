// Virtual file system for the import stage. It mirrors how the source meshes would sit on disk
// when a student imports them into nTop. `file` is what the walkthrough really loads; `preview`
// is a decimated Draco GLB in sample-models/previews used only for quick previews.

export const BREEDS = [
    // The 10-13 notebook's case: the scan nTop scales by 0.95, with the attachment surface the socket sweeps were run on.
    { slug: 'chihuahua-1015', label: 'Chihuahua (10-15)', solidFile: 'chihuahua-1015-solid.glb', solidBytes: 1029811, note: 'Scaled 0.95 in Step 1 · socket sweeps', units: 'mm',
      surfaces: [{ name: 'chihuahua-1015-surface.glb', bytes: 236131, label: 'Chihuahua (10-15) · Socket surface', category: 'socket', variation: 1 }] },
    { slug: 'chihuahua', label: 'Chihuahua', solidFile: 'chihuahua-original.obj', solidBytes: 27662866, note: 'Billie · full-body scan' },
    { slug: 'greyhound', label: 'Greyhound', solidFile: 'greyhound-solid.obj', solidBytes: 5309776, note: 'Golden hound · MeshMixer clean-up' },
    { slug: 'german-shepherd', label: 'German Shepherd', solidFile: 'german-shepherd-solid.obj', solidBytes: 7316862, note: 'Demo 7/17 · MeshMixer clean-up' },
];

export const CATEGORIES = { farback: 'Far back', forward: 'Forward', leghole: 'Leg hole', toolow: 'Too low' };

const ATTACHMENT_BYTES = {
    chihuahua: { farback: [2531384, 2841534, 3613534], forward: [2246134, 2127284, 2024234], leghole: [2385634, 2522234, 2569584], toolow: [2114334, 2062284, 2060734] },
    'german-shepherd': { farback: [582584, 682384, 865184], forward: [479684, 459184, 434684], leghole: [491784, 533134, 581034], toolow: [444034, 425434, 409534] },
    greyhound: { farback: [354634, 392834, 478184], forward: [341184, 321934, 298034], leghole: [350234, 374984, 400184], toolow: [334484, 313434, 306784] },
};

export const ROLES = {
    solidAnimal: { name: 'Solid Animal Mesh', short: 'Solid animal', color: 0x496b94, opacity: 0.3, units: 'm', start: ['Animals'] },
    attachment: { name: 'Attachment Animal Mesh', short: 'Attachment surface', color: 0x169c8c, opacity: 0.9, units: 'm', start: ['Animals', 'Chihuahua (10-15)', 'Attachment surfaces'] },
    mechanical: { name: 'Mechanical Interface', short: 'Mechanical interface', color: 0xdf7544, opacity: 1, units: 'mm', start: ['Interfaces', 'Mechanical'] },
    solidInterface: { name: 'Solid Interface', short: 'Solid interface', color: 0x6750a4, opacity: 1, units: 'mm', start: ['Interfaces', 'Solid'] },
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
        file(breed.solidFile, 'solidAnimal', breed.solidBytes, breed.slug + '-solid.glb',
            'sample-models/' + breed.solidFile + (breed.slug === 'chihuahua' ? '?v=4x' : ''),
            { label: breed.label + ' original', note: breed.note, breed: breed.slug, ...(breed.units ? { units: breed.units } : {}) }),
        folder('Attachment surfaces', breed.surfaces ? breed.surfaces.map(surface => file(
            surface.name, 'attachment', surface.bytes, surface.name, 'sample-models/' + surface.name,
            { label: surface.label, breed: breed.slug, category: surface.category, variation: surface.variation, units: breed.units },
        )) : Object.keys(CATEGORIES).flatMap(category => [1, 2, 3].map(variation => file(
            `${breed.slug}-${category}-${variation}.stl`, 'attachment', ATTACHMENT_BYTES[breed.slug][category][variation - 1],
            `${breed.slug}-${category}-${variation}.glb`,
            `sample-models/${breed.slug}-${category}-${variation}.stl${breed.slug === 'chihuahua' ? '?v=4x' : ''}`,
            { label: `${breed.label} · ${CATEGORIES[category]} · ${variation}`, breed: breed.slug, category, variation },
        )))),
    ]))),
    folder('Interfaces', [
        folder('Mechanical', [
            file('billie-mechanical-interface.glb', 'mechanical', 37832, 'large-mechanical.glb', 'billie-mechanical-interface.glb', { label: 'Large dog (Billie)', sizeClass: 'large' }),
            file('ollie-mechanical-interface.stl', 'mechanical', 87584, 'small-mechanical.glb', 'sample-models/interfaces/small-mechanical.stl', { label: 'Small dog (Ollie)', sizeClass: 'small' }),
        ]),
        folder('Solid', [
            file('billie-solid-interface.stl', 'solidInterface', 14884, 'large-solid.glb', 'billie-solid-interface.stl', { label: 'Large dog (Billie)', sizeClass: 'large' }),
            file('ollie-solid-interface.stl', 'solidInterface', 23784, 'small-solid.glb', 'sample-models/interfaces/small-solid.stl', { label: 'Small dog (Ollie)', sizeClass: 'small' }),
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
