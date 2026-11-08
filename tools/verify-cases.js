#!/usr/bin/env node
/*
 * Who Broke Prod? — case data verifier
 *
 * Usage:  node tools/verify-cases.js [-v]
 *
 * Loads the CASES array straight out of index.html (between the
 * CASES_START / CASES_END markers), builds every case's repository with the
 * real engine (engine.js) and checks:
 *   1. the reference solution passes
 *   2. every documented alternative passes
 *   3. every documented trap (a plausible near-miss) is rejected
 *   4. the starting input does not already pass
 * Exits 1 on any failure, so it can run in CI. Keep in sync with SOLUTIONS.md.
 */
const fs = require('fs');
const path = require('path');
const GitSim = require('../engine.js');

const VERBOSE = process.argv.includes('-v');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const block = html.split('/*CASES_START*/')[1].split('/*CASES_END*/')[0];
// eslint-disable-next-line no-new-func
const { CASES } = new Function('GitSim', block + '\nreturn { CASES, BADGES };')(GitSim);

/* ---- strategies used by bisect cases (sequences that depend on test output) ---- */
// decide(result, buildResult) -> 'good' | 'bad' | 'skip'
function manualBisect(start, testCmd, decide, buildCmd, after) {
  return { manual: true, start, testCmd, decide, buildCmd, after };
}
const byTest = (r) => (r.code === 0 ? 'good' : 'bad');
const skipBroken = (r, b) => (b && b.code !== 0 ? 'skip' : r.code === 0 ? 'good' : 'bad');
const brokenGood = (r, b) => (b && b.code !== 0 ? 'good' : r.code === 0 ? 'good' : 'bad');

const ALTERNATIVES = {
  'case-01': ['git log --format=%h -- config/prod.yml', 'git log config/prod.yml', 'git log --oneline main -- config/prod.yml', 'git log -- config/prod.yml'],
  'case-02': ['git log --oneline --author="^Mira C"', 'git log --oneline --author=Chen', "git log --oneline --author='Mira Chen'", 'git log --author="Mira Chen" --format="%h %an"'],
  'case-03': ['git log -S "retryCharge(" --oneline', 'git log --oneline -S"retryCharge(" -- src/payments/charge.js', "git log --format=%h -S'retryCharge('", 'git log -S"retryCharge(" main'],
  'case-04': ["git blame -L '/function applyDiscount(/,/^}/' src/discounts.js", 'git blame -L 14,+6 src/discounts.js', "git blame -L ':applyDiscount\\(' src/discounts.js", "git blame -L '/applyDiscount(/,+6' src/discounts.js", 'git blame -L 14,19 HEAD -- src/discounts.js'],
  'case-05': ['git blame --ignore-rev {{g06}} -L 5,10 src/checkout.js', 'git blame -w -L 5,+6 src/checkout.js', 'git blame -w -L 5,10 -- src/checkout.js'],
  'case-06': [
    manualBisect(['git bisect start main v2.4.0'], 'npm test', byTest),
    manualBisect(['git bisect start', 'git bisect bad', 'git bisect good v2.4.0'], 'npm test', byTest),
  ],
  'case-07': [
    manualBisect(['git bisect start main v2.5.0'], 'npm test', skipBroken, 'npm run build'),
    ['git bisect start main v2.5.0', 'git bisect run sh scripts/bisect-check.sh'],
  ],
  'case-08': [
    ['git reset --hard ORIG_HEAD'],
    ['git reset --hard HEAD@{4}'],
    ['git switch main', 'git branch -f release/2.5 {{k08}}'],
    ['git cherry-pick {{k06}} {{k08}}'],
    ['git reflog', 'git checkout {{k08}}', 'git branch -f release/2.5 HEAD', 'git switch release/2.5'],
  ],
  'case-09': [
    ['git switch release/2.5 && git cherry-pick {{j04}} {{j06}}'],
    ['git checkout release/2.5', 'git cherry-pick -x {{j04}}', 'git cherry-pick -x {{j06}}'],
    ['git switch release/2.5', 'git cherry-pick {{j06}} {{j04}}', 'git cherry-pick {{j04}} {{j06}}'],
  ],
  'case-10': [
    manualBisect(['git bisect start release/2.6 v2.6.0-rc1'], 'npm test', skipBroken, 'npm run build', ['git bisect reset', 'git switch release/2.6', 'git cherry-pick -x {{n2}}']),
    ['git switch release/2.6', 'git bisect start HEAD v2.6.0-rc1', 'git bisect run ./scripts/bisect-check.sh', 'git bisect reset', 'git cherry-pick {{n2}}'],
  ],
};

