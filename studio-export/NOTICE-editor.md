# Third-party software in the Studio editor

Only permissive licences (MIT, Apache-2.0, ISC, BSD). The editor adds no npm dependency: the browser file below is vendored
(copied, unmodified) into `src/editor/ui/vendor/` by `src/editor/vendor-ui.mjs`, which records the version and a sha256 of each
file in `src/editor/ui/vendor/VERSION.json`. Nothing is loaded from a CDN; the page works offline. The server side uses only
Node built-ins and `subtitle` (MIT, already a dependency of this package for the media tools).

| Name | Version | Licence | Used for |
|---|---|---|---|
| vis-timeline (standalone build, `vis-timeline.min.js`, 549 KB) | 8.5.4 | Apache-2.0 OR MIT | the layered timeline: rows, draggable and resizable clips, ruler, zoom, playhead |
| vis-data | 8.0.5 | Apache-2.0 OR MIT | bundled in the standalone build (item and group store) |
| vis-util | 6.0.2 | Apache-2.0 OR MIT | bundled in the standalone build |
| moment | 2.31.0 | MIT | bundled in the standalone build (time axis labels, used in UTC) |
| @egjs/hammerjs | 2.0.17 | MIT | bundled in the standalone build (pointer and touch gestures) |
| propagating-hammerjs | 3.0.0 | MIT | bundled in the standalone build |
| component-emitter | 1.3.1 | MIT | bundled in the standalone build |
| keycharm | 0.4.0 | Apache-2.0 OR MIT | bundled in the standalone build |
| uuid | 14.0.2 | MIT | bundled in the standalone build |
| xss | 1.0.15 | MIT | bundled in the standalone build (sanitising item titles) |
| commander | 2.20.3 | MIT | bundled with xss |
| cssfilter | 0.0.10 | MIT | bundled with xss |
| subtitle | see package.json | MIT | writing `.srt` and `.vtt` from the subtitle layer (server side; same library as `packages/tools/media`) |

Licence texts of vis-timeline are in `src/editor/ui/vendor/LICENSE-vis-timeline-MIT.txt` and
`src/editor/ui/vendor/LICENSE-vis-timeline-Apache-2.0.txt`.

Versions and licence fields above were read from each package's `package.json` in the release that `npm pack vis-timeline@8.5.4`
resolves (`npm ls --all` of a scratch install).

## Considered and not adopted

- wavesurfer.js (BSD-3-Clause): waveforms are not part of this deliverable; per-clip instances inside timeline blocks cost more than they give.
- OpenReel, OpenCut, omniclip (MIT, browser video editors): whole applications with their own project format and in-browser rendering;
  they would replace Studio's workspace files, ops endpoint and ffmpeg render instead of being embedded in them.
- Remotion, Diffusion Studio core (source-available licences, not permissive): out by rule.
- Kdenlive, Shotcut (GPL): usable as separate tools only, never linked.
- fluent-ffmpeg (archived) and ffmpeg.wasm (its cores are LGPL/GPL): not used; the render is a plain argument array for the system `ffmpeg`.
- ffmpeg itself stays a system prerequisite (`studio doctor` checks it); no ffmpeg binary is bundled. The tests use one only when it is
  installed (`FFMPEG=/path/to/ffmpeg` or on the PATH) and skip otherwise.
