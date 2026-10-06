import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { updateRemoteOmpEnv } from "../scripts/configure-remote-omp-env.ts";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(process.cwd(), ".tmp-dash-deploy-remote-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("remote OMP environment", () => {
  test("replaces one marked block, preserves other lines and existing permissions", async () => {
    const file = join(scratch, ".zshenv.local");
    const zshenv = join(scratch, ".zshenv");
    const original = "export KEEP_ME=1\n# unrelated local setting\n";
    const originalZshenv = "export PATH=/usr/bin:/bin\n";
    await writeFile(file, original);
    await chmod(file, 0o640);
    await writeFile(zshenv, originalZshenv);
    await chmod(zshenv, 0o640);

    const settings = { url: "https://hub.example/ingest/omp", host: "WORKSTATION", zshenv };
    expect(await updateRemoteOmpEnv(file, settings)).toBe(true);
    const first = await readFile(file, "utf8");
    const firstZshenv = await readFile(zshenv, "utf8");
    expect(first).toContain(original);
    expect(first).toContain("export DASH_URL='https://hub.example/ingest/omp'");
    expect(first).toContain("export DASH_HOST='WORKSTATION'");
    expect(first.split("# >>> dash remote omp >>>")).toHaveLength(2);
    expect(firstZshenv).toContain(originalZshenv);
    expect(firstZshenv).toContain("[[ -r \"$HOME/.zshenv.local\" ]] && source \"$HOME/.zshenv.local\"");
    expect(await (await stat(file)).mode & 0o777).toBe(0o640);
    expect(await (await stat(zshenv)).mode & 0o777).toBe(0o640);
    const localInode = (await stat(file)).ino;
    const zshenvInode = (await stat(zshenv)).ino;

    expect(await updateRemoteOmpEnv(file, settings)).toBe(false);
    expect(await readFile(file, "utf8")).toBe(first);
    expect(await readFile(zshenv, "utf8")).toBe(firstZshenv);
    expect((await stat(file)).ino).toBe(localInode);
    expect((await stat(zshenv)).ino).toBe(zshenvInode);
    expect(await updateRemoteOmpEnv(file, { ...settings, host: "new-host" })).toBe(true);
    const replaced = await readFile(file, "utf8");
    expect(replaced.split("# >>> dash remote omp >>>")).toHaveLength(2);
    expect(replaced).toContain("export DASH_HOST='new-host'");
    expect(replaced).not.toContain("export DASH_HOST='WORKSTATION'");

    expect(await updateRemoteOmpEnv(file, { uninstall: true, zshenv })).toBe(true);
    expect(await readFile(file, "utf8")).toBe(original);
    expect(await readFile(zshenv, "utf8")).toBe(originalZshenv);
  });

  test("creates missing zshenv.local with mode 600 and zshenv with mode 644", async () => {
    const file = join(scratch, ".zshenv.local");
    const zshenv = join(scratch, ".zshenv");
    await updateRemoteOmpEnv(file, { url: "https://hub.example/ingest/omp", host: "mbp", zshenv });
    expect(await (await stat(file)).mode & 0o777).toBe(0o600);
    expect(await (await stat(zshenv)).mode & 0o777).toBe(0o644);
  });

  test("does not append a loader when a bootstrap-style source line already exists", async () => {
    const file = join(scratch, ".zshenv.local");
    const zshenv = join(scratch, ".zshenv");
    const bootstrap = "[[ -r \"$HOME/.zshenv.local\" ]] && source \"$HOME/.zshenv.local\"\n";
    await writeFile(zshenv, bootstrap);
    const inode = (await stat(zshenv)).ino;

    expect(await updateRemoteOmpEnv(file, { url: "https://hub.example/ingest/omp", host: "mbp", zshenv })).toBe(true);
    expect(await readFile(zshenv, "utf8")).toBe(bootstrap);
    expect((await stat(zshenv)).ino).toBe(inode);
  });

  test("appends a loader when the only source-looking line is commented out", async () => {
    const file = join(scratch, ".zshenv.local");
    const zshenv = join(scratch, ".zshenv");
    const comment = "# source \"$HOME/.zshenv.local\"\n";
    await writeFile(zshenv, comment);

    expect(await updateRemoteOmpEnv(file, { url: "https://hub.example/ingest/omp", host: "mbp", zshenv })).toBe(true);
    const result = await readFile(zshenv, "utf8");
    expect(result).toContain(comment);
    expect(result.split("# >>> dash zshenv.local loader >>>")).toHaveLength(2);
  });

  test("uninstall removes only the Dash loader block and keeps a pre-existing source line", async () => {
    const file = join(scratch, ".zshenv.local");
    const zshenv = join(scratch, ".zshenv");
    const sourceLine = ". \"$HOME/.zshenv.local\" # bootstrap source\n";
    const contents = `${sourceLine}# keep this setting\n# >>> dash zshenv.local loader >>>\n[[ -r \"$HOME/.zshenv.local\" ]] && source \"$HOME/.zshenv.local\"\n# <<< dash zshenv.local loader <<<\n`;
    await writeFile(zshenv, contents);

    expect(await updateRemoteOmpEnv(file, { uninstall: true, zshenv })).toBe(true);
    expect(await readFile(zshenv, "utf8")).toBe(`${sourceLine}# keep this setting\n`);
  });

  test("rejects a dangling zshenv.local symlink without replacing it", async () => {
    const file = join(scratch, ".zshenv.local");
    const target = join(scratch, "missing-local-target");
    const zshenv = join(scratch, ".zshenv");
    await symlink(target, file);

    await expect(updateRemoteOmpEnv(file, { url: "https://hub.example/ingest/omp", host: "mbp", zshenv }))
      .rejects.toThrow(`Dangling symlink at ${file}`);
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    await expect(stat(target)).rejects.toThrow();
    await expect(stat(zshenv)).rejects.toThrow();
  });

  test("rejects a dangling zshenv symlink without writing either path", async () => {
    const file = join(scratch, ".zshenv.local");
    const zshenv = join(scratch, ".zshenv");
    const target = join(scratch, "missing-zshenv-target");
    await symlink(target, zshenv);

    await expect(updateRemoteOmpEnv(file, { url: "https://hub.example/ingest/omp", host: "mbp", zshenv }))
      .rejects.toThrow(`Dangling symlink at ${zshenv}`);
    expect((await lstat(zshenv)).isSymbolicLink()).toBe(true);
    await expect(stat(target)).rejects.toThrow();
    await expect(stat(file)).rejects.toThrow();
  });

  test("CLI accepts --file and --zshenv path overrides", async () => {
    const file = join(scratch, ".custom-zshenv.local");
    const zshenv = join(scratch, ".custom-zshenv");
    const proc = Bun.spawn([
      process.execPath,
      "run",
      join(process.cwd(), "scripts/configure-remote-omp-env.ts"),
      "--file", file,
      "--zshenv", zshenv,
      "--url", "https://hub.example/ingest/omp",
      "--host", "mbp",
    ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout + stderr).toContain(file);
    expect(await readFile(file, "utf8")).toContain("export DASH_HOST='mbp'");
    expect(await readFile(zshenv, "utf8")).toContain("# >>> dash zshenv.local loader >>>");
  });
});

