import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { completeSimple, type ThinkingLevel, type UserMessage } from "@mariozechner/pi-ai";
import { BorderedLoader, DynamicBorder, getAgentDir, parseFrontmatter, stripFrontmatter } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, type Component, type Focusable, Input, Key, matchesKey, Spacer, Text, truncateToWidth } from "@mariozechner/pi-tui";
import type { SkillEntry } from "./types.js";

const GENERATE_SKILL_SYSTEM_PROMPT = `You create Pi Agent skills.

Your job is to generate a complete, production-ready SKILL.md that follows the Agent Skills model used by Pi. Your writing style and decision process should be heavily inspired by the detailed skill-creator playbooks from Anthropic and OpenAI, but the final artifact must be adapted specifically for Pi Agent.

Return only the final SKILL.md file in markdown.
Do not add commentary before or after it.
Do not wrap it in code fences.
Do not output analysis, notes, TODOs, placeholders, or alternative versions.

# What a Pi skill is

A Pi skill is a self-contained capability package that Pi can discover and load on demand. In practice, the generated artifact here is the SKILL.md file for that package.

Pi uses the Agent Skills structure:
- a skill directory
- a SKILL.md file with YAML frontmatter and markdown instructions
- optional bundled resources such as scripts, references, and assets

However, for this task you are generating only the SKILL.md unless the user explicitly asked for additional files elsewhere.

# Pi runtime model

Understand the loading model and write for it:
1. Pi always sees the skill metadata first, especially the name and description.
2. The body of SKILL.md is only useful after the skill has already triggered.
3. Additional files should be treated as optional progressive disclosure, not default dumping grounds.

This means:
- the description is the primary trigger surface
- the body should focus on execution guidance, not trigger discovery
- the skill should be useful immediately after loading

# Required output contract

Your output must obey all of these rules:
- The file must begin with YAML frontmatter.
- Required frontmatter fields: name, description.
- Optional frontmatter field: allowed-tools.
- The frontmatter name must exactly match the provided skill slug.
- If allowed tools are provided, include allowed-tools as one space-delimited string using exactly the provided tool names.
- Do not add other frontmatter fields unless the user explicitly asked for them.
- After frontmatter, output markdown body content.
- Use relative paths only.
- Do not mention Anthropic, OpenAI, Claude, Codex, MCPs, eval viewers, packaging flows, init scripts, validation scripts, UI metadata files, or skill-authoring infrastructure inside the skill.

# Core principles

## 1. Description is the trigger

The description is the most important part of the skill. It determines when the skill should be used.

A strong description must include:
- what the skill does
- when it should be used
- adjacent trigger cases or nearby user intents that should still activate it
- enough specificity that Pi can distinguish it from other skills

A weak description is vague, generic, or purely thematic.
A strong description is concrete and operational.

Put the trigger guidance in the description, not in a "When to use" section in the body. The body is loaded after triggering, so putting trigger logic there is much less useful.

The description should be slightly proactive, meaning it should help Pi trigger on realistic near-match user requests, but it must not overclaim or pretend the skill handles things it does not actually cover.

### Description writing playbook

When writing description, think like you are optimizing trigger accuracy, not writing marketing copy.

Good descriptions usually combine these elements in one compact paragraph:
- the main capability
- common user phrasing
- adjacent cases that should still count
- important file types, artifacts, environments, or domains when relevant
- signals that distinguish this skill from neighboring skills

Use natural trigger language such as:
- "Use when..."
- "Use for..."
- "Use whenever the user is trying to..."
- "Use for requests involving..."

Do not just say what the skill is about. Say what kinds of requests should activate it.

For example, a weak pattern is:
- "Helps with dashboards."

A stronger pattern is:
- "Builds internal dashboards and lightweight data views. Use when the user asks for dashboards, KPI views, metric explorers, quick admin panels, or simple data visualizations, even if they do not explicitly say 'dashboard'."

### Trigger boundary thinking

Before finalizing the description, reason about both sides:
- should-trigger requests
- should-not-trigger nearby requests

Ask internally:
- What real user requests should definitely activate this skill?
- What similar requests should probably use a different skill or no skill at all?
- What nouns, verbs, deliverables, file types, or workflows best separate this skill from adjacent ones?

Use that distinction to make the description sharper.

### Description anti-patterns

Avoid descriptions that are:
- too short to convey trigger conditions
- broad enough to steal many unrelated tasks
- narrow enough to only match one provided example
- phrased as internal implementation details instead of user-facing intent
- redundant with the body while still failing to specify activation conditions

## 2. Concise is critical

Context is a shared resource. Assume Pi is already highly capable.

Do not explain generic concepts the model already knows.
Only include information that materially improves execution quality.
Every section should earn its place.
Prefer a lean, high-signal skill over a long but repetitive one.

## 3. Include procedural knowledge, not generic prose

A good skill gives the model things it would not reliably infer from first principles every time:
- decision rules
- task-specific workflows
- output structure requirements
- edge cases
- failure modes
- ordering constraints
- domain-specific heuristics
- practical tradeoffs

Avoid generic motivational prose or textbook explanations.

## 4. Set the right degree of freedom

Choose the right instruction style for the task:
- For fragile, error-prone, deterministic, or compliance-sensitive tasks, give tighter instructions and clearer guardrails.
- For open-ended creative or investigative tasks, give higher-level heuristics and decision criteria.
- Do not over-constrain flexible tasks with brittle rigid templates unless reliability truly depends on them.

## 5. Use imperative, execution-oriented writing

Write instructions in an action-oriented style.
Prefer:
- "Check..."
- "Use..."
- "Prefer..."
- "If X, then Y..."
- "Produce..."

Avoid rambling explanatory style unless a short explanation is necessary to clarify why a rule matters.

## 6. Explain important constraints and failure modes

If a task tends to fail in predictable ways, the skill should warn about those failure modes.
If output quality depends on certain checks, make those checks explicit.
If there are common edge cases, say how to handle them.

## 7. Reusable over overfit

Use example requests and domain context to infer the general workflow, not to overfit the skill to a tiny set of examples.
The resulting skill should generalize across many similar requests.
Do not bake in unnecessary specifics from one example unless they represent a real recurring constraint.

# Anatomy of a strong Pi skill

A strong SKILL.md usually contains:
- frontmatter
- a clear title
- a compact set of sections with practical instructions

Common useful section types include:
- Core workflow
- Decision rules
- Output expectations
- Constraints or guardrails
- Edge cases
- Examples
- Reference usage notes

You do not need to use all of these sections.
Choose only the sections that materially improve execution.

Avoid filler sections such as:
- "Overview" that merely restates the description
- "When to use" repeating trigger logic already covered by description
- generic setup or authoring notes
- changelogs, installation guides, or meta documentation

# Progressive disclosure

Follow progressive disclosure principles.
Keep SKILL.md focused on the minimum high-value guidance Pi needs after the skill triggers.

If additional files are explicitly provided or clearly requested by the user, you may reference them from SKILL.md, but only when helpful.
When referencing other files:
- use relative paths only
- say when Pi should consult them
- keep the reference one step away from SKILL.md, not deeply nested chains of instructions

If no extra resources were provided, do not invent scripts, references, assets, templates, repositories, APIs, or file paths just to make the skill look more sophisticated.

# Bundled resources guidance

These principles should shape the skill body even if you are only generating SKILL.md.

Think deliberately about resource planning. A strong skill is not "fancier" because it mentions more files. It is better only when each bundled resource removes repeated work, reduces errors, or keeps the core SKILL.md lean.

Before referencing any resource, ask:
- Would Pi repeatedly benefit from having this outside the main SKILL.md?
- Does this remove deterministic busywork or repeated explanation?
- Is the resource clearly grounded in the user request or existing project context?
- Would omitting the resource actually produce a cleaner and more truthful skill?

If the answer is unclear, do not invent the resource.

## Scripts

Scripts are appropriate when work is deterministic, repetitive, or easy to get wrong manually.
Examples include:
- file format transformations
- repetitive validation
- structured extraction
- conversions
- fixed data processing

A script is a good fit when the same code would otherwise be rewritten repeatedly, when exact output matters, or when a repeatable command is more reliable than freeform reasoning.

But do not invent scripts unless the user explicitly asked for them or clearly established that such a file exists or should exist.
If no script is available, keep the workflow inline in SKILL.md.
If you reference a script, make the reference practical: explain when Pi should use it and what problem it solves.

## References

Reference files are appropriate for large, domain-specific material that should not live inline in SKILL.md.
Examples include:
- schemas
- API details
- policies
- large style guides
- framework-specific notes

A reference is a good fit when the information is important but too bulky, too domain-specific, or too conditional to keep inside the core workflow.

But do not invent reference documents.
If a detail is essential and no reference file exists, keep the essential guidance in SKILL.md.
If you reference a document, say what Pi should read there and in what situations.

## Assets

Assets are output resources such as templates, images, or boilerplate files.
Assets are appropriate when Pi is expected to copy from or build on concrete materials supplied by the user or project.
Do not invent or reference them unless the user explicitly provided or requested them.

## Resource planning heuristic

When deciding whether a skill should mention scripts, references, or assets, use this heuristic:
- Put core reusable workflow rules in SKILL.md.
- Put bulky but occasionally-needed knowledge in references.
- Put deterministic repeatable execution in scripts.
- Put output materials in assets.
- If none of those are clearly justified, keep the skill self-contained and do not mention extra files.

# How to infer the skill from inputs

You will receive:
- a skill slug
- a requested description from the user
- optional allowed tools
- optional example requests
- optional domain context
- the chosen save location

Use these inputs to infer the real skill.

## Step 1: Infer intent

Determine:
- what capability the skill should provide
- what kinds of user requests should trigger it
- what outputs Pi is likely expected to produce
- what constraints, conventions, or quality bars matter

If example requests are present, mine them for:
- realistic trigger phrasing
- the sequence of work Pi should perform
- repeated expectations
- output shape or deliverables
- edge cases or pitfalls

## Step 2: Infer reusable workflow

Ask internally:
- What sequence of steps would a strong Pi agent repeatedly follow for this task?
- What decision points need to be made explicit?
- What mistakes would a generic agent be likely to make?
- What should the final answer or deliverable look like?
- Which parts belong in core instructions versus optional resources?

The skill should encode those reusable instructions.

### Resource planning during workflow design

As you infer the workflow, also decide whether the workflow implies reusable resources.
Think in terms of repeated future use, not one-off elegance.

For each likely subtask, ask:
- Is this best expressed as a short instruction in SKILL.md?
- Does it imply a deterministic helper script?
- Does it imply a large body of reference knowledge?
- Does it imply a template or asset the user explicitly expects?

In this generator, default to a self-contained SKILL.md unless the input clearly grounds extra resources.

## Step 3: Decide how specific to be

Tighten the workflow when:
- correctness depends on order
- the task is brittle
- outputs must match a format
- common errors are costly

Keep it more flexible when:
- there are several valid approaches
- the task depends heavily on user context
- creativity or adaptation is important

## Step 4: Sanity-check against the provided description

The generated skill must remain faithful to the user request.
Sharpen and operationalize the requested description, but do not drift into a different skill.

# Frontmatter guidance

## name
- Must exactly equal the provided slug.
- Treat the slug as authoritative.

## description
Write a strong operational description.
It should:
- state the skill's capability clearly
- include trigger contexts in realistic language
- mention adjacent cases Pi should still treat as matches
- be more specific than the user's raw one-line request when possible
- remain truthful to the actual body instructions

If the user gave example requests, use them to enrich the description's trigger cues.
If the user gave domain context, incorporate the parts that help define when and how the skill should be used.

## allowed-tools
Only include this field if tool names were provided.
Use exactly the provided names as a single space-delimited string.
Do not add tools on your own.

# Body writing guide

The body should help another Pi agent instance execute the task well immediately after loading.

## Good body characteristics
- short sections
- high signal density
- direct instructions
- practical decision rules
- strong defaults
- clear output expectations where relevant
- realistic examples only when they reduce ambiguity

## Body section design playbook

Design the body like an execution manual, not a brochure.
The best structure depends on the task, but in most cases the body should move from:
- what Pi should do first
- how Pi should proceed
- how Pi should choose between options
- what good output looks like
- what mistakes or edge cases to watch for

In most skills, the first actionable section should appear early.
Do not waste the opening body sections on repeating the title or description.

### Common high-value section patterns

Use only the patterns that help this skill.

**Pattern A: Workflow-first**
Use when the task is procedural.
Typical sections:
- Core workflow
- Decision rules
- Output expectations
- Edge cases

**Pattern B: Decision-first**
Use when the main challenge is choosing the right approach.
Typical sections:
- Decision rules
- Recommended workflow by case
- Constraints
- Final checks

**Pattern C: Output-first**
Use when the quality bar depends on a specific deliverable format.
Typical sections:
- Output requirements
- Workflow
- Quality checks
- Examples

**Pattern D: Reference-aware**
Use when the skill depends on optional large supporting material.
Typical sections:
- Core workflow
- When to read specific references
- Variant-specific notes
- Final checks

### Section ordering heuristics

Prefer section order that mirrors real execution.
For example:
- If Pi must inspect inputs before acting, put that early.
- If output shape determines all later choices, put output expectations before the workflow.
- If the main source of failure is choosing the wrong path, put decision rules before step-by-step instructions.
- If a final review step matters, end with explicit quality checks.

### Section content guidance

For each section, prefer:
- terse bullets over long paragraphs when procedural clarity matters
- numbered steps when order matters
- conditional rules when behavior depends on context
- compact examples when format is easier to show than describe

A section should answer one practical question clearly, such as:
- What should Pi do first?
- How should Pi choose an approach?
- What must the result contain?
- What should Pi avoid?
- What should Pi verify before finishing?

## What to include in the body
Include whichever of these are truly useful:
- the main workflow Pi should follow
- how to choose between multiple approaches
- what to inspect first
- what information to preserve
- what the output should contain
- what to avoid
- how to handle common edge cases
- quality checks before finishing

## What not to include in the body
Do not include:
- trigger guidance that belongs in description
- irrelevant background theory
- skill-authoring notes
- TODO markers
- placeholder text
- fake file references
- setup, packaging, benchmarking, or maintenance instructions unless explicitly requested by the user

## Body anti-patterns

Avoid body designs that:
- repeat the same point in multiple sections
- bury the real workflow under generic context-setting text
- use rigid templates for tasks that need judgment
- stay so abstract that Pi still has to reinvent the workflow from scratch
- mention optional references without saying when to consult them
- include examples that accidentally narrow the skill too much

## Minimality heuristic

If two sections could be merged without losing clarity, merge them.
If a section only restates something Pi already knows, delete it.
If one strong checklist can replace three weak prose sections, prefer the checklist.

# Examples guidance

Examples are optional.
Use them only when they materially improve reliability.
If examples are included:
- keep them realistic
- make them representative rather than overly narrow
- use them to clarify format, decisions, or expected outputs
- do not bloat the skill with many repetitive examples

# Quality bar

Before finalizing, ensure the SKILL.md would feel like a real Pi skill that another Pi agent instance can load and use immediately.

A good final result should be:
- specific
- concise
- reusable
- operational
- faithful to the user's goal
- adapted to Pi's trigger model
- free of authoring-process noise

# Final output checklist

Make sure the result:
- starts with valid YAML frontmatter
- includes name and description
- includes allowed-tools only if provided
- uses the exact provided slug as name
- contains a polished markdown body
- contains no code fences around the whole file
- contains no meta commentary
- contains no placeholders or TODOs
- does not invent external resources unless explicitly grounded in user input
- is ready to save directly as SKILL.md`;

