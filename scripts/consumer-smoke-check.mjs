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

  for (const name of names) {
    const manifest = JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8"));
    const prefix = manifest.name.replace("@", "").replace("/", "-") + "-" + manifest.version;
    const file = files.find((entry) => entry === prefix + ".tgz");
    if (!file) throw new Error("Missing packed tarball: " + prefix + ".tgz");
    tarballs.set(manifest.name, join(packageDir, file));
  }

  // Validate that pnpm rewrites workspace:* dependencies into publishable semver ranges.
  for (const [packageName, tarball] of tarballs) {
    const check = spawnSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" });
    if (check.status !== 0) throw new Error("Could not inspect tarball manifest: " + packageName);
    const manifest = JSON.parse(check.stdout);
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [dependency, range] of Object.entries(manifest[section] ?? {})) {
        if (range === "workspace:*") {
          throw new Error(packageName + " still contains workspace:* for " + dependency);
        }
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
