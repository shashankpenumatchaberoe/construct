import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { slugify, makeSlugger, esc } from '../../packages/docs-site/lib/text.mjs';
import { sanitizeHtml } from '../../packages/docs-site/lib/sanitize.mjs';
import { build, parseArgs, devStatus } from '../build.mjs';
import { USER_GROUPS, EXAMPLE_SURFACES, examplePages } from '../../packages/docs-site/lib/structure.mjs';
import { API_PACKAGES } from '../../packages/docs-site/lib/apiDocs.mjs';
import { makeTempDir } from '../../test-utils/tmpdir.mjs';

const BUILD_TIME = new Date('2026-09-20T00:00:00Z');
const walk = (d, files = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name), files) : files.push(path.join(d, e.name)));
  return files;
};
const exampleGroups = () => EXAMPLE_SURFACES.map((surface) => ({ surface, pages: examplePages(surface) }));

test('slugify / slugger dedupe / esc', () => {
  assert.equal(slugify('Hello, `World`!'), 'hello-world');
  const s = makeSlugger();
  assert.deepEqual([s('A b'), s('A b'), s('A b')], ['a-b', 'a-b-2', 'a-b-3']);
  assert.equal(esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});

test('sanitizer strips scripts, handlers and javascript: urls', () => {
  const out = sanitizeHtml('<p onclick="x()">a</p><script>alert(1)</script><a href="javascript:alert(1)">b</a><iframe src="x"></iframe><img src=x onerror=alert(1)>');
  assert.doesNotMatch(out, /script|onclick|onerror|javascript:|iframe/i);
  assert.match(out, /<p>a<\/p>/);
});

test('sanitizer (#421): the bypasses a regex pass misses are stripped by the parser', () => {
  const dropped = [
    '<img src=x onerror=alert(1)>',
    '<img src="x" onerror="alert(1)">',
    '<script>alert(1)',
    '<scr<script>ipt>alert(1)</scr</script>ipt>',
    "<a href='javascript:alert(1)'>x</a>",
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href="java&#x0A;script:alert(1)">x</a>',
    '<a href=" javascript:alert(1)">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<svg><script>alert(1)</script></svg>',
    '<svg onload=alert(1)>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<form action="javascript:alert(1)"><button>x</button></form>',
    '<body onload=alert(1)>',
    '<div style="background:url(javascript:alert(1))">x</div>',
    '<input type="text" onfocus="alert(1)" autofocus>',
    '<object data="javascript:alert(1)"></object>',
  ];
  for (const input of dropped) {
    const out = sanitizeHtml(input);
    assert.doesNotMatch(out, /<script|<svg|<iframe|<form|<object|<style|<body|onerror|onload|onfocus|onclick|javascript:|srcdoc|style=/i, `not stripped: ${input} -> ${out}`);
  }
  // A dropped element keeps its words; an unclosed tag does not swallow the rest of the page.
  assert.equal(sanitizeHtml('<p>a</p><script>alert(1)'), '<p>a</p>');
  assert.match(sanitizeHtml('<p>before</p><div onclick="x()">kept words</div>'), /kept words/);
});

test('sanitizer (#421): what the site itself writes passes untouched', () => {
  const page = [
    '<h2 id="a-b">A b<a class="anchor" href="#a-b" aria-label="Link to this section">#</a></h2>',
    '<p>It&#39;s a <code>x -&gt; y</code> &quot;quote&quot; <a href="../rel/" rel="noopener">rel</a> <a href="https://example.com/x" rel="noopener">abs</a> <a href="mailto:a@b.c">m</a></p>',
    '<img src="../assets/img/a.webp" loading="lazy" decoding="async" alt="An alt">',
    '<pre><code class="language-js">const a = 1 &lt; 2;\n</code></pre>',
    '<table><thead><tr><th align="left">h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>',
    '<ul class="contains-task-list"><li><input type="checkbox" checked disabled> done</li></ul>',
    '<figure class="video"><video controls preload="metadata" width="1280" height="720" poster="p.png" aria-label="v"><source src="v.webm" type="video/webm"><track kind="subtitles" srclang="en" label="English" src="v.vtt"><a href="v.webm" download>Download the video</a></video><figcaption>Downloads: <a href="v.webm" download>Silent video</a> &middot; <a href="v.vtt" download>Subtitles</a></figcaption></figure>',
  ].join('\n');
  assert.equal(sanitizeHtml(page), page);
  // Only a checkbox may be an input, and an image may be a data: image but a link may not be a data: page.
  assert.doesNotMatch(sanitizeHtml('<input type="text" value="x">'), /<input/);
  assert.match(sanitizeHtml('<img src="data:image/png;base64,AAAA" alt="">'), /data:image\/png/);
});

test('structure: the user guide is grouped by product, with a page for each family member', () => {
  assert.deepEqual(USER_GROUPS.map((g) => g.group), ['Start', 'Construct', 'Cockpit', 'Videos', 'CLI']);
  const paths = USER_GROUPS.flatMap((g) => g.pages.map((p) => p.path));
  for (const p of ['user-guide/line/', 'user-guide/construct/', 'user-guide/cockpit/', 'user-guide/cli/']) assert.ok(paths.includes(p), `${p} is missing`);
  // Every page's markdown source exists, and no page is registered twice.
  assert.equal(new Set(paths).size, paths.length, 'a page is registered twice');
  for (const g of USER_GROUPS) for (const p of g.pages) assert.ok(fs.existsSync(new URL(`../../${p.file}`, import.meta.url)), `${p.file} exists`);
  // The Cockpit and CLI groups carry their own examples; Core examples belong to the framework.
  assert.ok(USER_GROUPS.find((g) => g.group === 'Construct').pages.every((p) => !p.example || p.example === 'Core'));
  assert.ok(USER_GROUPS.find((g) => g.group === 'Cockpit').pages.every((p) => !p.example || p.example === 'Cockpit'));
  assert.ok(USER_GROUPS.find((g) => g.group === 'CLI').pages.every((p) => !p.example || p.example === 'CLI'));
});

test('structure: examples are split into CLI, Cockpit and Core, and each page states its surface', () => {
  assert.deepEqual(exampleGroups().map((g) => g.surface), ['CLI', 'Cockpit', 'Core']);
  for (const g of exampleGroups()) {
    const surface = g.surface.toLowerCase();
    assert.ok(g.pages.length > 0, `no ${g.surface} examples`);
    for (const p of g.pages) {
      assert.match(p.path, new RegExp(`^user-guide/examples/${surface}-`), `${p.path} is filed under the wrong surface`);
      assert.ok(fs.existsSync(new URL(`../../${p.file}`, import.meta.url)), `${p.file} exists`);
    }
  }
});

test('example pages: no user stories, the problem comes first, surfaces are never interleaved', () => {
  for (const g of exampleGroups()) {
    const surface = g.surface;
    for (const p of g.pages) {
      const md = fs.readFileSync(new URL(`../../${p.file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(md, /\bAs an? [\w -]+ I want\b/i, `user story in ${p.file}`);
      assert.match(md, /^\*\*Problem\.\*\*/, `${p.file} does not open with the problem`);
      assert.match(md, /Checked against commit `[0-9a-f]{7}` on \d{4}-\d{2}-\d{2}/, `${p.file} has no checked-against line`);
      if (surface === 'CLI') assert.doesNotMatch(md, /!\[[^\]]*\]\(@img/, `${p.file}: screenshots do not belong on a CLI page`);
      if (surface === 'Core') assert.doesNotMatch(md, /!\[[^\]]*\]\(@img/, `${p.file}: screenshots do not belong on a core page`);
      if (surface === 'Cockpit') assert.doesNotMatch(md, /^```bash\n(?:construct|node) /m, `${p.file}: a bare CLI transcript does not belong on a Cockpit page`);
    }
  }
});

test('every image an example page uses exists in site/assets/img', () => {
  for (const g of exampleGroups()) {
    for (const p of g.pages) {
      const md = fs.readFileSync(new URL(`../../${p.file}`, import.meta.url), 'utf8');
      for (const m of md.matchAll(/\(@img\/([^)]+)\)/g)) assert.ok(fs.existsSync(new URL(`../assets/img/${m[1]}`, import.meta.url)), `${m[1]} referenced by ${p.file}`);
    }
  }
});

test('build writes dev-status.json next to logo.json: the newest commit time only, deterministic with the override, null without history (#614)', async () => {
  const KEY = 'CONSTRUCT_DEV_STATUS_LAST_ACTIVITY';
  const before = process.env[KEY];
  try {
    process.env[KEY] = '2026-09-25T10:30:00+02:00';
    const out = makeTempDir('site-devstatus-');
    await build({ out, repo: 'o/r', buildTime: BUILD_TIME, api: false });
    const raw = fs.readFileSync(path.join(out, 'dev-status.json'), 'utf8');
    assert.deepEqual(JSON.parse(raw), { version: 1, lastActivityAt: '2026-09-25T08:30:00.000Z', windowSec: 900, generatedAt: '2026-09-20T00:00:00.000Z' });
    assert.deepEqual(Object.keys(JSON.parse(raw)), ['version', 'lastActivityAt', 'windowSec', 'generatedAt'], 'times only: no author, message or hash');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'logo.json'), 'utf8')), JSON.parse(fs.readFileSync(new URL('../logo.json', import.meta.url), 'utf8')), 'the site setting is copied as it is');
    const again = makeTempDir('site-devstatus-');
    await build({ out: again, repo: 'o/r', buildTime: BUILD_TIME, api: false });
    assert.equal(fs.readFileSync(path.join(again, 'dev-status.json'), 'utf8'), raw, 'the same inputs give the same file');
    // Unparsable override or `none`: null, never a made-up time.
    for (const v of ['none', 'garbage']) {
      process.env[KEY] = v;
      assert.equal(devStatus({ buildTime: BUILD_TIME }).lastActivityAt, null, v);
    }
    delete process.env[KEY];
    // No repository to ask (a directory outside any checkout): null.
    assert.equal(devStatus({ repoRoot: makeTempDir('site-nogit-'), buildTime: BUILD_TIME }).lastActivityAt, null);
    // This checkout has history: an ISO time, from the newest commit.
    assert.match(devStatus({ buildTime: BUILD_TIME }).lastActivityAt ?? '', /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  } finally {
    if (before === undefined) delete process.env[KEY];
    else process.env[KEY] = before;
  }
});