const TRAPS = {
  'case-01': ['git log --oneline', 'git log --oneline -- config/', "git log --oneline -- 'config/prod*'", 'git log --oneline --all -- config/prod.yml', 'git log --oneline --grep=prod', 'git log --oneline -i --grep=prod'],
  'case-02': ['git log --oneline --author=Mira', 'git log --oneline --author=mira@kettlebird.io', 'git log --oneline --all --author="Mira Chen"', 'git log --oneline --grep=Mira', 'git log --oneline --author=mira'],
  'case-03': ['git log --oneline -SretryCharge', 'git log --oneline -G"retryCharge\\("', 'git log --oneline -i --grep=retry', 'git log --oneline --grep=retry', 'git log --oneline -- src/payments/charge.js'],
  'case-04': ['git blame src/discounts.js', "git blame -L '/applyDiscount/,+6' src/discounts.js", 'git blame -L :applyDiscount src/discounts.js', 'git blame -L 14,18 src/discounts.js', 'git blame -L 13,19 src/discounts.js'],
  'case-05': ['git blame -L 5,10 src/checkout.js', 'git blame -L 5,10 {{g06}}^ -- src/checkout.js', 'git blame -w src/checkout.js'],
  'case-06': [
    manualBisect(['git bisect start main v2.4.0'], 'npm test', (r) => (r.code === 0 ? 'bad' : 'good')),
    ['git bisect start main v2.4.0'],
  ],
  'case-07': [
    ['git bisect start main v2.5.0', 'git bisect run npm test'],
    manualBisect(['git bisect start main v2.5.0'], 'npm test', byTest),
    manualBisect(['git bisect start main v2.5.0'], 'npm test', brokenGood, 'npm run build'),
  ],
  'case-08': [
    ['git reset --hard HEAD@{1}'],
    ['git reset --hard {{k07}}'],
    ['git reset --hard HEAD@{5}'],
    ['git branch rescue {{k08}}'],
    ['git cherry-pick {{k06}} {{k07}}'],
  ],
  'case-09': [
    ['git switch release/2.5', 'git cherry-pick {{j03}}..{{j06}}'],
    ['git switch release/2.5', 'git cherry-pick {{j06}} {{j04}}'],
    ['git cherry-pick {{j04}} {{j06}}'],
    ['git switch release/2.5', 'git cherry-pick {{j04}} {{j06}} {{j07}}'],
    ['git switch release/2.5', 'git cherry-pick {{j04}}'],
  ],
  'case-10': [
    ['git bisect start release/2.6 v2.6.0-rc1', 'git bisect run npm test', 'git bisect reset', 'git switch release/2.6', 'git cherry-pick {{n2}}'],
    ['git bisect start release/2.6 v2.6.0-rc1', 'git bisect run ./scripts/bisect-check.sh', 'git bisect reset', 'git switch release/2.6', 'git cherry-pick {{n1}}'],
    ['git bisect start release/2.6 v2.6.0-rc1', 'git bisect run ./scripts/bisect-check.sh', 'git cherry-pick {{n2}}'],
    ['git switch release/2.6', 'git cherry-pick {{n2}}'],
  ],
};

/* ---- helpers ---- */
const hashify = (st, s) => s.replace(/\{\{(\w+)\}\}/g, (_, id) => {
  if (!st.commits[id]) throw new Error(`unknown commit id {{${id}}}`);
  return st.commits[id].hash.slice(0, 7);
});

function runOutput(c, cmd) {
  const st = GitSim.build(c.repo);
  const line = hashify(st, cmd);
  const r = GitSim.exec(st, line);
  const want = c.grade.expected;
  const got = r.items && r.items.kind === (c.grade.expect === 'blame' ? 'blame' : 'commits') ? r.items.list : null;
  const ok = !!got && got.length === want.length && got.every((x, i) => x === want[i]);
  return { ok, got, want, out: r.out, line, tokens: GitSim.tokenCount(line) };
}

