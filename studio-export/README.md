# @line/studio

Studio turns a website into a narrated video from a chat. A local model plans a storyboard, you approve it, Playwright records it, a local voice speaks the captions and ffmpeg mixes the result. Everything runs on your machine; nothing is sent to a cloud service.

## What is inside

- `bin/studio.mjs`: the `studio` command (`studio`, `studio doctor`, `studio --version`, `studio --help`).
- `src/`: the chat UI and the local server (`src/server.mjs`, exporting `startStudio`).
- `vendor/media/`: a copy of Construct's media tools (`script.mjs`, `synth.mjs`, `voiceover.mjs`, `voice-lab.mjs`, `captions-from-video.mjs`, `make-music.mjs`, `add-audio.sh`, `lib.mjs`, and the Python helpers for voice cloning). They are copied unchanged from `packages/tools/media` at pack time; nothing in the tarball refers to the Construct repository.
- Dependencies installed with the package: `playwright` (the library only) and `subtitle` (SRT and WebVTT text).

## Run

```
npm install @line/studio          # from the private registry, see below
npx studio doctor                 # checks the machine and prints the command that fixes anything missing
npx studio --workspace ./studio-workspace --port 4810
```

Flags: `--port`, `--host` (the server defaults to loopback), `--workspace DIR` (where projects, recordings and voice-overs are written; default `./studio-workspace`; the packed media tools write only under it, in `videos/` and `.media-cache/`), `--config FILE` (default `./studio.config.json`).

The chat model, and any other model, is configured in `studio.config.json`: a base URL and a model name per capability (storyboard planning, narration writing) and the narration voice backend. Point it at a local server such as Ollama. `studio doctor` reads the first `baseUrl` in that file to check that the model server answers.

## Prerequisites

Installing the package does not install these; `studio doctor` checks each one and prints the exact fix.

| Item | Needed for | Fix |
|---|---|---|
| Node 20 or newer | everything | https://nodejs.org |
| `ffmpeg` and `ffprobe` on PATH (or `FFMPEG=/path`) | video, audio, mixing | `sudo apt install ffmpeg` or `brew install ffmpeg` |
| A Playwright browser | recording the website | `npx playwright install chromium` |
| Ollama (optional) | a local chat model for the storyboard | https://ollama.com, then `ollama serve` |
| `kokoro-js` (optional) | the default local narration voice | `mkdir -p ~/.cache/construct-media && cd ~/.cache/construct-media && npm init -y && npm i kokoro-js` |
| `python3` (optional) | own-voice cloning only | `sudo apt install python3 python3-venv` |

Playwright's browsers are not downloaded when the package is installed (npm does not run a download for the `playwright` library); run the `playwright install` line once. Ollama is never required for `studio doctor` to pass.

## What it does not include

- No browser, ffmpeg, Ollama, language model or voice model. They are large and you choose them.
- No music. Drop a track you may publish next to the video as `<slug>.music.<mp3|wav|ogg|m4a|opus|flac>`.
- No cloud calls and no telemetry.
- The Construct engine, CLI and Cockpit. Studio is standalone and does not depend on them.

## Registry

Private only. The package is configured for `https://npm.pkg.github.com` with restricted access. Add the scope to your `.npmrc` (the token stays in your environment, never in a file you commit):

```
@line:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

## Building the package (in the Construct repository)

```
npm run pack --workspace=packages/studio      # vendors packages/tools/media into vendor/media, then npm pack
packages/tools/dev/verify-studio-package.sh   # packs, installs the tarball into an empty directory and runs it
```

`vendor/` is generated and git-ignored. The pack step fails, and produces no tarball, when a vendored file imports a path outside `vendor/` or a package that `package.json` does not declare. Nothing is published from this repository by these commands.
