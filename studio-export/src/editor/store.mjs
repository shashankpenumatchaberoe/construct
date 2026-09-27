// Project files of the Studio editor, all inside one workspace folder, all addressed by slug (never by path):
//   <slug>.studio.json            the saved project (atomic write; `rev` counts saves, for optimistic concurrency)
//   <slug>.studio.autosave.json   a recovery copy written while editing; offered on the next open when newer than the save
//   .trash/<slug>.<stamp>.studio.json   where Delete moves a project (nothing is erased)
// Functions throw EditorError (code from ERR, an HTTP `status`); a stale write carries the current copy in `current`.
import fs from 'node:fs';
import path from 'node:path';
import {
  EditorError, ERR, SLUG_RE, assertProject, blankProject, isMediaName, listMedia, openWorkspace, projectDuration, projectFromJob, resolveMedia, validateProject,
} from './project.mjs';

export const PROJECT_SUFFIX = '.studio.json';
export const AUTOSAVE_SUFFIX = '.studio.autosave.json';
export const TRASH_DIR = '.trash';
export const MAX_PROJECT_BYTES = 2 * 1024 * 1024;
export const BUNDLE_FORMAT = 'line-studio-project-bundle';

export const checkSlug = (slug) => {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new EditorError(ERR.BAD_SLUG, 'A project name is letters, digits, . _ - (start with a letter or digit, up to 64).', 400);
  return slug;
};

/** A slug from free text ("My demo!" -> "my-demo"), or null when nothing usable is left. */
export function slugify(text) {
  const s = String(text ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[-._]+$/g, '').slice(0, 64).replace(/[-._]+$/, '');
  return SLUG_RE.test(s) ? s : null;
}

const fileOf = (root, slug, suffix = PROJECT_SUFFIX) => path.join(root, `${checkSlug(slug)}${suffix}`);
const isLink = (f) => { try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; } };

/** Write JSON atomically (temp file in the same folder, then rename). A symbolic link at the target is replaced, never followed. */
function writeJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_PROJECT_BYTES) throw new EditorError(ERR.TOO_LARGE, 'The project is too large to save.', 413);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJson(file, what) {
  if (isLink(file)) throw new EditorError(ERR.CORRUPT, `${what} is a link; refusing to read it.`, 422);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (Buffer.byteLength(text) > MAX_PROJECT_BYTES) throw new EditorError(ERR.CORRUPT, `${what} is too large.`, 422);
  try { return JSON.parse(text); } catch { throw new EditorError(ERR.CORRUPT, `${what} is not valid JSON.`, 422); }
}

const summarize = (slug, project, mtimeMs) => ({
  slug, name: project.name || slug, rev: project.rev ?? 0, updatedAt: new Date(mtimeMs).toISOString(), durationMs: projectDuration(project),
  layers: project.layers.map((l) => ({ id: l.id, kind: l.kind, name: l.name, clips: l.clips.length })),
  counts: project.layers.reduce((n, l) => ({ ...n, [l.kind]: (n[l.kind] || 0) + l.clips.length }), { video: 0, voice: 0, music: 0, subtitle: 0 }),
});

