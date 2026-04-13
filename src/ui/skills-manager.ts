import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rename as renamePath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getMarkdownTheme, parseFrontmatter, stripFrontmatter, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	Container,
	type Component,
	Editor,
	type Focusable,
	Input,
	Key,
	Markdown,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { normalizeSkillName, type SkillCreationAnswers, type SkillLocation } from "../create-skill.js";
import { isDeletableSkill } from "../delete-skill.js";
import type { SkillEntry, SkillRegistry } from "../types.js";

interface SkillsManagerOptions {
	onCreate: (answers: SkillCreationAnswers, signal?: AbortSignal) => Promise<SkillEntry | null>;
	onDelete: (skill: SkillEntry) => Promise<boolean>;
	onToggle: (skill: SkillEntry, enabled: boolean) => Promise<void>;
	onRefresh: () => Promise<SkillRegistry>;
}

interface ParsedSkillDocument {
	name: string;
	description: string;
	frontmatter: Record<string, unknown>;
	content: string;
	raw: string;
}

type MessageTone = "dim" | "success" | "error";
type Mode = "browse" | "create" | "preview" | "edit" | "rename" | "delete-confirm" | "generating";
type CreateTextStepId = "name" | "description";
type CreateChoiceStepId = "location";
type CreateTextStep = { id: CreateTextStepId; title: string; hint: string; optional: boolean; kind: "text" };
type CreateChoiceOption = { value: SkillLocation; label: string; description: string };
type CreateChoiceStep = { id: CreateChoiceStepId; title: string; hint: string; optional: boolean; kind: "choice"; options: CreateChoiceOption[] };
type CreateStep = CreateTextStep | CreateChoiceStep;

const LOCATION_OPTIONS: CreateChoiceOption[] = [
	{ value: "global", label: "Global", description: "Save in your user-level Pi skills directory." },
	{ value: "project", label: "Project", description: "Save in this project's .pi/skills directory." },
];

const CREATE_STEPS: CreateStep[] = [
	{ id: "name", title: "Name", hint: "Use lowercase letters, numbers, and hyphens, for example react-review.", optional: false, kind: "text" },
	{ id: "description", title: "Description", hint: "Describe what the skill does and when it should be used in one clear sentence.", optional: false, kind: "text" },
	{ id: "location", title: "Visibility", hint: "Choose whether the skill is available only in this project or in all your Pi sessions.", optional: false, kind: "choice", options: LOCATION_OPTIONS },
];

function getScopeLabel(skill: SkillEntry): string {
	if (skill.scope === "project") return "project";
	if (skill.scope === "user") return "global";
	return "local";
}

function getPackageLabel(skill: SkillEntry): string | undefined {
	return skill.origin === "package" && skill.source ? skill.source : undefined;
}

function getSkillLocation(skill: SkillEntry): string {
	return skill.origin === "package" ? skill.source : skill.path;
}

function getSkillLocationLabel(skill: SkillEntry): string {
	return skill.origin === "package" ? "package • " : "";
}

function formatScalar(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null) return "null";
	return JSON.stringify(value);
}

function formatYamlValue(key: string, value: unknown, indent = ""): string[] {
	if (typeof value === "string" && value.includes("\n")) {
		return [`${indent}${key}: |`, ...value.split("\n").map((line) => `${indent}  ${line}`)];
	}

	if (Array.isArray(value)) {
		if (value.length === 0) return [`${indent}${key}: []`];
		return [
			`${indent}${key}:`,
			...value.flatMap((item) => {
				if (item && typeof item === "object") {
					return [
						`${indent}  -`,
						...Object.entries(item as Record<string, unknown>).flatMap(([nestedKey, nestedValue]) =>
							formatYamlValue(nestedKey, nestedValue, `${indent}    `),
						),
					];
				}
				return [`${indent}  - ${formatScalar(item)}`];
			}),
		];
	}

	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) return [`${indent}${key}: {}`];
		return [
			`${indent}${key}:`,
			...entries.flatMap(([nestedKey, nestedValue]) => formatYamlValue(nestedKey, nestedValue, `${indent}  `)),
		];
	}

	return [`${indent}${key}: ${formatScalar(value)}`];
}

function buildFrontmatterBlock(skill: SkillEntry): string {
	const frontmatter = skill.frontmatter ?? { name: skill.name, description: skill.description };
	const lines = Object.entries(frontmatter).flatMap(([key, value]) => formatYamlValue(key, value));
	return ["---", ...lines, "---"].join("\n");
}

function buildSkillDocument(skill: SkillEntry): string {
	const frontmatter = buildFrontmatterBlock(skill);
	const content = skill.content.trim();
	return content ? `${frontmatter}\n\n${content}\n` : `${frontmatter}\n`;
}

function buildEditableSkillDocument(skill: SkillEntry, raw?: string): string {
	const source = raw ?? buildSkillDocument(skill);
	const parsed = parseFrontmatter<Record<string, unknown>>(source);
	const frontmatter = { ...parsed.frontmatter };
	delete frontmatter.name;
	const editableBlock = ["---", ...Object.entries(frontmatter).flatMap(([key, value]) => formatYamlValue(key, value)), "---"].join("\n");
	const content = stripFrontmatter(source).trim();
	return content ? `${editableBlock}\n\n${content}\n` : `${editableBlock}\n`;
}

function readSkillDocument(skill: SkillEntry): string {
	try {
		return readFileSync(skill.path, "utf8");
	} catch {
		return buildSkillDocument(skill);
	}
}

function parseSkillDocument(raw: string, expectedName: string): ParsedSkillDocument {
	const parsed = parseFrontmatter<Record<string, unknown>>(raw);
	const name = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name.trim() : "";
	const description = typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description.trim() : "";

	if (!name || !description) throw new Error("Skill must include frontmatter fields 'name' and 'description'");
	if (name !== expectedName) throw new Error(`Frontmatter name must stay '${expectedName}'`);

	return {
		name,
		description,
		frontmatter: Object.fromEntries(Object.entries(parsed.frontmatter).filter(([, value]) => value !== undefined)),
		content: stripFrontmatter(raw).trim(),
		raw: raw.trim() + "\n",
	};
}

