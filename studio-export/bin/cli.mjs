// The `studio` command line: start (default), doctor, --version, --help. Kept apart from bin/studio.mjs so tests can call main().
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runDoctor } from './doctor.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER_FILE = path.join(PKG_ROOT, 'src', 'server.mjs');
export const DEFAULT_WORKSPACE_DIR = 'studio-workspace';

export const readVersion = () => JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;

export const HELP = `studio <version>: a narrated video of a website from a chat, with local models

usage
  studio [start] [--port N] [--host H] [--workspace DIR] [--config FILE]
  studio doctor [--config FILE] [--ollama-url URL]
  studio --version | --help

  start        run the Studio server (default command); prints the URL to open
  doctor       check ffmpeg, ffprobe, Playwright chromium, Ollama, python3 and print the fix for anything missing
  --workspace  where projects, recordings and voice-overs are written (default ./${DEFAULT_WORKSPACE_DIR})
  --config     path to studio.config.json (default ./studio.config.json when present)
  --port/--host  where the server listens (defaults are set by the server; host defaults to loopback)`;

const VALUE_FLAGS = new Set(['port', 'host', 'workspace', 'config', 'ollama-url']);

/** Parses argv into { command, flags }. Throws on an unknown flag, a flag missing its value or a bad port. */
export function parseArgs(argv) {
  const flags = {};
  let command;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-v' || a === '--version') { flags.version = true; continue; }
    if (a === '-h' || a === '--help') { flags.help = true; continue; }
    if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (!VALUE_FLAGS.has(name)) throw new Error(`unknown option --${name} (see studio --help)`);
      const value = inline !== undefined ? inline : argv[++i];
      if (value === undefined || value === '') throw new Error(`--${name} needs a value`);
      flags[name] = value;
      continue;
    }
    if (command === undefined) { command = a; continue; }
    throw new Error(`unexpected argument "${a}" (see studio --help)`);
  }
  if (flags.port !== undefined) {
    const p = Number(flags.port);
    if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error(`--port must be a whole number from 0 to 65535, got "${flags.port}"`);
    flags.port = p;
  }
  return { command: command ?? 'start', flags };
}

/** Runs the command; returns the exit code. `out`/`err` are line writers, `startImport` loads the server module (both injectable). */
export async function main(argv, { out = (s) => console.log(s), err = (s) => console.error(s), cwd = process.cwd(), env = process.env, serverFile = SERVER_FILE, startImport = (file) => import(pathToFileURL(file).href), doctor = runDoctor } = {}) {
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { err(`studio: ${e.message}`); return 2; }
  const { command, flags } = parsed;
  if (flags.version) { out(readVersion()); return 0; }
  if (flags.help || command === 'help') { out(HELP.replace('<version>', readVersion())); return 0; }

  if (command === 'doctor') {
    const { lines, exitCode } = await doctor({ cwd, env, configPath: flags.config, ollamaUrl: flags['ollama-url'] });
    for (const l of lines) out(l);
    return exitCode;
  }

  if (command !== 'start') { err(`studio: unknown command "${command}" (see studio --help)`); return 2; }
  if (!fs.existsSync(serverFile)) { err('studio: the server is not part of this build (src/server.mjs is missing); reinstall @line/studio or run studio doctor.'); return 1; }

  const workspace = path.resolve(cwd, flags.workspace ?? env.STUDIO_WORKSPACE ?? DEFAULT_WORKSPACE_DIR);
  // The vendored media tools write under the workspace, never next to themselves (vendor/media/lib.mjs reads these).
  env.STUDIO_ROOT ??= workspace;
  env.STUDIO_VIDEO_DIR ??= path.join(workspace, 'videos');
  const mod = await startImport(serverFile);
  if (typeof mod.startStudio !== 'function') { err('studio: src/server.mjs does not export startStudio().'); return 1; }
  await mod.startStudio({ port: flags.port, host: flags.host, workspace, configPath: flags.config ? path.resolve(cwd, flags.config) : undefined });
  return null; // the server keeps the process alive; null = do not exit
}
