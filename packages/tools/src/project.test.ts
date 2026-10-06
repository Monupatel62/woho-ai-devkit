import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProjectTools } from "./index.js";

const root = await mkdtemp(join(process.cwd(), ".woho-project-test-"));
try {
  const tools = createProjectTools({
    root,
    workspace: { allowWrite: true },
    git: { allowWrite: true },
    command: { allowedCommands: ["node"] },
  });

  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["command", "git", "workspace"]);
  assert.equal(tools.find((tool) => tool.name === "workspace")?.capability, "file");
  assert.equal(tools.find((tool) => tool.name === "git")?.capability, "git");

  const workspace = tools.find((tool) => tool.name === "workspace")!;
  await workspace.execute({ operation: "write", path: "hello.txt", content: "woho" });
  const result = await workspace.execute({ operation: "read", path: "hello.txt" }) as { content: string };
  assert.equal(result.content, "woho");

  const command = tools.find((tool) => tool.name === "command")!;
  const commandResult = await command.execute({
    command: process.execPath,
    args: ["-e", "process.stdout.write('project-ok')"],
    cwd: root,
  }) as { stdout: string };
  assert.equal(commandResult.stdout, "project-ok");

  const failingGit = tools.find((tool) => tool.name === "git")!;
  await assert.rejects(
    () => failingGit.execute({ operation: "add", paths: ["missing-file-for-error-redaction"] }),
    (error: unknown) => error instanceof Error && error.message === "Git operation failed",
  );

  const controller = new AbortController();
  const pending = command.execute({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"],
    cwd: root,
  }, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("test abort")), 50);
  await assert.rejects(() => pending, /test abort|aborted/i);

  console.log("project tool tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
