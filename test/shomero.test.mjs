import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chooseScope, detectAgents, loadCatalog, planDirs, selectSkills } from '../bin/shomero.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, 'bin', 'shomero.mjs');

function tmp(name) { return mkdtempSync(join(tmpdir(), `shomero-${name}-`)); }

function writeSkill(repo, path, name, body = 'Body.') {
  mkdirSync(join(repo, path), { recursive: true });
  writeFileSync(join(repo, path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} does things — details\n---\n\n${body}\n`);
}

function fixtureRepo() {
  const repo = tmp('skills');
  writeSkill(repo, 'skills/usecase', 'usecase');
  writeSkill(repo, 'skills/open-pr', 'open-pr');
  writeSkill(repo, 'skills/third-parties/mixpanel', 'mixpanel');
  writeFileSync(join(repo, 'catalog.json'), JSON.stringify({
    version: 1,
    categories: { architecture: 'Layers', workflow: 'Flow', 'third-party': 'Vendors' },
    examples: { analytics: 'AnalyticsReporter' },
    skills: [
      { name: 'usecase', path: 'skills/usecase', category: 'architecture', requires: [] },
      { name: 'open-pr', path: 'skills/open-pr', category: 'workflow', requires: [] },
      { name: 'mixpanel', path: 'skills/third-parties/mixpanel', category: 'third-party', requires: ['analytics'] },
    ],
  }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'init', '--allow-empty'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'skills'], { cwd: repo });
  return repo;
}

function run(args, { home, cwd }) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, PATH: '/usr/bin:/bin', SHOMERO_HOME_DIR: home, SHOMERO_STATE_DIR: join(home, '.shomero') },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('planDirs installs once per folder the chosen tools read', () => {
  assert.deepEqual(planDirs(['claude']), ['.claude/skills']);
  assert.deepEqual(planDirs(['codex', 'gemini', 'cursor']), ['.agents/skills']);
  assert.deepEqual(planDirs(['claude', 'cursor', 'copilot']), ['.claude/skills']);
  assert.deepEqual(planDirs(['claude', 'codex']), ['.claude/skills', '.agents/skills']);
  assert.deepEqual(planDirs([]), ['.agents/skills']);
});

test('detectAgents finds tools by home folder or binary on PATH', () => {
  const home = tmp('home');
  const bin = tmp('bin');
  mkdirSync(join(home, '.gemini'));
  writeFileSync(join(bin, 'codex'), '');
  assert.deepEqual(detectAgents({ home, path: bin }), ['codex', 'gemini']);
});

test('selectSkills resolves names, categories and all, and suggests on typos', () => {
  const catalog = loadCatalog(fixtureRepo());
  assert.deepEqual(selectSkills(catalog, ['workflow']).map((s) => s.name), ['open-pr']);
  assert.equal(selectSkills(catalog, ['all']).length, 3);
  assert.throws(() => selectSkills(catalog, ['usecases']), /Did you mean: usecase/);
});

test('add, update and remove a project install from a git source', () => {
  const repo = fixtureRepo();
  const home = tmp('home');
  const project = tmp('project');
  const source = `file://${repo}`;

  const add = run(['add', 'all', '--project', '--agent', 'claude,codex', '--source', source], { home, cwd: project });
  assert.equal(add.code, 0, add.err);
  assert.match(add.out, /3 skills installed for this project only .* in \.claude\/skills and \.agents\/skills/);
  assert.match(add.out, /analytics\s+AnalyticsReporter/);
  for (const d of ['.claude/skills', '.agents/skills']) assert.ok(existsSync(join(project, d, 'mixpanel', 'SKILL.md')));
  const manifest = JSON.parse(readFileSync(join(project, '.shomero', 'skills.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.skills).sort(), ['mixpanel', 'open-pr', 'usecase']);
  assert.deepEqual(manifest.agents, ['claude', 'codex']);

  writeSkill(repo, 'skills/usecase', 'usecase', 'New body.');
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'change'], { cwd: repo });
  const update = run(['update'], { home, cwd: project });
  assert.equal(update.code, 0, update.err);
  assert.match(update.out, /3 skills updated for this project only .*\(\w+ → \w+\)/);
  assert.match(readFileSync(join(project, '.agents/skills/usecase/SKILL.md'), 'utf8'), /New body/);

  const rm = run(['remove', 'open-pr'], { home, cwd: project });
  assert.equal(rm.code, 0, rm.err);
  assert.ok(!existsSync(join(project, '.claude/skills/open-pr')));
  assert.ok(!existsSync(join(project, '.agents/skills/open-pr')));

  const all = run(['remove', 'all'], { home, cwd: project });
  assert.equal(all.code, 0, all.err);
  for (const d of ['.agents', '.claude', '.shomero']) assert.ok(!existsSync(join(project, d)), `${d} left behind`);
});

test('a same-named skill the user wrote is kept unless --force', () => {
  const repo = fixtureRepo();
  const home = tmp('home');
  const project = tmp('project');
  mkdirSync(join(project, '.claude/skills/open-pr'), { recursive: true });
  writeFileSync(join(project, '.claude/skills/open-pr/SKILL.md'), 'mine');

  const first = run(['add', 'open-pr', '--project', '--agent', 'claude', '--source', repo], { home, cwd: project });
  assert.match(first.out, /skipped \.claude\/skills\/open-pr/);
  assert.equal(readFileSync(join(project, '.claude/skills/open-pr/SKILL.md'), 'utf8'), 'mine');

  const again = run(['add', 'open-pr', '--project', '--agent', 'claude', '--source', repo], { home, cwd: project });
  assert.match(again.out, /skipped \.claude\/skills\/open-pr/);
  assert.equal(readFileSync(join(project, '.claude/skills/open-pr/SKILL.md'), 'utf8'), 'mine');

  const forced = run(['add', 'open-pr', '--project', '--agent', 'claude', '--force', '--source', repo], { home, cwd: project });
  assert.equal(forced.code, 0, forced.err);
  assert.match(readFileSync(join(project, '.claude/skills/open-pr/SKILL.md'), 'utf8'), /name: open-pr/);
});

test('update and remove never touch a same-named skill Shomero skipped', () => {
  const repo = fixtureRepo();
  const home = tmp('home');
  const project = tmp('project');
  mkdirSync(join(project, '.claude/skills/open-pr'), { recursive: true });
  writeFileSync(join(project, '.claude/skills/open-pr/SKILL.md'), 'mine');
  run(['add', 'open-pr', '--project', '--agent', 'claude,codex', '--source', repo], { home, cwd: project });
  assert.ok(existsSync(join(project, '.agents/skills/open-pr/SKILL.md')));
  const manifest = JSON.parse(readFileSync(join(project, '.shomero', 'skills.json'), 'utf8'));
  assert.deepEqual(manifest.skills['open-pr'].dirs, ['.agents/skills']);

  assert.equal(run(['update'], { home, cwd: project }).code, 0);
  assert.equal(readFileSync(join(project, '.claude/skills/open-pr/SKILL.md'), 'utf8'), 'mine');

  assert.equal(run(['remove', 'open-pr'], { home, cwd: project }).code, 0);
  assert.equal(readFileSync(join(project, '.claude/skills/open-pr/SKILL.md'), 'utf8'), 'mine');
  assert.ok(!existsSync(join(project, '.agents/skills/open-pr')));
});

test('add installs for the user by default, outside a terminal', () => {
  const repo = fixtureRepo();
  const home = tmp('home');
  const project = tmp('project');
  const r = run(['add', 'usecase', '--agent', 'claude', '--source', repo], { home, cwd: project });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /installed for your user \(every project\) in ~\/\.claude\/skills/);
  assert.ok(existsSync(join(home, '.claude/skills/usecase/SKILL.md')));
  assert.ok(!existsSync(join(project, '.claude')));
});

