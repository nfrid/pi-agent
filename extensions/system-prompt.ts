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
		nextPrompt += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
	}
	nextPrompt += "</project_context>\n";
	return nextPrompt;
}

function buildSystemPrompt(options: BuildSystemPromptOptions): string {
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

	if (customPrompt) {
		let prompt = customPrompt;
		if (appendSection) {
			prompt += appendSection;
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

	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0
			? visibleTools
					.map((name) => `- ${name}: ${toolSnippets?.[name]}`)
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

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
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
	pi.on("before_agent_start", (event) => ({
		systemPrompt: buildSystemPrompt(event.systemPromptOptions),
	}));
}
