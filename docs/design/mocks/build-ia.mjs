// Concept mocks for the five-screen information architecture (Features / Pages / Components / Git / Tests).
// Usage: node docs/design/mocks/build-ia.mjs && node docs/design/mocks/render.mjs ia-
// Content is illustrative storefront data (same as the other mocks), not repo output.
// Vocabulary (owner decision): the title + free text describing a change is a "Note"; steps stay "Plan".
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tabs, stateCard } from './parts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} - Concept</title>
<link rel="stylesheet" href="mock.css"><link rel="stylesheet" href="ia.css">
<script>document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') || 'dark';</script>
</head><body>
<div class="concept">Concept - not implemented <span>${title}</span></div>
${body}
</body></html>`;

const SCREENS = ['Features', 'Pages', 'Components', 'Git', 'Tests'];
const topbar = ({ screen, menuOpen = false, off = false, procs = '2 running', project = true }) => `
<header class="topbar" role="banner">
  <div class="brand"><i></i>Cockpit</div>
  ${project ? '<button class="chip-btn" aria-haspopup="listbox">storefront <span class="sub">main</span> &#9662;</button>' : '<button class="chip-btn" aria-haspopup="listbox">No project &#9662;</button>'}
  <nav class="snav ${off ? 'off' : ''}" aria-label="Screens">${SCREENS.map((s) => `<a class="${s === screen ? 'on' : ''}" ${s === screen ? 'aria-current="page"' : ''}>${s}${s === 'Git' && !off ? ' <span class="badge">3</span>' : ''}</a>`).join('')}</nav>
  <button class="chip-btn palette-trigger"><span>Search or run a command...</span><kbd>Ctrl K</kbd></button>
  <span class="pill run"><span class="spin"></span>${procs}</span>
  <button class="acct ${menuOpen ? 'open' : ''}" aria-haspopup="true" aria-expanded="${menuOpen}"><span class="avatar">SP</span>shashank-p &#9662;</button>
</header>`;

const menuInner = `
  <div class="who"><span class="avatar">SP</span><div><b>shashank-p</b><small>Signed in with GitHub</small></div></div>
  <div class="mgrp">Preferences</div>
  <div class="mi on"><span class="g">&#9881;</span>Settings<span class="r">Git, commits, model choice</span></div>
  <div class="mi"><span class="g">&#9673;</span>Local model<span class="r"><span class="pill ok" style="height:20px;padding:0 8px"><span class="dot"></span>Ready</span></span></div>
  <div class="mi"><span class="g">&#9680;</span>Theme<span class="r"><span class="seg"><button>Dark</button><button>Light</button><button class="on">System</button></span></span></div>
  <div class="msep"></div>
  <div class="mi"><span class="g">?</span>Help and shortcuts<span class="r"><kbd>?</kbd></span></div>
  <div class="msep"></div>
  <div class="mi"><span class="g">&#8677;</span>Sign out<span class="r">Ends this session only</span></div>`;
const menu = `<div class="menu" role="group" aria-label="Account">${menuInner}</div>`;

const bottom = (on = 'Processes', body, h = 150, counts = { p: '2', a: '1' }) => `
<div class="drawer" aria-label="Bottom panel: Run" style="height:${h}px">
  ${tabs([['Processes', [counts.p, 'acc']], ['Approvals', [counts.a, '']], ['Diagnostics', ['3', 'danger']], ['Logs', null]], on)}
  <div class="body">${body}</div>
</div>`;

const procTable = `
<table><tr><th>Process</th><th>Project</th><th>Step</th><th>Progress</th><th>Who</th><th></th></tr>
<tr><td><b>plan &middot; refund a delivered order</b></td><td>storefront</td><td>3 of 5 &middot; propose refundMachine</td><td><div class="bar-track"><div class="bar-fill" style="width:60%"></div></div></td><td><span class="tag llm">Local model</span></td><td><button class="btn sm">Pause</button> <button class="btn sm danger">Cancel</button></td></tr>
<tr><td>research &middot; issue #142</td><td>storefront</td><td>Done &middot; 2 min ago</td><td>Finished</td><td><span class="tag det">Deterministic</span></td><td><button class="btn sm primary">Review 4 files</button></td></tr>
</table>`;

const statusbar = `<footer class="statusbar"><span class="ok">&#9679; validate: 0 new violations</span><span>Notes saved on this machine</span><span class="spacer"></span><span>qwen2.5-coder:7b</span><span><kbd>F6</kbd> next panel</span><span><kbd>Ctrl J</kbd> bottom panel</span></footer>`;

const frame = ({ screen, left, mid, right, bot, menuOpen, extra = '', off, procs, project, lw, rw, botH = 150 }) => `
<div class="shell" style="${lw ? `--lw:${lw}px;` : ''}${rw ? `--rw:${rw}px;` : ''}grid-template-rows:44px 1fr ${botH}px 24px;position:relative">
  ${topbar({ screen, menuOpen, off, procs, project })}
  <div class="ia-main">
    <aside class="pane" aria-label="Left panel: Browse">${left}</aside><div class="resizer" role="separator" aria-orientation="vertical" tabindex="0"></div>
    <section class="pane mid" aria-label="Center stage">${mid}</section><div class="resizer" role="separator" aria-orientation="vertical" tabindex="0"></div>
    <aside class="pane" aria-label="Right panel: Inspect">${right}</aside>
  </div>
  ${bot}
  ${statusbar}
  ${menuOpen ? menu : ''}${extra}
</div>`;

const L = (k) => `<span class="layer ${k}">${k}</span>`;

/* ------------------------------------------------ 1 Features screen (hero) */
const featLeft = `
  <div class="pane-h"><span class="title">Features</span><span class="spacer"></span><button class="icon-btn" aria-label="New note">+</button><button class="icon-btn" aria-label="Collapse">&laquo;</button></div>
  ${tabs([['Notes', ['3', 'acc']], ['Features']], 'Notes')}
  <div class="search">&#8981; Filter notes <span class="spacer"></span><kbd>/</kbd></div>
  <div class="scroll"><div class="sect">Notes &middot; 3</div><div class="tree" style="padding:0 6px">
    <div class="dr sel"><span class="n">Refund a delivered order</span><span class="st draft">Draft</span><span class="s">Saved 12:41 &middot; edited 2 min ago</span></div>
    <div class="dr"><span class="n">Guest checkout</span><span class="st ready">Plan ready</span><span class="s">5 steps &middot; yesterday</span></div>
    <div class="dr"><span class="n">Split cart totals</span><span class="st run">Ran</span><span class="s">Process #12 &middot; 3 days ago</span></div>
  </div>
  <div class="sect" style="margin-top:8px">Features &middot; 4</div><div class="tree">
    <div class="row"><span class="twisty">&#9656;</span>auth<span class="meta">7 files</span></div>
    <div class="row"><span class="twisty">&#9656;</span>cart<span class="meta">11 files</span></div>
    <div class="row"><span class="twisty">&#9656;</span>checkout<span class="meta">9 files</span></div>
    <div class="row"><span class="twisty">&#9656;</span>orders<span class="meta">6 files</span></div>
  </div></div>`;
const impactRows = [['orders', 'feature', 'starts here'], ['checkout', 'feature', 'imports orderService'], ['ui-kit', 'component', 'AmountField used by 5 features']];
const featMid = `
  <div class="canvas-tb"><span class="crumbs">Features &rsaquo; Notes &rsaquo; <b>Refund a delivered order</b></span><span class="spacer"></span><span class="saveind ok">&#10003; Saved on this machine &middot; 12:41</span></div>
  <div style="overflow:hidden;flex:1">
  <div class="notebox"><div class="t">Refund a delivered order<span class="spacer"></span><span class="st draft">Draft</span></div>
    <div class="b">Customers should be able to request a refund from the order page within 30 days of delivery. Partial refunds allowed. Needs a confirmation step and an audit entry.</div>
    <div class="f"><span class="saveind">Autosaves as you type &middot; stays on this machine, never sent to a model</span><span class="spacer"></span><button class="btn sm">Research this note</button></div></div>
  <div class="sect" style="padding:16px 18px 6px">Impact <span class="tag det" style="margin-left:8px">Deterministic</span></div>
  <div style="margin:0 18px;background:var(--surface-1);border:1px solid var(--border-subtle);border-radius:var(--r-lg)"><table><tr><th>Where</th><th>Layer</th><th>Why</th><th>How known</th></tr>
  ${impactRows.map((r) => `<tr><td><b>${r[0]}</b></td><td>${L(r[1])}</td><td>${r[2]}</td><td><span class="tag det">Deterministic</span></td></tr>`).join('')}</table></div></div>`;
const featRight = `
  <div class="pane-h"><span class="title">Plan</span><span class="spacer"></span><span class="tag llm">1 model step</span></div>
  ${tabs([['Note'], ['Impact'], ['Plan', ['5', 'acc']]], 'Plan')}
  <div class="scroll">
    ${[['Summarize the orders feature', 'construct research summarize', 'det'], ['Trace refund paths in checkout', 'construct research workflow', 'det'], ['Propose refundMachine states', 'local model (qwen2.5-coder:7b)', 'llm'], ['Add refundService and hook', 'construct create service, hook', 'det'], ['You approve the diff', 'nothing applied without you', 'human']]
      .map((s, i) => `<div class="step"><span class="no">${i + 1}</span><div><b>${s[0]}</b><small>${s[1]}</small></div><span class="tag ${s[2]}">${{ det: 'Deterministic', llm: 'Local model', human: 'You' }[s[2]]}</span></div>`).join('')}
    <div style="padding:12px;display:flex;gap:8px"><button class="btn primary">Run plan</button><button class="btn">Edit steps</button></div>
  </div>`;
const features = frame({ screen: 'Features', left: featLeft, mid: featMid, right: featRight, bot: bottom('Processes', procTable) });

/* ------------------------------------------------ 2 Account menu on Pages */
const pagesLeft = `
  <div class="pane-h"><span class="title">Pages</span><span class="spacer"></span><button class="icon-btn">&laquo;</button></div>
  <div class="search">&#8981; Filter routes <span class="spacer"></span><kbd>/</kbd></div>
  <div class="scroll"><div class="sect">Pages &middot; 6</div><div class="tree">${['/', '/login', '/register', '/cart', '/checkout', '/products/[id]'].map((p, i) => `<div class="row ${i === 1 ? 'sel' : ''}">${L('page')}${p}<span class="meta">${['catalog', 'auth', 'auth', 'cart', 'checkout', 'catalog'][i]}</span></div>`).join('')}</div></div>`;
const pagesMid = `
  <div class="canvas-tb"><span class="crumbs">Pages &rsaquo; <b>/login</b></span><span class="spacer"></span><button class="btn sm">&#8853; Pick</button></div>
  <div class="stage"><div class="device" style="height:400px"><div class="bar"><i></i><i></i><i></i>&nbsp;&nbsp;localhost:5173/login</div><div class="app-nav"><b>Storefront</b><span>Catalog</span><span>Cart (2)</span></div><div class="login"><h2>Welcome back</h2><p>Sign in to continue.</p><label>Email</label><div class="in">sam@example.com</div><div class="cta">Sign in</div></div></div></div>`;
const pagesRight = `<div class="pane-h"><span class="title">Inspect</span></div>${tabs([['Inspector'], ['Scope'], ['Source'], ['Diff']], 'Inspector')}<div class="section"><div class="el-head"><span class="name">LoginForm</span>${L('component')}</div><div class="path">features/auth/components/LoginForm.tsx:14</div></div>`;
const menuMock = frame({ screen: 'Pages', left: pagesLeft, mid: pagesMid, right: pagesRight, bot: bottom('Processes', procTable, 134), menuOpen: true, botH: 134 });

/* ------------------------------------------------ 3 Slot matrix */
const cell = (arr) => arr.map((x) => `<span>${x}</span>`).join('');
const matrix = `
<div class="hh">Every screen fills the same four slots<small>Left = browse, Center = the thing itself, Right = inspect and act (verbs are tabs), Bottom = run and approve. A slot is a registered tab list, not a hard-wired panel.</small></div>
<table class="mx"><tr><th></th><th>Left panel (browse)</th><th>Center stage</th><th>Right panel (verb tabs)</th><th>Bottom panel (run)</th></tr>
<tr><td>Features</td><td>${cell(['<b>Tabs</b>Notes | Features', 'Saved notes, feature tree with summaries'])}</td><td>${cell(['Your note and its impact table', 'Feature summary and its flow', 'Create / Refactor / Import forms'])}</td><td>${cell(['<b>Verbs</b>Note | Impact | Plan', 'Plan steps tagged Deterministic / Local model / You'])}</td><td>Processes, Approvals, Diagnostics, Logs</td></tr>
<tr><td>Pages</td><td>${cell(['<b>Tabs</b>Pages | Flow', 'Route tree, flow tree'])}</td><td>Live preview, click to select</td><td>${cell(['<b>Verbs</b>Inspector | Scope | Source | Diff'])}</td><td>same bottom panel</td></tr>
<tr><td>Components</td><td>${cell(['<b>Tabs</b>Components | Workflows', 'Component tree, state machines'])}</td><td>${cell(['Component in isolation', 'or workflow diagram / narrative'])}</td><td>${cell(['<b>Verbs</b>Inspector | Used by | Source | Diff | Flow'])}</td><td>same bottom panel</td></tr>
<tr><td>Git</td><td>${cell(['<b>Tabs</b>Changes | Branches | PRs | Commits', 'Changed-file tree, branch and PR lists'])}</td><td>${cell(['Change view, blast radius', 'Connect / clone a remote (empty state)'])}</td><td>${cell(['<b>Verbs</b>Findings | Detail | Plan match | Commit (auto-commit, branch, dirty tree)', 'Review lives here, inside Git'])}</td><td>Analysis process, Approvals for auto-fix</td></tr>
<tr><td>Tests</td><td>${cell(['<b>Tabs</b>Tests | Coverage', 'Scenario and test list'])}</td><td>Test steps document, run result</td><td>${cell(['<b>Verbs</b>Edit step | Record | Freshness'])}</td><td>Test runs as processes</td></tr>
</table>
<p class="note">Git holds source control (changes, branches, commits), pull requests and Review. Not screens: Settings, Local model, Help, account and sign-out (top-right profile menu); the project switcher (top bar); the command palette (Ctrl K). The bottom panel is identical on every screen, so a running process or a waiting approval is never more than one keypress away (Ctrl J).</p>`;

/* ------------------------------------------------ 4 Notes states */
const dcard = (h, ind, body, extra = '') => `<div class="card"><b>${h}</b><div>${ind}</div><p>${body}</p>${extra}</div>`;
const drafts = `
<div class="hh">Notes: durable, per project, on this machine<small>Autosaved on the server into the per-user state directory. Never committed, never sent to a model unless you press a model step.</small></div>
<div class="sheet3">
 <div><h3>While you type</h3>
  ${dcard('Saving', '<span class="saveind busy"><span class="spin"></span> Saving...</span>', 'Fires 800 ms after you stop typing. The text is never blocked.')}
  ${dcard('Saved', '<span class="saveind ok">&#10003; Saved on this machine &middot; 12:41</span>', 'Reload the page or restart the Cockpit and the note is still there.')}
  ${dcard('Empty', '<span class="saveind">No notes yet</span>', 'Describe a change you want. It saves as you go.', '<div><button class="btn primary sm">New note</button></div>')}</div>
 <div><h3>When something is wrong</h3>
  ${dcard('Changed somewhere else', '<span class="saveind warn">&#9888; This note changed in another tab</span>', 'Two tabs edited the same note. Nothing is overwritten. Choose which copy wins.', '<div><button class="btn sm primary">Keep mine</button> <button class="btn sm">Load theirs</button> <button class="btn sm">Compare</button></div>')}
  ${dcard('Could not save', '<span class="saveind bad">&#10005; Not saved &middot; disk full</span>', 'Your text stays in the page. Free some space and press Retry. Do not close the tab yet.', '<div><button class="btn sm primary">Retry</button></div>')}</div>
 <div><h3>Life of a note</h3>
  ${dcard('Draft', '<span class="st draft">Draft</span>', 'Editable. Autosaved. Listed under Features, Notes.')}
  ${dcard('Plan ready', '<span class="st ready">Plan ready</span>', 'Steps proposed and tagged. Still editable; editing the text marks the plan Out of date.')}
  ${dcard('Ran', '<span class="st run">Ran</span> Process #12', 'Pressing Run copies the note and plan into a process record. The note becomes read-only history; duplicate it to iterate.')}</div>
</div>`;

