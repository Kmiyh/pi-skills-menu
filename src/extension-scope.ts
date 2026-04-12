import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ExtensionInstallScope } from "./types.js";

function normalizeDir(path: string): string {
	const normalized = resolve(path);
	return normalized.endsWith(sep) ? normalized : normalized + sep;
}

function isWithin(path: string, parent: string): boolean {
	const normalizedPath = normalizeDir(path);
	const normalizedParent = normalizeDir(parent);
	return normalizedPath.startsWith(normalizedParent);
}

export function detectExtensionInstallScope(cwd: string): ExtensionInstallScope {
	const extensionFile = fileURLToPath(import.meta.url);
	const agentDir = getAgentDir();
	const projectPiDir = resolve(cwd, ".pi");

	if (isWithin(extensionFile, projectPiDir)) {
		return "project";
	}

	if (isWithin(extensionFile, agentDir)) {
		return "global";
	}

	return "global";
}
