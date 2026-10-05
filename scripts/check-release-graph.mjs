import { readFile } from "node:fs/promises";
import { join } from "node:path";

const packageNames = ["core", "provider-openai", "agents", "tools", "memory", "mcp"];
const packages = new Map();

for (const directory of packageNames) {
  const path = join("packages", directory, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  packages.set(manifest.name, { directory, manifest });
}

const root = JSON.parse(await readFile("package.json", "utf8"));
if (root.private !== true) throw new Error("Workspace root must remain private.");

for (const [name, { directory, manifest }] of packages) {
  if (manifest.private === true) throw new Error(name + " must not be private.");
  if (manifest.license !== "Apache-2.0") throw new Error(name + " must use Apache-2.0.");
  if (manifest.engines?.node !== ">=20") throw new Error(name + " must require Node >=20.");
  if (manifest.type !== "module") throw new Error(name + " must be an ES module.");
  if (manifest.main !== "dist/index.js" || manifest.types !== "dist/index.d.ts") throw new Error(name + " has invalid main/types metadata.");
  if (manifest.publishConfig?.access !== "public") throw new Error(name + " must publish with public access.");
  if (!Array.isArray(manifest.files) || !manifest.files.includes("dist")) throw new Error(name + " must publish dist.");
  if (!manifest.exports?.["."]?.import || !manifest.exports?.["."]?.types) throw new Error(name + " must expose import and types entries.");
  if (manifest.exports["."].import !== "./dist/index.js" || manifest.exports["."].types !== "./dist/index.d.ts") throw new Error(name + " has invalid export targets.");
  if (!manifest.repository?.url?.endsWith("woho-ai-devkit.git")) throw new Error(name + " has invalid repository metadata.");
  if (!manifest.repository?.directory || !manifest.homepage) throw new Error(name + " is missing repository directory or homepage metadata.");

  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [dependency, range] of Object.entries(manifest[section] ?? {})) {
      if (range !== "workspace:*") continue;
      const target = packages.get(dependency);
      if (!target) throw new Error(directory + " references missing workspace package " + dependency);
      if (target.manifest.private === true) throw new Error(directory + " depends on private package " + dependency);
      if (target.manifest.publishConfig?.access !== "public") throw new Error(directory + " depends on non-public package " + dependency);
    }
  }
}

console.log("release graph check passed: " + packages.size + " public packages");
