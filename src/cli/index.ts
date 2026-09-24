// Entry point for the `zenspec` binary. Commands are implemented in later phases.
const [command] = process.argv.slice(2);

if (command === "--version" || command === "-v") {
  process.stdout.write(`${__ZENSPEC_VERSION__}\n`);
} else {
  process.stderr.write("zenspec: not implemented yet\n");
  process.exitCode = 1;
}