/* ------------------------------------------------ 5 No project */
const noProj = frame({
  screen: 'Features', off: true, project: false, procs: '0 running',
  left: `<div class="pane-h"><span class="title">Features</span></div><div class="scroll" style="padding:14px;color:var(--text-muted)">Nothing to browse until a project is open.</div>`,
  mid: `<div class="stage">${stateCard('&#9635;', 'Open a project to start', 'Pick a folder that contains an architecture.yml, or open a repository from GitHub.', '<div><button class="btn primary">Open a project...</button> <button class="btn">Clone a repository...</button></div>')}<div class="slotlab" style="left:16px;top:12px">Prompt and clone are built separately (workspace-scoped, #330 slice A): only their position is shown here</div></div>`,
  right: `<div class="pane-h"><span class="title">Inspect</span></div><div class="scroll" style="padding:14px;color:var(--text-muted)">Select something to inspect.</div>`,
  bot: bottom('Processes', '<div style="padding:14px;color:var(--text-muted)">No processes yet. Running and finished processes for a project appear here, on every screen.</div>', 110, { p: '0', a: '0' }), botH: 110,
});

/* ------------------------------------------------ 6 Git (PRs + Review inside) */
const gitLeft = (tab) => `<div class="pane-h"><span class="title">Git</span><span class="spacer"></span><button class="btn sm" aria-label="Connect remote">Connect remote</button><button class="icon-btn">&laquo;</button></div>${tabs([['Changes', ['11', '']], ['Branches'], ['PRs', ['3', 'acc']], ['Commits']], tab)}<div class="scroll"><div class="tree" style="padding-top:8px">
   <div class="dr sel"><span class="n">#341 Refund a delivered order</span><span class="st stale">2 findings</span><span class="s">shashank-p &middot; 11 files &middot; matches plan</span></div>
   <div class="dr"><span class="n">#338 Guest checkout</span><span class="st run">Clean</span><span class="s">4 files</span></div>
   <div class="dr"><span class="n">#335 Fix cart rounding</span><span class="st draft">No plan</span><span class="s">2 files</span></div></div>
   <div class="sect">Changed files &middot; 11</div><div class="tree"><div class="row">${L('workflow')}refundMachine.ts<span class="meta">+64</span></div><div class="row sel">${L('component')}RefundForm.tsx<span class="meta">+38 -2</span></div><div class="row">${L('component')}AmountField.tsx<span class="meta">+3</span></div></div></div>`;
const git = frame({
  screen: 'Git', lw: 356,
  left: gitLeft('PRs'),
  mid: `<div class="canvas-tb"><span class="crumbs">Git &rsaquo; PRs &rsaquo; #341 &rsaquo; <b>RefundForm.tsx</b></span><span class="spacer"></span><span class="tag det">Deterministic checks</span></div>
   <div class="scroll"><div class="code">${[['12', ' import { useRefundForm } from "../hooks/useRefundForm";', ''], ['13', '+import { orderService } from "@/features/orders/services/orderService";', 'add'], ['14', ' export function RefundForm() {', ''], ['15', '+  const orders = orderService.list();', 'add'], ['16', '   return <AmountField />;', '']].map((l) => `<div class="ln ${l[2]}"><i>${l[0]}</i><span>${l[1].replace(/</g, '&lt;')}</span></div>`).join('')}</div>
   <div class="callout warn"><span>&#9888;</span><div class="grow"><b>A component imports a service</b><small>Components go through a hook. Rule COMPONENT-002, deterministic.</small></div><button class="btn sm">Show in findings</button></div></div>`,
  right: `<div class="pane-h"><span class="title">Review and commit</span></div>${tabs([['Findings', ['2', '']], ['Detail'], ['Plan match'], ['Commit']], 'Findings')}<div class="scroll">
   <div class="step"><span class="no">!</span><div><b>Component imports a service</b><small>RefundForm.tsx:13 &middot; COMPONENT-002</small></div><span class="tag det">Deterministic</span></div>
   <div class="step"><span class="no">!</span><div><b>Touches shared AmountField (used by 5 features)</b><small>not in the plan</small></div><span class="tag det">Deterministic</span></div>
   <div style="padding:12px"><button class="btn">Propose a fix</button> <span class="tag llm">Local model - diff shown first</span></div></div>`,
  bot: bottom('Approvals', `<table><tr><th>Waiting for you</th><th>Proposed by</th><th></th></tr><tr><td><b>Fix: route RefundForm through useRefundForm</b> &middot; 1 file, +4 -2</td><td><span class="tag llm">Local model</span></td><td><button class="btn sm primary">Review diff</button> <button class="btn sm">Dismiss</button></td></tr></table>`, 134, { p: '1', a: '1' }), botH: 134,
});

/* Git with no remote: where "Connect remote" (clone and connect, #330 slice A) sits */
const gitConnect = frame({
  screen: 'Git', lw: 356,
  left: `<div class="pane-h"><span class="title">Git</span><span class="spacer"></span><button class="btn sm primary" aria-label="Connect remote">Connect remote</button></div>${tabs([['Changes', ['3', '']], ['Branches'], ['PRs'], ['Commits']], 'Changes')}<div class="scroll"><div class="sect">Changed files &middot; 3</div><div class="tree"><div class="row">${L('page')}checkout/page.tsx<span class="meta">+4 -1</span></div><div class="row">${L('component')}CartTotals.tsx<span class="meta">+12</span></div><div class="row">${L('workflow')}cartMachine.ts<span class="meta">+2</span></div></div></div>`,
  mid: `<div class="stage">${stateCard('&#8644;', 'This project has no remote yet', 'Connect a GitHub repository to see pull requests, branches and reviews here. Cloning always goes into your single workspace root.', '<div><button class="btn primary">Connect remote...</button> <button class="btn">Clone a repository...</button></div>')}<div class="slotlab" style="left:16px;top:12px">Being built as #330 slice A: only its position is shown here</div></div>`,
  right: `<div class="pane-h"><span class="title">Review</span></div><div class="scroll" style="padding:14px;color:var(--text-muted)">Findings appear here once a pull request is selected. Local changes can still be reviewed against the plan.</div>`,
  bot: bottom('Processes', '<div style="padding:14px;color:var(--text-muted)">No processes yet. Running and finished processes for a project appear here, on every screen.</div>', 110, { p: '0', a: '0' }), botH: 110,
});

/* ------------------------------------------------ 6b Git: Changes tab, stage/unstage, diff, Commit tab (#331, part of #277) */
const sessionBanner = (mode = 'every save') => `<div style="padding:8px 10px;border-bottom:1px solid var(--border-subtle)">
  <div style="font:600 12px var(--mono)">cockpit/refund-a-delivered-order</div>
  <div style="color:var(--text-faint);font-size:11px;margin-top:2px">Session branch (#283) &middot; save 12 &middot; auto-commit: ${mode}</div>
</div>`;
const cbRow = (layer, name, meta, on = true) => `<div class="art"><span class="cb ${on ? 'on' : ''}" aria-hidden="true">${on ? '&#10003;' : ''}</span><span>${L(layer)} ${name}</span><span style="margin-left:auto;color:var(--text-faint);font:11px var(--mono)">${meta}</span></div>`;
const diffLines = [['12', ' import { useRefundForm } from "../hooks/useRefundForm";', ''], ['13', '+import { orderService } from "@/features/orders/services/orderService";', 'add'], ['14', ' export function RefundForm() {', ''], ['15', '+  const orders = orderService.list();', 'add'], ['16', '   return <AmountField />;', '']];
const diffBlock = `<div class="code">${diffLines.map((l) => `<div class="ln ${l[2]}"><i>${l[0]}</i><span>${l[1].replace(/</g, '&lt;')}</span></div>`).join('')}</div>`;

const gitChangesLeft = (grouping = 1) => `<div class="pane-h"><span class="title">Git</span><span class="spacer"></span><button class="icon-btn" aria-label="Fetch">&#8635;</button><button class="icon-btn">&laquo;</button></div>${tabs([['Changes', ['11', 'acc']], ['Branches'], ['PRs', ['3', '']], ['Commits']], 'Changes')}
${sessionBanner()}
<div style="display:flex;gap:4px;padding:6px 10px;border-bottom:1px solid var(--border-subtle)">${['By feature', 'By layer', 'Files'].map((g, i) => `<button class="tg" aria-pressed="${i === grouping}">${g}</button>`).join('')}</div>
<div class="scroll">
 <details class="dt" open><summary>Staged &middot; ready to commit <span class="c">4</span></summary>
  <div style="padding:2px 0 6px"><button class="btn sm" style="margin:2px 0 4px 8px">Unstage all</button>
  ${cbRow('workflow', 'refundMachine.ts', '+64')}
  ${cbRow('component', 'RefundForm.tsx', '+38 -2')}
  ${cbRow('component', 'AmountField.tsx', '+3')}
  ${cbRow('domain', 'RefundPolicy.ts', '+11')}</div></details>
 <details class="dt" open><summary>Not staged <span class="c">7</span></summary>
  <div style="padding:2px 0 6px"><button class="btn sm" style="margin:2px 0 4px 8px">Stage all</button>
  ${cbRow('page', 'orders/[id]/refund/page.tsx', '+9 -1', false)}
  ${cbRow('service', 'orderService.ts', '+5', false)}
  ${cbRow('hook', 'useRefundForm.ts', '+22', false)}</div></details>
</div>`;

const gitChangesMid = `<div class="canvas-tb"><span class="crumbs">Git &rsaquo; Changes &rsaquo; <b>RefundForm.tsx</b></span><span class="spacer"></span><span class="tag det">Diff computed by git, not a model</span></div>
<div class="scroll">${diffBlock}
<div class="callout info"><span>&#9432;</span><div class="grow"><b>Staged as a whole file</b><small>Construct stages by file, not by hunk (the same block commit-on-save already uses), so what you commit here is exactly what this diff shows &mdash; reuses the Pages editor's unified diff view (<code>DiffView.tsx</code>), not a new diff renderer.</small></div></div></div>`;

const commitBox = `<div style="padding:10px 12px;border-bottom:1px solid var(--border-subtle)">
  <div class="saveind ok" style="margin-bottom:4px">&#10003; Commit on save: every save</div>
  <div style="color:var(--text-faint);font-size:11px">Settings &middot; Git controls the mode, prefix and branch naming (#283)</div>
 </div>
 <div style="padding:10px 12px;border-bottom:1px solid var(--border-subtle)">
  <label style="display:block;font-size:11px;color:var(--text-faint);margin-bottom:4px">Commit message &middot; 4 files staged</label>
  <div class="field" style="height:auto;padding:6px 8px;white-space:normal">CON refund: workflow, component, domain &middot; 3 features, 4 layers, 4 files</div>
  <div style="display:flex;gap:8px;margin-top:8px"><button class="btn primary sm">Commit staged</button><button class="btn sm">Amend last</button></div>
 </div>`;

const pushReady = `<div style="padding:10px 12px">
  <div style="display:flex;align-items:center;gap:8px"><b style="font-size:12px">Push / Pull</b><span class="tag det">3 ahead of origin/main</span></div>
  <p style="color:var(--text-muted);font-size:12px;margin:6px 0">Pushing sends this session branch to GitHub. Nothing pushes on its own &mdash; the one thing #283 deliberately left manual.</p>
  <div style="display:flex;gap:8px"><button class="btn primary sm">Push</button><button class="btn sm">Pull</button></div>
</div>`;

const pushBlocked = `<div style="padding:10px 12px">
  <div style="display:flex;align-items:center;gap:8px"><b style="font-size:12px">Push</b><span class="tag" style="background:var(--surface-3);color:var(--text-muted)">Not connected</span></div>
  <p style="color:var(--text-muted);font-size:12px;margin:6px 0">This Cockpit has no GitHub push credential yet (#638, waiting on the owner registering a GitHub App). Local commits are never blocked by this.</p>
  <button class="btn sm" disabled>Connect GitHub to push</button>
  <p style="color:var(--text-faint);font-size:11px;margin-top:8px">Meanwhile: <code>git push</code> from a terminal still works if this machine already has its own git credentials &mdash; this panel does not stop that.</p>
</div>`;

const gitChanges = frame({
  screen: 'Git', lw: 356,
  left: gitChangesLeft(1),
  mid: gitChangesMid,
  right: `<div class="pane-h"><span class="title">Review and commit</span></div>${tabs([['Findings', ['2', '']], ['Detail'], ['Plan match'], ['Commit']], 'Commit')}<div class="scroll">${commitBox}${pushReady}</div>`,
  bot: bottom('Processes', procTable, 134, { p: '2', a: '0' }), botH: 134,
});

const gitCommitBlocked = frame({
  screen: 'Git', lw: 356,
  left: gitChangesLeft(1),
  mid: gitChangesMid,
  right: `<div class="pane-h"><span class="title">Review and commit</span></div>${tabs([['Findings', ['2', '']], ['Detail'], ['Plan match'], ['Commit']], 'Commit')}<div class="scroll">${commitBox}${pushBlocked}</div>`,
  bot: bottom('Processes', procTable, 134, { p: '2', a: '0' }), botH: 134,
});

const gitBranches = frame({
  screen: 'Git', lw: 356,
  left: `<div class="pane-h"><span class="title">Git</span><span class="spacer"></span><button class="icon-btn" aria-label="Fetch">&#8635;</button><button class="icon-btn">&laquo;</button></div>${tabs([['Changes', ['11', '']], ['Branches'], ['PRs', ['3', '']], ['Commits']], 'Branches')}
   <div class="scroll"><div class="sect">Session branch</div>
   <div class="dr sel"><span class="n">cockpit/refund-a-delivered-order</span><span class="st ready">Current &middot; save 12</span><span class="s">auto-commit: every save</span></div>
   <div class="sect" style="margin-top:8px">New branch</div>
   <div style="display:flex;gap:6px;padding:0 10px 10px"><span class="field" style="flex:1;color:var(--text-faint)">e.g. fix-cart-rounding</span><button class="btn sm primary">Create</button></div>
   <div class="sect">Other branches &middot; 3</div>
   <div class="dr"><span class="n">main</span><span class="s">up to date</span></div><button class="btn sm" style="margin:0 10px 8px">Switch</button>
   <div class="dr"><span class="n">cockpit/guest-checkout</span><span class="s">4 files ahead &middot; save 6</span></div><button class="btn sm" style="margin:0 10px 8px">Switch</button>
   <div class="dr"><span class="n">cockpit/fix-cart-rounding</span><span class="s">2 files ahead &middot; save 2</span></div><button class="btn sm" style="margin:0 10px 8px">Switch</button></div>`,
  mid: `<div class="stage">${stateCard('&#8646;', 'Switching branches', 'Pick a branch on the left to check it out. A dirty working tree is offered a choice first (same DirtyTreePrompt #283 already shows on save), never silently discarded or force-switched.', '<div class="slotlab" style="position:static;display:inline-block">Local operation &middot; no sign-in needed on loopback</div>')}</div>`,
  right: `<div class="pane-h"><span class="title">Review and commit</span></div>${tabs([['Findings', ['0', '']], ['Detail'], ['Plan match'], ['Commit']], 'Commit')}<div class="scroll">${commitBox}${pushReady}</div>`,
  bot: bottom('Processes', procTable, 134, { p: '2', a: '0' }), botH: 134,
});