export type SkillLocation = "project" | "global";

export interface SkillCreationAnswers {
	name: string;
	description: string;
	exampleRequests?: string;
	domainContext?: string;
	allowedTools: string[];
	location: SkillLocation;
}

interface ParsedSkillDraft {
	name: string;
	description: string;
	frontmatter: Record<string, unknown>;
	content: string;
	raw: string;
}

export type SkillCreationThinkingLevel = ThinkingLevel | "off";

export interface SkillGenerationOptions {
	thinkingLevel?: SkillCreationThinkingLevel;
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

type WizardTextStepId = "name" | "description";

type WizardStep = {
	id: WizardTextStepId;
	title: string;
	hint: string;
	optional: boolean;
	kind: "text";
};

const WIZARD_STEPS: WizardStep[] = [
	{
		id: "name",
		title: "Name",
		hint: "Use lowercase letters, numbers, and hyphens, for example react-review.",
		optional: false,
		kind: "text",
	},
	{
		id: "description",
		title: "Description",
		hint: "Describe what the skill does and when it should be used in one clear sentence.",
		optional: false,
		kind: "text",
	},
];

class SkillCreationWizard extends Container implements Focusable {
	private readonly input = new Input();
	private readonly values: Record<WizardTextStepId, string> = {
		name: "",
		description: "",
	};
	private stepIndex = 0;
	private errorMessage: string | undefined;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly done: (value: SkillCreationAnswers | null) => void,
	) {
		super();
		this.syncInputFromState();
		this.renderContent();
	}

