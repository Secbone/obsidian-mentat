import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";
import fs from "fs";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: {
    main: "src/main.ts",
    styles: "src/ui/index.css"
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
    ...builtinModules
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outdir: "dist",
  entryNames: "[name]",
  minify: prod,
  loader: {
    '.css': 'css'
  }
});

// Ensure dist/ exists and copy manifest
if (!fs.existsSync("dist")) {
  fs.mkdirSync("dist", { recursive: true });
}

const watch = process.argv[2] === "watch";

if (watch) {
  fs.copyFileSync("manifest.json", "dist/manifest.json");
  await context.watch();
  console.log("Watching for changes... (reload Obsidian to pick up)");
} else {
  // One-shot build: either production or a plain dev build (no watch).
  await context.rebuild();
  fs.copyFileSync("manifest.json", "dist/manifest.json");
  console.log("Built dist/ (one-shot). Use 'npm run dev:watch' for HMR.");
  process.exit(0);
}
