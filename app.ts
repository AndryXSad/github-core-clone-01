// Forge: a GitHub-compatible git forge in one Node process (stdlib only).
// Git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4, MCP.
// Deterministic: no wall-clock or randomness in exported state.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, createInflate } from 'node:zlib';

const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const STRANGER_LOGIN = 'olgabauer';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const FIXED_TS = 1700000000;
const FIXED_ISO = '2025-01-01T00:00:00Z';
const IDENTITY = 'Conformance <conformance@make.fun>';
const ZERO_OID = '0000000000000000000000000000000000000000';
const FORGE_AGENT = 'forge/1.0';

function sha1hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}
function sha1Buffer(buf: Buffer): Buffer {
  return createHash('sha1').update(buf).digest();
}
function hashObject(type: string, data: Buffer): { oid: string; obj: GitObject } {
  const header = Buffer.from(`${type} ${data.length}\0`);
  const oid = sha1hex(Buffer.concat([header, data]));
  return { oid, obj: { type, data } };
}
function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}
function pktLine(payload: Buffer | string): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'));
  return Buffer.concat([head, data]);
}
const FLUSH = Buffer.from('0000');
const DELIM = Buffer.from('0001');
function pktLines(items: (Buffer | string)[]): Buffer {
  return Buffer.concat([...items.map((x) => pktLine(x)), FLUSH]);
}
interface Pkt { kind: 'data' | 'flush' | 'delim' | 'response_end'; payload: Buffer }
function decodePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (head === '0001') { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (head === '0002') { packets.push({ kind: 'response_end', payload: Buffer.alloc(0) }); off += 4; continue; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------- git objects
type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject { type: ObjType; data: Buffer }
interface TreeEntry { mode: string; name: string; oid: string }
interface CommitInfo { tree: string; parents: string[]; author: string; committer: string; message: string }
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0) break;
    const mode = data.subarray(off, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}
function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? a.name + '/' : a.name;
    const kb = b.mode === '40000' ? b.name + '/' : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headers = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of headers.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}
function encodeCommit(tree: string, parents: string[], message: string, ts = FIXED_TS): Buffer {
  const who = `${IDENTITY} ${ts} +0000`;
  const head = `tree ${tree}\n` + parents.map((p) => `parent ${p}\n`).join('') +
    `author ${who}\ncommitter ${who}\n\n`;
  return Buffer.from(head + message, 'utf8');
}
function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headers = split >= 0 ? text.slice(0, split) : text;
  let object = '';
  let type = '';
  let tag = '';
  for (const line of headers.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}
function buildPack(objects: GitObject[]): Buffer {
  const entries: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  entries.push(header);
  const typeCode: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const obj of objects) {
    const size = obj.data.length;
    const head: number[] = [];
    let remaining = size;
    let first = (typeCode[obj.type] << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    head.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) b |= 0x80;
      head.push(b);
    }
    entries.push(Buffer.from(head), deflateSync(obj.data));
  }
  const body = Buffer.concat(entries);
  const trailer = sha1Buffer(body);
  return Buffer.concat([body, trailer]);
}
function inflateAt(buf: Buffer, off: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const inf = createInflate();
    const chunks: Buffer[] = [];
    inf.on('data', (c: Buffer) => chunks.push(c));
    inf.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: inf.bytesWritten }));
    inf.on('error', reject);
    inf.end(buf.subarray(off));
  });
}
async function readPack(buf: Buffer): Promise<Map<string, GitObject>> {
  if (buf.length < 32) throw new Error('pack too small');
  const trailer = buf.subarray(buf.length - 20);
  const expected = sha1Buffer(buf.subarray(0, buf.length - 20));
  if (!trailer.equals(expected)) throw new Error('pack trailer checksum mismatch');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad PACK magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = buf.readUInt32BE(8);
  const typeName: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const out = new Map<string, GitObject>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    if (off >= buf.length - 20) throw new Error('pack truncated');
    const b0 = buf[off++];
    const typeCode = (b0 >> 4) & 0x7;
    if (typeCode === 6 || typeCode === 7) throw new Error('delta pack not supported');
    const type = typeName[typeCode];
    if (!type) throw new Error('bad object type in pack');
    let size = b0 & 0x0f;
    let shift = 4;
    let b = b0;
    while (b & 0x80) {
      b = buf[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    const { data, consumed } = await inflateAt(buf, off);
    if (data.length !== size) throw new Error('object size mismatch');
    off += consumed;
    const { oid, obj } = hashObject(type, data);
    out.set(oid, obj);
  }
  return out;
}

// ---------------------------------------------------------------- store
interface IssueRec {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; seq: number;
  comments: { id: number; body: string }[];
}
interface PullRec {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  head: string; base: string; seq: number;
}
interface Repo {
  seq: number; owner: string; name: string; priv: boolean; description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: IssueRec[]; pulls: PullRec[];
  nextNumber: number; nextCommentId: number;
}
const repos = new Map<string, Repo>();
let nextRepoSeq = 0;
let nextGlobalId = 10000;
function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}\0${name.toLowerCase()}`;
}
function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}
function createRepo(owner: string, name: string, priv: boolean, description: string): Repo {
  const repo: Repo = {
    seq: ++nextRepoSeq, owner, name, priv, description,
    defaultBranch: 'main',
    objects: new Map(), refs: new Map(), labels: new Map(),
    issues: [], pulls: [], nextNumber: 1, nextCommentId: 1,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}
function refTip(repo: Repo, refName: string): string | undefined {
  return repo.refs.get(refName);
}
function resolveRef(repo: Repo, ref: string): string | undefined {
  if (isOid(ref)) return repo.objects.has(ref) ? ref : undefined;
  const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  return repo.refs.get(full);
}
function collectCommitClosure(repo: Repo, commitOids: string[]): Set<string> {
  // Commits plus their tree closures, WITHOUT following commit parents.
  // Used for depth-limited fetches: only the depth-limited commits may be sent.
  const seen = new Set<string>();
  const stack = [...commitOids];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      stack.push(parseCommit(obj.data).tree);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') stack.push(e.oid);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}
function collectReachable(repo: Repo, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') stack.push(e.oid);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}
function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') stack.push(...parseCommit(obj.data).parents);
  }
  return false;
}
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const distA = new Map<string, number>();
  const queueA: [string, number][] = [[a, 0]];
  while (queueA.length > 0) {
    const [oid, d] = queueA.shift() as [string, number];
    if (distA.has(oid)) continue;
    distA.set(oid, d);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) queueA.push([p, d + 1]);
    }
  }
  const distB = new Map<string, number>();
  const queueB: [string, number][] = [[b, 0]];
  let best: string | null = null;
  let bestSum = Infinity;
  while (queueB.length > 0) {
    const [oid, d] = queueB.shift() as [string, number];
    if (distB.has(oid)) continue;
    distB.set(oid, d);
    if (distA.has(oid)) {
      const sum = (distA.get(oid) as number) + d;
      if (sum < bestSum) { bestSum = sum; best = oid; }
    }
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) queueB.push([p, d + 1]);
    }
  }
  return best;
}
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, string>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else if (e.mode !== '160000') out.set(path, e.oid);
  }
}
function buildTreeFromFlat(repo: Repo, files: Map<string, string>): string {
  const root = new Map<string, Map<string, string>>();
  function dirAt(path: string): Map<string, string> {
    let m = root.get(path);
    if (!m) { m = new Map(); root.set(path, m); }
    return m;
  }
  for (const [path, oid] of files) {
    const parts = path.split('/');
    const file = parts.pop() as string;
    const dir = parts.join('/');
    dirAt(dir).set(file, oid);
  }
  const built = new Map<string, string>();
  function build(dir: string): string {
    const cached = built.get(dir);
    if (cached) return cached;
    const entries: TreeEntry[] = [];
    for (const [name, oid] of dirAt(dir)) entries.push({ mode: '100644', name, oid });
    for (const [sub] of root) {
      if (sub === dir) continue;
      const parent = sub.includes('/') ? sub.slice(0, sub.lastIndexOf('/')) : '';
      if (parent === dir) {
        const name = sub.slice(dir ? dir.length + 1 : 0);
        entries.push({ mode: '40000', name, oid: build(sub) });
      }
    }
    const { oid, obj } = hashObject('tree', encodeTree(entries));
    repo.objects.set(oid, obj);
    built.set(dir, oid);
    return oid;
  }
  return build('');
}
function commitForBranch(repo: Repo, branch: string, message: string, mutate: (files: Map<string, string>) => void): { commitSha: string } {
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  const files = new Map<string, string>();
  if (tip) {
    const c = parseCommit((repo.objects.get(tip) as GitObject).data);
    flattenTree(repo, c.tree, '', files);
  }
  mutate(files);
  const treeOid = buildTreeFromFlat(repo, files);
  const parents = tip ? [tip] : [];
  const data = encodeCommit(treeOid, parents, message);
  const { oid, obj } = hashObject('commit', data);
  repo.objects.set(oid, obj);
  repo.refs.set(refName, oid);
  return { commitSha: oid };
}
function filesChanged(repo: Repo, baseOid: string, headOid: string): { path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] {
  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  if (baseOid && repo.objects.has(baseOid)) {
    const c = parseCommit((repo.objects.get(baseOid) as GitObject).data);
    flattenTree(repo, c.tree, '', baseFiles);
  }
  if (headOid && repo.objects.has(headOid)) {
    const c = parseCommit((repo.objects.get(headOid) as GitObject).data);
    flattenTree(repo, c.tree, '', headFiles);
  }
  const out: { path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] = [];
  const all = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...all].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b === h) continue;
    if (b === undefined) {
      const n = (repo.objects.get(h as string)?.data.toString('utf8').split('\n').filter((l) => l.length > 0).length ?? 0) || 1;
      out.push({ path, status: 'added', additions: n, deletions: 0, changes: n });
    } else if (h === undefined) {
      const n = (repo.objects.get(b)?.data.toString('utf8').split('\n').filter((l) => l.length > 0).length ?? 0) || 1;
      out.push({ path, status: 'removed', additions: 0, deletions: n, changes: n });
    } else {
      const bl = repo.objects.get(b)?.data.toString('utf8').split('\n') ?? [];
      const hl = repo.objects.get(h)?.data.toString('utf8').split('\n') ?? [];
      const additions = hl.filter((l) => !bl.includes(l)).length;
      const deletions = bl.filter((l) => !hl.includes(l)).length;
      out.push({ path, status: 'modified', additions: Math.max(additions, 1), deletions, changes: Math.max(additions, 1) + deletions });
    }
  }
  return out;
}
function prMergeable(repo: Repo, pr: PullRec): 'MERGEABLE' | 'CONFLICTING' {
  const headTip = resolveRef(repo, pr.head);
  const baseTip = resolveRef(repo, pr.base);
  if (!headTip || !baseTip) return 'CONFLICTING';
  if (isAncestor(repo, baseTip, headTip)) return 'MERGEABLE';
  const base = mergeBase(repo, headTip, baseTip);
  if (!base) return 'CONFLICTING';
  const headFiles = new Map<string, string>();
  const baseFiles = new Map<string, string>();
  const mergeFiles = new Map<string, string>();
  const hc = parseCommit((repo.objects.get(headTip) as GitObject).data);
  flattenTree(repo, hc.tree, '', headFiles);
  const bc = parseCommit((repo.objects.get(baseTip) as GitObject).data);
  flattenTree(repo, bc.tree, '', baseFiles);
  const mc = parseCommit((repo.objects.get(base) as GitObject).data);
  flattenTree(repo, mc.tree, '', mergeFiles);
  for (const path of new Set([...headFiles.keys(), ...baseFiles.keys(), ...mergeFiles.keys()])) {
    const m = mergeFiles.get(path);
    const h = headFiles.get(path);
    const b = baseFiles.get(path);
    if (h !== m && b !== m && h !== b) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}
function squashMerge(repo: Repo, pr: PullRec): { sha: string } | { error: string } {
  const headTip = resolveRef(repo, pr.head);
  const baseTip = resolveRef(repo, pr.base);
  if (!headTip || !baseTip) return { error: 'branch not found' };
  if (prMergeable(repo, pr) !== 'MERGEABLE') return { error: 'conflict' };
  const base = isAncestor(repo, baseTip, headTip) ? baseTip : (mergeBase(repo, headTip, baseTip) as string);
  const headFiles = new Map<string, string>();
  const baseFiles = new Map<string, string>();
  const mergeFiles = new Map<string, string>();
  const hc = parseCommit((repo.objects.get(headTip) as GitObject).data);
  flattenTree(repo, hc.tree, '', headFiles);
  const bc = parseCommit((repo.objects.get(baseTip) as GitObject).data);
  flattenTree(repo, bc.tree, '', baseFiles);
  const mc = parseCommit((repo.objects.get(base) as GitObject).data);
  flattenTree(repo, mc.tree, '', mergeFiles);
  const merged = new Map<string, string>(baseFiles);
  for (const path of new Set([...headFiles.keys(), ...mergeFiles.keys()])) {
    const m = mergeFiles.get(path);
    const h = headFiles.get(path);
    if (h !== m) {
      if (h === undefined) merged.delete(path);
      else merged.set(path, h);
    }
  }
  const treeOid = buildTreeFromFlat(repo, merged);
  const message = `${pr.title} (#${pr.number})\n\nSquashed commit of the following commits:\n\n${hc.message}`;
  const data = encodeCommit(treeOid, [baseTip], message);
  const { oid, obj } = hashObject('commit', data);
  repo.objects.set(oid, obj);
  repo.refs.set(`refs/heads/${pr.base}`, oid);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = FIXED_ISO;
  pr.mergeCommitSha = oid;
  return { sha: oid };
}

