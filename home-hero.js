// Home page hero: the socket morph plays first, then crossfades into the animal scans, then back, on a loop.
// Clicking or tapping the video (or Enter / Space on it) pauses and resumes it, so the motion can be stopped
// (WCAG 2.2.2) without a visible button; visitors who ask for reduced motion get the first frame until they press it.
(() => {
    const media = document.querySelector('.hero-media');
    if (!media) return;
    const clips = [...media.querySelectorAll('.hero-clip')];
    const FADE = 0.9;                 // seconds; matches the CSS transition
    let current = 0, paused = false, switching = false;

    const play = v => v.play().catch(() => {});   // autoplay can be refused; the poster stays
    function show(n) {
        current = n;
        clips.forEach((v, k) => v.classList.toggle('is-on', k === n));
    }
    // Start the next clip a little before this one ends, so the two overlap during the crossfade.
    function next() {
        if (switching) return;
        switching = true;
        const n = (current + 1) % clips.length;
        const v = clips[n];
        v.currentTime = 0;
        if (!paused) play(v);
        show(n);
        setTimeout(() => { switching = false; }, FADE * 1000);
    }
    clips.forEach((v, k) => {
        v.addEventListener('timeupdate', () => { if (k === current && v.duration && v.duration - v.currentTime < FADE * 0.6) next(); });
        v.addEventListener('ended', () => { if (k === current) next(); });
    });

    function setPaused(on) {
        paused = on;
        media.setAttribute('aria-pressed', String(on));
        media.setAttribute('aria-label', `Ollie's socket designs from nTop, then rotating 3D scans of Billie and Ollie. Press to ${on ? 'play' : 'pause'}.`);
        if (on) clips.forEach(v => v.pause()); else play(clips[current]);
    }
    media.addEventListener('click', () => setPaused(!paused));
    media.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPaused(!paused); } });

    // Reduced motion: hold on the first frame until someone presses play.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) setPaused(true);
    else play(clips[0]);
    // Stop decoding while the hero is off screen; carry on where it was when it comes back.
    if ('IntersectionObserver' in window) {
        new IntersectionObserver(entries => entries.forEach(e => {
            if (paused) return;
            if (e.isIntersecting) play(clips[current]); else clips.forEach(v => v.pause());
        })).observe(media);
    }
    window.heroDebug = { get current() { return current; }, get paused() { return paused; } };
})();
