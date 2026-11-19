#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

export const VERSION = '0.2.1';
const DEFAULT_SOURCE = 'https://github.com/shomero/shomero-skills.git';

export const AGENTS = {
  claude: { label: 'Claude Code', reads: ['.claude/skills'], bins: ['claude'], homes: ['.claude'] },
  codex: { label: 'OpenAI Codex', reads: ['.agents/skills', '.codex/skills'], bins: ['codex'], homes: ['.codex'] },
  gemini: { label: 'Gemini CLI', reads: ['.gemini/skills', '.agents/skills'], bins: ['gemini'], homes: ['.gemini'] },
  cursor: { label: 'Cursor', reads: ['.agents/skills', '.cursor/skills', '.claude/skills', '.codex/skills'], bins: ['cursor', 'cursor-agent'], homes: ['.cursor'] },
  copilot: { label: 'GitHub Copilot', reads: ['.github/skills', '.claude/skills', '.agents/skills'], bins: ['copilot'], homes: ['.copilot'] },
};
const SHARED_DIR = '.agents/skills';

class UsageError extends Error {}

const env = () => ({
  home: process.env.SHOMERO_HOME_DIR || homedir(),
  state: process.env.SHOMERO_STATE_DIR || join(process.env.SHOMERO_HOME_DIR || homedir(), '.shomero'),
});

export function planDirs(agents) {
  const dirs = agents.includes('claude') ? ['.claude/skills'] : [];
  const uncovered = agents.filter((a) => !AGENTS[a].reads.some((d) => dirs.includes(d)));
  if (uncovered.length || dirs.length === 0) dirs.push(SHARED_DIR);
  return dirs;
}

export function detectAgents({ home, path = process.env.PATH || '' }) {
  const pathDirs = path.split(delimiter).filter(Boolean);
  return Object.entries(AGENTS)
    .filter(([, a]) => a.homes.some((h) => existsSync(join(home, h))) || a.bins.some((b) => pathDirs.some((p) => existsSync(join(p, b)))))
    .map(([id]) => id);
}

function parseAgents(value) {
  if (!value) return null;
  const ids = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (ids.includes('all')) return Object.keys(AGENTS);
  for (const id of ids) if (!AGENTS[id]) throw new UsageError(`Unknown agent "${id}". Known: ${Object.keys(AGENTS).join(', ')}, all.`);
  return ids;
}

function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts,
  }).trim();
}

function cloneUrls(source) {
  const gh = source.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(\.git)?$/);
  return gh ? [source, `git@github.com:${gh[1]}.git`] : [source];
}

function cloneOrFetch(source, dir, refresh) {
  if (existsSync(join(dir, '.git'))) {
    if (refresh) {
      git(['-C', dir, 'fetch', '--quiet', '--depth', '1', 'origin']);
      git(['-C', dir, 'reset', '--quiet', '--hard', 'FETCH_HEAD']);
    }
    return;
  }
  mkdirSync(dirname(dir), { recursive: true });
  let last;
  for (const url of cloneUrls(source)) {
    try { git(['clone', '--quiet', '--depth', '1', url, dir]); return; } catch (e) {
      last = e;
      rmSync(dir, { recursive: true, force: true });
    }
  }
  throw last;
}

function isLocalSource(source) {
  return !/^(https?:|git@|ssh:)/.test(source) && existsSync(resolve(source));
}

export function resolveSource(source, { refresh = false } = {}) {
  if (isLocalSource(source)) {
    const dir = resolve(source);
    if (!existsSync(join(dir, 'catalog.json'))) throw new UsageError(`No catalog.json in ${dir}.`);
    let commit = null;
    try { commit = git(['-C', dir, 'rev-parse', '--short', 'HEAD']); } catch {}
    return { dir, commit, source: dir };
  }
  const slug = source.replace(/\.git$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dir = join(env().state, 'cache', slug);
  try {
    cloneOrFetch(source, dir, refresh);
  } catch (e) {
    throw new UsageError(`Could not fetch skills from ${source}: ${(e.stderr || e.message).toString().trim().split('\n')[0]}`);
  }
  return { dir, commit: git(['-C', dir, 'rev-parse', '--short', 'HEAD']), source };
}

function frontmatter(file) {
  const text = readFileSync(file, 'utf8');
  const block = text.match(/^---\n([\s\S]*?)\n---/);
  const get = (key) => block?.[1].match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '') ?? '';
  return { name: get('name'), description: get('description') };
}