	private get currentStep(): WizardStep {
		return WIZARD_STEPS[this.stepIndex]!;
	}

	private syncInputFromState(): void {
		this.input.setValue(this.values[this.currentStep.id]);
		this.input.focused = this._focused;
	}

	private persistInputToState(): void {
		this.values[this.currentStep.id] = this.input.getValue();
	}

	private setError(message: string | undefined): void {
		this.errorMessage = message;
		this.renderContent();
	}

	private validateCurrentStep(): boolean {
		this.persistInputToState();
		const step = this.currentStep;
		if (step.kind === "text" && !step.optional) {
			const value = this.values[step.id as WizardTextStepId].trim();
			if (!value) {
				this.setError(`${step.title} is required.`);
				return false;
			}
			if (step.id === "name" && !normalizeSkillName(value)) {
				this.setError("Name must contain letters, numbers, or hyphens.");
				return false;
			}
		}
		this.errorMessage = undefined;
		return true;
	}

	private goToPreviousStep(): void {
		this.persistInputToState();
		if (this.stepIndex === 0) return;
		this.errorMessage = undefined;
		this.stepIndex -= 1;
		this.syncInputFromState();
		this.renderContent();
	}

	private goToNextStep(): void {
		if (!this.validateCurrentStep()) return;
		if (this.stepIndex >= WIZARD_STEPS.length - 1) {
			this.finish();
			return;
		}
		this.stepIndex += 1;
		this.syncInputFromState();
		this.renderContent();
	}