const gitClean = frame({
  screen: 'Git', lw: 356,
  left: `<div class="pane-h"><span class="title">Git</span><span class="spacer"></span><button class="icon-btn" aria-label="Fetch">&#8635;</button><button class="icon-btn">&laquo;</button></div>${tabs([['Changes', null], ['Branches'], ['PRs', ['3', '']], ['Commits']], 'Changes')}
   ${sessionBanner('manual')}
   <div class="scroll" style="padding:14px;color:var(--text-muted)">Nothing to stage or commit. The working tree matches <code>HEAD</code> on this branch. Auto-commit is set to manual here, so nothing will commit on its own even after your next save &mdash; press Commit when you have something to record.</div>`,
  mid: `<div class="stage">${stateCard('&#10003;', 'Nothing to commit', 'The working tree matches the last commit on this branch. Keep editing, or switch branches to review something else.', '')}</div>`,
  right: `<div class="pane-h"><span class="title">Review and commit</span></div>${tabs([['Findings', null], ['Detail'], ['Plan match'], ['Commit']], 'Commit')}<div class="scroll">
   <div style="padding:10px 12px;border-bottom:1px solid var(--border-subtle)">
    <div class="saveind" style="margin-bottom:4px;color:var(--text-muted)">Commit on save: manual &mdash; nothing commits until you press Commit</div>
   </div>
   <div style="padding:10px 12px;border-bottom:1px solid var(--border-subtle)">
    <label style="display:block;font-size:11px;color:var(--text-faint);margin-bottom:4px">Last commit</label>
    <div style="font:12px var(--mono)">CON guest-checkout: page, hook &middot; 2 features, 3 layers, 4 files</div>
    <div style="color:var(--text-faint);font-size:11px;margin-top:4px">on <code>cockpit/guest-checkout</code></div>
   </div>${pushReady}</div>`,
  bot: bottom('Processes', '<div style="padding:14px;color:var(--text-muted)">No processes running.</div>', 110, { p: '0', a: '0' }), botH: 110,
});

/* ------------------------------------------------ 7 Narrow */
const phone = (title, tab, body, extra = '') => `<div><h3 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted)">${title}</h3><div class="narrow" style="position:relative;height:780px">
 <div class="topbar" style="height:44px;flex:none"><div class="brand"><i></i>Cockpit</div><span class="spacer"></span><span class="pill run"><span class="spin"></span>2</span><span class="avatar" aria-label="Account">SP</span></div>
 <nav class="snav" aria-label="Screens" style="height:38px;overflow:hidden;border-bottom:1px solid var(--border-subtle);flex:none;margin:0;padding:0 4px">${['Features', 'Pages', 'Comp.', 'Git', 'Tests'].map((s, i) => `<a class="${i === 0 ? 'on' : ''}" style="padding:0 9px;font-size:12px">${s}</a>`).join('')}</nav>
 <div style="flex:1;overflow:hidden;position:relative">${body}${extra}</div>
 <div class="tabbar" role="tablist">${['Browse', 'Stage', 'Inspect', 'Run'].map((t) => `<div class="${t === tab ? 'on' : ''}" role="tab">${t}${t === 'Run' ? ' <span class="badge acc">2</span>' : ''}</div>`).join('')}</div></div></div>`;
const narrow = `<div class="sheet3" style="grid-template-columns:repeat(3,390px);justify-content:space-between">
 ${phone('Browse: notes', 'Browse', `<div class="sect">Notes &middot; 3</div><div class="tree" style="padding:0 6px">
   <div class="dr sel"><span class="n">Refund a delivered order</span><span class="st draft">Draft</span><span class="s">Saved 12:41</span></div><div class="dr"><span class="n">Guest checkout</span><span class="st ready">Plan ready</span><span class="s">5 steps</span></div><div class="dr"><span class="n">Split cart totals</span><span class="st run">Ran</span><span class="s">Process #12</span></div></div>`)}
 ${phone('Run: processes and approvals', 'Run', `<div style="padding:10px;display:grid;gap:10px"><div class="card"><b>plan &middot; refund a delivered order</b><div class="bar-track" style="width:100%"><div class="bar-fill" style="width:60%"></div></div><span class="saveind">Step 3 of 5 &middot; <span class="tag llm">Local model</span></span><div><button class="btn sm">Pause</button> <button class="btn sm danger">Cancel</button></div></div><div class="card"><b>1 approval waiting</b><p>Fix: route RefundForm through useRefundForm</p><button class="btn sm primary">Review diff</button></div></div>`)}
 ${phone('Account menu (sheet)', 'Stage', `<div style="padding:14px;color:var(--text-muted)">Stage content is dimmed behind the sheet.</div>`, `<div class="menu" style="top:auto;bottom:0;left:0;right:0;width:auto;border-radius:var(--r-lg) var(--r-lg) 0 0">${menuInner}</div>`)}
