import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rename as renamePath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, parseFrontmatter, stripFrontmatter } from "@mariozechner/pi-coding-agent";
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
} from "@mariozechner/pi-tui";
import { normalizeSkillName } from "../create-skill.js";
import { isDeletableSkill } from "../delete-skill.js";
import type { SkillEntry } from "../types.js";

interface ParsedSkillDocument {
	name: string;
	description: string;
	frontmatter: Record<string, unknown>;
	content: string;
	raw: string;
}

type MessageTone = "dim" | "success" | "error";

function getSkillLocation(skill: SkillEntry): string {
	return skill.origin === "package" ? skill.source : skill.path;
}

function getSkillLocationLabel(skill: SkillEntry): string {
	return skill.origin === "package" ? "package" : "path";
}

function formatScalar(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (value === null) {
		return "null";
	}
	return JSON.stringify(value);
}

function formatYamlValue(key: string, value: unknown, indent = ""): string[] {
	if (typeof value === "string" && value.includes("\n")) {
		return [`${indent}${key}: |`, ...value.split("\n").map((line) => `${indent}  ${line}`)];
	}

	if (Array.isArray(value)) {
		if (value.length === 0) {
			return [`${indent}${key}: []`];
		}
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
		if (entries.length === 0) {
			return [`${indent}${key}: {}`];
		}
		return [
			`${indent}${key}:`,
			...entries.flatMap(([nestedKey, nestedValue]) => formatYamlValue(nestedKey, nestedValue, `${indent}  `)),
		];
	}

	return [`${indent}${key}: ${formatScalar(value)}`];
}

