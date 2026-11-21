// Invoke with an already built server binary in WENOTE_API. The server exits with this test.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createServer } from "node:net";
const temp = await mkdtemp(join(tmpdir(), "wenote-e2e-"));
const portProbe = createServer().listen(0, "127.0.0.1");
await once(portProbe, "listening");
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(
  resolve(process.env.WENOTE_API),
  [
    "-addr",
    `127.0.0.1:${port}`,
    "-web-dir",
    resolve("apps/web/dist"),
    ...(process.env.WENOTE_TEST_BUCKET
      ? [
          "-s3-bucket",
          process.env.WENOTE_TEST_BUCKET,
          "-s3-endpoint",
          process.env.WENOTE_TEST_S3 || "",
          "-s3-region",
          process.env.AWS_REGION || "us-east-1",
        ]
      : []),
  ],
  { cwd: temp, stdio: "inherit" },
);
const closed = once(server, "exit");
try {
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    healthy = await fetch(origin + "/healthz")
      .then((r) => r.ok)
      .catch(() => false);
    if (healthy) break;
    if (server.exitCode !== null) throw Error("API exited");
    await setTimeout(50);
  }
  if (!healthy) throw Error("API did not start");
  const commands = [
    [
      "cargo",
      [
        "test",
        "--locked",
        "-p",
        "wenote-sync",
        "--test",
        "two_devices",
        "--",
        "--ignored",
        "--nocapture",
      ],
    ],
  ];
  if (process.argv.includes("--browser"))
    commands.push(
      [process.execPath, ["apps/web/tests/phase1.mjs"]],
      [process.execPath, ["apps/web/tests/phase2.mjs"]],
      [process.execPath, ["apps/web/tests/phase4.mjs"]],
      [process.execPath, ["apps/web/tests/phase5.mjs"]],
    );
  if (process.argv.includes("--android"))
    commands.push([process.execPath, ["apps/web/tests/android.mjs"]]);
  for (const [command, args] of commands) {
    const runner = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, WENOTE_TEST_ORIGIN: origin },
    });
    const [code] = await once(runner, "exit");
    if (code !== 0) throw Error(`${command} acceptance exited with ${code}`);
  }
} finally {
  server.kill();
  await closed;
  await rm(temp, { recursive: true, force: true });
}
