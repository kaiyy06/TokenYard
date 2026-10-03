#!/usr/bin/env node
import { HELP, type Io, start, stats } from "./commands.js";
import { doctor, init } from "./setup.js";

// node:sqlite is still flagged experimental on Node 22. Hide that one notice, keep the rest.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /sqlite/i.test(warning.message)) return;
  console.error(`${warning.name}: ${warning.message}`);
});

const io: Io = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    io.out(HELP);
    return command === undefined ? 1 : 0;
  }
  if (rest.includes("-h") || rest.includes("--help")) {
    io.out(HELP);
    return 0;
  }
  switch (command) {
    case "start": {
      const running = await start(rest, io);
      await new Promise<void>((resolve) => {
        const stop = () => resolve();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      await running.close();
      return 0;
    }
    case "stats":
      stats(rest, io);
      return 0;
    case "init":
      return init(rest, io);
    case "doctor":
      return doctor(rest, io);
    default:
      io.err(`unknown command "${command}"\n\n${HELP}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
