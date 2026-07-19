// Asset imports resolved by the bundler, not by TypeScript. `lib/ui--server--brookebrodack`
// imports images directly (`import bg from '../public/assets/images/nature-origami-bg.webp'`)
// and gets back the emitted URL string.
//
// app/brookebrodack-site gets these from `rebuildjs/types`, but rebuildjs is not a
// dependency of this package — it lives in the app submodule — so `types: ["rebuildjs/types"]`
// aborts the whole check with TS2688. Declared locally instead.
declare module '*.avif' { const src:string; export default src }
declare module '*.gif' { const src:string; export default src }
declare module '*.jpeg' { const src:string; export default src }
declare module '*.jpg' { const src:string; export default src }
declare module '*.png' { const src:string; export default src }
declare module '*.svg' { const src:string; export default src }
declare module '*.webp' { const src:string; export default src }
declare module '*.css' { const href:string; export default href }