// ---------------------------------------------------------------- HTTP plumbing
let requestCounter = 0;
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > 64 * 1024 * 1024) { reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${++requestCounter}`,
    ...headers,
  });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `req-${++requestCounter}`,
    ...headers,
  });
  res.end(body);
}
function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!SHOP_TOKEN) return h.startsWith('Bearer ') && h.length > 7;
  return h === `Bearer ${SHOP_TOKEN}`;
}
function parseJsonBody(buf: Buffer): unknown {
  if (buf.length === 0) return {};
  return JSON.parse(buf.toString('utf8'));
}
function bodyObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function paginate<T>(items: T[], url: URL, host: string): { page: T[]; link: string | null } {
  const perPageRaw = parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = parseInt(url.searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  // Link URLs must stay on the entry's own origin (the request's Host), or a
  // client following rel="next" leaves the origin and fails the check.
  const origin = `http://${host}`;
  const mk = (p: number): string => {
    const q = new URLSearchParams(url.searchParams);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${origin}${url.pathname}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (page < totalPages) { parts.push(`${mk(page + 1)}; rel="next"`); parts.push(`${mk(totalPages)}; rel="last"`); }
  if (page > 1) { parts.push(`${mk(1)}; rel="first"`); parts.push(`${mk(page - 1)}; rel="prev"`); }
  return { page: pageItems, link: parts.length > 0 ? parts.join(', ') : null };
}
function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.seq, node_id: `R_${r.seq}`, name: r.name, full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: r.owner === VIEWER_LOGIN ? VIEWER_ID : 1001, type: 'User' },
    private: r.priv, description: r.description, default_branch: r.defaultBranch,
    has_issues: true, has_projects: false, has_wiki: false, has_pages: false, has_downloads: false,
    html_url: `https://example.invalid/${r.owner}/${r.name}`,
    url: `/api/v3/repos/${r.owner}/${r.name}`,
    created_at: FIXED_ISO, updated_at: FIXED_ISO, pushed_at: FIXED_ISO,
    fork: false, archived: false, disabled: false, size: 0, language: null,
    visibility: r.priv ? 'private' : 'public', topics: [],
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}
function issueJson(r: Repo, i: IssueRec): Record<string, unknown> {
  return {
    id: i.id, node_id: `I_${r.seq}_${i.number}`, number: i.number, title: i.title,
    body: i.body, state: i.state,
    labels: i.labels.map((name) => ({ name, color: r.labels.get(name)?.color ?? '000000' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignees: [], milestone: null, locked: false,
    created_at: FIXED_ISO, updated_at: FIXED_ISO, closed_at: i.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://example.invalid/${r.owner}/${r.name}/issues/${i.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
    comments: i.comments.length, comments_url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}/comments`,
  };
}
function pullJson(r: Repo, p: PullRec): Record<string, unknown> {
  const headSha = resolveRef(r, p.head) ?? ZERO_OID;
  const baseSha = resolveRef(r, p.base) ?? ZERO_OID;
  return {
    id: p.id, node_id: `P_${r.seq}_${p.number}`, number: p.number, title: p.title,
    body: p.body, state: p.state, locked: false,
    head: { ref: p.head, sha: headSha, label: `${r.owner}:${p.head}`, user: { login: VIEWER_LOGIN, id: VIEWER_ID } },
    base: { ref: p.base, sha: baseSha, label: `${r.owner}:${p.base}`, user: { login: VIEWER_LOGIN, id: VIEWER_ID } },
    merged: p.merged, merged_at: p.mergedAt, merge_commit_sha: p.mergeCommitSha,
    mergeable: prMergeable(r, p) === 'MERGEABLE',
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO, updated_at: FIXED_ISO, closed_at: p.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://example.invalid/${r.owner}/${r.name}/pull/${p.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
  };
}
function commitJson(r: Repo, oid: string): Record<string, unknown> {
  const obj = r.objects.get(oid);
  const info = obj && obj.type === 'commit' ? parseCommit(obj.data) : { tree: '', parents: [], author: '', committer: '', message: '' };
  const who = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <(.*)> \d+ [+-]\d{4}$/.exec(line.trim());
    if (m) return { name: m[1], email: m[2], date: FIXED_ISO };
    return { name: 'Conformance', email: 'conformance@make.fun', date: FIXED_ISO };
  };
  return {
    sha: oid, node_id: `C_${oid.slice(0, 12)}`,
    commit: { message: info.message, author: who(info.author), committer: who(info.committer), tree: { sha: info.tree } },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: info.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${r.owner}/${r.name}/commits/${oid}`,
    html_url: `https://example.invalid/${r.owner}/${r.name}/commit/${oid}`,
  };
}
function findIssue(r: Repo, n: number): IssueRec | undefined {
  return r.issues.find((i) => i.number === n);
}
function findPull(r: Repo, n: number): PullRec | undefined {
  return r.pulls.find((p) => p.number === n);
}
function createIssueRec(r: Repo, title: string, body: string, labels: string[]): IssueRec {
  const rec: IssueRec = {
    id: nextGlobalId++, number: r.nextNumber++, title, body, state: 'open',
    labels: [...labels], seq: r.issues.length + r.pulls.length + 1, comments: [],
  };
  r.issues.push(rec);
  return rec;
}
function createPullRec(r: Repo, title: string, body: string, head: string, base: string): PullRec {
  const rec: PullRec = {
    id: nextGlobalId++, number: r.nextNumber++, title, body, state: 'open',
    merged: false, mergedAt: null, mergeCommitSha: null, head, base,
    seq: r.issues.length + r.pulls.length + 1,
  };
  r.pulls.push(rec);
  return rec;
}

// ---------------------------------------------------------------- REST v3
async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const scopes = { 'x-oauth-scopes': 'repo, read:org' };
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}', authorizations_url: '/api/v3/authorizations',
    }, scopes);
    return;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0' }, scopes);
    return;
  }
  if (!authed(req)) { errJson(res, 401, 'Requires authentication'); return; }
  const bodyBuf = await readBody(req);
  let body: unknown = {};
  if (bodyBuf.length > 0) {
    try { body = parseJsonBody(bodyBuf); } catch { errJson(res, 400, 'Problems parsing JSON'); return; }
  }
  const b = bodyObj(body);
  const segs = path.split('/').filter((s) => s.length > 0).slice(2); // after api/v3
  const dec = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

  // POST /user/repos
  if (method === 'POST' && segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    const name = str(b.name);
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) { errJson(res, 422, 'name is invalid'); return; }
    if (getRepo(VIEWER_LOGIN, name)) { errJson(res, 422, 'Repository creation failed. Name already exists on this account.'); return; }
    const repo = createRepo(VIEWER_LOGIN, name, b.private === true, str(b.description));
    sendJson(res, 201, repoJson(repo));
    return;
  }
  // GET /user/repos
  if (method === 'GET' && segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    const all = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((x, y) => x.seq - y.seq);
    const { page, link } = paginate(all.map((r) => repoJson(r)), url, req.headers.host ?? 'entry');
    sendJson(res, 200, page, link ? { link } : {});
    return;
  }
  // /repos/{owner}/{name}/...
  if (segs.length >= 3 && segs[0] === 'repos') {
    const owner = dec(segs[1]);
    const name = dec(segs[2]);
    if (owner !== VIEWER_LOGIN) { errJson(res, 404, 'Not Found'); return; }
    const repo = getRepo(owner, name);
    const rest = segs.slice(3);
    if (!repo) { errJson(res, 404, 'Not Found'); return; }
    // GET/PATCH/DELETE repo
    if (rest.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.priv = b.private;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        res.writeHead(204, { 'x-github-request-id': `req-${++requestCounter}` });
        res.end();
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    // branches
    if (rest[0] === 'branches') {
      if (method !== 'GET') { errJson(res, 404, 'Not Found'); return; }
      const branchNames = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice(11)).sort();
      if (rest.length === 1) {
        const list = branchNames.map((bn) => ({
          name: bn, commit: { sha: repo.refs.get(`refs/heads/${bn}`) ?? ZERO_OID, url: `/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(`refs/heads/${bn}`) ?? ZERO_OID}` },
          protected: false,
        }));
        sendJson(res, 200, list);
        return;
      }
      const branch = rest.slice(1).map(dec).join('/');
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (!tip) { errJson(res, 404, 'Branch not found'); return; }
      sendJson(res, 200, {
        name: branch, commit: { sha: tip, url: `/api/v3/repos/${owner}/${name}/commits/${tip}` },
        protected: false,
      });
      return;
    }
    // commits
    if (rest[0] === 'commits') {
      if (method !== 'GET') { errJson(res, 404, 'Not Found'); return; }
      const shaParam = url.searchParams.get('sha');
      const start = shaParam ? resolveRef(repo, shaParam) : refTip(repo, `refs/heads/${repo.defaultBranch}`);
      const out: Record<string, unknown>[] = [];
      if (start) {
        const seen = new Set<string>();
        const stack = [start];
        while (stack.length > 0 && out.length < 1000) {
          const oid = stack.pop() as string;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const obj = repo.objects.get(oid);
          if (!obj || obj.type !== 'commit') continue;
          out.push(commitJson(repo, oid));
          stack.push(...parseCommit(obj.data).parents);
        }
      }
      sendJson(res, 200, out);
      return;
    }
    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = str(b.ref);
        const sha = str(b.sha);
        if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) { errJson(res, 422, 'Invalid ref'); return; }
        if (!isOid(sha) || !repo.objects.has(sha)) { errJson(res, 422, 'Object does not exist'); return; }
        if (repo.refs.has(ref)) { errJson(res, 422, 'Reference already exists'); return; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: `R_${ref}`, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` } });
        return;
      }
      if (method === 'GET' && rest.length >= 3 && rest[2] === 'heads') {
        const branch = rest.slice(3).map(dec).join('/');
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) { errJson(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { ref: `refs/heads/${branch}`, node_id: `R_refs/heads/${branch}`, object: { sha: tip, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${tip}` } });
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    // contents
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map(dec).join('/');
      const refParam = url.searchParams.get('ref');
      const tip = refParam ? resolveRef(repo, refParam) : refTip(repo, `refs/heads/${repo.defaultBranch}`);
      if (method === 'GET') {
        if (!tip) { errJson(res, 404, 'Not Found'); return; }
        const commit = parseCommit((repo.objects.get(tip) as GitObject).data);
        const files = new Map<string, string>();
        flattenTree(repo, commit.tree, '', files);
        if (filePath === '') {
          const top = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
          for (const [p, oid] of files) {
            const first = p.split('/')[0];
            if (p.includes('/')) {
              if (!top.has(first)) top.set(first, { type: 'dir', name: first, path: first, sha: '' });
            } else {
              top.set(first, { type: 'file', name: first, path: first, sha: oid });
            }
          }
          sendJson(res, 200, [...top.values()].sort((a, z) => a.name.localeCompare(z.name)));
          return;
        }
        const oid = files.get(filePath);
        if (oid) {
          const data = (repo.objects.get(oid) as GitObject).data;
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: data.length,
            name: filePath.split('/').pop(), path: filePath,
            content: data.toString('base64'), sha: oid,
            url: `/api/v3/repos/${owner}/${name}/contents/${filePath}`,
            html_url: `https://example.invalid/${owner}/${name}/blob/${repo.defaultBranch}/${filePath}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${oid}`,
          });
          return;
        }
        const dirPrefix = filePath + '/';
        const entries: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] = [];
        const seen = new Set<string>();
        for (const [p, o] of files) {
          if (!p.startsWith(dirPrefix)) continue;
          const rest2 = p.slice(dirPrefix.length);
          const first = rest2.split('/')[0];
          if (seen.has(first)) continue;
          seen.add(first);
          if (rest2.includes('/')) entries.push({ type: 'dir', name: first, path: `${filePath}/${first}`, sha: '' });
          else entries.push({ type: 'file', name: first, path: p, sha: o });
        }
        if (entries.length > 0) { sendJson(res, 200, entries.sort((a, z) => a.name.localeCompare(z.name))); return; }
        errJson(res, 404, 'Not Found'); return;
      }
      if (method === 'PUT') {
        const message = str(b.message) || 'Update file';
        const contentB64 = str(b.content);
        const shaGiven = str(b.sha);
        const branch = str(b.branch) || repo.defaultBranch;
        if (!/^[A-Za-z0-9+/=]+$/.test(contentB64)) { errJson(res, 422, 'content is not valid Base64'); return; }
        const content = Buffer.from(contentB64, 'base64');
        const branchTip = refTip(repo, `refs/heads/${branch}`);
        const files = new Map<string, string>();
        if (branchTip) {
          const c = parseCommit((repo.objects.get(branchTip) as GitObject).data);
          flattenTree(repo, c.tree, '', files);
        }
        const existing = files.get(filePath);
        if (existing) {
          if (!shaGiven) { errJson(res, 422, 'sha is required when updating a file'); return; }
          if (shaGiven !== existing) { errJson(res, 409, 'sha does not match the current file'); return; }
        } else if (shaGiven) {
          errJson(res, 422, 'sha provided for a new file'); return;
        }
        const { oid: blobOid, obj: blobObj } = hashObject('blob', content);
        repo.objects.set(blobOid, blobObj);
        const { commitSha } = commitForBranch(repo, branch, message, (f) => { f.set(filePath, blobOid); });
        sendJson(res, existing ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, encoding: 'base64', content: contentB64 },
          commit: { sha: commitSha, message },
        });
        return;
      }
      if (method === 'DELETE') {
        const message = str(b.message) || 'Delete file';
        const shaGiven = str(b.sha);
        const branch = str(b.branch) || repo.defaultBranch;
        const branchTip = refTip(repo, `refs/heads/${branch}`);
        if (!branchTip) { errJson(res, 404, 'Not Found'); return; }
        const files = new Map<string, string>();
        const c = parseCommit((repo.objects.get(branchTip) as GitObject).data);
        flattenTree(repo, c.tree, '', files);
        const existing = files.get(filePath);
        if (!existing) { errJson(res, 404, 'Not Found'); return; }
        if (shaGiven && shaGiven !== existing) { errJson(res, 409, 'sha does not match the current file'); return; }
        const { commitSha } = commitForBranch(repo, branch, message, (f) => { f.delete(filePath); });
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    // labels
    if (rest[0] === 'labels') {
      if (method === 'POST') {
        const name = str(b.name);
        const color = str(b.color) || '000000';
        if (!name) { errJson(res, 422, 'name is required'); return; }
        repo.labels.set(name, { name, color });
        sendJson(res, 201, { name, color, description: '' });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = str(b.title);
          if (!title) { errJson(res, 422, 'title is required'); return; }
          const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).map((l) => String(l)) : [];
          for (const l of labels) {
            if (!repo.labels.has(l)) { errJson(res, 422, `Label does not exist: ${l}`); return; }
          }
          const issue = createIssueRec(repo, title, str(b.body), labels);
          sendJson(res, 201, issueJson(repo, issue));
          return;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const sort = url.searchParams.get('sort') ?? 'created';
          const direction = url.searchParams.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const cmp = sort === 'created' ? (a: IssueRec, z: IssueRec) => a.seq - z.seq : (a: IssueRec, z: IssueRec) => a.seq - z.seq;
          list.sort((a, z) => (direction === 'desc' ? -cmp(a, z) : cmp(a, z)));
          const { page, link } = paginate(list.map((i) => issueJson(repo, i)), url, req.headers.host ?? 'entry');
          sendJson(res, 200, page, link ? { link } : {});
          return;
        }
        errJson(res, 404, 'Not Found'); return;
      }
      const num = parseInt(rest[1], 10);
      const issue = Number.isFinite(num) ? findIssue(repo, num) : undefined;
      if (rest.length === 2) {
        if (!issue) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
        if (method === 'PATCH') {
          if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) issue.state = b.state;
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        errJson(res, 404, 'Not Found'); return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'POST') {
          const comment = { id: nextGlobalId++, body: str(b.body) };
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, node_id: `C_${repo.seq}_${issue.number}_${issue.comments.length}`, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: FIXED_ISO, updated_at: FIXED_ISO });
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((cm, idx) => ({ id: cm.id, node_id: `C_${repo.seq}_${issue.number}_${idx + 1}`, body: cm.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: FIXED_ISO, updated_at: FIXED_ISO })));
          return;
        }
        errJson(res, 404, 'Not Found'); return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = str(b.title);
          const head = str(b.head);
          const base = str(b.base);
          if (!title || !head || !base) { errJson(res, 422, 'title, head and base are required'); return; }
          if (!resolveRef(repo, head) || !resolveRef(repo, base)) { errJson(res, 422, 'head or base branch does not exist'); return; }
          const dup = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
          if (dup) { errJson(res, 422, 'A pull request already exists for this branch combination.'); return; }
          const pr = createPullRec(repo, title, str(b.body), head, base);
          sendJson(res, 201, pullJson(repo, pr));
          return;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, z) => z.seq - a.seq);
          const { page, link } = paginate(list.map((p) => pullJson(repo, p)), url, req.headers.host ?? 'entry');
          sendJson(res, 200, page, link ? { link } : {});
          return;
        }
        errJson(res, 404, 'Not Found'); return;
      }
      const num = parseInt(rest[1], 10);
      const pr = Number.isFinite(num) ? findPull(repo, num) : undefined;
      if (rest.length === 2) {
        if (!pr) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'GET') { sendJson(res, 200, pullJson(repo, pr)); return; }
        errJson(res, 404, 'Not Found'); return;
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pr) { errJson(res, 404, 'Not Found'); return; }
        if (method !== 'GET') { errJson(res, 404, 'Not Found'); return; }
        const headTip = resolveRef(repo, pr.head) ?? '';
        const baseTip = resolveRef(repo, pr.base) ?? '';
        const base = mergeBase(repo, headTip, baseTip);
        const diff = filesChanged(repo, base ?? baseTip, headTip);
        sendJson(res, 200, diff.map((d) => ({
          sha: '', filename: d.path, status: d.status, additions: d.additions, deletions: d.deletions, changes: d.changes,
          blob_url: '', raw_url: '', contents_url: '',
        })));
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pr) { errJson(res, 404, 'Not Found'); return; }
        if (method !== 'PUT') { errJson(res, 404, 'Not Found'); return; }
        if (pr.state !== 'open') { errJson(res, 405, 'Pull Request is not mergeable'); return; }
        const result = squashMerge(repo, pr);
        if ('error' in result) {
          if (result.error === 'conflict') { errJson(res, 405, 'Merge conflict'); return; }
          errJson(res, 422, result.error);
          return;
        }
        sendJson(res, 200, { merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  errJson(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- git smart HTTP
function refAdvertisement(repo: Repo, caps: string): Buffer {
  const parts: Buffer[] = [];
  const heads = [...repo.refs.entries()].filter(([r]) => r.startsWith('refs/heads/')).sort((a, b) => a[0].localeCompare(b[0]));
  const tags = [...repo.refs.entries()].filter(([r]) => r.startsWith('refs/tags/')).sort((a, b) => a[0].localeCompare(b[0]));
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? heads[0]?.[1] ?? ZERO_OID;
  const first = heads.length > 0 || tags.length > 0 || defaultTip !== ZERO_OID;
  if (first) {
    parts.push(pktLine(`${defaultTip} HEAD\0${caps}\n`));
  } else {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  }
  for (const [ref, oid] of heads) parts.push(pktLine(`${oid} ${ref}\n`));
  for (const [ref, oid] of tags) {
    parts.push(pktLine(`${oid} ${ref}\n`));
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const peeled = parseTag(obj.data).object;
      parts.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
function v2LsRefs(repo: Repo, args: Record<string, string | boolean | string[]>): Buffer {
  const prefixes = Array.isArray(args['ref-prefix']) ? args['ref-prefix'] : (typeof args['ref-prefix'] === 'string' ? [args['ref-prefix']] : []);
  const peel = args['peel'] === true;
  const symrefs = args['symrefs'] === true;
  const unborn = args['unborn'] === true;
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const entries: [string, string][] = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (matches('HEAD')) {
    if (headTip) {
      let line = `${headTip} HEAD`;
      if (symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      lines.push(line);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    }
  }
  for (const [ref, oid] of entries) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    const obj = repo.objects.get(oid);
    if (peel && obj && obj.type === 'tag') {
      line += ` peeled:${parseTag(obj.data).object}`;
    }
    lines.push(line);
  }
  return pktLines(lines.map((l) => l + '\n'));
}
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  let off = 0;
  while (off < pack.length) {
    const chunk = pack.subarray(off, off + 65515);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    off += chunk.length;
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const m = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
  if (!m) { errJson(res, 404, 'Not Found'); return; }
  const owner = decodeURIComponent(m[1]);
  const name = decodeURIComponent(m[2]);
  const suffix = m[3];
  if (!authed(req)) { errJson(res, 401, 'Requires authentication'); return; }
  if (owner !== VIEWER_LOGIN) { errJson(res, 404, 'Not Found'); return; }
  const repo = getRepo(owner, name);
  if (!repo) { errJson(res, 404, 'Not Found'); return; }
  if (method === 'GET' && suffix === 'info/refs') {
    const service = url.searchParams.get('service');
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (v2) {
        const body = pktLines(['version 2\n', `agent=${FORGE_AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n']);
        sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
        return;
      }
      const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k ofs-delta thin-pack agent=${FORGE_AGENT}`;
      const preamble = pktLine(`# service=git-upload-pack\n`);
      sendRaw(res, 200, Buffer.concat([preamble, FLUSH, refAdvertisement(repo, caps)]), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${FORGE_AGENT}`;
      const preamble = pktLine(`# service=git-receive-pack\n`);
      sendRaw(res, 200, Buffer.concat([preamble, FLUSH, refAdvertisement(repo, caps)]), 'application/x-git-receive-pack-advertisement');
      return;
    }
    errJson(res, 400, 'Invalid service'); return;
  }
  if (method === 'POST' && suffix === 'git-upload-pack') {
    let body: Buffer;
    try { body = await readBody(req); } catch { errJson(res, 400, 'Bad request'); return; }
    let parsed: { packets: Pkt[]; rest: Buffer };
    try { parsed = decodePktLines(body); } catch { errJson(res, 400, 'Bad pkt-line'); return; }
    const lines = parsed.packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
    const first = lines[0] ?? '';
    if (!first.startsWith('command=')) { errJson(res, 400, 'Expected command'); return; }
    const command = first.slice(8).trim();
    if (command === 'ls-refs') {
      const args: Record<string, string | boolean | string[]> = {};
      const prefixes: string[] = [];
      for (const line of lines.slice(1)) {
        const t = line.trim();
        if (t === 'peel') args['peel'] = true;
        else if (t === 'symrefs') args['symrefs'] = true;
        else if (t === 'unborn') args['unborn'] = true;
        else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice(11));
        else if (t.startsWith('ref-prefix=')) prefixes.push(t.slice(11));
      }
      if (prefixes.length > 0) args['ref-prefix'] = prefixes;
      sendRaw(res, 200, v2LsRefs(repo, args), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const prevShallow: string[] = [];
      let depth: number | null = null;
      for (const line of lines.slice(1)) {
        const t = line.trim();
        if (t.startsWith('want ')) wants.push(t.slice(5).trim());
        else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
        else if (t.startsWith('shallow ')) prevShallow.push(t.slice(8).trim());
        else if (t.startsWith('deepen ')) depth = parseInt(t.slice(7), 10);
        else if (t === 'done' || t === 'thin-pack' || t === 'no-progress' || t === 'ofs-delta' || t.startsWith('filter ') || t.startsWith('agent')) { /* ok */ }
      }
      const parts: Buffer[] = [];
      const wantReach = collectReachable(repo, wants.filter((w) => repo.objects.has(w)));
      if (haves.length > 0) {
        const common = haves.filter((h) => repo.objects.has(h) && wantReach.has(h));
        parts.push(pktLine('acknowledgments\n'));
        if (common.length > 0) {
          for (const c of common) parts.push(pktLine(`ACK ${c}\n`));
          // fetch-pack.c process_ack: a 'ready' ack section must end with DELIM (0001), not flush.
          parts.push(pktLine('ready\n'), DELIM);
        } else {
          // No common commits: NAK ends the section with a flush (kit-compatible).
          parts.push(pktLine('NAK\n'), FLUSH);
        }
      }
      let included: Set<string>;
      let newShallow: string[] = [];
      let unshallow: string[] = [];
      if (depth !== null) {
        // BFS from wants, depth-limited (depth = max commit distance + 1)
        const dist = new Map<string, number>();
        const q: [string, number][] = wants.filter((w) => repo.objects.has(w)).map((w) => [w, 0]);
        while (q.length > 0) {
          const [oid, d] = q.shift() as [string, number];
          if (dist.has(oid)) continue;
          dist.set(oid, d);
          if (d + 1 >= depth) continue;
          const obj = repo.objects.get(oid);
          if (obj && obj.type === 'commit') {
            for (const p of parseCommit(obj.data).parents) q.push([p, d + 1]);
          }
        }
        const commits = new Set(dist.keys());
        const boundary: string[] = [];
        for (const oid of commits) {
          const obj = repo.objects.get(oid);
          const parents = obj && obj.type === 'commit' ? parseCommit(obj.data).parents : [];
          if (parents.some((p) => !commits.has(p))) boundary.push(oid);
        }
        included = collectCommitClosure(repo, [...commits]);
        const delivered = included;
        newShallow = [...new Set([...boundary, ...prevShallow.filter((s) => !delivered.has(s))])];
        unshallow = prevShallow.filter((s) => delivered.has(s) && !newShallow.includes(s));
      } else {
        const wantReach = collectReachable(repo, wants.filter((w) => repo.objects.has(w)));
        const haveReach = collectReachable(repo, haves.filter((h) => repo.objects.has(h)));
        included = new Set([...wantReach].filter((o) => !haveReach.has(o)));
      }
      if (newShallow.length > 0 || unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const s of newShallow) parts.push(pktLine(`shallow ${s}\n`));
        for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
        parts.push(FLUSH);
      }
      const objs: GitObject[] = [];
      for (const oid of [...included].sort()) {
        const obj = repo.objects.get(oid);
        if (obj) objs.push(obj);
      }
      const pack = buildPack(objs);
      parts.push(pktLine('packfile\n'), sidebandPack(pack));
      sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    errJson(res, 400, 'Unknown command'); return;
  }
  if (method === 'POST' && suffix === 'git-receive-pack') {
    let body: Buffer;
    try { body = await readBody(req); } catch { errJson(res, 400, 'Bad request'); return; }
    let parsed: { packets: Pkt[]; rest: Buffer };
    try { parsed = decodePktLines(body); } catch { errJson(res, 400, 'Bad pkt-line'); return; }
    const dataPkts = parsed.packets.filter((p) => p.kind === 'data');
    const commands: { old: string; next: string; ref: string }[] = [];
    let bad = false;
    for (const p of dataPkts) {
      const line = p.payload.toString('utf8');
      const nul = line.indexOf('\0');
      const head = nul >= 0 ? line.slice(0, nul) : line;
      const parts = head.trim().split(' ');
      if (parts.length < 3 || !isOid(parts[0]) || !isOid(parts[1]) || !parts[2].startsWith('refs/')) { bad = true; break; }
      commands.push({ old: parts[0], next: parts[1], ref: parts[2] });
    }
    if (bad) { errJson(res, 400, 'Malformed receive-pack commands'); return; }
    const packBytes = parsed.rest;
    const report: string[] = [];
    let unpackOk = true;
    let unpackDetail = '';
    const incoming = new Map<string, GitObject>();
    const hasUpdates = commands.some((c) => c.next !== ZERO_OID);
    if (hasUpdates) {
      if (packBytes.length === 0) { unpackOk = false; unpackDetail = 'empty pack'; }
      else {
        try {
          const parsed2 = await readPack(packBytes);
          for (const [oid, obj] of parsed2) incoming.set(oid, obj);
        } catch (e) {
          unpackOk = false;
          unpackDetail = e instanceof Error ? e.message : 'unpack error';
        }
      }
    }
    const results: string[] = [];
    if (!unpackOk) {
      report.push(`unpack ${unpackDetail}\n`);
      for (const c of commands) results.push(`ng ${c.ref} unpacker error\n`);
    } else {
      for (const [oid, obj] of incoming) repo.objects.set(oid, obj);
      report.push('unpack ok\n');
      for (const c of commands) {
        const current = repo.refs.get(c.ref);
        if (c.next === ZERO_OID) {
          // delete
          if (current === undefined) results.push(`ng ${c.ref} ref does not exist\n`);
          else if (current !== c.old) results.push(`ng ${c.ref} non-fast-forward\n`);
          else { repo.refs.delete(c.ref); results.push(`ok ${c.ref}\n`); }
        } else if (c.old === ZERO_OID) {
          // create
          if (current !== undefined) results.push(`ng ${c.ref} already exists\n`);
          else if (!repo.objects.has(c.next)) results.push(`ng ${c.ref} object not found\n`);
          else { repo.refs.set(c.ref, c.next); results.push(`ok ${c.ref}\n`); }
        } else {
          if (current === undefined) results.push(`ng ${c.ref} ref does not exist\n`);
          else if (current !== c.old) results.push(`ng ${c.ref} non-fast-forward\n`);
          else if (!repo.objects.has(c.next)) results.push(`ng ${c.ref} object not found\n`);
          else if (!isAncestor(repo, c.old, c.next)) results.push(`ng ${c.ref} non-fast-forward\n`);
          else { repo.refs.set(c.ref, c.next); results.push(`ok ${c.ref}\n`); }
        }
      }
    }
    const inner = Buffer.concat([pktLines([...report, ...results])]);
    const outer = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), FLUSH]);
    sendRaw(res, 200, outer, 'application/x-git-receive-pack-result');
    return;
  }
  errJson(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- GraphQL
interface GqlField {
  name: string; alias: string | null;
  args: Record<string, unknown>; selection: GqlSelection[] | null;
  inlineType: string | null;
}
type GqlSelection = GqlField | { fragment: true; typeCondition: string | null; selection: GqlSelection[] };
interface GqlOp { type: 'query' | 'mutation'; name: string | null; variables: Record<string, unknown>; selection: GqlSelection[] }
function gqlTokenize(src: string): { kind: string; value: string }[] {
  const toks: { kind: string; value: string }[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '{' || c === '}' || c === '(' || c === ')' || c === '[' || c === ']' || c === ':' || c === '!' || c === '=' || c === '|' || c === '&') {
      toks.push({ kind: 'punct', value: c }); i++; continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') { toks.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if (c === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j++;
      toks.push({ kind: 'var', value: src.slice(i + 1, j) }); i = j; continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; } else { out += src[j]; j++; }
      }
      toks.push({ kind: 'string', value: out }); i = j + 1; continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) j++;
      toks.push({ kind: 'number', value: src.slice(i, j) }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j++;
      toks.push({ kind: 'name', value: src.slice(i, j) }); i = j; continue;
    }
    throw new Error(`Unexpected character ${c}`);
  }
  return toks;
}
class GqlParser {
  toks: { kind: string; value: string }[]; pos = 0;
  constructor(src: string) { this.toks = gqlTokenize(src); }
  peek(): { kind: string; value: string } | undefined { return this.toks[this.pos]; }
  next(): { kind: string; value: string } { return this.toks[this.pos++] as { kind: string; value: string }; }
  expect(v: string): void {
    const t = this.next();
    if (t.value !== v) throw new Error(`Expected ${v}, got ${t.value}`);
  }
  parseValue(): unknown {
    const t = this.next();
    if (t.kind === 'var') return { __var: t.value };
    if (t.kind === 'string') return t.value;
    if (t.kind === 'number') return t.value.includes('.') || t.value.includes('e') ? parseFloat(t.value) : parseInt(t.value, 10);
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return { __enum: t.value };
    }
    if (t.value === '[') {
      const arr: unknown[] = [];
      while (this.peek()?.value !== ']') arr.push(this.parseValue());
      this.expect(']');
      return arr;
    }
    if (t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek()?.value !== '}') {
        const k = this.next();
        this.expect(':');
        obj[k.value] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    throw new Error(`Unexpected value token ${t.value}`);
  }
  parseArgs(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    this.expect('(');
    while (this.peek()?.value !== ')') {
      const k = this.next();
      this.expect(':');
      args[k.value] = this.parseValue();
    }
    this.expect(')');
    return args;
  }
  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const sels: GqlSelection[] = [];
    while (this.peek()?.value !== '}') {
      const t = this.peek() as { kind: string; value: string };
      if (t.value === '...') {
        this.next();
        const n = this.peek() as { kind: string; value: string };
        if (n.value === 'on') {
          this.next();
          const tc = this.next();
          sels.push({ fragment: true, typeCondition: tc.value, selection: this.parseSelectionSet() });
        } else {
          throw new Error('Named fragments not supported');
        }
      } else {
        const first = this.next();
        let name = first.value;
        let alias: string | null = null;
        if (this.peek()?.value === ':') {
          this.next();
          alias = name;
          name = this.next().value;
        }
        let args: Record<string, unknown> = {};
        if (this.peek()?.value === '(') args = this.parseArgs();
        let selection: GqlSelection[] | null = null;
        if (this.peek()?.value === '{') selection = this.parseSelectionSet();
        sels.push({ name, alias, args, selection, inlineType: null });
      }
    }
    this.expect('}');
    return sels;
  }
  parseDocument(): GqlOp[] {
    const ops: GqlOp[] = [];
    while (this.pos < this.toks.length) {
      const t = this.next();
      let type: 'query' | 'mutation' = 'query';
      let name: string | null = null;
      if (t.value === 'query' || t.value === 'mutation') {
        type = t.value as 'query' | 'mutation';
        const n = this.peek();
        if (n && n.kind === 'name') name = this.next().value;
        if (this.peek()?.value === '(') {
          // variable definitions — skip
          let depth = 0;
          do {
            const tk = this.next();
            if (tk.value === '(' || tk.value === '[') depth++;
            if (tk.value === ')' || tk.value === ']') depth--;
          } while (depth > 0 && this.pos < this.toks.length);
        }
      } else if (t.value === '{') {
        this.pos--;
      } else {
        throw new Error(`Unexpected document token ${t.value}`);
      }
      const selection = this.parseSelectionSet();
      ops.push({ type, name, variables: {}, selection });
    }
    return ops;
  }
}
function resolveVars(v: unknown, vars: Record<string, unknown>): unknown {
  if (v !== null && typeof v === 'object' && '__var' in (v as Record<string, unknown>)) {
    return vars[(v as Record<string, unknown>).__var as string];
  }
  if (Array.isArray(v)) return v.map((x) => resolveVars(x, vars));
  if (v !== null && typeof v === 'object' && '__enum' in (v as Record<string, unknown>)) {
    return (v as Record<string, unknown>).__enum;
  }
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = resolveVars(x, vars);
    return out;
  }
  return v;
}
const INTROSPECTION: Record<string, { fields: string[]; enumValues?: string[] }> = {
  Issue: { fields: ['id', 'number', 'title', 'body', 'state', 'labels', 'comments', 'author', 'createdAt', 'updatedAt', 'url', 'repository'] },
  PullRequest: { fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'author', 'createdAt', 'updatedAt'] },
  Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'] },
  User: { fields: ['id', 'login', 'name', 'email', 'avatarUrl'] },
  IssueConnection: { fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  SearchType: { fields: [], enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL', 'TEAM', 'ORGANIZATION', 'PROJECT', 'CODE', 'WIKI'] },
  IssueState: { fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  OrderDirection: { fields: [], enumValues: ['ASC', 'DESC'] },
};
interface GqlObj { __typename: string; [key: string]: unknown }
function gqlCursor(index: number): string {
  return Buffer.from(`c:${index}`).toString('base64url');
}
function gqlCursorIndex(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^c:(\d+)$/.exec(decoded);
    return m ? parseInt(m[1], 10) : -1;
  } catch { return -1; }
}
function repoGql(r: Repo): GqlObj {
  return {
    __typename: 'Repository', id: `R_${r.seq}`, databaseId: r.seq, name: r.name,
    nameWithOwner: `${r.owner}/${r.name}`, owner: { __typename: 'User', id: `U_${VIEWER_ID}`, login: r.owner, name: r.owner === VIEWER_LOGIN ? 'ada iversen' : r.owner, email: VIEWER_EMAIL },
    defaultBranchRef: { __typename: 'Ref', name: r.defaultBranch },
    viewerPermission: 'ADMIN', hasIssuesEnabled: true, description: r.description, private: r.priv,
    createdAt: FIXED_ISO, updatedAt: FIXED_ISO, url: `https://example.invalid/${r.owner}/${r.name}`,
    __repo: r,
  };
}
function issueGql(r: Repo, i: IssueRec): GqlObj {
  return {
    __typename: 'Issue', id: `I_${r.seq}_${i.number}`, number: i.number, title: i.title,
    body: i.body, state: i.state === 'open' ? 'OPEN' : 'CLOSED',
    labels: { __typename: 'LabelConnection', nodes: i.labels.map((l) => ({ __typename: 'Label', name: l, color: r.labels.get(l)?.color ?? '000000' })) },
    comments: { __typename: 'IssueCommentConnection', nodes: i.comments.map((c, idx) => ({ __typename: 'IssueComment', id: `C_${r.seq}_${i.number}_${idx + 1}`, body: c.body, author: { __typename: 'User', login: VIEWER_LOGIN } })) },
    author: { __typename: 'User', login: VIEWER_LOGIN, id: `U_${VIEWER_ID}` },
    createdAt: FIXED_ISO, updatedAt: FIXED_ISO,
    url: `https://example.invalid/${r.owner}/${r.name}/issues/${i.number}`,
    __repo: r, __issue: i,
  };
}
function pullGql(r: Repo, p: PullRec): GqlObj {
  return {
    __typename: 'PullRequest', id: `P_${r.seq}_${p.number}`, number: p.number, title: p.title,
    body: p.body, state: p.merged ? 'MERGED' : (p.state === 'open' ? 'OPEN' : 'CLOSED'),
    merged: p.merged, mergeable: prMergeable(r, p),
    headRefName: p.head, baseRefName: p.base,
    headRef: { __typename: 'Ref', name: p.head, target: { __typename: 'Commit', oid: resolveRef(r, p.head) ?? ZERO_OID } },
    baseRef: { __typename: 'Ref', name: p.base, target: { __typename: 'Commit', oid: resolveRef(r, p.base) ?? ZERO_OID } },
    author: { __typename: 'User', login: VIEWER_LOGIN, id: `U_${VIEWER_ID}` },
    createdAt: FIXED_ISO, updatedAt: FIXED_ISO,
    __repo: r, __pull: p,
  };
}
function findByGlobalId(id: string): { kind: 'repo' | 'issue' | 'pull' | 'comment'; repo?: Repo; issue?: IssueRec; pull?: PullRec } | null {
  const parts = id.split('_');
  if (parts[0] === 'R' && parts.length === 2) {
    const repo = [...repos.values()].find((r) => r.seq === parseInt(parts[1] as string, 10));
    return repo ? { kind: 'repo', repo } : null;
  }
  if (parts[0] === 'I' && parts.length === 3) {
    const repo = [...repos.values()].find((r) => r.seq === parseInt(parts[1] as string, 10));
    const issue = repo ? findIssue(repo, parseInt(parts[2] as string, 10)) : undefined;
    return repo && issue ? { kind: 'issue', repo, issue } : null;
  }
  if (parts[0] === 'P' && parts.length === 3) {
    const repo = [...repos.values()].find((r) => r.seq === parseInt(parts[1] as string, 10));
    const pull = repo ? findPull(repo, parseInt(parts[2] as string, 10)) : undefined;
    return repo && pull ? { kind: 'pull', repo, pull } : null;
  }
  if (parts[0] === 'C' && parts.length === 4) {
    const repo = [...repos.values()].find((r) => r.seq === parseInt(parts[1] as string, 10));
    const issue = repo ? findIssue(repo, parseInt(parts[2] as string, 10)) : undefined;
    return repo && issue ? { kind: 'comment', repo, issue } : null;
  }
  return null;
}

// ---------------------------------------------------------------- GraphQL execution
function applySelection(parent: GqlObj, selection: GqlSelection[], vars: Record<string, unknown>, errors: { message: string }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if ('fragment' in sel) {
      if (sel.typeCondition && sel.typeCondition !== parent.__typename) continue;
      Object.assign(out, applySelection(parent, sel.selection, vars, errors));
      continue;
    }
    const field = sel as GqlField;
    const key = field.alias ?? field.name;
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(field.args)) args[k] = resolveVars(v, vars);
    const value = resolveGqlField(parent, field.name, args, errors);
    if (value === undefined) {
      out[key] = null;
      continue;
    }
    if (value !== null && typeof value === 'object' && '__typename' in (value as Record<string, unknown>) && field.selection) {
      out[key] = applySelection(value as GqlObj, field.selection, vars, errors);
    } else if (Array.isArray(value) && field.selection) {
      out[key] = value.map((item) => {
        if (item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
          return applySelection(item as GqlObj, field.selection as GqlSelection[], vars, errors);
        }
        return item;
      });
    } else {
      out[key] = value;
    }
  }
  return out;
}
function resolveGqlField(parent: GqlObj, name: string, args: Record<string, unknown>, errors: { message: string }[]): unknown {
  const type = parent.__typename;
  if (name === '__typename') return type;
  if (type === 'Query') {
    if (name === 'viewer') return { __typename: 'User', id: `U_${VIEWER_ID}`, login: VIEWER_LOGIN, name: 'ada iversen', email: VIEWER_EMAIL };
    if (name === 'repository') {
      const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoGql(repo) : null;
    }
    if (name === 'node') {
      const found = findByGlobalId(String(args.id ?? ''));
      if (!found) return null;
      if (found.kind === 'repo' && found.repo) return repoGql(found.repo);
      if (found.kind === 'issue' && found.repo && found.issue) return issueGql(found.repo, found.issue);
      if (found.kind === 'pull' && found.repo && found.pull) return pullGql(found.repo, found.pull);
      return null;
    }
    if (name === '__type') {
      const t = INTROSPECTION[String(args.name ?? '')];
      if (!t) return null;
      return {
        __typename: '__Type', name: String(args.name),
        fields: t.fields.map((f) => ({ __typename: '__Field', name: f })),
        enumValues: (t.enumValues ?? []).map((v) => ({ __typename: '__EnumValue', name: v })),
      };
    }
    errors.push({ message: `Cannot query field "${name}" on type "Query".` });
    return undefined;
  }
  if (type === 'Mutation') {
    if (name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findByGlobalId(String(input.repositoryId ?? ''));
      if (!found || found.kind !== 'repo' || !found.repo) { errors.push({ message: 'Could not resolve to a Repository with the global id provided.' }); return undefined; }
      const issue = createIssueRec(found.repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: issueGql(found.repo, issue) };
    }
    if (name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findByGlobalId(String(input.issueId ?? ''));
      if (!found || found.kind !== 'issue' || !found.repo || !found.issue) { errors.push({ message: 'Could not resolve to an Issue with the global id provided.' }); return undefined; }
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueGql(found.repo, found.issue) };
    }
    if (name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findByGlobalId(String(input.repositoryId ?? ''));
      if (!found || found.kind !== 'repo' || !found.repo) { errors.push({ message: 'Could not resolve to a Repository with the global id provided.' }); return undefined; }
      const repo = found.repo;
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (!resolveRef(repo, head) || !resolveRef(repo, base)) { errors.push({ message: 'head or base branch does not exist' }); return undefined; }
      const dup = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
      if (dup) { errors.push({ message: 'A pull request already exists for this branch combination.' }); return undefined; }
      const pr = createPullRec(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullGql(repo, pr) };
    }
    if (name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findByGlobalId(String(input.pullRequestId ?? ''));
      if (!found || found.kind !== 'pull' || !found.repo || !found.pull) { errors.push({ message: 'Could not resolve to a PullRequest with the global id provided.' }); return undefined; }
      const pr = found.pull;
      if (pr.state !== 'open') { errors.push({ message: 'Pull Request is not mergeable' }); return undefined; }
      const result = squashMerge(found.repo, pr);
      if ('error' in result) { errors.push({ message: result.error === 'conflict' ? 'Merge conflict' : result.error }); return undefined; }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullGql(found.repo, pr) };
    }
    if (name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findByGlobalId(String(input.subjectId ?? ''));
      if (!found || found.kind !== 'issue' || !found.repo || !found.issue) { errors.push({ message: 'Could not resolve to an Issue with the global id provided.' }); return undefined; }
      const comment = { id: nextGlobalId++, body: String(input.body ?? '') };
      found.issue.comments.push(comment);
      const node: GqlObj = { __typename: 'IssueComment', id: `C_${found.repo.seq}_${found.issue.number}_${found.issue.comments.length}`, body: comment.body };
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node, cursor: gqlCursor(found.issue.comments.length - 1) } };
    }
    errors.push({ message: `Cannot query field "${name}" on type "Mutation".` });
    return undefined;
  }
  if (type === 'Repository') {
    const repo = parent.__repo as Repo;
    if (name === 'issue') {
      const issue = findIssue(repo, Number(args.number));
      return issue ? issueGql(repo, issue) : null;
    }
    if (name === 'issues') {
      let list = [...repo.issues];
      const states = args.states as string[] | undefined;
      if (states && states.length > 0) list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const dir = String(orderBy.direction ?? 'DESC');
      list.sort((a, z) => (dir === 'DESC' ? z.seq - a.seq : a.seq - z.seq));
      const first = typeof args.first === 'number' ? args.first : list.length;
      const after = typeof args.after === 'string' ? gqlCursorIndex(args.after) : -1;
      const start = after + 1;
      const nodes = list.slice(start, start + first);
      const endIndex = start + nodes.length - 1;
      return {
        __typename: 'IssueConnection', totalCount: list.length,
        nodes: nodes.map((i) => issueGql(repo, i)),
        edges: nodes.map((i, idx) => ({ __typename: 'IssueEdge', node: issueGql(repo, i), cursor: gqlCursor(start + idx) })),
        pageInfo: {
          __typename: 'PageInfo', hasNextPage: endIndex < list.length - 1, hasPreviousPage: start > 0,
          startCursor: nodes.length > 0 ? gqlCursor(start) : null,
          endCursor: nodes.length > 0 ? gqlCursor(endIndex) : null,
        },
      };
    }
    if (name === 'pullRequests') {
      const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
      const list = repo.pulls.filter((p) => p.state === 'open').sort((a, z) => z.seq - a.seq).slice(0, first);
      return {
        __typename: 'PullRequestConnection', totalCount: repo.pulls.length,
        nodes: list.map((p) => pullGql(repo, p)),
        edges: list.map((p, idx) => ({ __typename: 'PullRequestEdge', node: pullGql(repo, p), cursor: gqlCursor(idx) })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    }
    if (name === 'pullRequest') {
      const pr = findPull(repo, Number(args.number));
      return pr ? pullGql(repo, pr) : null;
    }
    if (name in parent) return parent[name];
    errors.push({ message: `Cannot query field "${name}" on type "Repository".` });
    return undefined;
  }
  if (type === 'PullRequest') {
    const repo = parent.__repo as Repo;
    const pr = parent.__pull as PullRec;
    if (name === 'files') {
      const first = typeof args.first === 'number' ? args.first : 100;
      const headTip = resolveRef(repo, pr.head) ?? '';
      const baseTip = resolveRef(repo, pr.base) ?? '';
      const base = mergeBase(repo, headTip, baseTip);
      const diff = filesChanged(repo, base ?? baseTip, headTip).slice(0, first);
      return {
        __typename: 'PullRequestChangedFileConnection', totalCount: diff.length,
        nodes: diff.map((d) => ({ __typename: 'PullRequestChangedFile', path: d.path, additions: d.additions, deletions: d.deletions, changeType: d.status.toUpperCase() })),
        edges: diff.map((d, idx) => ({ __typename: 'PullRequestChangedFileEdge', node: { __typename: 'PullRequestChangedFile', path: d.path, additions: d.additions, deletions: d.deletions, changeType: d.status.toUpperCase() }, cursor: gqlCursor(idx) })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    }
    if (name === 'commits') {
      const headTip = resolveRef(repo, pr.head);
      const nodes: GqlObj[] = [];
      if (headTip) {
        const seen = new Set<string>();
        const stack = [headTip];
        while (stack.length > 0 && nodes.length < 100) {
          const oid = stack.pop() as string;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const obj = repo.objects.get(oid);
          if (!obj || obj.type !== 'commit') continue;
          nodes.push({ __typename: 'PullRequestCommit', commit: { __typename: 'Commit', oid } });
          stack.push(...parseCommit(obj.data).parents);
        }
      }
      return { __typename: 'PullRequestCommitConnection', nodes, pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    }
    if (name in parent) return parent[name];
    errors.push({ message: `Cannot query field "${name}" on type "PullRequest".` });
    return undefined;
  }
  if (type === 'Issue') {
    if (name in parent) return parent[name];
    errors.push({ message: `Cannot query field "${name}" on type "Issue".` });
    return undefined;
  }
  if (name in parent) return parent[name];
  errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
  return undefined;
}
async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') { errJson(res, 404, 'Not Found'); return; }
  if (!authed(req)) { errJson(res, 401, 'Requires authentication'); return; }
  let bodyBuf: Buffer;
  try { bodyBuf = await readBody(req); } catch { errJson(res, 400, 'Bad request'); return; }
  let body: unknown;
  try { body = parseJsonBody(bodyBuf); } catch { errJson(res, 400, 'Problems parsing JSON'); return; }
  const requests = Array.isArray(body) ? body : [body];
  const responses: unknown[] = [];
  for (const reqItem of requests) {
    const item = bodyObj(reqItem);
    const query = str(item.query);
    const variables = bodyObj(item.variables ?? {});
    const errors: { message: string }[] = [];
    let data: Record<string, unknown> | null = null;
    try {
      const ops = new GqlParser(query).parseDocument();
      const op = ops[0] as GqlOp;
      const root: GqlObj = { __typename: op.type === 'mutation' ? 'Mutation' : 'Query' };
      data = applySelection(root, op.selection, variables, errors);
    } catch (e) {
      errors.push({ message: e instanceof Error ? e.message : 'GraphQL parse error' });
      data = null;
    }
    const resp: Record<string, unknown> = { data };
    if (errors.length > 0) resp.errors = errors;
    responses.push(resp);
  }
  sendJson(res, 200, Array.isArray(body) ? responses : responses[0]);
}

// ---------------------------------------------------------------- MCP
const MCP_TOOLS: Record<string, unknown>[] = [
  { name: 'create_repo', description: 'Create a new repository owned by the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', description: 'Issue state: open, closed, or all' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
];
function mcpToolError(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}
function mcpToolOk(result: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}
function runMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = String(args.owner ?? '');
  const repoName = String(args.repo ?? '');
  if (name === 'create_repo') {
    const repoNm = String(args.name ?? '');
    if (!repoNm) return mcpToolError('Missing required argument: name');
    if (getRepo(VIEWER_LOGIN, repoNm)) return mcpToolError(`Repository ${repoNm} already exists`);
    const repo = createRepo(VIEWER_LOGIN, repoNm, args.private === true, String(args.description ?? ''));
    return mcpToolOk(repoJson(repo));
  }
  if (owner !== VIEWER_LOGIN) return mcpToolError(`Repository ${owner}/${repoName} not found`);
  const repo = getRepo(owner, repoName);
  if (name === 'get_repo') {
    if (!repo) return mcpToolError(`Repository ${owner}/${repoName} not found`);
    return mcpToolOk(repoJson(repo));
  }
  if (!repo) return mcpToolError(`Repository ${owner}/${repoName} not found`);
  if (name === 'create_issue') {
    const title = String(args.title ?? '');
    if (!title) return mcpToolError('Missing required argument: title');
    const issue = createIssueRec(repo, title, String(args.body ?? ''), []);
    return mcpToolOk(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const state = String(args.state ?? 'open');
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    return mcpToolOk(list.map((i) => issueJson(repo, i)));
  }
  if (name === 'create_pull_request') {
    const title = String(args.title ?? '');
    const head = String(args.head ?? '');
    const base = String(args.base ?? '');
    if (!title || !head || !base) return mcpToolError('Missing required argument: title, head, or base');
    if (!resolveRef(repo, head) || !resolveRef(repo, base)) return mcpToolError('head or base branch does not exist');
    const dup = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
    if (dup) return mcpToolError('A pull request already exists for this branch combination.');
    const pr = createPullRec(repo, title, String(args.body ?? ''), head, base);
    return mcpToolOk(pullJson(repo, pr));
  }
  if (name === 'merge_pull_request') {
    const num = Number(args.pull_number);
    if (!Number.isFinite(num)) return mcpToolError('Missing required argument: pull_number');
    const pr = findPull(repo, num);
    if (!pr) return mcpToolError(`Pull request #${num} not found`);
    if (pr.state !== 'open') return mcpToolError('Pull Request is not mergeable');
    const result = squashMerge(repo, pr);
    if ('error' in result) return mcpToolError(result.error === 'conflict' ? 'Merge conflict' : result.error);
    return mcpToolOk({ merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
  }
  return mcpToolError(`Unknown tool: ${name}`);
}
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    sendJson(res, 200, {});
    return;
  }
  if (method !== 'POST') { errJson(res, 405, 'Method Not Allowed'); return; }
  let bodyBuf: Buffer;
  try { bodyBuf = await readBody(req); } catch { errJson(res, 400, 'Bad request'); return; }
  let body: unknown;
  try { body = parseJsonBody(bodyBuf); } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const item = bodyObj(body);
  const id = 'id' in item ? item.id : null;
  if (!authed(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }
  const rpcMethod = str(item.method);
  if (rpcMethod === 'notifications/initialized' || rpcMethod.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': `req-${++requestCounter}` });
    res.end();
    return;
  }
  const params = bodyObj(item.params ?? {});
  if (rpcMethod === 'server/discover') {
    const serverInfo = { name: 'forge', version: '1.0.0' };
    sendJson(res, 200, {
      jsonrpc: '2.0', id,
      result: {
        supportedVersions: ['2026-07-28', '2025-06-18', '2025-03-26'],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      },
    });
    return;
  }
  if (rpcMethod === 'initialize') {
    const requested = str(params.protocolVersion);
    const supported = ['2026-07-28', '2025-06-18', '2025-03-26'];
    const version = supported.includes(requested) ? requested : '2026-07-28';
    const serverInfo = { name: 'forge', version: '1.0.0' };
    sendJson(res, 200, {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      },
    });
    return;
  }
  if (rpcMethod === 'tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
    return;
  }
  if (rpcMethod === 'tools/call') {
    const toolName = str(params.name);
    const toolArgs = bodyObj(params.arguments ?? {});
    const known = MCP_TOOLS.find((t) => t.name === toolName);
    if (!known) {
      sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${toolName}` } });
      return;
    }
    const schema = (known.inputSchema ?? {}) as Record<string, unknown>;
    const required = (schema.required ?? []) as string[];
    for (const reqField of required) {
      if (!(reqField in toolArgs) || toolArgs[reqField] === undefined || toolArgs[reqField] === null || toolArgs[reqField] === '') {
        sendJson(res, 200, { jsonrpc: '2.0', id, result: mcpToolError(`Missing required argument: ${reqField}`) });
        return;
      }
    }
    sendJson(res, 200, { jsonrpc: '2.0', id, result: runMcpTool(toolName, toolArgs) });
    return;
  }
  sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${rpcMethod}` } });
}

// ---------------------------------------------------------------- dispatcher
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        if (path === '/healthz' && (req.method ?? 'GET') === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/mcp') { await handleMcp(req, res); return; }
        if (path === '/api/graphql') { await handleGraphql(req, res); return; }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) { await handleRest(req, res, url); return; }
        if (/^\/[^/]+\/[^/]+\.git\//.test(path)) { await handleGit(req, res, url); return; }
        errJson(res, 404, 'Not Found');
      } catch (e) {
        if (!res.headersSent) {
          errJson(res, 500, e instanceof Error ? e.message : 'Internal Server Error');
        } else {
          try { res.end(); } catch { /* already closed */ }
        }
      }
    })();
  });
}
