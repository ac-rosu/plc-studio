// CSS files are bundled as text (esbuild loader 'text').
declare module '*.css' {
  const content: string;
  export default content;
}