function parseEditableSkillDocument(raw: string, expectedName: string): ParsedSkillDocument {
	const parsed = parseFrontmatter<Record<string, unknown>>(raw);
	if (typeof parsed.frontmatter.name === "string") {
		throw new Error("Name is immutable here. Use Rename instead.");
	}
	const frontmatter: Record<string, unknown> = {
		name: expectedName,
		...Object.fromEntries(Object.entries(parsed.frontmatter).filter(([, value]) => value !== undefined)),
	};
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!description) throw new Error("Skill must include frontmatter field 'description'");
	const content = stripFrontmatter(raw).trim();
	const fullRaw = content
		? `${["---", ...Object.entries(frontmatter).flatMap(([key, value]) => formatYamlValue(key, value)), "---"].join("\n")}\n\n${content}\n`
		: `${["---", ...Object.entries(frontmatter).flatMap(([key, value]) => formatYamlValue(key, value)), "---"].join("\n")}\n`;
	return {
		name: expectedName,
		description,
		frontmatter,
		content,
		raw: fullRaw,
	};
}

function getToneText(theme: ExtensionContext["ui"]["theme"], tone: MessageTone, text: string): string {
	if (tone === "error") return theme.fg("error", text);
	if (tone === "success") return theme.fg("success", text);
	return theme.fg("dim", text);
}

function createFrameLine(theme: ExtensionContext["ui"]["theme"], line: string, innerWidth: number): string {
	const pad = Math.max(0, innerWidth - visibleWidth(line));
	return `${theme.fg("accent", "│ ")}${line}${" ".repeat(pad)}${theme.fg("accent", " │")}`;
}

function centerRenderedLines(lines: string[], width: number): string[] {
	const renderedWidth = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	const leftPad = Math.max(0, Math.floor((width - renderedWidth) / 2));
	if (leftPad === 0) return lines;
	const prefix = " ".repeat(leftPad);
	return lines.map((line) => `${prefix}${line}`);
}

function renderCenteredDialog(
	theme: ExtensionContext["ui"]["theme"],
	width: number,
	lines: string[],
	maxInnerWidth = 64,
): string[] {
	const innerWidth = Math.max(20, Math.min(width - 4, maxInnerWidth));
	const ellipsis = theme.fg("dim", "...");
	const top = theme.fg("accent", `┌${"─".repeat(innerWidth + 2)}┐`);
	const bottom = theme.fg("accent", `└${"─".repeat(innerWidth + 2)}┘`);
	return centerRenderedLines(
		[top, ...lines.map((line) => createFrameLine(theme, truncateToWidth(line, innerWidth, ellipsis), innerWidth)), bottom],
		width,
	);
}

function renderFramedPanel(
	theme: ExtensionContext["ui"]["theme"],
	width: number,
	lines: string[],
): string[] {
	const innerWidth = Math.max(20, width - 4);
	const ellipsis = theme.fg("dim", "...");
	const top = theme.fg("accent", `┌${"─".repeat(innerWidth + 2)}┐`);
	const bottom = theme.fg("accent", `└${"─".repeat(innerWidth + 2)}┘`);
	return [
		top,
		...lines.map((line) => createFrameLine(theme, truncateToWidth(line, innerWidth, ellipsis), innerWidth)),
		bottom,
	];
}

function getEditorTheme(theme: ExtensionContext["ui"]["theme"]) {
	return {
		borderColor: (text: string) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.bg("selectedBg", theme.fg("text", text)),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		},
	};
}

class SingleLineText implements Component {
	constructor(
		private readonly text: string,
		private readonly ellipsis = "...",
	) {}

	render(width: number): string[] {
		return [truncateToWidth(this.text, width, this.ellipsis)];
	}

	invalidate(): void {}
}

class PrefixedEditor implements Component {
	constructor(
		private readonly editor: Editor,
		private readonly prefix = "> ",
	) {}

	render(width: number): string[] {
		const editorWidth = Math.max(1, width - this.prefix.length);
		const rendered = this.editor.render(editorWidth);
		const lines = rendered.length >= 2 ? rendered.slice(1, -1) : rendered;
		if (lines.length === 0) return [this.prefix];
		return lines.map((line, index) => `${index === 0 ? this.prefix : "  "}${line}`);
	}

	invalidate(): void {
		this.editor.invalidate();
	}
}

class ScrollableSkillPreview implements Component {
	private scrollOffset = 0;
	private lastInnerWidth = 1;
	private lastContentLines: string[] = [];

	constructor(
		private skill: SkillEntry,
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly getTerminalRows: () => number,
	) {}

	setSkill(skill: SkillEntry): void {
		this.skill = skill;
		this.scrollOffset = 0;
		this.lastContentLines = [];
	}

	invalidate(): void {}

	private getInnerWidth(width: number): number {
		return Math.max(1, width - 4);
	}

	private getMaxHeight(): number {
		return Math.max(10, Math.floor(this.getTerminalRows() * 0.78));
	}

