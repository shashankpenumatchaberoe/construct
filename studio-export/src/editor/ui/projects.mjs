// The first screen: "New quick demo" (pick a Studio job, land on the timeline with its layers ready), recent projects, and the
// list of every project with Open, Duplicate, Rename, Export and Delete, plus Import. All work is done by the server; this
// file draws the lists and forwards clicks.
import { api } from './api.mjs';
import { ask, fmt, h, when } from './dom.mjs';

const kinds = [['video', 'video'], ['voice', 'voice'], ['music', 'music'], ['subtitle', 'subtitles']];
const counts = (p) => kinds.map(([k, label]) => `${p.counts[k] || 0} ${label}`).join(' · ');

export function mountHome(root, { open, notify }) {
  const fail = (e) => notify(e.message || 'Something went wrong.', true);

  async function quick(job) {
    try {
      let slug = job;
      try { slug = (await api.create({ name: job, from: job, slug: job })).slug; } catch (e) { if (e.code !== 'EXISTS') throw e; }
      open(slug);
    } catch (e) { fail(e); }
  }
  async function blank() {
    const name = await ask({ title: 'New blank project', text: 'Name it. You can add recordings and audio from the workspace afterwards.', input: 'My video', confirmLabel: 'Create' });
    if (!name) return;
    try { open((await api.create({ name })).slug); } catch (e) { fail(e); }
  }
  async function rename(p) {
    const name = await ask({ title: `Rename "${p.name}"`, text: 'The new name becomes the file name (letters, digits, dots, dashes).', input: p.slug, confirmLabel: 'Rename' });
    if (!name || name === p.slug) return;
    try { await api.rename(p.slug, name.trim(), p.rev); await refresh(); notify(`Renamed to ${name.trim()}.`); } catch (e) { fail(e); refresh(); }
  }
  async function remove(p) {
    const yes = await ask({ title: `Delete "${p.name}"?`, text: 'It moves to the .trash folder in the workspace. The recording, voice and music files are not touched.', confirmLabel: 'Delete', danger: true });
    if (!yes) return;
    try { await api.trash(p.slug, p.rev); await refresh(); notify('Moved to .trash.'); } catch (e) { fail(e); refresh(); }
  }
  async function duplicate(p) {
    try { await api.duplicate(p.slug); await refresh(); notify('Duplicated.'); } catch (e) { fail(e); }
  }
  async function exportBundle(p) {
    try {
      const bundle = await api.exportBundle(p.slug);
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      const a = h('a', { href: url, download: `${p.slug}.studio-bundle.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      const missing = bundle.media.filter((m) => !m.present).length;
      notify(`Exported ${p.slug}.studio-bundle.json. The media files stay in the workspace${missing ? ` (${missing} not found there)` : ''}.`);
    } catch (e) { fail(e); }
  }
  async function importFile(file) {
    if (!file) return;
    try {
      const made = await api.importBundle(JSON.parse(await file.text()));
      await refresh();
      notify(`Imported as ${made.slug}.${made.missing.length ? ` Missing media in this workspace: ${made.missing.join(', ')}.` : ''}`, made.missing.length > 0);
    } catch (e) { fail(e instanceof SyntaxError ? new Error('That file is not JSON.') : e); }
  }

  const row = (p) => h('li', { class: 'project' },
    p.broken ? h('span', { class: 'p-name' }, `${p.slug} (unreadable)`) : h('button', { type: 'button', class: 'p-open', onclick: () => open(p.slug) }, h('span', { class: 'p-name' }, p.name), h('span', { class: 'p-meta' }, `${fmt(p.durationMs)} · ${counts(p)} · ${when(p.updatedAt)}`)),
    h('span', { class: 'p-actions' },
      p.broken ? null : [
        h('button', { type: 'button', onclick: () => duplicate(p), 'aria-label': `Duplicate ${p.name}` }, 'Duplicate'),
        h('button', { type: 'button', onclick: () => rename(p), 'aria-label': `Rename ${p.name}` }, 'Rename'),
        h('button', { type: 'button', onclick: () => exportBundle(p), 'aria-label': `Export ${p.name}` }, 'Export'),
        h('button', { type: 'button', class: 'danger-text', onclick: () => remove(p), 'aria-label': `Delete ${p.name}` }, 'Delete'),
      ]));

  async function refresh() {
    let projects = [];
    let jobs = [];
    try { [{ projects }, { jobs }] = await Promise.all([api.projects(), api.sources()]); } catch (e) { fail(e); }
    const select = h('select', { id: 'job-select', 'aria-label': 'Studio recording' }, jobs.map((j) => h('option', { value: j.slug }, `${j.slug}${j.captions ? '' : ' (no captions)'}${j.hasProject ? ' (has a project)' : ''}`)));
    const start = h('button', { type: 'button', class: 'primary', id: 'quick-start', disabled: !jobs.length, onclick: () => quick(select.value) }, 'Open on the timeline');
    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: (e) => { importFile(e.target.files[0]); e.target.value = ''; } });
    const recent = projects.filter((p) => !p.broken).slice(0, 3);
    root.replaceChildren(
      h('section', { class: 'card quick', 'aria-labelledby': 'quick-title' },
        h('h2', { id: 'quick-title' }, 'New quick demo'),
        jobs.length
          ? h('p', {}, 'Pick a recording Studio made. You land on the timeline with its video, voice-over, music and subtitles already in layers.')
          : h('p', {}, 'No recordings in this workspace yet. Make one in Studio, or start a blank project and add media later.'),
        h('div', { class: 'row' }, jobs.length ? select : null, start, h('button', { type: 'button', id: 'new-blank', onclick: blank }, 'Blank project'))),
      recent.length ? h('section', { class: 'card', 'aria-labelledby': 'recent-title' }, h('h2', { id: 'recent-title' }, 'Recent'), h('ul', { class: 'projects recent' }, recent.map((p) => h('li', {}, h('button', { type: 'button', class: 'p-open', onclick: () => open(p.slug) }, h('span', { class: 'p-name' }, p.name), h('span', { class: 'p-meta' }, `${fmt(p.durationMs)} · ${when(p.updatedAt)}`)))))) : null,
      h('section', { class: 'card', 'aria-labelledby': 'all-title' },
        h('div', { class: 'row between' }, h('h2', { id: 'all-title' }, `All projects (${projects.length})`), h('span', {}, h('button', { type: 'button', onclick: () => fileInput.click() }, 'Import bundle'), fileInput)),
        projects.length ? h('ul', { class: 'projects' }, projects.map(row)) : h('p', { class: 'muted' }, 'Nothing saved yet.')));
  }
  return { refresh };
}
