// Lets TypeScript accept the side-effect CSS imports that esbuild bundles
// (the shared diff/graph stylesheets and the app shell CSS).
declare module "*.css";
