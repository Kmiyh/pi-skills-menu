export type ExtensionInstallScope = "global" | "project";

export interface SkillEntry {
	name: string;
	description: string;
	path: string;
	content: string;
	frontmatter?: Record<string, unknown>;
	scope: "user" | "project" | "temporary";
	origin: "package" | "top-level";
	source: string;
	baseDir?: string;
}

export interface SkillRegistry {
	skills: SkillEntry[];
	byName: Map<string, SkillEntry>;
}
