# ✨ Claude Skills

A cozy little [Obsidian](https://obsidian.md) plugin that lets you browse your [Claude Code](https://claude.com/claude-code) skills and slash commands, peek at their details, and run them with a single click 🖱️ — from a sidebar panel or straight from your Kanban cards.
> 🚧 **Work in progress!** This is a personal plugin, still growing and occasionally rough around the edges. Things may change, break, or get polished without warning. Contributions, bug reports, and gentle nudges are very welcome.

## 🌟 Features

- 🗂️ **Sidebar panel** — lists all discovered skills and commands, grouped by source, with a search/filter box.
- 📖 **Skill details view** — click a skill to see its rendered `SKILL.md` (description, metadata, supporting files) in a dedicated tab. Supporting files (references, scripts, templates) are listed and open inline for text files, or in your default editor otherwise.
- ✏️ **Inline editing** — edit a skill's markdown directly in the detail view and save with `Ctrl/Cmd+S`.
- ▶️ **One-click run** — runs `claude /skill-name [args]` in a terminal. Optionally prompts for arguments first (e.g. a Jira key or file path).
- 🖥️ **Terminal integration** — runs in an embedded terminal via the [Open Terminal](https://github.com/m4rri4nne/open-terminal-obsidian) plugin when available (reusing an existing idle or active Claude session), or falls back to opening an external terminal window (Terminal.app on macOS, Windows Terminal/PowerShell on Windows, `x-terminal-emulator` on Linux).
- 📌 **Kanban integration** — adds a ▶ button to cards in the [Kanban](https://github.com/mgmeyers/obsidian-kanban) plugin that contain a Jira-style issue key (e.g. `PROJ-123`), running one or more configured skills against that key.
- 🔍 **Command palette** — `Open skills panel`, `Run skill…` (fuzzy picker), and `Reload skills list` commands.

## 🧭 Where skills are discovered

The plugin scans these locations and merges the results (project skills take precedence over personal ones with the same name):

| Source | Location |
|---|---|
| 🏡 Project (vault) | `<vault>/.claude/skills/*/SKILL.md` and `<vault>/.claude/commands/*.md` |
| 👤 Personal | `~/.claude/skills/*/SKILL.md` and `~/.claude/commands/*.md` |
| 🧩 Plugins | `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/{skills,commands}` (toggle in settings) |
| 📁 Other folders | Any additional folders you list in settings, each scanned for `*/SKILL.md` |

Skills with `user-invocable: false` in their frontmatter are skipped.

## 📦 Installation

This plugin isn't on the Obsidian community plugin store yet. To install manually:

1. Copy `main.js`, `manifest.json`, and `styles.css` into `<your-vault>/.obsidian/plugins/claude-skills/`.
2. Reload Obsidian (or disable/re-enable community plugins).
3. Enable **Claude Skills** under Settings → Community plugins.

## 🚀 Usage

1. Click the sparkles ✨ ribbon icon (or run **Claude Skills: Open skills panel**) to open the sidebar.
2. Browse or filter skills, click a card to view its details, or click **Run** to execute it.
3. If "Ask for arguments before running" is enabled, a dialog lets you type arguments before the skill runs.

## ⚙️ Settings

| Setting | Description |
|---|---|
| Claude command | The Claude Code CLI executable (default `claude`). |
| Extra arguments | Extra flags passed before the prompt, e.g. `--permission-mode acceptEdits` or `--model opus`. |
| Ask for arguments before running | Shows an input box for arguments before running a skill. |
| Where to run | Use the embedded terminal when the Open Terminal plugin is installed, or always open an external window. |
| Reuse open terminal | Sends the prompt to an already-open Claude session or idle terminal instead of always opening a new one. |
| Show plugin skills | Include skills bundled in installed Claude Code plugins. |
| Additional folders | Extra folders (one per line) to scan for `*/SKILL.md`. |
| Button on cards | Adds a ▶ run button to Kanban cards containing an issue key. |
| Skills on cards | Comma-separated skill names to run from Kanban cards (single skill runs directly, multiple shows a menu). |
| Confirm before running | Pre-fills the arguments box with the card's issue key before running. |

## ✅ Requirements

- Desktop only (uses Node's `fs`/`child_process`/`os` APIs).
- The [Claude Code](https://claude.com/claude-code) CLI installed and available on your `PATH` (or configured via the "Claude command" setting).
- Optional: [Open Terminal](https://github.com/m4rri4nne/open-terminal-obsidian) for embedded-terminal support.
- Optional: [Kanban](https://github.com/mgmeyers/obsidian-kanban) for card-button integration.

## 💜 Author

Made with care by Alicia de Paula
