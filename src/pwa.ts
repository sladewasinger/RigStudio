/**
 * D1 PWA installability: registers `public/sw.js` (see that file for what it caches and
 * why) ONLY in production builds. `import.meta.env.PROD` is false for `npm run dev` and
 * for the interaction suite (Vitest Browser Mode runs through Vite's dev pipeline) — so
 * neither ever registers a service worker, keeping HMR and the test suite untouched, as
 * required. `BASE_URL` (not a hardcoded leading slash) so the registration scope is
 * correct under any deploy base (e.g. `npm run pages`'s `/RigStudio/`).
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* registration failure (unsupported engine, blocked storage) shouldn't break the app */
    });
  });
}