describe("deploy-remote.sh", () => {
  test("requires an explicit hub before remote access but permits uninstall without one", async () => {
    const fakeBin = join(scratch, "bin");
    const sshMarker = join(scratch, "ssh-called");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(fakeBin, "ssh"), `#!/bin/sh\nprintf called > '${sshMarker}'\n`);
    await chmod(join(fakeBin, "ssh"), 0o755);

    const run = async (args: string[], hub: string) => {
      const proc = Bun.spawn([
        "/bin/bash", join(process.cwd(), "scripts/deploy-remote.sh"),
        "user@192.0.2.10", "workstation", ...args,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, DASH_HUB: hub, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { output: stdout + stderr, exitCode };
    };

    const missingHubInstall = await run(["--apply"], "");
    expect(missingHubInstall.exitCode).toBe(2);
    expect(missingHubInstall.output).toContain("DASH_HUB is required");
    let sshWasCalled = false;
    try { await stat(sshMarker); sshWasCalled = true; }
    catch { /* A missing hub must fail before attempting remote access. */ }
    expect(sshWasCalled).toBe(false);

    const install = await run([], "hub.example:4777");
    expect(install.exitCode).toBe(0);
    expect(install.output).toContain("https://hub.example:4777/ingest/omp");

    const uninstall = await run(["--uninstall"], "");
    expect(uninstall.exitCode).toBe(0);
    expect(sshWasCalled).toBe(false);
  });
});
