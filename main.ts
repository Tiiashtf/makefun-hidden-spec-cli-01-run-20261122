// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old path, new path] pairs, in the order the edits made them. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One line of a file: its break, LF or CRLF, and whether the text ends with it (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { lines: parts, br, finalBr };
}

function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBr ? m.br : '');
}

const leadingWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Line equality at one matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position at or after `from` where O occurs in `lines` at `tier`. */
function matchAt(O: string[], lines: string[], tier: number, from: number, endAtLast: boolean): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i += 1) {
    if (endAtLast && i + O.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (at or after `from`), with its positions. */
function firstTier(
  O: string[],
  lines: string[],
  strict: boolean,
  from: number,
  endAtLast: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = matchAt(O, lines, t, from, endAtLast);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** One line of a replacement: its text, and the index into O when it is a context line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** The lines that replace the k matched lines at `pos`: context lines come from the file itself, and at tier 2
 *  every other line is re-indented from O's indent to the file's (SPEC.md section 5). */
function buildReplacement(O: string[], N: NewLine[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const f = tier === 2 && O.length > 0 ? leadingWs(fileLines[pos]!) : '';
  const p = tier === 2 && O.length > 0 ? leadingWs(O[0]!) : '';
  for (const n of N) {
    if (n.ctx !== null) {
      out.push(fileLines[pos + n.ctx]!);
      continue;
    }
    if (tier === 2 && n.text !== '' && n.text.trim() !== '' && n.text.startsWith(p)) out.push(f + n.text.slice(p.length));
    else out.push(n.text);
  }
  return out;
}

/** A hunk body line: its kind, its text after the first character, and the raw line it came from. */
interface UBodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  raw: string;
}

interface UHunk {
  /** The old start line A of `@@ -A[,B] +C[,D] @@` (B and D are not used). */
  a: number;
  body: UBodyLine[];
}

interface USection {
  /** Old/new path as named, null for /dev/null, undefined when nothing names it. */
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: UHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path of a `--- `/`+++ ` header line: after the four characters, up to the first tab, spaces removed,
 *  with one leading `a/` or `b/` removed. */
function headerPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Split a hunk body into its old lines O and its new lines N (context lines linked to their O index). */
function hunkON(h: UHunk): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.kind === '-') O.push(b.text);
    else if (b.kind === '+') N.push({ text: b.text, ctx: null });
  }
  return { O, N };
}

/** Whether a `\` line follows the hunk's last context or `+` line (its final line break is then absent). */
function hunkNoNewline(h: UHunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k -= 1) {
    if (h.body[k]!.kind === ' ' || h.body[k]!.kind === '+') {
      return k + 1 < h.body.length && h.body[k + 1]!.kind === '\\';
    }
  }
  return false;
}

/** Whether a `\` line follows the last `+` line of any hunk of the section (a created file then ends
 *  without a line break). */
