// 0.5.0: 해부 다음에 하는 일. build(새 사이트의 출발점), apply(내 프로젝트와 견준 빈칸 목록), video(영상 뽑기), fill 과 에이전트에 맡기기.
// 진짜 에이전트(claude, codex), 진짜 REA, npm 은 시험에서 부르지 않는다. 에이전트 자리에는 대역(fixtures/fake-agent.cjs)을 쓴다.
// 임시 HOME, 임시 폴더, 임시 git 저장소, 내 컴퓨터의 시험용 사이트(127.0.0.1)만 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startSite, fakeClock } from './fixtures/server.mjs';
import { collect, buildDraftFromPages, writeOutputs } from '../skill/reversebusiness/tools/collect.mjs';
import { findBrowser, shouldBeHeadless } from '../skill/reversebusiness/tools/render.mjs';
import { pickLang } from '../lib/lang.mjs';
import { renderSite, planBlocks } from '../skill/reversebusiness/tools/make-site.mjs';
import { comparePlan, isLocalUrl, makePlan, PlanStop } from '../skill/reversebusiness/tools/apply-plan.mjs';
import { probeVideo } from '../skill/reversebusiness/tools/video.mjs';
import { targetNames, nameProblem } from '../skill/reversebusiness/tools/kinds.mjs';
import { agentArgs, forbiddenArg, runAgent, findAgentCli, fillPrompt, specPrompt, applyPrompt } from '../lib/delegate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'rebiz.mjs');
const EXAMPLE = path.join(ROOT, 'examples', 'aicitybuilders-vibecoding', 'report.json');
const MY_PROJECT = path.join(ROOT, 'test', 'fixtures', 'my-project');
const FAKE_AGENT = [process.execPath, path.join(ROOT, 'test', 'fixtures', 'fake-agent.cjs')];
const BROWSER = findBrowser();
const tmp = (p = 'rebiz-next-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const example = () => JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
// 대역이 받은 것을 적는 기록은 일하는 폴더 밖에 둔다.
const LOGS = tmp('rebiz-agentlog-');
test.after(() => fs.rmSync(LOGS, { recursive: true, force: true }));

function prepRunEnv(dir, agent, extra) {
  const log = path.join(LOGS, `${path.basename(dir)}.log`);
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, NO_COLOR: '1', TMPDIR: path.join(dir, 'tmp'), REBIZ_REA: 'none', REBIZ_NODE: 'v20.0.0', REBIZ_AGENT_CLI: 'none', GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...extra };
  delete env.REBIZ_AGENT_RUNNER; delete env.REBIZ_REA_INSTALLER; delete env.REBIZ_REA_RUNNER; delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
  if (agent) { env.REBIZ_AGENT_RUNNER = JSON.stringify(FAKE_AGENT); env.FAKE_AGENT_MODE = agent; env.FAKE_AGENT_LOG = log; }
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  return { env, log };
}
const readCalls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// rebiz 를 임시 HOME 에서 돌린다. 에이전트 CLI 는 없는 것으로 두고(진짜 claude, codex 를 부르지 않는다), agent 를 주면 대역을 쓴다.
function run(dir, args, { agent = '', env: extra = {}, cwd = dir } = {}) {
  const { env, log } = prepRunEnv(dir, agent, extra);
  const r = spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readCalls(log) };
}
async function runAsync(dir, args, { agent = '', env: extra = {}, cwd = dir } = {}) {
  const { env, log } = prepRunEnv(dir, agent, extra);
  const r = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, out }));
  });
  return { ...r, calls: readCalls(log) };
}
// 임시 폴더에 예시 리포트를 놓는다. edit 로 고쳐 쓴다.
function withReport(edit = (r) => r) {
  const dir = tmp();
  const r = example();
  edit(r);
  fs.writeFileSync(path.join(dir, 'report.json'), `${JSON.stringify(r, null, 2)}\n`);
  return dir;
}
const emptySpec = (r) => { r.sections.my_version = { working_name: '', same_problem: '', who: '', mvp: [], differences: [], not_taken: [] }; };
// 내 프로젝트(시험용으로 지어낸 가게)를 임시 git 저장소로 만든다.
function gitProject(dir, { init = true } = {}) {
  const proj = path.join(dir, 'proj');
  fs.cpSync(MY_PROJECT, proj, { recursive: true });
  const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const g = (...a) => spawnSync('git', ['-C', proj, '-c', 'user.name=tester', '-c', 'user.email=tester@example.invalid', ...a], { env, encoding: 'utf8' });
  if (init) { g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-q', '-m', 'first'); }
  return { proj, g };
}
const noForbidden = (args) => assert.ok(!args.some(forbiddenArg) && !args.some((a) => /dangerously|bypass|danger-full-access|skip-permissions/i.test(a)), `권한을 건너뛰는 옵션이 없어야 한다: ${args.join(' ')}`);
// 대상의 글과 이름: 예시 리포트의 대상에서 온 것으로 볼 만한 글자들
const TARGET_WORDS = [/aicitybuilders/i, /AI\s?CITY\s?BUILDERS/i, /바이브코딩/, /45,000/, /95,000/];

// ---------- build ----------
test('build: 6번 칸과 배운 구역 순서만으로 바로 열리는 새 사이트를 만들고, 대상의 글과 이름은 쓰지 않는다', () => {
  const dir = withReport();
  try {
    const before = read(dir, 'report.json');
    const r = run(dir, ['build', 'report.json', '--no-open']);
    assert.equal(r.status, 0, r.out);
    const html = read(dir, 'my-version', 'index.html');
    const css = read(dir, 'my-version', 'style.css');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'my-version')).sort(), ['index.html', 'style.css']);
    for (const re of TARGET_WORDS) { assert.doesNotMatch(html, re); assert.doesNotMatch(css, re); }
    assert.doesNotMatch(`${html}${css}`, /https?:\/\/|<script|<img|@import|url\(/i, '바깥 자원, 스크립트, 그림을 부르지 않는다');
    // 구역의 순서는 리포트의 뼈대 그대로 (가져오지 않기로 한 구역은 뺀다)
    const want = example().skeleton.blocks.filter((b) => b.taken !== false).map((b) => b.kind);
    const got = [...html.matchAll(/class="rb rb-([a-z]+)[ "]/g)].map((m) => m[1]);
    assert.deepEqual(got, want);
    assert.match(html, /한 접시 사진 교실/);
    assert.match(html, /여기에<\/span> /, '문구 자리는 무엇을 쓸지 안내로 채운다');
    assert.equal((html.match(/<h1/g) || []).length, 1);
    // 뼈대에 붙인 구역 이름(리포트 쓴 사람의 말)도 옮기지 않는다
    assert.doesNotMatch(html, /함께 주는 것, 큰 숫자 3개|일정과 단서 상자/);
    // 리포트에 적혀 있던 내 구역의 선택자는 그대로 쓸 수 있다
    assert.match(html, /class="rb rb-nav top"/);
    assert.match(html, /id="gift"/);
    assert.equal(read(dir, 'report.json'), before, '선택자가 이미 적힌 리포트는 바꾸지 않는다');
    assert.match(r.out, /겹침 검사\s+건너뜀: 리포트 옆에 source\.json 이 없습니다/);
    assert.match(r.out, /다음 {2}rebiz view report\.json --mine my-version/);
    assert.match(r.out, /또는 {2}rebiz video report\.json --mine my-version/);
    // 이미 파일이 있는 폴더는 건드리지 않는다
    fs.writeFileSync(path.join(dir, 'my-version', 'mine.txt'), '내가 고친 것');
    const again = run(dir, ['build', 'report.json']);
    assert.equal(again.status, 2, again.out);
    assert.match(again.out, /폴더에 이미 파일이 있습니다/);
    assert.equal(read(dir, 'my-version', 'index.html'), html);
    assert.equal(run(dir, ['build', 'report.json', '--force']).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('build: 6번 칸이 비어 있으면 만들지 않고 채우는 방법을 알려 준다', () => {
  const dir = withReport(emptySpec);
  try {
    const r = run(dir, ['build', 'report.json']);
    assert.equal(r.status, 2, r.out);
    assert.ok(!fs.existsSync(path.join(dir, 'my-version')));
    assert.match(r.out, /6번 칸\(내 버전 명세\)이 비어 있어서 아직 만들지 않았습니다/);
    assert.match(r.out, /rebiz build report\.json --agent claude/);
    assert.match(r.out, /"reversebusiness 로 report\.json 의 6번 칸\(내 버전 명세\)을 써 줘"/);
    assert.equal(r.calls.length, 0, '시키지 않으면 에이전트를 부르지 않는다');
    // 차별점이 3개가 아니면 고칠 곳을 알려 주고 만들지 않는다
    const bad = withReport((x) => { x.sections.my_version.differences.pop(); });
    const b = run(bad, ['build', 'report.json']);
    assert.equal(b.status, 1, b.out);
    assert.match(b.out, /차별점은 정확히 3개/);
    assert.ok(!fs.existsSync(path.join(bad, 'my-version')));
    fs.rmSync(bad, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('build --topic: 주제 자리에 그 말을 쓰고, 대상의 이름이나 클론이라는 말은 받지 않는다', () => {
  const dir = withReport();
  try {
    const r = run(dir, ['build', 'report.json', '--topic', '동네 목공 교실', '--out', 'site']);
    assert.equal(r.status, 0, r.out);
    const html = read(dir, 'site', 'index.html');
    assert.match(html, /<title>동네 목공 교실<\/title>/);
    assert.match(html, /<h1 class="rb-h1">동네 목공 교실<\/h1>/);
    for (const [topic, why] of [['aicitybuilders 같은 강의', /대상의 이름/], ['AI-City-Builders 따라 하기', /대상의 이름/], ['강의 판매 클론', /클론, 카피 같은 말/]]) {
      const bad = run(dir, ['build', 'report.json', '--topic', topic, '--out', 'bad']);
      assert.equal(bad.status, 1, bad.out);
      assert.match(bad.out, why);
      assert.ok(!fs.existsSync(path.join(dir, 'bad')), '쓰면 안 되는 말이 있으면 아무것도 만들지 않는다');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('build: 뼈대에 선택자가 없으면 리포트에 적어 주고, 뼈대가 없으면 기본 순서로 만든다', () => {
  const dir = withReport((r) => { for (const b of r.skeleton.blocks) delete b.mine; });
  try {
    const r = run(dir, ['build', 'report.json']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /뼈대 11곳에 내 구역의 선택자를 적었습니다/);
    const rep = JSON.parse(read(dir, 'report.json'));
    const html = read(dir, 'my-version', 'index.html');
    for (const b of rep.skeleton.blocks) {
      if (b.taken === false) { assert.equal(b.mine, undefined); continue; }
      assert.match(b.mine, /^#rb-\d+$/);
      assert.ok(html.includes(`id="${b.mine.slice(1)}"`));
    }
    const bare = example();
    delete bare.skeleton;
    const site = renderSite(bare);
    assert.equal(site.synthesized, true);
    assert.deepEqual(site.blocks.map((b) => b.kind), ['nav', 'headline', 'list', 'price', 'faq', 'cta', 'footer']);
    assert.match(site.html, /리포트에 뼈대가 없어 기본 순서로 만들었습니다/);
    // 리포트의 글은 글자로만 들어간다 (태그로 해석되지 않는다)
    const x = example();
    x.sections.my_version.working_name = '<script>alert(1)</script> 교실';
    assert.doesNotMatch(renderSite(x).html, /<script>alert/);
    assert.equal(planBlocks(x).blocks.length, 11);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('build: 리포트 옆에 source.json 이 있으면 스스로 겹침 검사를 돌리고, 겹치면 종료 코드로 알린다', async () => {
  const site = await startSite();
  const dir = tmp();
  try {
    const c = await collect(`${site.origin}/`, { ...(() => { const k = fakeClock(); return { sleep: k.sleep, now: k.now }; })(), render: 'off', rea: null, maxPages: 2 });
    const built = buildDraftFromPages(c, {});
    built.source.brand.names.push('달빛 도시락'); // 시험용 사이트는 127.0.0.1 이라 이름을 직접 더한다
    writeOutputs(dir, c, built);
    const file = path.join(dir, 'report.json');
    const set = (mv) => { const r = JSON.parse(read(file)); r.sections.my_version = mv; fs.writeFileSync(file, JSON.stringify(r, null, 2)); };
    const spec = {
      working_name: '골목 화분 구독 (가상의 예시)', same_problem: '한 장짜리 페이지에서 정기 구독을 판다.', who: '가상의 예시다. 집에서 화분을 키우는 사람.',
      mvp: ['무엇을 받는지 보여 주는 장면', '달마다 받는 것', '가격과 바꾸는 방법'],
      differences: [{ title: '대상', text: '화분을 키우는 사람이다.' }, { title: '형태', text: '정적인 한 장이다.' }, { title: '유통', text: '동네 배달만 한다.' }],
      not_taken: ['문구, 이름, 그림, 색'],
    };
    assert.equal(run(dir, ['build', 'report.json']).status, 2, '수집기 초안은 6번 칸이 비어 있다');
    set(spec);
    const ok = run(dir, ['build', 'report.json']);
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /겹침 검사\s+통과 \(원본 글 \d+줄과 견줌/);
    assert.doesNotMatch(read(dir, 'my-version', 'index.html'), /달빛|도시락|8,900/);
    // 명세에 원본의 문장을 옮겨 적으면 겹침으로 잡힌다
    set({ ...spec, mvp: ['지어낸 시험용 가게입니다. 매일 저녁 여섯 시에 문 앞에 둡니다.'] });
    const dup = run(dir, ['build', 'report.json', '--out', 'dup']);
    assert.equal(dup.status, 1, dup.out);
    assert.match(dup.out, /실패 {2}\[문장\]/);
    assert.match(dup.out, /겹침 검사\s+겹침 \d+건/);
    // 명세에 대상의 이름이 있으면 만들기 전에 멈춘다
    set({ ...spec, who: '달빛 도시락을 먹던 사람' });
    const named = run(dir, ['build', 'report.json', '--out', 'named']);
    assert.equal(named.status, 1, named.out);
    assert.match(named.out, /누구에게: 대상의 이름이 들어 있어요/);
    assert.ok(!fs.existsSync(path.join(dir, 'named')));
  } finally { await site.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('이름 검사: 띄어쓰기와 기호를 바꿔도 대상의 이름을 알아본다', () => {
  const names = targetNames(example(), { names: ['달빛 도시락'], domains: ['dalbit.example'] });
  assert.ok(names.includes('aicitybuilders'));
  assert.equal(nameProblem('Ai City-Builders 풍으로', names), '대상의 이름');
  assert.equal(nameProblem('달빛도시락처럼', names), '대상의 이름');
  assert.equal(nameProblem('○○ 클론 만들기', names), '클론, 카피 같은 말');
  assert.equal(nameProblem('동네 목공 교실', names), '');
  assert.deepEqual(targetNames({ meta: { target: { url: 'http://127.0.0.1:3000/' } } }), [], '내 컴퓨터 주소는 이름으로 보지 않는다');
});

// ---------- apply ----------
test('apply: 내 첫 화면을 배운 뼈대와 견주어 빈칸 목록을 표와 plan.md, plan.json 으로 남긴다 (git 이 없어도 된다)', () => {
  const dir = withReport();
  try {
    const { proj } = gitProject(dir, { init: false });
    const before = read(proj, 'index.html');
    const r = run(dir, ['apply', 'report.json', '--to', 'proj']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /빈칸\s+7곳 · 순서 다른 곳 0곳 · 있음 4곳|빈칸\s+8곳 · 순서 다른 곳 0곳 · 있음 3곳/);
    assert.match(r.out, /03 {2}제목과 가격 상자\s+가격 구역\s+없음\s+넣을 자리: 내 1번째 구역 다음/);
    assert.match(r.out, /08 {2}지금 확인할 수 있는 구성\s+글 구역\s+가져오지 않음/);
    assert.match(r.out, /계획\s+proj[\\/]rebiz-apply[\\/]plan\.md/);
    assert.match(r.out, /"proj[\\/]rebiz-apply[\\/]plan\.md 를 읽고 이 프로젝트의 첫 화면에 적용해 줘\. 새 브랜치에서 하고, 문구는 내 말로 새로 쓰고, 커밋과 배포는 하지 마"/);
    assert.match(r.out, /다음 {2}rebiz view report\.json/);
    assert.equal(read(proj, 'index.html'), before, '계획만 만들고 코드는 고치지 않는다');
    const md = read(proj, 'rebiz-apply', 'plan.md');
    const plan = JSON.parse(read(proj, 'rebiz-apply', 'plan.json'));
    assert.match(md, /## 빈칸: 배운 뼈대에는 있는데 내 첫 화면에는 없는 구역 \d곳/);
    assert.match(md, /\*\*제목과 가격 상자\*\* \(가격 구역, 돈 받는 층\)\n {3}- 넣을 자리: 내 1번째 구역\(이동 메뉴\) 다음\n {3}- 쓸 것: 지금 가격/);
    assert.match(md, /\| 6 \| 목차: 묶음과 강, 준비 상태 \| 목록 구역 \| 가치를 주는 층 \| 3번째 \(목록 구역\) \| 있음 \|/);
    assert.match(md, /## 지킬 것/);
    for (const text of [md, JSON.stringify(plan)]) {
      assert.ok(!text.includes(dir), '계획에 내 컴퓨터의 절대 경로를 적지 않는다');
      for (const re of TARGET_WORDS) assert.doesNotMatch(text, re);
      assert.doesNotMatch(text, /https?:\/\//);
    }
    assert.equal(plan.schema, 'rebiz/apply-plan@1');
    assert.equal(plan.page.ref, 'index.html');
    assert.equal(plan.counts.missing, plan.rows.filter((x) => x.state === 'missing').length);
    assert.ok(plan.rows.filter((x) => x.state === 'missing').every((x) => x.write));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('apply: 견주기는 순서를 지키며 짝을 짓고, 순서가 다른 구역과 없는 구역을 가른다', () => {
  const T = ['nav', 'headline', 'price', 'list', 'faq', 'cta', 'footer'].map((kind, i) => ({ n: i + 1, kind, role: 'other', name: kind, taken: true }));
  const cmp = comparePlan(T, ['nav', 'headline', 'faq', 'list', 'footer'].map((kind) => ({ kind })));
  const state = Object.fromEntries(cmp.rows.map((r) => [r.target.kind, r.state]));
  assert.equal(state.nav, 'same'); assert.equal(state.headline, 'same'); assert.equal(state.footer, 'same');
  assert.equal(state.price, 'missing'); assert.equal(state.cta, 'missing');
  assert.deepEqual([state.list, state.faq].sort(), ['moved', 'same'], '자리가 바뀐 둘 가운데 하나만 순서 다름으로 본다');
  assert.equal(cmp.rows.find((r) => r.target.kind === 'price').after.n, 2, '빈칸은 바로 앞에서 짝지어진 내 구역 다음에 넣는다');
  assert.deepEqual(cmp.counts, { target: 7, mine: 5, same: 4, moved: 1, missing: 2, notTaken: 0, extra: 0 });
  const same = comparePlan(T, T.map((b) => ({ kind: b.kind })));
  assert.equal(same.counts.missing + same.counts.moved, 0);
});

test('apply: 프레임워크 프로젝트나 껍데기 HTML 이면 그 사실을 말하고 --page, --url 을 안내한다. --url 은 내 컴퓨터 주소만', async () => {
  const dir = withReport();
  const site = await startSite();
  try {
    const next = path.join(dir, 'nextapp');
    fs.mkdirSync(path.join(next, 'app'), { recursive: true });
    fs.writeFileSync(path.join(next, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }));
    fs.writeFileSync(path.join(next, 'app', 'page.tsx'), 'export default function Page() { return (<main><header><nav><a href="#a">소개</a><a href="#b">수업</a><a href="#c">길</a></nav></header><section><h1>주말마다 의자 하나를 만듭니다</h1><p>나무를 처음 만지는 사람을 위한 동네 목공 교실입니다. 토요일 오전 세 시간, 네 번이면 됩니다.</p></section></main>); }\n');
    const a = run(dir, ['apply', 'report.json', '--to', 'nextapp']);
    assert.equal(a.status, 2, a.out);
    assert.match(a.out, /첫 화면의 정적 HTML 파일을 찾지 못했어요\. Next\.js 프로젝트로 보입니다/);
    assert.match(a.out, /--to nextapp --page app\/page\.tsx/);
    assert.match(a.out, /--to nextapp --url http:\/\/localhost:3000/);
    assert.ok(!fs.existsSync(path.join(next, 'rebiz-apply')));
    // --page 로 소스 파일을 주면 글자로만 읽고, 어림이라고 적는다
    const p = run(dir, ['apply', 'report.json', '--to', 'nextapp', '--page', 'app/page.tsx']);
    assert.equal(p.status, 0, p.out);
    assert.match(p.out, /소스 파일을 글자로만 읽음 \(어림입니다/);
    assert.equal(run(dir, ['apply', 'report.json', '--to', 'nextapp', '--page', '../report.json']).status, 2, '프로젝트 폴더 밖의 파일은 받지 않는다');
    // 스크립트가 그리는 껍데기
    const spa = path.join(dir, 'spa');
    fs.mkdirSync(spa);
    fs.writeFileSync(path.join(spa, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>');
    const s = run(dir, ['apply', 'report.json', '--to', 'spa']);
    assert.equal(s.status, 2, s.out);
    assert.match(s.out, /index\.html 은 스크립트가 화면을 그리는 껍데기라서/);
    // 바깥 주소는 받지 않는다
    for (const u of ['https://example.com/', 'http://192.168.0.10:3000/', 'http://localhost.example.com/', 'http://user:pw@localhost:3000/']) assert.equal(isLocalUrl(u), false, u);
    for (const u of ['http://localhost:3000/', 'http://127.0.0.1:5173/app', 'http://[::1]:8080/', 'http://app.localhost:3000/']) assert.equal(isLocalUrl(u), true, u);
    const out = run(dir, ['apply', 'report.json', '--to', 'nextapp', '--url', 'https://example.com/']);
    assert.equal(out.status, 2, out.out);
    assert.match(out.out, /--url 은 내 컴퓨터 주소만 받아요/);
    await assert.rejects(makePlan(path.join(dir, 'report.json'), next, { url: 'https://example.com/', render: 'off' }), PlanStop);
    // 내 컴퓨터의 주소는 읽는다 (시험용 사이트, 브라우저 없이)
    const plan = await makePlan(path.join(dir, 'report.json'), next, { url: `${site.origin}/`, render: 'off' });
    assert.equal(plan.page.how, 'url-html');
    assert.ok(plan.cmp.counts.mine >= 3);
    assert.ok(site.seen.every((q) => q.method === 'GET'));
    // 브라우저가 있으면 그려서 읽는다. 그때도 내 컴퓨터 밖으로는 요청을 보내지 않는다 (시험용 페이지는 바깥 스크립트를 부르려 한다).
    if (BROWSER) {
      const drawn = await makePlan(path.join(dir, 'report.json'), next, { url: `${site.origin}/` });
      assert.equal(drawn.page.how, 'url-rendered');
      assert.equal(drawn.page.measured, true);
      assert.ok(drawn.cmp.counts.mine >= 3);
    }
    // 뼈대가 없는 리포트로는 견줄 수 없다
    const bare = withReport((r) => { delete r.skeleton; });
    const b = run(bare, ['apply', 'report.json', '--to', dir]);
    assert.equal(b.status, 2, b.out);
    assert.match(b.out, /배운 뼈대\(skeleton\.blocks\)가 없어요/);
    fs.rmSync(bare, { recursive: true, force: true });
  } finally { await site.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('apply --agent: git 저장소가 아니거나 작업 트리가 지저분하면 멈추고, 에이전트를 부르지 않는다', () => {
  const dir = withReport();
  try {
    const { proj } = gitProject(dir, { init: false });
    const a = run(dir, ['apply', 'report.json', '--to', 'proj', '--agent', 'codex', '--yes'], { agent: 'apply' });
    assert.equal(a.status, 1, a.out);
    assert.match(a.out, /멈춤\s+git 저장소가 아닙니다/);
    assert.equal(a.calls.length, 0);
    assert.ok(fs.existsSync(path.join(proj, 'rebiz-apply', 'plan.md')), '계획은 남는다');
    fs.rmSync(proj, { recursive: true, force: true });
    const { g } = gitProject(dir);
    const page = path.join(dir, 'proj', 'index.html');
    const clean = read(page);
    fs.appendFileSync(page, '<!-- 고치던 중 -->\n');
    fs.writeFileSync(path.join(dir, 'proj', 'memo.txt'), '아직 커밋하지 않은 파일');
    const d = run(dir, ['apply', 'report.json', '--to', 'proj', '--agent', 'codex', '--yes'], { agent: 'apply' });
    assert.equal(d.status, 1, d.out);
    assert.match(d.out, /멈춤\s+작업 트리가 깨끗하지 않습니다/);
    assert.match(d.out, / M index\.html/);
    assert.match(d.out, /\?\? memo\.txt/);
    assert.equal(d.calls.length, 0);
    assert.equal(g('branch', '--list').stdout.trim(), '* main', '브랜치를 만들지 않는다');
    assert.equal(read(page), `${clean}<!-- 고치던 중 -->\n`, '내가 고치던 것을 건드리지 않는다');
    // --agent 값은 claude 또는 codex 하나만
    const bad = run(dir, ['apply', 'report.json', '--to', 'proj', '--agent', 'cursor']);
    assert.equal(bad.status, 2, bad.out);
    assert.match(bad.out, /--agent 는 여기서 claude 또는 codex 하나만 받습니다/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('apply --agent: 확인 뒤 새 브랜치 rebiz/apply-날짜 에서만 맡기고, 커밋하지 않고, diff 와 겹침 검사를 보여 준다', () => {
  const dir = withReport();
  try {
    const { proj, g } = gitProject(dir);
    // 겹침 검사가 돌도록 원본 글 묶음을 리포트 옆에 둔다 (지어낸 글)
    fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify({ texts: ['코드로 만드는 영상 수업을 지금 미리 신청하면 할인합니다'], brand: { names: ['시험용 원본 가게'], domains: [] }, assets: [] }));
    const head = g('rev-parse', 'HEAD').stdout.trim();
    // 확인(--yes)이 없으면 부르지 않고 브랜치도 만들지 않는다. 붙여 넣을 한 문장으로 대신한다.
    const ask = run(dir, ['apply', 'report.json', '--to', 'proj', '--agent', 'codex'], { agent: 'apply' });
    assert.equal(ask.status, 0, ask.out);
    assert.match(ask.out, /이 단계는 내 에이전트\(Codex\)를 한 번 실행하고, 그 에이전트의 사용량을 씁니다/);
    assert.match(ask.out, /확인이 필요합니다\. 맡기려면 --yes 를 붙여 다시 실행하세요/);
    assert.match(ask.out, /rebiz-apply[\\/]plan\.md 를 읽고 이 프로젝트의 첫 화면에 적용해 줘/);
    assert.equal(ask.calls.length, 0);
    assert.equal(g('branch', '--list').stdout.trim(), '* main');
    const r = run(dir, ['apply', 'report.json', '--to', 'proj', '--agent', 'codex', '--yes'], { agent: 'apply' });
    assert.equal(r.status, 0, r.out);
    const d = new Date();
    const branch = `rebiz/apply-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), branch);
    assert.match(r.out, new RegExp(`브랜치\\s+${branch} 를 만들었습니다\\s+\\(원래 브랜치: main\\)`));
    assert.equal(g('rev-parse', 'HEAD').stdout.trim(), head, '커밋하지 않는다');
    assert.equal(g('rev-parse', 'main').stdout.trim(), head);
    assert.equal(r.calls.length, 1);
    const call = r.calls[0];
    assert.deepEqual(call.args, ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--ephemeral', '-C', proj, '-']);
    noForbidden(call.args);
    assert.equal(call.cwd, proj, '작업 폴더는 내 프로젝트 폴더 하나');
    assert.match(call.prompt, /rebiz-apply\/plan\.md 를 읽는다/);
    assert.match(call.prompt, /git commit, push, 배포를 하지 않는다/);
    assert.match(call.prompt, /인터넷에 접속하지 않는다/);
    for (const re of TARGET_WORDS) assert.doesNotMatch(call.prompt, re, '맡기는 글에 대상의 주소와 이름을 넣지 않는다');
    assert.match(r.out, /git diff --stat\n\s+index\.html \| 5 \+\+\+\+\+/);
    assert.match(r.out, /다시 견줌\s+빈칸 (\d)곳에서 (\d)곳으로/);
    const m = /다시 견줌\s+빈칸 (\d)곳에서 (\d)곳으로/.exec(r.out);
    assert.equal(Number(m[2]), Number(m[1]) - 1, '대역이 물음 구역 하나를 넣었다');
    assert.match(r.out, /겹침 검사\s+통과 \(바뀐 파일 3개를 원본 글 1줄과 견줌\)/);
    assert.match(r.out, /커밋하지 않았습니다/);
    assert.match(read(proj, 'index.html'), /<section class="ask" id="ask">/);
    // 고친 것이 커밋되지 않은 채로 다시 맡기면 멈춘다
    const again = run(dir, ['apply', 'report.json', '--to', 'proj', '--agent', 'codex', '--yes'], { agent: 'apply' });
    assert.equal(again.status, 1, again.out);
    assert.match(again.out, /작업 트리가 깨끗하지 않습니다/);
    assert.equal(again.calls.length, 1, '두 번째에는 부르지 않았다');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('apply --agent: 에이전트 CLI 가 없으면 붙여 넣을 한 문장으로 끝내고, 에이전트가 원본의 글을 옮기면 겹침으로 알린다', () => {
  const dir = withReport();
  try {
    const { proj, g } = gitProject(dir);
    const none = run(dir, ['apply', 'report.json', '--to', 'proj', '--agent', 'claude', '--yes']);
    assert.equal(none.status, 0, none.out);
    assert.match(none.out, /맡기지 않음\s+Claude Code 의 실행 파일\(claude\)을 이 컴퓨터에서 찾지 못했습니다/);
    assert.match(none.out, /rebiz-apply[\\/]plan\.md 를 읽고 이 프로젝트의 첫 화면에 적용해 줘/);
    assert.equal(g('branch', '--list').stdout.trim(), '* main');
    // 대역이 넣는 글과 같은 문장을 원본 글로 두면, 바뀐 파일에서 겹침이 잡히고 종료 코드로 알린다
    fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify({ texts: ['공구를 따로 사서 가져와야 하나요'], brand: { names: [], domains: [] }, assets: [] }));
    const r = run(dir, ['apply', 'report.json', '--to', 'proj', '--agent', 'claude', '--yes'], { agent: 'apply' });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /겹침 검사\s+바뀐 파일에서 겹침 \d+건/);
    const args = r.calls[0].args;
    noForbidden(args);
    assert.equal(args[0], '-p');
    const slash = (p) => path.resolve(p).split(path.sep).join('/').replace(/^\/+/, '');
    assert.ok(args.includes(`Edit(//${slash(proj)}/**)`), args.join(' '));
    assert.ok(!args.some((a) => /^Bash/.test(a)), '코드를 고칠 때는 명령 실행을 허용하지 않는다');
    assert.ok(args.indexOf('WebFetch') > args.indexOf('--disallowedTools'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- fill 과 맡기기 ----------
test('fill: 기본은 맡기지 않고 붙여 넣을 한 문장과 다음 명령을 보여 준다', () => {
  const dir = withReport();
  try {
    const before = read(dir, 'report.json');
    const r = run(dir, ['fill', 'report.json']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /문장\s+관찰 20 · 추정 6 · 모름 7/);
    assert.match(r.out, /"reversebusiness 로 report\.json 의 모름 칸을 이어서 채워 줘\. 이미 읽어 둔 자료만 쓰고, 끝나면 rebiz check 로 검사해 줘"/);
    assert.match(r.out, /rebiz fill report\.json --agent claude/);
    assert.match(r.out, /다음 {2}rebiz build report\.json\n또는 {2}rebiz apply report\.json --to <내 프로젝트 폴더>/);
    assert.equal(read(dir, 'report.json'), before);
    assert.equal(r.calls.length, 0);
    // 리포트를 주지 않아도 지금 폴더의 report.json 을 쓴다. 없으면 쓰는 법을 알려 준다.
    assert.equal(run(dir, ['fill']).status, 0);
    const empty = tmp();
    const e = run(empty, ['fill']);
    assert.equal(e.status, 2, e.out);
    assert.match(e.out, /사용: rebiz fill <report\.json>/);
    fs.rmSync(empty, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fill --agent: 확인 뒤 리포트의 폴더에서 한 번 실행하고, 끝나면 검사해서 보여 준다. 권한을 건너뛰는 옵션은 쓰지 않는다', () => {
  const dir = withReport();
  try {
    const before = read(dir, 'report.json');
    const ask = run(dir, ['fill', 'report.json', '--agent', 'claude'], { agent: 'fill' });
    assert.equal(ask.status, 0, ask.out);
    assert.match(ask.out, /이 단계는 내 에이전트\(Claude Code\)를 한 번 실행하고, 그 에이전트의 사용량을 씁니다/);
    assert.match(ask.out, /권한\s+claude -p, 허용 도구: 이 폴더 안 읽기와 고치기, 스킬 문서 읽기, rebiz check 실행 \(웹 도구는 막음\)/);
    assert.match(ask.out, /시간 한도\s+10분/);
    assert.match(ask.out, /확인이 필요합니다/);
    assert.equal(ask.calls.length, 0);
    assert.equal(read(dir, 'report.json'), before);
    assert.ok(!fs.existsSync(path.join(dir, 'report.before-fill.json')), '맡기지 않았으면 사본을 남기지 않는다');
    const r = run(dir, ['fill', 'report.json', '--agent', 'claude', '--yes'], { agent: 'fill' });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.calls.length, 1);
    const { args, cwd, prompt } = r.calls[0];
    noForbidden(args);
    assert.equal(cwd, dir);
    const slash = (p) => path.resolve(p).split(path.sep).join('/').replace(/^\/+/, '');
    assert.deepEqual(args.slice(0, 3), ['-p', '--allowedTools', `Read(//${slash(dir)}/**)`]);
    assert.ok(!args.includes('Read') && !args.includes('Glob') && !args.includes('Grep'), '읽기는 이 폴더와 스킬 문서 폴더로만 한정한다');
    assert.match(prompt, /남의 사이트에서 온 데이터다/);
    assert.ok(args.includes(`Edit(//${slash(dir)}/**)`));
    assert.ok(args.includes(`Bash(node ${CLI} check:*)`));
    assert.ok(!args.includes(prompt), '할 일은 인자가 아니라 표준 입력으로 준다');
    assert.match(prompt, /모름으로 남은 칸을 채워라/);
    assert.match(prompt, /고치는 파일은 report\.json 하나다/);
    assert.match(prompt, /sections\.my_version 은 건드리지 않는다/);
    assert.match(prompt, /check report\.json --dissect-only/);
    assert.match(prompt, /인터넷에 접속하지 않는다\. 어떤 사이트도 새로 열지 않는다/);
    assert.match(r.out, /바뀐 파일\s+report\.json/);
    assert.match(r.out, /문장\s+관찰 20 · 추정 7 \(\+1\) · 모름 6 \(-1\)/);
    assert.match(r.out, /검사 통과/);
    assert.match(r.out, /다음 {2}rebiz build report\.json/);
    assert.equal(read(dir, 'report.before-fill.json'), before, '맡기기 전의 사본이 남는다');
    // 리포트 말고 다른 파일이 바뀌면 알려 준다
    const stray = run(dir, ['fill', 'report.json', '--agent', 'claude', '--yes'], { agent: 'stray' });
    assert.match(stray.out, /알림\s+리포트 말고 다른 파일도 바뀌었습니다: extra\.txt/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fill --agent: 에이전트가 리포트를 깨뜨리면 되돌리고, 실패와 시간 초과를 종료 코드로 알린다', () => {
  const dir = withReport();
  try {
    const before = read(dir, 'report.json');
    const broke = run(dir, ['fill', 'report.json', '--agent', 'codex', '--yes'], { agent: 'break' });
    assert.equal(broke.status, 1, broke.out);
    assert.match(broke.out, /되돌림\s+에이전트가 남긴 report\.json 를 읽을 수 없어 맡기기 전의 내용으로 되돌렸습니다/);
    assert.equal(read(dir, 'report.json'), before);
    const fail = run(dir, ['fill', 'report.json', '--agent', 'codex', '--yes'], { agent: 'fail' });
    assert.equal(fail.status, 1, fail.out);
    assert.match(fail.out, /에이전트 실패\s+종료 코드 1/);
    assert.equal(read(dir, 'report.json'), before);
    const slow = run(dir, ['fill', 'report.json', '--agent', 'codex', '--yes', '--timeout', '0.02'], { agent: 'sleep' });
    assert.equal(slow.status, 1, slow.out);
    assert.match(slow.out, /시간 초과\s+0\.02분을 넘어 에이전트를 껐습니다/);
    const pid = slow.calls[slow.calls.length - 1].pid;
    assert.throws(() => process.kill(pid, 0), '시간 한도를 넘긴 에이전트는 꺼져 있다');
    // 에이전트 CLI 가 없으면 붙여 넣을 한 문장으로 대신한다 (정상 종료)
    const none = run(dir, ['fill', 'report.json', '--agent', 'codex', '--yes']);
    assert.equal(none.status, 0, none.out);
    assert.match(none.out, /맡기지 않음\s+Codex 의 실행 파일\(codex\)을 이 컴퓨터에서 찾지 못했습니다/);
    assert.match(none.out, /에이전트를 열고 이 한 문장을 붙여 넣으세요/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('build --agent: 6번 칸이 비어 있으면 확인 뒤 에이전트에게 명세를 쓰게 하고 이어서 만든다', () => {
  const dir = withReport(emptySpec);
  try {
    const r = run(dir, ['build', 'report.json', '--agent', 'codex', '--yes', '--topic', '골목 화분 구독'], { agent: 'spec' });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.calls.length, 1);
    noForbidden(r.calls[0].args);
    assert.deepEqual(r.calls[0].args.slice(0, 3), ['exec', '--sandbox', 'workspace-write']);
    assert.match(r.calls[0].prompt, /6번 칸 sections\.my_version \(내 버전 명세\)을 써라/);
    assert.match(r.calls[0].prompt, /내 사업의 주제는 이것이다: 골목 화분 구독/);
    assert.match(r.calls[0].prompt, /source\.json, evidence 폴더, 받아 둔 원본 글은 열지 않는다/);
    assert.match(r.out, /만든 곳\s+my-version/);
    assert.match(read(dir, 'my-version', 'index.html'), /<h1 class="rb-h1">골목 화분 구독<\/h1>/);
    assert.ok(fs.existsSync(path.join(dir, 'report.before-spec.json')));
    // 에이전트가 아무것도 쓰지 않으면 만들지 않는다
    const dir2 = withReport(emptySpec);
    const n = run(dir2, ['build', 'report.json', '--agent', 'codex', '--yes'], { agent: 'noop' });
    assert.equal(n.status, 1, n.out);
    assert.ok(!fs.existsSync(path.join(dir2, 'my-version')));
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('맡기기: 어떤 경우에도 권한 확인을 건너뛰거나 샌드박스를 끄는 옵션을 붙이지 않는다', async () => {
  const dir = tmp();
  try {
    for (const name of ['claude', 'codex']) for (const checkCli of ['', CLI]) noForbidden(agentArgs(name, { dir, checkCli }));
    assert.deepEqual(agentArgs('codex', { dir }), ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--ephemeral', '-C', dir, '-']);
    for (const a of ['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', 'danger-full-access', 'bypassPermissions', '--yolo', '--full-auto', '--add-dir', '--trust', '--permission-mode']) assert.equal(forbiddenArg(a), true, a);
    for (const a of ['exec', '--sandbox', 'workspace-write', '-p', '--allowedTools', 'Read', '-C', '/tmp/bypass-app', '-']) assert.equal(forbiddenArg(a), false, a);
    assert.throws(() => agentArgs('gemini', { dir }));
    // 그런 옵션이 섞여 들어오면 실행을 거부한다
    const log = path.join(dir, 'log');
    const r = await runAgent('codex', { cmd: FAKE_AGENT[0], pre: [FAKE_AGENT[1], '--dangerously-bypass-approvals-and-sandbox'] }, { dir, prompt: 'x', env: { ...process.env, FAKE_AGENT_LOG: log } });
    assert.equal(r.refused, true);
    assert.ok(!fs.existsSync(log), '대역이 실행되지 않았다');
    // 찾기: 대역, 없음으로 두기, 모르는 이름
    assert.equal(findAgentCli('codex', { env: { REBIZ_AGENT_RUNNER: JSON.stringify(FAKE_AGENT), PATH: '' } }).how, 'test');
    assert.equal(findAgentCli('codex', { env: { REBIZ_AGENT_CLI: 'none', PATH: process.env.PATH } }), null);
    assert.equal(findAgentCli('codex', { env: { PATH: dir } }), null);
    assert.equal(findAgentCli('cursor', { env: process.env }), null);
    // Windows: .cmd 실행 파일은 cmd.exe /d /c 로 감싸고 %APPDATA%\npm 도 찾는다
    const winApp = path.join(dir, 'appdata');
    const winCmd = path.join(winApp, 'npm', 'codex.cmd');
    fs.mkdirSync(path.dirname(winCmd), { recursive: true });
    fs.writeFileSync(winCmd, '@echo off\r\n');
    const winCodex = findAgentCli('codex', { env: { PATH: '', APPDATA: winApp }, platform: 'win32' });
    assert.equal(winCodex.cmd, 'cmd.exe');
    assert.deepEqual(winCodex.pre, ['/d', '/c', winCmd]);
    // 맡기는 글에는 지킬 선이 들어 있다
    for (const p of [fillPrompt({ report: 'report.json', checkCmd: 'c' }), specPrompt({ report: 'report.json', checkCmd: 'c' }), applyPrompt({ plan: 'rebiz-apply/plan.md', page: 'index.html' })]) {
      assert.match(p, /인터넷에 접속하지 않는다/);
      assert.match(p, /git commit, push, 배포를 하지 않는다/);
      assert.match(p, /지어내지 않는다/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- video ----------
test('video: 브라우저가 없으면 까닭과 대신 할 일을 알려 준다', () => {
  const dir = withReport();
  try {
    const r = run(dir, ['video', 'report.json'], { env: { REBIZ_BROWSER: 'none' } });
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /멈춤\s+Chrome 계열 브라우저\(Chrome, Chromium, Edge, Brave\)를 찾지 못했어요/);
    assert.match(r.out, /대신\s+rebiz view report\.json 로 해부 화면을 열고 "영상으로 저장 \(9:16\)" 단추를 누르세요/);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => /\.(mp4|webm)$/.test(f)), []);
    assert.equal(probeVideo(path.join(dir, 'report.json')).format, '', '영상이 아닌 파일은 형식을 말하지 않는다');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('video: 브라우저를 열지 않아도 9:16 영상을 파일로 뽑고, 끝나면 브라우저와 임시 프로필을 남기지 않는다', { skip: BROWSER ? false : '이 컴퓨터에 Chrome 계열 브라우저가 없어 건너뜀' }, () => {
  const dir = withReport();
  try {
    const r = run(dir, ['video', 'report.json', '--out', 'out/clip.mp4']);
    assert.equal(r.status, 0, r.out);
    const file = fs.readdirSync(path.join(dir, 'out')).find((f) => /^clip\.(mp4|webm)$/.test(f));
    assert.ok(file, r.out);
    const v = probeVideo(path.join(dir, 'out', file));
    assert.ok(['mp4', 'webm'].includes(v.format));
    assert.equal(v.width, 1080);
    assert.equal(v.height, 1920);
    assert.ok(v.bytes > 500_000, `파일이 너무 작다: ${v.bytes}`);
    if (v.format === 'mp4') assert.ok(v.seconds > 25 && v.seconds < 35, `길이 ${v.seconds}`);
    assert.match(r.out, /형식\s+(mp4|webm) · 1080x1920 · /);
    assert.match(r.out, /브라우저를 끄고 프로필을 지웠습니다\. 바깥으로 나간 요청 0\./);
    assert.match(r.out, /다음 {2}rebiz build report\.json/);
    // 임시 프로필과 임시 작업 폴더가 남아 있지 않다
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')).filter((f) => /^rebiz-(render|video)-/.test(f)), []);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => /\.(mp4|webm|html)$/.test(f)), [], '리포트 옆에 다른 파일을 남기지 않는다');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 명령 표와 안내 ----------
test('도움말: build, apply, video, fill 이 실제 명령으로 나오고, 해부 화면을 연 뒤에는 다음 명령을 알려 준다', () => {
  const dir = withReport();
  try {
    const h = run(dir, ['--help']);
    assert.equal(h.status, 0);
    for (const u of ['rebiz fill <report.json>', 'rebiz build <report.json>', 'rebiz apply <report.json> --to <내 프로젝트 폴더>', 'rebiz video <report.json>']) assert.ok(h.out.includes(u), u);
    assert.doesNotMatch(h.out, /예정|다음 판/);
    assert.match(h.out, /rebiz <주소> {2}-> {2}rebiz fill {2}-> {2}rebiz build 또는 rebiz apply {2}-> {2}rebiz view, rebiz video/);
    const v = run(dir, ['view', 'report.json', '--no-open']);
    assert.equal(v.status, 0, v.out);
    assert.match(v.out, /다음 {2}rebiz video report\.json/);
    assert.equal(JSON.parse(read(ROOT, 'package.json')).version, '0.2.0');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fillPrompt 는 includeSpec 일 때 6번 칸 명세 지시와 주제를 함께 넣는다', () => {
  const prompt = fillPrompt({
    report: 'report.json',
    skill: '',
    checkCmd: 'rebiz check report.json',
    materials: ['source.json'],
    includeSpec: true,
    topic: '작은 화분 구독',
  });
  assert.match(prompt, /작은 화분 구독/);
  assert.match(prompt, /sections\.my_version/);
  assert.doesNotMatch(prompt, /sections\.my_version 은 건드리지 않는다/);
});

test('dissect <주소> 는 --agent 로 한 번에 해부, 명세, 내 버전 출발점, 완성된 report.html 까지 만든다', async () => {
  const site = await startSite({
    routes: {
      '/': (_req, _res, html) => html('<!doctype html><html><head><title>작은 그릇 가게</title></head><body><h1>매달 하나씩 보내는 그릇</h1><p>월 29,000원 정기 구독으로 매달 받아 보세요.</p><button>시작하기</button></body></html>'),
    },
  });
  const dir = tmp('rebiz-dissect-e2e-');
  const outDir = path.join(dir, 'site-out');
  const draftDir = path.join(dir, 'draft-out');
  try {
    // 1) --agent 없이 비대화형(테스트) 실행 시 외부 에이전트를 몰래 부르지 않고 초안만 만든다.
    const raw = await runAsync(dir, [site.origin, '--no-open', '--no-render', '--out', draftDir]);
    assert.equal(raw.status, 0, raw.out);
    assert.equal(raw.calls.length, 0);
    const rawReport = JSON.parse(read(draftDir, 'report.json'));
    assert.equal(rawReport.sections.money.customer[0].status, 'unknown');

    // 2) --agent claude --yes 를 주면 수집 뒤 채우기 + 6번 칸 + my-version + 완성된 report.html 까지 한 번에 끝낸다.
    const full = await runAsync(dir, [site.origin, '--agent', 'claude', '--yes', '--no-open', '--no-render', '--topic', '작은 화분 구독', '--out', outDir], { agent: 'dissect' });
    assert.equal(full.status, 0, full.out);
    assert.equal(full.calls.length, 1);
    assert.match(full.calls[0].prompt, /작은 화분 구독/);
    const fullReport = JSON.parse(read(outDir, 'report.json'));
    assert.equal(fullReport.meta.draft, false);
    assert.equal(fullReport.sections.money.customer[0].status, 'inferred');
    assert.equal(fullReport.sections.my_version.working_name, '골목 화분 구독 (가상의 예시)');
    assert.ok(fs.existsSync(path.join(outDir, 'my-version', 'index.html')));
    const viewHtml = read(outDir, 'report.html');
    assert.match(viewHtml, /골목 화분 구독 \(가상의 예시\)/);
  } finally {
    await site.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pickLang 과 shouldBeHeadless: 언어 자동 감지 및 데스크톱 라이브 창 기본값', () => {
  assert.equal(pickLang('en', { LANG: 'ko_KR.UTF-8' }), 'en');
  assert.equal(pickLang('ko', { LANG: 'en_US.UTF-8' }), 'ko');
  assert.equal(pickLang('', { REBIZ_LANG: 'en', LANG: 'ko_KR.UTF-8' }), 'en');
  assert.equal(pickLang('', { LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(pickLang('', { LANG: 'ko_KR.UTF-8' }), 'ko');

  assert.equal(shouldBeHeadless({ headless: false, env: { CI: 'true', REBIZ_HEADLESS: '1' }, platform: 'linux' }), false);
  assert.equal(shouldBeHeadless({ headless: true, env: {}, platform: 'darwin' }), true);
  assert.equal(shouldBeHeadless({ env: { REBIZ_HEADLESS: '1' }, platform: 'darwin' }), true);
  assert.equal(shouldBeHeadless({ env: { CI: 'true' }, platform: 'darwin' }), true);
  assert.equal(shouldBeHeadless({ env: {}, platform: 'darwin' }), false);
  assert.equal(shouldBeHeadless({ env: {}, platform: 'win32' }), false);
  assert.equal(shouldBeHeadless({ env: {}, platform: 'linux' }), true);
  assert.equal(shouldBeHeadless({ env: { DISPLAY: ':0' }, platform: 'linux' }), false);
});

test('--lang en: 영문 도움말과 영문 해부 화면을 만든다', () => {
  const dir = withReport();
  try {
    const h = run(dir, ['--help', '--lang', 'en'], { env: { REBIZ_LANG: '' } });
    assert.equal(h.status, 0, h.out);
    assert.match(h.out, /Dissect any business from one URL/);
    assert.match(h.out, /--headless/);

    const outHtml = path.join(dir, 'view-en.html');
    const v = run(dir, ['view', 'report.json', '--out', outHtml, '--lang', 'en', '--no-open'], { env: { REBIZ_LANG: '' } });
    assert.equal(v.status, 0, v.out);
    assert.match(v.out, /Report view/);
    assert.match(v.out, /Next {2}rebiz video report\.json/);
    assert.match(read(dir, 'view-en.html'), /"lang":"en"/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dissect <주소>: 에이전트가 리포트를 고치지 못하고 실패해도 검증 오류를 도배하지 않고 초안을 연다', async () => {
  const site = await startSite({
    routes: {
      '/': (_req, _res, html) => html('<!doctype html><html><head><title>작은 도구</title></head><body><h1>빠른 작업</h1><p>월 19,000원</p></body></html>'),
    },
  });
  const dir = tmp('rebiz-dissect-fail-');
  const outDir = path.join(dir, 'out');
  try {
    const res = await runAsync(dir, [site.origin, '--agent', 'claude', '--yes', '--no-open', '--no-render', '--out', outDir], { agent: 'fail' });
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /초안 열기/);
    assert.doesNotMatch(res.out, /오류\s+meta\.one_line/);
    assert.doesNotMatch(res.out, /오류\s+my_version\.working_name/);
    assert.ok(fs.existsSync(path.join(outDir, 'report.html')));
    assert.match(res.out, /다음 {2}rebiz fill /);
  } finally {
    await site.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
