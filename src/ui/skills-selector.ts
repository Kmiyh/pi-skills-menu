import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
	Container,
	type Component,
	Editor,
	type Focusable,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	type TUI,
} from "@mariozechner/pi-tui";
import { normalizeSkillName, type SkillCreationAnswers, type SkillLocation } from "../create-skill.js";
import { isDeletableSkill } from "../delete-skill.js";
import type { SkillEntry, SkillRegistry } from "../types.js";

export type SkillsMenuSelection =
	| { type: "skill"; skill: SkillEntry; selectedIndex: number; query: string }
	| { type: "create"; answers: SkillCreationAnswers; selectedIndex: number; query: string }
	| { type: "preview"; skill: SkillEntry; selectedIndex: number; query: string }
	| { type: "delete"; skill: SkillEntry; selectedIndex: number; query: string }
	| { type: "toggle"; skill: SkillEntry; selectedIndex: number; query: string }
	| null;

type CreateTextStepId = "name" | "description";
type CreateChoiceStepId = "location";
type CreateStepId = CreateTextStepId | CreateChoiceStepId;
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
		if (lines.length === 0) {
			return [this.prefix];
		}
		return lines.map((line, index) => `${index === 0 ? this.prefix : "  "}${line}`);
	}

	invalidate(): void {
		this.editor.invalidate();
	}
}

type BrowseRenderEntry =
	| { kind: "create" }
	| { kind: "header"; label: string }
	| { kind: "skill"; skill: SkillEntry };

