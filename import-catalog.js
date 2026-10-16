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
        solidPreview: 'chihuahua-1015-solid.glb', solidBytes: 1029811,
        note: 'Scaled 0.95 in Step 1 · socket sweeps',
        surfaces: [{
            name: 'ollie-attachment-surface.glb', file: 'sample-models/chihuahua-1015-surface.glb',
            preview: 'chihuahua-1015-surface.glb', bytes: 236131,
            label: 'Ollie · Socket surface', category: 'socket', variation: 1,
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
        file(breed.solidName, 'solidAnimal', breed.solidBytes, breed.solidPreview, breed.solidFile,
            { label: breed.label + ' scan', note: breed.note, breed: breed.slug, units: breed.units }),
        ...breed.surfaces.map(surface => file(
            surface.name, 'attachment', surface.bytes, surface.preview, surface.file,
            { label: surface.label, breed: breed.slug, category: surface.category, variation: surface.variation, units: breed.units },
        )),
    ]))),
    folder('Interfaces', [
        folder('Mechanical', [
            file('small-mechanical-interface.stl', 'mechanical', 87584, 'small-mechanical.glb', 'sample-models/interfaces/small-mechanical.stl', { label: 'Small Mechanical Interface', sizeClass: 'small' }),
            file('large-mechanical-interface.glb', 'mechanical', 37832, 'large-mechanical.glb', 'billie-mechanical-interface.glb', { label: 'Large Mechanical Interface', sizeClass: 'large' }),
        ]),
        folder('Solid', [
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