</div>`;

/* States: sign-in gate vs. push-credential gate (#331), and narrow */
const gitStates = `<div class="hh">Git changes: sign-in gate vs. push-credential gate<small>Two different reasons Push can be disabled, so the message always names the real one (principles.md #9, honest error states).</small></div>
<div class="sheet3">
 <div><h3>Read-only always works</h3>
  ${stateCard('&#128065;', 'Viewing and diffing, no session', 'Changes, diff and the changed-file tree read local git only and work on loopback without signing in &mdash; the same posture #283 already has for commit-on-save.')}</div>
 <div><h3>Hosted, not signed in</h3>
  ${stateCard('&#128274;', 'Sign in to push', 'This Cockpit requires a signed-in session (not loopback). Staging and committing locally still work; Push and Pull are disabled until you sign in with GitHub.', '<div><button class="btn primary sm">Sign in with GitHub</button></div>')}</div>
 <div><h3>Signed in, no push credential (#638)</h3>
  ${stateCard('&#128279;', 'Connect GitHub to push', 'Signed in, but this Cockpit instance has no GitHub App credential to push with yet. The button stays visible and named honestly rather than hidden.', '<button class="btn sm" disabled>Connect GitHub to push</button>')}</div>
</div>`;

const runProcs = () => `<table><tr><th>Process</th><th>Project</th><th>Status</th><th></th></tr>
 <tr><td><b>dev server &middot; storefront</b> <span class="tag det">Deterministic</span></td><td>storefront (inside the workspace)</td><td>running on :5173 &middot; 14 min</td><td><button class="btn sm">Restart</button> <button class="btn sm danger">Stop</button></td></tr></table>`;

/* Git narrow (390 px): Changes as one panel, own top-level mock so it is not clipped under other content (#331) */
const gitNarrow = `<div class="sheet3" style="grid-template-columns:390px;justify-content:start">${phone('Git &middot; Changes, as one panel', 'Changes', `${tabs([['Changes', ['11', 'acc']], ['Branches'], ['Commit']], 'Changes')}${sessionBanner()}<div class="scroll" style="max-height:600px"><details class="dt" open><summary>Staged <span class="c">4</span></summary>${cbRow('component', 'RefundForm.tsx', '+38 -2')}</details><details class="dt" open><summary>Not staged <span class="c">7</span></summary>${cbRow('page', 'refund/page.tsx', '+9 -1', false)}</details></div>`)}</div>`;

/* ================================================= POC parity (preview-first Pages / Components), quiet IDE feel */
// Density rule: at rest the tree shows at most ONE dot per row; badges, impact, tests, findings and Notes
// appear on the SELECTED row and in the right panel (collapsed sections). Overlays sit in one menu.
const nb = (k, t) => `<span class="nb ${k}">${t}</span>`;
const dot = (k, t) => `<span class="nd ${k}" title="${t}" aria-label="${t}"></span>`;
const trow = (lvl, layer, name, tail = '', o = {}) => `<div class="row l${lvl} ${o.sel ? 'sel' : ''}">${o.tw ? `<span class="twisty">${o.tw}</span>` : ''}${L(layer)}<span>${name}</span><span class="nbs">${tail}</span></div>`;
const etabs = (items) => `<div class="etabs" role="tablist">${items.map(([n, on, pin]) => `<button role="tab" class="${on ? 'on' : ''}" aria-selected="${!!on}">${pin ? '&#9679; ' : ''}${n}${pin ? '' : ' <span class="x">&times;</span>'}</button>`).join('')}</div>`;
const treeHead = (title, tabsArr, on) => `<div class="pane-h"><span class="title">${title}</span><span class="spacer"></span><button class="icon-btn" aria-label="New">+</button><button class="icon-btn" aria-label="Collapse">&laquo;</button></div>${tabs(tabsArr, on)}<div class="search">&#8981; Go to file, node or route <span class="spacer"></span><kbd>Ctrl P</kbd></div>`;
const pagesTree = (sel = 'LoginForm', extraPage = false) => `${treeHead('Pages', [['Tree'], ['Pages'], ['Flow']], 'Tree')}
  <div class="scroll"><div class="sect">${extraPage ? '/account/profile' : '/login'}</div><div class="tree">
   ${extraPage
     ? `${trow(0, 'page', 'ProfilePage', nb('git', 'new'), { tw: '&#9662;', sel: true })}${trow(1, 'component', 'AppNav')}${trow(1, 'component', 'Section', '', {})}`
     : `${trow(0, 'page', 'LoginPage', '', { tw: '&#9662;' })}
   ${trow(1, 'component', 'AppNav')}
   ${trow(1, 'component', 'LoginForm', sel === 'LoginForm' ? nb('imp', '3 feat') + nb('find', '2') + nb('test', '2') : dot('find', '2 findings'), { tw: '&#9662;', sel: sel === 'LoginForm' })}
   ${trow(2, 'component', 'EmailField', dot('git', 'edited'))}
   ${trow(2, 'component', 'PasswordField')}
   ${trow(2, 'component', 'SubmitButton')}
   ${trow(1, 'component', 'AuthFooter', dot('git', 'new'))}`}
  </div></div>`;
const loginDevice = ({ sel = true, pins = '', ghosts = '', h = 440, w = 640 }) => `
<div class="device" style="height:${h}px;width:${w}px">
  <div class="bar"><i></i><i></i><i></i>&nbsp;&nbsp;localhost:5173/login</div>
  <div class="app-nav"><b>Storefront</b><span>Catalog</span><span>Cart (2)</span><span>Sign in</span></div>
  <div class="login" id="lf"><h2>Welcome back</h2><p>Sign in to continue checkout.</p><label>Email</label><div class="in">sam@example.com</div><label>Password</label><div class="in">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</div><div class="cta">Sign in</div></div>
  ${sel ? `<div class="sel-box" style="left:calc(50% - 174px);top:98px;width:348px;height:322px"></div><div class="sel-tag" style="left:calc(50% - 174px);top:78px">LoginForm</div>` : ''}
  ${pins}${ghosts}
</div>`;
const profileDevice = `<div class="device" style="height:400px;width:640px"><div class="bar"><i></i><i></i><i></i>&nbsp;&nbsp;localhost:5173/account/profile</div><div class="app-nav"><b>Storefront</b><span>Catalog</span><span>Cart (2)</span></div><div style="padding:34px 40px;color:#667085"><h2 style="margin:0 0 6px;color:#1a1d24">Profile</h2><p>New page. Nothing here yet.</p></div><div class="sel-box" style="left:16px;top:112px;width:608px;height:150px"></div><div class="sel-tag" style="left:16px;top:92px">ProfilePage</div></div>`;
const devpill = `<span class="devpill"><span class="dot"></span>:5173 running</span>`;
const ovMenu = (n = 2) => `<button class="tg" aria-haspopup="true">Overlays &middot; ${n} on &#9662;</button>`;
const editorBar = (crumb, tabsHtml, right = '') => `${etabs(tabsHtml)}<div class="canvas-tb"><span class="crumbs">${crumb}</span>${devpill}<span class="spacer"></span>${right}<button class="tg" aria-pressed="true" title="Click an element without holding Alt">&#8853; Pick</button></div>`;
const foot = `<div class="canvas-foot"><span>Desktop 1280</span><span>Alt+Click opens source</span><span class="spacer"></span><span>Live: reloads when a file changes</span></div>`;

// The reusable inline action: GenerateChip. Mechanical is the default; AI is opt-in per action.
const gen = (o = {}) => {
  const ai = o.mode === 'ai'; const only = o.only; const dis = o.disabled;
  return `<span class="gen ${dis ? 'dis' : ''}" role="group" aria-label="${o.label || 'Generate'}">
   <span class="mode" role="radiogroup" aria-label="How">${only ? `<button role="radio" aria-checked="true" class="on ai" disabled>AI only</button>` : `<button role="radio" aria-checked="${!ai}" class="${!ai ? 'on det' : ''}" ${dis ? 'disabled' : ''}>Mechanical</button><button role="radio" aria-checked="${ai}" class="${ai ? 'on ai' : ''}" ${dis ? 'disabled' : ''}>AI</button>`}</span>
   <button class="go" ${dis ? 'disabled' : ''}>${o.running ? 'Cancel' : 'Generate'}</button></span>`;
};
const nextRow = (n, what, sub, chip, extra = '', flag = '') => `<div class="nx"><div class="nxh"><span class="no">${n}</span><div class="grow"><b>${what}</b><small>${sub}</small></div>${chip}</div>${flag ? `<div class="nxf">${flag}</div>` : ''}${extra}</div>`;

/* --- 1 Pages: preview first, quiet ------------------------------------------------- */
const inspectorQuiet = `
  <div class="section"><div class="el-head"><span class="name">LoginForm</span>${L('component')}<span class="spacer"></span><button class="icon-btn" aria-label="More">&#8943;</button></div><div class="path">features/auth/components/LoginForm.tsx:14</div></div>
  <details class="dt" open><summary>Props and bindings <span class="c">3</span></summary>
   <div class="prop"><span class="k">email</span><span class="field">email</span><span class="bind var">state</span></div>
   <div class="prop"><span class="k">onSubmit</span><span class="field">handleLogin</span><span class="bind var">handler</span></div>
   <div class="prop"><span class="k">disabled</span><span class="field">false</span><span class="bind lit">literal</span></div></details>
  <details class="dt"><summary>Impact <span class="c">3 features</span></summary></details>
  <details class="dt"><summary>Findings <span class="c warn">2</span></summary></details>
  <details class="dt"><summary>Tests <span class="c">2 pass</span></summary></details>
  <details class="dt"><summary>Notes <span class="c">1</span></summary></details>`;
const pagesMock = frame({ screen: 'Pages', lw: 300, rw: 360,
  left: pagesTree(),
  mid: editorBar('Pages &rsaquo; /login &rsaquo; <b>LoginForm</b>', [['Preview /login', true, true], ['LoginForm.tsx'], ['loginMachine.ts']], ovMenu(2)) +
    `<div class="stage" style="flex:1;padding:14px;place-items:start center">${loginDevice({ h: 500, pins: '<span class="pin find" style="left:calc(50% + 156px);top:88px" aria-label="2 findings">2</span>' })}<div class="ovcard" style="left:calc(50% - 174px);top:432px;flex-direction:row;align-items:center;width:348px"><b>LoginForm</b><span>Change touches 3 features</span><span style="display:flex;gap:6px"><button class="btn sm">Change...</button><button class="btn sm">Open source</button></span></div></div>` + foot,
  right: `<div class="pane-h"><span class="title">Inspect</span></div>${tabs([['Inspector'], ['Scope'], ['Source'], ['Change'], ['Diff']], 'Inspector')}<div class="scroll">${inspectorQuiet}</div>`,
  bot: bottom('Processes', runProcs(), 104, { p: '1', a: '0' }), botH: 104 });

/* --- 2 Pages: headline for Generate: a freshly created page ------------------------- */
const nextSteps = `
  <div class="section"><div class="el-head"><span class="name">ProfilePage</span>${L('page')}<span class="spacer"></span><button class="icon-btn" aria-label="More">&#8943;</button></div><div class="path">features/account/pages/ProfilePage.tsx (just created)</div></div>
  <div class="sect" style="padding-top:10px">Suggested next steps <span class="tag det" style="margin-left:6px">Mechanical by default</span></div>
  ${nextRow(1, 'Add the missing layer files', 'hook, service, domain stubs for account', gen({}), '<div class="nxl"><a>Preview diff</a> &middot; 3 files &middot; 0 model calls</div>')}
  ${nextRow(2, 'Fill their bodies', 'write real code into those stubs', gen({ mode: 'ai' }),
    `<div class="disc"><b>Before it runs</b> Sends 3 stub files and their layer rules (4.1 KB) to <b>qwen2.5-coder:7b</b> on this machine. <b>3 model calls</b>, one per file. Result arrives as a diff you approve file by file. <a>Change model</a></div>`)}
  ${nextRow(3, 'Auto-map props', 'wire 3 parent variables to child props', gen({}), '<div class="nxl"><a>Preview diff</a> &middot; 1 file</div>')}
  ${nextRow(4, 'Add test ids', 'data-testid from the flow events', gen({}), '', 'block exists; not offered as a command yet')}
  ${nextRow(5, 'Extract to component', 'select part of the page, name it', gen({ only: true }), '', 'no block yet: AI only (logged as a request for one)')}
  ${nextRow(6, 'Generate tests for this route', 'scenarios from the account flow', gen({}), '<div class="nxl"><a>Preview diff</a> &middot; 2 tests</div>')}`;
const nextMock = frame({ screen: 'Pages', lw: 250, rw: 480,
  left: pagesTree('', true),
  mid: editorBar('Pages &rsaquo; /account/profile &rsaquo; <b>ProfilePage</b>', [['Preview /account/profile', true, true], ['ProfilePage.tsx']], ovMenu(0)) +
    `<div class="stage" style="flex:1;padding:14px;place-items:start center">${profileDevice}</div>` + foot,
  right: `<div class="pane-h"><span class="title">Next</span></div>${tabs([['Next steps', ['6', 'acc']], ['Inspector'], ['Source'], ['Diff']], 'Next steps')}<div class="scroll">${nextSteps}</div>`,
  bot: bottom('Processes', runProcs(), 104, { p: '1', a: '0' }), botH: 104 });

/* --- 3 Pages: change a selection --------------------------------------------------- */
const changeMock = frame({ screen: 'Pages', lw: 300, rw: 400,
  left: pagesTree(),
  mid: editorBar('Pages &rsaquo; /login &rsaquo; <b>LoginForm</b>', [['Preview /login', true, true], ['LoginForm.tsx']], ovMenu(1)) +
    `<div class="stage" style="flex:1;padding:14px;place-items:start center">${loginDevice({ h: 500, ghosts: '<div class="ghost" style="left:12px;top:36px;width:616px;height:34px"></div><div class="ghost-tag" style="left:16px;top:38px;left:300px">will change: AppNav import</div>' })}<div class="ovcard" style="left:calc(50% - 174px);top:432px;width:348px;border-color:var(--warn)"><b>Preview of the change</b><span>Dashed boxes will change. Nothing is written until you approve.</span></div></div>` + foot,
  right: `<div class="pane-h"><span class="title">Change</span></div>${tabs([['Inspector'], ['Scope'], ['Source'], ['Change', ['4', 'acc']], ['Diff']], 'Change')}<div class="scroll">
   <div class="verbs">${['Move', 'Rename', 'Extract', 'Wrap in...', 'Delete'].map((v, i) => `<button class="tg" aria-pressed="${i === 0}">${v}</button>`).join('')}</div>
   <div class="ask"><b>Move</b> LoginForm to <span class="field" style="display:inline-flex;width:160px">features/account</span></div>
   ${nextRow(1, 'Move the file, rewrite 3 imports', 'construct refactor move', gen({}))}
   ${nextRow(2, 'Update the folder description', 'a sentence for the new folder', gen({ mode: 'ai' }))}
   <div class="sect" style="padding-top:10px">Approve per file &middot; 4 of 5</div>
   ${[['LoginForm.tsx', 'moved', 1], ['LoginPage.tsx', '+1 -1', 1], ['CheckoutPage.tsx', '+1 -1', 1], ['LoginForm.test.ts', '+1 -1', 1], ['README.md (AI)', '+3', 0]].map((a) => `<div class="art"><span class="cb ${a[2] ? 'on' : ''}">${a[2] ? '&#10003;' : ''}</span><span>${a[0]}</span><span style="color:var(--text-muted)">${a[1]}</span></div>`).join('')}
   <div style="padding:10px 12px"><button class="btn primary">Approve 4 of 5</button> <button class="btn">Discard</button></div></div>`,
  bot: bottom('Approvals', `<table><tr><th>Waiting for you</th><th>From</th><th></th></tr><tr><td><b>Move LoginForm to features/account</b> &middot; 5 files, 4 selected</td><td><span class="tag det">Mechanical</span> <span class="tag llm">Local model</span></td><td><button class="btn sm primary">Review diff</button></td></tr></table>`, 110, { p: '1', a: '1' }), botH: 110 });

/* --- 4 Components ------------------------------------------------------------------ */
const compMock = frame({ screen: 'Components', lw: 300, rw: 410,
  left: `${treeHead('Components', [['Components'], ['Workflows']], 'Components')}<div class="scroll"><div class="sect">auth</div><div class="tree">
   ${trow(1, 'component', 'LoginForm', nb('imp', '3 feat') + nb('find', '2') + nb('test', '2'), { sel: true })}${trow(1, 'component', 'PasswordField')}${trow(1, 'component', 'AuthFooter', dot('git', 'new'))}${trow(1, 'workflow', 'loginMachine')}</div><div class="sect">ui-kit</div><div class="tree">${trow(1, 'component', 'AmountField')}${trow(1, 'component', 'SubmitButton')}${trow(1, 'component', 'Modal')}</div></div>`,
  mid: editorBar('Components &rsaquo; auth &rsaquo; <b>LoginForm</b>', [['Preview LoginForm', true, true], ['LoginForm.tsx']], ovMenu(1)) +
    `<div class="canvas-tb" style="height:32px"><span style="color:var(--text-faint);font-size:11px">State</span><span class="seg" role="radiogroup" aria-label="State"><button class="on" role="radio" aria-checked="true">idle</button><button role="radio" aria-checked="false">submitting</button><button role="radio" aria-checked="false">error</button></span><span class="tag det">from loginMachine</span><span class="spacer"></span><button class="tg" aria-pressed="false">Mobile 390</button></div>
   <div class="stage" style="flex:1;place-items:start center;padding:16px"><div class="device" style="height:320px;width:480px"><div class="bar"><i></i><i></i><i></i>&nbsp;&nbsp;LoginForm, on its own</div><div class="login" style="margin:14px auto"><h2>Welcome back</h2><label>Email</label><div class="in">sam@example.com</div><label>Password</label><div class="in">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</div><div class="cta">Sign in</div></div></div>
   <div class="mach"><div class="mh">Flow &middot; loginMachine</div><div><span class="st2 cur">idle</span><span class="arr">SUBMIT &rarr;</span><span class="st2">submitting</span><span class="arr">FAIL &rarr;</span><span class="st2">error</span></div></div></div>` + `<div class="canvas-foot"><span>Same live app, this component only</span><span class="spacer"></span><span>Live</span></div>`,
  right: `<div class="pane-h"><span class="title">Inspect</span></div>${tabs([['Inspector'], ['Used by', ['2', '']], ['Source'], ['Change'], ['Diff']], 'Inspector')}<div class="scroll">
   <div class="section"><div class="el-head"><span class="name">LoginForm</span>${L('component')}<span class="spacer"></span><button class="icon-btn" aria-label="More">&#8943;</button></div><div class="path">features/auth/components/LoginForm.tsx:14</div></div>
   <details class="dt" open><summary>Props <span class="c">3</span></summary><div class="prop"><span class="k">email</span><span class="field">string</span><span class="bind lit">required</span></div><div class="prop"><span class="k">onSubmit</span><span class="field">() =&gt; void</span><span class="bind lit">required</span></div><div class="prop"><span class="k">disabled</span><span class="field">boolean</span><span class="bind lit">= false</span></div><div style="margin-top:6px"><button class="btn sm">+ Add prop</button></div></details>
   <details class="dt"><summary>Used by <span class="c">2 pages</span></summary></details><details class="dt"><summary>Tests <span class="c">2 pass</span></summary></details><details class="dt"><summary>Findings <span class="c warn">2</span></summary></details></div>`,
  bot: bottom('Processes', runProcs(), 110, { p: '1', a: '0' }), botH: 110 });

/* --- 5 Generate states ------------------------------------------------------------- */
const sc = (h, p, body) => `<div class="card"><b>${h}</b><p>${p}</p>${body}</div>`;
const genStates = `
<div class="hh">The inline Generate control: one contract, every place a step can be produced<small>Mechanical (a deterministic block, zero model calls) is the default and says so. AI is opt-in per action, and output only ever lands as a reviewable diff.</small></div>
<div class="sheet3">
 <div><h3>States</h3>
  ${sc('Idle, mechanical (default)', 'Add the missing layer files', `<div>${gen({})}</div><span class="tag det">Deterministic &middot; 0 model calls</span>`)}
  ${sc('AI chosen: says what it will send', 'Fill their bodies', `<div>${gen({ mode: 'ai' })}</div><div class="disc"><b>Before it runs</b> Sends 3 files (4.1 KB) to qwen2.5-coder:7b, on this machine. 3 model calls. Result is a diff you approve.</div>`)}
  ${sc('Running, with cancel', 'Fill their bodies', `<div>${gen({ mode: 'ai', running: true })}</div><span class="saveind busy"><span class="spin"></span> File 2 of 3 &middot; Process #15</span>`)}</div>
 <div><h3>Results and refusals</h3>
  ${sc('Result', 'A diff, never a silent write', `<div><span class="tag llm">Local model</span> 3 files ready</div><div><button class="btn sm primary">Review diff</button> <button class="btn sm">Discard</button></div><p>Lands in Approvals, approved per file.</p>`)}
  ${sc('Refused: model offline', 'AI is off, nothing ran', `<div>${gen({ mode: 'ai' })}</div><div class="callout warn" style="margin:0"><span>&#9888;</span><div class="grow"><b>Local model is offline</b><small>Nothing was sent.</small></div></div><div><button class="btn sm">Use Mechanical instead</button> <button class="btn sm">Open Local model</button></div>`)}
  ${sc('Disabled, with the reason', 'Extract to component', `<div>${gen({ disabled: true })}</div><span class="saveind">Select part of the page first</span>`)}</div>
 <div><h3>Rules of the contract</h3>
  ${sc('No block yet', 'Where no deterministic block exists', `<div>${gen({ only: true })}</div><span class="saveind">Flagged "no block yet": counted as a request for a mechanical block, never a silent model fallback.</span>`)}
  <div class="card"><b>Remembered</b><p>The Mechanical / AI choice is stored per user and per action kind (for example "fill a layer"), in the browser's local settings. It defaults to Mechanical when there is no choice, and to Mechanical again if the model is offline.</p></div>
  <div class="card"><b>Slot contract</b><p>Props in: action id, label, mechanical block (or none), AI allowed, what would be sent, target. Events out: run, cancel, choose-mode. Result is an artifact handed to Approvals; the chip never writes files.</p></div></div>
</div>`;

/* --- 6 Live preview states --------------------------------------------------------- */
const pst = (h, p, extra = '', c = '') => `<div class="card" ${c}><b>${h}</b><p>${p}</p>${extra}</div>`;
const previewStates = `
<div class="hh">The live preview needs the target app's dev server<small>Tree, impact, findings, Notes, plan, source and diff work from the files alone. Only the rendered canvas, click-to-source and live reload need the server.</small></div>
<div class="sheet3">
 <div><h3>Before it runs</h3>
  ${pst('Dev server not running', 'Start it to see /login. It runs inside your workspace, for this project only.', '<div><button class="btn primary sm">Start dev server</button> <button class="btn sm">Use a URL instead</button></div>')}
  ${pst('Starting', '<span class="saveind busy"><span class="spin"></span> npm run dev, Process #14</span> Watch it in the bottom panel. Usually 3 to 5 s.', '<div><button class="btn sm">Open in Processes</button></div>')}
  ${pst('Outside the workspace', 'This project is not inside the workspace root, so the Cockpit will not start a server for it.', '<div><button class="btn sm">Open a project in the workspace</button></div>', 'style="border-color:var(--danger)"')}</div>
 <div><h3>When it goes wrong</h3>
  ${pst('Server stopped', 'Port 5173 is in use by another process.', '<div><button class="btn primary sm">Use port 5174</button> <button class="btn sm">Show log</button></div>', 'style="border-color:var(--danger)"')}
  ${pst('Click-to-source is off', 'Your app does not load the Cockpit preview plugin. Tree, impact and source still work.', '<div><span class="mono" style="background:var(--surface-3);padding:2px 6px;border-radius:4px">plugins: [constructPreview(), react()]</span></div><div><button class="btn sm">Copy line</button></div>', 'style="border-color:var(--warn)"')}
  ${pst('App error in the preview', 'The app threw: Cannot read properties of undefined (reading email).', '<div><button class="btn sm">Show in source</button></div>', 'style="border-color:var(--danger)"')}</div>
 <div><h3>Running, and what needs it</h3>
  ${pst('Running', '<span class="saveind ok">&#10003; :5173 running &middot; live reload on</span>', '<div><button class="btn sm">Restart</button> <button class="btn sm danger">Stop</button></div>')}
  ${pst('Needs the server', 'Rendered canvas, Alt+Click and Pick, live reload, isolated component view, state switching.', '')}
  ${pst('Works without it', 'File tree, impact, findings, Notes, plan, diff, tests list, Generate.', '')}</div>
</div>`;

/* --- 7 Side preview on Tests ------------------------------------------------------- */
const sideMock = frame({ screen: 'Tests', lw: 300, rw: 340,
  left: `<div class="pane-h"><span class="title">Tests</span></div>${tabs([['Tests', ['6', 'acc']], ['Coverage']], 'Tests')}<div class="scroll"><div class="tree" style="padding-top:8px"><div class="row sel">${L('page')}login happy path<span class="meta">passed</span></div><div class="row">${L('page')}wrong password<span class="meta">passed</span></div><div class="row">${L('page')}guest checkout<span class="meta">failed</span></div></div></div>`,
  mid: `<div class="etabs"><button class="on" aria-selected="true">login happy path</button></div><div class="canvas-tb"><span class="crumbs">Tests &rsaquo; <b>login happy path</b></span><span class="spacer"></span><button class="tg" aria-pressed="true">Preview beside</button></div><div class="half"><div style="padding:14px;border-right:1px solid var(--border-subtle)"><div class="sect" style="padding-left:0">Step 2 of 4</div><div class="card"><b>Type the email</b><p>Fill "Email" with sam@example.com</p></div><div class="card"><b>Type the password</b><p>Fill "Password"</p></div></div><div class="stage" style="padding:12px;place-items:start center;background:var(--canvas)">${loginDevice({ h: 360, w: 350, sel: false })}</div></div>`,
  right: `<div class="pane-h"><span class="title">Inspect</span></div>${tabs([['Edit step'], ['Record'], ['Freshness']], 'Edit step')}<div class="scroll" style="padding:14px;color:var(--text-muted)">The preview beside the steps is the same live app. Pick an element there to fill a step's target.</div>`,
  bot: bottom('Processes', runProcs(), 110, { p: '1', a: '0' }), botH: 110 });

const pocOut = { 'ia-pages': pagesMock, 'ia-pages-next': nextMock, 'ia-pages-change': changeMock, 'ia-components': compMock, 'ia-generate-states': genStates, 'ia-preview-states': previewStates, 'ia-side-preview': sideMock };
const pocTitles = { 'ia-pages': 'Pages: live preview first, quiet until you select', 'ia-pages-next': 'Pages: a new page selected, with suggested next steps and the inline Generate control', 'ia-pages-change': 'Pages: change a selection with impact preview and per-file approval', 'ia-components': 'Components: one component on its own, with flow states', 'ia-generate-states': 'Inline Generate: Mechanical | AI, states and rules', 'ia-preview-states': 'Live preview: needs the dev server (states)', 'ia-side-preview': 'Tests: the live preview as a side view' };

/* ================================================= Story: feature-level story.md (link or paste) */
const acRow = (id, text, st) => `<div class="ac"><span class="acid">${id}</span><span class="grow">${text}</span>${st}</div>`;
const storyLeft = `${treeHead('Features', [['Notes', ['3', '']], ['Features']], 'Features')}
  <div class="scroll"><div class="tree" style="padding-top:8px">
   <div class="row"><span class="twisty">&#9656;</span>auth</div><div class="row"><span class="twisty">&#9656;</span>cart</div><div class="row"><span class="twisty">&#9656;</span>checkout</div>
   <div class="row"><span class="twisty">&#9662;</span>orders<span class="nbs">${nb('imp', 'story')}</span></div>
   <div class="row l1"><span class="twisty">&#9656;</span>pages &middot; components &middot; workflows</div>
   <div class="row l1 sel">&#9776; story.md<span class="nbs">${dot('find', '2 to review')}</span></div>
   <div class="row l1">&#9776; architecture notes</div></div></div>`;
