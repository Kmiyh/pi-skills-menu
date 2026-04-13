import { DefaultPackageManager, getAgentDir, SettingsManager, type ResolvedResource } from "@mariozechner/pi-coding-agent";
import { parseSkillFile } from "./skill-parser.js";
import type { SkillEntry, SkillRegistry } from "./types.js";

function compareSkills(a: SkillEntry, b: SkillEntry): number {
	const scopeRank = (scope: SkillEntry["scope"]) => {
		switch (scope) {
			case "project":
				return 0;
			case "user":
				return 1;
			default:
				return 2;
		}
	};

	const rankDiff = scopeRank(a.scope) - scopeRank(b.scope);
	if (rankDiff !== 0) return rankDiff;

	if (a.origin !== b.origin) {
		return a.origin === "top-level" ? -1 : 1;
	}

	return a.name.localeCompare(b.name);
}

function toSkillEntry(resource: ResolvedResource): SkillEntry | null {
	const parsed = parseSkillFile(resource.path);
	if (!parsed) return null;

	return {
		name: parsed.name,
		description: parsed.description,
		content: parsed.content,
		frontmatter: parsed.frontmatter,
		path: resource.path,
		scope: resource.metadata.scope,
		origin: resource.metadata.origin,
		source: resource.metadata.source,
		baseDir: resource.metadata.baseDir,
		enabled: resource.enabled,
	};
}

function dedupeByPath(skills: SkillEntry[]): SkillEntry[] {
	const seen = new Set<string>();
	const deduped: SkillEntry[] = [];
	for (const skill of skills) {
		if (seen.has(skill.path)) continue;
		seen.add(skill.path);
		deduped.push(skill);
	}
	return deduped;
}

export async function loadSkillRegistry(cwd: string): Promise<SkillRegistry> {
	const settingsManager = SettingsManager.create(cwd, getAgentDir());
	const packageManager = new DefaultPackageManager({
		cwd,
		agentDir: getAgentDir(),
		settingsManager,
	});
	const resolved = await packageManager.resolve();

	const allSkills = dedupeByPath(resolved.skills.map(toSkillEntry).filter((entry): entry is SkillEntry => entry !== null)).sort(compareSkills);
	const byName = new Map<string, SkillEntry>();
	for (const entry of allSkills) {
		if (!entry.enabled) continue;
		if (!byName.has(entry.name)) {
			byName.set(entry.name, entry);
		}
	}

	const skills = Array.from(byName.values()).sort(compareSkills);
	return {
		skills,
		allSkills,
		byName: new Map(skills.map((skill) => [skill.name, skill])),
	};
}
