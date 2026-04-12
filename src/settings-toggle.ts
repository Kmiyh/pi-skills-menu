import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ExtensionInstallScope } from "./types.js";

export interface SkillCommandSettingResult {
	changed: boolean;
	path: string;
}

export function getSettingsPath(scope: ExtensionInstallScope, cwd: string): string {
	return scope === "global" ? join(getAgentDir(), "settings.json") : resolve(cwd, ".pi", "settings.json");
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
	try {
		const content = await readFile(path, "utf8");
		const parsed = JSON.parse(content);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		throw error;
	}
}

export async function ensureSkillCommandsHidden(scope: ExtensionInstallScope, cwd: string): Promise<SkillCommandSettingResult> {
	const path = getSettingsPath(scope, cwd);
	const settings = await readSettings(path);

	if (settings.enableSkillCommands === false) {
		return { changed: false, path };
	}

	settings.enableSkillCommands = false;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
	return { changed: true, path };
}