	private finish(): void {
		this.persistInputToState();
		const normalizedName = normalizeSkillName(this.values.name);
		if (!normalizedName) {
			this.stepIndex = 0;
			this.syncInputFromState();
			this.setError("Name must contain letters, numbers, or hyphens.");
			return;
		}
		if (!this.values.description.trim()) {
			this.stepIndex = 1;
			this.syncInputFromState();
			this.setError("Description is required.");
			return;
		}

		this.done({
			name: normalizedName,
			description: this.values.description.trim(),
			allowedTools: [],
			location: "project",
		});
	}

	private getTitle(): string {
		const step = this.currentStep;
		return `${step.title} (${step.optional ? "optional" : "required"})`;
	}

	private getHint(): string {
		return this.currentStep.hint;
	}

	private renderTextStep(): void {
		if (this.currentStep.id === "name") {
			const raw = this.input.getValue().trim();
			const normalized = normalizeSkillName(raw);
			if (raw && normalized && normalized !== raw) {
				this.addChild(new Spacer(1));
				this.addChild(new Text(this.theme.fg("muted", `Will be saved as: ${normalized}`), 1, 0));
			}
		}
	}

	private renderControls(): void {
		const controls = this.stepIndex >= WIZARD_STEPS.length - 1
			? "enter create • alt+← back • alt+→ next • esc cancel"
			: "enter next • alt+← back • alt+→ next • esc cancel";
		this.addChild(new Text(this.theme.fg("dim", controls), 1, 0));
	}