test('chooseScope asks only in a terminal inside a git repo, and flags skip the question', async () => {
  const repo = fixtureRepo();
  const asked = [];
  const ask = (answer) => async (q) => { asked.push(q); return answer; };
  assert.equal(await chooseScope({ dir: undefined }, { interactive: false, ask: ask('2') }), 'user');
  assert.equal(await chooseScope({ project: true }, { interactive: true, ask: ask('1') }), 'project');
  assert.equal(await chooseScope({ dir: repo }, { interactive: true, ask: ask('1') }), 'project');
  assert.equal(await chooseScope({ user: true }, { interactive: true, ask: ask('2') }), 'user');
  assert.equal(asked.length, 0);
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    assert.equal(await chooseScope({}, { interactive: true, ask: ask('') }), 'user');
    assert.equal(await chooseScope({}, { interactive: true, ask: ask('2') }), 'project');
    assert.equal(await chooseScope({ yes: true }, { interactive: true, ask: ask('2') }), 'user');
    await assert.rejects(chooseScope({}, { interactive: true, ask: ask('maybe') }), /isn't 1 or 2/);
  } finally { process.chdir(cwd); }
  process.chdir(tmp('not-a-repo'));
  try { assert.equal(await chooseScope({}, { interactive: true, ask: ask('2') }), 'user'); } finally { process.chdir(cwd); }
  assert.equal(asked.length, 3);
});

test('update refreshes the user install and this project install together', () => {
  const repo = fixtureRepo();
  const home = tmp('home');
  const project = tmp('project');
  run(['add', 'usecase', '--agent', 'claude', '--source', repo], { home, cwd: project });
  run(['add', 'open-pr', '--project', '--agent', 'claude', '--source', repo], { home, cwd: project });
  const u = run(['update'], { home, cwd: project });
  assert.equal(u.code, 0, u.err);
  assert.match(u.out, /1 skill updated for your user/);
  assert.match(u.out, /1 skill updated for this project only/);
  const rm = run(['remove', 'usecase', 'open-pr'], { home, cwd: project });
  assert.match(rm.out, /1 skill removed for your user/);
  assert.match(rm.out, /1 skill removed for this project only/);
});

test('--global installs under the home folder', () => {
  const repo = fixtureRepo();
  const home = tmp('home');
  const r = run(['add', 'usecase', '--global', '--agent', 'gemini', '--source', repo], { home, cwd: tmp('cwd') });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(home, '.agents/skills/usecase/SKILL.md')));
  assert.ok(existsSync(join(home, '.shomero/skills.json')));
});

test('unknown commands and skills fail with a readable message', () => {
  const repo = fixtureRepo();
  const home = tmp('home');
  const bad = run(['add', 'nope', '--source', repo], { home, cwd: tmp('cwd') });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /No skill or category "nope"/);
  assert.match(run(['frobnicate'], { home, cwd: tmp('cwd') }).err, /Unknown command/);
});

test('install.sh installs the CLI without touching shell files when asked', () => {
  const home = tmp('home');
  const dir = join(home, '.shomero', 'bin');
  const r = spawnSync('bash', [join(root, 'install.sh')], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, SHOMERO_CLI_FILE: cli, SHOMERO_INSTALL_DIR: dir, SHOMERO_NO_MODIFY_PATH: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /shomero 0\.2\.1 installed/);
  assert.equal(execFileSync(join(dir, 'shomero'), ['--version'], { encoding: 'utf8' }).trim(), '0.2.1');
});
