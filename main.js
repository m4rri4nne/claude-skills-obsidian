"use strict";

const {
  Plugin,
  ItemView,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  FileSystemAdapter,
  TFile,
  parseYaml,
  setIcon,
  MarkdownRenderer,
  Menu,
} = require("obsidian");
const fs = require("fs");
const os = require("os");
const path = require("path");

const VIEW_TYPE = "claude-skills-view";
const DETAIL_VIEW_TYPE = "claude-skill-detail-view";

const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".js", ".mjs", ".cjs", ".ts", ".py",
  ".sh", ".ps1", ".cs", ".xml", ".html", ".css", ".csv", ".toml", ".ini", ".feature",
]);

const DEFAULT_SETTINGS = {
  claudeCommand: "claude",
  // Extra arguments passed to claude (e.g. --permission-mode acceptEdits)
  extraArgs: "",
  // Ask for arguments before running
  askArgs: true,
  // Additional folders containing skills (one per line)
  extraFolders: "",
  showPlugins: true,
  // "auto": embedded terminal when Open Terminal is installed, otherwise an external window
  // "external": always an external terminal window
  terminalMode: "auto",
  // Reuse an open terminal instead of opening a new one
  reuseTerminal: true,
  // Button on Kanban cards that contain a Jira key
  kanbanEnabled: true,
  kanbanSkills: "test-plan",
  kanbanConfirm: true,
  collapsed: {},
};

const SOURCES = {
  project: { label: "Project (vault)", icon: "folder-open" },
  personal: { label: "Personal (~/.claude)", icon: "user" },
  commands: { label: "Commands", icon: "slash" },
  plugin: { label: "Plugins", icon: "puzzle" },
  extra: { label: "Other folders", icon: "folder-plus" },
};

// ---------- Skill discovery ----------

function readFrontmatter(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {};
    return parseYaml(m[1]) || {};
  } catch {
    return {};
  }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function scanSkillsDir(dir, source, extra = {}) {
  const out = [];
  for (const sub of listDirs(dir)) {
    const file = path.join(sub, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const fm = readFrontmatter(file);
    if (fm["user-invocable"] === false) continue;
    out.push({
      name: String(fm.name || path.basename(sub)),
      description: String(fm.description || "").trim(),
      argumentHint: fm["argument-hint"] ? String(fm["argument-hint"]) : "",
      file,
      source,
      ...extra,
    });
  }
  return out;
}

function scanCommandsDir(dir, extra = {}) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const file = path.join(dir, e.name);
    const fm = readFrontmatter(file);
    out.push({
      name: e.name.replace(/\.md$/, ""),
      description: String(fm.description || "").trim(),
      argumentHint: fm["argument-hint"] ? String(fm["argument-hint"]) : "",
      file,
      source: "commands",
      ...extra,
    });
  }
  return out;
}

function scanPlugins(claudeHome) {
  // Installed plugins live in ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
  const out = [];
  const cache = path.join(claudeHome, "plugins", "cache");
  for (const market of listDirs(cache)) {
    for (const plugin of listDirs(market)) {
      const pluginName = path.basename(plugin);
      // Use the latest version (alphabetical order) or the folder itself
      const versions = listDirs(plugin).sort();
      const roots = versions.length ? [versions[versions.length - 1]] : [plugin];
      for (const root of roots) {
        const tag = { plugin: pluginName };
        out.push(...scanSkillsDir(path.join(root, "skills"), "plugin", tag));
        out.push(...scanCommandsDir(path.join(root, "commands"), tag).map((s) => ({ ...s, source: "plugin" })));
      }
    }
  }
  return out;
}

// ---------- View ----------

class SkillsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.filter = "";
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Claude Skills";
  }

  getIcon() {
    return "sparkles";
  }

  async onOpen() {
    this.render();
  }

  render() {
    const el = this.contentEl;
    el.empty();
    el.addClass("claude-skills-view");

    const header = el.createDiv({ cls: "claude-skills-header" });
    const search = header.createEl("input", {
      type: "search",
      placeholder: "Filter skills…",
      cls: "claude-skills-search",
    });
    search.value = this.filter;
    search.addEventListener("input", () => {
      this.filter = search.value;
      this.renderList(listEl);
    });

    const refresh = header.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Reload" } });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => {
      this.plugin.loadSkills();
      this.renderList(listEl);
      new Notice(`${this.plugin.skills.length} skills found`);
    });

    const claudeBtn = header.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Open Claude (no skill)" } });
    setIcon(claudeBtn, "terminal-square");
    claudeBtn.addEventListener("click", () => this.plugin.runClaude(null));

    const listEl = el.createDiv({ cls: "claude-skills-list" });
    this.renderList(listEl);
  }

  renderList(listEl) {
    listEl.empty();
    const q = this.filter.trim().toLowerCase();
    const skills = this.plugin.skills.filter(
      (s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );

    if (!skills.length) {
      listEl.createDiv({ cls: "claude-skills-empty", text: q ? "No skills match the filter." : "No skills found." });
      return;
    }

    for (const [key, meta] of Object.entries(SOURCES)) {
      const group = skills.filter((s) => s.source === key);
      if (!group.length) continue;

      const collapsed = !q && this.plugin.settings.collapsed[key];
      const section = listEl.createDiv({ cls: "claude-skills-section" + (collapsed ? " is-collapsed" : "") });
      const title = section.createDiv({ cls: "claude-skills-section-title" });
      const chevron = title.createSpan({ cls: "claude-skills-chevron" });
      setIcon(chevron, "chevron-down");
      const icon = title.createSpan();
      setIcon(icon, meta.icon);
      title.createSpan({ text: meta.label });
      title.createSpan({ cls: "claude-skills-count", text: String(group.length) });
      title.addEventListener("click", async () => {
        this.plugin.settings.collapsed[key] = !this.plugin.settings.collapsed[key];
        await this.plugin.saveSettings();
        this.renderList(listEl);
      });

      const body = section.createDiv({ cls: "claude-skills-section-body" });
      for (const skill of group.sort((a, b) => a.name.localeCompare(b.name))) this.renderCard(body, skill);
    }
  }

  renderCard(parent, skill) {
    const card = parent.createDiv({ cls: "claude-skills-card" });

    const top = card.createDiv({ cls: "claude-skills-card-top" });
    const nameEl = top.createDiv({ cls: "claude-skills-name" });
    nameEl.createSpan({ text: "/" + this.plugin.invocationName(skill) });
    if (skill.plugin) nameEl.createSpan({ cls: "claude-skills-tag", text: skill.plugin });

    const actions = top.createDiv({ cls: "claude-skills-actions" });

    card.addClass("is-clickable");
    card.addEventListener("click", () => this.plugin.openSkillFile(skill));

    const openBtn = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "View details" } });
    setIcon(openBtn, "file-text");
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.plugin.openSkillFile(skill);
    });

    const runBtn = actions.createEl("button", { cls: "mod-cta claude-skills-run", attr: { "aria-label": "Run" } });
    setIcon(runBtn, "play");
    runBtn.createSpan({ text: "Run" });
    runBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.plugin.runSkill(skill);
    });

    if (skill.description) {
      const desc = card.createDiv({ cls: "claude-skills-desc", text: skill.description });
      desc.setAttr("title", skill.description);
      desc.addEventListener("click", (e) => {
        e.stopPropagation();
        desc.toggleClass("is-expanded", !desc.hasClass("is-expanded"));
      });
    }
  }
}

// ---------- Skill details ----------

function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: text };
  let fm = {};
  try {
    fm = parseYaml(m[1]) || {};
  } catch {}
  return { fm, body: text.slice(m[0].length) };
}

function listFilesRecursive(dir, depth = 3, base = dir) {
  const out = [];
  if (depth < 0) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(full, depth - 1, base));
    else out.push({ full, rel: path.relative(base, full) });
  }
  return out;
}