	private buildContentLines(innerWidth: number): string[] {
		const content = new Container();
		const separator = this.theme.fg("muted", " • ");
		const scope = this.theme.fg("muted", getScopeLabel(this.skill));
		const location = this.theme.fg("muted", `${getSkillLocationLabel(this.skill)}${getSkillLocation(this.skill)}`);
		const status = this.skill.enabled ? this.theme.fg("success", "enabled") : this.theme.fg("warning", "disabled");
		content.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.skill.name)), 0, 0));
		content.addChild(new Text(`${scope}${separator}${location}${separator}${status}`, 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(this.theme.fg("muted", this.theme.bold("Metadata")), 0, 0));
		content.addChild(new Text(this.theme.fg("dim", buildFrontmatterBlock(this.skill)), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(this.theme.fg("muted", this.theme.bold("Content")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Markdown(this.skill.content, 0, 0, getMarkdownTheme()));
		const lines = content.render(innerWidth);
		this.lastInnerWidth = innerWidth;
		this.lastContentLines = lines;
		return lines;
	}

	private buildFooter(innerWidth: number, visibleHeight: number, totalLines: number): string {
		const maxScroll = Math.max(0, totalLines - visibleHeight);
		const scrollInfo = maxScroll > 0
			? ` • ${this.scrollOffset + 1}-${Math.min(totalLines, this.scrollOffset + visibleHeight)}/${totalLines}`
			: "";
		const editInfo = isDeletableSkill(this.skill) ? " • e edit • r rename • backspace delete" : "";
		const insertInfo = this.skill.enabled ? " • enter insert" : "";
		return truncateToWidth(
			this.theme.fg("dim", `↑/↓ scroll${insertInfo} • ctrl+x enable/disable${editInfo} • esc back${scrollInfo}`),
			innerWidth,
			this.theme.fg("dim", "..."),
		);
	}

	render(width: number): string[] {
		const innerWidth = this.getInnerWidth(width);
		const maxHeight = this.getMaxHeight();
		const visibleHeight = Math.max(1, maxHeight - 3);
		const contentLines = this.buildContentLines(innerWidth);
		const maxScroll = Math.max(0, contentLines.length - visibleHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visibleLines = contentLines.slice(this.scrollOffset, this.scrollOffset + visibleHeight);
		const top = this.theme.fg("accent", `┌${"─".repeat(innerWidth + 2)}┐`);
		const bottom = this.theme.fg("accent", `└${"─".repeat(innerWidth + 2)}┘`);

		return [
			top,
			...visibleLines.map((line) => createFrameLine(this.theme, line, innerWidth)),
			createFrameLine(this.theme, this.buildFooter(innerWidth, visibleHeight, contentLines.length), innerWidth),
			bottom,
		];
	}

	handleInput(data: string): void {
		const maxHeight = this.getMaxHeight();
		const visibleHeight = Math.max(1, maxHeight - 3);
		const totalLines = this.lastContentLines.length || this.buildContentLines(this.lastInnerWidth).length;
		const maxScroll = Math.max(0, totalLines - visibleHeight);

		if (matchesKey(data, Key.up)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - visibleHeight);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + visibleHeight);
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.scrollOffset = 0;
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.scrollOffset = maxScroll;
		}
	}
}

class SkillEditorView implements Component, Focusable {
	private readonly editor: Editor;
	private readonly initialText: string;
	private readonly proxyTui: TUI;
	private readonly realTui: TUI;
	private virtualRows = 24;
	private _focused = false;
	private message: { text: string; tone: MessageTone } | undefined;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		private skill: SkillEntry,
		private readonly theme: ExtensionContext["ui"]["theme"],
		tui: TUI,
		initialText: string,
		private readonly onSave: (value: string) => void,
		private readonly onCancel: () => void,
	) {
		this.initialText = initialText;
		this.realTui = tui;
		const self = this;
		this.proxyTui = {
			requestRender: () => tui.requestRender(),
			get terminal() {
				return { ...tui.terminal, rows: Math.max(1, self.virtualRows) };
			},
		} as TUI;
		this.editor = new Editor(this.proxyTui, getEditorTheme(theme), { autocompleteMaxVisible: 6 });
		this.editor.setText(initialText);
	}

	setSkill(skill: SkillEntry): void {
		this.skill = skill;
	}

	setMessage(text: string, tone: MessageTone): void {
		this.message = { text, tone };
	}

	isDirty(): boolean {
		return this.editor.getText() !== this.initialText;
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	private getTargetHeight(realRows: number): number {
		return Math.max(10, Math.floor(realRows * 0.78));
	}

	private getRowsForVisibleEditorLines(targetVisibleLines: number): number {
		let rows = 5;
		while (Math.max(5, Math.floor(rows * 0.3)) < targetVisibleLines && rows < 1000) rows += 1;
		return rows;
	}

	render(width: number): string[] {
		const innerWidth = Math.max(20, width - 4);
		const top = this.theme.fg("accent", `┌${"─".repeat(innerWidth + 2)}┐`);
		const bottom = this.theme.fg("accent", `└${"─".repeat(innerWidth + 2)}┘`);
		const lines: string[] = [
			this.theme.fg("accent", this.theme.bold(`Edit ${this.skill.name}`)),
			this.theme.fg("muted", getSkillLocation(this.skill)),
			this.theme.fg("dim", `Name is immutable here: ${this.skill.name}`),
		];

		if (this.message) {
			lines.push("");
			lines.push(getToneText(this.theme, this.message.tone, this.message.text));
		}

		const targetHeight = this.getTargetHeight(this.realTui.terminal.rows);
		const targetInnerLines = Math.max(1, targetHeight - 2);
		const staticLineCount = lines.length + 1 + 1 + 1;
		const editorBlockLines = Math.max(7, targetInnerLines - staticLineCount);
		const targetVisibleEditorLines = Math.max(5, editorBlockLines - 2);
		this.virtualRows = this.getRowsForVisibleEditorLines(targetVisibleEditorLines);

		lines.push("");
		lines.push(...this.editor.render(innerWidth));
		lines.push("");
		lines.push(truncateToWidth(this.theme.fg("dim", "ctrl+s save • esc back"), innerWidth, this.theme.fg("dim", "...")));

		while (lines.length < targetInnerLines) {
			lines.splice(Math.max(0, lines.length - 1), 0, "");
		}

		return [top, ...lines.slice(0, targetInnerLines).map((line) => createFrameLine(this.theme, line, innerWidth)), bottom];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.onCancel();
			return;
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			this.onSave(this.editor.getText());
			return;
		}
		if (this.message?.tone === "error") {
			this.message = undefined;
		}
		this.editor.handleInput(data);
	}
}

