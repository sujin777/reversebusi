// 에이전트 찾기와 스킬 설치. 하는 일은 폴더 복사 하나뿐이고, 에이전트의 설정 파일은 건드리지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SKILL_NAME = 'reversebusiness';
export const MARKER = '.rebiz.json';
export const PACKAGE = 'rebiz';

// 에이전트별로 "깔려 있는지 보는 곳"과 "스킬을 두는 곳".
// Codex, Cursor, Gemini CLI 는 공용 위치(~/.agents/skills)를 함께 읽으므로 한 벌만 둔다.
export function agentTable({ home = os.homedir(), env = process.env } = {}) {
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const shared = path.join(home, '.agents', 'skills');
  return [
    { key: 'claude', label: 'Claude Code', detect: [claudeHome], skills: path.join(claudeHome, 'skills') },
    { key: 'codex', label: 'Codex', detect: [codexHome], skills: shared },
    { key: 'cursor', label: 'Cursor', detect: [path.join(home, '.cursor')], skills: shared },
    { key: 'gemini', label: 'Gemini CLI', detect: [path.join(home, '.gemini', 'settings.json'), path.join(home, '.gemini', 'oauth_creds.json'), path.join(home, '.gemini', 'skills')], skills: shared },
    { key: 'antigravity', label: 'Antigravity', detect: [path.join(home, '.gemini', 'config'), path.join(home, '.gemini', 'antigravity'), path.join(home, '.antigravity')], skills: path.join(home, '.gemini', 'config', 'skills') },
    { key: 'agents', label: '공용 폴더', detect: [], skills: shared, explicitOnly: true },
  ];
}

const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

export function detectAgents(opts = {}) {
  return agentTable(opts).filter((a) => !a.explicitOnly && a.detect.some(exists));
}

// 같은 폴더로 가는 에이전트는 한 줄로 묶는다.
export function planTargets({ agents = [], dirs = [], project = false, cwd = process.cwd(), home, env } = {}) {
  const table = agentTable({ home, env });
  const picked = [];
  const unknown = [];
  for (const d of dirs) picked.push({ label: '직접 지정', skills: path.resolve(cwd, d) });
  if (project) picked.push({ label: '이 프로젝트', skills: path.join(cwd, '.claude', 'skills') });
  for (const k of agents) {
    const a = table.find((x) => x.key === k);
    if (!a) unknown.push(k); else picked.push({ label: a.label, skills: a.skills, key: a.key });
  }
  const explicit = picked.length > 0 || unknown.length > 0;
  if (!explicit) for (const a of detectAgents({ home, env })) picked.push({ label: a.label, skills: a.skills, key: a.key });
  const merged = [];
  for (const p of picked) {
    const hit = merged.find((m) => m.skills === p.skills);
    if (hit) { if (!hit.labels.includes(p.label)) hit.labels.push(p.label); if (p.key && !hit.keys.includes(p.key)) hit.keys.push(p.key); } else merged.push({ labels: [p.label], skills: p.skills, keys: p.key ? [p.key] : [] });
  }
  return { targets: merged.map((m) => ({ label: m.labels.join(', '), skills: m.skills, dest: path.join(m.skills, SKILL_NAME), keys: m.keys })), unknown, explicit, known: table.map((a) => a.key) };
}

// 표식은 이 도구가 쓴 보통 파일이어야 한다. 링크이거나 다른 도구의 것이면 내 폴더로 보지 않는다.
export function readMarker(dir) {
  try {
    const file = path.join(dir, MARKER);
    if (!fs.lstatSync(file).isFile()) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && j.package === PACKAGE ? j : null;
  } catch { return null; }
}
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
// 홈 폴더 아래에서 설치 위치까지 가는 길에 심볼릭 링크가 하나라도 있으면 건드리지 않는다.
export function linkOnPath(dest, home = os.homedir()) {
  let p = path.resolve(dest);
  const stop = path.resolve(home);
  const inside = p === stop || p.startsWith(stop + path.sep);
  for (let i = 0; i < 12; i += 1) {
    if (isLink(p)) return p;
    const up = path.dirname(p);
    if (up === p || p === stop || (!inside && i >= 1)) break;
    p = up;
  }
  return '';
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.DS_Store' || e.name === MARKER) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyDir(s, d);
    else if (e.isFile()) { fs.copyFileSync(s, d); n += 1; }
  }
  return n;
}

// 각 대상에 무엇을 할지 정한다: install(새로), update(내가 깐 것 갱신), skip(남의 폴더), replace(--force), blocked(심볼릭 링크)
export function planInstall(targets, { force = false, version = '', home } = {}) {
  return targets.map((tg) => {
    const link = linkOnPath(tg.dest, home);
    if (link) {
      let hint = '';
      try {
        const real = fs.realpathSync(path.dirname(tg.dest));
        if (real && real !== path.dirname(tg.dest)) hint = ` (실제 경로 설치: --dir "${real}")`;
      } catch { /* 해석할 수 없으면 기본 안내 */ }
      return { ...tg, action: 'blocked', why: `심볼릭 링크라서 건드리지 않아요${hint}` };
    }
    if (!exists(tg.dest)) return { ...tg, action: 'install' };
    const mine = readMarker(tg.dest);
    if (mine) return { ...tg, action: 'update', from: mine.version || '?', to: version };
    return force ? { ...tg, action: 'replace' } : { ...tg, action: 'skip', why: '같은 이름의 다른 폴더가 이미 있어요 (덮어쓰려면 --force)' };
  });
}

export function applyInstall(plan, { skillSrc, viewerSrc, version, pkgName, now = new Date() }) {
  const done = [];
  for (const p of plan) {
    if (p.action === 'skip' || p.action === 'blocked') { done.push({ ...p, files: 0 }); continue; }
    // 계획을 세운 뒤에 바뀌었을 수 있으니 손대기 직전에 한 번 더 본다.
    if (linkOnPath(p.dest) || (p.action === 'update' && !readMarker(p.dest))) { done.push({ ...p, action: 'blocked', files: 0 }); continue; }
    let backup = '';
    if (p.action === 'replace') {
      backup = `${p.dest}.backup-${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
      fs.renameSync(p.dest, backup);
    } else if (p.action === 'update') fs.rmSync(p.dest, { recursive: true, force: true });
    const files = copyDir(skillSrc, p.dest) + copyDir(viewerSrc, path.join(p.dest, 'viewer'));
    fs.writeFileSync(path.join(p.dest, MARKER), `${JSON.stringify({ package: pkgName, version, installedAt: now.toISOString() }, null, 2)}\n`);
    done.push({ ...p, files, backup });
  }
  return done;
}

// 지울 때는 표식 파일이 있는 폴더만 지운다.
export function planRemove({ agents = [], dirs = [], project = false, cwd, home, env } = {}) {
  const explicit = agents.length || dirs.length || project;
  const { targets } = explicit
    ? planTargets({ agents, dirs, project, cwd, home, env })
    : planTargets({ agents: agentTable({ home, env }).map((a) => a.key), cwd, home, env });
  return targets.filter((tg) => exists(tg.dest)).map((tg) => ({ ...tg, action: linkOnPath(tg.dest, home) ? 'keep' : readMarker(tg.dest) ? 'remove' : 'keep' }));
}
export function applyRemove(plan) {
  for (const p of plan) if (p.action === 'remove' && !linkOnPath(p.dest) && readMarker(p.dest)) fs.rmSync(p.dest, { recursive: true, force: true });
  return plan;
}

export function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.DS_Store') continue;
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name)); else if (e.isFile()) n += 1;
  }
  return n;
}