const storyMid = editorBar('Features &rsaquo; orders &rsaquo; <b>story.md</b>', [['Story: orders', true, true], ['refundMachine.ts']], '') .replace(devpill, '').replace(/<button class="tg" aria-pressed="true" title="Click an element[^]*?<\/button>/, '') + `
  <div style="overflow:hidden;flex:1;padding:14px 18px;display:flex;flex-direction:column;gap:10px">
   <div class="fm"><div class="fmh">Front matter <span class="tag human">You own this</span> <span class="spacer"></span><span class="saveind">hand-editable, versioned, shareable</span></div><pre>---
sources:
  - url: https://acme.atlassian.net/browse/STORE-142
    parse: { title: { xpath: "//h1[@data-testid='issue.title']" }, description: 'div.description', acceptance: 'ul.acceptance &gt; li', status: 'span.status' }
---</pre></div>
   <div class="saveind"><span class="saveind ok">&#10003; Snapshot updated 12:02, saved automatically</span> <span class="via">via: your browser</span> &middot; <a>Refresh</a> &middot; <a>view diff</a></div>
   <div class="notebox" style="margin:0"><div class="t">Refund a delivered order <span class="spacer"></span><span class="st draft">Tool-owned block</span></div>
    <div class="b">As a customer I want to request a refund from the order page so that I do not need to contact support. Refunds are allowed within 30 days of delivery.</div>
    <div style="border-top:1px solid var(--border-subtle);padding:6px 0">
     ${acRow('S1', 'Refund button shows only on delivered orders', '<span class="nb test">matched</span>')}
     ${acRow('S2', 'Refund allowed within 30 days of delivery', '<span class="nb test">matched</span>')}
     ${acRow('S3', 'Partial refunds are allowed', '<span class="nb find">missing</span>')}
     ${acRow('S4', 'Customer confirms before the refund is sent', '<span class="nb test">matched</span>')}
     ${acRow('S5', 'An audit entry is written', '<span class="nb find">missing</span>')}</div>
    <div class="f"><span class="saveind">features/orders/story.md &middot; only the block between the markers is rewritten</span><span class="spacer"></span><label class="saveind"><span class="cb on" style="width:14px;height:14px;border:2px solid var(--accent);background:var(--accent);border-radius:3px;display:inline-block"></span> Keep out of git</label></div></div>
  </div>`;
const cmpList = (h, tag, items, extra = '') => `<details class="dt" open><summary>${h} <span class="c ${tag}">${items.length}</span></summary>${items.join('')}${extra}</details>`;
const cmpItem = (t, sub, chip = '') => `<div class="nx" style="padding:6px 0;border:0"><div class="nxh"><div class="grow"><b>${t}</b><small>${sub}</small></div>${chip}</div></div>`;
const storyRight = `<div class="pane-h"><span class="title">Compare</span><span class="spacer"></span><span class="tag det">Mechanical compare</span></div>${tabs([['Compare', ['2', '']], ['Sources'], ['History']], 'Compare')}<div class="scroll">
  <div class="callout warn" style="margin:10px 12px 0"><span>&#9888;</span><div class="grow"><b>Summary may be out of date</b><small>The generated summary changed since you last reviewed.</small></div><button class="btn sm">Mark reviewed</button></div>
  ${cmpList('Missing from the code', 'warn', [cmpItem('S3 Partial refunds are allowed', 'no scenario, route or test mentions it', gen({ label: 'Add scenario' })), cmpItem('S5 An audit entry is written', 'no test carries @story S5', gen({ label: 'Generate test' }))])}
  ${cmpList('In the code, not in the story', '', [cmpItem('state manualReview', 'refundMachine has it; no acceptance line does', '<button class="btn sm">Add to story</button>')])}
  ${cmpList('Matched', '', [cmpItem('S1, S2, S4', '3 lines matched to scenarios and tests (@story S1, S2, S4)', '')])}
  <div style="padding:10px 12px;color:var(--text-muted);font-size:12px">Compare is deterministic: ids and keywords against scenarios, routes, states and tests. Switch a row to AI for a fuzzier match; citations are checked mechanically before they are shown.</div></div>`;
const storyMock = frame({ screen: 'Features', lw: 280, rw: 400, left: storyLeft, mid: storyMid, right: storyRight, bot: bottom('Processes', runProcs(), 104, { p: '1', a: '0' }), botH: 104 });

const storyStates = `
<div class="hh">Story: link or paste, snapshot kept, never a login you did not give<small>The Cockpit fetches a public page's HTML and reads it; there is no Jira or GitHub API connection. Pages that need a login cannot be fetched, so paste the text instead.</small></div>
<div class="sheet3">
 <div><h3>Getting the ticket</h3>
  ${pst('Link a ticket', 'Paste a GitHub issue URL. It is fetched once, read, and saved as a snapshot you can review offline.', '<div><span class="field" style="display:inline-flex;width:100%">https://github.com/acme/storefront/issues/142</span></div><div><button class="btn primary sm">Fetch</button> <button class="btn sm">Paste text instead</button></div>')}
  ${pst('Fetching', '<span class="saveind busy"><span class="spin"></span> Fetching github.com, no login sent</span>', '<div><button class="btn sm">Cancel</button></div>')}
  ${pst('This page needs a login', 'Jira Cloud and private GitHub issues cannot be read without credentials or an API, and this version has neither. The link is saved as a reference.', '<div><button class="btn primary sm">Paste the text instead</button></div>', 'style="border-color:var(--warn)"')}</div>
 <div><h3>Refused, and why</h3>
  ${pst('Host not allowed', 'Only https pages on github.com are fetched. Add an Atlassian host in Settings if your team uses one.', '<div><button class="btn sm">Open Settings</button></div>', 'style="border-color:var(--danger)"')}
  ${pst('Blocked for safety', 'That address points at a private or local network. The Cockpit never fetches those.', '', 'style="border-color:var(--danger)"')}
  ${pst('Too big or too slow', 'The page is larger than 1 MB or took longer than 10 s. Nothing was saved.', '<div><button class="btn sm">Paste text instead</button></div>', 'style="border-color:var(--danger)"')}</div>
 <div><h3>Keeping it current and private</h3>
  ${pst('Refresh: ticket vs snapshot', 'The ticket changed since 12:02.', '<div class="code" style="border:1px solid var(--border-subtle);border-radius:var(--r-sm)"><div class="ln"><i>4</i><span>Refunds allowed within 30 days</span></div><div class="ln del"><i>5</i><span>- Partial refunds are not allowed</span></div><div class="ln add"><i>5</i><span>+ Partial refunds are allowed</span></div></div><div><button class="btn primary sm">Accept changes</button> <button class="btn sm">Keep my snapshot</button></div>')}
  ${pst('Private ticket, public repo', 'This ticket looks private and the repository is public. Committing the snapshot would publish it.', '<div><button class="btn primary sm">Keep out of git</button> <button class="btn sm">Commit anyway</button></div>', 'style="border-color:var(--warn)"')}
  ${pst('Kept out of git', 'Stored in your per-user state folder (with Notes), not in the project. It is not shared with teammates.', '')}</div>
</div>`;
Object.assign(pocOut, { 'ia-story': storyMock, 'ia-story-states': storyStates });
Object.assign(pocTitles, { 'ia-story': 'Features: a feature story linked to a ticket, compared with the code', 'ia-story-states': 'Story: fetch states, refusals, refresh and privacy' });

/* ================================================= Clipper: click-to-parse userscript for tickets behind a login */
const ol = (label, style, cls = '') => `<div class="olx ${cls}" style="${style}"><span class="oll">${label}</span></div>`;
const jiraPage = `
<div class="jp">
  <div class="jbar"><i></i><i></i><i></i>&nbsp;&nbsp;acme.atlassian.net/browse/STORE-142 <span style="margin-left:auto;color:#667085">(a page you are logged in to)</span></div>
  <div class="jnav"><b>Jira</b><span>Your work</span><span>Projects</span><span>Boards</span></div>
  <div class="jbody">
   <div class="jcrumb">Projects / Storefront / <span style="position:relative">STORE-142</span></div>
   <h2>Refund a delivered order</h2>
   <div class="jmeta"><span class="jstat">In Progress</span> <span>Assignee: Sam</span></div>
   <h4>Description</h4>
   <p>As a customer I want to request a refund from the order page so that I do not need to contact support.</p>
   <h4>Acceptance criteria</h4>
   <ul><li>Refund button shows only on delivered orders</li><li>Refund allowed within 30 days of delivery</li><li>Partial refunds are allowed</li><li>Customer confirms before the refund is sent</li><li>An audit entry is written</li></ul>
   <div class="jside">Details<br>Priority: High<br>Sprint: 14</div>
   ${ol('Key', 'left:154px;top:14px;width:80px;height:22px', 'done')}
   ${ol('Title', 'left:26px;top:42px;width:330px;height:34px', 'done')}
   ${ol('Status', 'left:26px;top:80px;width:98px;height:26px', 'done')}
   ${ol('Description', 'left:26px;top:150px;width:604px;height:48px', 'done')}
   ${ol('Acceptance criteria: click the list', 'left:26px;top:238px;width:420px;height:118px', 'cur')}
  </div>
</div>`;
const clipPanel = `
<div class="clp"><div class="clh"><b>Construct Clipper</b> <span class="tag det">Deterministic</span><span class="spacer"></span><span style="color:var(--text-muted);font-size:12px">userscript</span></div>
  <div class="clb">
   <div class="sect" style="padding:0 0 6px">Pick a field, then click it on the page</div>
   <div class="clf"><button class="tg" aria-pressed="false">&#10003; Key</button><button class="tg" aria-pressed="false">&#10003; Title</button><button class="tg" aria-pressed="false">&#10003; Status</button><button class="tg" aria-pressed="false">&#10003; Description</button><button class="tg" aria-pressed="true">Acceptance criteria</button></div>
   <div class="card" style="margin:10px 0 0"><b>Preview (plain text)</b>
     <div class="kv"><span>Key</span><span>STORE-142</span><span>Title</span><span>Refund a delivered order</span><span>Status</span><span>In Progress</span><span>Acceptance</span><span>5 lines found</span></div></div>
   <div class="card" style="margin:10px 0 0"><b>Selectors for features/orders/story.md</b><span class="mono" style="white-space:pre-wrap">title: { xpath: "//h1[@data-testid='issue.title']" }\ndescription: div.description\nacceptance: ul.acceptance &gt; li\nstatus: span.status</span><span class="saveind">Emitted the most stable form (data-testid or id first, no positions). Title matches 1 &middot; preview: Refund a delivered order. Acceptance matches 5 (a list).</span><p>Picking proposes these selectors as a diff in story.md (data, never code). Nothing is saved until you approve it in the Cockpit.</p><div><button class="btn primary sm">Send proposal to Cockpit</button> <button class="btn sm">Test on this page</button></div></div>
   <div class="sect" style="padding:12px 0 4px">Other stories that name this host &middot; 3</div>
   <div class="tpl"><span>orders: acme.atlassian.net/browse/STORE-142</span><span class="nb test">this page</span></div>
   <div class="tpl"><span>cart: acme.atlassian.net/browse/STORE-77</span></div>
   <div class="tpl"><span>checkout: acme.atlassian.net/browse/STORE-9</span><span class="nb find">selector did not match</span></div>
   <div style="padding-top:8px"><button class="btn sm">Copy selectors</button></div>
  </div></div>`;
const clipperMock = `<div class="clipwrap">${jiraPage}${clipPanel}</div>`;

const clipBridge = `
<div class="hh">One call, the right route: your own browser reads a login-only ticket when the Cockpit needs it<small>The screen calls StoryApi.fetch(url). Public pages are read by the server; login-only pages by the userscript in your browser. No cookie, password or token ever reaches the Cockpit server.</small></div>
<div class="sheet3">
 <div><h3>Strategy is picked per link</h3>
  ${pst('StoryApi.fetch(url)', 'One call from the screen; the strategy is chosen automatically and every screen looks the same either way, with a small "via" label.', '<div class="kv" style="grid-template-columns:110px 1fr"><span>Public page</span><span>server, guarded fetch <span class="nb test">default</span></span><span>Login-only</span><span>your browser, userscript <span class="nb test">recommended</span></span><span>Server browser</span><span>later, owner decision <span class="nb find">not for v1</span></span></div>')}
  ${pst('Login-only flow', 'Each time the story is needed: 1) the page asks the userscript (handshake code, the URL and the parse selectors read from story.md, same page only); 2) your browser reads the ticket with your own login and returns only the picked fields; 3) the Cockpit compares a fingerprint and, only if it changed, saves through its own signed-in call, as untrusted text.', '')}
  ${pst('Optional, later: server browser', 'A headless browser on the server with a stored login per host. Costs: the server would hold a live Jira or GitHub session at rest (a credential; if leaked it can read everything that login can); SSO and MFA cannot be completed headlessly, so it needs an interactive remote-login window; Chromium is heavy; remote page scripts would run on the server (sandbox and SSRF concerns); scraping terms may forbid it. Not recommended for v1. The strategy slot, a per-host opt-in and the indicator (via: server browser) are reserved.', '<div><span class="tag llm">owner decision</span></div>', 'style="border-color:var(--warn)"')}</div>
 <div><h3>Two approvals, both revocable</h3>
  ${pst('In the Cockpit: this story wants to read a page', 'A story.md can name any URL, including one that arrived in a cloned repository. The first use of each host and URL asks you.', '<div><button class="btn primary sm">Allow once</button> <button class="btn sm">Always for this host</button> <button class="btn sm danger">Deny</button></div>', 'style="border-color:var(--warn)"')}
  ${pst('In the userscript: allow this Cockpit', '<b>cockpit.example.org</b> wants to read tickets from <b>acme.atlassian.net</b> using your login in this browser. It only gets the fields the story.md selectors pick, never the whole page.', '<div><button class="btn primary sm">Allow this Cockpit</button> <button class="btn sm">Not now</button></div>', 'style="border-color:var(--accent)"')}
  ${pst('Approved hosts', 'acme.atlassian.net for cockpit.example.org &middot; approved 2026-09-20', '<div><button class="btn sm danger">Revoke</button></div>')}
  ${pst('Activity log (userscript menu)', '12:02 read STORE-142 (5 fields, 2.1 KB) &middot; 12:31 read STORE-142 &middot; 12:32 refused: host not approved (tracker.example.org)', '<div><span class="mono">10 reads per minute at most</span></div>')}</div>
 <div><h3>Limits and what bounds the risk</h3>
  ${pst('Threat: a script injected into the Cockpit page', 'It could ask the userscript for tickets. That is bounded: only hosts you approved for this Cockpit origin, only URLs a story.md names and you consented to, only the picked fields returned, selectors validated as data, rate-limited, and every read is in the activity log.', '')}
  ${pst('Needs, honestly', 'A userscript manager (Tampermonkey or Violentmonkey) and the Cockpit tab open. Without them the last snapshot is used, and the indicator says so. Public GitHub issues need no clipper.', '')}
  ${pst('Last resort', 'Manual paste stays available when nothing else works.', '<div><button class="btn sm">Paste text instead</button></div>')}</div>
</div>`;

const ind = (cls, text, title) => `<span class="sind ${cls}" title="${title}"><span class="dt2"></span>${text}</span>`;
const via = (t) => `<span class="via">via: ${t}</span>`;
const indRow = (name, chip, note) => `<div class="irow"><span class="in">${name}</span><span>${chip}</span><span class="inote">${note}</span></div>`;
const storyIndicators = `
<div class="hh">Story indicators: one quiet mark on the feature, the same for every strategy<small>Shown on the feature row and the Story tab header. Text plus a dot, never colour alone, plus a small "via" label. Checked every time the story is needed (single-flight, debounced; never per keystroke or per render).</small></div>
<div style="padding:14px 24px;display:grid;gap:6px;max-width:1240px">
 ${indRow('In sync', ind('ok', '3/5 matched', 'Acceptance 3 of 5 matched') + via('your browser'), 'Fingerprint equals the saved sourceHash, so nothing was rewritten.')}
 ${indRow('Ticket changed upstream', ind('warn', 'ticket changed, snapshot updated', 'story.md snapshot was rewritten') + '<a>view diff</a>' + via('server'), 'The tool block was rewritten and shows up as a normal commit and diff. Your own text was not touched.')}
 ${indRow('Story stale vs code', ind('warn', 'may be out of date', 'The generated summary changed since it was reviewed') + '<a>mark reviewed</a>', 'The code moved since you last reviewed.')}
 ${indRow('Checking', ind('busy', 'checking ticket', 'One check at a time') + via('your browser'), 'Single request, short debounce. The last snapshot stays visible.')}
 ${indRow('Offline or clipper off', ind('off', 'using snapshot from 12:02', 'No userscript answered') + '<a>Install clipper</a>', 'Says so instead of pretending. Falls back to the saved snapshot. Paste text is the last resort.')}
 ${indRow('Host not approved', ind('warn', 'approve host', 'Allow this Cockpit to read tickets from acme.atlassian.net'), 'One-time approval in the userscript; nothing is read before it.')}
 ${indRow('Template did not match', ind('bad', 're-pick', 'The site changed its layout'), 'Open the ticket and click the field again. The last snapshot stays.')}
 ${indRow('Snapshot edited by hand', ind('warn', 'snapshot edited, refresh paused', 'The tool-owned block differs from its fingerprint') + '<a>keep mine</a> <a>use the ticket</a>', 'Conflict rule: hand edits inside the tool block are never overwritten silently.')}
 ${indRow('No story yet', '<a>Add a story</a>', 'The only trace. Indicator, compare, @story coverage and Generate-from-story do not exist until a story.md does. Adding it shows as a normal diff.')}
 ${indRow('Direct content (no link)', ind('ok', 'story vs code: 3/5', 'Compared with the code only') + via('written here'), 'Nothing is fetched, so there is no upstream or freshness check; only story against code.')}
 ${indRow('Login-only, no pattern yet', ind('warn', 'pick fields', 'No selectors yet') + '<a>Pick fields</a> <a>AI proposes a pattern</a>', 'Login-only pages are always read with an explicit pattern, fields only. Nothing is read until there is one.')}
 ${indRow('AI unavailable', ind('off', 'using snapshot from 12:02', 'The configured model did not answer'), 'Nothing invented: the saved snapshot is used and the model state is named.')}
 ${indRow('Server browser (later)', ind('ok', '3/5 matched', 'Acceptance 3 of 5 matched') + via('server browser'), 'Only if the owner enables it per host. Same states, same indicator.')}
</div>`;
Object.assign(pocOut, { 'ia-clip-bridge': clipBridge, 'ia-story-indicators': storyIndicators });
Object.assign(pocTitles, { 'ia-clip-bridge': 'One call, the right route: server, your browser (userscript), later a server browser', 'ia-story-indicators': 'Story indicators on the feature: states' });
Object.assign(pocOut, { 'ia-clipper': clipperMock });
Object.assign(pocTitles, { 'ia-clipper': 'Clipper: click to pick ticket fields; the selectors are written into story.md as a diff' });

const storyConsent = `
<div class="hh">Consent: a story file is not a permission<small>A story.md that arrives in a cloned or foreign repository can name any URL. Nothing is read from your browser until you say so, per host and per URL.</small></div>
<div class="sheet3">
 <div><h3>First use of a host and URL</h3>
  ${pst('This story wants to read a page', '<b>features/orders/story.md</b> wants to read <span class="mono">https://acme.atlassian.net/browse/STORE-142</span> from <b>acme.atlassian.net</b> using your browser login. Only the fields it names (title, description, acceptance, status) will come back.', '<div><button class="btn primary sm">Allow once</button> <button class="btn sm">Always for this host</button> <button class="btn sm danger">Deny</button></div>', 'style="border-color:var(--accent)"')}
  ${pst('Came from a cloned repository', 'This story.md was not written here (it arrived with the clone of acme/storefront). Review the URL and the selectors before you allow anything.', '<div><button class="btn sm">Show story.md front matter</button></div>', 'style="border-color:var(--warn)"')}</div>
 <div><h3>Selectors are data, and are checked</h3>
  ${pst('Rejected selector', '<span class="mono">acceptance: javascript:alert(1)</span> is not a valid selector, so the story was not read. Selectors are limited to 200 characters and to plain query-selector syntax.', '<div><button class="btn sm">Edit story.md</button></div>', 'style="border-color:var(--danger)"')}
  ${pst('Rejected XPath', '<span class=\"mono\">//*[document(\'http://x\')]</span> is not allowed: only plain node-set paths are evaluated, no functions that reach outside the page.', '', 'style=\"border-color:var(--danger)\"')}
  ${pst('Denied', 'Reading acme.atlassian.net is denied for this story. The last snapshot is used.', '<div><button class="btn sm">Change</button></div>')}</div>
 <div><h3>Nothing leaves without you</h3>
  ${pst('Fetched snapshot is never pushed', 'A refreshed snapshot is saved to the file and shows as an ordinary diff or commit on this machine. It is never pushed automatically.', '')}
  ${pst('Approved (host, URL) pairs', 'acme.atlassian.net &middot; always &middot; 2026-09-20<br>acme.atlassian.net/browse/STORE-9 &middot; once (expired)', '<div><button class="btn sm danger">Revoke all</button></div>')}</div>
</div>`;
Object.assign(pocOut, { 'ia-story-consent': storyConsent });
Object.assign(pocTitles, { 'ia-story-consent': 'Story consent: a story file names a URL, you decide whether it is read' });

const fmBlock = (t) => `<pre class="mono" style="margin:0;background:var(--surface-3);padding:6px 8px;border-radius:4px;white-space:pre-wrap">${t}</pre>`;
const storyModes = `
<div class="hh">Three ways a story.md can be filled, all valid<small>A story only does anything when a story.md exists for the feature. Without one there is a single quiet "Add a story" action.</small></div>
<div class="sheet3">
 <div><h3>Modes</h3>
  ${pst('a. Link + parse pattern (mechanical)', 'Fetch and read with selectors you wrote or picked. Zero model calls, checked on every use.', fmBlock('sources:\n  - url: https://acme.atlassian.net/browse/STORE-142\n    parse: { title: h1.title, acceptance: ul.ac > li }') + '<div><span class="tag det">Deterministic</span></div>')}
  ${pst('b. Direct content', 'You write or paste the story. No link, nothing fetched, no freshness check; the indicator compares only story vs code.', fmBlock('# Refund a delivered order\n## Acceptance\n- S1 Refund button only on delivered orders'))}
  ${pst('c. Link without a pattern (public pages only)', 'Only for pages the server can fetch itself (public, guarded). The page text is fetched and your configured AI (local model by default) extracts the fields. Safer route below.', fmBlock('sources:\n  - url: https://acme.atlassian.net/browse/STORE-142') + '<div><span class="tag llm">Local model</span></div>')}</div>
 <div><h3>Preferred: AI proposes the pattern once</h3>
  ${pst('Propose selectors', 'The model looks at a stripped copy of the page once and suggests selectors. You review them as a diff in the front matter. After that every refresh is mechanical, with zero model calls.', '<div>' + gen({ mode: 'ai', label: 'Propose selectors' }) + '</div><div class="disc" style="margin-left:0"><b>Before it runs</b> Sends the page text only (scripts, styles and attributes stripped, at most 64 KB, about 5 KB here) to qwen2.5-coder:7b. <b>1 model call.</b> Result is a diff to story.md.</div>')}
  ${pst('Result: a diff you approve', 'parse: { title: h1.title, description: div.desc, acceptance: ul.ac &gt; li }', '<div><button class="btn primary sm">Approve diff</button> <button class="btn sm">Discard</button></div>')}</div>
 <div><h3>If AI extracts every time (opt-in)</h3>
  ${pst('What is sent, and verified', 'Each use sends the sanitised page text (size cap, count of model calls shown) and needs the AI toggle and consent. Then a mechanical check: every extracted field must be quoted text found in the fetched page text. Anything not found is rejected or flagged, so extraction cannot invent content. The result is a reviewable diff to the tool-owned block.', '<div><span class="tag det">Verified mechanically</span></div>')}
  ${pst('Login-only pages: always a pattern', 'A login-only page is never read as a whole and the AI never sees it. Use <b>Pick fields</b> (click to pick), or <b>AI proposes a pattern</b> from a structure-only skeleton: the tag, id, class and data-testid tree with text cut to 40 characters, no attribute values, links, form values or scripts, at most 32 KB. You see the exact skeleton before it is sent. Preferred over sending candidate text, which contains real ticket text.', '<div><button class=\"btn sm\">Pick fields</button> <button class=\"btn sm\">Show the skeleton that would be sent</button></div>', 'style=\"border-color:var(--warn)\"')}
</div>`;
Object.assign(pocOut, { 'ia-story-modes': storyModes });
Object.assign(pocTitles, { 'ia-story-modes': 'Story: three modes, and AI proposes the pattern once' });

/* ================================================= Features: a feature as a hierarchy (routes nested under it, then layers) */
const miss = (layer) => `<div class="row l2 muted" style="opacity:.85"><span class="layer" style="border:1px dashed var(--border-strong);background:transparent">${layer}</span><span>missing</span><span class="nbs"><a>Add</a></span></div>`;
const ftLeft = `${treeHead('Features', [['Notes', ['3', '']], ['Features']], 'Features')}
  <div class="scroll"><div class="sect" style="display:flex;justify-content:space-between"><span>construct/ &middot; 4 features</span><span class="nb">root</span></div><div class="tree">
   <div class="row"><span class="twisty">&#9656;</span>auth</div>
   <div class="row"><span class="twisty">&#9662;</span><b>refunds</b><span class="nbs">${dot('find', '1 violation')}</span></div>
   <div class="row l1 sel"><span class="twisty">&#9662;</span>Routes<span class="meta">1</span></div>
   <div class="row l2"><span class="layer route" style="background:var(--surface-3)">route</span>/orders/[id]/refund<span class="meta">Next app router</span></div>
   <div class="row l1"><span class="twisty">&#9662;</span>Layers<span class="meta">6 of 7</span></div>
   <div class="row l2"><span class="twisty">&#9656;</span>${L('page')}page<span class="meta">1 file</span></div>
   <div class="row l2"><span class="twisty">&#9656;</span>${L('component')}component<span class="meta">4 files</span></div>
   <div class="row l2"><span class="twisty">&#9656;</span><span class="layer">hook</span>hook<span class="meta">1 file</span></div>
   <div class="row l2"><span class="twisty">&#9662;</span>${L('workflow')}workflow<span class="meta">1 file ${dot('find', '1 violation')}</span></div>
   <div class="row l3" style="padding-left:78px">refundMachine.ts</div>
   <div class="row l2"><span class="twisty">&#9656;</span><span class="layer">service</span>service<span class="meta">2 files</span></div>
   <div class="row l2"><span class="twisty">&#9656;</span><span class="layer">domain</span>domain<span class="meta">2 files</span></div>
   ${miss('controller')}
   <div class="row"><span class="twisty">&#9656;</span>cart</div><div class="row"><span class="twisty">&#9656;</span>ui-kit</div>
   <div class="sect" style="margin-top:8px">Legacy, outside construct/</div>
   <div class="row muted"><span class="twisty">&#9656;</span>src/<span class="meta">38 files, not managed</span></div>
  </div></div>`;
const fnode = (l, t, sub, o = '') => `<div class="fnode ${o}"><div class="fnh">${L(l)}<b>${t}</b></div><div class="fns">${sub}</div></div>`;
const farr = (t = '&darr;') => `<div class="farr">${t}</div>`;
const ftMid = editorBar('Features &rsaquo; construct &rsaquo; <b>refunds</b>', [['refunds', true, true], ['story.md']], '<span class="seg" role="radiogroup" aria-label="View"><button role="radio" aria-checked="false">Tree</button><button class="on" role="radio" aria-checked="true">Flow</button></span>').replace(devpill, '').replace(/<button class="tg" aria-pressed="true" title="Click an element[^]*?<\/button>/, '') + `
  <div class="stage" style="flex:1;padding:18px;place-items:start center;overflow:hidden"><div class="fflow">
   <div class="farr" style="margin:0">Arrows point the way imports go</div>
   <div class="frow">${fnode('route', '/orders/[id]/refund', 'Next app router', '')}</div>${farr()}
   <div class="frow">${fnode('page', 'RefundPage', '1 file')}</div>${farr()}
   <div class="frow">${fnode('component', 'RefundForm, AmountField', '4 files')}${fnode('hook', 'useRefundForm', '1 file')}<div class="fnode miss"><div class="fnh"><span class="layer" style="border:1px dashed var(--border-strong);background:transparent">controller</span><b>missing</b></div><div class="fns">pages usually go through one</div></div></div>${farr()}
   <div class="frow">${fnode('workflow', 'refundMachine', '1 file &middot; 1 violation', 'warn')}${fnode('service', 'refundService', '2 files')}</div>${farr()}
   <div class="frow">${fnode('domain', 'refundRules', '2 files')}</div>
  </div></div>`;
const ftRight = `<div class="pane-h"><span class="title">Inspect</span></div>${tabs([['Summary'], ['Impact'], ['Story'], ['Plan']], 'Summary')}<div class="scroll">
  <div class="section"><div class="el-head"><span class="name">refunds</span><span class="layer">feature</span><span class="spacer"></span><button class="icon-btn">&#8943;</button></div><div class="path">construct/refunds</div></div>
  <details class="dt" open><summary>What it is <span class="c">Deterministic</span></summary><div>Lets a customer request a refund from a delivered order. One route reaches it. Six of the seven parts exist.</div></details>
  <details class="dt" open><summary>Routes <span class="c">1</span></summary><div class="mono">/orders/[id]/refund <span style="color:var(--text-muted)">Next app router</span></div></details>
  <details class="dt" open><summary>Layers <span class="c">6 of 7</span></summary><div>Missing: controller <a>Add the missing layer files</a></div></details>
  <details class="dt"><summary>Violations <span class="c warn">1</span></summary></details>
  <details class="dt"><summary>Another feature: ui-kit <span class="c">no route</span></summary><div class="callout info" style="margin:6px 0"><span>i</span><div class="grow"><b>Not mapped to a route yet</b><small>That is fine for a shared kit, or a feature you imported first. <a>Map to a route</a></small></div></div></details></div>`;
const featureTree = frame({ screen: 'Features', lw: 340, rw: 380, left: ftLeft, mid: ftMid, right: ftRight, bot: bottom('Processes', runProcs(), 104, { p: '1', a: '0' }), botH: 104 });
Object.assign(pocOut, { 'ia-feature-structure': featureTree });
Object.assign(pocTitles, { 'ia-feature-structure': 'Features: a feature as a hierarchy, routes nested under it, then layers, drawn from the import graph' });

/* ================================================= Block palette: Providers / Expressions / Components (#518, part of #500 phase 3) */
// Grounded in the real canImport graph (packages/core/config.mjs DEFAULT_LAYERS) and the typed-contracts
// factories (packages/core/typed-contracts/{provider,units,factories}.ts), not invented categories:
// a page's own canImport is ['component', 'types'], and architecture-enforcer.mjs's per-layer checks
// (PAGE-002/003/005/006) additionally allow exactly two hook-layer exceptions by naming convention --
// a Provider hook (use<Name>Provider, built via defineProvider) and a tracked-state hook (use<Name>State).
// So the palette's three groups are: Providers (hook-layer, shown with the plain grey layer chip already
// used for hook/service/domain elsewhere in these mocks -- a Provider is NOT its own branded LayerName,
// only a naming convention over `hook`), Expressions (the real, newly-branded `expression` layer, its own
// warn/amber chip), and Components (component-layer, existing chip). Workflows/services/domain are never
// listed, even collapsed -- the boundary is explained in one plain-language line instead ("never show
// something the architecture wouldn't allow").
const palLayer = (k, t) => `<span class="layer${k ? ' ' + k : ''}">${t || k}</span>`;
const palItem = (chip, name, path, desc, action, cls = '') =>`<div class="pal-item ${cls}"><div class="grow"><div class="pal-name">${chip}<b>${name}</b></div><span class="path">${path}</span><p>${desc}</p></div>${action || ''}</div>`;
const palGroup = (title, count, itemsHtml, open = true) => `<details class="dt" ${open ? 'open' : ''}><summary>${title} <span class="c">${count}</span></summary>${itemsHtml}</details>`;
const palBoundary = `<p style="margin:10px 12px;padding:8px 10px;border:1px solid var(--border-subtle);border-radius:var(--r-md);background:var(--surface-1);color:var(--text-muted);font-size:12px;line-height:1.5"><b style="color:var(--text)">Not shown here:</b> workflows, services and domain logic. A page composes components, expressions and providers only &mdash; it can't reach a workflow, service or domain unit directly (rules PAGE-002/003/005). Ask a controller to wire one of those in instead.</p>`;

// The shared "cart" scenario for this initiative: CartSummaryPage, feature `cart`.
const cartTree = (o = {}) => `${treeHead('Pages', [['Tree'], ['Pages'], ['Flow']], 'Tree')}
  <div class="scroll"><div class="sect">/cart</div><div class="tree">
   ${trow(0, 'page', 'CartSummaryPage', o.pageFlag ? dot('find', '1 finding: inline .map() (PAGE-008)') : '', { tw: '&#9662;', sel: !!o.pageSel })}
   ${trow(1, 'component', 'AppNav')}
   ${trow(1, 'component', 'PromoCodeField')}
   ${trow(1, 'component', 'CheckoutCta')}</div></div>`;
const cartBox = (o = {}) => `
<div class="cartbox">
  <h2>Your cart</h2>
  <div class="cartline">Canvas tote bag &times; 1<span>$38.00</span></div>
  <div class="cartline">Ceramic mug &times; 2<span>$24.00</span></div>
  <div class="cartline">Wool scarf &times; 1<span>$42.00</span></div>
  <div class="cartin">Promo code</div>
  <div class="cartcta">Checkout &middot; $104.00</div>
</div>`;
const cartDevice = (o = {}) => `<div class="device" style="height:440px;width:640px">
  <div class="bar"><i></i><i></i><i></i>&nbsp;&nbsp;localhost:5173/cart</div>
  <div class="app-nav"><b>Storefront</b><span>Catalog</span><span>Cart (3)</span></div>
  ${cartBox()}
  ${o.sel ? `<div class="sel-box" style="left:20px;top:78px;width:596px;height:96px"></div><div class="sel-tag" style="left:20px;top:58px">3 elements &middot; inline .map() over cartItems</div>` : ''}
</div>`;

// Slice 1 (MVP first slice, read-only browse, no selection): what the feature can use, no actions yet.
const palReadOnly = `
  ${palGroup('Providers this feature can use', 2, `
    ${palItem(palLayer('', 'provider'), 'CartProvider', 'features/cart/hooks/useCartProvider.ts', 'Shares { total, itemCount } from the cart service across this page’s tree via React Context (defineProvider) &mdash; no prop drilling.', '')}
    ${palItem(palLayer('', 'provider'), 'AuthProvider', 'features/auth &middot; via its public index', 'Shares the signed-in customer. Imported from another feature’s public API (SLICE-002), wired the same way regardless of which feature defined it.', '')}
  `)}
  ${palGroup('Expressions this feature can wrap with', 1, `
    ${palItem(palLayer('expression'), 'ShowForRole', 'features/cart/expressions/ShowForRole.tsx', 'Renders children only for a matching signed-in role. Wraps today’s member-discount banner. Pure, accepts children, returns JSX (EXPR-001/005).', '')}
  `)}
  ${palGroup('Components this feature can compose', 3, `
    ${palItem(palLayer('component'), 'AmountField', 'features/ui-kit &middot; via its public index', 'Formats a currency amount. Used by 5 features.', '')}
    ${palItem(palLayer('component'), 'PromoCodeField', 'features/cart/components', 'A labelled text field with an Apply button.', '')}
    ${palItem(palLayer('component'), 'CheckoutCta', 'features/cart/components', 'Primary button; routes to /checkout.', '')}
  `)}
  ${palBoundary}`;
const paletteMock = frame({ screen: 'Pages', lw: 280, rw: 420,
  left: cartTree({}),
  mid: editorBar('Pages &rsaquo; /cart &rsaquo; <b>CartSummaryPage</b>', [['Preview /cart', true, true], ['CartSummaryPage.tsx']], ovMenu(0)) +
    `<div class="stage" style="flex:1;padding:14px;place-items:start center">${cartDevice({})}</div>` + foot,
  right: `<div class="pane-h"><span class="title">Palette</span></div>${tabs([['Inspector'], ['Scope'], ['Source'], ['Palette'], ['Diff']], 'Palette')}<div class="scroll">${palReadOnly}</div>`,
  bot: bottom('Processes', runProcs(), 104, { p: '1', a: '0' }), botH: 104 });

// Slice 3 (interactive, needs #517): a JSX selection made, palette suggests a new Expression to wrap it with.
const palSuggest = `
  <div class="callout info"><span>&#8981;</span><div class="grow"><b>Selection: 3 elements from a .map() over cartItems</b><small>CartSummaryPage.tsx:18-24 &middot; flagged PAGE-008 (inline loop rendering, not presentation)</small></div></div>
  ${palGroup('Expressions this feature can wrap with', 2, `
    ${palItem(palLayer('expression'), '+ New Expression', '', 'No existing Expression fits a loop. Name derived from the mapped array’s element (editable) &mdash; per #517’s naming rule, never a placeholder.', `<div class="grow" style="flex:none;display:flex;flex-direction:column;gap:6px;align-items:flex-end"><span class="field" style="width:170px">ForEachCartLine</span><button class="btn sm primary">Wrap with...</button></div>`, 'suggest')}
    ${palItem(palLayer('expression'), 'ShowForRole', 'features/cart/expressions/ShowForRole.tsx', 'Wraps a single child behind a role check &mdash; not a fit for a loop over an array.', '<span class="tag" style="background:var(--surface-3);color:var(--text-muted)">Not a fit</span>', 'unfit')}
  `)}
  ${palGroup('Providers this feature can use', 2, `
    ${palItem(palLayer('', 'provider'), 'CartProvider', 'features/cart/hooks/useCartProvider.ts', 'Shares { total, itemCount } across this page’s tree.', '')}
    ${palItem(palLayer('', 'provider'), 'AuthProvider', 'features/auth &middot; via its public index', 'Shares the signed-in customer.', '')}
  `, false)}
  ${palGroup('Components this feature can compose', 3, `
    ${palItem(palLayer('component'), 'AmountField', 'features/ui-kit &middot; via its public index', 'Formats a currency amount.', '')}
    ${palItem(palLayer('component'), 'PromoCodeField', 'features/cart/components', 'A labelled text field with an Apply button.', '')}
    ${palItem(palLayer('component'), 'CheckoutCta', 'features/cart/components', 'Primary button; routes to /checkout.', '')}
  `, false)}
  ${palBoundary}`;
const paletteSuggestMock = frame({ screen: 'Pages', lw: 280, rw: 440,
  left: cartTree({ pageSel: true, pageFlag: true }),
  mid: editorBar('Pages &rsaquo; /cart &rsaquo; <b>CartSummaryPage</b>', [['Preview /cart', true, true], ['CartSummaryPage.tsx']], ovMenu(1)) +
    `<div class="stage" style="flex:1;padding:14px;place-items:start center">${cartDevice({ sel: true })}</div>` + foot,
  right: `<div class="pane-h"><span class="title">Palette</span></div>${tabs([['Inspector'], ['Scope'], ['Source'], ['Palette', ['1', 'acc']], ['Diff']], 'Palette')}<div class="scroll">${palSuggest}</div>`,
  bot: bottom('Processes', runProcs(), 104, { p: '1', a: '0' }), botH: 104 });

// Confirm step, once #517's mechanical extraction block exists: an ask card + steps + per-file approval,
// the exact same idiom as ia-pages-change's Change tab (Move/Rename/Extract/Wrap in.../Delete) -- "Wrap
// with..." is that same verb, triggered from the palette instead of typed from a blank Change form.
const palConfirm = `
  <div class="ask"><b>Wrap with</b> a new Expression named <span class="field" style="display:inline-flex;width:170px">ForEachCartLine</span></div>
  ${nextRow(1, 'Create ForEachCartLine.tsx', 'features/cart/expressions &middot; defineExpression(...) &mdash; satisfies EXPR-005/006', gen({}), '<div class="nxl"><a>Preview diff</a> &middot; 1 file &middot; 0 model calls</div>')}
  ${nextRow(2, 'Rewrite CartSummaryPage.tsx', 'replace the inline .map() with &lt;ForEachCartLine&gt;', gen({}), '<div class="nxl"><a>Preview diff</a> &middot; 1 file</div>')}
  <div class="sect" style="padding-top:10px">Approve per file &middot; 2 of 2</div>
  ${[['ForEachCartLine.tsx (new)', '+18', 1], ['CartSummaryPage.tsx', '+2 -7', 1]].map((a) => `<div class="art"><span class="cb ${a[2] ? 'on' : ''}">${a[2] ? '&#10003;' : ''}</span><span>${a[0]}</span><span style="color:var(--text-muted)">${a[1]}</span></div>`).join('')}
  <div style="padding:10px 12px"><button class="btn primary">Approve 2 of 2</button> <button class="btn">Discard</button></div>`;
const paletteConfirmMock = frame({ screen: 'Pages', lw: 280, rw: 420,
  left: cartTree({ pageSel: true, pageFlag: true }),
  mid: editorBar('Pages &rsaquo; /cart &rsaquo; <b>CartSummaryPage</b>', [['Preview /cart', true, true], ['CartSummaryPage.tsx']], ovMenu(1)) +
    `<div class="stage" style="flex:1;padding:14px;place-items:start center">${cartDevice({ sel: true })}<div class="ovcard" style="left:20px;top:410px;width:596px;border-color:var(--accent)"><b>Wrap with ForEachCartLine</b><span>Nothing is written until you approve &mdash; construct refactor extract-expression under the hood.</span></div></div>` + foot,
  right: `<div class="pane-h"><span class="title">Palette</span></div>${tabs([['Inspector'], ['Scope'], ['Source'], ['Palette', ['1', 'acc']], ['Diff']], 'Palette')}<div class="scroll">${palConfirm}</div>`,
  bot: bottom('Approvals', `<table><tr><th>Waiting for you</th><th>From</th><th></th></tr><tr><td><b>Wrap CartSummaryPage’s cart lines with ForEachCartLine</b> &middot; 2 files, 2 selected</td><td><span class="tag det">Mechanical</span></td><td><button class="btn sm primary">Review diff</button></td></tr></table>`, 110, { p: '0', a: '1' }), botH: 110 });

/* Palette states: empty / loading / error / no selection / no block yet (before #517 ships) / narrow */
const palStates = `
<div class="hh">The palette: read what a feature can use, wrap what it can’t reach directly<small>Grouped by the real canImport graph (packages/core/config.mjs) and the typed-contracts factories &mdash; nothing shown here is a rule the architecture would actually refuse.</small></div>
<div class="sheet3">
 <div><h3>Before there is anything to show</h3>
  ${sc('Empty: no Expressions yet', 'This feature has none', `<p>You can still compose Components and Providers below. Expressions appear here once you extract or create one &mdash; try "Wrap with..." on a selection.</p>`)}
  ${sc('Loading', 'Computing what this feature can use', `<span class="saveind busy"><span class="spin"></span> Reading the import graph for this feature…</span>`)}
  ${sc('Error', 'Couldn’t compute the palette', `<div class="callout danger" style="margin:0"><span>&#9888;</span><div class="grow"><b>architecture.yml failed to load</b><small>Unknown layer "expression" &mdash; check for a typo in a layers override.</small></div></div><button class="btn sm">Open architecture.yml</button>`)}</div>
 <div><h3>Wrap with...: selection and sequencing</h3>
  ${sc('No selection yet', 'Wrap with... needs a JSX selection', `<div>${gen({ disabled: true })}</div><span class="saveind">Select an element or range in the preview or source first.</span>`)}
  ${sc('Today, before #517 ships', 'The mechanical block does not exist yet', `<div>${gen({ only: true })}</div><span class="saveind">Shown honestly as "AI only, no block yet" (logged as a request for #517) &mdash; never a silent model fallback pretending to be mechanical.</span>`)}
  ${sc('Once #517 ships', 'Mechanical is the default', `<div>${gen({})}</div><span class="tag det">Deterministic &middot; construct refactor extract-expression</span>`)}</div>
 <div><h3>Narrow (390px)</h3>
  <div class="sheet3" style="grid-template-columns:1fr;padding:0">${phone('Palette, as the Inspect tab', 'Inspect', `<div class="pane-h"><span class="title">Palette</span></div>${tabs([['Inspector'], ['Palette', ['1', 'acc']]], 'Palette')}<div class="scroll" style="max-height:600px">${palGroup('Expressions', 1, palItem(palLayer('expression'), 'ShowForRole', 'features/cart/expressions', 'Wraps a role check.', ''))}</div>`)
    .replace('class="on" style="padding:0 9px;font-size:12px">Features', 'class="" style="padding:0 9px;font-size:12px">Features')
    .replace('class="" style="padding:0 9px;font-size:12px">Pages', 'class="on" style="padding:0 9px;font-size:12px">Pages')}</div></div>
</div>`;
Object.assign(pocOut, { 'ia-palette': paletteMock, 'ia-palette-suggest': paletteSuggestMock, 'ia-palette-confirm': paletteConfirmMock, 'ia-palette-states': palStates });
Object.assign(pocTitles, { 'ia-palette': 'Pages: block palette, read-only (Providers / Expressions / Components a page can actually use)', 'ia-palette-suggest': 'Pages: JSX selected, palette suggests wrapping it with a new Expression', 'ia-palette-confirm': 'Pages: Wrap with... confirmed, mechanical steps and per-file approval', 'ia-palette-states': 'Palette: empty, loading, error, no-selection, no-block-yet and narrow states' });

/* ================================================= Prop-to-scope binding: the Scope tab (#523, pairs with #518's Palette tab) */
// Extends the REAL, already-shipped screen -- ui/client/features/pages-editor/components/{ScopePanel,
// ScopeLinkGraph}.tsx (#223) already renders a two-column view (page declarations left, the selected
// element's props right) from packages/engine/scopeLinks.mjs's buildScopeLinks(), but every row is a
// plain, non-interactive <span> (its <svg> is aria-hidden) -- nothing can be clicked, focused or
// dragged today. AutoMapPanel (ui/client/.../AutoMapPanel.tsx, #54) already offers a checkbox
// multi-select "wire N props" action, but only for SAME-NAMED matches already destructured in the
// SAME file (ScopeDeclKind is 'prop'|'state'|'setter' only -- no Provider values, no other unit's
// output, ever). This mock's real gap, in order: (1) make the existing rows real interactive elements
// (2) let a person pick a SPECIFIC, possibly differently-named candidate, not just accept a same-name
// guess (3) widen the source list itself to Provider-exposed values and other already-called units'
// outputs, which the current server-side graph does not enumerate at all yet -- a small, separate
// core extension (packages/engine/scopeLinks.mjs), not just UI paint.
const scGroupLbl = (t) => `<div class="sc-group-lbl">${t}</div>`;
const scChip = (kind, name, type, o = {}) => `<button class="sc-${kind} ${o.cls || ''}" ${o.disabled ? 'disabled' : ''} aria-label="${o.aria || name}">${name}<span class="sc-not-type">${type}</span></button>`;

// Same LoginForm/EmailField scenario as every other Pages mock (ia-pages.html, cockpit-shell.html):
// LoginForm.tsx destructures { email, onSubmit, disabled } from its own Props (already shown, unchanged,
// in those mocks' "Props and bindings" section) and renders EmailField as a child. Selecting EmailField
// asks the question this ticket answers: where can EmailField.value come FROM?
const scopeSelTree = `${treeHead('Pages', [['Tree'], ['Pages'], ['Flow']], 'Tree')}
  <div class="scroll"><div class="sect">/login</div><div class="tree">
   ${trow(0, 'page', 'LoginPage', '', { tw: '&#9662;' })}
   ${trow(1, 'component', 'AppNav')}
   ${trow(1, 'component', 'LoginForm', '', { tw: '&#9662;' })}
   ${trow(2, 'component', 'EmailField', '', { sel: true })}
   ${trow(2, 'component', 'PasswordField')}
   ${trow(2, 'component', 'SubmitButton')}
   ${trow(1, 'component', 'AuthFooter')}
  </div></div>`;
const scopeDevice = () => `
<div class="device" style="height:440px;width:640px">
  <div class="bar"><i></i><i></i><i></i>&nbsp;&nbsp;localhost:5173/login</div>
  <div class="app-nav"><b>Storefront</b><span>Catalog</span><span>Cart (2)</span><span>Sign in</span></div>
  <div class="login" id="lf"><h2>Welcome back</h2><p>Sign in to continue checkout.</p>
    <label>Email</label><div class="in">sam@example.com</div>
    <label>Password</label><div class="in">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</div>
    <div class="cta">Sign in</div></div>
  <div class="sel-box" style="left:calc(50% - 174px);top:172px;width:348px;height:52px"></div>
  <div class="sel-tag" style="left:calc(50% - 174px);top:152px">EmailField</div>
</div>`;

// The three real ScopeSourceItem groups (extends ScopeDeclKind: today only 'prop'|'state'|'setter' --
// 'provider' and 'unit-output' are the two new kinds this ticket needs added to buildScopeLinks()).
const scSourceGroups = (linking) => `
  ${scGroupLbl("This file&rsquo;s own props &middot; LoginForm")}
  ${scChip('src', 'email', 'string', linking ? { cls: 'suggest' } : {})}
  ${scChip('src', 'onSubmit', '() =&gt; void', linking ? { cls: 'unfit', disabled: true } : {})}
  ${scChip('src', 'disabled', 'boolean', linking ? { cls: 'unfit', disabled: true } : {})}
  ${scGroupLbl('Providers this feature can use')}
  ${scChip('src', 'customer.email', 'string', linking ? { cls: 'suggest', aria: 'customer.email, string, from AuthProvider' } : {})}
  ${scChip('src', 'customer.name', 'string', linking ? { cls: 'suggest', aria: 'customer.name, string, from AuthProvider' } : {})}
  ${scChip('src', 'customer.id', 'string', linking ? { cls: 'suggest', aria: 'customer.id, string, from AuthProvider &mdash; likely the wrong pick, an opaque id' } : {})}
  ${scGroupLbl('Other units&rsquo; outputs already used here')}
  ${scChip('src', 'isPending', 'boolean', linking ? { cls: 'unfit', disabled: true } : {})}
`;
const scTargets = (linking, bound) => `
  <div class="prop"><span class="k">value</span>${bound
    ? `<span class="field">email</span><span style="display:inline-flex;align-items:center;gap:4px"><span class="bind ref">linked</span><span class="via">via LoginForm&rsquo;s own prop</span></span>`
    : `<span class="field ${linking ? 'linking' : ''}">${linking ? '?' : '""'}</span>${linking ? '<span class="tag" style="background:var(--danger-soft);color:var(--danger)">Linking&hellip;</span>' : '<button class="linkbtn" aria-label="Bind value on EmailField to a scope value" title="Bind...">&#8672;</button>'}`}</div>
  <div class="prop"><span class="k">label</span><span class="field">"Email"</span><span class="bind lit">literal</span></div>`;
const scInspector = (linking, bound) => `
  <div class="section"><div class="el-head"><span class="name">EmailField</span>${L('component')}<span class="spacer"></span><button class="icon-btn" aria-label="More">&#8943;</button></div><div class="path">features/auth/components/EmailField.tsx:6</div></div>
  <details class="dt" open><summary>Props and bindings <span class="c">2</span></summary>${scTargets(linking, bound)}</details>`;

// 1 -- read only: what CAN fill this prop, grounded, before any action exists (Slice 1, same "no
// execution risk" first cut as Palette's own).
const scopeReadMock = frame({ screen: 'Pages', lw: 280, rw: 420,
  left: scopeSelTree,
  mid: editorBar('Pages &rsaquo; /login &rsaquo; <b>EmailField</b>', [['Preview /login', true, true], ['EmailField.tsx']], ovMenu(0)) +
    `<div class="stage" style="flex:1;padding:14px;place-items:start center">${scopeDevice()}</div>` + foot,
  right: `<div class="pane-h"><span class="title">Scope</span></div>${tabs([['Inspector'], ['Scope'], ['Source'], ['Palette'], ['Diff']], 'Scope')}<div class="scroll">${scInspector(false, false)}
   <div class="section"><h4 style="margin-bottom:2px">Available in this feature&rsquo;s scope</h4><p style="margin:0 0 8px;color:var(--text-muted);font-size:12px">Same reachability the block palette (#518) already computes, read for data instead of imports &mdash; nothing here reaches a workflow, service or domain unit either.</p>${scSourceGroups(false)}</div></div>`,
  bot: bottom('Processes', runProcs(), 104, { p: '1', a: '0' }), botH: 104 });

