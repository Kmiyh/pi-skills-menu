import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SkillEntry, SkillRegistry } from "./types.js";

export const SKILL_MARKER_PREFIX = "[skill] ";
const SKILL_MARKER_FRAGMENTS = ["[skill]", "[skill", "[skil", "[ski", "[sk", "skill]"];

export function buildSkillMarker(skillName: string): string {
	return `${SKILL_MARKER_PREFIX}${skillName}`;
}

export function insertSkillMarker(ctx: ExtensionContext, skill: SkillEntry): void {
	ctx.ui.pasteToEditor(`${buildSkillMarker(skill.name)}\n`);
}

function getMarkedSkillName(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith(SKILL_MARKER_PREFIX)) return null;
	const name = trimmed.slice(SKILL_MARKER_PREFIX.length).trim();
	return name.length > 0 ? name : null;
}

function isPotentialSkillMarkerLine(line: string): boolean {
	const trimmed = line.trim().toLowerCase();
	return SKILL_MARKER_FRAGMENTS.some((fragment) => trimmed.startsWith(fragment));
}

function isCompleteSkillMarkerLine(line: string, registry: SkillRegistry): boolean {
	const trimmed = line.trim();
	const skillName = getMarkedSkillName(trimmed);
	if (!skillName) return false;
	return trimmed === buildSkillMarker(skillName) && registry.byName.has(skillName);
}

export function removeIncompleteSkillMarkerLines(
	text: string,
	registry: SkillRegistry,
): { changed: boolean; text: string } {
	const lines = text.split(/\r?\n/);
	let changed = false;
	const keptLines = lines.filter((line) => {
		if (isCompleteSkillMarkerLine(line, registry)) {
			return true;
		}
		if (line.trim().startsWith(SKILL_MARKER_PREFIX) || isPotentialSkillMarkerLine(line)) {
			changed = true;
			return false;
		}
		return true;
	});

	return {
		changed,
		text: keptLines.join("\n"),
	};
}

function buildSingleSkillBlock(skill: SkillEntry): string {
	const relativeHint = skill.baseDir ? `References are relative to ${skill.baseDir}.\n\n` : "";
	return `<skill name="${skill.name}" location="${skill.path}">\n${relativeHint}${skill.content}\n</skill>`;
}

function buildMultiSkillBlock(skills: SkillEntry[]): string {
	const combinedName = skills.map((skill) => skill.name).join(", ");
	const combinedContent = skills
		.map((skill) => {
			const relativeHint = skill.baseDir ? `References are relative to ${skill.baseDir}.\n\n` : "";
			return `## ${skill.name}\n\n${relativeHint}${skill.content}`;
		})
		.join("\n\n---\n\n");
	return `<skill name="${combinedName}" location="multiple">\n${combinedContent}\n</skill>`;
}

export function hasSkillMarker(text: string): boolean {
	return text
		.split(/\r?\n/)
		.some((line) => line.includes(SKILL_MARKER_PREFIX) || isPotentialSkillMarkerLine(line));
}

export function expandSkillMarkers(
	text: string,
	registry: SkillRegistry,
): { changed: boolean; text: string; insertedSkill: boolean } {
	const lines = text.split(/\r?\n/);
	const selectedSkills: SkillEntry[] = [];
	const remainingLines: string[] = [];
	let changed = false;

	for (const line of lines) {
		const skillName = getMarkedSkillName(line);
		if (skillName) {
			const skill = registry.byName.get(skillName);
			changed = true;
			if (skill) {
				selectedSkills.push(skill);
			}
			continue;
		}

		if (isPotentialSkillMarkerLine(line)) {
			changed = true;
			continue;
		}

		remainingLines.push(line);
	}

	if (selectedSkills.length === 0) {
		return {
			changed,
			text: changed ? remainingLines.join("\n").trim() : text,
			insertedSkill: false,
		};
	}

	const skillBlock = selectedSkills.length === 1 ? buildSingleSkillBlock(selectedSkills[0]!) : buildMultiSkillBlock(selectedSkills);
	const userText = remainingLines.join("\n").trim();

	return {
		changed: true,
		text: userText ? `${skillBlock}\n\n${userText}` : skillBlock,
		insertedSkill: true,
	};
}
