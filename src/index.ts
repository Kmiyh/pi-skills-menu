import type { ExtensionAPI, ExtensionContext, InputEventResult } from "@mariozechner/pi-coding-agent";
import { createSkillFromAnswersWithoutUI } from "./create-skill.js";
import { deleteSkill } from "./delete-skill.js";
import { detectExtensionInstallScope } from "./extension-scope.js";
import { expandSkillMarkers, hasSkillMarker, insertSkillMarker, removeIncompleteSkillMarkerLines } from "./markers.js";
import { loadSkillRegistry } from "./skill-registry.js";
import { ensureSkillCommandsHidden } from "./settings-toggle.js";
import { setSkillEnabled } from "./skill-enabled-toggle.js";
import type { ExtensionInstallScope, SkillRegistry } from "./types.js";
import { showSkillsManager } from "./ui/skills-manager.js";

const EMPTY_REGISTRY: SkillRegistry = {
	skills: [],
	allSkills: [],
	byName: new Map(),
};

export default function skillsMenuExtension(pi: ExtensionAPI) {
	let registry: SkillRegistry = EMPTY_REGISTRY;
	let currentCwd: string | undefined;
	let installScope: ExtensionInstallScope | undefined;
	let hideChecked = false;
	let pendingReload = false;
	let terminalInputUnsubscribe: (() => void) | undefined;
	let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

	async function refreshRegistry(cwd: string): Promise<SkillRegistry> {
		registry = await loadSkillRegistry(cwd);
		currentCwd = cwd;
		return registry;
	}

	async function maybeHideBuiltinSkillCommands(ctx: ExtensionContext): Promise<boolean> {
		if (hideChecked && currentCwd === ctx.cwd) {
			return false;
		}

		installScope = detectExtensionInstallScope(ctx.cwd);
		hideChecked = true;
		const result = await ensureSkillCommandsHidden(installScope, ctx.cwd);
		if (!result.changed) {
			return false;
		}

		pendingReload = true;
		const reload = (ctx as ExtensionContext & { reload?: () => Promise<void> }).reload;
		if (typeof reload === "function") {
			await reload.call(ctx);
			return true;
		}

		return false;
	}

	function scheduleIncompleteMarkerCleanup(ctx: ExtensionContext): void {
		if (!ctx.hasUI) {
			return;
		}
		if (cleanupTimer) {
			clearTimeout(cleanupTimer);
		}
		cleanupTimer = setTimeout(() => {
			const currentText = ctx.ui.getEditorText();
			const sanitized = removeIncompleteSkillMarkerLines(currentText, registry);
			if (sanitized.changed) {
				ctx.ui.setEditorText(sanitized.text);
			}
		}, 0);
	}

	async function prepareSession(ctx: ExtensionContext): Promise<boolean> {
		const reloaded = await maybeHideBuiltinSkillCommands(ctx);
		if (reloaded) {
			return true;
		}

		try {
			await refreshRegistry(ctx.cwd);
		} catch (error) {
			registry = EMPTY_REGISTRY;
			console.error("skills-menu: failed to load skills registry", error);
		}

		terminalInputUnsubscribe?.();
		if (ctx.hasUI) {
			terminalInputUnsubscribe = ctx.ui.onTerminalInput(() => {
				scheduleIncompleteMarkerCleanup(ctx);
				return undefined;
			});
		}

		return false;
	}

	pi.registerCommand("skills", {
		description: "Browse and insert available skills",
		handler: async (_args, ctx) => {
			if (pendingReload) {
				pendingReload = false;
				await ctx.reload();
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/skills requires interactive mode", "warning");
				return;
			}

			try {
				await refreshRegistry(ctx.cwd);
			} catch (error) {
				console.error("skills-menu: failed to refresh skills registry", error);
				ctx.ui.notify("Failed to load skills list", "error");
				return;
			}

			const selection = await showSkillsManager(ctx, registry, {
				onCreate: async (answers, signal) => await createSkillFromAnswersWithoutUI(ctx, answers, {
					thinkingLevel: pi.getThinkingLevel(),
					signal,
				}),
				onDelete: async (skill) => {
					try {
						return await deleteSkill(ctx, skill);
					} catch (error) {
						console.error("skills-menu: failed to delete skill", error);
						ctx.ui.notify("Failed to delete skill", "error");
						return false;
					}
				},
				onToggle: async (skill, enabled) => {
					try {
						await setSkillEnabled(ctx.cwd, skill, enabled);
					} catch (error) {
						console.error("skills-menu: failed to toggle skill", error);
						throw error instanceof Error ? error : new Error("Failed to update skill visibility");
					}
				},
				onRefresh: async () => await refreshRegistry(ctx.cwd),
			});
			if (!selection) {
				return;
			}
			insertSkillMarker(ctx, selection);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await prepareSession(ctx);
	});

	pi.on("session_shutdown", async () => {
		terminalInputUnsubscribe?.();
		terminalInputUnsubscribe = undefined;
		if (cleanupTimer) {
			clearTimeout(cleanupTimer);
			cleanupTimer = undefined;
		}
	});

	pi.on("input", async (event, ctx): Promise<InputEventResult | void> => {
		if (event.source === "extension") {
			return { action: "continue" };
		}

		if (!hasSkillMarker(event.text)) {
			return { action: "continue" };
		}

		if (!currentCwd || currentCwd !== ctx.cwd || registry.allSkills.length === 0) {
			try {
				await refreshRegistry(ctx.cwd);
			} catch (error) {
				console.error("skills-menu: failed to refresh skills registry for input transform", error);
				return { action: "continue" };
			}
		}

		const expanded = expandSkillMarkers(event.text, registry);
		if (!expanded.changed) {
			return { action: "continue" };
		}

		if (!expanded.insertedSkill && expanded.text.trim().length === 0) {
			ctx.ui.notify("Incomplete skill marker removed", "info");
			return { action: "handled" };
		}

		return {
			action: "transform",
			text: expanded.text,
		};
	});
}