function buildFrontmatterBlock(skill: SkillEntry): string {
	const frontmatter = skill.frontmatter ?? {
		name: skill.name,
		description: skill.description,
	};
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

	if (!name || !description) {
		throw new Error("Skill must include frontmatter fields 'name' and 'description'");
	}
	if (name !== expectedName) {
		throw new Error(`Frontmatter name must stay '${expectedName}'`);
	}

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
	if (!description) {
		throw new Error("Skill must include frontmatter field 'description'");
	}
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

function toUpdatedSkill(skill: SkillEntry, parsed: ParsedSkillDocument): SkillEntry {
	return {
		...skill,
		name: parsed.name,
		description: parsed.description,
		content: parsed.content,
		frontmatter: parsed.frontmatter,
	};
}

function getToneText(
	theme: ExtensionContext["ui"]["theme"],
	tone: MessageTone,
	text: string,
): string {
	if (tone === "error") return theme.fg("error", text);
	if (tone === "success") return theme.fg("success", text);
	return theme.fg("dim", text);
}

function createFrameLine(
	theme: ExtensionContext["ui"]["theme"],
	line: string,
	innerWidth: number,
): string {
	const pad = Math.max(0, innerWidth - visibleWidth(line));
	return `${theme.fg("accent", "│ ")}${line}${" ".repeat(pad)}${theme.fg("accent", " │")}`;
}

function centerRenderedLines(lines: string[], width: number): string[] {
	const renderedWidth = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	const leftPad = Math.max(0, Math.floor((width - renderedWidth) / 2));
	if (leftPad === 0) {
		return lines;
	}
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

class ScrollableSkillPreview implements Component {
	private scrollOffset = 0;
	private lastInnerWidth = 1;
	private lastContentLines: string[] = [];

	constructor(
		private skill: SkillEntry,
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly getTerminalRows: () => number,
		private readonly editable: boolean,
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
		return Math.max(10, Math.floor(this.getTerminalRows() * 0.8));
	}

	private buildContentLines(innerWidth: number): string[] {
		const content = new Container();
		content.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.skill.name)), 0, 0));
		content.addChild(new Text(this.theme.fg("muted", `${getSkillLocationLabel(this.skill)} • ${getSkillLocation(this.skill)}`), 0, 0));
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
		const editInfo = this.editable ? " • e edit • r rename" : "";
		return truncateToWidth(
			this.theme.fg("dim", `↑/↓ scroll • pgup/pgdn jump • home/end${editInfo} • esc back${scrollInfo}`),
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
		return Math.max(10, Math.floor(realRows * 0.8));
	}

	private getRowsForVisibleEditorLines(targetVisibleLines: number): number {
		let rows = 5;
		while (Math.max(5, Math.floor(rows * 0.3)) < targetVisibleLines && rows < 1000) {
			rows += 1;
		}
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
		lines.push(
			truncateToWidth(
				this.theme.fg("dim", "ctrl+s save • esc back"),
				innerWidth,
				this.theme.fg("dim", "..."),
			),
		);

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
	if (!normalizedName) {
		throw new Error("Name must contain letters, numbers, or hyphens");
	}
	if (normalizedName === skill.name) {
		ctx.ui.notify("Skill name unchanged", "info");
		return skill;
	}

	const currentDir = dirname(skill.path);
	const parentDir = dirname(currentDir);
	const targetDir = join(parentDir, normalizedName);
	const targetPath = join(targetDir, "SKILL.md");
	if (existsSync(targetDir) || existsSync(targetPath)) {
		throw new Error(`Skill already exists: ${normalizedName}`);
	}

	const currentRaw = readFileSync(skill.path, "utf8");
	const parsedCurrent = parseSkillDocument(currentRaw, skill.name);
	const renamedFrontmatter = {
		...parsedCurrent.frontmatter,
		name: normalizedName,
	};
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

class SkillPreviewDialog implements Focusable {
	private readonly editable: boolean;
	private readonly preview: ScrollableSkillPreview;
	private readonly renameInput = new Input();
	private editorView: SkillEditorView | undefined;
	private currentSkill: SkillEntry;
	private mode: "preview" | "edit" | "rename" = "preview";
	private _focused = false;
	private discardConfirmOpen = false;
	private renameError: string | undefined;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.renameInput.focused = value && this.mode === "rename";
		if (this.editorView) {
			this.editorView.focused = value;
		}
	}

	constructor(
		private readonly ctx: ExtensionContext,
		skill: SkillEntry,
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly tui: TUI,
		private readonly close: () => void,
		private readonly requestRender: () => void,
	) {
		this.currentSkill = skill;
		this.editable = isDeletableSkill(skill);
		this.preview = new ScrollableSkillPreview(skill, theme, () => tui.terminal.rows, this.editable);
		this.renameInput.onSubmit = (value) => {
			void this.submitRename(value);
		};
	}

	invalidate(): void {
		this.preview.invalidate();
		this.renameInput.invalidate();
		this.editorView?.invalidate();
	}

	private renderDiscardConfirm(width: number): string[] {
		return renderCenteredDialog(this.theme, width, [
			this.theme.fg("accent", this.theme.bold("Discard changes?")),
			"",
			`Discard unsaved changes to ${this.currentSkill.name}?`,
			"",
			this.theme.fg("dim", "enter/y discard • esc/n keep editing"),
		]);
	}

	private renderRenameDialog(width: number): string[] {
		const lines = [
			this.theme.fg("accent", this.theme.bold("Rename skill")),
			"",
			this.theme.fg("dim", "Enter new skill name (lowercase letters, numbers, hyphens)"),
			"",
			...this.renameInput.render(Math.max(20, Math.min(width - 4, 64))),
		];

		if (this.renameError) {
			lines.push("", getToneText(this.theme, "error", this.renameError));
		}

		lines.push("", this.theme.fg("dim", "enter save • esc cancel"));
		return renderCenteredDialog(this.theme, width, lines);
	}

	render(width: number): string[] {
		if (this.discardConfirmOpen) {
			return this.renderDiscardConfirm(width);
		}
		if (this.mode === "rename") {
			return this.renderRenameDialog(width);
		}
		return this.mode === "preview"
			? this.preview.render(width)
			: this.editorView?.render(width) ?? this.preview.render(width);
	}

	handleInput(data: string): void {
		if (this.discardConfirmOpen) {
			if (matchesKey(data, Key.enter) || data === "y" || data === "Y") {
				this.discardConfirmOpen = false;
				this.closeEditor();
				return;
			}
			if (matchesKey(data, Key.escape) || data === "n" || data === "N") {
				this.discardConfirmOpen = false;
				this.requestRender();
				return;
			}
			return;
		}

		if (this.mode === "rename") {
			if (matchesKey(data, Key.escape)) {
				this.closeRenameDialog();
				return;
			}
			if (this.renameError) {
				this.renameError = undefined;
			}
			this.renameInput.handleInput(data);
			return;
		}

		if (this.mode === "preview") {
			if (this.editable && (data === "e" || data === "E")) {
				this.openEditor();
				return;
			}
			if (this.editable && (data === "r" || data === "R")) {
				this.openRenameDialog();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab)) {
				this.close();
				return;
			}
			this.preview.handleInput(data);
			return;
		}

		if (matchesKey(data, Key.escape)) {
			void this.closeEditorMaybeConfirm();
			return;
		}

		this.editorView?.handleInput(data);
	}

	private openEditor(): void {
		this.discardConfirmOpen = false;
		this.renameInput.focused = false;
		const initialText = buildEditableSkillDocument(this.currentSkill, readSkillDocument(this.currentSkill));
		this.editorView = new SkillEditorView(
			this.currentSkill,
			this.theme,
			this.tui,
			initialText,
			(value) => this.saveEditedSkill(value),
			() => this.closeEditor(),
		);
		this.editorView.focused = this._focused;
		this.mode = "edit";
		this.requestRender();
	}

	private closeEditor(): void {
		this.discardConfirmOpen = false;
		this.renameInput.focused = false;
		this.mode = "preview";
		this.editorView = undefined;
		this.requestRender();
	}

	private async closeEditorMaybeConfirm(): Promise<void> {
		if (!this.editorView || !this.editorView.isDirty()) {
			this.closeEditor();
			return;
		}
		this.discardConfirmOpen = true;
		this.requestRender();
	}

	private openRenameDialog(): void {
		this.renameError = undefined;
		this.renameInput.setValue(this.currentSkill.name);
		this.mode = "rename";
		this.renameInput.focused = this._focused;
		this.requestRender();
	}

	private closeRenameDialog(): void {
		this.renameError = undefined;
		this.renameInput.focused = false;
		this.mode = "preview";
		this.requestRender();
	}

	private async submitRename(value: string): Promise<void> {
		try {
			const renamed = await renameSkillEntry(this.ctx, this.currentSkill, value);
			if (!renamed) {
				this.closeRenameDialog();
				return;
			}
			this.currentSkill = renamed;
			this.preview.setSkill(renamed);
			this.editorView?.setSkill(renamed);
			this.closeRenameDialog();
		} catch (error) {
			this.renameError = error instanceof Error ? error.message : "Failed to rename skill";
			this.requestRender();
		}
	}

	private saveEditedSkill(raw: string): void {
		try {
			const parsed = parseEditableSkillDocument(raw, this.currentSkill.name);
			writeFileSync(this.currentSkill.path, parsed.raw, "utf8");
			this.currentSkill = toUpdatedSkill(this.currentSkill, parsed);
			this.preview.setSkill(this.currentSkill);
			this.editorView?.setSkill(this.currentSkill);
			this.ctx.ui.notify(`Updated skill: ${this.currentSkill.name}`, "info");
			this.closeEditor();
		} catch (error) {
			this.editorView?.setMessage(error instanceof Error ? error.message : "Failed to save skill", "error");
			this.requestRender();
		}
	}
}

export async function showSkillPreview(ctx: ExtensionContext, skill: SkillEntry): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const close = () => {
			done();
		};
		const dialog = new SkillPreviewDialog(ctx, skill, theme, tui, close, () => tui.requestRender());

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
