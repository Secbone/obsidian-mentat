import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import fs from "fs";
import path from "path";

const prod = process.argv[2] === "production";

// Custom plugin to rename main.css to styles.css
const cssRenamePlugin = {
  name: 'css-rename',
  setup(build) {
    build.onEnd(() => {
      const mainCssPath = path.join(process.cwd(), 'main.css');
      const stylesCssPath = path.join(process.cwd(), 'styles.css');

      if (fs.existsSync(mainCssPath)) {
        fs.renameSync(mainCssPath, stylesCssPath);
        console.log('✅ Renamed main.css to styles.css');
      }
    });
  }
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  plugins: [cssRenamePlugin],
  loader: {
    '.css': 'css'
  }
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
  console.log("Watching for changes...");
}
