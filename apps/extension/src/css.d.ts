// The extension esbuild context loads `*.css` imports with the `text` loader
// (see esbuild.js), so an inline-template webview can embed a stylesheet's raw
// bytes into its <style>. Typed here as a string default export so `tsc`
// accepts `import tokensCss from "…/tokens.css"`.
declare module "*.css" {
  const content: string;
  export default content;
}
