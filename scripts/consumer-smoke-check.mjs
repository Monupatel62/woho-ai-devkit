import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const names = ["core", "provider-openai", "agents", "tools", "memory", "mcp"];
const root = process.cwd();
const packageDir = join(root, ".release-packages");
const temp = await mkdtemp(join(tmpdir(), "woho-consumer-"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(command + " " + args.join(" ") + " failed");
}

try {
  const files = await readdir(packageDir);
  const tarballs = new Map();
  const sourceManifests = new Map();

  for (const name of names) {
    const manifest = JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8"));
    sourceManifests.set(manifest.name, manifest);
    const prefix = manifest.name.replace("@", "").replace("/", "-") + "-" + manifest.version;
    const file = files.find((entry) => entry === prefix + ".tgz");
    if (!file) throw new Error("Missing packed tarball: " + prefix + ".tgz");
    tarballs.set(manifest.name, join(packageDir, file));
  }

  // Validate publish rewriting and tarball boundaries before any consumer install.
  for (const [packageName, tarball] of tarballs) {
    const source = sourceManifests.get(packageName);
    if (!source) throw new Error("Missing source manifest: " + packageName);
    const check = spawnSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" });
    if (check.status !== 0) throw new Error("Could not inspect tarball manifest: " + packageName);
    const manifest = JSON.parse(check.stdout);

    if (manifest.name !== source.name || manifest.version !== source.version) {
      throw new Error(packageName + " tarball name/version does not match source metadata");
    }
    if (manifest.private === true) throw new Error(packageName + " tarball must not be private");
    if (manifest.devDependencies) throw new Error(packageName + " tarball must not contain devDependencies");

    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [dependency, range] of Object.entries(manifest[section] ?? {})) {
        if (range === "workspace:*" || range.startsWith("workspace:")) {
          throw new Error(packageName + " still contains workspace protocol for " + dependency);
        }
        const sourceRange = source[section]?.[dependency];
        if (sourceRange === "workspace:*") {
          const target = [...sourceManifests.values()].find((candidate) => candidate.name === dependency);
          if (!target || range !== target.version) {
            throw new Error(packageName + " must publish internal dependency " + dependency + " at exact version " + (target?.version ?? "unknown") + ", got " + range);
          }
        }
      }
    }

    const listing = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    if (listing.status !== 0) throw new Error("Could not list tarball: " + packageName);
    const entries = listing.stdout.split("\n").filter(Boolean);
    for (const required of ["package/package.json", "package/README.md", "package/LICENSE", "package/dist/index.js", "package/dist/index.d.ts"]) {
      if (!entries.includes(required)) throw new Error(packageName + " tarball missing required file: " + required);
    }
    const licenseCheck = spawnSync("tar", ["-xOf", tarball, "package/LICENSE"], { encoding: "utf8" });
    if (licenseCheck.status !== 0 || !licenseCheck.stdout.includes("Apache License") || !licenseCheck.stdout.includes("Version 2.0, January 2004") || !licenseCheck.stdout.includes("END OF TERMS AND CONDITIONS")) {
      throw new Error(packageName + " tarball does not contain the full Apache-2.0 license text");
    }
    for (const entry of entries) {
      if (/package\/(?:src|test|tests|\.github|\.git|\.env|tsconfig|coverage)\b|(?:\.map|\.ts)$/.test(entry)) {
        throw new Error(packageName + " tarball contains development/source artifact: " + entry);
      }
    }
  }

  // Install and execute the packages without internal workspace dependencies first.
  const independent = ["@woho/core", "@woho/memory"];
  run("pnpm", ["init"], temp);
  run("pnpm", ["add", "--config.auto-install-peers=false", ...independent.map((name) => tarballs.get(name))], temp);

  const smoke = spawnSync(process.execPath, ["--input-type=module", "-e",
    'const pkgs=["@woho/core","@woho/memory"]; for (const p of pkgs) { const m=await import(p); if (!m) throw new Error("empty module: "+p); } console.log("consumer smoke check passed: "+pkgs.length+" independently installable packages");'
  ], { cwd: temp, stdio: "inherit" });
  if (smoke.status !== 0) throw new Error("consumer import smoke check failed");

  console.log("packed manifest check passed: " + tarballs.size + " packages");
} finally {
  await rm(temp, { recursive: true, force: true });
}
