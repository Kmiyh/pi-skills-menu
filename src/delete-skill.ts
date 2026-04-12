import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SkillEntry } from "./types.js";

export function isDeletableSkill(skill: SkillEntry): boolean {
	return skill.origin === "top-level" && (skill.scope === "project" || skill.scope === "user");
}

export async function deleteSkill(ctx: ExtensionContext, skill: SkillEntry): Promise<boolean> {
	if (!isDeletableSkill(skill)) {
		ctx.ui.notify("Only your own project and global skills can be deleted", "warning");
		return false;
	}

	const targetPath = dirname(skill.path);
	await rm(targetPath, { recursive: true, force: true });
	ctx.ui.notify(`Deleted skill: ${skill.name}`, "info");
	return true;
}