async function renameSkillEntry(ctx: ExtensionContext, skill: SkillEntry, entered: string): Promise<SkillEntry | null> {
	if (!isDeletableSkill(skill)) {
		ctx.ui.notify("Only your own project and global skills can be renamed", "warning");
		return null;
	}

	const normalizedName = normalizeSkillName(entered);
	if (!normalizedName) throw new Error("Name must contain letters, numbers, or hyphens");
	if (normalizedName === skill.name) {
		ctx.ui.notify("Skill name unchanged", "info");
		return skill;
	}

	const currentDir = dirname(skill.path);
	const parentDir = dirname(currentDir);
	const targetDir = join(parentDir, normalizedName);
	const targetPath = join(targetDir, "SKILL.md");
	if (existsSync(targetDir) || existsSync(targetPath)) throw new Error(`Skill already exists: ${normalizedName}`);

	const currentRaw = readFileSync(skill.path, "utf8");
	const parsedCurrent = parseSkillDocument(currentRaw, skill.name);
	const renamedFrontmatter = { ...parsedCurrent.frontmatter, name: normalizedName };
	const updatedRaw = parsedCurrent.content
		? `${["---", ...Object.entries(renamedFrontmatter).flatMap(([key, value]) => formatYamlValue(key, value)), "---"].join("\n")}\n\n${parsedCurrent.content}\n`
		: `${["---", ...Object.entries(renamedFrontmatter).flatMap(([key, value]) => formatYamlValue(key, value)), "---"].join("\n")}\n`;

	await renamePath(currentDir, targetDir);
	writeFileSync(targetPath, updatedRaw, "utf8");

	const renamedSkill: SkillEntry = {
		...skill,
		name: normalizedName,
		path: targetPath,
		frontmatter: renamedFrontmatter,
		baseDir: targetDir,
	};
	ctx.ui.notify(`Renamed skill: ${skill.name} → ${normalizedName}`, "info");
	return renamedSkill;
}

class SkillsManagerDialog implements Focusable {
	private mode: Mode = "browse";
	private _focused = false;
	private registry: SkillRegistry;
	private filteredSkills: SkillEntry[] = [];
	private selectedIndex: number;
	private browseQuery: string;
	private readonly browseInput = new Input();
	private readonly descriptionEditor: Editor;
	private readonly renameInput = new Input();
	private createStepIndex = 0;
	private createValues: Record<CreateTextStepId, string> = { name: "", description: "" };
	private createLocation: SkillLocation = "global";
	private submittedDescriptionValue: string | undefined;
	private createError: string | undefined;
	private previewSkillPath: string | undefined;
	private preview: ScrollableSkillPreview | undefined;
	private editorView: SkillEditorView | undefined;
	private renameError: string | undefined;
	private deleteSkillPath: string | undefined;
	private deleteReturnMode: "browse" | "preview" = "browse";
	private generationAbortController: AbortController | undefined;
	private generationRunId = 0;

	constructor(
		private readonly ctx: ExtensionContext,
		registry: SkillRegistry,
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly tui: TUI,
		private readonly done: (skill: SkillEntry | null) => void,
		private readonly options: SkillsManagerOptions,
		private readonly requestRender: () => void,
		initialSelectedIndex = 0,
		initialQuery = "",
	) {
		this.registry = registry;
		this.selectedIndex = Math.max(0, initialSelectedIndex);
		this.browseQuery = initialQuery;
		this.browseInput.setValue(initialQuery);
		this.descriptionEditor = new Editor(tui, {
			borderColor: (text: string) => " ".repeat(text.length),
			selectList: {
				selectedPrefix: (text: string) => this.theme.fg("accent", text),
				selectedText: (text: string) => this.theme.bg("selectedBg", this.theme.fg("text", text)),
				description: (text: string) => this.theme.fg("muted", text),
				scrollInfo: (text: string) => this.theme.fg("dim", text),
				noMatch: (text: string) => this.theme.fg("warning", text),
			},
		});
		this.descriptionEditor.onSubmit = (text: string) => {
			this.submittedDescriptionValue = text;
			void this.advanceCreate();
		};
		this.renameInput.onSubmit = (value) => {
			void this.submitRename(value);
		};
		this.refreshBrowseList();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.syncFocus();
	}

	invalidate(): void {
		this.descriptionEditor.invalidate();
		this.renameInput.invalidate();
		this.preview?.invalidate();
		this.editorView?.invalidate();
	}

	private syncFocus(): void {
		this.browseInput.focused = this._focused && (this.mode === "browse" || (this.mode === "create" && this.currentCreateStep.id === "name"));
		this.descriptionEditor.focused = this._focused && this.mode === "create" && this.currentCreateStep.id === "description";
		this.renameInput.focused = this._focused && this.mode === "rename";
		if (this.editorView) this.editorView.focused = this._focused && this.mode === "edit";
	}

	private filterSkills(query: string): SkillEntry[] {
		const trimmed = query.trim().toLowerCase();
		const source = this.registry.allSkills;
		if (!trimmed) return source;
		const tokens = trimmed.split(/\s+/).filter(Boolean);
		return source.filter((skill) => tokens.every((token) => skill.name.toLowerCase().includes(token)));
	}

	private orderBrowseSkills(skills: SkillEntry[]): SkillEntry[] {
		const ownSkills = skills.filter((skill) => isDeletableSkill(skill));
		const otherSkills = skills.filter((skill) => !isDeletableSkill(skill));
		return [...ownSkills, ...otherSkills];
	}