// 2 -- linking mode: "Bind..." pressed on `value`. Click-to-select-then-click-to-target, the same
// selection vocabulary Pages already uses (Pick element, Palette's Wrap-with selection) -- typed
// candidates highlighted (.suggest, exactly Palette's own "fits" style), mismatches dimmed and
// disabled with a text reason (.unfit + "Not this type", the direct analogue of Palette's "Not a fit"),
// never colour alone. Keyboard: Tab from the pressed Bind button lands here with focus already inside
// the candidate list (first enabled item); Up/Down/Tab move between candidates, Enter/Space commits
// the focused one, Escape (or re-pressing the toggled Bind button) cancels back to the prop row.
const scopeLinkMock = frame({ screen: 'Pages', lw: 280, rw: 440,
  left: scopeSelTree,
  mid: editorBar('Pages &rsaquo; /login &rsaquo; <b>EmailField</b>', [['Preview /login', true, true], ['EmailField.tsx']], ovMenu(0)) +
    `<div class="stage" style="flex:1;padding:14px;place-items:start center">${scopeDevice()}</div>` + foot,
  right: `<div class="pane-h"><span class="title">Scope</span></div>${tabs([['Inspector'], ['Scope', ['1', 'acc']], ['Source'], ['Palette'], ['Diff']], 'Scope')}<div class="scroll">${scInspector(true, false)}
   <div class="callout info"><span>&#8672;</span><div class="grow"><b>Linking: value (string) on EmailField</b><small>Click or Enter a highlighted candidate, drag one onto the field, or press Escape to cancel. Dimmed candidates are a different type &mdash; disabled, not hidden, so you can see why.</small></div></div>
   <div class="section">${scSourceGroups(true)}</div></div>`,
  bot: bottom('Processes', runProcs(), 104, { p: '1', a: '0' }), botH: 104 });

