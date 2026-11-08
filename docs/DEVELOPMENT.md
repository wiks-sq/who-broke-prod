# Who Broke Prod? — Developer Guide

A browser game that teaches **Git investigation**: `log` filters, the pickaxe, `blame -L/-w`, `bisect` (with `skip`/`run`), `reflog` recovery and `cherry-pick`. Most Git games teach branching with abstract diagrams. Here the player is on call, production is down, and the evidence sits in a messy repository.

It follows the "skill-expression puzzle with a deterministic evaluator" pattern used by [Regex Noir](https://github.com/wiks-sq/regex-noir): the player types real commands, a sandboxed engine runs them against fixed data, and the result is graded exactly. It has no backend, no build step and no accounts. Progress lives in `localStorage`.

> The answer key (`SOLUTIONS.md`) is kept **out of the repository** on purpose (see `.gitignore`). Maintainers keep a local copy.

---

## 1. Layout

```
git_game/
├── index.html            # The game: markup, CSS, CASES data (plain JS) and the React/JSX UI
├── engine.js             # The Git simulator. Shared by the game, the cheat sheet and the verifier
├── cheatsheet.html       # Searchable reference + live sandbox terminal (plain JS, no React)
├── og-image.png          # 1200×630 social preview
├── favicon.ico/.svg, apple-touch-icon.png, icon-192.png, icon-512.png, site.webmanifest
├── README.md             # Public project page
├── docs/DEVELOPMENT.md   # This file
├── SOLUTIONS.md          # Answer key (local only, git-ignored)
├── .github/workflows/verify.yml  # CI: runs the case verifier
└── tools/
    ├── verify-cases.js   # node tools/verify-cases.js [-v]: references, alternatives and traps
    ├── og-image.html     # Source for og-image.png
    └── icons/            # mark-small.svg, mark-large.svg, render.sh (Chrome headless + Pillow)
```

## 2. Running

- **Serve locally (recommended):** `python3 -m http.server 8000`, then open http://localhost:8000.
- **Double-click** `index.html` also works: `engine.js` loads through a normal `<script>` tag.
- **Deploy:** upload `index.html`, `engine.js`, `cheatsheet.html`, `og-image.png`, the icons and `site.webmanifest` to any static host (production: Apache at https://git.regexnoir.com).

Runtime dependencies (CDN, pinned): React/ReactDOM 18.3.1 and @babel/standalone 7.24.7 (unpkg), IBM Plex Sans/Mono (Google Fonts). The cheat sheet only needs the fonts.

## 3. Before release

| What | Where | Current |
|---|---|---|
| Canonical / OG / Twitter / JSON-LD URLs | `<head>` of `index.html` and `cheatsheet.html` | `https://git.regexnoir.com/` |
| Buy Me a Coffee link | `const SUPPORT_URL` in `index.html`, plus two links in `cheatsheet.html` | `https://buymeacoffee.com/marginnotes` (empty string hides every coffee button) |
| Storage key | `const STORAGE_KEY` | `whoBrokeProd.v1` (change only to wipe everyone's progress) |

## 4. How a case works

```
open case ──► dossier: briefing, mentor note, objectives, "graded on", field kit
     │
     ▼
type commands in the terminal (Enter = run, free)
     │   └─► live: terminal output, commit graph (HEAD, refs, bisect marks), evidence panel / case board
     ├── Hint 1 / Hint 2  → −200 each
     ├── Declassify (after 3 misfires) → reference answer, −500, no efficiency bonus
     ▼
Ctrl/Cmd+Enter → "File evidence" (output cases) / "Close case" (state cases)
     ├── wrong → shake, misfire −100, specific diagnosis + per-case nudges
     └── right → victory modal: score breakdown, your command explained token by token
                 (or your moves), reference, concept, story debrief, next case
```

Two grading kinds (`grade.kind`):

- **`output`** (cases 01–05): the engine returns structured `items` along with the text output. `git log`/`shortlog`/`show` return commit ids; `git blame` returns `line:commitId` pairs. The filed command's items must equal `grade.expected` exactly and in order. Projecting to items (rather than parsing text) means `--oneline`, `--format=%h` and plain `git log` all count the same.
- **`state`** (cases 06–10): `grade.check(api)` returns `[{label, ok, note}]`. The case board shows these live; all must be `ok` to close. The `api` exposes branch tips, ancestry, `origin(id)` (follows cherry-picks back to their source), `run(script, id)`, `bisectResult()` and similar.

Efficiency bonus: `tokens` (shell words) for output cases; `steps` (commits tested in the bisect that named the culprit) or `moves` (branch-moving commands, bisect excluded) for state cases. Each is compared with the reference solution, measured live.

Scoring: base 1000, −100 per misfire, −200 per hint, −500 declassify, +150 efficiency, capstone par bonus 100 + 500 × (time left / 600 s), floor 100. The best score is kept. The case timer starts on first open and survives reloads.

## 5. The engine (`engine.js`)

One IIFE that exports `GitSim` (`window.GitSim` in the browser, `module.exports` in Node).

**Model.** Commits store full tree snapshots (`{path: content}`). History is linear per branch (first-parent only, no merge commits). There is no index or working tree: the working tree is always HEAD's tree. Hashes are deterministic fake SHA-1s derived from the case id and commit content, so they're stable across reloads and match SOLUTIONS.md.

**Supported:** `log` (`--oneline -n --author --grep -i -F --all-match --invert-grep -S -G --pickaxe-regex --all --reverse -p --stat --name-only --name-status --format/--pretty --since/--until --graph`, ranges `A..B`, `^A`, pathspecs incl. globs), `shortlog -sne`, `show` (incl. `REV:path`), `diff`, `blame` (`-L a,b | a,+n | /re/,/re/ | :func`, `-w`, `--ignore-rev`, `-e -s -l`), `bisect` (`start/good/bad/new/old/skip/run/view/log/reset/terms`), `reflog`, `branch` (`-v -f -d -D -m --contains --show-current`), `checkout`/`switch` (`-b/-c`, `--detach`, `-`), `reset` (`--soft/--mixed` behave like `--hard`, with a note), `cherry-pick` (`-x`, ranges, conflict detection), `tag`, `status`, `rev-parse`, `git grep`. Shell: `ls cat -n grep echo $? pwd clear help` plus per-case scripts (`npm test`, `npm run build`, `./scripts/bisect-check.sh`). `&&` and `;` chain commands. **Pipes are refused on purpose**, so players learn Git's own filters.

**Not simulated** (each gets a friendly in-world message): `commit add push pull merge rebase revert stash`, and so on.

**Diff/blame.** Line-level LCS. Blame walks first parents, carrying ownership through unchanged lines; `-w` compares lines with all whitespace stripped; `--ignore-rev` maps a skipped commit's changed lines positionally to the parent's owners.

**Cherry-pick.** Per file: if the target equals the source's parent, take the source version; otherwise apply the source's hunks by exact context match (nearest position wins). No match means `CONFLICT`. Conflict resolution isn't simulated, so the pick rolls back and earlier picks in the same command stay, as in Git.

**Bisect.** Candidates = ancestors(bad) − ancestors(goods). The next commit maximises `min(n, N−n)`, where `n` is how many candidates it reaches, and skipped commits are excluded. `run` maps exit codes as Git does (0 good, 125 skip, 1–127 bad, ≥128 abort).

**Regex inputs** (`--author --grep -G`, `blame -L /re/`): tried as JavaScript regex first, falling back to a literal match if they don't compile. This mimics Git's basic-regex handling of `(`. Patterns are capped at 200 characters, and nested quantifiers like `(a+)+` are rejected.

**Why no Web Worker?** The blueprint (§2.12) recommends one. Here every player-controlled regex runs against strings under 200 characters, nested quantifiers are rejected up front, and no command loops on player input (`bisect run` is capped at 64 steps and only runs fixed case scripts). The engine therefore stays on the main thread, which keeps `file://` play working. If you add a feature that runs player code, move `exec` into a worker and replay `drafts[caseId].history` after a timeout.

## 6. Case data

`CASES` sits between `/*CASES_START*/ … /*CASES_END*/` in `index.html`. It's plain JS (no JSX) so the verifier can eval it.

```js
{
  id: 'case-04',                       // permanent storage key
  title, chapter, difficulty, briefing,
  officer: { name, role, note },       // mentor voice
  objectives: [...], evidence: '...',  // name every decoy category
  repo: {
    id, now, head,                     // id seeds hashes, so changing it changes every hash
    history: [                         // replayed in order by GitSim.build()
      { id: 'f01', on: 'main', from?: 'f00', author, date, msg, files: { path: 'content' | null | fn(old, tree) } },
      { amend: true, id, date, msg, files },  // replaces HEAD's commit (reflog: commit (amend))
      { git: 'reset --hard HEAD~2' },         // any engine command; {{id}} → that commit's hash
      { tag: 'v2.4.0', at: 'h01' },
    ],
    scripts: { 'npm test': (tree) => ({ code, out }) },
  },
  startInput: 'git log --oneline',     // teaching lever: a broken first attempt
  grade: { kind: 'output', expect: 'commits' | 'blame', expected: [...] }
       | { kind: 'state', size: 'steps' | 'moves', check: (api) => [{ label, ok, note }] },
  solution: { cmd } | { steps: [...], note },     // {{id}} placeholders allowed
  hints: [nudge, stronger], nudges: [[/regex on the filed command/, 'message']],
  conceptUnlocked, debrief, cheats: [[token, desc]], timeLimit?,
}
```

Helpers in the block: `GitSim.sub(from, to)` / `subs(...)` (exact, unique replacement; throws if missing, so typos fail the verifier), `testRun(checks)`, `importsOk`, `jsonOk`, `buildFail`, `testCrash`.

### Adding or editing a case
1. Write the reference, then 2–3 near-miss answers, then the decoy commits that defeat them.
2. Add references, alternatives and traps to `tools/verify-cases.js`. Bisect strategies use `manualBisect(start, testCmd, decide, buildCmd?, after?)`.
3. `node tools/verify-cases.js -v` must report **All cases verified.**
4. Regenerate the hashes in your local SOLUTIONS.md if any history changed.

## 7. Persistence

One key, `whoBrokeProd.v1`: `{ v, solved, sessions, drafts, current, settings: { sound, theme }, completedAt }`. **Drafts store each case's command history**, and the sandbox is rebuilt by replaying it, so the terminal scrollback, branch positions and bisect state all survive a reload. Every storage call is wrapped in try/catch, and the game still plays with storage blocked. "↺ Fresh repo" clears the history but keeps penalties and the clock. "Reset" in the header wipes everything except settings.

## 8. Accessibility and presentation

Three themes (Day, Night, High contrast) via CSS custom properties. The default follows `prefers-color-scheme`. Modals use `aria-modal` and close on Esc or a backdrop click. The evidence panel and progress counter are `aria-live`. Everything is keyboard-playable (`/` focuses the prompt, Tab completes, ↑/↓ walks history). `prefers-reduced-motion` disables the shake and stamp animations. Sound is Web Audio only, with a toggle. The layout stacks below 980 px and has no horizontal scroll at 375 px.

## 9. Manual smoke test

1. Fresh storage: only case 01 is unlocked, and the prompt is pre-filled with `git log --oneline`.
2. Enter: the evidence panel shows "11 commits listed · 3/3 evidence found · 8 not evidence".
3. Ctrl+Enter on `git log --oneline --grep=prod`: misfire, −100, the `--grep` nudge appears.
4. File `git log --oneline -- config/prod.yml`: victory modal, explainer, case 02 unlocks.
5. Reload: progress, terminal replay, theme and sound all persist.
6. Case 06: `git bisect start main v2.4.0` puts bisect marks on the graph; `git bisect run npm test` names the culprit and the case board turns green.
7. Case 09: `git cherry-pick <second fix>` on release/2.5 gives CONFLICT and a rollback note.
8. Mobile (375 px): no horizontal scroll; the terminal and buttons are usable.
9. Finish case 10: the Principal Investigator badge downloads as a 1200×1200 PNG.

## 10. Regenerating assets

```bash
bash tools/icons/render.sh
google-chrome --headless=new --hide-scrollbars --window-size=1200,630 --virtual-time-budget=4000 --screenshot=og-image.png "file://$PWD/tools/og-image.html"
```