	private refreshBrowseList(preferredPath?: string): void {
		const currentPath = preferredPath ?? this.getSelectedSkill()?.path;
		this.filteredSkills = this.orderBrowseSkills(this.filterSkills(this.browseQuery));
		const selectableCount = this.filteredSkills.length + 1;
		if (currentPath) {
			const nextIndex = this.filteredSkills.findIndex((skill) => skill.path === currentPath);
			if (nextIndex >= 0) {
				this.selectedIndex = nextIndex + 1;
				return;
			}
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, selectableCount - 1));
	}

	private getSelectedSkill(): SkillEntry | undefined {
		if (this.selectedIndex === 0) return undefined;
		return this.filteredSkills[this.selectedIndex - 1];
	}

	private getCurrentSkill(): SkillEntry | undefined {
		return this.previewSkillPath ? this.registry.allSkills.find((skill) => skill.path === this.previewSkillPath) : undefined;
	}

	private get currentCreateStep(): CreateStep {
		return CREATE_STEPS[this.createStepIndex]!;
	}

	private moveLocationSelection(delta: number): void {
		const currentIndex = LOCATION_OPTIONS.findIndex((option) => option.value === this.createLocation);
		const safeIndex = currentIndex === -1 ? 0 : currentIndex;
		const nextIndex = (safeIndex + delta + LOCATION_OPTIONS.length) % LOCATION_OPTIONS.length;
		this.createLocation = LOCATION_OPTIONS[nextIndex]!.value;
	}

	private enterCreateMode(): void {
		this.mode = "create";
		this.createStepIndex = 0;
		this.createError = undefined;
		this.syncCreateInput();
		this.syncFocus();
		this.requestRender();
	}

	private exitToBrowse(preferredPath?: string): void {
		this.mode = "browse";
		this.createError = undefined;
		this.renameError = undefined;
		this.previewSkillPath = undefined;
		this.preview = undefined;
		this.editorView = undefined;
		this.deleteSkillPath = undefined;
		this.browseInput.setValue(this.browseQuery);
		this.refreshBrowseList(preferredPath);
		this.syncFocus();
		this.requestRender();
	}

	private openPreview(skill: SkillEntry): void {
		this.previewSkillPath = skill.path;
		this.preview = new ScrollableSkillPreview(skill, this.theme, () => this.tui.terminal.rows);
		this.mode = "preview";
		this.syncFocus();
		this.requestRender();
	}

	private openDeleteConfirm(skill: SkillEntry, returnMode: "browse" | "preview"): void {
		this.deleteSkillPath = skill.path;
		this.deleteReturnMode = returnMode;
		this.mode = "delete-confirm";
		this.syncFocus();
		this.requestRender();
	}

	private openEditor(): void {
		const skill = this.getCurrentSkill();
		if (!skill || !isDeletableSkill(skill)) return;
		const initialText = buildEditableSkillDocument(skill, readSkillDocument(skill));
		this.editorView = new SkillEditorView(
			skill,
			this.theme,
			this.tui,
			initialText,
			(value) => this.saveEditedSkill(value),
			() => this.closeEditor(),
		);
		this.mode = "edit";
		this.syncFocus();
		this.requestRender();
	}

	private closeEditor(): void {
		this.editorView = undefined;
		this.mode = "preview";
		this.syncFocus();
		this.requestRender();
	}

	private openRenameDialog(): void {
		const skill = this.getCurrentSkill();
		if (!skill || !isDeletableSkill(skill)) return;
		this.renameError = undefined;
		this.renameInput.setValue(skill.name);
		this.mode = "rename";
		this.syncFocus();
		this.requestRender();
	}

	private closeRenameDialog(): void {
		this.renameError = undefined;
		this.mode = "preview";
		this.syncFocus();
		this.requestRender();
	}

	private syncCreateInput(): void {
		const step = this.currentCreateStep;
		if (step.id === "name") {
			this.browseInput.setValue(this.createValues.name);
			return;
		}
		if (step.id === "description") {
			this.submittedDescriptionValue = undefined;
			this.descriptionEditor.setText(this.createValues.description);
		}
	}

	private persistCreateInput(): void {
		const step = this.currentCreateStep;
		if (step.id === "name") {
			this.createValues.name = this.browseInput.getValue();
			return;
		}
		if (step.id === "description") {
			if (this.submittedDescriptionValue !== undefined) {
				this.createValues.description = this.submittedDescriptionValue;
				this.submittedDescriptionValue = undefined;
				return;
			}
			this.createValues.description = this.descriptionEditor.getText();
		}
	}

	private validateCreateStep(): boolean {
		this.persistCreateInput();
		const step = this.currentCreateStep;
		if (step.kind === "text" && !step.optional) {
			const value = this.createValues[step.id].trim();
			if (!value) {
				this.createError = `${step.title} is required.`;
				return false;
			}
			if (step.id === "name" && !normalizeSkillName(value)) {
				this.createError = "Name must contain letters, numbers, or hyphens.";
				return false;
			}
		}
		if (step.kind === "choice" && !LOCATION_OPTIONS.some((option) => option.value === this.createLocation)) {
			this.createError = `${step.title} is required.`;
			return false;
		}
		this.createError = undefined;
		return true;
	}

	private goToPreviousCreateStep(): void {
		this.persistCreateInput();
		if (this.createStepIndex === 0) return;
		this.createError = undefined;
		this.createStepIndex -= 1;
		this.syncCreateInput();
		this.syncFocus();
	}

	private async advanceCreate(): Promise<void> {
		if (!this.validateCreateStep()) return;
		if (this.createStepIndex >= CREATE_STEPS.length - 1) {
			await this.submitCreate();
			return;
		}
		this.createStepIndex += 1;
		this.syncCreateInput();
		this.syncFocus();
	}

	private async submitCreate(): Promise<void> {
		const name = normalizeSkillName(this.createValues.name);
		if (!name) {
			this.createStepIndex = 0;
			this.syncCreateInput();
			this.createError = "Name is required.";
			return;
		}
		if (!this.createValues.description.trim()) {
			this.createStepIndex = 1;
			this.syncCreateInput();
			this.createError = "Description is required.";
			return;
		}

		this.mode = "generating";
		const runId = ++this.generationRunId;
		const abortController = new AbortController();
		this.generationAbortController = abortController;
		this.syncFocus();
		this.requestRender();
		const createdSkill = await this.options.onCreate({
			name,
			description: this.createValues.description.trim(),
			allowedTools: [],
			location: this.createLocation,
		}, abortController.signal);
		if (this.generationRunId !== runId) {
			return;
		}
		this.generationAbortController = undefined;
		if (abortController.signal.aborted || !createdSkill) {
			this.mode = "create";
			this.syncFocus();
			this.requestRender();
			return;
		}
		await this.refreshRegistry(createdSkill.path);
		const created = this.registry.allSkills.find((skill) => skill.path === createdSkill.path) ?? createdSkill;
		this.openPreview(created);
		this.requestRender();
	}

	private async refreshRegistry(preferredPath?: string): Promise<void> {
		this.registry = await this.options.onRefresh();
		this.refreshBrowseList(preferredPath);
		if (this.previewSkillPath) {
			const current = this.registry.allSkills.find((skill) => skill.path === this.previewSkillPath);
			if (!current) {
				this.exitToBrowse(preferredPath);
				return;
			}
			this.preview?.setSkill(current);
			this.editorView?.setSkill(current);
		}
	}

	private async toggleSkill(skill: SkillEntry): Promise<void> {
		try {
			await this.options.onToggle(skill, !skill.enabled);
			await this.refreshRegistry(skill.path);
			this.requestRender();
			this.ctx.ui.notify(
				skill.enabled
					? `Disabled ${skill.name}. Run /reload to fully apply the change.`
					: `Enabled ${skill.name}. Run /reload to fully apply the change.`,
				"info",
			);
		} catch (error) {
			this.ctx.ui.notify(error instanceof Error ? error.message : "Failed to update skill visibility", "error");
			this.requestRender();
		}
	}

	private async confirmDelete(): Promise<void> {
		const skill = this.deleteSkillPath ? this.registry.allSkills.find((entry) => entry.path === this.deleteSkillPath) : undefined;
		if (!skill) {
			this.exitToBrowse();
			return;
		}
		const deleted = await this.options.onDelete(skill);
		if (!deleted) {
			this.mode = this.deleteReturnMode === "preview" ? "preview" : "browse";
			this.syncFocus();
			this.requestRender();
			return;
		}
		this.deleteSkillPath = undefined;
		this.previewSkillPath = undefined;
		this.preview = undefined;
		await this.refreshRegistry();
		this.exitToBrowse();
		this.requestRender();
	}

	private async submitRename(value: string): Promise<void> {
		const skill = this.getCurrentSkill();
		if (!skill) {
			this.exitToBrowse();
			return;
		}
		try {
			const renamed = await renameSkillEntry(this.ctx, skill, value);
			if (!renamed) {
				this.closeRenameDialog();
				return;
			}
			this.previewSkillPath = renamed.path;
			await this.refreshRegistry(renamed.path);
			const current = this.registry.allSkills.find((entry) => entry.path === renamed.path) ?? renamed;
			this.preview?.setSkill(current);
			this.editorView?.setSkill(current);
			this.closeRenameDialog();
			this.requestRender();
		} catch (error) {
			this.renameError = error instanceof Error ? error.message : "Failed to rename skill";
			this.requestRender();
		}
	}

	private async saveEditedSkill(raw: string): Promise<void> {
		const skill = this.getCurrentSkill();
		if (!skill) {
			this.exitToBrowse();
			return;
		}
		try {
			const parsed = parseEditableSkillDocument(raw, skill.name);
			writeFileSync(skill.path, parsed.raw, "utf8");
			await this.refreshRegistry(skill.path);
			const current = this.registry.allSkills.find((entry) => entry.path === skill.path) ?? {
				...skill,
				description: parsed.description,
				content: parsed.content,
				frontmatter: parsed.frontmatter,
			};
			this.preview?.setSkill(current);
			this.ctx.ui.notify(`Updated skill: ${skill.name}`, "info");
			this.closeEditor();
			this.requestRender();
		} catch (error) {
			this.editorView?.setMessage(error instanceof Error ? error.message : "Failed to save skill", "error");
			this.requestRender();
		}
	}

	render(width: number): string[] {
		if (this.mode === "preview") return this.preview?.render(width) ?? [];
		if (this.mode === "edit") return this.editorView?.render(width) ?? [];
		if (this.mode === "rename") return this.renderRenameDialog(width);
		if (this.mode === "delete-confirm") return this.renderDeleteDialog(width);
		if (this.mode === "generating") return this.renderGeneratingDialog(width);
		return this.mode === "create" ? this.renderCreate(width) : this.renderBrowse(width);
	}

	private renderBrowse(width: number): string[] {
		const innerWidth = Math.max(20, width - 4);
		const root = new Container();
		root.addChild(new Text(this.theme.fg("accent", this.theme.bold("Skills")), 1, 0));
		root.addChild(new Spacer(1));
		root.addChild(this.browseInput);
		root.addChild(new Spacer(1));

		const list = new Container();
		const entries: Array<{ kind: "create" } | { kind: "header"; label: string } | { kind: "skill"; skill: SkillEntry }> = [{ kind: "create" }];
		const ownSkills = this.filteredSkills.filter((skill) => isDeletableSkill(skill));
		const otherSkills = this.filteredSkills.filter((skill) => !isDeletableSkill(skill));
		if (ownSkills.length > 0) {
			entries.push({ kind: "header", label: "Your Skills" });
			entries.push(...ownSkills.map((skill) => ({ kind: "skill" as const, skill })));
		}
		if (otherSkills.length > 0) {
			entries.push({ kind: "header", label: "Library Skills" });
			entries.push(...otherSkills.map((skill) => ({ kind: "skill" as const, skill })));
		}

		let selectedDisplayIndex = 0;
		let selectableIndex = 0;
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]!;
			if (entry.kind === "create" || entry.kind === "skill") {
				if (selectableIndex === this.selectedIndex) {
					selectedDisplayIndex = i;
					break;
				}
				selectableIndex += 1;
			}
		}
		const startIndex = Math.max(0, Math.min(selectedDisplayIndex - 6, Math.max(0, entries.length - 12)));
		const endIndex = Math.min(startIndex + 12, entries.length);
		selectableIndex = 0;
		const descriptionEllipsis = this.theme.fg("dim", "...");
		for (let i = 0; i < endIndex; i++) {
			const entry = entries[i]!;
			const isSelectable = entry.kind === "create" || entry.kind === "skill";
			const isSelected = isSelectable && selectableIndex === this.selectedIndex;
			if (i >= startIndex) {
				if (entry.kind === "header") {
					list.addChild(new Spacer(1));
					list.addChild(new SingleLineText(this.theme.fg("muted", this.theme.bold(entry.label)), descriptionEllipsis));
				} else if (entry.kind === "create") {
					const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
					const label = isSelected ? this.theme.fg("accent", "Create new skill") : "Create new skill";
					const desc = this.theme.fg("dim", " — generate and save a new skill");
					list.addChild(new SingleLineText(`${prefix}${label}${desc}`, descriptionEllipsis));
				} else {
					const skill = entry.skill;
					const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
					const name = isSelected ? this.theme.fg("accent", skill.name) : skill.enabled ? skill.name : this.theme.fg("muted", skill.name);
					const status = skill.enabled ? "" : this.theme.fg("warning", " [disabled]");
					const scope = this.theme.fg("muted", ` [${getScopeLabel(skill)}]`);
					const packageLabel = getPackageLabel(skill);
					const source = packageLabel ? this.theme.fg("muted", ` - [${packageLabel}]`) : "";
					const descriptionPrefix = packageLabel ? " " : " - ";
					const description = this.theme.fg("dim", `${descriptionPrefix}${skill.description}`);
					list.addChild(new SingleLineText(`${prefix}${name}${status}${scope}${source}${description}`, descriptionEllipsis));
				}
			}
			if (isSelectable) selectableIndex += 1;
		}

		root.addChild(list);
		root.addChild(new Spacer(1));
		const selectedSkill = this.getSelectedSkill();
		const actions = ["type to search"];
		if (!selectedSkill) {
			actions.push("enter create", "esc close");
		} else {
			if (selectedSkill.enabled) actions.push("enter insert");
			actions.push("tab preview", "ctrl+x enable/disable");
			if (!this.browseQuery && isDeletableSkill(selectedSkill)) actions.push("backspace delete");
			actions.push("esc close");
		}
		root.addChild(new Text(this.theme.fg("dim", actions.join(" • ")), 1, 0));
		return renderFramedPanel(this.theme, width, root.render(innerWidth));
	}

	private renderCreate(width: number): string[] {
		const innerWidth = Math.max(20, width - 4);
		const step = this.currentCreateStep;
		const root = new Container();
		root.addChild(new Text(this.theme.fg("accent", this.theme.bold(`${step.title} (${step.optional ? "optional" : "required"})`)), 1, 0));
		root.addChild(new Spacer(1));
		if (step.id === "name") {
			root.addChild(this.browseInput);
			root.addChild(new Spacer(1));
			if (step.hint) root.addChild(new Text(this.theme.fg("dim", step.hint), 1, 0));
		} else if (step.id === "description") {
			root.addChild(new PrefixedEditor(this.descriptionEditor));
			if (step.hint) {
				root.addChild(new Spacer(1));
				root.addChild(new Text(this.theme.fg("dim", step.hint), 1, 0));
			}
		} else if (step.kind === "choice") {
			for (const option of step.options) {
				const isSelected = option.value === this.createLocation;
				const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
				const label = isSelected ? this.theme.fg("accent", option.label) : option.label;
				const description = this.theme.fg("dim", ` — ${option.description}`);
				root.addChild(new SingleLineText(`${prefix}${label}${description}`));
			}
			if (step.hint) {
				root.addChild(new Spacer(1));
				root.addChild(new Text(this.theme.fg("dim", step.hint), 1, 0));
			}
		}
		if (this.createError) {
			root.addChild(new Spacer(1));
			root.addChild(new Text(this.theme.fg("error", this.createError), 1, 0));
		}
		root.addChild(new Spacer(1));
		const footer = step.id === "description"
			? "enter next • ctrl+j newline • alt+← back • alt+→ next • esc cancel"
			: step.id === "location"
				? "↑↓ choose • enter create • alt+← back • esc cancel"
				: "enter next • alt+← back • alt+→ next • esc cancel";
		root.addChild(new Text(this.theme.fg("dim", footer), 1, 0));
		return renderFramedPanel(this.theme, width, root.render(innerWidth));
	}

	private renderRenameDialog(width: number): string[] {
		const lines = [
			this.theme.fg("accent", this.theme.bold("Rename skill")),
			"",
			this.theme.fg("dim", "Enter new skill name (lowercase letters, numbers, hyphens)"),
			"",
			...this.renameInput.render(Math.max(20, Math.min(width - 4, 64))),
		];
		if (this.renameError) lines.push("", getToneText(this.theme, "error", this.renameError));
		lines.push("", this.theme.fg("dim", "enter save • esc cancel"));
		return renderCenteredDialog(this.theme, width, lines);
	}

	private renderDeleteDialog(width: number): string[] {
		const skill = this.deleteSkillPath ? this.registry.allSkills.find((entry) => entry.path === this.deleteSkillPath) : undefined;
		const innerWidth = Math.max(20, Math.min(width - 4, 64));
		const message = skill ? `Delete ${skill.name}? This removes the skill from disk and cannot be undone.` : "Delete this skill?";
		return renderCenteredDialog(this.theme, width, [
			this.theme.fg("accent", this.theme.bold("Delete skill")),
			"",
			...wrapTextWithAnsi(message, innerWidth),
			"",
			this.theme.fg("dim", "enter delete • esc cancel"),
		]);
	}

	private renderGeneratingDialog(width: number): string[] {
		return renderCenteredDialog(this.theme, width, [
			this.theme.fg("accent", this.theme.bold("Generating skill")),
			"",
			this.theme.fg("dim", "Please wait while the SKILL.md is generated and saved."),
			"",
			this.theme.fg("dim", "The dialog will switch to preview when generation finishes."),
			"",
			this.theme.fg("dim", "esc cancel"),
		]);
	}

	handleInput(data: string): void {
		if (this.mode === "generating") {
			if (matchesKey(data, Key.escape)) {
				this.generationAbortController?.abort();
				this.generationAbortController = undefined;
				this.generationRunId += 1;
				this.mode = "create";
				this.syncFocus();
				this.requestRender();
			}
			return;
		}
		if (this.mode === "rename") {
			if (matchesKey(data, Key.escape)) {
				this.closeRenameDialog();
				return;
			}
			if (this.renameError) this.renameError = undefined;
			this.renameInput.handleInput(data);
			return;
		}
		if (this.mode === "delete-confirm") {
			if (matchesKey(data, Key.escape)) {
				this.mode = this.deleteReturnMode === "preview" ? "preview" : "browse";
				this.syncFocus();
				return;
			}
			if (matchesKey(data, Key.enter) || data === "y" || data === "Y") {
				void this.confirmDelete();
			}
			return;
		}
		if (this.mode === "edit") {
			this.editorView?.handleInput(data);
			return;
		}
		if (this.mode === "preview") {
			const skill = this.getCurrentSkill();
			if (!skill) {
				this.exitToBrowse();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab)) {
				this.exitToBrowse(skill.path);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				if (!skill.enabled) {
					this.ctx.ui.notify("Enable this skill first with ctrl+x", "info");
					return;
				}
				this.done(skill);
				return;
			}
			if (matchesKey(data, Key.ctrl("x"))) {
				void this.toggleSkill(skill);
				return;
			}
			if (isDeletableSkill(skill) && (data === "e" || data === "E")) {
				this.openEditor();
				return;
			}
			if (isDeletableSkill(skill) && (data === "r" || data === "R")) {
				this.openRenameDialog();
				return;
			}
			if (isDeletableSkill(skill) && (matchesKey(data, Key.backspace) || data === "d" || data === "D")) {
				this.openDeleteConfirm(skill, "preview");
				return;
			}
			this.preview?.handleInput(data);
			return;
		}
		if (this.mode === "create") {
			this.handleCreateInput(data);
			return;
		}
		this.handleBrowseInput(data);
	}

	private handleBrowseInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredSkills.length : this.selectedIndex - 1;
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = this.selectedIndex === this.filteredSkills.length ? 0 : this.selectedIndex + 1;
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.selectedIndex === 0) {
				this.enterCreateMode();
				return;
			}
			const skill = this.getSelectedSkill();
			if (!skill) return;
			if (!skill.enabled) {
				this.ctx.ui.notify("Enable this skill first with ctrl+x", "info");
				return;
			}
			this.done(skill);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			const skill = this.getSelectedSkill();
			if (skill) this.openPreview(skill);
			return;
		}
		if (matchesKey(data, Key.ctrl("x"))) {
			const skill = this.getSelectedSkill();
			if (skill) void this.toggleSkill(skill);
			return;
		}
		if (matchesKey(data, Key.backspace) && !this.browseInput.getValue()) {
			const skill = this.getSelectedSkill();
			if (skill && isDeletableSkill(skill)) this.openDeleteConfirm(skill, "browse");
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.browseInput.getValue()) {
				this.browseQuery = "";
				this.browseInput.setValue("");
				this.refreshBrowseList();
				return;
			}
			this.done(null);
			return;
		}

		this.browseInput.handleInput(data);
		this.browseQuery = this.browseInput.getValue();
		this.refreshBrowseList();
	}

	private handleCreateInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.exitToBrowse();
			return;
		}
		if (matchesKey(data, Key.alt("left"))) {
			this.goToPreviousCreateStep();
			return;
		}
		if (matchesKey(data, Key.alt("right"))) {
			void this.advanceCreate();
			return;
		}
		if (matchesKey(data, Key.enter) && this.currentCreateStep.id !== "description") {
			void this.advanceCreate();
			return;
		}

		this.createError = undefined;
		const step = this.currentCreateStep;
		if (step.id === "name") {
			this.browseInput.handleInput(data);
			this.createValues.name = this.browseInput.getValue();
			return;
		}
		if (step.id === "location") {
			if (matchesKey(data, Key.up)) {
				this.moveLocationSelection(-1);
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.moveLocationSelection(1);
			}
			return;
		}
		this.descriptionEditor.handleInput(data);
		if (matchesKey(data, Key.enter)) return;
		this.createValues.description = this.descriptionEditor.getText();
	}
}

export async function showSkillsManager(
	ctx: ExtensionContext,
	registry: SkillRegistry,
	options: SkillsManagerOptions,
	initialSelectedIndex = 0,
	initialQuery = "",
): Promise<SkillEntry | null> {
	return await ctx.ui.custom<SkillEntry | null>((tui, _theme, _kb, done) => {
		const dialog = new SkillsManagerDialog(ctx, registry, ctx.ui.theme, tui, done, options, () => tui.requestRender(), initialSelectedIndex, initialQuery);
		return {
			get focused() {
				return dialog.focused;
			},
			set focused(value: boolean) {
				dialog.focused = value;
			},
			render(width: number) {
				return dialog.render(width);
			},
			invalidate() {
				dialog.invalidate();
			},
			handleInput(data: string) {
				dialog.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "80%", maxHeight: "85%", anchor: "center" } });
}