// 3 -- bound: committed, mechanical, per-file approval (the SAME idiom as Palette's confirm and
// ia-pages-change's Change tab -- construct's own auto-map (packages/engine/pagesEditor.mjs
// applyAutoMap) already does the same-name case as a bulk checkbox action (kept below, unchanged);
// this single differently-named/-sourced pick needs the same one-line snippet-rewire block
// (pages-editor-propflow-rename/-values already cover literal<->variable, per ia-five-screens.md 8.4)
// pointed at a new source name instead of a new mechanical block.
const scopeBoundMock = frame({ screen: 'Pages', lw: 280, rw: 420,
  left: scopeSelTree,
  mid: editorBar('Pages &rsaquo; /login &rsaquo; <b>EmailField</b>', [['Preview /login', true, true], ['EmailField.tsx']], ovMenu(0)) +
    `<div class="stage" style="flex:1;padding:14px;place-items:start center">${scopeDevice()}</div>` + foot,
  right: `<div class="pane-h"><span class="title">Scope</span></div>${tabs([['Inspector'], ['Scope'], ['Source'], ['Palette'], ['Diff']], 'Scope')}<div class="scroll">${scInspector(false, true)}
   <div class="ask"><b>Bind</b> EmailField&rsquo;s <span class="field" style="display:inline-flex;width:60px">value</span> to <span class="field" style="display:inline-flex;width:60px">email</span></div>
   ${nextRow(1, 'Rewrite the JSX attribute', 'existing snippet-rewire block &middot; value={email} &mdash; no new mechanical block', gen({}), '<div class="nxl"><a>Preview diff</a> &middot; 1 file &middot; 0 model calls</div>')}
   <div class="sect" style="padding-top:10px">Approve &middot; 1 of 1</div>
   <div class="art"><span class="cb on">&#10003;</span><span>LoginForm.tsx</span><span style="color:var(--text-muted)">+1 -1</span></div>
   <div style="padding:10px 12px"><button class="btn primary">Approve</button> <button class="btn">Discard</button></div>
   <div class="section" style="border-top:1px solid var(--border-subtle)"><h4>Scope links on this file</h4><div class="link">email &rarr; EmailField.value</div></div>
   <div class="cb-group"><b style="font-size:12px">Auto-map (unchanged, #54) &middot; same-named candidates only</b>
    <div class="cbrow"><input type="checkbox" checked disabled />disabled &rarr; SubmitButton.disabled</div>
    <div class="cbrow" style="color:var(--text-muted)">Wire 1 prop(s) &middot; doesn&rsquo;t see Providers or other units&rsquo; outputs</div></div></div>`,
  bot: bottom('Approvals', `<table><tr><th>Waiting for you</th><th>From</th><th></th></tr><tr><td><b>Bind EmailField&rsquo;s value to LoginForm&rsquo;s email</b> &middot; 1 file</td><td><span class="tag det">Mechanical</span></td><td><button class="btn sm primary">Review diff</button></td></tr></table>`, 110, { p: '0', a: '1' }), botH: 110 });

