import { readFileSync } from "node:fs";
import { parseFrontmatter, stripFrontmatter } from "@mariozechner/pi-coding-agent";
import type { SkillEntry } from "./types.js";

interface SkillFrontmatter {
	name?: unknown;
	description?: unknown;
	[key: string]: unknown;
}

export function parseSkillFile(path: string): Pick<SkillEntry, "name" | "description" | "content" | "frontmatter"> | null {
	try {
		const raw = readFileSync(path, "utf8");
		const { frontmatter } = parseFrontmatter<SkillFrontmatter>(raw);
		const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
		const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";

		if (!name || !description) {
			return null;
		}

		return {
			name,
			description,
			content: stripFrontmatter(raw).trim(),
			frontmatter: Object.fromEntries(Object.entries(frontmatter).filter(([, value]) => value !== undefined)),
		};
	} catch {
		return null;
	}
}