class SkillDetailView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.file = null; // file currently displayed
    this.skillFile = null; // the skill's SKILL.md (or command .md)
    this.editing = false;
  }

  getViewType() {
    return DETAIL_VIEW_TYPE;
  }

  getDisplayText() {
    const skill = this.skill();
    if (!skill) return "Skill";
    const name = "/" + this.plugin.invocationName(skill);
    return this.file && this.file !== this.skillFile ? `${name} · ${path.basename(this.file)}` : name;
  }

  getIcon() {
    return "sparkles";
  }

  getState() {
    return { file: this.file, skillFile: this.skillFile };
  }

  async setState(state, result) {
    if (state && state.file) {
      this.file = state.file;
      this.skillFile = state.skillFile || state.file;
      this.editing = false;
      await this.render();
    }
    await super.setState(state, result);
  }

  skill() {
    return this.plugin.skills.find((s) => s.file === this.skillFile) || null;
  }

  skillDir() {
    const skill = this.skill();
    // Skills live in their own folder; commands are a single .md (no supporting files)
    if (skill && skill.source === "commands") return null;
    if (this.skillFile && path.basename(this.skillFile) === "SKILL.md") return path.dirname(this.skillFile);
    return null;
  }

  async onOpen() {
    this.contentEl.addClass("claude-skill-detail");
    await this.render();
  }

  async onClose() {
    this.contentEl.empty();
  }

  async render() {
    const el = this.contentEl;
    el.empty();
    if (!this.file) return;

    let text;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      el.createDiv({ cls: "claude-skills-empty", text: `Could not read the file: ${err.message}` });
      return;
    }

    const skill = this.skill();
    const isMain = this.file === this.skillFile;
    const isMarkdown = path.extname(this.file).toLowerCase() === ".md";
    const { fm, body } = isMarkdown ? splitFrontmatter(text) : { fm: {}, body: text };

    // Toolbar
    const toolbar = el.createDiv({ cls: "claude-skill-toolbar" });
    if (!isMain) {
      this.iconButton(toolbar, "arrow-left", "Back to the skill", () => this.show(this.skillFile));
    }
    toolbar.createDiv({ cls: "claude-skill-toolbar-path", text: this.file, attr: { title: this.file } });
    if (skill) {
      const run = toolbar.createEl("button", { cls: "mod-cta claude-skills-run" });
      setIcon(run, "play");
      run.createSpan({ text: "Run" });
      run.addEventListener("click", () => this.plugin.runSkill(skill));
    }
    this.iconButton(toolbar, this.editing ? "eye" : "pencil", this.editing ? "Preview" : "Edit", () => {
      this.editing = !this.editing;
      this.render();
    });
    this.iconButton(toolbar, "refresh-cw", "Reload", () => this.render());
    this.iconButton(toolbar, "copy", "Copy path", () => {
      navigator.clipboard.writeText(this.file);
      new Notice("Path copied");
    });
    this.iconButton(toolbar, "external-link", "Open in default editor", () =>
      window.require("electron").shell.openPath(this.file)
    );
    this.iconButton(toolbar, "folder-open", "Show in folder", () =>
      window.require("electron").shell.showItemInFolder(this.file)
    );

    if (this.editing) {
      this.renderEditor(el, text);
      return;
    }

    const page = el.createDiv({ cls: "claude-skill-page markdown-rendered" });

    // Header with metadata (main file only)
    if (isMain && skill) {
      const head = page.createDiv({ cls: "claude-skill-head" });
      head.createEl("h1", { text: "/" + this.plugin.invocationName(skill) });
      const badges = head.createDiv({ cls: "claude-skill-badges" });
      badges.createSpan({ cls: "claude-skills-tag", text: SOURCES[skill.source]?.label || skill.source });
      if (skill.plugin) badges.createSpan({ cls: "claude-skills-tag", text: `plugin: ${skill.plugin}` });
      if (skill.description) head.createEl("p", { cls: "claude-skill-description", text: skill.description });

      const meta = Object.entries(fm).filter(([k]) => k !== "name" && k !== "description");
      if (meta.length) {
        const table = head.createEl("table", { cls: "claude-skill-meta" });
        for (const [k, v] of meta) {
          const row = table.createEl("tr");
          row.createEl("th", { text: k });
          const cell = row.createEl("td");
          const values = Array.isArray(v) ? v : typeof v === "string" && k === "tools" ? v.split(/\s*,\s*/) : [v];
          if (values.length > 1 || k === "tools" || k === "allowed-tools") {
            for (const item of values) cell.createEl("code", { cls: "claude-skill-chip", text: String(item) });
          } else {
            cell.setText(typeof v === "object" ? JSON.stringify(v) : String(v));
          }
        }
      }
    }

    // Content
    const content = page.createDiv({ cls: "claude-skill-content" });
    const md = isMarkdown ? body : "```" + path.extname(this.file).slice(1) + "\n" + body + "\n```";
    await MarkdownRenderer.render(this.app, md, content, "", this);
    this.wireLinks(content);

    // Supporting files (references, scripts, templates…)
    const dir = this.skillDir();
    if (isMain && dir) {
      const files = listFilesRecursive(dir).filter((f) => f.full !== this.skillFile);
      if (files.length) {
        const sec = page.createDiv({ cls: "claude-skill-files" });
        sec.createEl("h3", { text: `Skill files (${files.length})` });
        const list = sec.createEl("ul");
        for (const f of files) {
          const li = list.createEl("li");
          const icon = li.createSpan({ cls: "claude-skill-file-icon" });
          setIcon(icon, TEXT_EXTENSIONS.has(path.extname(f.full).toLowerCase()) ? "file-text" : "file");
          const a = li.createEl("a", { text: f.rel.split(path.sep).join("/"), href: "#" });
          a.addEventListener("click", (e) => {
            e.preventDefault();
            this.openRelated(f.full);
          });
        }
      }
    }
  }

  renderEditor(el, text) {
    const wrap = el.createDiv({ cls: "claude-skill-editor" });
    const area = wrap.createEl("textarea", { cls: "claude-skill-textarea" });
    area.value = text;
    area.spellcheck = false;
    const bar = wrap.createDiv({ cls: "claude-skill-editor-bar" });
    const status = bar.createSpan({ cls: "claude-skill-editor-status" });

    const save = async () => {
      try {
        fs.writeFileSync(this.file, area.value, "utf8");
        status.setText("Saved");
        this.plugin.loadSkills();
        this.plugin.refreshViews();
      } catch (err) {
        new Notice(`Could not save: ${err.message}`);
      }
    };
    area.addEventListener("input", () => status.setText("Unsaved changes"));
    area.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    });

    const cancel = bar.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.editing = false;
      this.render();
    });
    const saveBtn = bar.createEl("button", { cls: "mod-cta", text: "Save (Ctrl+S)" });
    saveBtn.addEventListener("click", async () => {
      await save();
      this.editing = false;
      this.render();
    });
    setTimeout(() => area.focus(), 0);
  }

  // Relative links in the markdown (e.g. references/guide.md) open inside this view
  wireLinks(container) {
    const baseDir = path.dirname(this.file);
    container.querySelectorAll("a").forEach((a) => {
      const href = a.getAttribute("data-href") || a.getAttribute("href") || "";
      if (!href || /^(https?:|mailto:|#)/i.test(href)) return;
      const target = path.resolve(baseDir, decodeURI(href.split("#")[0]));
      if (!fs.existsSync(target)) return;
      a.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.openRelated(target);
        },
        true
      );
    });
  }

  openRelated(file) {
    if (TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) this.show(file);
    else window.require("electron").shell.openPath(file);
  }

  async show(file) {
    await this.leaf.setViewState({
      type: DETAIL_VIEW_TYPE,
      active: true,
      state: { file, skillFile: this.skillFile },
    });
  }

  iconButton(parent, icon, label, onClick) {
    const b = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
    setIcon(b, icon);
    b.addEventListener("click", onClick);
    return b;
  }
}

