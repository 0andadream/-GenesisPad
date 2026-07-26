import { cp, mkdir, rm } from "node:fs/promises";

const output = new URL("../dist/", import.meta.url);
const root = new URL("../", import.meta.url);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL("index.html", root), new URL("index.html", output));
await cp(new URL("styles.css", root), new URL("styles.css", output));
await cp(new URL("public/", root), output, { recursive: true });

console.log("GenesisPad static site built in dist/");