/* States: empty scope, loading, error, no selection, all-mismatched, drag, keyboard focus, deferred
   multi-field linking, narrow. */
const scopeStates = `
<div class="hh">Scope: what this feature could plug in, and how to plug it in<small>Extends the real, shipped ScopeLinkGraph/ScopePanel (#223) and AutoMapPanel (#54) &mdash; not a parallel screen.</small></div>
<div class="sheet3">
 <div><h3>Before there is anything to show</h3>
  ${sc('Empty scope', 'Nothing reachable yet', `<p>This component takes no props of its own, no Provider is reachable, and no other unit&rsquo;s output is called here yet. Every target stays a literal until one exists.</p>`)}
  ${sc('Loading', 'Computing scope for this file', `<span class="saveind busy"><span class="spin"></span> Reading declarations, Providers and unit outputs in scope&hellip;</span>`)}
  ${sc('Error', 'Couldn&rsquo;t compute scope links', `<div class="callout danger" style="margin:0"><span>&#9888;</span><div class="grow"><b>EmailField.tsx&rsquo;s own props could not be resolved</b><small>Falling back to every in-scope name, unfiltered by what the child actually declares (same fallback ScopePanel already has today).</small></div></div>`)}</div>
 <div><h3>Linking mode: no fit, no selection</h3>
  ${sc('No selection yet', 'Bind needs an element selected', `<div><button class="linkbtn" disabled>&#8672;</button></div><span class="saveind">Select an element in the tree or preview first.</span>`)}
  ${sc('Nothing type-matches', 'Every candidate is dimmed', `${scChip('src', 'onSubmit', '() =&gt; void', { cls: 'unfit', disabled: true })}${scChip('src', 'disabled', 'boolean', { cls: 'unfit', disabled: true })}<p style="margin:8px 0 0">Type a literal instead, or add a component/hook that exposes the right type &mdash; never silently hidden as "nothing available".</p>`)}
  ${sc('Keyboard focus', 'Tab/Arrow reach every candidate, no pointer needed', `<div class="scmock" style="position:static;display:flex;gap:6px;flex-wrap:wrap">${scChip('src', 'email', 'string', { cls: 'suggest kbd' })}</div><span class="saveind">Focus ring is the same 2px accent outline used everywhere else (principles.md); Enter/Space commits, Escape cancels.</span>`)}</div>
 <div><h3>Drag-and-drop: the optional pointer accelerator</h3>
  ${sc('Dragging a source', 'Grabbed, not yet over a target', `<div class="scmock" style="position:static"><span class="sc-src sc-dragging">email<span class="sc-not-type">string</span></span></div><span class="saveind">Purely additive: drops call the exact same bind action click-to-link already does &mdash; never the only way to reach the outcome (WCAG 2.5.7).</span>`)}
  ${sc('Valid drop target', 'Type matches, drop accepted', `<div class="prop"><span class="k">value</span><span class="field sc-drop-ok">${'{email}'}</span></div>`)}
  ${sc('Invalid drop target', 'Type mismatch, drop refused', `<div class="prop"><span class="k">disabled</span><span class="field sc-drop-bad">not-allowed</span></div><span class="saveind">Cursor and outline both change; refusal is never silent.</span>`)}</div>
 <div><h3>Deferred: multi-field linking ("Ctrl + related fields")</h3>
  ${sc('Not in this slice', 'A real idea, not yet scoped', `<p>Binding an object&rsquo;s several sub-fields at once (e.g. <code>customer.street</code> + <code>customer.city</code> onto two sibling props together) needs a destructure-aware mechanical block AutoMap doesn&rsquo;t have today. AutoMap&rsquo;s existing checkbox multi-select (#54, shown bound above) is the closest real precedent &mdash; extending it to cross-source, cross-type candidates is the natural next step, logged, not built here.</p>`)}</div>
 <div><h3>Narrow (390px)</h3>
  <div class="sheet3" style="grid-template-columns:1fr;padding:0">${phone('Scope, as the Inspect tab', 'Inspect', `<div class="pane-h"><span class="title">Scope</span></div>${tabs([['Inspector'], ['Scope', ['1', 'acc']]], 'Scope')}<div class="scroll" style="max-height:600px">${scSourceGroups(true)}</div>`)
    .replace('class="on" style="padding:0 9px;font-size:12px">Features', 'class="" style="padding:0 9px;font-size:12px">Features')
    .replace('class="" style="padding:0 9px;font-size:12px">Pages', 'class="on" style="padding:0 9px;font-size:12px">Pages')}</div></div>
</div>`;
Object.assign(pocOut, { 'ia-scope': scopeReadMock, 'ia-scope-link': scopeLinkMock, 'ia-scope-bound': scopeBoundMock, 'ia-scope-states': scopeStates });
Object.assign(pocTitles, { 'ia-scope': 'Pages: Scope tab, read-only (Providers / this file&rsquo;s own props / other units&rsquo; outputs a prop could bind to)', 'ia-scope-link': 'Pages: linking mode, a prop&rsquo;s Bind... pressed, type-matching candidates highlighted', 'ia-scope-bound': 'Pages: bound, mechanical rewrite and per-file approval, existing auto-map shown alongside', 'ia-scope-states': 'Scope: empty, loading, error, no-fit, keyboard focus, drag and deferred multi-field states' });

const out = { 'ia-features': features, 'ia-account-menu': menuMock, 'ia-slot-matrix': matrix, 'ia-notes-states': drafts, 'ia-no-project': noProj, 'ia-git': git, 'ia-git-connect': gitConnect, 'ia-git-changes': gitChanges, 'ia-git-commit-blocked': gitCommitBlocked, 'ia-git-branches': gitBranches, 'ia-git-clean': gitClean, 'ia-git-states': gitStates, 'ia-git-narrow': gitNarrow, 'ia-narrow': narrow };
const titles = { 'ia-features': 'Features screen: notes, impact, plan, processes', 'ia-account-menu': 'Account menu: settings, local model, theme, help, sign out', 'ia-slot-matrix': 'Five screens, four slots', 'ia-notes-states': 'Notes: durable states', 'ia-no-project': 'No project: where the Open a project prompt sits', 'ia-git': 'Git screen: PRs and review inside the shell', 'ia-git-connect': 'Git with no remote: where Connect remote and Clone sit', 'ia-git-changes': 'Git: Changes tab, stage/unstage, diff, Commit tab (push ready)', 'ia-git-commit-blocked': 'Git: Commit tab, push blocked on no GitHub credential (#638)', 'ia-git-branches': 'Git: Branches tab, session branch, switch and create', 'ia-git-clean': 'Git: Changes tab, clean tree (nothing to stage)', 'ia-git-states': 'Git: sign-in gate vs. push-credential gate', 'ia-git-narrow': 'Git: Changes, narrow (390 px), one panel at a time', 'ia-narrow': 'Narrow (390 px): one panel at a time' };
Object.assign(out, pocOut); Object.assign(titles, pocTitles);
for (const [k, v] of Object.entries(out)) writeFileSync(join(here, `${k}.html`), page(titles[k], v));
console.log('ia mocks written');