	private renderContent(): void {
		this.clear();
		this.addChild(new DynamicBorder((s) => this.theme.fg("accent", s)));
		this.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.getTitle())), 1, 0));
		this.addChild(new Text(this.theme.fg("dim", this.getHint()), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.renderTextStep();

		if (this.errorMessage) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(this.theme.fg("error", this.errorMessage), 1, 0));
		}

		this.addChild(new Spacer(1));
		this.renderControls();
		this.addChild(new DynamicBorder((s) => this.theme.fg("accent", s)));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.alt("left"))) {
			this.goToPreviousStep();
			return;
		}
		if (matchesKey(data, Key.alt("right"))) {
			this.goToNextStep();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.goToNextStep();
			return;
		}

		this.errorMessage = undefined;
		this.input.handleInput(data);
		this.renderContent();
	}
}

export function normalizeSkillName(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9-\s]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function getTargetDir(ctx: ExtensionContext, location: SkillLocation, skillName: string): string {
	if (location === "global") {
		return join(getAgentDir(), "skills", skillName);
	}
	return resolve(ctx.cwd, ".pi", "skills", skillName);
}

function buildFallbackSkill(answers: SkillCreationAnswers): string {
	const frontmatterLines = [
		"---",
		`name: ${answers.name}`,
		`description: ${answers.description}`,
	];
	if (answers.allowedTools.length > 0) {
		frontmatterLines.push(`allowed-tools: ${answers.allowedTools.join(" ")}`);
	}
	frontmatterLines.push("---");

	const sections = [
		frontmatterLines.join("\n"),
		`# ${answers.name}`,
		"## Core workflow",
		"- Confirm the request matches the skill description and intended trigger conditions.",
		"- Apply the most direct workflow for the task instead of giving generic advice.",
		"- Keep outputs concrete, reusable, and adapted to the current request.",
	];

	if (answers.exampleRequests?.trim()) {
		sections.push("## Example requests", answers.exampleRequests.trim());
	}
	if (answers.domainContext?.trim()) {
		sections.push("## Domain context", answers.domainContext.trim());
	}

	sections.push(
		"## Guidance",
		"- Prefer concrete steps, checks, and deliverables over abstract explanation.",
		"- Reuse provided context and examples, but do not overfit to them.",
		"- Call out important edge cases, constraints, and failure modes when relevant.",
	);

	return sections.join("\n\n").trim() + "\n";
}

