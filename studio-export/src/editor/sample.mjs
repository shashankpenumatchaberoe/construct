// A small, valid example project and a workspace to go with it: what the tests, the browser check and a first look at the editor
// use. The media files are placeholders (a few bytes), not playable; a real workspace holds Studio's recording and voice-over.
import fs from 'node:fs';
import path from 'node:path';
import { blankProject } from './project.mjs';

/** Ten seconds: one video clip, one voice clip, one music clip and two subtitles, all naming files of the `demo` job. */
export function sampleProject(slug = 'demo') {
  const p = blankProject({ name: 'Demo' });
  const layer = (id) => p.layers.find((l) => l.id === id);
  layer('video').clips.push({ id: 'c1', start: 0, duration: 10000, in: 0, src: `${slug}.webm` });
  layer('voice').clips.push({ id: 'c2', start: 0, duration: 10000, in: 0, src: `${slug}.voice.opus` });
  layer('music').clips.push({ id: 'c3', start: 0, duration: 10000, in: 0, src: `${slug}.music.mp3` });
  layer('subs').clips.push({ id: 'c4', start: 500, duration: 3000, in: 0, text: 'Hello there, this is Studio' });
  layer('subs').clips.push({ id: 'c5', start: 4000, duration: 3000, in: 0, text: 'A second line of text' });
  return p;
}

/**
 * Write placeholder media for the sample job into `dir` (the workspace) and, when `withProject`, its `<slug>.studio.json`.
 * `mediaDir` puts the media in a sub-folder (Studio itself writes recordings to `<workspace>/videos`).
 */
export function writeSampleWorkspace(dir, { slug = 'demo', withProject = true, mediaDir = '' } = {}) {
  fs.mkdirSync(path.join(dir, mediaDir), { recursive: true });
  for (const name of [`${slug}.webm`, `${slug}.voice.opus`, `${slug}.music.mp3`]) fs.writeFileSync(path.join(dir, mediaDir, name), Buffer.from(`placeholder ${name}\n`.repeat(50)));
  if (withProject) fs.writeFileSync(path.join(dir, `${slug}.studio.json`), `${JSON.stringify(sampleProject(slug), null, 2)}\n`);
  return dir;
}
