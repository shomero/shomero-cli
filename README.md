# shomero

Install [Shomero skills](https://github.com/shomero/shomero-skills) into your project, for whichever AI coding tools you use.

```bash
curl -fsSL https://github.com/shomero/shomero-cli/releases/latest/download/install.sh | bash
```

Then:

```bash
shomero add all
```

Skills go **for your user** by default (`~/.claude/skills`, `~/.agents/skills`), so every project on your machine has them. Run inside a git repo, `add` asks whether to install them **for that project only** instead; Enter keeps the default.

Needs Node.js 18+ and git. Pin a version with `SHOMERO_VERSION=v0.1.0` in front of `bash`.

While this repo is private, install through your GitHub login instead:

```bash
gh release download -R shomero/shomero-cli -p install.sh -O - | bash
```

## Commands

| Command | Does |
|---|---|
| `shomero list` | Show every skill by category (`--category ui`, `--installed`) |
| `shomero add <skill\|category\|all>…` | Install skills, e.g. `shomero add architecture feature-auth` |
| `shomero remove <skill\|all>…` | Remove skills Shomero installed |
| `shomero update` | Pull the latest skills and refresh your user install and this project's |
| `shomero agents` | Show which tools were found and where skills will go |

Where: `--user` (no question), `--project` (this project only), `--dir <path>` (that project), `-y` (never ask, use your user).
Options: `--agent claude,codex,gemini,cursor,copilot|all`, `--source <git url|folder>`, `--force`, `--refresh`.

## Which tools, which folders

Every tool here reads the open [Agent Skills](https://agentskills.io) format (`<folder>/<skill>/SKILL.md`). Shomero installs into as few folders as possible so no tool sees a skill twice:

| Tool | Reads | Shomero installs into |
|---|---|---|
| Claude Code | `.claude/skills` | `.claude/skills` |
| OpenAI Codex | `.agents/skills` | `.agents/skills` |
| Gemini CLI | `.gemini/skills`, `.agents/skills` | `.agents/skills` |
| Cursor | `.agents/skills`, `.cursor/skills`, `.claude/skills` | covered by either |
| GitHub Copilot | `.github/skills`, `.claude/skills`, `.agents/skills` | covered by either |

Without `--agent`, it uses the tools it finds on your machine (their home folder or command). For your user the folders are under your home folder; for a project, at the project root.

## What it writes

- The skill folders above.
- A record of what it installed: `~/.shomero/skills.json` for your user, `.shomero/skills.json` in a project. Commit the project one with the skill folders, so `shomero update` works for the whole team.

A skill folder with the same name that Shomero didn't install is never overwritten, unless you pass `--force`.

## Releasing

1. Bump the version in `bin/shomero.mjs` (`VERSION`) and `package.json`.
2. Commit, then tag and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. The `Release` workflow tests on Linux and macOS with Node 18 and 22, checks the tag matches both versions, and publishes a GitHub release with `shomero.mjs` and `install.sh` attached. The install one-liner picks it up through `releases/latest`.

The one-liner works for everyone only when this repo is public: release files of a private repo need a GitHub login to download. The skills repo is cloned with the user's own git access (HTTPS, then SSH).

## Develop

```bash
npm test
node bin/shomero.mjs list --source ../shomero-skills
```

One file, no dependencies: `bin/shomero.mjs`.
