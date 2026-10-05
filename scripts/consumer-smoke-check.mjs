import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const names = ["core", "provider-openai", "agents", "tools", "memory", "mcp"];
const root = process.cwd();
const packageDir = join(root, ".release-packages");
const temp = await mkdtemp(join(tmpdir(), "woho-consumer-"));

try {
  const tarballs = [];
  for (const name of names) {
    const manifest = JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8"));
    tarballs.push(join(packageDir, manifest.name.replace("@", "").replace("/", "-") + "-" + manifest.version + ".tgz"));
  }

  const init = spawnSync("pnpm", ["init"], { cwd: temp, stdio: "inherit" });
  if (init.status !== 0) throw new Error("pnpm init failed");

  const install = spawnSync("pnpm", ["add", ...tarballs], { cwd: temp, stdio: "inherit" });
  if (install.status !== 0) throw new Error("packed package installation failed");

  const smoke = spawnSync(process.execPath, ["--input-type=module", "-e",
    'const pkgs=["@woho/core","@woho/provider-openai","@woho/agents","@woho/tools","@woho/memory","@woho/mcp"]; for (const p of pkgs) { const m=await import(p); if (!m) throw new Error("empty module: "+p); } console.log("consumer smoke check passed: "+pkgs.length+" packages");'
  ], { cwd: temp, stdio: "inherit" });
  if (smoke.status !== 0) throw new Error("consumer import smoke check failed");
} finally {
  await rm(temp, { recursive: true, force: true });
}