/** A workspace's project store. `workspace` is resolved to a real path once. */
export function openStore(workspaceDir, { now = () => Date.now() } = {}) {
  const root = openWorkspace(workspaceDir);

  /** The saved project and its file time, or null. */
  function load(slug) {
    const file = fileOf(root, slug);
    const project = readJson(file, `${slug}${PROJECT_SUFFIX}`);
    if (!project) return null;
    const v = validateProject(project);
    if (!v.ok) throw new EditorError(ERR.CORRUPT, `${slug}${PROJECT_SUFFIX} is not a valid project: ${v.errors[0].message}`, 422, { errors: v.errors });
    return { project, mtimeMs: fs.statSync(file).mtimeMs };
  }
  const need = (slug) => {
    const r = load(slug);
    if (!r) throw new EditorError(ERR.NOT_FOUND, `No project "${slug}".`, 404);
    return r;
  };
  const stale = (slug, current) => new EditorError(ERR.STALE_REV, 'This project was saved elsewhere since you opened it.', 409, { current });
  const requireRev = (rev) => {
    if (!Number.isSafeInteger(rev)) throw new EditorError(ERR.REV_REQUIRED, 'Send the rev you are saving against (If-Match header or a "rev" field).', 400);
    return rev;
  };
  /** Save `project` over the stored one when `rev` matches the stored rev; the new rev is one higher. */
  function save(slug, project, rev) {
    checkSlug(slug);
    requireRev(rev);
    assertProject(project);
    const existing = need(slug);
    if ((existing.project.rev ?? 0) !== rev) throw stale(slug, existing.project);
    const next = { ...project, rev: rev + 1 };
    writeJson(fileOf(root, slug), next);
    clearAutosave(slug);
    return next;
  }
  /** A new project: blank, or built from the Studio job `from` (its recording, captions, voice and music). */
  async function createProject({ name, slug, from } = {}, { execFile } = {}) {
    if (name !== undefined && (typeof name !== 'string' || name.length > 120)) throw new EditorError(ERR.BAD_NAME, 'The name is text of at most 120 characters.', 400);
    const s = slug ? checkSlug(slug) : slugify(name || from);
    if (!s) throw new EditorError(ERR.BAD_SLUG, 'Give the project a name of letters or digits.', 400);
    if (fs.existsSync(fileOf(root, s))) throw new EditorError(ERR.EXISTS, `A project named "${s}" already exists.`, 409);
    const title = (name || s).trim().slice(0, 120) || s;
    const project = from ? await projectFromJob(root, checkSlug(from), { execFile, name: title }) : blankProject({ name: title });
    project.rev = 1;
    writeJson(fileOf(root, s), project);
    return { slug: s, project };
  }
  function list() {
    const out = [];
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(PROJECT_SUFFIX)) continue;
      const slug = e.name.slice(0, -PROJECT_SUFFIX.length);
      if (!SLUG_RE.test(slug)) continue;
      try {
        const r = load(slug);
        if (r) out.push(summarize(slug, r.project, r.mtimeMs));
      } catch { out.push({ slug, name: slug, broken: true, updatedAt: new Date(fs.statSync(path.join(root, e.name)).mtimeMs).toISOString(), durationMs: 0, layers: [], counts: {}, rev: 0 }); }
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.slug.localeCompare(b.slug)));
  }
  /** Studio jobs to start a quick demo from: every `<slug>.webm` recording, with what accompanies it. */
  function jobs() {
    return listMedia(root).filter((n) => /\.webm$/.test(n) && !/\.(export|voice|mixed|audio)\.webm$/.test(n)).map((n) => n.slice(0, -5)).filter((s) => SLUG_RE.test(s)).map((slug) => ({
      slug,
      captions: Boolean(resolveMedia(root, `${slug}.captions.json`)),
      voice: Boolean(resolveMedia(root, `${slug}.voice.opus`)),
      music: ['mp3', 'wav', 'ogg', 'm4a', 'opus', 'flac'].some((e) => resolveMedia(root, `${slug}.music.${e}`)),
      hasProject: fs.existsSync(fileOf(root, slug)),
    }));
  }
  function uniqueSlug(base) {
    let s = base;
    for (let i = 2; fs.existsSync(fileOf(root, s)); i++) s = `${base.slice(0, 58)}-${i}`;
    return s;
  }
  /** A copy under a new slug (`<slug>-copy`, made unique). The source is untouched. */
  function duplicate(slug, { name } = {}) {
    const { project } = need(slug);
    const to = uniqueSlug(`${slug.slice(0, 56)}-copy`);
    const copy = { ...project, name: (typeof name === 'string' && name.trim() ? name.trim() : `${project.name || slug} copy`).slice(0, 120), rev: 1 };
    writeJson(fileOf(root, to), copy);
    return { slug: to, project: copy };
  }
  /** Rename the files of a project. Refuses an existing target (EXISTS, 409) and a stale rev. */
  function rename(slug, to, rev) {
    checkSlug(slug);
    checkSlug(to);
    requireRev(rev);
    const existing = need(slug);
    if ((existing.project.rev ?? 0) !== rev) throw stale(slug, existing.project);
    if (to === slug) return { slug, project: existing.project };
    if (fs.existsSync(fileOf(root, to))) throw new EditorError(ERR.EXISTS, `A project named "${to}" already exists.`, 409);
    const project = { ...existing.project, name: existing.project.name === slug ? to : existing.project.name, rev: rev + 1 };
    writeJson(fileOf(root, to), project);
    fs.rmSync(fileOf(root, slug));
    const auto = fileOf(root, slug, AUTOSAVE_SUFFIX);
    if (fs.existsSync(auto)) fs.renameSync(auto, fileOf(root, to, AUTOSAVE_SUFFIX));
    return { slug: to, project };
  }
  /** Move a project (and its recovery copy) into `.trash/`. Needs the exact slug as `confirm` and the current rev. Nothing is erased. */
  function trash(slug, { confirm, rev }) {
    checkSlug(slug);
    if (confirm !== slug) throw new EditorError(ERR.CONFIRM_REQUIRED, 'Confirm the delete by sending the project name as "confirm".', 400);
    requireRev(rev);
    const existing = need(slug);
    if ((existing.project.rev ?? 0) !== rev) throw stale(slug, existing.project);
    const dir = path.join(root, TRASH_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    fs.renameSync(fileOf(root, slug), path.join(dir, `${slug}.${stamp}${PROJECT_SUFFIX}`));
    const auto = fileOf(root, slug, AUTOSAVE_SUFFIX);
    if (fs.existsSync(auto)) fs.renameSync(auto, path.join(dir, `${slug}.${stamp}${AUTOSAVE_SUFFIX}`));
    return { trashed: `${slug}.${stamp}${PROJECT_SUFFIX}` };
  }
  // ---- autosave
  function writeAutosave(slug, project) {
    assertProject(project);
    need(slug);
    writeJson(fileOf(root, slug, AUTOSAVE_SUFFIX), project);
  }
  function readAutosave(slug) {
    checkSlug(slug);
    const f = fileOf(root, slug, AUTOSAVE_SUFFIX);
    const project = readJson(f, `${slug}${AUTOSAVE_SUFFIX}`);
    if (!project) return null;
    const v = validateProject(project);
    if (!v.ok) return null;
    return { project, mtimeMs: fs.statSync(f).mtimeMs };
  }
  /** The recovery copy when it is newer than the saved project and differs from it, else null. */
  function recoverable(slug) {
    const a = readAutosave(slug);
    const saved = load(slug);
    if (!a || !saved || a.mtimeMs <= saved.mtimeMs) return null;
    if (JSON.stringify(a.project.layers) === JSON.stringify(saved.project.layers)) return null;
    return { project: a.project, updatedAt: new Date(a.mtimeMs).toISOString() };
  }
  function clearAutosave(slug) {
    fs.rmSync(fileOf(root, slug, AUTOSAVE_SUFFIX), { force: true });
  }
  // ---- portable bundles: JSON, media referenced by workspace-relative bare names, never paths
  function exportBundle(slug) {
    const { project } = need(slug);
    const media = [...new Set(project.layers.flatMap((l) => l.clips.map((c) => c.src).filter(Boolean)))].sort();
    return { format: BUNDLE_FORMAT, version: 1, name: project.name || slug, project, media: media.map((name) => ({ name, present: Boolean(resolveMedia(root, name)) })) };
  }
  /** Import a bundle as a new project. Rejects a bundle whose project or media list names a path (`../x`, `/abs`, `a/b`). */
  function importBundle(bundle, { slug, name } = {}) {
    if (!bundle || typeof bundle !== 'object' || bundle.format !== BUNDLE_FORMAT || bundle.version !== 1) throw new EditorError(ERR.BAD_BUNDLE, 'This is not a Studio project bundle.', 422);
    if (!Array.isArray(bundle.media)) throw new EditorError(ERR.BAD_BUNDLE, 'The bundle has no media list.', 422);
    for (const m of bundle.media) if (!m || !isMediaName(m.name)) throw new EditorError(ERR.BAD_BUNDLE, 'The bundle names a media file that is not a bare file name; refusing it.', 422);
    const v = validateProject(bundle.project);
    if (!v.ok) throw new EditorError(ERR.BAD_BUNDLE, `The bundle's project is not valid: ${v.errors[0].message}`, 422, { errors: v.errors });
    const base = slug ? checkSlug(slug) : slugify(name || bundle.name || bundle.project.name) || 'imported';
    if (slug && fs.existsSync(fileOf(root, base))) throw new EditorError(ERR.EXISTS, `A project named "${base}" already exists.`, 409);
    const to = slug ? base : uniqueSlug(base);
    const project = { ...bundle.project, name: (typeof name === 'string' && name.trim() ? name.trim() : bundle.project.name || to).slice(0, 120), rev: 1 };
    writeJson(fileOf(root, to), project);
    const missing = [...new Set(project.layers.flatMap((l) => l.clips.map((c) => c.src).filter(Boolean)))].filter((n) => !resolveMedia(root, n));
    return { slug: to, project, missing };
  }
  return { root, load, need, save, createProject, list, jobs, duplicate, rename, trash, writeAutosave, readAutosave, recoverable, clearAutosave, exportBundle, importBundle };
}
