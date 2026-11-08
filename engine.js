/*
 * Who Broke Prod? — Git sandbox engine
 *
 * A small, deterministic simulation of the parts of Git used for forensics:
 * log (filters, pickaxe, paths, ranges), show, diff, blame (-L, -w, --ignore-rev),
 * bisect (start/good/bad/skip/run/reset/log/view), reflog, branch, checkout,
 * switch, reset, cherry-pick, tag, status, rev-parse, shortlog, grep.
 *
 * History is linear per branch (no merge commits) and there is no index or
 * working-tree state: the working tree is always HEAD's tree.
 *
 * Runs unchanged in the browser (window.GitSim) and in Node (module.exports),
 * so the game, the cheat sheet and tools/verify-cases.js share one engine.
 */
(function (global) {
  'use strict';

  /* ==== ERRORS ==== */
  class GitError extends Error {}
  const fatal = (msg) => { throw new GitError(msg); };

  /* ==== SMALL UTILS ==== */
  const pad2 = (n) => String(n).padStart(2, '0');
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function fakeSha(str) {
    let out = '';
    for (let k = 0; k < 5; k++) {
      let h = (0x811c9dc5 ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
      out += (h >>> 0).toString(16).padStart(8, '0');
    }
    return out;
  }

  function splitLines(s) {
    if (s == null || s === '') return [];
    const t = s.endsWith('\n') ? s.slice(0, -1) : s;
    return t.split('\n');
  }
  const joinLines = (a) => (a.length ? a.join('\n') + '\n' : '');
  const ensureNL = (s) => (s === '' || s.endsWith('\n') ? s : s + '\n');
  const subject = (msg) => msg.split('\n')[0];
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const authorName = (a) => a.replace(/\s*<.*>$/, '');
  const authorEmail = (a) => (a.match(/<(.*)>/) || [, ''])[1];

  function parseStamp(d) {
    const p = d.match(/\d+/g).map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2], p[3] || 0, p[4] || 0);
  }
  function stampToStr(ms) {
    const t = new Date(ms);
    return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())} ${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
  }
  const addMinutes = (d, n) => stampToStr(parseStamp(d) + n * 60000);
  function fmtDate(d) {
    const t = new Date(parseStamp(d));
    return `${DOW[t.getUTCDay()]} ${MON[t.getUTCMonth()]} ${t.getUTCDate()} ${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}:00 ${t.getUTCFullYear()} +0000`;
  }
  function relDate(st, d) {
    const mins = Math.round((parseStamp(st.now) - parseStamp(d)) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 90) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const h = Math.round(mins / 60);
    if (h < 36) return `${h} hours ago`;
    const days = Math.round(h / 24);
    if (days < 14) return `${days} days ago`;
    return `${Math.round(days / 7)} weeks ago`;
  }
  function parseDate(st, s) {
    const v = s.trim().toLowerCase();
    let m;
    if ((m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2}):(\d{2}))?/))) {
      return `${m[1]}-${m[2]}-${m[3]} ${pad2(m[4] || 0)}:${m[5] || '00'}`;
    }
    if ((m = v.match(/^(\d+)[ .]?(minute|min|hour|day|week)s?[ .]?ago$/))) {
      const mult = { minute: 1, min: 1, hour: 60, day: 1440, week: 10080 }[m[2]];
      return addMinutes(st.now, -Number(m[1]) * mult);
    }
    if (v === 'yesterday') return addMinutes(st.now, -1440);
    if (v === 'today' || v === 'midnight') return st.now.slice(0, 10) + ' 00:00';
    fatal(`fatal: could not parse date '${s}' (try 2026-10-28, "2026-10-28 14:00" or "3 days ago")`);
  }

  // Player regexes: try JavaScript syntax first; if it does not compile, fall back to a
  // literal match (so "applyDiscount(" works as it does in Git's basic regex dialect).
  function mkRegex(p, icase, fixed) {
    if (p.length > 200) fatal('fatal: pattern too long for this sandbox (200 characters max)');
    if (!fixed && /(\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)|\[(?:[^\]\\]|\\.)*\][+*])[+*{]/.test(p)) {
      fatal('fatal: nested quantifiers like (a+)+ can take forever to match; simplify the pattern');
    }
    const flags = icase ? 'i' : '';
    if (fixed) return new RegExp(escapeRe(p), flags);
    try { return new RegExp(p, flags); } catch (e) { return new RegExp(escapeRe(p), flags); }
  }

  /* ==== SHELL TOKENIZER ==== */
  // Splits a command line on && and ; outside quotes. Pipes are refused on purpose.
  function splitChain(line) {
    const segs = [];
    let cur = '', q = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        cur += ch;
        if (ch === '\\' && q === '"' && i + 1 < line.length) { cur += line[++i]; continue; }
        if (ch === q) q = null;
        continue;
      }
      if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
      if (ch === '&' && line[i + 1] === '&') { segs.push({ text: cur.trim(), next: '&&' }); cur = ''; i++; continue; }
      if (ch === ';') { segs.push({ text: cur.trim(), next: ';' }); cur = ''; continue; }
      if (ch === '|') {
        throw new GitError("sandbox: pipes (|) aren't available here. Use Git's own filters instead (-n, --author, --grep, -S, -- <path>…). That's the point of the exercise!");
      }
      if (ch === '>' || ch === '<') throw new GitError('sandbox: redirection (> <) is not available here.');
      if (ch === '`' || (ch === '$' && line[i + 1] === '(')) throw new GitError('sandbox: command substitution is not available here.');
      cur += ch;
    }
    if (q) throw new GitError(`bash: unexpected EOF while looking for matching \`${q}'`);
    segs.push({ text: cur.trim(), next: null });
    return segs.filter((s) => s.text !== '');
  }

  function tokenize(seg) {
    const toks = [];
    let cur = '', has = false, q = null;
    for (let i = 0; i < seg.length; i++) {
      const ch = seg[i];
      if (q === "'") { if (ch === "'") q = null; else cur += ch; continue; }
      if (q === '"') {
        if (ch === '\\' && i + 1 < seg.length && '"\\$`'.includes(seg[i + 1])) { cur += seg[++i]; continue; }
        if (ch === '"') q = null; else cur += ch;
        continue;
      }
      if (ch === "'" || ch === '"') { q = ch; has = true; continue; }
      if (ch === '\\' && i + 1 < seg.length) { cur += seg[++i]; has = true; continue; }
      if (/\s/.test(ch)) { if (has) { toks.push(cur); cur = ''; has = false; } continue; }
      cur += ch; has = true;
    }
    if (q) throw new GitError(`bash: unexpected EOF while looking for matching \`${q}'`);
    if (has) toks.push(cur);
    return toks;
  }

  /* ==== DIFF ==== */
  function diffOps(a, b, eq) {
    eq = eq || ((x, y) => x === y);
    const n = a.length, m = b.length;
    let pre = 0;
    while (pre < n && pre < m && eq(a[pre], b[pre])) pre++;
    let suf = 0;
    while (suf < n - pre && suf < m - pre && eq(a[n - 1 - suf], b[m - 1 - suf])) suf++;
    const N = n - pre - suf, M = m - pre - suf;
    const dp = [];
    for (let i = 0; i <= N; i++) dp.push(new Uint16Array(M + 1));
    for (let i = N - 1; i >= 0; i--) {
      for (let j = M - 1; j >= 0; j--) {
        dp[i][j] = eq(a[pre + i], b[pre + j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    for (let k = 0; k < pre; k++) ops.push({ t: '=', a: k, b: k });
    let i = 0, j = 0;
    while (i < N && j < M) {
      if (eq(a[pre + i], b[pre + j]) && dp[i][j] === dp[i + 1][j + 1] + 1) { ops.push({ t: '=', a: pre + i, b: pre + j }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', a: pre + i }); i++; }
      else { ops.push({ t: '+', b: pre + j }); j++; }
    }
    while (i < N) { ops.push({ t: '-', a: pre + i }); i++; }
    while (j < M) { ops.push({ t: '+', b: pre + j }); j++; }
    for (let k = 0; k < suf; k++) ops.push({ t: '=', a: n - suf + k, b: m - suf + k });
    return ops;
  }

  function makeHunks(a, b, ctx) {
    ctx = ctx == null ? 3 : ctx;
    const ops = diffOps(a, b);
    const aBefore = [], bBefore = [];
    let ca = 0, cb = 0;
    for (const o of ops) {
      aBefore.push(ca); bBefore.push(cb);
      if (o.t !== '+') ca++;
      if (o.t !== '-') cb++;
    }
    const changed = [];
    ops.forEach((o, k) => { if (o.t !== '=') changed.push(k); });
    if (!changed.length) return [];
    const groups = [];
    let s = changed[0], e = changed[0];
    for (const k of changed.slice(1)) {
      if (k - e <= 2 * ctx + 1) e = k; else { groups.push([s, e]); s = e = k; }
    }
    groups.push([s, e]);
    return groups.map(([gs, ge]) => {
      const from = Math.max(0, gs - ctx), to = Math.min(ops.length - 1, ge + ctx);
      const lines = [];
      let aLen = 0, bLen = 0;
      for (let k = from; k <= to; k++) {
        const o = ops[k];
        if (o.t === '=') { lines.push(' ' + a[o.a]); aLen++; bLen++; }
        else if (o.t === '-') { lines.push('-' + a[o.a]); aLen++; }
        else { lines.push('+' + b[o.b]); bLen++; }
      }
      return { aStart: aBefore[from], aLen, bStart: bBefore[from], bLen, lines };
    });
  }

  function hunkHeader(h) {
    const r = (start, len) => (len === 1 ? `${start + 1}` : `${len === 0 ? start : start + 1},${len}`);
    return `@@ -${r(h.aStart, h.aLen)} +${r(h.bStart, h.bLen)} @@`;
  }

  // Apply the change base→result onto target. Returns new text or null on conflict.
  function applyPatch(base, result, target) {
    const hs = makeHunks(splitLines(base), splitLines(result));
    const t = splitLines(target);
    let offset = 0;
    for (const h of hs) {
      const old = h.lines.filter((l) => l[0] !== '+').map((l) => l.slice(1));
      const neu = h.lines.filter((l) => l[0] !== '-').map((l) => l.slice(1));
      const expect = h.aStart + offset;
      let best = -1, bestDist = Infinity;
      for (let p = 0; p + old.length <= t.length; p++) {
        let ok = true;
        for (let k = 0; k < old.length; k++) if (t[p + k] !== old[k]) { ok = false; break; }
        if (ok && Math.abs(p - expect) < bestDist) { best = p; bestDist = Math.abs(p - expect); }
      }
      if (best < 0) return null;
      t.splice(best, old.length, ...neu);
      offset = best - h.aStart + (neu.length - old.length);
    }
    return joinLines(t);
  }

  /* ==== REPO MODEL ==== */
  function newState(def) {
    return {
      def,
      commits: {}, order: [], byHash: {},
      heads: {}, tags: {},
      HEAD: { ref: (def && def.initialBranch) || 'main' },
      reflog: [],
      origHead: null,
      bisect: null,
      bisectResult: null, bisectSteps: 0, bisectResultSteps: 0, bisectHistory: [],
      seq: 0,
      now: (def && def.now) || '2026-11-01 02:14',
      lastExit: 0,
      moves: [],
      building: false,
    };
  }

  const C = (st, id) => st.commits[id];
  const short = (st, id) => st.commits[id].hash.slice(0, 7);
  function headId(st) { return st.HEAD.ref ? st.heads[st.HEAD.ref] || null : st.HEAD.det; }
  function headTree(st) { const h = headId(st); return h ? st.commits[h].tree : {}; }
  function parentTree(st, c) { return c.parent ? st.commits[c.parent].tree : {}; }

  function addCommit(st, o) {
    let hash = fakeSha([st.def ? st.def.id : '', o.id, o.parent || '', o.author, o.date, o.msg, Object.keys(o.tree).length].join('|'));
    while (st.byHash[hash]) hash = fakeSha(hash + '+');
    const c = { id: o.id, hash, parent: o.parent || null, author: o.author, date: o.date, cdate: o.cdate || o.date, msg: o.msg, tree: o.tree, pickedFrom: o.pickedFrom || null };
    st.commits[c.id] = c;
    st.order.push(c.id);
    st.byHash[hash] = c.id;
    return c;
  }

  function ancestors(st, id) {
    const s = new Set();
    let cur = id;
    while (cur && !s.has(cur)) { s.add(cur); cur = st.commits[cur].parent; }
    return s;
  }
  function isAncestor(st, a, b) { return ancestors(st, b).has(a); }

  function changedFiles(st, c) {
    const p = parentTree(st, c), t = c.tree;
    const files = new Set([...Object.keys(p), ...Object.keys(t)]);
    return [...files].filter((f) => p[f] !== t[f]).sort();
  }

  function setHeadTo(st, id) {
    if (st.HEAD.ref) st.heads[st.HEAD.ref] = id; else st.HEAD = { det: id };
  }
  function logRef(st, id, msg) { st.reflog.push({ id, msg }); }
  function headName(st) { return st.HEAD.ref || short(st, st.HEAD.det); }

  function sortedIds(st, set) {
    const idx = {};
    st.order.forEach((id, i) => { idx[id] = i; });
    return [...set].sort((x, y) => {
      const a = st.commits[x], b = st.commits[y];
      if (a.cdate !== b.cdate) return a.cdate < b.cdate ? 1 : -1;
      return idx[y] - idx[x];
    });
  }

  function allTips(st) {
    const tips = [...Object.values(st.heads), ...Object.values(st.tags)];
    const h = headId(st);
    if (h) tips.push(h);
    return tips;
  }

  function decorations(st) {
    const map = {};
    const add = (id, label) => { (map[id] = map[id] || []).push(label); };
    const h = headId(st);
    if (h) add(h, st.HEAD.ref ? `HEAD -> ${st.HEAD.ref}` : 'HEAD');
    for (const [name, id] of Object.entries(st.heads).sort()) if (name !== st.HEAD.ref) add(id, name);
    for (const [name, id] of Object.entries(st.tags).sort()) add(id, `tag: ${name}`);
    return map;
  }

  /* ==== REVISIONS ==== */
  function resolveBase(st, base, spec) {
    let m;
    if (base === 'HEAD' || base === '@') {
      const h = headId(st);
      if (!h) fatal(`fatal: ambiguous argument 'HEAD': unknown revision (your current branch has no commits yet)`);
      return h;
    }
    if ((m = base.match(/^(?:HEAD)?@\{(\d+)\}$/))) {
      const n = Number(m[1]);
      if (n >= st.reflog.length) fatal(`fatal: log for 'HEAD' only has ${st.reflog.length} entries`);
      return st.reflog[st.reflog.length - 1 - n].id;
    }
    if (/@\{/.test(base)) fatal(`fatal: this sandbox only keeps a reflog for HEAD — use HEAD@{n}`);
    if (base === 'ORIG_HEAD') {
      if (!st.origHead) fatal(`fatal: ambiguous argument 'ORIG_HEAD': unknown revision`);
      return st.origHead;
    }
    const b = base.replace(/^refs\/(heads|tags)\//, '');
    if (st.heads[b]) return st.heads[b];
    if (st.tags[b]) return st.tags[b];
    if (/^[0-9a-f]{4,40}$/i.test(base)) {
      const hits = Object.keys(st.byHash).filter((h) => h.startsWith(base.toLowerCase()));
      if (hits.length === 1) return st.byHash[hits[0]];
      if (hits.length > 1) fatal(`error: short object ID ${base} is ambiguous`);
    }
    fatal(`fatal: ambiguous argument '${spec}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
  }

  function resolveRev(st, spec) {
    if (!spec) fatal('fatal: empty revision');
    const m = spec.match(/^(.*?)((?:[~^]\d*)*)$/);
    const base = m[1], suffix = m[2];
    if (!base) fatal(`fatal: ambiguous argument '${spec}'`);
    let id = resolveBase(st, base, spec);
    const parts = suffix.match(/[~^]\d*/g) || [];
    for (const p of parts) {
      const n = p.length > 1 ? Number(p.slice(1)) : 1;
      if (p[0] === '^') {
        if (n === 0) continue;
        if (n > 1) fatal(`fatal: ambiguous argument '${spec}': commit ${short(st, id)} has only one parent in this sandbox`);
        const par = st.commits[id].parent;
        if (!par) fatal(`fatal: ambiguous argument '${spec}': unknown revision (${short(st, id)} is the root commit)`);
        id = par;
      } else {
        for (let k = 0; k < n; k++) {
          const par = st.commits[id].parent;
          if (!par) fatal(`fatal: ambiguous argument '${spec}': unknown revision (history only goes back ${k} commit${k === 1 ? '' : 's'} from ${base})`);
          id = par;
        }
      }
    }
    return id;
  }
  function tryRev(st, spec) { try { return resolveRev(st, spec); } catch (e) { return null; } }

  function isGlob(p) { return /[*?[]/.test(p); }
  function globRe(p) {
    let r = '';
    for (const ch of p) r += ch === '*' ? '.*' : ch === '?' ? '.' : '[]'.includes(ch) ? ch : escapeRe(ch);
    return new RegExp('^' + r + '$');
  }
  function pathMatches(specs, f) {
    if (!specs || !specs.length) return true;
    return specs.some((sp) => {
      const s = sp.replace(/^\.\//, '').replace(/\/$/, '');
      if (s === '' || s === '.') return true;
      if (isGlob(s)) return globRe(s).test(f);
      return f === s || f.startsWith(s + '/');
    });
  }
  function pathKnown(st, p) {
    const s = p.replace(/^\.\//, '').replace(/\/$/, '');
    if (s === '.' || s === '') return true;
    if (isGlob(s)) return true;
    const trees = [headTree(st)];
    return trees.some((t) => Object.keys(t).some((f) => f === s || f.startsWith(s + '/')));
  }

  // rev / range list → set of ids
  function revSet(st, revs, opts) {
    opts = opts || {};
    const inc = [], exc = [];
    for (const r of revs) {
      if (r.includes('...')) fatal(`fatal: symmetric ranges (A...B) aren't supported in this sandbox; use A..B`);
      if (r.includes('..')) {
        const [a, b] = r.split('..');
        exc.push(resolveRev(st, a || 'HEAD'));
        inc.push(resolveRev(st, b || 'HEAD'));
      } else if (r.startsWith('^')) exc.push(resolveRev(st, r.slice(1)));
      else inc.push(resolveRev(st, r));
    }
    if (opts.all) inc.push(...allTips(st));
    if (!inc.length) {
      const h = headId(st);
      if (!h) fatal(`fatal: your current branch '${st.HEAD.ref}' does not have any commits yet`);
      inc.push(h);
    }
    const set = new Set();
    for (const i of inc) for (const a of ancestors(st, i)) set.add(a);
    for (const e of exc) for (const a of ancestors(st, e)) set.delete(a);
    return set;
  }

  /* ==== OUTPUT HELPERS ==== */
  function countStr(s, needle) {
    if (!s || !needle) return 0;
    let n = 0, i = 0;
    while ((i = s.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
    return n;
  }
  function countRe(s, re) {
    if (!s) return 0;
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let n = 0;
    for (const m of s.matchAll(g)) { n++; if (m[0] === '' ) break; }
    return n;
  }

  function fileDiff(path, a, b) {
    const out = [`diff --git a/${path} b/${path}`];
    if (a === undefined) out.push('new file mode 100644', '--- /dev/null', `+++ b/${path}`);
    else if (b === undefined) out.push('deleted file mode 100644', `--- a/${path}`, '+++ /dev/null');
    else out.push(`--- a/${path}`, `+++ b/${path}`);
    for (const h of makeHunks(splitLines(a), splitLines(b))) out.push(hunkHeader(h), ...h.lines);
    return out;
  }

  function treeDiff(ta, tb, paths) {
    const files = [...new Set([...Object.keys(ta), ...Object.keys(tb)])].sort().filter((f) => ta[f] !== tb[f] && pathMatches(paths, f));
    return files;
  }

  function numstat(a, b) {
    let add = 0, del = 0;
    for (const o of diffOps(splitLines(a), splitLines(b))) { if (o.t === '+') add++; else if (o.t === '-') del++; }
    return [add, del];
  }

  function statLines(ta, tb, files) {
    if (!files.length) return [];
    const rows = files.map((f) => [f, ...numstat(ta[f], tb[f])]);
    const w = Math.max(...rows.map((r) => r[0].length));
    const maxN = Math.max(...rows.map((r) => r[1] + r[2]));
    const nw = String(maxN).length;
    const scale = maxN > 40 ? 40 / maxN : 1;
    const out = rows.map(([f, a, d]) => ` ${f.padEnd(w)} | ${String(a + d).padStart(nw)} ${'+'.repeat(Math.ceil(a * scale))}${'-'.repeat(Math.ceil(d * scale))}`);
    const A = rows.reduce((s, r) => s + r[1], 0), D = rows.reduce((s, r) => s + r[2], 0);
    out.push(summaryLine(rows.length, A, D));
    return out;
  }
  function summaryLine(n, A, D) {
    let s = ` ${n} file${n === 1 ? '' : 's'} changed`;
    if (A) s += `, ${A} insertion${A === 1 ? '' : 's'}(+)`;
    if (D) s += `, ${D} deletion${D === 1 ? '' : 's'}(-)`;
    return s;
  }

  function mediumHeader(st, id, deco, label) {
    const c = st.commits[id];
    const d = deco && deco[id] ? ` (${deco[id].join(', ')})` : '';
    return [
      `${label || 'commit'} ${c.hash}${d}`,
      `Author: ${c.author}`,
      `Date:   ${fmtDate(c.date)}`,
      '',
      ...c.msg.split('\n').map((l) => (l ? '    ' + l : '')),
    ];
  }

  function formatCommit(st, id, fmt, deco) {
    const c = st.commits[id];
    const d = deco && deco[id] ? deco[id].join(', ') : '';
    const map = {
      H: c.hash, h: c.hash.slice(0, 7), an: authorName(c.author), ae: authorEmail(c.author),
      cn: authorName(c.author), ce: authorEmail(c.author),
      ad: fmtDate(c.date), as: c.date.slice(0, 10), ai: c.date + ':00 +0000', ar: relDate(st, c.date),
      cd: fmtDate(c.cdate), cs: c.cdate.slice(0, 10), cr: relDate(st, c.cdate),
      s: subject(c.msg), b: c.msg.split('\n').slice(2).join('\n'), B: c.msg,
      d: d ? ` (${d})` : '', D: d, n: '\n', '%': '%',
      p: c.parent ? short(st, c.parent) : '', P: c.parent ? st.commits[c.parent].hash : '',
    };
    return fmt.replace(/%(an|ae|ad|as|ai|ar|cn|ce|cd|cs|cr|H|h|s|b|B|d|D|n|p|P|%)/g, (_, k) => map[k]);
  }

  /* ==== COMMIT SELECTION (log / shortlog) ==== */
  function parseLogArgs(st, args, cmdName) {
    const o = {
      oneline: false, n: Infinity, authors: [], greps: [], icase: false, fixed: false, S: null, G: null,
      pickaxeRegex: false, all: false, reverse: false, patch: false, stat: false, nameOnly: false,
      nameStatus: false, format: null, since: null, until: null, graph: false, revs: [], paths: [],
      allMatch: false, invert: false, decorate: true, shortlog: { s: false, n: false, e: false },
    };
    let dashdash = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const need = () => { if (i + 1 >= args.length) fatal(`fatal: option '${a}' requires a value`); return args[++i]; };
      let m;
      if (dashdash) { o.paths.push(a); continue; }
      if (a === '--') { dashdash = true; continue; }
      if (a === '--oneline') o.oneline = true;
      else if (/^-\d+$/.test(a)) o.n = Number(a.slice(1));
      else if (a === '-n' || a === '--max-count') { const v = need(); if (!/^\d+$/.test(v)) fatal(`fatal: '${v}': not an integer`); o.n = Number(v); }
      else if ((m = a.match(/^-n(\d+)$/)) || (m = a.match(/^--max-count=(\d+)$/))) o.n = Number(m[1]);
      else if (a === '--author' || a === '--committer') o.authors.push(need());
      else if ((m = a.match(/^--(?:author|committer)=([\s\S]*)$/))) o.authors.push(m[1]);
      else if (a === '--grep') o.greps.push(need());
      else if ((m = a.match(/^--grep=([\s\S]*)$/))) o.greps.push(m[1]);
      else if (a === '-i' || a === '--regexp-ignore-case') o.icase = true;
      else if (a === '-F' || a === '--fixed-strings') o.fixed = true;
      else if (['-E', '--extended-regexp', '-P', '--perl-regexp', '--basic-regexp'].includes(a)) { /* JS regex either way */ }
      else if (a === '--all-match') o.allMatch = true;
      else if (a === '--invert-grep') o.invert = true;
      else if (a === '-S') o.S = need();
      else if (a.startsWith('-S')) o.S = a.slice(2);
      else if (a === '-G') o.G = need();
      else if (a.startsWith('-G')) o.G = a.slice(2);
      else if (a === '--pickaxe-regex') o.pickaxeRegex = true;
      else if (a === '--all' || a === '--branches') o.all = true;
      else if (a === '--reverse') o.reverse = true;
      else if (a === '-p' || a === '--patch' || a === '-u') o.patch = true;
      else if (a === '--stat') o.stat = true;
      else if (a === '--name-only') o.nameOnly = true;
      else if (a === '--name-status') o.nameStatus = true;
      else if ((m = a.match(/^--(?:pretty|format)=([\s\S]*)$/))) o.format = m[1];
      else if (a === '--pretty' || a === '--format') o.format = need();
      else if ((m = a.match(/^--(?:since|after)=([\s\S]*)$/))) o.since = parseDate(st, m[1]);
      else if (a === '--since' || a === '--after') o.since = parseDate(st, need());
      else if ((m = a.match(/^--(?:until|before)=([\s\S]*)$/))) o.until = parseDate(st, m[1]);
      else if (a === '--until' || a === '--before') o.until = parseDate(st, need());
      else if (a === '--graph') o.graph = true;
      else if (a === '--no-decorate') o.decorate = false;
      else if (a === '--decorate' || /^--decorate=/.test(a)) o.decorate = true;
      else if (['--no-merges', '--first-parent', '--abbrev-commit', '--date-order', '--topo-order', '--color', '--no-color', '--follow', '--no-abbrev-commit', '--no-pager', '--full-history'].includes(a) || /^--date=/.test(a) || /^--color=/.test(a)) { /* no-op here */ }
      else if (cmdName === 'shortlog' && /^-[sne]+$/.test(a)) { for (const ch of a.slice(1)) o.shortlog[ch] = true; }
      else if (cmdName === 'shortlog' && ['--summary', '--numbered', '--email'].includes(a)) o.shortlog[a[2]] = true;
      else if (a === '-L' || a.startsWith('-L')) fatal(`fatal: this sandbox doesn't support 'git log -L'. Try 'git blame -L <start>,<end> <file>' instead.`);
      else if (a === '-g' || a === '--walk-reflogs') fatal(`fatal: use 'git reflog' to walk the reflog in this sandbox.`);
      else if (a.startsWith('-')) fatal(`fatal: unrecognized argument: ${a}`);
      else if (a.includes('..') || a.startsWith('^') || tryRev(st, a)) o.revs.push(a);
      else if (pathKnown(st, a)) o.paths.push(a);
      else resolveRev(st, a); // throws Git's "ambiguous argument" error
    }
    return o;
  }

  function selectCommits(st, o) {
    const set = revSet(st, o.revs, { all: o.all });
    let ids = sortedIds(st, set);
    const authorRes = o.authors.map((p) => mkRegex(p, o.icase, o.fixed));
    const grepRes = o.greps.map((p) => mkRegex(p, o.icase, o.fixed));
    const sNeedle = o.S;
    const sRe = o.S != null && o.pickaxeRegex ? mkRegex(o.S, o.icase, false) : null;
    const gRe = o.G != null ? mkRegex(o.G, o.icase, false) : null;
    if (o.S === '') fatal('fatal: -S requires a string');
    ids = ids.filter((id) => {
      const c = st.commits[id];
      if (o.since && c.cdate < o.since) return false;
      if (o.until && c.cdate > o.until) return false;
      if (authorRes.length && !authorRes.some((r) => r.test(c.author))) return false;
      if (grepRes.length) {
        const hit = o.allMatch ? grepRes.every((r) => r.test(c.msg)) : grepRes.some((r) => r.test(c.msg));
        if (hit === o.invert) return false;
      }
      if (o.paths.length || o.S != null || gRe) {
        const files = changedFiles(st, c).filter((f) => pathMatches(o.paths, f));
        if (!files.length) return false;
        const pt = parentTree(st, c);
        if (o.S != null) {
          const cnt = sRe ? (s) => countRe(s, sRe) : (s) => countStr(o.icase ? (s || '').toLowerCase() : s, o.icase ? sNeedle.toLowerCase() : sNeedle);
          if (!files.some((f) => cnt(pt[f]) !== cnt(c.tree[f]))) return false;
        }
        if (gRe) {
          const touched = files.some((f) => diffOps(splitLines(pt[f]), splitLines(c.tree[f])).some((op) =>
            (op.t === '-' && gRe.test(splitLines(pt[f])[op.a])) || (op.t === '+' && gRe.test(splitLines(c.tree[f])[op.b]))));
          if (!touched) return false;
        }
      }
      return true;
    });
    if (ids.length > o.n) ids = ids.slice(0, o.n);
    if (o.reverse) ids.reverse();
    return ids;
  }

  /* ==== GIT LOG ==== */
  function cmdLog(st, args) {
    const o = parseLogArgs(st, args, 'log');
    const ids = selectCommits(st, o);
    const deco = o.decorate ? decorations(st) : null;
    const out = [];
    const gp = (s, first) => (o.graph ? (first ? '* ' : '| ') + s : s);
    ids.forEach((id, idx) => {
      const c = st.commits[id];
      const block = [];
      let fmt = o.format;
      if (fmt) fmt = fmt.replace(/^(t?format:)/, '');
      if (o.oneline || fmt === 'oneline') {
        const d = deco && deco[id] ? `(${deco[id].join(', ')}) ` : '';
        block.push(`${o.oneline ? c.hash.slice(0, 7) : c.hash} ${d}${subject(c.msg)}`);
      } else if (fmt && !['medium', 'full', 'fuller', 'short', 'raw'].includes(fmt)) {
        block.push(...formatCommit(st, id, fmt, deco).split('\n'));
      } else if (fmt === 'short') {
        const d = deco && deco[id] ? ` (${deco[id].join(', ')})` : '';
        block.push(`commit ${c.hash}${d}`, `Author: ${c.author}`, '', `    ${subject(c.msg)}`);
        if (idx < ids.length - 1 || o.patch || o.stat) block.push('');
      } else {
        block.push(...mediumHeader(st, id, deco));
        if (idx < ids.length - 1 || o.patch || o.stat || o.nameOnly || o.nameStatus) block.push('');
      }
      const pt = parentTree(st, c);
      const files = treeDiff(pt, c.tree, o.paths.length ? o.paths : null);
      if (o.stat) { block.push(...statLines(pt, c.tree, files)); if (idx < ids.length - 1) block.push(''); }
      if (o.nameOnly) { block.push(...files); if (idx < ids.length - 1 && !(o.oneline || fmt)) block.push(''); }
      if (o.nameStatus) { block.push(...files.map((f) => `${pt[f] === undefined ? 'A' : c.tree[f] === undefined ? 'D' : 'M'}\t${f}`)); }
      if (o.patch) { for (const f of files) block.push(...fileDiff(f, pt[f], c.tree[f])); if (idx < ids.length - 1) block.push(''); }
      block.forEach((l, k) => out.push(gp(l, k === 0)));
    });
    return { out: out.join('\n'), items: { kind: 'commits', list: ids } };
  }

  function cmdShortlog(st, args) {
    const o = parseLogArgs(st, args, 'shortlog');
    const ids = selectCommits(st, o);
    const groups = new Map();
    for (const id of ids) {
      const c = st.commits[id];
      const key = o.shortlog.e ? c.author : authorName(c.author);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(id);
    }
    let rows = [...groups.entries()];
    rows.sort((a, b) => (o.shortlog.n ? b[1].length - a[1].length : 0) || a[0].localeCompare(b[0]));
    const out = [];
    for (const [who, list] of rows) {
      if (o.shortlog.s) out.push(`${String(list.length).padStart(6)}\t${who}`);
      else {
        out.push(`${who} (${list.length}):`);
        for (const id of [...list].reverse()) out.push(`      ${subject(st.commits[id].msg)}`);
        out.push('');
      }
    }
    return { out: out.join('\n').replace(/\n+$/, ''), items: { kind: 'commits', list: ids } };
  }

  /* ==== GIT SHOW / DIFF ==== */
  function cmdShow(st, args) {
    let stat = false, nameOnly = false, noPatch = false, oneline = false, fmt = null;
    const revs = [];
    let m;
    for (const a of args) {
      if (a === '--stat') stat = true;
      else if (a === '--name-only') nameOnly = true;
      else if (a === '-s' || a === '--no-patch') noPatch = true;
      else if (a === '--oneline') oneline = true;
      else if ((m = a.match(/^--(?:pretty|format)=([\s\S]*)$/))) fmt = m[1].replace(/^t?format:/, '');
      else if (['--no-color', '--color', '-p', '--patch'].includes(a) || /^--date=/.test(a)) { /* default */ }
      else if (a.startsWith('-')) fatal(`fatal: unrecognized argument: ${a}`);
      else revs.push(a);
    }
    if (!revs.length) revs.push('HEAD');
    const deco = decorations(st);
    const out = [], shown = [];
    revs.forEach((r, k) => {
      if (k) out.push('');
      const ci = r.indexOf(':');
      if (ci > 0 || ci === 0) {
        const id = ci === 0 ? headId(st) : resolveRev(st, r.slice(0, ci));
        const p = r.slice(ci + 1).replace(/^\.\//, '');
        const t = st.commits[id].tree;
        if (t[p] === undefined) {
          const dir = Object.keys(t).filter((f) => f.startsWith(p.replace(/\/$/, '') + '/'));
          if (dir.length) { out.push(`tree ${r}`, '', ...listDir(t, p)); return; }
          fatal(`fatal: path '${p}' does not exist in '${r.slice(0, ci) || 'HEAD'}'`);
        }
        out.push(...splitLines(t[p]));
        return;
      }
      const id = resolveRev(st, r);
      shown.push(id);
      const c = st.commits[id];
      if (oneline) out.push(`${c.hash.slice(0, 7)} ${deco[id] ? '(' + deco[id].join(', ') + ') ' : ''}${subject(c.msg)}`);
      else if (fmt) out.push(...formatCommit(st, id, fmt, deco).split('\n'));
      else out.push(...mediumHeader(st, id, deco));
      if (noPatch) return;
      const pt = parentTree(st, c);
      const files = treeDiff(pt, c.tree);
      if (!files.length) return;
      if (!oneline && !fmt) out.push('');
      if (stat) out.push(...statLines(pt, c.tree, files));
      else if (nameOnly) out.push(...files);
      else for (const f of files) out.push(...fileDiff(f, pt[f], c.tree[f]));
    });
    return { out: out.join('\n'), items: { kind: 'commits', list: shown } };
  }

  function cmdDiff(st, args) {
    let stat = false, nameOnly = false, dashdash = false;
    const revs = [], paths = [];
    for (const a of args) {
      if (dashdash) { paths.push(a); continue; }
      if (a === '--') dashdash = true;
      else if (a === '--stat') stat = true;
      else if (a === '--name-only') nameOnly = true;
      else if (['--cached', '--staged'].includes(a)) { /* nothing staged */ }
      else if (a.startsWith('-')) fatal(`fatal: unrecognized argument: ${a}`);
      else if (a.includes('..') || tryRev(st, a)) revs.push(a);
      else if (pathKnown(st, a)) paths.push(a);
      else resolveRev(st, a);
    }
    let A, B;
    if (!revs.length) return { out: '' };
    if (revs.length === 1 && revs[0].includes('..')) {
      const [a, b] = revs[0].split('..');
      A = resolveRev(st, a || 'HEAD'); B = resolveRev(st, b || 'HEAD');
    } else if (revs.length === 1) { A = resolveRev(st, revs[0]); B = headId(st); }
    else { A = resolveRev(st, revs[0]); B = resolveRev(st, revs[1]); }
    const ta = st.commits[A].tree, tb = st.commits[B].tree;
    const files = treeDiff(ta, tb, paths);
    if (stat) return { out: statLines(ta, tb, files).join('\n') };
    if (nameOnly) return { out: files.join('\n') };
    const out = [];
    for (const f of files) out.push(...fileDiff(f, ta[f], tb[f]));
    return { out: out.join('\n') };
  }

  /* ==== GIT BLAME ==== */
  const FUNC_LINE = /^[A-Za-z_$]/;

  function parseLineRange(spec, lines, fromLine) {
    const findRe = (src, start) => {
      const re = mkRegex(src, false, false);
      for (let i = start; i < lines.length; i++) if (re.test(lines[i])) return i;
      return -1;
    };
    if (spec.startsWith(':')) {
      const re = mkRegex(spec.slice(1), false, false);
      let s = -1;
      for (let i = 0; i < lines.length; i++) if (FUNC_LINE.test(lines[i]) && re.test(lines[i])) { s = i; break; }
      if (s < 0) fatal(`fatal: -L parameter '${spec.slice(1)}': no match`);
      let e = lines.length - 1;
      for (let j = s + 1; j < lines.length; j++) if (FUNC_LINE.test(lines[j])) { e = j - 1; break; }
      return [s, e];
    }
    // split "start,end" where either side may be /regex/
    let startTok, endTok = '';
    if (spec.startsWith('/')) {
      let k = 1;
      while (k < spec.length && spec[k] !== '/') { if (spec[k] === '\\') k++; k++; }
      startTok = spec.slice(0, k + 1);
      const rest = spec.slice(k + 1);
      if (rest && rest[0] !== ',') fatal(`fatal: -L argument not 'start,end': ${spec}`);
      endTok = rest.slice(1);
    } else {
      const c = spec.indexOf(',');
      startTok = c < 0 ? spec : spec.slice(0, c);
      endTok = c < 0 ? '' : spec.slice(c + 1);
    }
    let s;
    if (/^\d+$/.test(startTok)) {
      s = Number(startTok) - 1;
      if (s < 0) fatal(`fatal: -L invalid line number: 0`);
      if (s >= lines.length) fatal(`fatal: file has only ${lines.length} line${lines.length === 1 ? '' : 's'}`);
    } else if (/^\/.*\/$/.test(startTok) && startTok.length > 1) {
      s = findRe(startTok.slice(1, -1), fromLine || 0);
      if (s < 0) fatal(`fatal: -L parameter '${startTok.slice(1, -1)}' starting at line ${(fromLine || 0) + 1}: no match`);
    } else fatal(`fatal: -L argument not 'start,end': ${spec}`);
    let e;
    if (endTok === '') e = lines.length - 1;
    else if (/^\+\d+$/.test(endTok)) e = s + Number(endTok.slice(1)) - 1;
    else if (/^-\d+$/.test(endTok)) { e = s; s = Math.max(0, s - Number(endTok.slice(1)) + 1); }
    else if (/^\d+$/.test(endTok)) e = Number(endTok) - 1;
    else if (/^\/.*\/$/.test(endTok) && endTok.length > 1) {
      e = findRe(endTok.slice(1, -1), s + 1);
      if (e < 0) fatal(`fatal: -L parameter '${endTok.slice(1, -1)}' starting at line ${s + 2}: no match`);
    } else fatal(`fatal: -L argument not 'start,end': ${spec}`);
    if (e < s) [s, e] = [e, s];
    e = Math.min(e, lines.length - 1);
    return [s, e];
  }

  function blameLines(st, startId, path, opts) {
    const memo = new Map();
    const strip = (x) => x.replace(/\s+/g, '');
    const eq = opts.w ? (x, y) => strip(x) === strip(y) : null;
    function go(id) {
      if (memo.has(id)) return memo.get(id);
      const c = st.commits[id];
      const lines = splitLines(c.tree[path]);
      let res;
      const p = c.parent ? st.commits[c.parent] : null;
      if (!p || p.tree[path] === undefined) res = lines.map(() => id);
      else if (p.tree[path] === c.tree[path]) res = go(p.id);
      else {
        const pres = go(p.id);
        const pl = splitLines(p.tree[path]);
        const ops = diffOps(pl, lines, eq);
        res = new Array(lines.length);
        const ignored = opts.ignore && opts.ignore.has(id);
        let k = 0;
        while (k < ops.length) {
          const o = ops[k];
          if (o.t === '=') { res[o.b] = pres[o.a]; k++; continue; }
          const dels = [], adds = [];
          while (k < ops.length && ops[k].t !== '=') { (ops[k].t === '-' ? dels : adds).push(ops[k]); k++; }
          adds.forEach((ad, n) => { res[ad.b] = ignored && dels[n] ? pres[dels[n].a] : id; });
        }
      }
      memo.set(id, res);
      return res;
    }
    return go(startId);
  }

  function cmdBlame(st, args) {
    let w = false, showEmail = false, longHash = false, suppress = false;
    const ranges = [], ignore = new Set(), pos = [];
    let dashdash = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const need = () => { if (i + 1 >= args.length) fatal(`fatal: option '${a}' requires a value`); return args[++i]; };
      let m;
      if (dashdash) { pos.push(a); continue; }
      if (a === '--') dashdash = true;
      else if (a === '-w') w = true;
      else if (a === '-e' || a === '--show-email') showEmail = true;
      else if (a === '-l') longHash = true;
      else if (a === '-s') suppress = true;
      else if (a === '-L') ranges.push(need());
      else if (a.startsWith('-L')) ranges.push(a.slice(2));
      else if (a === '--ignore-rev') ignore.add(resolveRev(st, need()));
      else if ((m = a.match(/^--ignore-rev=(.+)$/))) ignore.add(resolveRev(st, m[1]));
      else if (a === '--ignore-revs-file' || a.startsWith('--ignore-revs-file')) fatal(`fatal: use --ignore-rev <commit> in this sandbox`);
      else if (['--root', '--no-color', '--color-lines', '--date=short', '-C', '-M'].includes(a)) { /* accepted */ }
      else if (a.startsWith('-')) fatal(`fatal: unrecognized argument: ${a}`);
      else pos.push(a);
    }
    if (!pos.length) fatal('usage: git blame [<options>] [<rev>] [--] <file>');
    if (pos.length > 2) fatal('fatal: too many arguments: git blame [<rev>] [--] <file>');
    const file = pos[pos.length - 1].replace(/^\.\//, '');
    const rev = pos.length === 2 ? pos[0] : 'HEAD';
    const id = resolveRev(st, rev);
    const content = st.commits[id].tree[file];
    if (content === undefined) fatal(`fatal: no such path '${file}' in ${rev}`);
    const lines = splitLines(content);
    const owners = blameLines(st, id, file, { w, ignore });
    let picks = [];
    if (!ranges.length) picks = lines.map((_, i) => i);
    else {
      let from = 0;
      for (const r of ranges) {
        const [s, e] = parseLineRange(r, lines, from);
        for (let i = s; i <= e; i++) if (!picks.includes(i)) picks.push(i);
        from = e + 1;
      }
      picks.sort((a, b) => a - b);
    }
    const who = (cid) => (showEmail ? `<${authorEmail(st.commits[cid].author)}>` : authorName(st.commits[cid].author));
    const aw = Math.max(...picks.map((i) => who(owners[i]).length));
    const nw = String(lines.length).length;
    const out = picks.map((i) => {
      const c = st.commits[owners[i]];
      const root = !c.parent;
      const h = longHash ? c.hash : root ? '^' + c.hash.slice(0, 7) : c.hash.slice(0, 8);
      if (suppress) return `${h} ${String(i + 1).padStart(nw)}) ${lines[i]}`;
      return `${h} (${who(owners[i]).padEnd(aw)} ${c.date} ${String(i + 1).padStart(nw)}) ${lines[i]}`;
    });
    return { out: out.join('\n'), items: { kind: 'blame', list: picks.map((i) => `${i + 1}:${owners[i]}`) } };
  }

  /* ==== HEAD MOVEMENT ==== */
  function checkoutTo(st, target, reflogMsgFrom) {
    // target: {ref} | {det}
    const fromName = reflogMsgFrom || (st.HEAD.ref ? st.HEAD.ref : st.HEAD.det ? st.commits[st.HEAD.det].hash.slice(0, 7) : '');
    const id = target.ref ? st.heads[target.ref] : target.det;
    st.HEAD = target.ref ? { ref: target.ref } : { det: target.det };
    const toName = target.ref || st.commits[id].hash.slice(0, 7);
    if (id) logRef(st, id, `checkout: moving from ${fromName} to ${toName}`);
  }

  function cmdCheckout(st, args, isSwitch) {
    const name = isSwitch ? 'switch' : 'checkout';
    let create = null, force = false, detach = false;
    const pos = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if ((!isSwitch && (a === '-b' || a === '-B')) || (isSwitch && (a === '-c' || a === '-C' || a === '--create' || a === '--force-create'))) {
        if (i + 1 >= args.length) fatal(`error: switch \`${a.replace(/^-+/, '')}' requires a value`);
        create = args[++i]; force = a === '-B' || a === '-C' || a === '--force-create';
      } else if (a === '--detach' || (isSwitch && a === '-d')) detach = true;
      else if (a === '--') fatal(`sandbox: there are no working-tree changes to discard here — every file already matches HEAD.`);
      else if (a === '-f' || a === '--force' || a === '-q' || a === '--quiet') { /* fine */ }
      else if (a.startsWith('-') && a !== '-') fatal(`error: unknown option \`${a.replace(/^-+/, '')}'`);
      else pos.push(a);
    }
    const before = headId(st);
    if (create) {
      validBranchName(create);
      if (st.heads[create] && !force) fatal(`fatal: a branch named '${create}' already exists`);
      const start = pos[0] ? resolveRev(st, pos[0]) : before;
      if (!start) fatal(`fatal: not a valid object name: 'HEAD'`);
      st.heads[create] = start;
      checkoutTo(st, { ref: create });
      track(st, `${name} ${create}`);
      return { out: `Switched to a new branch '${create}'` };
    }
    if (!pos.length) {
      if (isSwitch) fatal('fatal: missing branch or commit argument');
      return { out: st.HEAD.ref ? `Your branch is up to date.` : '' };
    }
    let t = pos[0];
    if (t === '-') {
      const prev = [...st.reflog].reverse().find((e) => /^checkout: moving from /.test(e.msg));
      if (!prev) fatal(`error: no previous branch`);
      t = prev.msg.replace(/^checkout: moving from (\S+) to .*$/, '$1');
      if (st.byHash[t]) t = t.slice(0, 7);
    }
    if (st.heads[t] && !detach) {
      if (st.HEAD.ref === t) return { out: `Already on '${t}'` };
      checkoutTo(st, { ref: t });
      track(st, `${name} ${t}`);
      return { out: `Switched to branch '${t}'` };
    }
    const id = resolveRev(st, t);
    if (isSwitch && !detach) {
      fatal(`fatal: a branch is expected, got ${st.tags[t] ? `tag '${t}'` : `commit '${t}'`}\nhint: If you want to detach HEAD at the commit, try again with the --detach option.`);
    }
    const wasDet = !st.HEAD.ref;
    checkoutTo(st, { det: id });
    track(st, `${name} ${t}`);
    const c = st.commits[id];
    const lines = [];
    if (!wasDet) {
      lines.push(`Note: switching to '${t}'.`, '', `You are in 'detached HEAD' state. You can look around, make experimental`, `changes and commit them, and you can discard any commits you make in this`, `state without impacting any branches by switching back to a branch.`, '');
    } else if (before && before !== id) {
      lines.push(`Previous HEAD position was ${short(st, before)} ${subject(st.commits[before].msg)}`);
    }
    lines.push(`HEAD is now at ${c.hash.slice(0, 7)} ${subject(c.msg)}`);
    return { out: lines.join('\n') };
  }

  function validBranchName(n) {
    if (!/^[A-Za-z0-9._\/-]+$/.test(n) || n.startsWith('-') || n.includes('..') || n.endsWith('/') || n === 'HEAD') {
      fatal(`fatal: '${n}' is not a valid branch name`);
    }
  }

  function track(st, text) { if (!st.building) st.moves.push(text); }

  function cmdReset(st, args) {
    let mode = 'mixed';
    const pos = [];
    for (const a of args) {
      if (a === '--hard' || a === '--soft' || a === '--mixed' || a === '--keep' || a === '--merge') mode = a.slice(2);
      else if (a === '-q' || a === '--quiet') { /* */ }
      else if (a === '--') fatal(`sandbox: there's no index here, so there is nothing to unstage.`);
      else if (a.startsWith('-')) fatal(`error: unknown option \`${a.replace(/^-+/, '')}'`);
      else pos.push(a);
    }
    if (pos.length > 1) fatal(`fatal: only one commit can be given to git reset in this sandbox`);
    const spec = pos[0] || 'HEAD';
    const id = resolveRev(st, spec);
    const old = headId(st);
    st.origHead = old;
    setHeadTo(st, id);
    logRef(st, id, `reset: moving to ${spec}`);
    track(st, `reset --${mode} ${spec}`);
    const c = st.commits[id];
    const lines = [];
    if (mode === 'hard' || mode === 'keep' || mode === 'merge') lines.push(`HEAD is now at ${c.hash.slice(0, 7)} ${subject(c.msg)}`);
    else lines.push(`[sandbox] This sandbox has no index or working-tree changes, so --${mode} moved the branch exactly like --hard would.`, `HEAD is now at ${c.hash.slice(0, 7)} ${subject(c.msg)}`);
    return { out: lines.join('\n') };
  }

  /* ==== BRANCH / TAG ==== */
  function cmdBranch(st, args) {
    let del = null, forceDel = false, forceMove = false, verbose = false, contains = null, showCurrent = false, rename = false;
    const pos = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-d' || a === '--delete') del = true;
      else if (a === '-D') { del = true; forceDel = true; }
      else if (a === '-f' || a === '--force') { forceMove = true; forceDel = true; }
      else if (a === '-v' || a === '-vv' || a === '--verbose') verbose = true;
      else if (a === '-a' || a === '--all' || a === '-l' || a === '--list' || a === '-r') { /* list */ }
      else if (a === '--contains') { contains = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : 'HEAD'; }
      else if (a.startsWith('--contains=')) contains = a.slice(11);
      else if (a === '--show-current') showCurrent = true;
      else if (a === '-m' || a === '-M' || a === '--move') rename = true;
      else if (a.startsWith('-')) fatal(`error: unknown option \`${a.replace(/^-+/, '')}'`);
      else pos.push(a);
    }
    if (showCurrent) return { out: st.HEAD.ref || '' };
    if (rename) {
      const [from, to] = pos.length === 2 ? pos : [st.HEAD.ref, pos[0]];
      if (!from || !st.heads[from]) fatal(`error: refname ${from} not found`);
      validBranchName(to);
      if (st.heads[to]) fatal(`fatal: a branch named '${to}' already exists`);
      st.heads[to] = st.heads[from]; delete st.heads[from];
      if (st.HEAD.ref === from) st.HEAD = { ref: to };
      track(st, `branch -m ${from} ${to}`);
      return { out: '' };
    }
    if (del) {
      if (!pos.length) fatal('fatal: branch name required');
      const out = [];
      for (const n of pos) {
        if (!st.heads[n]) fatal(`error: branch '${n}' not found`);
        if (st.HEAD.ref === n) fatal(`error: cannot delete branch '${n}' used by worktree at '/home/oncall/kettlebird-shop'`);
        const h = headId(st);
        if (!forceDel && (!h || !isAncestor(st, st.heads[n], h))) {
          fatal(`error: the branch '${n}' is not fully merged.\nhint: If you are sure you want to delete it, run 'git branch -D ${n}'`);
        }
        out.push(`Deleted branch ${n} (was ${short(st, st.heads[n])}).`);
        delete st.heads[n];
        track(st, `branch -D ${n}`);
      }
      return { out: out.join('\n') };
    }
    if (pos.length && !contains) {
      const [n, start] = pos;
      validBranchName(n);
      if (st.heads[n] && !forceMove) fatal(`fatal: a branch named '${n}' already exists`);
      if (st.heads[n] && st.HEAD.ref === n) fatal(`fatal: cannot force update the branch '${n}' used by worktree at '/home/oncall/kettlebird-shop'`);
      const id = start ? resolveRev(st, start) : headId(st);
      if (!id) fatal(`fatal: not a valid object name: 'HEAD'`);
      st.heads[n] = id;
      track(st, `branch ${forceMove ? '-f ' : ''}${n}${start ? ' ' + start : ''}`);
      return { out: '' };
    }
    // list
    let names = Object.keys(st.heads).sort();
    if (contains) {
      const cid = resolveRev(st, contains);
      names = names.filter((n) => isAncestor(st, cid, st.heads[n]));
    }
    const out = [];
    const width = Math.max(0, ...names.map((n) => n.length));
    if (!st.HEAD.ref && (!contains || isAncestor(st, resolveRev(st, contains), st.HEAD.det))) {
      const lbl = st.bisect ? `(no branch, bisect started on ${st.bisect.startName})` : `(HEAD detached at ${short(st, st.HEAD.det)})`;
      out.push(`* ${lbl}`);
    }
    for (const n of names) {
      const cur = st.HEAD.ref === n ? '* ' : '  ';
      if (verbose) {
        const id = st.heads[n];
        out.push(`${cur}${n.padEnd(width)} ${short(st, id)} ${subject(st.commits[id].msg)}`);
      } else out.push(cur + n);
    }
    return { out: out.join('\n') };
  }

  function cmdTag(st, args) {
    const pos = args.filter((a) => !a.startsWith('-'));
    if (args.includes('-d')) {
      for (const n of pos) { if (!st.tags[n]) fatal(`error: tag '${n}' not found.`); delete st.tags[n]; }
      track(st, `tag -d ${pos.join(' ')}`);
      return { out: '' };
    }
    if (!pos.length || args.includes('-l') || args.includes('--list')) return { out: Object.keys(st.tags).sort().join('\n') };
    const [n, rev] = pos;
    if (st.tags[n]) fatal(`fatal: tag '${n}' already exists`);
    st.tags[n] = rev ? resolveRev(st, rev) : headId(st);
    track(st, `tag ${n}`);
    return { out: '' };
  }

  /* ==== REFLOG ==== */
  function cmdReflog(st, args) {
    let n = Infinity;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      let m;
      if (a === 'show' || a === 'HEAD' || a === '--oneline' || a === '--all') continue;
      if (a === '-n') n = Number(args[++i]);
      else if ((m = a.match(/^-n?(\d+)$/))) n = Number(m[1]);
      else if (a === 'expire' || a === 'delete') fatal(`sandbox: nice try — the reflog is evidence. It stays.`);
      else if (st.heads[a]) fatal(`sandbox: this sandbox only keeps a reflog for HEAD. Run 'git reflog' on its own.`);
      else fatal(`fatal: unrecognized argument: ${a}`);
    }
    const deco = decorations(st);
    const rows = [], ids = [];
    for (let k = 0; k < Math.min(n, st.reflog.length); k++) {
      const e = st.reflog[st.reflog.length - 1 - k];
      const d = deco[e.id] ? `(${deco[e.id].join(', ')}) ` : '';
      rows.push(`${short(st, e.id)} ${d}HEAD@{${k}}: ${e.msg}`);
      ids.push(e.id);
    }
    return { out: rows.join('\n'), items: { kind: 'reflog', list: ids } };
  }

  /* ==== CHERRY-PICK ==== */
  function pickCommit(st, src) {
    // returns {tree, empty} or {conflict: [files]}
    const base = parentTree(st, src);
    const tgt = headTree(st);
    const tree = { ...tgt };
    const files = changedFiles(st, src);
    let changed = false;
    const conflicts = [];
    for (const f of files) {
      const b = base[f], r = src.tree[f], t = tgt[f];
      if (t === r) continue;
      if (t === b) { if (r === undefined) delete tree[f]; else tree[f] = r; changed = true; continue; }
      if (b === undefined || r === undefined || t === undefined) { conflicts.push(f); continue; }
      const res = applyPatch(b, r, t);
      if (res === null) { conflicts.push(f); continue; }
      if (res !== t) { tree[f] = res; changed = true; }
    }
    if (conflicts.length) return { conflict: conflicts };
    return { tree, empty: !changed };
  }

  function cmdCherryPick(st, args) {
    let x = false;
    const specs = [];
    for (const a of args) {
      if (a === '-x') x = true;
      else if (a === '--abort' || a === '--quit' || a === '--continue' || a === '--skip') fatal('error: no cherry-pick or revert in progress');
      else if (a === '-n' || a === '--no-commit') fatal(`sandbox: there's no index here, so -n/--no-commit isn't available.`);
      else if (a === '-m' || a.startsWith('--mainline')) fatal('error: there are no merge commits in this repository');
      else if (['-e', '--edit', '--ff', '--allow-empty', '--keep-redundant-commits', '-s', '--signoff'].includes(a)) { /* ok */ }
      else if (a.startsWith('-')) fatal(`error: unknown option \`${a.replace(/^-+/, '')}'`);
      else specs.push(a);
    }
    if (!specs.length) fatal('usage: git cherry-pick [<options>] <commit-ish>...');
    if (!headId(st)) fatal(`fatal: your current branch has no commits yet`);
    let list = [];
    for (const s of specs) {
      if (s.includes('..')) list.push(...sortedIds(st, revSet(st, [s])).reverse());
      else list.push(resolveRev(st, s));
    }
    if (!list.length) fatal('error: empty commit set passed');
    const out = [];
    for (const id of list) {
      const src = st.commits[id];
      const r = pickCommit(st, src);
      if (r.conflict) {
        out.push(`error: could not apply ${short(st, id)}... ${subject(src.msg)}`,
          `hint: After resolving the conflicts, mark them with`,
          `hint: "git add <pathspec>", then run "git cherry-pick --continue".`,
          ...r.conflict.map((f) => `CONFLICT (content): Merge conflict in ${f}`), '',
          `[sandbox] Conflict resolution isn't simulated, so this pick was rolled back${out.length ? ' (earlier picks in this command were kept)' : ''}.`,
          `[sandbox] The patch expects lines that aren't on this branch. Does it depend on an earlier commit?`);
        return { out: out.join('\n'), error: true };
      }
      if (r.empty) {
        out.push(`On ${st.HEAD.ref ? 'branch ' + st.HEAD.ref : 'detached HEAD'}`,
          `The previous cherry-pick is now empty: every change in ${short(st, id)} is already here.`,
          `[sandbox] Skipped ${short(st, id)}. Are you on the branch you meant to pick onto?`);
        continue;
      }
      st.seq++;
      const pid = `p${st.seq}`;
      const msg = src.msg + (x ? `\n\n(cherry picked from commit ${src.hash})` : '');
      const c = addCommit(st, { id: pid, parent: headId(st), author: src.author, date: src.date, cdate: addMinutes(st.now, st.seq), msg, tree: r.tree, pickedFrom: id });
      setHeadTo(st, pid);
      logRef(st, pid, `cherry-pick: ${subject(src.msg)}`);
      const pt = parentTree(st, c);
      const files = treeDiff(pt, c.tree);
      let A = 0, D = 0;
      for (const f of files) { const [a, d] = numstat(pt[f], c.tree[f]); A += a; D += d; }
      out.push(`[${st.HEAD.ref || 'detached HEAD'} ${c.hash.slice(0, 7)}] ${subject(msg)}`, ` Author: ${src.author}`, ` Date: ${fmtDate(src.date)}`, summaryLine(files.length, A, D));
    }
    track(st, `cherry-pick ${specs.join(' ')}`);
    return { out: out.join('\n') };
  }

  /* ==== BISECT ==== */
  function bisectCandidates(st) {
    const b = st.bisect;
    const set = ancestors(st, b.bad);
    for (const g of b.good) for (const a of ancestors(st, g)) set.delete(a);
    return set;
  }

  function bisectNext(st) {
    const b = st.bisect;
    if (!b.bad && !b.good.length) return 'status: waiting for both good and bad commits';
    if (!b.bad) return 'status: waiting for bad commit, ' + b.good.length + ' good commit' + (b.good.length > 1 ? 's' : '') + ' known';
    if (!b.good.length) return 'status: waiting for good commit(s), bad commit known';
    const cand = bisectCandidates(st);
    if (!cand.size || !cand.has(b.bad)) {
      return `Some good revs are not ancestors of the bad rev.\ngit bisect cannot work properly in this case.\nMaybe you mistook good and bad revs?`;
    }
    if (cand.size === 1) {
      const id = b.bad;
      b.done = id;
      st.bisectResult = id;
      st.bisectResultSteps = st.bisectSteps;
      st.bisectHistory.push(id);
      const c = st.commits[id];
      const files = changedFiles(st, c);
      return [`${c.hash} is the first bad commit`, ...mediumHeader(st, id, null), '', ...statLines(parentTree(st, c), c.tree, files)].join('\n');
    }
    const testable = sortedIds(st, cand).filter((id) => id !== b.bad && !b.skip.includes(id));
    if (!testable.length) {
      const left = sortedIds(st, cand).filter((id) => id === b.bad || b.skip.includes(id));
      b.done = 'ambiguous';
      st.bisectResult = null;
      return [`There are only 'skip'ped commits left to test.`, `The first bad commit could be any of:`, ...left.map((id) => st.commits[id].hash), `We cannot bisect more!`].join('\n');
    }
    const N = cand.size;
    let best = testable[0], bestScore = -1;
    for (const t of testable) {
      let nAnc = 0;
      for (const a of ancestors(st, t)) if (cand.has(a)) nAnc++;
      const score = Math.min(nAnc, N - nAnc);
      if (score > bestScore) { best = t; bestScore = score; }
    }
    b.current = best;
    const fromName = st.HEAD.ref || st.commits[st.HEAD.det].hash.slice(0, 7);
    if (headId(st) !== best || st.HEAD.ref) checkoutTo(st, { det: best }, fromName);
    const left = Math.max(0, Math.floor((N - 1) / 2));
    const steps = left > 0 ? Math.floor(Math.log2(left)) + 1 : 0;
    return `Bisecting: ${left} revision${left === 1 ? '' : 's'} left to test after this (roughly ${steps} step${steps === 1 ? '' : 's'})\n[${st.commits[best].hash}] ${subject(st.commits[best].msg)}`;
  }

  function bisectMark(st, kind, revs, viaRun) {
    const b = st.bisect;
    if (!b) fatal(`You need to start by "git bisect start"`);
    const ids = revs.length ? revs.map((r) => resolveRev(st, r)) : [headId(st)];
    if (!ids[0]) fatal('fatal: bad HEAD');
    const testing = b.bad && b.good.length && !b.done;
    for (const id of ids) {
      if (testing) st.bisectSteps++;
      if (kind === 'bad') b.bad = id;
      else if (kind === 'good') { if (!b.good.includes(id)) b.good.push(id); }
      else if (!b.skip.includes(id)) b.skip.push(id);
      b.log.push(`# ${kind}: [${st.commits[id].hash}] ${subject(st.commits[id].msg)}`, `git bisect ${kind} ${st.commits[id].hash}`);
    }
    if (b.done && b.done !== 'ambiguous') { /* re-marking after done: recompute */ }
    b.done = null;
    return bisectNext(st);
  }

  function cmdBisect(st, args) {
    const sub = args[0];
    const rest = args.slice(1);
    const alias = { new: 'bad', old: 'good' };
    const s = alias[sub] || sub;
    if (!s || s === 'help') {
      return { out: 'usage: git bisect [start|bad|good|skip|run|log|view|reset]\n\n  git bisect start [<bad> [<good>...]]\n  git bisect bad [<rev>]      (alias: new)\n  git bisect good [<rev>...]  (alias: old)\n  git bisect skip [<rev>...]\n  git bisect run <cmd>...\n  git bisect view | log | reset' };
    }
    if (s === 'start') {
      const notes = [];
      if (st.bisect) { const r = bisectReset(st); notes.push(r); }
      const pos = rest.filter((a) => a !== '--' && !a.startsWith('--'));
      const ids = pos.map((r) => resolveRev(st, r));
      const startName = st.HEAD.ref || short(st, st.HEAD.det);
      st.bisect = { start: st.HEAD.ref ? { ref: st.HEAD.ref } : { det: st.HEAD.det }, startName, bad: null, good: [], skip: [], log: [`git bisect start${pos.length ? ' ' + pos.map((p) => `'${p}'`).join(' ') : ''}`], done: null, current: null };
      st.bisectSteps = 0;
      track(st, `bisect start${pos.length ? ' ' + pos.join(' ') : ''}`);
      if (ids.length) {
        st.bisect.bad = ids[0];
        st.bisect.log.push(`# bad: [${st.commits[ids[0]].hash}] ${subject(st.commits[ids[0]].msg)}`, `git bisect bad ${st.commits[ids[0]].hash}`);
        for (const g of ids.slice(1)) {
          st.bisect.good.push(g);
          st.bisect.log.push(`# good: [${st.commits[g].hash}] ${subject(st.commits[g].msg)}`, `git bisect good ${st.commits[g].hash}`);
        }
      }
      const msg = bisectNext(st);
      return { out: [...notes.filter(Boolean), msg].join('\n') };
    }
    if (s === 'bad' || s === 'good' || s === 'skip') {
      const out = bisectMark(st, s, rest);
      track(st, `bisect ${s}${rest.length ? ' ' + rest.join(' ') : ''}`);
      return { out };
    }
    if (s === 'reset') {
      if (!st.bisect) return { out: 'We are not bisecting.' };
      const out = bisectReset(st, rest[0]);
      track(st, 'bisect reset');
      return { out };
    }
    if (s === 'log') {
      if (!st.bisect) fatal('error: We are not bisecting.');
      const extra = st.bisect.done && st.bisect.done !== 'ambiguous' ? [`# first bad commit: [${st.commits[st.bisect.done].hash}] ${subject(st.commits[st.bisect.done].msg)}`] : [];
      return { out: [...st.bisect.log, ...extra].join('\n') };
    }
    if (s === 'view' || s === 'visualize') {
      if (!st.bisect || !st.bisect.bad) fatal('error: We are not bisecting (or no bad commit is known yet).');
      const cand = bisectCandidates(st);
      const ids = sortedIds(st, cand);
      return { out: ids.map((id) => `${short(st, id)} ${subject(st.commits[id].msg)}${st.bisect.skip.includes(id) ? '  (skipped)' : ''}`).join('\n'), items: { kind: 'commits', list: ids } };
    }
    if (s === 'run') {
      if (!st.bisect) fatal(`You need to start by "git bisect start"`);
      if (!st.bisect.bad || !st.bisect.good.length) fatal(`git bisect run needs a known bad and at least one good commit first.\n(try: git bisect start <bad> <good>)`);
      if (!rest.length) fatal('bisect run failed: no command provided.');
      const cmd = rest.join(' ');
      const out = [];
      track(st, `bisect run ${cmd}`);
      for (let guard = 0; guard < 64 && !st.bisect.done; guard++) {
        const r = runScript(st, rest);
        if (r.notFound) { out.push(r.out, `bisect run failed:`, `'${cmd}' could not be run (exit code 127)`); return { out: out.join('\n'), error: true }; }
        out.push(`running  ${rest.map((t) => `'${t}'`).join(' ')}`);
        if (r.out) out.push(r.out);
        if (r.code >= 128 || r.code < 0) { out.push(`bisect run failed:`, `exit code ${r.code} from '${cmd}' is < 0 or >= 128`); return { out: out.join('\n'), error: true }; }
        const kind = r.code === 0 ? 'good' : r.code === 125 ? 'skip' : 'bad';
        out.push(bisectMark(st, kind, []));
      }
      if (st.bisect.done && st.bisect.done !== 'ambiguous') out.push('bisect found first bad commit');
      return { out: out.join('\n') };
    }
    if (s === 'terms') return { out: 'Your current terms are good for the old state\nand bad for the new state.' };
    fatal(`error: unknown bisect subcommand '${sub}'. Try 'git bisect help'.`);
  }

  function bisectReset(st, to) {
    const b = st.bisect;
    const before = headId(st);
    const target = to ? { det: resolveRev(st, to) } : b.start;
    st.bisect = null;
    checkoutTo(st, target);
    const id = headId(st);
    const lines = [];
    if (before && before !== id) lines.push(`Previous HEAD position was ${short(st, before)} ${subject(st.commits[before].msg)}`);
    lines.push(target.ref ? `Switched to branch '${target.ref}'` : `HEAD is now at ${short(st, id)} ${subject(st.commits[id].msg)}`);
    return lines.join('\n');
  }

  /* ==== SCRIPTS (npm test etc.) ==== */
  function normScript(toks) {
    let t = [...toks];
    if ((t[0] === 'sh' || t[0] === 'bash') && t[1]) t = t.slice(1);
    let s = t.join(' ');
    s = s.replace(/^(\.\/)?(scripts\/[\w.-]+\.sh)/, './$2');
    if (s === 'npm t' || s === 'npm run test') s = 'npm test';
    return s;
  }
  function runScript(st, toks) {
    const key = normScript(toks);
    const scripts = (st.def && st.def.scripts) || {};
    const fn = scripts[key];
    if (!fn) {
      if (/^npm (run )?/.test(key)) {
        const name = key.replace(/^npm (run )?/, '');
        return { code: 1, out: `npm ERR! Missing script: "${name}"\n\nnpm ERR! To see a list of scripts, run:\nnpm ERR!   npm run`, notFound: !Object.keys(scripts).length };
      }
      if (/^\.\/scripts\//.test(key) && headTree(st)[key.slice(2)] === undefined) return { code: 127, out: `bash: ${key}: No such file or directory`, notFound: true };
      return { code: 127, out: `bash: ${toks[0]}: command not found`, notFound: true };
    }
    const r = fn(headTree(st), { short: headId(st) ? short(st, headId(st)) : '' });
    return { code: r.code, out: r.out };
  }

  /* ==== SHELL BUILTINS ==== */
  function listDir(tree, dir) {
    const d = (dir || '').replace(/^\.\/?/, '').replace(/\/$/, '');
    const entries = new Set();
    for (const f of Object.keys(tree)) {
      if (d && !f.startsWith(d + '/')) continue;
      const rest = d ? f.slice(d.length + 1) : f;
      const k = rest.indexOf('/');
      entries.add(k < 0 ? rest : rest.slice(0, k + 1));
    }
    return [...entries].sort();
  }

  function cmdLs(st, args) {
    const tree = headTree(st);
    const pos = args.filter((a) => !a.startsWith('-'));
    const target = pos[0] || '';
    const d = target.replace(/^\.\/?/, '').replace(/\/$/, '');
    if (d && tree[d] !== undefined) return { out: d };
    const e = listDir(tree, d);
    if (d && !e.length) return { out: `ls: cannot access '${target}': No such file or directory`, error: true };
    return { out: e.join('  ') };
  }

  function cmdCat(st, args) {
    const tree = headTree(st);
    const num = args.includes('-n');
    const files = args.filter((a) => !a.startsWith('-'));
    if (!files.length) return { out: 'cat: missing file operand', error: true };
    const out = [];
    let n = 0;
    for (const f of files) {
      const p = f.replace(/^\.\//, '');
      if (tree[p] === undefined) {
        const isDir = Object.keys(tree).some((x) => x.startsWith(p.replace(/\/$/, '') + '/'));
        return { out: [...out, `cat: ${f}: ${isDir ? 'Is a directory' : 'No such file or directory'}`].join('\n'), error: true };
      }
      for (const l of splitLines(tree[p])) out.push(num ? `${String(++n).padStart(6)}\t${l}` : l);
    }
    return { out: out.join('\n') };
  }

  function searchTree(tree, pattern, opts, paths, prefix) {
    const re = mkRegex(pattern, opts.i, opts.F);
    const files = Object.keys(tree).sort().filter((f) => pathMatches(paths, f));
    const out = [];
    for (const f of files) {
      splitLines(tree[f]).forEach((l, k) => {
        const hit = opts.w ? new RegExp(`(^|\\W)(?:${re.source})(?=\\W|$)`, re.flags).test(l) : re.test(l);
        if (hit !== !!opts.v) {
          const parts = [];
          if (opts.multi) parts.push((prefix || '') + f);
          if (opts.n) parts.push(String(k + 1));
          parts.push(l);
          out.push(parts.join(':'));
        }
      });
    }
    return out;
  }

  function parseGrepArgs(args) {
    const opts = { n: false, i: false, F: false, w: false, v: false, r: false, l: false };
    const pos = [];
    let dashdash = false;
    for (const a of args) {
      if (dashdash) { pos.push(a); continue; }
      if (a === '--') { dashdash = true; pos.push('--'); continue; }
      if (/^-[nirRFwvlE]+$/.test(a)) { for (const ch of a.slice(1)) { if (ch === 'R') opts.r = true; else if (ch !== 'E') opts[ch] = true; } }
      else if (a.startsWith('-')) fatal(`grep: unknown option -- '${a}'`);
      else pos.push(a);
    }
    return { opts, pos };
  }

  function cmdShellGrep(st, args) {
    const { opts, pos } = parseGrepArgs(args);
    const p = pos.filter((x) => x !== '--');
    if (!p.length) return { out: 'usage: grep [-nirFwv] PATTERN FILE...', error: true };
    const pattern = p[0];
    let paths = p.slice(1);
    const tree = headTree(st);
    if (!paths.length) { if (!opts.r) return { out: 'grep: no file given (try grep -rn PATTERN .)', error: true }; paths = ['.']; }
    for (const x of paths) {
      const s = x.replace(/^\.\//, '').replace(/\/$/, '');
      const isDir = s === '.' || s === '' || Object.keys(tree).some((f) => f.startsWith(s + '/'));
      if (isDir && !opts.r) return { out: `grep: ${x}: Is a directory`, error: true };
      if (!isDir && tree[s] === undefined) return { out: `grep: ${x}: No such file or directory`, error: true };
    }
    opts.multi = opts.r || paths.length > 1;
    const out = searchTree(tree, pattern, opts, paths);
    st.lastExit = out.length ? 0 : 1;
    return { out: out.join('\n') };
  }

  function cmdGitGrep(st, args) {
    const { opts, pos } = parseGrepArgs(args);
    const dd = pos.indexOf('--');
    const before = dd < 0 ? pos : pos.slice(0, dd);
    let paths = dd < 0 ? [] : pos.slice(dd + 1);
    if (!before.length) fatal('fatal: no pattern given');
    const pattern = before[0];
    let rev = null;
    for (const x of before.slice(1)) { if (tryRev(st, x)) rev = x; else paths.push(x); }
    const id = rev ? resolveRev(st, rev) : headId(st);
    opts.multi = true;
    const out = searchTree(st.commits[id].tree, pattern, opts, paths, rev ? rev + ':' : '');
    return { out: out.join('\n') };
  }

  function cmdStatus(st) {
    const lines = [];
    if (st.HEAD.ref) lines.push(`On branch ${st.HEAD.ref}`);
    else lines.push(`HEAD detached at ${short(st, st.HEAD.det)}`);
    if (st.bisect) lines.push(`You are currently bisecting, started from ${st.bisect.start.ref ? `branch '${st.bisect.start.ref}'` : 'a detached HEAD'}.`, `  (use "git bisect reset" to get back to the original branch)`, '');
    lines.push('nothing to commit, working tree clean');
    return { out: lines.join('\n') };
  }

  function cmdRevParse(st, args) {
    const out = [];
    let shortMode = false, abbrev = false;
    for (const a of args) {
      if (a === '--short') shortMode = true;
      else if (a === '--abbrev-ref') abbrev = true;
      else if (a === '--show-toplevel') out.push('/home/oncall/kettlebird-shop');
      else if (a === '--is-inside-work-tree') out.push('true');
      else if (abbrev && (a === 'HEAD' || a === '@')) out.push(st.HEAD.ref || 'HEAD');
      else { const id = resolveRev(st, a); out.push(shortMode ? short(st, id) : st.commits[id].hash); }
    }
    return { out: out.join('\n') };
  }

  const HELP = [
    'Available in this sandbox:',
    '  git log [--oneline] [-n N] [--author=RE] [--grep=RE] [-i] [-S str] [-G RE]',
    '          [--since=DATE] [--until=DATE] [--all] [-p] [--stat] [--format=…] [REV|A..B] [-- PATH]',
    '  git show REV [--stat]         git show REV:PATH        git diff A B [-- PATH]',
    '  git blame [-w] [-L a,b | -L /re/,+n | -L :func] [--ignore-rev REV] [REV] FILE',
    '  git bisect start [BAD [GOOD]] | good | bad | skip | run CMD | view | log | reset',
    '  git reflog [-n N]             git shortlog [-sne]      git grep [-n] RE [REV]',
    '  git branch [-v] [-f] [-D] [NAME [START]]   git branch --contains REV',
    '  git checkout / git switch [-c] BRANCH      git checkout --detach REV',
    '  git reset --hard REV          git cherry-pick [-x] REV... | A..B',
    '  git status   git tag   git rev-parse REV',
    '  ls [DIR]   cat [-n] FILE   grep [-rni] RE PATH   npm test   clear',
    '',
    'Revisions: HEAD, HEAD~2, HEAD^, HEAD@{3}, ORIG_HEAD, a1b2c3d, main, v2.4.0, A..B',
    'No pipes (|) — use Git\'s own filters. Chain with && or ;',
  ].join('\n');

  const NOT_HERE = {
    commit: "sandbox: you're investigating, not writing code. (Need a commit on a branch? cherry-pick it.)",
    add: "sandbox: there's nothing to stage — the working tree always matches HEAD here.",
    push: 'sandbox: nobody pushes from an incident sandbox. File your evidence instead (Ctrl/Cmd+Enter).',
    pull: 'sandbox: this is an offline forensic copy of the repo — there is no remote.',
    fetch: 'sandbox: this is an offline forensic copy of the repo — there is no remote.',
    clone: 'sandbox: you already have the repo.',
    init: 'sandbox: you already have the repo.',
    merge: "sandbox: Kettlebird's release branches only take cherry-picks. Merging isn't available here.",
    rebase: 'sandbox: rebasing rewrites history. During an investigation we keep history as it is.',
    revert: "sandbox: git revert isn't simulated here. (In real life it's often the right call!)",
    stash: "sandbox: there's nothing to stash — the working tree is clean.",
    restore: 'sandbox: there are no working-tree changes to restore.',
    rm: 'sandbox: deleting files is out of scope for an investigation.',
    mv: 'sandbox: moving files is out of scope for an investigation.',
    'cat-file': "sandbox: try 'git show REV' or 'git show REV:path' instead.",
    fsck: "sandbox: 'git fsck --lost-found' isn't simulated. The reflog (git reflog) is your friend here.",
    gc: 'sandbox: garbage collection is disabled. Lost commits stay findable for the investigation.',
    worktree: "sandbox: worktrees aren't simulated.",
    remote: 'sandbox: this is an offline forensic copy of the repo — there is no remote.',
    config: 'sandbox: configuration is locked for this investigation.',
  };

  /* ==== DISPATCH ==== */
  const MUTATING = new Set(['checkout', 'switch', 'reset', 'cherry-pick', 'branch', 'tag', 'bisect']);

  function execGit(st, toks) {
    let i = 1;
    while (toks[i] === '--no-pager' || toks[i] === '-P' || toks[i] === '-c' || toks[i] === '-C') { if (toks[i] === '-c' || toks[i] === '-C') i++; i++; }
    const sub = toks[i];
    const args = toks.slice(i + 1);
    switch (sub) {
      case undefined: case 'help': case '--help': return { out: HELP };
      case '--version': case 'version': return { out: 'git version 2.47.0 (sandbox)' };
      case 'log': return cmdLog(st, args);
      case 'shortlog': return cmdShortlog(st, args);
      case 'show': return cmdShow(st, args);
      case 'diff': return cmdDiff(st, args);
      case 'blame': case 'annotate': return cmdBlame(st, args);
      case 'bisect': return cmdBisect(st, args);
      case 'reflog': return cmdReflog(st, args);
      case 'branch': return cmdBranch(st, args);
      case 'checkout': return cmdCheckout(st, args, false);
      case 'switch': return cmdCheckout(st, args, true);
      case 'reset': return cmdReset(st, args);
      case 'cherry-pick': return cmdCherryPick(st, args);
      case 'tag': return cmdTag(st, args);
      case 'status': return cmdStatus(st);
      case 'rev-parse': return cmdRevParse(st, args);
      case 'grep': return cmdGitGrep(st, args);
      default:
        if (NOT_HERE[sub]) return { out: NOT_HERE[sub], error: true };
        return { out: `git: '${sub}' is not a git command. See 'git help'.`, error: true };
    }
  }

  function execOne(st, text) {
    const toks = tokenize(text);
    if (!toks.length) return { out: '' };
    const cmd = toks[0];
    if (cmd === 'git') return execGit(st, toks);
    if (cmd === 'clear' || cmd === 'cls') return { out: '', clear: true };
    if (cmd === 'help' || cmd === 'man') return { out: HELP };
    if (cmd === 'ls') return cmdLs(st, toks.slice(1));
    if (cmd === 'cat') return cmdCat(st, toks.slice(1));
    if (cmd === 'grep') return cmdShellGrep(st, toks.slice(1));
    if (cmd === 'pwd') return { out: '/home/oncall/kettlebird-shop' };
    if (cmd === 'whoami') return { out: 'oncall' };
    if (cmd === 'date') return { out: fmtDate(st.now).replace(' +0000', ' UTC') };
    if (cmd === 'echo') {
      return { out: toks.slice(1).map((t) => (t === '$?' ? String(st.lastExit) : t)).join(' ') };
    }
    if (cmd === 'cd') return { out: toks[1] && toks[1] !== '.' && toks[1] !== '~/kettlebird-shop' ? 'sandbox: stay in the repo, detective.' : '' };
    if (cmd === 'sudo') return { out: 'oncall is not in the sudoers file. This incident will be reported.', error: true };
    if (cmd === 'rm') return { out: "sandbox: nothing gets deleted during an investigation.", error: true };
    if (cmd === 'npm' || cmd === 'sh' || cmd === 'bash' || cmd.startsWith('./') || cmd.startsWith('scripts/')) {
      const r = runScript(st, toks);
      st.lastExit = r.code;
      return { out: r.out, error: r.code !== 0, exit: r.code };
    }
    if (['vim', 'vi', 'nano', 'emacs', 'code'].includes(cmd)) return { out: `sandbox: no editors during an incident. Use 'cat -n FILE'.`, error: true };
    if (['head', 'tail', 'less', 'more', 'wc', 'sort', 'uniq'].includes(cmd)) return { out: `sandbox: '${cmd}' isn't available. Try git's own options (-n N, --reverse, --oneline) or 'cat -n'.`, error: true };
    return { out: `bash: ${cmd}: command not found`, error: true };
  }

  function exec(st, line) {
    const text = (line || '').trim();
    if (!text) return { out: '', segments: 0 };
    let segs;
    try { segs = splitChain(text); }
    catch (e) { return { out: e.message, error: true, segments: 0 }; }
    const outs = [];
    let items = null, error = false, clear = false;
    let skip = false;
    for (const seg of segs) {
      if (skip) { if (seg.next === ';' || seg.next === null) skip = false; continue; }
      let r;
      try { r = execOne(st, seg.text); }
      catch (e) {
        if (e instanceof GitError) r = { out: e.message, error: true };
        else r = { out: `sandbox: internal error (${e.message}). Please report this case and command.`, error: true };
      }
      if (r.clear) { clear = true; outs.length = 0; }
      if (r.out) outs.push(r.out);
      if (r.items) items = r.items;
      st.lastExit = r.exit != null ? r.exit : r.error ? 1 : 0;
      if (r.error) { error = true; if (seg.next === '&&') skip = true; }
    }
    return { out: outs.join('\n'), items: segs.length === 1 ? items : null, error, clear, segments: segs.length };
  }

  /* ==== BUILDER ==== */
  function applyChanges(tree, files) {
    const t = { ...tree };
    for (const [p, v] of Object.entries(files || {})) {
      if (v === null) delete t[p];
      else if (typeof v === 'function') { const r = v(t[p], t); if (r === null) delete t[p]; else t[p] = ensureNL(r); }
      else t[p] = ensureNL(v);
    }
    return t;
  }

  function sub(from, to) {
    return (s) => {
      if (s == null) throw new Error(`sub(): file missing while replacing ${JSON.stringify(from)}`);
      const i = s.indexOf(from);
      if (i < 0) throw new Error(`sub(): ${JSON.stringify(from)} not found`);
      if (s.indexOf(from, i + 1) >= 0) throw new Error(`sub(): ${JSON.stringify(from)} is ambiguous`);
      return s.slice(0, i) + to + s.slice(i + from.length);
    };
  }
  function subs(...pairs) {
    return (s) => pairs.reduce((acc, [a, b]) => sub(a, b)(acc), s);
  }

  function hashesIn(st, text) {
    return text.replace(/\{\{(\w+)\}\}/g, (_, id) => {
      if (!st.commits[id]) throw new Error(`build: unknown commit id ${id}`);
      return st.commits[id].hash;
    });
  }

  function build(def) {
    const st = newState(def);
    st.building = true;
    const run = (cmd) => {
      const r = exec(st, 'git ' + hashesIn(st, cmd));
      if (r.error) throw new Error(`build(${def.id}): git ${cmd}\n${r.out}`);
      return r;
    };
    for (const step of def.history) {
      if (step.git) { run(step.git); continue; }
      if (step.tag) { st.tags[step.tag] = step.at; continue; }
      const br = step.on || st.HEAD.ref || 'main';
      if (step.amend) {
        const old = st.commits[headId(st)];
        const c = addCommit(st, { id: step.id, parent: old.parent, author: step.author || old.author, date: step.date, msg: step.msg, tree: applyChanges(old.tree, step.files) });
        setHeadTo(st, c.id);
        logRef(st, c.id, `commit (amend): ${subject(step.msg)}`);
        continue;
      }
      if (st.HEAD.ref !== br || (!st.HEAD.ref)) {
        if (st.heads[br]) run(`checkout ${br}`);
        else if (!Object.keys(st.heads).length) st.HEAD = { ref: br };
        else run(`checkout -b ${br} ${step.from ? `{{${step.from}}}` : ''}`);
      }
      const parent = headId(st);
      const c = addCommit(st, { id: step.id, parent, author: step.author, date: step.date, msg: step.msg, tree: applyChanges(parent ? st.commits[parent].tree : {}, step.files) });
      setHeadTo(st, c.id);
      logRef(st, c.id, `${parent ? 'commit' : 'commit (initial)'}: ${subject(step.msg)}`);
    }
    if (def.head && st.HEAD.ref !== def.head) run(`checkout ${def.head}`);
    st.building = false;
    st.moves = [];
    st.bisectHistory = [];
    st.bisectResult = null;
    st.origHead = def.keepOrigHead ? st.origHead : st.origHead;
    return st;
  }

  function replay(def, history) {
    const st = build(def);
    const results = [];
    for (const line of history || []) results.push({ line, ...exec(st, line) });
    return { st, results };
  }

  /* ==== VIEW (commit graph for the UI) ==== */
  function view(st) {
    const reach = new Set();
    for (const t of allTips(st)) for (const a of ancestors(st, t)) reach.add(a);
    const ids = sortedIds(st, reach);
    const lane = {};
    const tipsOrdered = [];
    const pri = (n) => (n === 'main' ? 0 : n.startsWith('release') ? 1 : 2);
    const heads = Object.entries(st.heads).sort((a, b) => pri(a[0]) - pri(b[0]) || a[0].localeCompare(b[0]));
    if (st.HEAD.det) tipsOrdered.push(st.HEAD.det);
    for (const [, id] of heads) tipsOrdered.push(id);
    for (const id of Object.values(st.tags)) tipsOrdered.push(id);
    // main first, then others, detached last unless it's on a branch
    const ordered = [...heads.map((h) => h[1]), ...(st.HEAD.det ? [st.HEAD.det] : []), ...Object.values(st.tags)];
    let next = 0;
    for (const tip of ordered) {
      if (lane[tip] != null) continue;
      const L = next++;
      let cur = tip;
      while (cur && lane[cur] == null) { lane[cur] = L; cur = st.commits[cur].parent; }
    }
    const deco = decorations(st);
    const b = st.bisect;
    const cand = b && b.bad && b.good.length ? bisectCandidates(st) : null;
    const rows = ids.map((id) => {
      const c = st.commits[id];
      let mark = null;
      if (b) {
        if (b.bad === id) mark = 'bad';
        else if (b.good.includes(id)) mark = 'good';
        else if (b.skip.includes(id)) mark = 'skip';
        else if (cand && !cand.has(id)) mark = 'out';
        if (b.done === id) mark = 'culprit';
      }
      return {
        id, hash: c.hash, short: c.hash.slice(0, 7), subject: subject(c.msg), author: authorName(c.author), date: c.date,
        lane: lane[id], parent: c.parent && reach.has(c.parent) ? c.parent : null, refs: deco[id] || [], head: headId(st) === id, mark, picked: !!c.pickedFrom,
      };
    });
    return { rows, lanes: next, head: st.HEAD.ref ? { ref: st.HEAD.ref } : { det: st.HEAD.det }, bisecting: !!b, now: st.now };
  }

  function promptLabel(st) {
    const base = st.HEAD.ref ? st.HEAD.ref : headId(st) ? `(${short(st, st.HEAD.det)}...)` : st.HEAD.ref;
    return st.bisect ? `${base}|BISECTING` : base;
  }

  /* ==== TAB COMPLETION ==== */
  const SUBCOMMANDS = ['log', 'show', 'diff', 'blame', 'bisect', 'reflog', 'branch', 'checkout', 'switch', 'reset', 'cherry-pick', 'status', 'tag', 'shortlog', 'grep', 'rev-parse', 'help'];
  function complete(st, line) {
    const m = line.match(/^(.*?)(\S*)$/);
    const before = m[1], word = m[2];
    const toks = before.trim().split(/\s+/).filter(Boolean);
    let pool;
    if (!toks.length) pool = ['git', 'cat', 'cat -n', 'ls', 'grep', 'npm test', 'clear', 'help'];
    else if (toks.length === 1 && toks[0] === 'git') pool = SUBCOMMANDS;
    else if (toks[0] === 'git' && toks[1] === 'bisect' && toks.length === 2) pool = ['start', 'good', 'bad', 'skip', 'run', 'view', 'log', 'reset'];
    else {
      const files = Object.keys(headTree(st));
      const dirs = [...new Set(files.flatMap((f) => { const p = f.split('/'); return p.slice(0, -1).map((_, i) => p.slice(0, i + 1).join('/') + '/'); }))];
      pool = [...Object.keys(st.heads), ...Object.keys(st.tags), 'HEAD', ...dirs, ...files];
    }
    const hits = [...new Set(pool)].filter((p) => p.startsWith(word) && p !== word).sort();
    if (!hits.length) return { line, options: [] };
    let common = hits[0];
    for (const h of hits) { while (!h.startsWith(common)) common = common.slice(0, -1); }
    const completed = hits.length === 1 ? before + hits[0] + (hits[0].endsWith('/') ? '' : ' ') : before + common;
    return { line: completed, options: hits.length > 1 ? hits : [] };
  }

  /* ==== EXPLAINER ==== */
  const SUB_DESC = {
    log: 'show commit history, newest first (starting from HEAD unless you name revisions)',
    shortlog: 'summarise history grouped by author',
    show: 'show one commit: its metadata and the diff it introduced',
    diff: 'compare two trees and print the changed lines',
    blame: 'label every line of a file with the commit that last changed it',
    bisect: 'binary-search history for the first commit where something broke',
    reflog: 'list every position HEAD has been in, including commits no branch points at any more',
    branch: 'list, create, move or delete branches (branches are just movable pointers to commits)',
    checkout: 'move HEAD to a branch or commit',
    switch: 'move HEAD to a branch',
    reset: 'move the current branch pointer to another commit',
    'cherry-pick': "copy a commit's change onto the current branch as a new commit",
    tag: 'list or create tags (fixed names for commits)',
    status: 'show where HEAD is and whether a bisect is in progress',
    'rev-parse': 'turn a revision name into a full commit hash',
    grep: 'search file contents in a commit',
  };
  const BISECT_DESC = {
    start: 'begin a bisect session (optionally: <bad> then <good>)', bad: 'mark a commit as containing the bug (default: HEAD)', new: 'same as bad',
    good: 'mark a commit as known to work (default: HEAD)', old: 'same as good', skip: "this commit can't be tested — let bisect choose a neighbour",
    run: 'let Git test every step automatically: exit 0 = good, 125 = skip, 1–127 = bad', reset: 'end the session and return to where you started',
    log: 'print the marks made so far', view: 'list the commits still under suspicion',
  };
  function describeRev(t) {
    let m;
    if (t.includes('..')) { const [a, b] = t.split('..'); return `commits reachable from ${b || 'HEAD'} but not from ${a || 'HEAD'}`; }
    if ((m = t.match(/^(?:HEAD)?@\{(\d+)\}$/))) return `where HEAD was ${m[1]} move${m[1] === '1' ? '' : 's'} ago (read from the reflog)`;
    if (t === 'HEAD' || t === '@') return 'the commit you currently have checked out';
    if (t === 'ORIG_HEAD') return 'where HEAD was before the last reset (Git saves it for you)';
    if ((m = t.match(/^(.+?)~(\d*)$/))) return `${m[2] || 1} commit${(m[2] || '1') === '1' ? '' : 's'} before ${m[1]}, following first parents`;
    if ((m = t.match(/^(.+?)\^$/))) return `the parent of ${m[1]}`;
    if (/^[0-9a-f]{7,40}$/.test(t)) return `the commit whose hash starts with ${t.slice(0, 7)}`;
    if (t.includes(':')) return `the file ${t.split(':')[1]} as it was in ${t.split(':')[0] || 'HEAD'}`;
    return `the revision or path “${t}”`;
  }
  function explainTokens(toks) {
    const rows = [];
    if (toks[0] !== 'git') {
      const map = { cat: 'print a file from the working tree (HEAD)', ls: 'list files', grep: 'search files in the working tree', npm: 'run the project script', clear: 'clear the terminal' };
      rows.push({ tok: toks.join(' '), desc: map[toks[0]] || 'shell command' });
      return rows;
    }
    rows.push({ tok: 'git ' + (toks[1] || ''), desc: SUB_DESC[toks[1]] || 'git subcommand' });
    const sub = toks[1];
    const args = toks.slice(2);
    let afterDD = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      let m, d = null;
      const nxt = () => args[i + 1];
      if (afterDD) { rows.push({ tok: a, desc: `limit to changes under the path “${a}”${isGlob(a) ? ' (a glob: * also matches /)' : ''}` }); continue; }
      if (a === '--') { afterDD = true; d = 'everything after this is a path, not a revision'; }
      else if (sub === 'bisect' && i === 0) d = BISECT_DESC[a] || 'bisect subcommand';
      else if (sub === 'bisect' && args[0] === 'run' && i > 0) { rows.push({ tok: args.slice(1).join(' '), desc: "the test command Git runs at every step (its exit code decides good/bad/skip)" }); break; }
      else if (a === '--oneline') d = 'one line per commit: short hash, refs and subject';
      else if ((m = a.match(/^-(\d+)$/)) || (a === '-n' && (m = [null, nxt()]) && i++)) d = `stop after ${m[1]} commits`;
      else if ((m = a.match(/^--author=([\s\S]*)$/)) || (a === '--author' && (m = [null, nxt()]) && i++)) d = `keep commits whose “Name <email>” matches the regex /${m[1]}/ — a substring match unless anchored`;
      else if ((m = a.match(/^--grep=([\s\S]*)$/)) || (a === '--grep' && (m = [null, nxt()]) && i++)) d = `keep commits whose message matches /${m[1]}/ (the message, not the code)`;
      else if (a === '-i' || a === '--regexp-ignore-case') d = 'make --grep / --author case-insensitive';
      else if ((m = a.match(/^-S([\s\S]+)$/)) || (a === '-S' && (m = [null, nxt()]) && i++)) d = `pickaxe: keep commits that change how many times “${m[1]}” appears (added or removed — not merely edited around)`;
      else if ((m = a.match(/^-G([\s\S]+)$/)) || (a === '-G' && (m = [null, nxt()]) && i++)) d = `keep commits with an added or removed line matching /${m[1]}/ (includes in-place edits)`;
      else if (a === '--all') d = 'start from every branch and tag, not just HEAD — includes work that never shipped';
      else if (a === '--reverse') d = 'print oldest first';
      else if (a === '-p' || a === '--patch') d = 'include the diff of every commit';
      else if (a === '--stat') d = 'summarise which files changed and by how much';
      else if (/^--(since|after)=/.test(a)) d = `only commits made on or after ${a.split('=')[1]}`;
      else if (/^--(until|before)=/.test(a)) d = `only commits made on or before ${a.split('=')[1]}`;
      else if (/^--(format|pretty)=/.test(a)) d = 'custom output format (%h hash, %an author, %s subject…)';
      else if (a === '-w') d = 'ignore whitespace when matching lines to their parent version — sees through re-indentation';
      else if ((m = a.match(/^-L([\s\S]+)$/)) || (a === '-L' && (m = [null, nxt()]) && i++)) {
        const r = m[1];
        d = r.startsWith(':') ? `only the function whose definition line matches /${r.slice(1)}/` : `only lines ${r} (numbers, /regex/ or +count)`;
      }
      else if ((m = a.match(/^--ignore-rev=?([\s\S]*)$/))) { const v = m[1] || (i++, args[i]); d = `pretend commit ${v} never happened; its lines are traced to whoever wrote them before`; }
      else if (a === '-x') d = 'append “(cherry picked from commit …)” to the new message';
      else if (a === '--hard') d = 'move the branch and make the files match';
      else if (a === '-b' || a === '-c') { d = `create a branch named ${nxt()} and switch to it`; i++; }
      else if (a === '-f' || a === '--force') d = 'move an existing branch pointer';
      else if (a === '-D') d = 'delete a branch even if its commits are not merged';
      else if (a === '--contains') { d = `only branches that already include ${nxt() || 'HEAD'}`; i++; }
      else if (a === '--detach') d = 'check out the commit without being on any branch';
      else if (a.startsWith('-')) d = 'option';
      else d = describeRev(a);
      rows.push({ tok: a, desc: d });
    }
    return rows;
  }
  function explain(line) {
    let segs;
    try { segs = splitChain(line); } catch (e) { return []; }
    const rows = [];
    for (const s of segs) { try { rows.push(...explainTokens(tokenize(s.text))); } catch (e) { /* ignore */ } }
    return rows;
  }
  function tokenCount(line) {
    try { return splitChain(line).reduce((n, s) => n + tokenize(s.text).length, 0); } catch (e) { return Infinity; }
  }
  function isMutatingCmd(line) {
    try {
      return splitChain(line).some((s) => { const t = tokenize(s.text); return t[0] === 'git' && MUTATING.has(t[1]); });
    } catch (e) { return false; }
  }

  /* ==== CASE API (for objective checks) ==== */
  function api(st) {
    return {
      st,
      tip: (b) => st.heads[b] || null,
      head: () => headId(st),
      onBranch: () => st.HEAD.ref || null,
      commit: (id) => st.commits[id],
      tree: (id) => (id ? st.commits[id].tree : {}),
      parent: (id) => (id ? st.commits[id].parent : null),
      ancestors: (id) => (id ? ancestors(st, id) : new Set()),
      contains: (branchOrId, id) => { const t = st.heads[branchOrId] || branchOrId; return !!(t && st.commits[t] && ancestors(st, t).has(id)); },
      origin: (id) => (st.commits[id] && st.commits[id].pickedFrom) || id,
      firstParents: (id, n) => { const out = []; let c = id; while (c && out.length < n) { out.push(c); c = st.commits[c].parent; } return out; },
      run: (cmd, id) => { const fn = st.def.scripts[cmd]; return fn(id ? st.commits[id].tree : headTree(st), {}); },
      bisecting: () => !!st.bisect,
      bisectResult: () => st.bisectResult,
      bisectSteps: () => st.bisectResultSteps,
      moves: () => st.moves.filter((m) => !/^bisect/.test(m)),
      short: (id) => (st.commits[id] ? short(st, id) : id),
      subject: (id) => (st.commits[id] ? subject(st.commits[id].msg) : id),
    };
  }

  const GitSim = {
    build, replay, exec, view, promptLabel, complete, explain, tokenCount, isMutatingCmd, api,
    sub, subs, fakeSha, tokenize, splitChain, makeHunks, diffOps, applyPatch, splitLines, GitError,
    HELP,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = GitSim;
  else global.GitSim = GitSim;
})(typeof window !== 'undefined' ? window : globalThis);
