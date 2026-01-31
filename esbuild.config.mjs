import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: {
    main: "src/main.ts",
    styles: "src/ui/styles/chat.css"
  },
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
  outdir: ".",
  entryNames: "[name]",
  minify: prod,
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
