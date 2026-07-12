import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

function formatSkillsForPrompt(
	skills: NonNullable<BuildSystemPromptOptions["skills"]>,
): string {
	if (skills.length === 0) {
		return "";
	}

	const skillEntries = skills
		.map(
			(skill) =>
				`  <skill name="${escapeXml(skill.name)}" path="${escapeXml(skill.filePath)}">\n    ${escapeXml(skill.description)}\n  </skill>`,
		)
		.join("\n");

	return `\n\n<available_skills>\n${skillEntries}\n</available_skills>`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function currentDate(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function appendProjectContext(
	prompt: string,
	contextFiles: NonNullable<BuildSystemPromptOptions["contextFiles"]>,
): string {
	if (contextFiles.length === 0) {
		return prompt;
	}

	let nextPrompt = `${prompt}\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n`;
	for (const { path, content } of contextFiles) {
		nextPrompt += `<project_instructions path="${escapeXml(path)}">\n${content}\n</project_instructions>\n\n`;
	}
	nextPrompt += "</project_context>\n";
	return nextPrompt;
}

function formatPromptInfo(options: BuildSystemPromptOptions): string {
	const contextFiles = options.contextFiles ?? [];
	const skills = options.skills ?? [];
	const tools = options.selectedTools ?? [];

	return [
		`CWD: ${options.cwd}`,
		`Custom prompt: ${options.customPrompt ? "yes" : "no"}`,
		`Appended prompt: ${options.appendSystemPrompt ? "yes" : "no"}`,
		`Active tools: ${tools.length > 0 ? tools.join(", ") : "default"}`,
		`Context files: ${contextFiles.length}`,
		...contextFiles.map((file) => `- ${file.path}`),
		`Skills: ${skills.length}`,
		...skills.map((skill) => `- ${skill.name}: ${skill.filePath}`),
	].join("\n");
}

const BASH_GUIDELINES = [
	"Prefer one composed bash call for dependent deterministic discovery, filtering, aggregation, or validation; run unrelated inspections in parallel.",
	"Keep bash output bounded and relevant using targeted paths, filters, counts, excerpts, diffs, or compact structured summaries.",
	"Use separate calls when results require semantic judgment, and before writes, destructive actions, or scope-expanding work; prefer dedicated read, edit, and write tools for file contents.",
];

function enhanceToolSnippet(name: string, snippet: string): string {
	if (name !== "bash") {
		return snippet;
	}

	return `${snippet} Prefer readable composed pipelines or temporary scripts for deterministic multi-step work, and keep stdout focused because it is added to model context.`;
}

function formatBashGuidance(): string {
	return `\n\nBash guidance:\n${BASH_GUIDELINES.map((guideline) => `- ${guideline}`).join("\n")}`;
}

function buildSystemPrompt(
	options: BuildSystemPromptOptions,
	mode?: string,
): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");
	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const hasBash = tools.includes("bash");

	if (customPrompt) {
		let prompt = customPrompt;
		if (appendSection) {
			prompt += appendSection;
		}
		if (hasBash) {
			prompt += formatBashGuidance();
		}
		prompt = appendProjectContext(prompt, contextFiles);

		const customPromptHasRead =
			!selectedTools || selectedTools.includes("read");
		if (customPromptHasRead) {
			prompt += formatSkillsForPrompt(skills);
		}

		prompt += `\nCurrent date: ${currentDate()}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;
		return prompt;
	}

	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0
			? visibleTools
					.map((name) => {
						const snippet = toolSnippets?.[name];
						return `- ${name}: ${enhanceToolSnippet(name, snippet ?? "")}`;
					})
					.join("\n")
			: "(none)";

	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string) => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	if (hasBash) {
		if (!hasGrep && !hasFind && !hasLs) {
			addGuideline("Use bash for file operations like ls, rg, find");
		}
		for (const guideline of BASH_GUIDELINES) {
			addGuideline(guideline);
		}
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	if (mode && mode !== "tui") {
		addGuideline(
			`Pi is running in ${mode} mode; avoid assuming interactive terminal UI is available.`,
		);
	}

	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");
	const guidelines = guidelinesList
		.map((guideline) => `- ${guideline}`)
		.join("\n");

	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}`;

	if (appendSection) {
		prompt += appendSection;
	}

	prompt = appendProjectContext(prompt, contextFiles);
	if (hasRead) {
		prompt += formatSkillsForPrompt(skills);
	}

	prompt += `\nCurrent date: ${currentDate()}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;
	return prompt;
}

export default function systemPrompt(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const mode = "mode" in ctx ? String(ctx.mode) : undefined;
		return {
			systemPrompt: buildSystemPrompt(event.systemPromptOptions, mode),
		};
	});

	pi.registerCommand("prompt-info", {
		description: "Show current system prompt inputs",
		handler: async (_args, ctx) => {
			const getSystemPromptOptions = (
				ctx as typeof ctx & {
					getSystemPromptOptions?: () => BuildSystemPromptOptions;
				}
			).getSystemPromptOptions;
			if (!getSystemPromptOptions) {
				ctx.ui.notify(
					"This Pi version does not expose system prompt options.",
					"warning",
				);
				return;
			}

			const info = formatPromptInfo(getSystemPromptOptions.call(ctx));
			if (ctx.hasUI) {
				ctx.ui.notify(info, "info");
				return;
			}
			console.log(info);
		},
	});
}
