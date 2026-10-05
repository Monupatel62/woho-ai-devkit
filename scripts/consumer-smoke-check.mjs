import { mkdtemp, readFile, rm, readdir, writeFile } from "node:fs/promises";
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
  const tarballs = [];

  for (const name of names) {
    const manifest = JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8"));
    const expected = manifest.name.replace("@", "").replace("/", "-") + "-" + manifest.version + ".tgz";
    const tarball = join(packageDir, expected);
    if (!files.includes(expected)) throw new Error("Missing packed tarball: " + expected);
    tarballs.push(tarball);
  }

  await writeFile(
    join(temp, "package.json"),
    JSON.stringify({ name: "woho-consumer-smoke", version: "1.0.0", private: true }, null, 2) + "\n"
  );

  run("pnpm", ["add", "--no-frozen-lockfile", ...tarballs], temp);

  const smoke = spawnSync(process.execPath, ["--input-type=module", "-e",
    'const pkgs=["@woho/core","@woho/provider-openai","@woho/agents","@woho/tools","@woho/memory","@woho/mcp"]; for (const p of pkgs) { const m=await import(p); if (!m) throw new Error("empty module: "+p); } console.log("consumer smoke check passed: "+pkgs.length+" packages");'
  ], { cwd: temp, stdio: "inherit" });
  if (smoke.status !== 0) throw new Error("consumer import smoke check failed");
} finally {
  await rm(temp, { recursive: true, force: true });
}
