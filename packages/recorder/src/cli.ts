import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { startRecorder } from "./proxy.js";

const USAGE = `Usage:
  recorder record [--upstream <url>] [--port <n>] [--out <dir>]
      Proxy on 127.0.0.1 that records every exchange. Raw captures contain prompts;
      keep them out of git (captures/ is ignored).
      Defaults: --upstream https://api.anthropic.com --port 8788 --out captures/<timestamp>`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

async function record(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      upstream: { type: "string", default: "https://api.anthropic.com" },
      port: { type: "string", default: "8788" },
      out: { type: "string" },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid port: ${values.port}`);
  const outDir = values.out ?? join("captures", new Date().toISOString().replace(/[:.]/g, "-"));

  const recorder = await startRecorder({
    upstream: values.upstream,
    outDir,
    port,
    onCapture(file, capture) {
      const status = capture.response?.status ?? "failed";
      const size = capture.response ? `${(capture.response.body.bytes / 1024).toFixed(1)} kB` : "";
      const time = capture.response ? `${capture.response.totalMs.toFixed(0)} ms` : "";
      const note = capture.error ? ` (${capture.error})` : "";
      console.log(
        `${basename(file)}  ${capture.request.method} ${capture.request.path} -> ${status} ${time} ${size}${note}`,
      );
    },
  });
  console.log(`recording ${values.upstream} on ${recorder.url}, writing to ${outDir}`);
  console.log("press Ctrl+C to stop");

  process.once("SIGINT", () => {
    void recorder.close().then(() => process.exit(0));
  });
}

const [command, ...rest] = process.argv.slice(2);
if (command === "record") await record(rest);
else fail(command === undefined ? "missing command" : `unknown command: ${command}`);