function sectionLastPlusNoNewline(hunks: UHunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi -= 1) {
    const body = hunks[hi]!.body;
    for (let k = body.length - 1; k >= 0; k -= 1) {
      if (body[k]!.kind === '+') return k + 1 < body.length && body[k + 1]!.kind === '\\';
    }
  }
  return false;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let hunk: UHunk | null = null;
  /** 'outside': before the first section. 'header': a section before its first hunk. 'body': inside a hunk.
   *  'between': a section after a hunk body ended, before its next hunk or section. */
  let state: 'outside' | 'header' | 'body' | 'between' = 'outside';

  const startGit = (line: string, i: number): void => {
    const m = GIT_RE.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    sec = {
      pairOld: undefined,
      pairNew: undefined,
      renameOld: undefined,
      renameNew: undefined,
      gitOld: m[1],
      gitNew: m[2],
      newFileMode: false,
      deletedFileMode: false,
      hunks: [],
    };
    sections.push(sec);
    hunk = null;
    state = 'header';
  };
  const startPair = (i: number): void => {
    sec = {
      pairOld: headerPath(lines[i]!) === '/dev/null' ? null : headerPath(lines[i]!),
      pairNew: headerPath(lines[i + 1]!) === '/dev/null' ? null : headerPath(lines[i + 1]!),
      renameOld: undefined,
      renameNew: undefined,
      gitOld: undefined,
      gitNew: undefined,
      newFileMode: false,
      deletedFileMode: false,
      hunks: [],
    };
    sections.push(sec);
    hunk = null;
    state = 'header';
  };
  const startHunk = (line: string, i: number): void => {
    const m = HUNK_RE.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    hunk = { a: Number(m[1]), body: [] };
    sec!.hunks.push(hunk);
    state = 'body';
  };
  const endBody = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.raw === '') hunk.body.pop();
    hunk = null;
    state = 'between';
  };
  const isBodyLine = (line: string): boolean =>
    line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (state === 'outside') {
      if (line.startsWith('diff --git ')) {
        startGit(line, i);
        i += 1;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startPair(i);
        i += 2;
      } else if (line.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i += 1; // prose, code fences and anything else outside a section is ignored
      }
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('@@')) {
        startHunk(line, i);
        i += 1;
      } else if (line.startsWith('diff --git ')) {
        startGit(line, i);
        i += 1;
      } else if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (sec!.pairOld !== undefined) {
            startPair(i);
            i += 2;
          } else {
            sec!.pairOld = headerPath(line) === '/dev/null' ? null : headerPath(line);
            sec!.pairNew = headerPath(lines[i + 1]!) === '/dev/null' ? null : headerPath(lines[i + 1]!);
            i += 2;
          }
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
      } else if (line.startsWith('+++ ')) {
        if (sec!.pairNew === undefined) sec!.pairNew = headerPath(line) === '/dev/null' ? null : headerPath(line);
        i += 1;
      } else if (line.startsWith('rename from ')) {
        sec!.renameOld = line.slice('rename from '.length).trim();
        i += 1;
      } else if (line.startsWith('rename to ')) {
        sec!.renameNew = line.slice('rename to '.length).trim();
        i += 1;
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        sec!.newFileMode = true;
        i += 1;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        sec!.deletedFileMode = true;
        i += 1;
      } else {
        i += 1; // index, old/new mode, similarity, Index: and any other header line are ignored
      }
      continue;
    }
    if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        endBody();
        startGit(line, i);
        i += 1;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endBody();
        startPair(i);
        i += 2;
      } else if (line.startsWith('@@')) {
        endBody();
        startHunk(line, i);
        i += 1;
      } else if (isBodyLine(line)) {
        hunk!.body.push({
          kind: (line === '' ? ' ' : (line[0] as ' ' | '-' | '+' | '\\')),
          text: line === '' ? '' : line.slice(1),
          raw: line,
        });
        i += 1;
      } else {
        endBody();
        // the line that ended the body is re-read in the 'between' state
      }
      continue;
    }
    // state === 'between'
    if (line.startsWith('diff --git ')) {
      startGit(line, i);
      i += 1;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startPair(i);
      i += 2;
    } else if (line.startsWith('@@')) {
      startHunk(line, i);
      i += 1;
    } else {
      i += 1; // prose between hunks is ignored
    }
  }
  if (state === 'body') endBody();
  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((s) => {
    const oldPath = s.pairOld !== undefined ? s.pairOld : (s.renameOld ?? s.gitOld ?? null);
    const newPath = s.pairNew !== undefined ? s.pairNew : (s.renameNew ?? s.gitNew ?? null);
    const isCreate = oldPath === null || s.newFileMode;
    const isDelete = !isCreate && (newPath === null || s.deletedFileMode);
    const isMove = !isCreate && !isDelete && oldPath !== newPath;
    return (tree: Tree): void => {
      if (isCreate) {
        const p = newPath;
        if (p === null) return; // both paths /dev/null: nothing to create
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        for (const h of s.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (sectionLastPlusNoNewline(s.hunks) ? '' : '\n'));
        return;
      }
      if (isDelete) {
        const p = oldPath;
        if (p === null) return; // both paths /dev/null: nothing to delete
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (isMove && newPath !== null && newPath !== p && !safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (isMove && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
      let model = parseFile(before);
      let d = 0;
      for (const h of s.hunks) {
        const { O, N } = hunkON(h);
        if (O.length === 0) {
          const at = Math.min(h.a + d, model.lines.length);
          const atEnd = at === model.lines.length;
          const ins = N.map((n) => n.text);
          model = { lines: [...model.lines.slice(0, at), ...ins, ...model.lines.slice(at)], br: model.br, finalBr: atEnd ? !hunkNoNewline(h) : model.finalBr };
          d += N.length;
          continue;
        }
        const found = firstTier(O, model.lines, strict, 0, false);
        if (found === null) throw new Fail('no-match', p);
        const target = h.a - 1 + d;
        let pos = found.positions[0]!;
        for (const q of found.positions) {
          if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
        }
        const repl = buildReplacement(O, N, model.lines, pos, found.tier);
        const runsToEnd = pos + O.length === model.lines.length;
        model = {
          lines: [...model.lines.slice(0, pos), ...repl, ...model.lines.slice(pos + O.length)],
          br: model.br,
          finalBr: runsToEnd ? !hunkNoNewline(h) : model.finalBr,
        };
        d += N.length - O.length;
      }
      const out = serializeFile(model);
      if (isMove) {
        tree.now.set(p, null);
        tree.now.set(newPath!, out);
        tree.moves.push([p, newPath!]);
      } else {
        tree.now.set(p, out);
      }
    };
  });
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1; // index of the previous block's `>>>>>>> REPLACE` line, -1 before the first
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplace; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const model = parseFile(before);
      const found = firstTier(oldLines, model.lines, strict, 0, false);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const repl = buildReplacement(
        oldLines,
        newLines.map((t) => ({ text: t, ctx: null })),
        model.lines,
        pos,
        found.tier,
      );
      model.lines.splice(pos, oldLines.length, ...repl);
      tree.now.set(p, serializeFile(model));
    });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

interface VChunk {
  /** The anchor text, or null for no anchor. */
  anchor: string | null;
  /** True when a `*** End of File` line closed the chunk: it only matches at the file's end. */
  eof: boolean;
  O: string[];
  N: NewLine[];
}

const isV4aSectionStart = (line: string): boolean =>
  line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');

/** Parse one V4A Update section's chunks from its lines (trailing blank lines already removed). */
function parseV4aChunks(raw: string[], updateLineNo: number, base: number): { moveTo: string | null; chunks: VChunk[] } {
  let moveTo: string | null = null;
  let k = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const isBody = (line: string): boolean =>
    line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+');
  for (; k < raw.length; k += 1) {
    const line = raw[k]!;
    if (line.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: line.slice(2).trim() === '' ? null : line.slice(2).trim(), eof: false, O: [], N: [] };
      continue;
    }
    if (line.trimEnd() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${base + k + 1}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (!isBody(line)) throw new Exit2(`error: parse ${base + k + 1}`);
    if (cur === null) {
      if (chunks.length > 0) throw new Exit2(`error: parse ${base + k + 1}`);
      cur = { anchor: null, eof: false, O: [], N: [] };
    }
    if (line === '') {
      cur.O.push('');
      cur.N.push({ text: '', ctx: cur.O.length - 1 });
    } else if (line.startsWith(' ')) {
      cur.O.push(line.slice(1));
      cur.N.push({ text: line.slice(1), ctx: cur.O.length - 1 });
    } else if (line.startsWith('-')) cur.O.push(line.slice(1));
    else if (line.startsWith('+')) cur.N.push({ text: line.slice(1), ctx: null });
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
  return { moveTo, chunks };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isV4aSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const isAdd = line.startsWith('*** Add File: ');
    const isDelete = line.startsWith('*** Delete File: ');
    const path = line.slice(line.indexOf(': ') + 2).trim();
    const headerLineNo = i + 1;
    // Collect the section's lines, up to the next section or `*** End Patch`, then drop the blank lines
    // at the end of the section: they are not part of it.
    let j = i + 1;
    while (j < last && !isV4aSectionStart(lines[j]!)) j += 1;
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (isAdd) {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      const p = path;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (isDelete) {
      if (raw.length > 0) throw new Exit2(`error: parse ${i + 2}`);
      const p = path;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const { moveTo, chunks } = parseV4aChunks(raw, headerLineNo, i + 1);
      const p = path;
      const mv = moveTo;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        let model = parseFile(before);
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            const a = firstTier([chunk.anchor], model.lines, strict, cursor, false);
            if (a === null) throw new Fail('no-match', p);
            cursor = a.positions[0]! + 1;
          }
          if (chunk.O.length === 0) {
            const at = chunk.eof ? model.lines.length : cursor;
            const ins = chunk.N.map((n) => n.text);
            model = { lines: [...model.lines.slice(0, at), ...ins, ...model.lines.slice(at)], br: model.br, finalBr: model.finalBr };
            cursor = at + ins.length;
            continue;
          }
          const found = firstTier(chunk.O, model.lines, strict, cursor, chunk.eof);
          if (found === null) throw new Fail('no-match', p);
          const pos = found.positions[0]!;
          const repl = buildReplacement(chunk.O, chunk.N, model.lines, pos, found.tier);
          model = {
            lines: [...model.lines.slice(0, pos), ...repl, ...model.lines.slice(pos + chunk.O.length)],
            br: model.br,
            finalBr: model.finalBr,
          };
          cursor = pos + repl.length;
        }
        const out = serializeFile(model);
        if (mv !== null) {
          tree.now.set(p, null);
          tree.now.set(mv, out);
          tree.moves.push([p, mv]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const wasNew = tree.original(newP);
    if (wasOld !== null && wasNew === null && tree.get(oldP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