export function loadCatalog(dir) {
  const catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
  const skills = catalog.skills.map((s) => ({ ...s, ...frontmatter(join(dir, s.path, 'SKILL.md')), name: s.name, src: join(dir, s.path) }));
  return { categories: catalog.categories || {}, examples: catalog.examples || {}, skills };
}

export function selectSkills(catalog, tokens) {
  if (tokens.length === 0) throw new UsageError('Name at least one skill, category, or "all". Try: shomero list');
  const byName = new Map(catalog.skills.map((s) => [s.name, s]));
  const picked = new Map();
  for (const token of tokens) {
    if (token === 'all') catalog.skills.forEach((s) => picked.set(s.name, s));
    else if (catalog.categories[token] || catalog.skills.some((s) => s.category === token)) catalog.skills.filter((s) => s.category === token).forEach((s) => picked.set(s.name, s));
    else if (byName.has(token)) picked.set(token, byName.get(token));
    else {
      const near = [...byName.keys()].filter((n) => n.includes(token) || token.includes(n)).slice(0, 3);
      throw new UsageError(`No skill or category "${token}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ' Try: shomero list'}`);
    }
  }
  return [...picked.values()];
}

function projectBase(values) { return resolve(values.dir || process.cwd()); }

export function scopeFor(kind, values) {
  const { home, state } = env();
  if (kind === 'user') return { kind, base: home, manifest: join(state, 'skills.json'), label: 'for your user (every project)', show: (d) => `~/${d}` };
  const base = projectBase(values);
  return { kind, base, manifest: join(base, '.shomero', 'skills.json'), label: `for this project only (${base})`, show: (d) => d };
}

function explicitScope(values) {
  if (values.project || values.dir) return 'project';
  if (values.user || values.global) return 'user';
  return null;
}

function insideGitRepo(dir) {
  try { return git(['-C', dir, 'rev-parse', '--is-inside-work-tree']) === 'true'; } catch { return false; }
}

async function askLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const cancel = () => rl.close();
  rl.on('SIGINT', cancel);
  try {
    return await new Promise((done, fail) => {
      rl.once('close', () => fail(new UsageError('Cancelled; nothing installed.')));
      rl.question(question).then(done, () => fail(new UsageError('Cancelled; nothing installed.')));
    });
  } finally { rl.removeListener('SIGINT', cancel); rl.close(); }
}

export async function chooseScope(values, { interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY), ask = askLine } = {}) {
  const explicit = explicitScope(values);
  if (explicit) return explicit;
  if (!interactive || values.yes || !insideGitRepo(projectBase(values))) return 'user';
  const answer = (await ask(`Install for:\n  1) your user: every project on this machine (recommended)\n  2) this project only: ${projectBase(values)}, committed with the repo\nChoose [1]: `)).trim().toLowerCase();
  if (['', '1', 'u', 'user'].includes(answer)) return 'user';
  if (['2', 'p', 'project'].includes(answer)) return 'project';
  throw new UsageError(`"${answer}" isn't 1 or 2.`);
}

function installedScopes(values) {
  const explicit = explicitScope(values);
  if (explicit) return [scopeFor(explicit, values)];
  return ['user', 'project'].map((k) => scopeFor(k, values)).filter((sc) => Object.keys(readManifest(sc.manifest).skills).length);
}