function runState(c, seq) {
  const st = GitSim.build(c.repo);
  const log = [];
  const ex = (cmd) => { const line = hashify(st, cmd); const r = GitSim.exec(st, line); log.push(`$ ${line}\n${r.out}`); return r; };
  if (Array.isArray(seq)) seq.forEach(ex);
  else {
    seq.start.forEach(ex);
    for (let guard = 0; guard < 40 && st.bisect && !st.bisect.done; guard++) {
      const b = seq.buildCmd ? ex(seq.buildCmd) : null;
      const t = ex(seq.testCmd);
      const v = seq.decide({ code: t.error ? 1 : 0 }, b && { code: b.error ? 1 : 0 });
      ex(`git bisect ${v}`);
    }
    (seq.after || []).forEach(ex);
  }
  const checks = c.grade.check(GitSim.api(st));
  return { ok: checks.every((k) => k.ok), checks, log, steps: st.bisectSteps, moves: st.moves.length, st };
}

let failures = 0;
const fail = (msg) => { failures++; console.log('  ✗ ' + msg); };
const pass = (msg) => { if (VERBOSE) console.log('  ✓ ' + msg); };
const label = (s) => (Array.isArray(s) ? s.join(' ; ') : s.manual ? `[manual ${s.decide.name || 'strategy'}] ${s.start.join(' ; ')}${s.after ? ' ; ' + s.after.join(' ; ') : ''}` : s);

for (const c of CASES) {
  console.log(`${c.id}  ${c.title}`);
  let st0;
  try { st0 = GitSim.build(c.repo); } catch (e) { fail('build failed: ' + e.message); continue; }
  if (c.grade.kind === 'output') {
    const ref = runOutput(c, c.solution.cmd);
    if (ref.ok) pass(`reference: ${ref.line}  (${ref.tokens} tokens)`);
    else fail(`reference fails: ${ref.line}\n      want ${JSON.stringify(ref.want)}\n      got  ${JSON.stringify(ref.got)}\n${ref.out}`);
    const start = runOutput(c, c.startInput);
    if (start.ok) fail(`startInput already passes: ${c.startInput}`);
    for (const alt of ALTERNATIVES[c.id] || []) {
      const r = runOutput(c, alt);
      if (r.ok) pass(`alt: ${r.line}`); else fail(`alternative fails: ${r.line}\n      got ${JSON.stringify(r.got)}\n${r.out}`);
    }
    for (const trap of TRAPS[c.id] || []) {
      const r = runOutput(c, trap);
      if (!r.ok) pass(`trap rejected: ${r.line}`); else fail(`trap passes: ${r.line}`);
    }
  } else {
    const steps = c.solution.steps;
    const ref = runState(c, steps);
    if (ref.ok) pass(`reference: ${steps.join(' ; ')}  (steps ${ref.steps}, moves ${ref.moves})`);
    else fail(`reference fails: ${steps.join(' ; ')}\n${JSON.stringify(ref.checks, null, 1)}\n${ref.log.join('\n')}`);
    const none = runState(c, []);
    if (none.ok) fail('case passes with no commands');
    for (const alt of ALTERNATIVES[c.id] || []) {
      const r = runState(c, alt);
      if (r.ok) pass(`alt: ${label(alt)}  (steps ${r.steps})`); else fail(`alternative fails: ${label(alt)}\n${JSON.stringify(r.checks)}${VERBOSE ? '\n' + r.log.join('\n') : ''}`);
    }
    for (const trap of TRAPS[c.id] || []) {
      const r = runState(c, trap);
      if (!r.ok) pass(`trap rejected: ${label(trap)}  → ${r.checks.filter((k) => !k.ok).map((k) => k.label).join('; ')}${r.st.bisectResult ? ' [named ' + r.st.bisectResult + ']' : ''}`);
      else fail(`trap passes: ${label(trap)}`);
    }
  }
}
console.log(failures ? `\n${failures} problem(s) found.` : '\nAll cases verified.');
process.exit(failures ? 1 : 0);
