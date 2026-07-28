import { cp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const output = new URL("../dist/", import.meta.url);
const root = new URL("../", import.meta.url);
const rootDir = fileURLToPath(root);
const outDir = fileURLToPath(output);

async function exists(url) {
  try {
    await access(fileURLToPath(url));
    return true;
  } catch {
    return false;
  }
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

// Static landing page assets
for (const name of ["index.html", "styles.css", "logo.css", "sculpture.css", "app.js"]) {
  const src = new URL(name, root);
  if (await exists(src)) {
    await cp(src, new URL(name, output));
  }
}

// App shell (HTML/CSS). JS is bundled below.
if (await exists(new URL("app/", root))) {
  await cp(new URL("app/", root), new URL("app/", output), { recursive: true });
}

// Bundle launchpad app for the browser (IIFE, no native ESM loaders needed).
const entry = fileURLToPath(new URL("app/app.js", root));
const outfile = fileURLToPath(new URL("app/app.js", output));
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
  logLevel: "info",
});

// Public static assets (logo, favicon, stats.json, …)
if (await exists(new URL("public/", root))) {
  await cp(new URL("public/", root), output, { recursive: true });
}

// Optional OpenAI hosting metadata (must not fail the Vercel build).
if (await exists(new URL(".openai/hosting.json", root))) {
  await mkdir(new URL(".openai/", output), { recursive: true });
  await cp(
    new URL(".openai/hosting.json", root),
    new URL(".openai/hosting.json", output),
  );
}

// Lightweight asset worker stub for non-Vercel hosts.
await mkdir(new URL("server/", output), { recursive: true });
await writeFile(
  new URL("server/index.js", output),
  "export default { async fetch(request, env) { return env.ASSETS.fetch(request); } };\n",
);

console.log(`GenesisPad static site built in ${outDir} (from ${rootDir})`);