// ---------- Arguments modal ----------

class ArgsModal extends Modal {
  constructor(app, skill, invocation, onSubmit, initialValue = "") {
    super(app);
    this.skill = skill;
    this.invocation = invocation;
    this.onSubmit = onSubmit;
    this.initialValue = initialValue;
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(`Run /${this.invocation}`);
    if (this.skill.description) contentEl.createEl("p", { cls: "claude-skills-modal-desc", text: this.skill.description });

    let value = this.initialValue;
    const submit = () => {
      this.close();
      this.onSubmit(value.trim());
    };

    new Setting(contentEl)
      .setName("Arguments (optional)")
      .setDesc(this.skill.argumentHint || "E.g. a Jira key or a file path. Leave empty to run without arguments.")
      .addText((t) => {
        t.setPlaceholder(this.skill.argumentHint || "PRODISCO-42");
        t.setValue(value);
        t.onChange((v) => (value = v));
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        });
        setTimeout(() => t.inputEl.focus(), 0);
      });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Run").setCta().onClick(submit));
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---------- Plugin ----------

class ClaudeSkillsPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.loadSkills();

    this.registerView(VIEW_TYPE, (leaf) => new SkillsView(leaf, this));
    this.registerView(DETAIL_VIEW_TYPE, (leaf) => new SkillDetailView(leaf, this));

    this.addRibbonIcon("sparkles", "Claude Skills", () => this.activateView());

    this.addCommand({
      id: "open-skills-panel",
      name: "Open skills panel",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "run-skill",
      name: "Run skill…",
      callback: () => new SkillSuggestModal(this.app, this).open(),
    });

    this.addCommand({
      id: "reload-skills",
      name: "Reload skills list",
      callback: () => {
        this.loadSkills();
        this.refreshViews();
        new Notice(`${this.skills.length} skills found`);
      },
    });

    this.addSettingTab(new ClaudeSkillsSettingTab(this.app, this));
    this.setupKanban();
  }

  onunload() {
    this.teardownKanban();
  }

  vaultPath() {
    const a = this.app.vault.adapter;
    return a instanceof FileSystemAdapter ? a.getBasePath() : null;
  }

  loadSkills() {
    const vault = this.vaultPath();
    const home = path.join(os.homedir(), ".claude");
    const skills = [];

    if (vault) {
      skills.push(...scanSkillsDir(path.join(vault, ".claude", "skills"), "project"));
      skills.push(...scanCommandsDir(path.join(vault, ".claude", "commands")));
    }
    skills.push(...scanSkillsDir(path.join(home, "skills"), "personal"));
    skills.push(...scanCommandsDir(path.join(home, "commands")));
    if (this.settings.showPlugins) skills.push(...scanPlugins(home));

    for (const line of this.settings.extraFolders.split(/\r?\n/)) {
      const dir = line.trim();
      if (dir) skills.push(...scanSkillsDir(dir, "extra"));
    }

    // Remove duplicates (project takes precedence over personal)
    const seen = new Set();
    this.skills = skills.filter((s) => {
      const key = this.invocationName(s);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  invocationName(skill) {
    return skill.plugin ? `${skill.plugin}:${skill.name}` : skill.name;
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.render();
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  // Embedded terminal from the optional Open Terminal plugin (null when not installed/enabled)
  terminalPlugin() {
    if (this.settings.terminalMode === "external") return null;
    const t = this.app.plugins.plugins["open-terminal"];
    return t && typeof t.runInTerminal === "function" ? t : null;
  }

  runSkill(skill, initialArgs = "", { confirm } = {}) {
    const invocation = this.invocationName(skill);
    const run = (args) => this.runClaude(`/${invocation}${args ? " " + args : ""}`);
    const ask = confirm === undefined ? this.settings.askArgs : confirm;
    if (ask) new ArgsModal(this.app, skill, invocation, run, initialArgs).open();
    else run(initialArgs);
  }

  findSkill(name) {
    return this.skills.find((s) => this.invocationName(s) === name || s.name === name) || null;
  }

  // ---------- Kanban card buttons ----------

  kanbanSkills() {
    return this.settings.kanbanSkills
      .split(/[\n,]/)
      .map((s) => s.trim().replace(/^\//, ""))
      .filter(Boolean)
      .map((name) => this.findSkill(name))
      .filter(Boolean);
  }

  setupKanban() {
    this.kanbanObservers = new Map();
    const sync = () => {
      const leaves = this.app.workspace.getLeavesOfType("kanban");
      const alive = new Set();
      for (const leaf of leaves) {
        const el = leaf.view.containerEl;
        alive.add(el);
        if (!this.kanbanObservers.has(el)) {
          let scheduled = false;
          const obs = new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
              scheduled = false;
              this.decorateKanban(el);
            });
          });
          obs.observe(el, { childList: true, subtree: true });
          this.kanbanObservers.set(el, obs);
        }
        this.decorateKanban(el);
      }
      for (const [el, obs] of this.kanbanObservers) {
        if (!alive.has(el)) {
          obs.disconnect();
          this.kanbanObservers.delete(el);
        }
      }
    };
    this.syncKanban = sync;
    this.registerEvent(this.app.workspace.on("layout-change", sync));
    this.registerEvent(this.app.workspace.on("active-leaf-change", sync));
    this.app.workspace.onLayoutReady(sync);
  }

  teardownKanban() {
    if (this.kanbanObservers) for (const obs of this.kanbanObservers.values()) obs.disconnect();
    document.querySelectorAll(".claude-skills-kanban-btn").forEach((b) => b.remove());
  }

  // Extract the Jira key from the card (/browse/KEY link or "KEY-123" text)
  cardIssueKey(item) {
    for (const a of item.querySelectorAll("a[href]")) {
      const m = a.getAttribute("href").match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/);
      if (m) return m[1];
    }
    const m = (item.textContent || "").match(/\b([A-Z][A-Z0-9_]+-\d+)\b/);
    return m ? m[1] : null;
  }

  decorateKanban(root) {
    if (!this.settings.kanbanEnabled) return;
    const skills = this.kanbanSkills();
    if (!skills.length) return;

    for (const item of root.querySelectorAll(".kanban-plugin__item")) {
      const wrapper = item.querySelector(".kanban-plugin__item-postfix-button-wrapper");
      if (!wrapper) continue;
      const key = this.cardIssueKey(item);
      let btn = wrapper.querySelector(".claude-skills-kanban-btn");

      if (!key) {
        if (btn) btn.remove();
        continue;
      }
      if (btn && btn.dataset.key === key && btn.dataset.skills === this.settings.kanbanSkills) continue;
      if (btn) btn.remove();

      btn = createEl("a", {
        cls: "claude-skills-kanban-btn kanban-plugin__item-postfix-button clickable-icon",
        attr: {
          "data-ignore-drag": "true",
          "aria-label": skills.length === 1 ? `/${this.invocationName(skills[0])} ${key}` : `Claude skills for ${key}`,
        },
      });
      btn.dataset.key = key;
      btn.dataset.skills = this.settings.kanbanSkills;
      setIcon(btn, skills.length === 1 ? "play" : "sparkles");

      // Keep the click from starting a drag or opening the card editor
      for (const ev of ["pointerdown", "mousedown", "dblclick"]) btn.addEventListener(ev, (e) => e.stopPropagation());
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (skills.length === 1) {
          this.runSkill(skills[0], key, { confirm: this.settings.kanbanConfirm });
          return;
        }
        const menu = new Menu();
        for (const skill of skills) {
          menu.addItem((mi) =>
            mi
              .setTitle(`/${this.invocationName(skill)} ${key}`)
              .setIcon("play")
              .onClick(() => this.runSkill(skill, key, { confirm: this.settings.kanbanConfirm }))
          );
        }
        menu.showAtMouseEvent(e);
      });

      wrapper.prepend(btn);
    }
  }

  // Detect the Claude Code UI in the last terminal lines (also catches sessions started manually)
  looksLikeClaude(view) {
    const term = view.term;
    if (!term) return false;
    const b = term.buffer.active;
    const end = b.baseY + b.cursorY + 4;
    const lines = [];
    for (let i = Math.max(0, end - 12); i <= end && i < b.length; i++) {
      const l = b.getLine(i);
      if (l) lines.push(l.translateToString(true));
    }
    const text = lines.join("\n");
    return (
      /\? for shortcuts|esc to interrupt|shift\+tab to cycle|⏵⏵/.test(text) ||
      (/^\s*[❯>]\s*$/m.test(text) && /─{10,}/.test(text))
    );
  }

  claudeArgs() {
    const parts = [this.settings.claudeCommand.trim() || "claude"];
    if (this.settings.extraArgs.trim()) parts.push(this.settings.extraArgs.trim());
    return parts;
  }

  async runClaude(prompt) {
    const terminal = this.terminalPlugin();
    if (!terminal) {
      this.runExternal(prompt);
      return;
    }
    if (!this.claudeTerminals) this.claudeTerminals = new WeakSet();

    const reuse = this.settings.reuseTerminal && typeof terminal.getTerminals === "function";
    if (reuse) {
      // 1) A Claude session is already open: send the prompt straight into it
      const session = terminal
        .getTerminals()
        .find((v) => v.isAlive() && !v.isAtPrompt() && (this.claudeTerminals.has(v) || this.looksLikeClaude(v)));
      if (session) {
        session.reveal();
        if (prompt) session.sendText(prompt);
        return;
      }
    }

    // 2) A terminal is idle at the prompt: run claude there. 3) Otherwise open a new one.
    const parts = this.claudeArgs();
    if (prompt) parts.push(terminal.quoteArg(prompt));
    const view = await terminal.runInTerminal(parts.join(" "), { cwd: this.vaultPath(), reuse });
    if (view) this.claudeTerminals.add(view);
  }

  // Fallback without Open Terminal: run claude in a separate system terminal window
  runExternal(prompt) {
    const cwd = this.vaultPath();
    const parts = this.claudeArgs();
    const onError = (err) => new Notice(`Could not open a terminal: ${err.message}`);

    if (process.platform === "win32") {
      // -EncodedCommand (UTF-16LE base64) avoids every quoting problem with spaces, quotes and $
      if (prompt) parts.push("'" + prompt.replace(/'/g, "''") + "'");
      const encoded = Buffer.from(parts.join(" "), "utf16le").toString("base64");
      const psArgs = ["powershell.exe", "-NoExit", "-NoLogo", "-EncodedCommand", encoded];
      this.spawnDetached("wt.exe", ["-d", cwd, ...psArgs], { cwd }, () =>
        // Windows Terminal not installed: plain PowerShell console window
        this.spawnDetached("cmd.exe", ["/c", "start", '""', ...psArgs], { cwd, windowsVerbatimArguments: true }, onError)
      );
      return;
    }

    const sh = (a) => "'" + String(a).replace(/'/g, "'\\''") + "'";
    if (prompt) parts.push(sh(prompt));
    const line = `cd ${sh(cwd)} && ${parts.join(" ")}`;
    if (process.platform === "darwin") {
      const script = `tell application "Terminal" to do script ${JSON.stringify(line)}\ntell application "Terminal" to activate`;
      this.spawnDetached("osascript", ["-e", script], { cwd }, onError);
    } else {
      this.spawnDetached("x-terminal-emulator", ["-e", "bash", "-lc", `${line}; exec bash`], { cwd }, onError);
    }
  }

  spawnDetached(command, args, options, onError) {
    const { spawn } = require("child_process");
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore", ...options });
      child.on("error", onError);
      child.unref();
    } catch (err) {
      onError(err);
    }
  }

  // Open the skill details in an Obsidian tab (reuses the tab if already open)
  async openSkillFile(skill) {
    const { workspace } = this.app;
    const existing = workspace
      .getLeavesOfType(DETAIL_VIEW_TYPE)
      .find((l) => l.view.skillFile === skill.file);
    const leaf = existing || workspace.getLeaf("tab");
    await leaf.setViewState({
      type: DETAIL_VIEW_TYPE,
      active: true,
      state: { file: skill.file, skillFile: skill.file },
    });
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.collapsed = this.settings.collapsed || {};
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// Quick picker (Ctrl+P → "Run skill…")
const { FuzzySuggestModal } = require("obsidian");

class SkillSuggestModal extends FuzzySuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Pick a skill to run");
  }

  getItems() {
    return this.plugin.skills;
  }

  getItemText(skill) {
    return `/${this.plugin.invocationName(skill)} — ${skill.description}`;
  }

  onChooseItem(skill) {
    this.plugin.runSkill(skill);
  }
}

// ---------- Settings ----------

class ClaudeSkillsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = async (reload) => {
      await this.plugin.saveSettings();
      if (reload) {
        this.plugin.loadSkills();
        this.plugin.refreshViews();
      }
    };

    new Setting(containerEl)
      .setName("Claude command")
      .setDesc("Claude Code CLI executable.")
      .addText((t) => t.setValue(s.claudeCommand).onChange(async (v) => ((s.claudeCommand = v), await save())));

    new Setting(containerEl)
      .setName("Extra arguments")
      .setDesc("Added before the prompt. E.g. --permission-mode acceptEdits  or  --model opus")
      .addText((t) => t.setValue(s.extraArgs).onChange(async (v) => ((s.extraArgs = v), await save())));

    new Setting(containerEl)
      .setName("Ask for arguments before running")
      .setDesc("Shows a box to type arguments (e.g. a Jira key).")
      .addToggle((t) => t.setValue(s.askArgs).onChange(async (v) => ((s.askArgs = v), await save())));

    const hasEmbedded = !!this.app.plugins.plugins["open-terminal"];
    new Setting(containerEl)
      .setName("Where to run")
      .setDesc(
        hasEmbedded
          ? "Open Terminal detected: skills can run in the embedded terminal."
          : "Open Terminal plugin not found: skills run in an external terminal window (Windows Terminal or PowerShell)."
      )
      .addDropdown((dd) =>
        dd
          .addOption("auto", "Embedded terminal when available")
          .addOption("external", "Always an external window")
          .setValue(s.terminalMode)
          .onChange(async (v) => ((s.terminalMode = v), await save()))
      );

    new Setting(containerEl)
      .setName("Reuse open terminal")
      .setDesc(
        "Requires the Open Terminal plugin. If a Claude session is already open, the skill is sent to it; if a terminal is idle at the prompt, it runs there. A new terminal opens only when none is available."
      )
      .addToggle((t) => t.setValue(s.reuseTerminal).onChange(async (v) => ((s.reuseTerminal = v), await save())));

    new Setting(containerEl)
      .setName("Show plugin skills")
      .setDesc("Include skills from plugins installed in ~/.claude/plugins/cache.")
      .addToggle((t) => t.setValue(s.showPlugins).onChange(async (v) => ((s.showPlugins = v), await save(true))));

    new Setting(containerEl)
      .setName("Additional folders")
      .setDesc("Other folders containing subfolders with a SKILL.md (one per line).")
      .addTextArea((t) => t.setValue(s.extraFolders).onChange(async (v) => ((s.extraFolders = v), await save(true))));

    containerEl.createEl("h3", { text: "Kanban cards" });

    const refreshKanban = () => {
      this.plugin.teardownKanban();
      this.plugin.setupKanban();
    };

    new Setting(containerEl)
      .setName("Button on cards")
      .setDesc("Adds a ▶ button to Kanban cards that contain a Jira key (e.g. CI-287).")
      .addToggle((t) =>
        t.setValue(s.kanbanEnabled).onChange(async (v) => {
          s.kanbanEnabled = v;
          await save();
          refreshKanban();
        })
      );

    new Setting(containerEl)
      .setName("Skills on cards")
      .setDesc("Comma-separated skill names. With one skill the button runs it directly; with several it opens a menu.")
      .addText((t) =>
        t
          .setPlaceholder("test-plan, zephyr-test-cases")
          .setValue(s.kanbanSkills)
          .onChange(async (v) => {
            s.kanbanSkills = v;
            await save();
            refreshKanban();
          })
      );

    new Setting(containerEl)
      .setName("Confirm before running")
      .setDesc("Shows the arguments box pre-filled with the card's key.")
      .addToggle((t) => t.setValue(s.kanbanConfirm).onChange(async (v) => ((s.kanbanConfirm = v), await save())));
  }
}

module.exports = ClaudeSkillsPlugin;