class SkillsSelectorComponent extends Container implements Focusable {
	private input = new Input();
	private descriptionEditor: Editor;
	private listContainer = new Container();
	private footerText = new Text("", 1, 0);
	private filteredSkills: SkillEntry[] = [];
	private selectedIndex: number;
	private readonly maxVisible = 12;
	private readonly createLabel = "Create new skill";
	private mode: "browse" | "create" = "browse";
	private createStepIndex = 0;
	private createValues: Record<CreateTextStepId, string> = {
		name: "",
		description: "",
	};
	private createLocation: SkillLocation = "global";
	private submittedDescriptionValue: string | undefined;
	private createError: string | undefined;
	private browseQuery: string;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && (this.mode === "browse" || this.currentCreateStep.id === "name");
		this.descriptionEditor.focused = value && this.mode === "create" && this.currentCreateStep.id === "description";
	}

	constructor(
		private readonly skills: SkillEntry[],
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly done: (value: SkillsMenuSelection) => void,
		tui: TUI,
		initialSelectedIndex = 0,
		initialQuery = "",
	) {
		super();
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
			this.goToNextCreateStep();
		};
		this.filteredSkills = skills;
		this.selectedIndex = Math.max(0, initialSelectedIndex);
		this.browseQuery = initialQuery;
		this.input.setValue(initialQuery);

		this.refresh();
	}

	private rebuildLayout(showInput: boolean): void {
		this.clear();
		this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
		this.addChild(this.header);
		this.addChild(new Spacer(1));
		if (showInput) {
			this.addChild(this.input);
			this.addChild(new Spacer(1));
		}
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(this.footerText);
		this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
	}

	private readonly header = new Text("", 1, 0);

	private filterSkills(query: string): SkillEntry[] {
		const trimmed = query.trim().toLowerCase();
		if (!trimmed) return this.skills;

		const tokens = trimmed.split(/\s+/).filter(Boolean);
		return this.skills.filter((skill) => tokens.every((token) => skill.name.toLowerCase().includes(token)));
	}

	private orderBrowseSkills(skills: SkillEntry[]): SkillEntry[] {
		const ownSkills = skills.filter((skill) => isDeletableSkill(skill)).sort((a, b) => Number(b.enabled) - Number(a.enabled));
		const otherSkills = skills.filter((skill) => !isDeletableSkill(skill)).sort((a, b) => Number(b.enabled) - Number(a.enabled));
		return [...ownSkills, ...otherSkills];
	}

	private buildBrowseEntries(): BrowseRenderEntry[] {
		const ownSkills = this.filteredSkills.filter((skill) => isDeletableSkill(skill));
		const otherSkills = this.filteredSkills.filter((skill) => !isDeletableSkill(skill));
		const entries: BrowseRenderEntry[] = [{ kind: "create" }];

		if (ownSkills.length > 0) {
			entries.push({ kind: "header", label: "Your Skills" });
			entries.push(...ownSkills.map((skill) => ({ kind: "skill" as const, skill })));
		}
		if (otherSkills.length > 0) {
			entries.push({ kind: "header", label: "Library Skills" });
			entries.push(...otherSkills.map((skill) => ({ kind: "skill" as const, skill })));
		}

		return entries;
	}

	private getSelectableCount(): number {
		return this.filteredSkills.length + 1;
	}

	private getSelectedSkill(): SkillEntry | undefined {
		if (this.selectedIndex === 0) return undefined;
		return this.filteredSkills[this.selectedIndex - 1];
	}

	private getCurrentQuery(): string {
		return this.input.getValue();
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

	private setBrowseInputValue(value: string): void {
		this.browseQuery = value;
		this.input.setValue(value);
	}

	private enterCreateMode(): void {
		this.mode = "create";
		this.createStepIndex = 0;
		this.createError = undefined;
		this.syncCreateInput();
		this.refresh();
	}

	private exitCreateMode(): void {
		this.mode = "browse";
		this.createError = undefined;
		this.setBrowseInputValue(this.browseQuery);
		this.refresh();
	}

	private syncCreateInput(): void {
		const step = this.currentCreateStep;
		if (step.id === "name") {
			this.input.setValue(this.createValues.name);
			this.input.focused = this._focused;
			this.descriptionEditor.focused = false;
			return;
		}
		if (step.id === "description") {
			this.submittedDescriptionValue = undefined;
			this.descriptionEditor.setText(this.createValues.description);
			this.input.focused = false;
			this.descriptionEditor.focused = this._focused;
			return;
		}
		this.input.focused = false;
		this.descriptionEditor.focused = false;
	}

	private persistCreateInput(): void {
		const step = this.currentCreateStep;
		if (step.id === "name") {
			this.createValues.name = this.input.getValue();
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
				this.refresh();
				return false;
			}
			if (step.id === "name" && !normalizeSkillName(value)) {
				this.createError = "Name must contain letters, numbers, or hyphens.";
				this.refresh();
				return false;
			}
		}
		if (step.kind === "choice" && !LOCATION_OPTIONS.some((option) => option.value === this.createLocation)) {
			this.createError = `${step.title} is required.`;
			this.refresh();
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
		this.refresh();
	}

	private submitCreate(): void {
		const name = normalizeSkillName(this.createValues.name);
		if (!name) {
			this.createStepIndex = 0;
			this.syncCreateInput();
			this.createError = "Name is required.";
			this.refresh();
			return;
		}
		if (!this.createValues.description.trim()) {
			this.createStepIndex = 1;
			this.syncCreateInput();
			this.createError = "Description is required.";
			this.refresh();
			return;
		}

		this.done({
			type: "create",
			answers: {
				name,
				description: this.createValues.description.trim(),
				allowedTools: [],
				location: this.createLocation,
			},
			selectedIndex: this.selectedIndex,
			query: this.browseQuery,
		});
	}

	private goToNextCreateStep(): void {
		if (!this.validateCreateStep()) return;
		if (this.createStepIndex >= CREATE_STEPS.length - 1) {
			this.submitCreate();
			return;
		}
		this.createStepIndex += 1;
		this.syncCreateInput();
		this.refresh();
	}

	private refreshBrowse(): void {
		this.rebuildLayout(true);
		this.header.setText(this.theme.fg("accent", this.theme.bold("Skills")));
		this.filteredSkills = this.orderBrowseSkills(this.filterSkills(this.browseQuery));
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.getSelectableCount() - 1));
		const selectedSkill = this.getSelectedSkill();
		const actions = ["type to search"];
		if (!selectedSkill) {
			actions.push("enter create", "esc close");
		} else {
			if (selectedSkill.enabled) {
				actions.push("enter insert");
			}
			actions.push("tab preview", "x enable/disable");
			if (!this.browseQuery && isDeletableSkill(selectedSkill)) {
				actions.push("backspace delete");
			}
			actions.push("esc close");
		}
		this.footerText.setText(this.theme.fg("dim", actions.join(" • ")));
		this.renderBrowseList();
	}

	private renderBrowseList(): void {
		this.listContainer.clear();
		const descriptionEllipsis = this.theme.fg("dim", "...");
		const entries = this.buildBrowseEntries();
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

		const startIndex = Math.max(0, Math.min(selectedDisplayIndex - Math.floor(this.maxVisible / 2), Math.max(0, entries.length - this.maxVisible)));
		const endIndex = Math.min(startIndex + this.maxVisible, entries.length);
		selectableIndex = 0;

		for (let i = 0; i < endIndex; i++) {
			const entry = entries[i]!;
			const isSelectable = entry.kind === "create" || entry.kind === "skill";
			const isSelected = isSelectable && selectableIndex === this.selectedIndex;
			if (i >= startIndex) {
				if (entry.kind === "header") {
					this.listContainer.addChild(new Spacer(1));
					this.listContainer.addChild(new SingleLineText(this.theme.fg("muted", this.theme.bold(entry.label)), descriptionEllipsis));
				} else if (entry.kind === "create") {
					const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
					const label = isSelected ? this.theme.fg("accent", this.createLabel) : this.createLabel;
					const desc = this.theme.fg("dim", " — generate and save a new skill");
					this.listContainer.addChild(new SingleLineText(`${prefix}${label}${desc}`, descriptionEllipsis));
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
					this.listContainer.addChild(new SingleLineText(`${prefix}${name}${status}${scope}${source}${description}`, descriptionEllipsis));
				}
			}
			if (isSelectable) {
				selectableIndex += 1;
			}
		}
	}

	private refreshCreate(): void {
		const step = this.currentCreateStep;
		this.rebuildLayout(step.id === "name");
		this.header.setText(this.theme.fg("accent", this.theme.bold(`${step.title} (${step.optional ? "optional" : "required"})`)));
		this.footerText.setText(this.theme.fg("dim", this.getCreateFooter(step)));
		this.renderCreateList();
	}

	private getCreateFooter(step: CreateStep): string {
		if (step.id === "description") {
			return "enter next • ctrl+j newline • alt+← back • alt+→ next • esc cancel";
		}
		if (step.id === "location") {
			return "↑↓ choose • enter create • alt+← back • esc cancel";
		}
		return this.createStepIndex >= CREATE_STEPS.length - 1
			? "enter create • alt+← back • esc cancel"
			: "enter next • alt+← back • alt+→ next • esc cancel";
	}

	private renderCreateList(): void {
		this.listContainer.clear();
		const step = this.currentCreateStep;

		if (step.id === "description") {
			this.listContainer.addChild(new PrefixedEditor(this.descriptionEditor));
			if (step.hint) {
				this.listContainer.addChild(new Spacer(1));
				this.listContainer.addChild(new Text(this.theme.fg("dim", step.hint), 1, 0));
			}
		} else if (step.id === "location") {
			for (const option of step.options) {
				const isSelected = option.value === this.createLocation;
				const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
				const label = isSelected ? this.theme.fg("accent", option.label) : option.label;
				const description = this.theme.fg("dim", ` — ${option.description}`);
				this.listContainer.addChild(new SingleLineText(`${prefix}${label}${description}`));
			}
			if (step.hint) {
				this.listContainer.addChild(new Spacer(1));
				this.listContainer.addChild(new Text(this.theme.fg("dim", step.hint), 1, 0));
			}
		} else if (step.hint) {
			this.listContainer.addChild(new Text(this.theme.fg("dim", step.hint), 1, 0));
		}

		if (this.createError) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(this.theme.fg("error", this.createError), 1, 0));
		}
	}

	private refresh(): void {
		if (this.mode === "browse") this.refreshBrowse();
		else this.refreshCreate();
	}

	handleInput(data: string): void {
		if (this.mode === "browse") {
			this.handleBrowseInput(data);
			return;
		}
		this.handleCreateInput(data);
	}

	private handleBrowseInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = this.selectedIndex === 0 ? this.getSelectableCount() - 1 : this.selectedIndex - 1;
			this.refreshBrowse();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = this.selectedIndex === this.getSelectableCount() - 1 ? 0 : this.selectedIndex + 1;
			this.refreshBrowse();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.selectedIndex === 0) {
				this.enterCreateMode();
				return;
			}
			const skill = this.getSelectedSkill();
			if (skill?.enabled) {
				this.done({ type: "skill", skill, selectedIndex: this.selectedIndex, query: this.browseQuery });
			}
			return;
		}
		if (matchesKey(data, Key.tab)) {
			const skill = this.getSelectedSkill();
			if (skill) {
				this.done({ type: "preview", skill, selectedIndex: this.selectedIndex, query: this.browseQuery });
			}
			return;
		}
		if (data === "x" || data === "X") {
			const skill = this.getSelectedSkill();
			if (skill) {
				this.done({ type: "toggle", skill, selectedIndex: this.selectedIndex, query: this.browseQuery });
			}
			return;
		}
		if (matchesKey(data, Key.backspace) && !this.input.getValue()) {
			const skill = this.getSelectedSkill();
			if (skill && isDeletableSkill(skill)) {
				this.done({ type: "delete", skill, selectedIndex: this.selectedIndex, query: this.browseQuery });
			}
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.input.getValue()) {
				this.setBrowseInputValue("");
				this.refreshBrowse();
			} else {
				this.done(null);
			}
			return;
		}

		this.input.handleInput(data);
		this.browseQuery = this.input.getValue();
		this.refreshBrowse();
	}

	private handleCreateInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.exitCreateMode();
			return;
		}
		if (matchesKey(data, Key.alt("left"))) {
			this.goToPreviousCreateStep();
			return;
		}
		if (matchesKey(data, Key.alt("right"))) {
			this.goToNextCreateStep();
			return;
		}
		if (matchesKey(data, Key.enter) && this.currentCreateStep.id !== "description") {
			this.goToNextCreateStep();
			return;
		}

		this.createError = undefined;
		const step = this.currentCreateStep;
		if (step.id === "name") {
			this.input.handleInput(data);
			this.createValues.name = this.input.getValue();
			this.refreshCreate();
			return;
		}
		if (step.id === "location") {
			if (matchesKey(data, Key.up)) {
				this.moveLocationSelection(-1);
				this.refreshCreate();
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.moveLocationSelection(1);
				this.refreshCreate();
				return;
			}
			return;
		}
		this.descriptionEditor.handleInput(data);
		if (matchesKey(data, Key.enter)) {
			return;
		}
		this.createValues.description = this.descriptionEditor.getText();
		this.refreshCreate();
	}
}

export async function showSkillsSelector(
	ctx: ExtensionContext,
	registry: SkillRegistry,
	initialSelectedIndex = 0,
	initialQuery = "",
): Promise<SkillsMenuSelection> {
	return await ctx.ui.custom<SkillsMenuSelection>((tui, _theme, _kb, done) => {
		const component = new SkillsSelectorComponent(
			registry.allSkills,
			ctx.ui.theme,
			done,
			tui,
			initialSelectedIndex,
			initialQuery,
		);
		return {
			get focused() {
				return component.focused;
			},
			set focused(value: boolean) {
				component.focused = value;
			},
			render(width: number) {
				return component.render(width);
			},
			invalidate() {
				component.invalidate();
			},
			handleInput(data: string) {
				component.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