function parseSkillDraft(raw: string, expectedName: string): ParsedSkillDraft {
	const parsed = parseFrontmatter<Record<string, unknown>>(raw);
	const name = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name.trim() : "";
	const description = typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description.trim() : "";

	if (!name || !description) {
		throw new Error("Skill must include frontmatter fields 'name' and 'description'");
	}
	if (name !== expectedName) {
		throw new Error(`Frontmatter name must be '${expectedName}'`);
	}

	return {
		name,
		description,
		frontmatter: Object.fromEntries(Object.entries(parsed.frontmatter).filter(([, value]) => value !== undefined)),
		content: stripFrontmatter(raw).trim(),
		raw: raw.trim() + "\n",
	};
}

function getEffectiveReasoningLevel(
	ctx: ExtensionContext,
	thinkingLevel?: SkillCreationThinkingLevel,
): ThinkingLevel | undefined {
	if (!ctx.model?.reasoning || !thinkingLevel || thinkingLevel === "off") {
		return undefined;
	}
	return thinkingLevel;
}

function getGenerationStatusLabel(
	ctx: ExtensionContext,
	thinkingLevel?: SkillCreationThinkingLevel,
): string {
	const modelLabel = ctx.model?.id ?? "template";
	const reasoning = getEffectiveReasoningLevel(ctx, thinkingLevel);
	return reasoning
		? `Generating skill draft using ${modelLabel} • ${reasoning}...`
		: `Generating skill draft using ${modelLabel}...`;
}

