import { dirname, join, relative } from "node:path";
import { getAgentDir, SettingsManager, type PackageSource } from "@mariozechner/pi-coding-agent";
import type { SkillEntry } from "./types.js";

function updatePatterns(current: string[], pattern: string, enabled: boolean): string[] {
	const updated = current.filter((entry) => {
		const stripped = entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-") ? entry.slice(1) : entry;
		return stripped !== pattern;
	});
	updated.push(`${enabled ? "+" : "-"}${pattern}`);
	return updated;
}

function getTopLevelPattern(skill: SkillEntry, cwd: string): string {
	const baseDir = skill.scope === "project" ? join(cwd, ".pi") : getAgentDir();
	return relative(baseDir, skill.path);
}

function getPackagePattern(skill: SkillEntry): string {
	const baseDir = skill.baseDir ?? dirname(skill.path);
	return relative(baseDir, skill.path);
}

function hasPackageFilters(pkg: Exclude<PackageSource, string>): boolean {
	return pkg.extensions !== undefined || pkg.skills !== undefined || pkg.prompts !== undefined || pkg.themes !== undefined;
}

export async function setSkillEnabled(cwd: string, skill: SkillEntry, enabled: boolean): Promise<void> {
	if (skill.scope === "temporary") {
		throw new Error("Temporary skills cannot be toggled.");
	}

	const settingsManager = SettingsManager.create(cwd, getAgentDir());

	if (skill.origin === "top-level") {
		const settings = skill.scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
		const current = [...(settings.skills ?? [])];
		const updated = updatePatterns(current, getTopLevelPattern(skill, cwd), enabled);

		if (skill.scope === "project") {
			settingsManager.setProjectSkillPaths(updated);
		} else {
			settingsManager.setSkillPaths(updated);
		}
		await settingsManager.flush();
		return;
	}

	const settings = skill.scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
	const packages = [...(settings.packages ?? [])];
	const packageIndex = packages.findIndex((pkg) => (typeof pkg === "string" ? pkg : pkg.source) === skill.source);
	if (packageIndex === -1) {
		throw new Error("Could not find the package settings entry for this skill.");
	}

	const packageEntry = packages[packageIndex];
	const packageConfig = typeof packageEntry === "string" ? { source: packageEntry } : { ...packageEntry };
	const current = [...(packageConfig.skills ?? [])];
	const updated = updatePatterns(current, getPackagePattern(skill), enabled);
	packageConfig.skills = updated.length > 0 ? updated : undefined;
	packages[packageIndex] = hasPackageFilters(packageConfig) ? packageConfig : packageConfig.source;

	if (skill.scope === "project") {
		settingsManager.setProjectPackages(packages);
	} else {
		settingsManager.setPackages(packages);
	}
	await settingsManager.flush();
}
