import { cp, mkdir, rm, writeFile } from "node:fs/promises";

const output = new URL("../dist/", import.meta.url);
const root = new URL("../", import.meta.url);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL("index.html", root), new URL("index.html", output));
await cp(new URL("styles.css", root), new URL("styles.css", output));
await cp(new URL("app.js", root), new URL("app.js", output));
await cp(new URL("app/", root), new URL("app/", output), { recursive: true });
await cp(new URL("public/", root), output, { recursive: true });
await mkdir(new URL("server/", output), { recursive: true });
await writeFile(
  new URL("server/index.js", output),
  'export default { async fetch(request, env) { return env.ASSETS.fetch(request); } };'
);
await mkdir(new URL(".openai/", output), { recursive: true });
await cp(
  new URL(".openai/hosting.json", root),
  new URL(".openai/hosting.json", output)
);

console.log("GenesisPad static site built in dist/");