test('build renders the site offline: home pitch, examples, references, no ticket-derived tutorials', async () => {
  const out = makeTempDir('site-test-');
  const res = await build({ out, repo: 'o/r', buildTime: BUILD_TIME });
  assert.equal(res.examples, 9);
  const home = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(home, /AI guesses\. Construct computes\./);
  assert.match(home, /Try it in 60 seconds/);
  assert.match(home, /See it work in the Cockpit/);
  assert.equal((home.match(/class="btn primary"/g) || []).length, 1, 'one primary call to action');
  assert.match(home, /small tools that give the same answer every time/);
  assert.doesNotMatch(home, /\blayer\b|envelope|worktree|blast radius/i);
  // The family: every member named, each with its own section to go to, and the open-core boundary stated.
  for (const member of ['Line', 'Construct', 'Cockpit', 'command line']) assert.match(home, new RegExp(`<strong>${member}</strong>`), `${member} is not named on the home page`);
  for (const p of ['user-guide/line/', 'user-guide/construct/', 'user-guide/cockpit/', 'user-guide/cli/']) assert.match(home, new RegExp(`href="${p.replace(/\//g, '\\/')}"`), `no link to ${p}`);
  assert.match(home, /open source under the MIT licence; the Cockpit/);
  assert.doesNotMatch(home, /Pick how you like to work/);
  assert.match(home, /href="user-guide\/examples\/cli-scaffold-and-validate\/"/);
  assert.match(home, /href="user-guide\/examples\/cockpit-plan-and-run\/"/);
  assert.match(home, /href="user-guide\/examples\/core-plans-and-impact\/"/);
  assert.match(home, /Documentation built <time datetime="2026-09-20T00:00:00.000Z">/);
  assert.doesNotMatch(home, /walkthrough|user stor/i);
  for (const g of exampleGroups()) for (const p of g.pages) assert.ok(fs.existsSync(path.join(out, p.path, 'index.html')), p.path);
  const idx = fs.readFileSync(path.join(out, 'user-guide/examples/index.html'), 'utf8');
  for (const label of EXAMPLE_SURFACES) assert.match(idx, new RegExp(`<h2>${label}</h2>`));
  // A short page for each product, reachable from the guide.
  for (const p of ['user-guide/line/', 'user-guide/construct/', 'user-guide/cli/']) assert.ok(fs.existsSync(path.join(out, p, 'index.html')), p);
  // A Cockpit page carries real screenshots, copied and linked relative to its own depth.
  const plan = fs.readFileSync(path.join(out, 'user-guide/examples/cockpit-plan-and-run/index.html'), 'utf8');
  assert.match(plan, /src="\.\.\/\.\.\/\.\.\/assets\/img\/cockpit-plan-impact\.webp"/);
  assert.ok(fs.existsSync(path.join(out, 'assets/img/cockpit-plan-impact.webp')));
  // The old tutorial address redirects to the examples.
  assert.match(fs.readFileSync(path.join(out, 'user-guide/tutorials/index.html'), 'utf8'), /url=..\/examples\//);
  assert.ok(!fs.existsSync(path.join(out, 'guides')));
  for (const p of ['user-guide/getting-started/', 'user-guide/concepts/', 'user-guide/cockpit/', 'user-guide/how-to/create/', 'developers/architecture/', 'developers/cli-reference/', 'developers/rules-reference/', 'developers/execution-model/', 'developers/ast/', 'search/']) {
    assert.ok(fs.existsSync(path.join(out, p, 'index.html')), p);
  }
  assert.ok(fs.existsSync(path.join(out, '404.html')));
  assert.ok(fs.existsSync(path.join(out, 'assets/css/site.css')));
  fs.rmSync(out, { recursive: true });
});

test('generated and reused docs are current, and carry no tracker plumbing or dead links', async () => {
  const out = makeTempDir('site-test-');
  await build({ out, repo: 'o/r', buildTime: BUILD_TIME });
  const rules = fs.readFileSync(path.join(out, 'developers/rules-reference/index.html'), 'utf8');
  assert.match(rules, /PAGE-003/); // straight from DEFAULT_RULES
  const cli = fs.readFileSync(path.join(out, 'developers/cli-reference/index.html'), 'utf8');
  assert.match(cli, /construct research workflow/);
  assert.match(cli, /construct review/);
  for (const f of walk(out).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(f, 'utf8');
    const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/&#\d+;/g, "'").replace(/<[^>]+>/g, ' ');
    assert.doesNotMatch(text, /#\d{2,4}\b/, `ticket number leaked in ${path.relative(out, f)}`);
    assert.doesNotMatch(text, /CLAUDE\.md|subagent|orchestrat/i, `internal wording in ${path.relative(out, f)}`);
    for (const m of html.matchAll(/<(?:a|img|link)\b[^>]*?(?:href|src)="(?!https?:|mailto:|data:|\/)([^"#]+)/g)) {
      if (m[1].includes('pagefind/')) continue; // produced by the search indexer, off in tests
      let target = path.resolve(path.dirname(f), m[1]);
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
      assert.ok(fs.existsSync(target), `dead link ${m[1]} in ${path.relative(out, f)}`);
    }
  }
  fs.rmSync(out, { recursive: true });
});

test('markdown helpers: sections, includes, ticket stripping', async () => {
  const { extractSection, relevel, stripTicketRefs, stripTicketRefsHtml } = await import('../../packages/docs-site/lib/markdown.mjs');
  const md = '# T\n\n## A\n\ntext\n\n```bash\n# not a heading\n```\n\n## B\n\nother\n';
  const { markdown } = extractSection(md, 'A');
  assert.match(markdown, /not a heading/);
  assert.doesNotMatch(markdown, /other/);
  assert.equal(relevel('## A\n\n### C\n', 3, true), '\n### C\n'.replace('\n### C', '\n#### C'));
  assert.equal(stripTicketRefs('Title (#96, the epic) and more (Epic 6.4/#100) end. Tracked under issue #104.'), 'Title and more end.');
  assert.doesNotMatch(stripTicketRefsHtml('<table><tr><th>#</th><th>Story</th></tr><tr><td>#128</td><td>x</td></tr></table>'), /#128/);
  // A bare ticket number after a sentence break, with no defining phrase around it at all (the case #479 found:
  // a source comment reading "#77 follow-up to #53").
  assert.doesNotMatch(stripTicketRefs('#77 follow-up to #53'), /#\d+/);
  assert.doesNotMatch(stripTicketRefs('Fixed the retry loop. #620 adds a timeout; #626 adds a cap.'), /#\d+/);
  // Real shapes this codebase's own source comments use: a "/"-joined pair, a version/ticket pair, a
  // hyphenated ref, and one quoted in prose -- all bare, none of the phrasings the earlier rules already catch.
  assert.doesNotMatch(stripTicketRefs("mirroring #527/#532's own read/write split"), /#\d+/);
  assert.doesNotMatch(stripTicketRefs('Remove tracker plumbing ("(#96)", "Epic 6.4/#100", "Tracked under issue #104").'), /#\d+/);
  assert.doesNotMatch(stripTicketRefs('Byte-for-byte the pre-#334 behaviour.'), /#\d+/);
  // Not a ticket ref: CSS hex colors, a heading anchor, and a URL fragment survive untouched.
  assert.equal(stripTicketRefs('Use color #fff for the background, or #a1b2c3 for the border.'), 'Use color #fff for the background, or #a1b2c3 for the border.');
  assert.equal(stripTicketRefs('See the #some-heading section.'), 'See the #some-heading section.');
  assert.equal(stripTicketRefs('Visit https://example.com/page#42 for details.'), 'Visit https://example.com/page#42 for details.');
});

test('friendliness: three-item nav, product side menu, where-am-I line, quickstart first, plain words', async () => {
  const out = makeTempDir('site-test-');
  await build({ out, repo: 'o/r', buildTime: BUILD_TIME });
  const gs = fs.readFileSync(path.join(out, 'user-guide/getting-started/index.html'), 'utf8');
  assert.match(gs, /<nav class="primary"[^>]*>(?:<a [^>]*>[^<]+<\/a>){3}<\/nav>/);
  for (const label of ['Home', 'Guide', 'For developers']) assert.match(gs, new RegExp(`>${label}</a>`));
  assert.ok(gs.indexOf('Try it in 60 seconds') < gs.indexOf('What just happened'), 'quickstart comes before the explanation');
  // The side menu is grouped by product, in order, and never by surface.
  const sidebar = /<aside class="sidebar"[\s\S]*?<\/aside>/.exec(gs)[0];
  assert.deepEqual([...sidebar.matchAll(/<p class="side-h">([^<]+)<\/p>/g)].map((m) => m[1]), ['Start', 'Construct', 'Cockpit', 'Videos', 'CLI']);
  assert.doesNotMatch(gs, /side-h">Examples/);
  assert.match(gs, /<p class="kicker">Start<\/p>/);
  const plan = fs.readFileSync(path.join(out, 'user-guide/examples/cockpit-plan-and-run/index.html'), 'utf8');
  assert.match(plan, /<p class="kicker">Cockpit<\/p>/);
  assert.match(plan, /aria-current="page"/);
  for (const g of exampleGroups()) for (const p of g.pages) {
    const html = fs.readFileSync(path.join(out, p.path, 'index.html'), 'utf8');
    for (const h of ['Do this', 'You get', 'Why it matters']) assert.match(html, new RegExp(`<h2 id="[^"]*">${h}<`), `${p.path} lacks "${h}"`);
  }
  const prose = plan.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(prose, /\bworktree\b|blast radius|envelope/i);
  fs.rmSync(out, { recursive: true });
});

test('API reference: core, engine and AST are generated from source, versioned, and list a known module and export', async () => {
  const out = makeTempDir('site-api-test-');
  await build({ out, repo: 'o/r', buildTime: BUILD_TIME, version: '0.9', api: ['core', 'engine', 'ast'] });
  const idx = fs.readFileSync(path.join(out, 'developers/api/index.html'), 'utf8');
  assert.match(idx, /v0\.9/);
  for (const id of ['core', 'engine', 'ast']) assert.match(idx, new RegExp(`href="[./]*developers/api/${id}/"`));
  const engine = fs.readFileSync(path.join(out, 'developers/api/engine/index.html'), 'utf8');
  assert.match(engine, /packages\/engine\/pipeline/, 'a known module is listed');
  const page = fs.readFileSync(path.join(out, 'developers/api/engine/packages/engine/pipeline/index.html'), 'utf8');
  assert.match(page, /runPipeline/, 'a known export is documented');
  assert.match(page, /<h[1-4][^>]*>Parameters/, 'params are rendered');
  assert.match(page, /v0\.9/, 'the page carries the version it was built for');
  assert.ok(fs.existsSync(path.join(out, 'developers/api/ast/packages/ast/parse/index.html')));
  assert.ok(!fs.existsSync(path.join(out, 'developers/api/tools')), 'packages not requested are not built');
  // Without `api` a build carries no API pages (library default).
  const plain = makeTempDir('site-noapi-test-');
  await build({ out: plain, repo: 'o/r', buildTime: BUILD_TIME });
  assert.ok(!fs.existsSync(path.join(plain, 'developers/api')));
  fs.rmSync(out, { recursive: true });
  fs.rmSync(plain, { recursive: true });
});

test('API reference: no leaked internal ticket number on any generated page of any of the 8 API-doc packages', async () => {
  const out = makeTempDir('site-api-allpkgs-test-');
  await build({ out, repo: 'o/r', buildTime: BUILD_TIME, version: '0.9', api: true });
  const apiRoot = path.join(out, 'developers/api');
  assert.ok(fs.existsSync(apiRoot));
  // Every one of the 8 API_PACKAGES writes its own directory (each has at least one documentable module in
  // this repo); a package silently missing from the build would otherwise go unchecked below.
  for (const pkg of API_PACKAGES) assert.ok(fs.existsSync(path.join(apiRoot, pkg.id)), `no output for package "${pkg.id}"`);
  let checked = 0;
  for (const f of walk(apiRoot).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(f, 'utf8');
    const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/&#\d+;/g, "'").replace(/<[^>]+>/g, ' ');
    assert.doesNotMatch(text, /#\d{2,4}\b/, `ticket number leaked in ${path.relative(out, f)}`);
    checked++;
  }
  assert.ok(checked > API_PACKAGES.length, 'more than one page per package was actually checked');
  fs.rmSync(out, { recursive: true });
});

test('API reference: Cockpit server REST reference and CLI command reference are wired into the versioned build', async () => {
  const out = makeTempDir('site-api-rest-cli-test-');
  await build({ out, repo: 'o/r', buildTime: BUILD_TIME, version: '0.9', api: ['cockpit-server', 'cli'] });

  const idx = fs.readFileSync(path.join(out, 'developers/api/index.html'), 'utf8');
  assert.match(idx, /href="[./]*developers\/api\/cockpit-server\/rest\/"/, 'the REST reference is linked from the API nav');
  assert.match(idx, /href="[./]*developers\/api\/cli\/"/, 'the CLI reference is linked from the API nav');

  const restIdx = fs.readFileSync(path.join(out, 'developers/api/cockpit-server/rest/index.html'), 'utf8');
  assert.match(restIdx, /href="[./]*developers\/api\/cockpit-server\/rest\/processes\/"/);
  const processes = fs.readFileSync(path.join(out, 'developers/api/cockpit-server/rest/processes/index.html'), 'utf8');
  assert.match(processes, /POST \/api\/processes\/:id\/decide/);
  assert.match(processes, /v0\.9/, 'the REST page carries the version it was built for');

  const cli = fs.readFileSync(path.join(out, 'developers/api/cli/index.html'), 'utf8');
  assert.match(cli, /construct review/);
  assert.match(cli, /v0\.9/, 'the CLI reference page carries the version it was built for');

  // No dead links and no internal ticket numbers on the pages this slice adds.
  for (const rel of ['developers/api/index.html', 'developers/api/cockpit-server/rest/index.html', 'developers/api/cockpit-server/rest/processes/index.html', 'developers/api/cli/index.html']) {
    const f = path.join(out, rel);
    const html = fs.readFileSync(f, 'utf8');
    const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/&#\d+;/g, "'").replace(/<[^>]+>/g, ' ');
    assert.doesNotMatch(text, /#\d{2,4}\b/, `ticket number leaked in ${rel}`);
    for (const m of html.matchAll(/<(?:a|img|link)\b[^>]*?(?:href|src)="(?!https?:|mailto:|data:|\/)([^"#]+)/g)) {
      let target = path.resolve(path.dirname(f), m[1]);
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
      assert.ok(fs.existsSync(target), `dead link ${m[1]} in ${rel}`);
    }
  }
  fs.rmSync(out, { recursive: true });
});

test('api-manifest.json: every package/module/REST group/CLI URL a future Trinity refresh needs, omitted without --api', async () => {
  const out = makeTempDir('site-api-manifest-test-');
  await build({ out, repo: 'o/r', buildTime: BUILD_TIME, version: '0.9', api: ['core', 'cockpit-server', 'cli'] });
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'api-manifest.json'), 'utf8'));
  assert.equal(manifest.version, 'v0.9');
  const core = manifest.packages.find((p) => p.id === 'core');
  assert.equal(core.url, 'https://o.github.io/r/developers/api/core/');
  assert.ok(core.modules.length > 5);
  assert.ok(core.modules.every((m) => m.url.startsWith(core.url)));
  assert.equal(manifest.cockpitServerRest.groups.find((g) => g.group === 'processes').routeCount > 0, true);
  assert.equal(manifest.cli.commandCount > 10, true);
  fs.rmSync(out, { recursive: true });

  const plain = makeTempDir('site-api-manifest-plain-test-');
  await build({ out: plain, repo: 'o/r', buildTime: BUILD_TIME });
  assert.ok(!fs.existsSync(path.join(plain, 'api-manifest.json')), 'no manifest without --api');
  fs.rmSync(plain, { recursive: true });
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--out', 'x', '--repo', 'a/b']), { out: 'x', repo: 'a/b' });
});

test('video pages offer a download and the published site leaves out video history', async () => {
  const out = makeTempDir('site-test-');
  await build({ out, repo: 'o/r', buildTime: BUILD_TIME });
  const page = fs.readFileSync(path.join(out, 'user-guide/videos/ticket-to-story/index.html'), 'utf8');
  assert.match(page, /<video controls/);
  assert.match(page, /Download the video<\/a><\/video>/);
  assert.ok(fs.existsSync(path.join(out, 'assets/video/01-ticket-to-story.webm')));
  // Subtitles and the narrated version are optional siblings; when their files exist the page offers them.
  assert.match(page, /<track kind="subtitles" srclang="en" label="English" src="[^"]*01-ticket-to-story\.en\.vtt">/);
  assert.match(page, /<figcaption>Downloads: <a href="[^"]*01-ticket-to-story\.webm" download>Silent video/);
  assert.match(page, /<a href="[^"]*01-ticket-to-story\.voice\.webm" download>With synthetic narration/);
  assert.match(page, /<a href="[^"]*01-ticket-to-story\.mixed\.webm" download>With narration and music/);
  assert.match(page, /<a href="[^"]*01-ticket-to-story\.voice\.opus" download>Narration only/);
  assert.match(page, /<a href="[^"]*01-ticket-to-story\.music\.opus" download>Music only/);
  assert.match(page, /<a href="[^"]*01-ticket-to-story\.en\.srt" download>Subtitles/);
  assert.ok(fs.existsSync(path.join(out, 'assets/video/01-ticket-to-story.en.vtt')));
  assert.ok(!fs.existsSync(path.join(out, 'assets/video/history')), 'earlier takes stay in the repo, not on the site');
  fs.rmSync(out, { recursive: true });
});