function readManifest(file) {
  if (!existsSync(file)) return { version: 1, source: null, commit: null, dirs: [], skills: {} };
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeManifest(file, manifest) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

const ownedDirs = (entry, manifest) => (entry ? entry.dirs || manifest.dirs || [] : []);

function copySkill(skill, base, dirs, owned, force) {
  const done = [];
  const skipped = [];
  for (const d of dirs) {
    const dest = join(base, d, skill.name);
    if (existsSync(dest) && !owned.includes(d) && !force) { skipped.push(join(d, skill.name)); continue; }
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(skill.src, dest, { recursive: true });
    done.push(d);
  }
  return { done, skipped };
}

const out = (line = '') => process.stdout.write(`${line}\n`);
const sourceOf = (values, manifest) => values.source || process.env.SHOMERO_SKILLS_SOURCE || manifest?.source || DEFAULT_SOURCE;
const short = (text, max = 88) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function cmdList(values) {
  const scopes = installedScopes(values);
  const { dir } = resolveSource(sourceOf(values, readManifest(scopeFor('user', values).manifest)), { refresh: values.refresh });
  const catalog = loadCatalog(dir);
  const where = new Map();
  for (const sc of scopes) for (const name of Object.keys(readManifest(sc.manifest).skills)) where.set(name, [...(where.get(name) || []), sc.kind]);
  const order = Object.keys(catalog.categories);
  const cats = [...new Set(catalog.skills.map((s) => s.category))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  for (const cat of cats) {
    if (values.category && values.category !== cat) continue;
    const skills = catalog.skills.filter((s) => s.category === cat && (!values.installed || where.has(s.name)));
    if (!skills.length) continue;
    out(`${cat}${catalog.categories[cat] ? `: ${catalog.categories[cat]}` : ''}`);
    for (const s of skills) {
      const tag = where.has(s.name) ? ` [${where.get(s.name).join(', ')}]` : '';
      out(`  ${s.name.padEnd(26)} ${short(s.description.split(' — ')[0], 88 - tag.length)}${tag}`);
    }
    out();
  }
  out('Install: shomero add <skill|category|all>   e.g. shomero add architecture feature-auth');
}

async function cmdAdd(tokens, values) {
  const userManifest = readManifest(scopeFor('user', values).manifest);
  const src = resolveSource(sourceOf(values, userManifest), { refresh: values.refresh });
  const catalog = loadCatalog(src.dir);
  const skills = selectSkills(catalog, tokens);
  const sc = scopeFor(await chooseScope(values), values);
  const manifest = readManifest(sc.manifest);
  const agents = parseAgents(values.agent) || (manifest.agents?.length ? manifest.agents : null) || detectAgents({ home: env().home });
  const dirs = [...new Set([...planDirs(agents), ...(values.agent ? [] : manifest.dirs || [])])];
  const skippedAll = [];
  for (const s of skills) {
    const owned = ownedDirs(manifest.skills[s.name], manifest);
    const { done, skipped } = copySkill(s, sc.base, dirs, owned, values.force);
    skippedAll.push(...skipped.map(sc.show));
    if (done.length || owned.length) manifest.skills[s.name] = { category: s.category, dirs: [...new Set([...owned, ...done])] };
  }
  Object.assign(manifest, { source: src.source, commit: src.commit, agents, dirs: [...new Set([...(manifest.dirs || []), ...dirs])] });
  writeManifest(sc.manifest, manifest);

  const added = skills.filter((s) => manifest.skills[s.name]);
  out(`✓ ${plural(added.length, 'skill')} installed ${sc.label} in ${dirs.map(sc.show).join(' and ')}`);
  out(`  for ${agents.length ? agents.map((a) => AGENTS[a].label).join(', ') : 'any tool that reads .agents/skills'}`);
  for (const p of skippedAll) out(`! skipped ${p}: a skill with that name is already there and isn't Shomero's. Use --force to replace it.`);
  if (sc.kind === 'project') out('  Commit .shomero/skills.json and the skill folders so the team gets them too.');
  const needs = [...new Set(added.flatMap((s) => s.requires || []))];
  if (needs.length) {
    out('');
    out('These skills expect pieces from the example project:');
    for (const n of needs) out(`  ${n.padEnd(14)} ${catalog.examples[n] || ''}`);
  }
}

function removeIfEmpty(dir) {
  try { if (readdirSync(dir).length === 0) { rmdirSync(dir); return true; } } catch {}
  return false;
}

function cleanUp(sc, manifest) {
  rmSync(sc.manifest, { force: true });
  removeIfEmpty(dirname(sc.manifest));
  for (const d of manifest.dirs) if (removeIfEmpty(join(sc.base, d))) removeIfEmpty(dirname(join(sc.base, d)));
}

function cmdRemove(tokens, values) {
  if (!tokens.length) throw new UsageError('Name the skills to remove, or "all".');
  const scopes = installedScopes(values);
  if (!scopes.length) { out('Nothing installed yet.'); return; }
  const found = new Set();
  for (const sc of scopes) {
    const manifest = readManifest(sc.manifest);
    const names = tokens.includes('all') ? Object.keys(manifest.skills) : tokens.filter((n) => manifest.skills[n]);
    for (const name of names) {
      for (const d of ownedDirs(manifest.skills[name], manifest)) rmSync(join(sc.base, d, name), { recursive: true, force: true });
      delete manifest.skills[name];
      found.add(name);
    }
    if (Object.keys(manifest.skills).length) writeManifest(sc.manifest, manifest);
    else cleanUp(sc, manifest);
    if (names.length) out(`✓ ${plural(names.length, 'skill')} removed ${sc.label}`);
  }
  for (const name of tokens) if (name !== 'all' && !found.has(name)) out(`! ${name} isn't installed by Shomero; left alone.`);
}

function cmdUpdate(values) {
  const scopes = installedScopes(values);
  if (!scopes.length) { out('Nothing installed yet. Try: shomero add all'); return; }
  for (const sc of scopes) {
    const manifest = readManifest(sc.manifest);
    const src = resolveSource(sourceOf(values, manifest), { refresh: true });
    const byName = new Map(loadCatalog(src.dir).skills.map((s) => [s.name, s]));
    let updated = 0;
    for (const name of Object.keys(manifest.skills)) {
      const s = byName.get(name);
      if (!s) { out(`! ${name} no longer exists in the catalog; kept your copy. Remove it with: shomero remove ${name}`); continue; }
      const owned = ownedDirs(manifest.skills[name], manifest);
      copySkill(s, sc.base, owned, owned, true);
      updated++;
    }
    const before = manifest.commit;
    Object.assign(manifest, { source: src.source, commit: src.commit });
    writeManifest(sc.manifest, manifest);
    const at = before && before !== src.commit ? ` (${before} → ${src.commit})` : src.commit ? ` (at ${src.commit})` : '';
    out(`✓ ${plural(updated, 'skill')} updated ${sc.label}${at}`);
  }
}

function cmdAgents(values) {
  const detected = detectAgents({ home: env().home });
  const chosen = parseAgents(values.agent) || detected;
  for (const [id, a] of Object.entries(AGENTS)) out(`${detected.includes(id) ? '✓' : ' '} ${id.padEnd(8)} ${a.label.padEnd(15)} reads ${a.reads.join(', ')}`);
  out('');
  out(`shomero add installs into: ${planDirs(chosen).map((d) => `~/${d}`).join(' and ')} (or the same folders in a project with --project)`);
  out('Pick tools yourself with --agent claude,codex,gemini,cursor,copilot (or all).');
}

const HELP = `shomero ${VERSION}: install Shomero skills for AI coding agents

Usage
  shomero list [--category <c>] [--installed]   Show the skills, and where each is installed
  shomero add <skill|category|all>...           Install skills (for your user by default)
  shomero remove <skill|all>...                 Remove installed skills
  shomero update                                Pull the latest skills and refresh every install
  shomero agents                                Show detected tools and where skills go

Where skills go
  By default, for your user: ~/.claude/skills and ~/.agents/skills, active in every project.
  Inside a git repo, in a terminal, add asks whether to install for this project instead.
  --user           For your user, without asking
  --project        For this project only (.claude/skills, .agents/skills), committed with the repo
  --dir <path>     The project folder (implies --project)
  --yes, -y        Never ask; use the default (your user)

Options
  --agent <list>   claude, codex, gemini, cursor, copilot, all (default: detected tools)
  --source <s>     Skills repo: git URL or local folder (default: ${DEFAULT_SOURCE})
  --force          Replace a same-named skill that Shomero didn't install
  --refresh        Fetch the latest skills before list/add

Examples
  shomero add all
  shomero add architecture feature-auth --agent claude,codex
  shomero add kotlin-conventions --project`;

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      agent: { type: 'string' }, user: { type: 'boolean' }, global: { type: 'boolean' }, project: { type: 'boolean' },
      dir: { type: 'string' }, source: { type: 'string' }, yes: { type: 'boolean', short: 'y' },
      force: { type: 'boolean' }, refresh: { type: 'boolean' }, category: { type: 'string' }, installed: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.project && (values.user || values.global)) throw new UsageError('Pick one: --user or --project.');
  const [command, ...rest] = positionals;
  if (values.version) return out(VERSION);
  if (values.help || !command || command === 'help') return out(HELP);
  switch (command) {
    case 'list': case 'ls': return cmdList(values);
    case 'add': case 'install': return cmdAdd(rest, values);
    case 'remove': case 'rm': return cmdRemove(rest, values);
    case 'update': return cmdUpdate(values);
    case 'agents': return cmdAgents(values);
    default: throw new UsageError(`Unknown command "${command}". Run: shomero help`);
  }
}

const invoked = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (invoked) {
  main().catch((e) => {
    process.stderr.write(`✗ ${e instanceof UsageError || e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? e.message : e.stack}\n`);
    process.exit(1);
  });
}