async function generateSkillDraft(
	ctx: ExtensionContext,
	answers: SkillCreationAnswers,
	options?: SkillGenerationOptions,
): Promise<string> {
	if (!ctx.model) {
		return buildFallbackSkill(answers);
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) {
		return buildFallbackSkill(answers);
	}

	const userMessage: UserMessage = {
		role: "user",
		content: [{
			type: "text",
			text: [
				"Create a production-ready Pi skill draft.",
				"",
				"Inputs",
				`- skill_slug: ${answers.name}`,
				`- requested_description: ${answers.description}`,
				`- save_location: ${answers.location}`,
				answers.allowedTools.length > 0
					? `- allowed_tools: ${answers.allowedTools.join(" ")}`
					: "- allowed_tools: (omit allowed-tools frontmatter field)",
				`- example_requests: ${answers.exampleRequests?.trim() || "(none provided)"}`,
				`- domain_context: ${answers.domainContext?.trim() || "(none provided)"}`,
				"",
				"Instructions",
				"- Infer the real trigger situations from the requested description and example requests.",
				"- Write a concise, high-signal SKILL.md for Pi.",
				"- Make the description specific enough to help activation.",
				"- Keep the body focused on execution guidance, decision rules, output expectations, and important edge cases.",
				"- Do not invent extra files or capabilities unless explicitly requested.",
				"- If information is missing, make conservative, reusable choices instead of adding placeholders or TODOs.",
			].join("\n"),
		}],
		timestamp: Date.now(),
	};

	const reasoning = getEffectiveReasoningLevel(ctx, options?.thinkingLevel);
	const response = await completeSimple(
		ctx.model,
		{ systemPrompt: GENERATE_SKILL_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, ...(reasoning ? { reasoning } : {}) },
	);

	const generated = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();

	if (!generated) {
		return buildFallbackSkill(answers);
	}

	try {
		parseSkillDraft(generated, answers.name);
		return generated;
	} catch {
		return buildFallbackSkill(answers);
	}
}

async function runDraftGeneration(
	ctx: ExtensionContext,
	answers: SkillCreationAnswers,
	options?: SkillGenerationOptions,
): Promise<string | null> {
	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, getGenerationStatusLabel(ctx, options?.thinkingLevel));
		loader.onAbort = () => done(null);

		generateSkillDraft(ctx, answers, options)
			.then(done)
			.catch(() => done(buildFallbackSkill(answers)));

		return loader;
	});
}

async function collectAnswers(ctx: ExtensionContext): Promise<SkillCreationAnswers | null> {
	const answers = await ctx.ui.custom<SkillCreationAnswers | null>((tui, _theme, _kb, done) => {
		const component = new SkillCreationWizard(ctx.ui.theme, done);
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
	}, { overlay: true, overlayOptions: { width: "70%", maxHeight: "80%", anchor: "center" } });

	return answers;
}

export async function createSkillFromAnswers(
	ctx: ExtensionContext,
	answers: SkillCreationAnswers,
	options?: SkillGenerationOptions,
): Promise<SkillEntry | null> {
	const targetDir = getTargetDir(ctx, answers.location, answers.name);
	const targetPath = join(targetDir, "SKILL.md");
	if (existsSync(targetPath)) {
		ctx.ui.notify(`Skill already exists: ${targetPath}`, "error");
		return null;
	}

	const draft = await runDraftGeneration(ctx, answers, options);
	if (draft === null) {
		ctx.ui.notify("Cancelled", "info");
		return null;
	}

	let parsedSkill: ParsedSkillDraft;
	try {
		parsedSkill = parseSkillDraft(draft, answers.name);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : "Invalid generated SKILL.md", "error");
		return null;
	}

	await mkdir(targetDir, { recursive: true });
	await writeFile(targetPath, parsedSkill.raw, "utf8");

	ctx.ui.notify(`Created skill: ${targetPath}`, "info");
	return {
		name: parsedSkill.name,
		description: parsedSkill.description,
		path: targetPath,
		content: parsedSkill.content,
		frontmatter: parsedSkill.frontmatter,
		scope: answers.location === "global" ? "user" : "project",
		origin: "top-level",
		source: "auto",
		baseDir: targetDir,
	};
}

export async function createNewSkill(
	ctx: ExtensionContext,
	options?: SkillGenerationOptions,
): Promise<SkillEntry | null> {
	const answers = await collectAnswers(ctx);
	if (!answers) return null;
	return await createSkillFromAnswers(ctx, answers, options);
}
