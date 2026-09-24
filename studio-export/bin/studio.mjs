#!/usr/bin/env node
// Entry point of the `studio` command. All logic is in ./cli.mjs.
import { main } from './cli.mjs';

const code = await main(process.argv.slice(2));
if (code !== null) process.exitCode = code; // null: the server is running, let it keep the process alive
