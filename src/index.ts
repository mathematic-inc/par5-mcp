#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import generatePassphrase from "eff-diceware-passphrase";
import { z } from "zod";

// Helper to create a safe filename from an item string
function toSafeFilename(item: string): string {
	// Get basename if it's a path
	const name = basename(item);
	// Replace unsafe characters with underscores
	return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

interface OutputFiles {
	stdout: string;
	stderr: string;
}

// Batch size for parallel execution (configurable via PAR5_BATCH_SIZE env var)
const BATCH_SIZE = parseInt(process.env.PAR5_BATCH_SIZE || "10", 10);

// Helper to run a command and stream stdout/stderr to separate files
// Returns a promise that resolves when the command completes
function runCommandToFiles(
	command: string,
	stdoutFile: string,
	stderrFile: string,
	options: { timeout?: number } = {},
): Promise<void> {
	return new Promise((resolve) => {
		(async () => {
			const stdoutHandle = await open(stdoutFile, "w");
			const stderrHandle = await open(stderrFile, "w");
			const stdoutStream = stdoutHandle.createWriteStream();
			const stderrStream = stderrHandle.createWriteStream();

			const child = spawn("sh", ["-c", command], {
				stdio: ["ignore", "pipe", "pipe"],
			});

			let timeoutId: NodeJS.Timeout | undefined;
			if (options.timeout) {
				timeoutId = setTimeout(() => {
					child.kill("SIGTERM");
				}, options.timeout);
			}

			child.stdout.pipe(stdoutStream);
			child.stderr.pipe(stderrStream);

			child.on("close", async () => {
				if (timeoutId) clearTimeout(timeoutId);
				stdoutStream.end();
				stderrStream.end();
				await stdoutHandle.close();
				await stderrHandle.close();
				resolve();
			});

			child.on("error", async (err) => {
				if (timeoutId) clearTimeout(timeoutId);
				stderrStream.write(`\nERROR: ${err.message}\n`);
				stdoutStream.end();
				stderrStream.end();
				await stdoutHandle.close();
				await stderrHandle.close();
				resolve();
			});
		})();
	});
}

// Helper to run commands in batches
async function runInBatches(
	tasks: Array<{
		command: string;
		stdoutFile: string;
		stderrFile: string;
		timeout?: number;
	}>,
): Promise<void> {
	for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
		const batch = tasks.slice(i, i + BATCH_SIZE);
		await Promise.all(
			batch.map((task) =>
				runCommandToFiles(task.command, task.stdoutFile, task.stderrFile, {
					timeout: task.timeout,
				}),
			),
		);
	}
}

// Create output directory for results
const outputDir = join(tmpdir(), "par5-mcp-results");

// Store for lists
const lists = new Map<string, string[]>();

// Generate a unique diceware list ID (3 words joined with hyphens)
function generateListId(): string {
	const words = generatePassphrase(3);
	let id = words.join("-");

	// Ensure uniqueness by appending more words if needed
	while (lists.has(id)) {
		const extraWord = generatePassphrase(1)[0];
		id = `${id}-${extraWord}`;
	}

	return id;
}

// Create the MCP server
const server = new McpServer({
	name: "par5-mcp",
	version: "1.0.0",
});

// Tool: create_list
server.registerTool(
	"create_list",
	{
		description: `Creates a named list of items for parallel processing. Use this tool when you need to perform the same operation across multiple files, URLs, or any collection of items.

WHEN TO USE:
- Before running shell commands or AI agents across multiple items
- When you have a collection of file paths, URLs, identifiers, or any strings to process in parallel

WORKFLOW:
1. Call create_list with your array of items
2. Use the returned list_id with run_shell_across_list or run_agent_across_list
3. The list persists for the duration of the session

EXAMPLE: To process files ["src/a.ts", "src/b.ts", "src/c.ts"], first create a list, then use run_shell_across_list or run_agent_across_list with the returned id.`,
		inputSchema: {
			items: z
				.array(z.string())
				.describe(
					"Array of items to store in the list. Each item can be a file path, URL, identifier, or any string that will be substituted into commands or prompts.",
				),
		},
	},
	async ({ items }) => {
		const id = generateListId();
		lists.set(id, items);
		return {
			content: [
				{
					type: "text",
					text: `Successfully created a list with ${items.length} items. The list ID is "${id}". You can now use this ID with run_shell_across_list or run_agent_across_list to process each item in parallel. The commands will run in the background and stream output to files. After starting the commands, you should sleep briefly and then read the output files to check results.`,
				},
			],
		};
	},
);

// Tool: create_list_from_shell
server.registerTool(
	"create_list_from_shell",
	{
		description: `Creates a list by running a shell command and parsing its newline-delimited output.

WHEN TO USE:
- When you need to create a list from command output (e.g., find, ls, grep, git ls-files)
- When the list of items to process is determined by a shell command
- As an alternative to manually specifying items in create_list

EXAMPLES:
- "find src -name '*.ts'" to get all TypeScript files
- "git ls-files '*.tsx'" to get all tracked TSX files
- "ls *.json" to get all JSON files in current directory
- "grep -l 'TODO' src/**/*.ts" to get files containing TODO

WORKFLOW:
1. Call create_list_from_shell with your command
2. The command's stdout is split by newlines to create list items
3. Empty lines are filtered out
4. Use the returned list_id with run_shell_across_list or run_agent_across_list`,
		inputSchema: {
			command: z
				.string()
				.describe(
					"Shell command to run. Its stdout will be split by newlines to create list items. Example: 'find src -name \"*.ts\"' or 'git ls-files'",
				),
		},
	},
	async ({ command }) => {
		return new Promise((resolve) => {
			const child = spawn("sh", ["-c", command], {
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";

			child.stdout.on("data", (data: Buffer) => {
				stdout += data.toString();
			});

			child.stderr.on("data", (data: Buffer) => {
				stderr += data.toString();
			});

			child.on("close", (code) => {
				if (code !== 0 && stderr) {
					resolve({
						content: [
							{
								type: "text",
								text: `Error: Command exited with code ${code}.\n\nstderr:\n${stderr}`,
							},
						],
						isError: true,
					});
					return;
				}

				// Split by newlines and filter out empty lines
				const items = stdout
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line.length > 0);

				if (items.length === 0) {
					resolve({
						content: [
							{
								type: "text",
								text: `Warning: Command produced no output. No list was created.${stderr ? `\n\nstderr:\n${stderr}` : ""}`,
							},
						],
					});
					return;
				}

				const id = generateListId();
				lists.set(id, items);

				resolve({
					content: [
						{
							type: "text",
							text: `Successfully created a list with ${items.length} items from command output. The list ID is "${id}". You can now use this ID with run_shell_across_list or run_agent_across_list to process each item in parallel.${stderr ? `\n\nNote: Command produced stderr output:\n${stderr}` : ""}`,
						},
					],
				});
			});

			child.on("error", (err) => {
				resolve({
					content: [
						{
							type: "text",
							text: `Error: Failed to execute command: ${err.message}`,
						},
					],
					isError: true,
				});
			});
		});
	},
);

// Tool: get_list
server.registerTool(
	"get_list",
	{
		description: `Retrieves the items in an existing list by its ID.

WHEN TO USE:
- To inspect the contents of a list before processing
- To verify which items are in a list
- To check if a list exists`,
		inputSchema: {
			list_id: z.string().describe("The list ID returned by create_list."),
		},
	},
	async ({ list_id }) => {
		const items = lists.get(list_id);
		if (!items) {
			return {
				content: [
					{
						type: "text",
						text: `Error: No list found with ID "${list_id}". The list may have been deleted or the ID is incorrect.`,
					},
				],
				isError: true,
			};
		}

		const itemList = items.map((item, i) => `${i + 1}. ${item}`).join("\n");

		return {
			content: [
				{
					type: "text",
					text: `List "${list_id}" contains ${items.length} items:\n\n${itemList}`,
				},
			],
		};
	},
);

// Tool: update_list
server.registerTool(
	"update_list",
	{
		description: `Updates an existing list by replacing its items with a new array.

WHEN TO USE:
- To modify the contents of an existing list
- To add or remove items from a list
- To reorder items in a list`,
		inputSchema: {
			list_id: z.string().describe("The list ID returned by create_list."),
			items: z
				.array(z.string())
				.describe(
					"The new array of items to replace the existing list contents.",
				),
		},
	},
	async ({ list_id, items }) => {
		if (!lists.has(list_id)) {
			return {
				content: [
					{
						type: "text",
						text: `Error: No list found with ID "${list_id}". The list may have been deleted or the ID is incorrect. Use create_list to create a new list.`,
					},
				],
				isError: true,
			};
		}

		const oldCount = lists.get(list_id)?.length;
		lists.set(list_id, items);

		return {
			content: [
				{
					type: "text",
					text: `Successfully updated list "${list_id}". Changed from ${oldCount} items to ${items.length} items.`,
				},
			],
		};
	},
);

// Tool: delete_list
server.registerTool(
	"delete_list",
	{
		description: `Deletes an existing list by its ID.

WHEN TO USE:
- To clean up lists that are no longer needed
- To free up memory after processing is complete`,
		inputSchema: {
			list_id: z.string().describe("The list ID returned by create_list."),
		},
	},
	async ({ list_id }) => {
		if (!lists.has(list_id)) {
			return {
				content: [
					{
						type: "text",
						text: `Error: No list found with ID "${list_id}". The list may have already been deleted or the ID is incorrect.`,
					},
				],
				isError: true,
			};
		}

		const itemCount = lists.get(list_id)?.length;
		lists.delete(list_id);

		return {
			content: [
				{
					type: "text",
					text: `Successfully deleted list "${list_id}" which contained ${itemCount} items.`,
				},
			],
		};
	},
);

// Tool: list_all_lists
server.registerTool(
	"list_all_lists",
	{
		description: `Lists all existing lists and their item counts.

WHEN TO USE:
- To see all available lists in the current session
- To find a list ID you may have forgotten
- To check how many lists exist`,
		inputSchema: {},
	},
	async () => {
		if (lists.size === 0) {
			return {
				content: [
					{
						type: "text",
						text: "No lists exist. Use create_list to create a new list.",
					},
				],
			};
		}

		const listInfo = Array.from(lists.entries())
			.map(([id, items]) => `- "${id}": ${items.length} items`)
			.join("\n");

		return {
			content: [
				{
					type: "text",
					text: `Found ${lists.size} list(s):\n\n${listInfo}`,
				},
			],
		};
	},
);

// Tool: run_shell_across_list
server.registerTool(
	"run_shell_across_list",
	{
		description: `Executes a shell command for each item in a previously created list. Commands run in batches of ${BATCH_SIZE} parallel processes, with stdout and stderr streamed to separate files.

WHEN TO USE:
- Running the same shell command across multiple files (e.g., linting, formatting, compiling)
- Batch processing with command-line tools
- Any operation where you need to execute shell commands on a collection of items

HOW IT WORKS:
1. Each item in the list is substituted into the command where $item appears
2. Commands run in batches of ${BATCH_SIZE} at a time to avoid overwhelming the system
3. Output streams directly to files as the commands execute
4. This tool waits for all commands to complete before returning

AFTER COMPLETION:
- Read the stdout files to check results
- Check stderr files if you encounter errors or unexpected output
- Files are named based on the item (e.g., "myfile.ts.stdout.txt")

VARIABLE SUBSTITUTION:
- Use $item in your command - it will be replaced with each list item (properly shell-escaped)
- Example: "cat $item" becomes "cat 'src/file.ts'" for item "src/file.ts"`,
		inputSchema: {
			list_id: z
				.string()
				.describe(
					"The list ID returned by create_list. This identifies which list of items to iterate over.",
				),
			command: z
				.string()
				.describe(
					"Shell command to execute for each item. Use $item as a placeholder - it will be replaced with the current item value (properly escaped). Example: 'wc -l $item' or 'cat $item | grep TODO'",
				),
		},
	},
	async ({ list_id, command }) => {
		const items = lists.get(list_id);
		if (!items) {
			return {
				content: [
					{
						type: "text",
						text: `Error: No list found with ID "${list_id}". Please call create_list first to create a list of items, then use the returned ID with this tool.`,
					},
				],
				isError: true,
			};
		}

		// Create output directory
		const runId = randomUUID();
		const runDir = join(outputDir, runId);
		await mkdir(runDir, { recursive: true });

		const results: Array<{ item: string; files: OutputFiles }> = [];
		const tasks: Array<{
			command: string;
			stdoutFile: string;
			stderrFile: string;
		}> = [];

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			// Replace $item with the actual item value (properly escaped)
			const escapedItem = item.replace(/'/g, "'\\''");
			const expandedCommand = command.replace(/\$item/g, `'${escapedItem}'`);

			const safeFilename = toSafeFilename(item);
			const stdoutFile = join(runDir, `${safeFilename}.stdout.txt`);
			const stderrFile = join(runDir, `${safeFilename}.stderr.txt`);

			tasks.push({
				command: expandedCommand,
				stdoutFile,
				stderrFile,
			});

			results.push({
				item,
				files: { stdout: stdoutFile, stderr: stderrFile },
			});
		}

		// Run commands in batches of 10
		await runInBatches(tasks);

		// Build prose response
		const fileList = results
			.map(
				(r) =>
					`- ${r.item}: stdout at "${r.files.stdout}", stderr at "${r.files.stderr}"`,
			)
			.join("\n");

		const numBatches = Math.ceil(items.length / BATCH_SIZE);

		return {
			content: [
				{
					type: "text",
					text: `Completed ${results.length} shell commands in ${numBatches} batch(es) of up to ${BATCH_SIZE} parallel commands each. Output has been streamed to files.

OUTPUT FILES:
${fileList}

NEXT STEPS:
1. Read the stdout files to check the results of each command
2. If there are errors, check the corresponding stderr files for details

All commands have completed and output files are ready to read.`,
				},
			],
		};
	},
);

// Determine which agents are enabled based on PAR5_DISABLE_* env vars
const ALL_AGENTS = ["claude", "gemini", "codex"] as const;
const ENABLED_AGENTS = ALL_AGENTS.filter((agent) => {
	const disableVar = `PAR5_DISABLE_${agent.toUpperCase()}`;
	return !process.env[disableVar];
});

// Tool: run_agent_across_list (only registered if at least one agent is enabled)
if (ENABLED_AGENTS.length > 0) {
	const agentDescriptions: Record<string, string> = {
		claude:
			"claude: Claude Code CLI (uses --dangerously-skip-permissions for autonomous operation)",
		gemini: "gemini: Google Gemini CLI (uses --yolo for auto-accept)",
		codex:
			"codex: OpenAI Codex CLI (uses --dangerously-bypass-approvals-and-sandbox for autonomous operation)",
	};

	const availableAgentsDoc = ENABLED_AGENTS.map(
		(a) => `- ${agentDescriptions[a]}`,
	).join("\n");

	server.registerTool(
		"run_agent_across_list",
		{
			description: `Spawns an AI coding agent for each item in a previously created list. Agents run in batches of ${BATCH_SIZE} parallel processes with automatic permission skipping enabled.

WHEN TO USE:
- Performing complex code analysis, refactoring, or generation across multiple files
- Tasks that require AI reasoning rather than simple shell commands
- When you need to delegate work to multiple AI agents working in parallel

AVAILABLE AGENTS:
${availableAgentsDoc}

HOW IT WORKS:
1. Each item in the list is substituted into the prompt where {{item}} appears
2. Agents run in batches of ${BATCH_SIZE} at a time to avoid overwhelming the system
3. Each agent has a 5-minute timeout
4. Output streams directly to files as the agents work
5. This tool waits for all agents to complete before returning

AFTER COMPLETION:
- Read the stdout files to check the results from each agent
- Check stderr files if you encounter errors
- Files are named based on the item (e.g., "myfile.ts.stdout.txt")

VARIABLE SUBSTITUTION:
- Use {{item}} in your prompt - it will be replaced with each list item
- Example: "Review {{item}} for bugs" becomes "Review src/file.ts for bugs" for item "src/file.ts"`,
			inputSchema: {
				list_id: z
					.string()
					.describe(
						"The list ID returned by create_list. This identifies which list of items to iterate over.",
					),
				agent: z
					.enum(ENABLED_AGENTS as unknown as [string, ...string[]])
					.describe(
						`Which AI agent to use: ${ENABLED_AGENTS.map((a) => `'${a}'`).join(", ")}. All agents run with permission-skipping flags for autonomous operation.`,
					),
				prompt: z
					.string()
					.describe(
						"The prompt to send to each agent. Use {{item}} as a placeholder - it will be replaced with the current item value. Example: 'Review {{item}} and suggest improvements' or 'Add error handling to {{item}}'",
					),
			},
		},
		async ({ list_id, agent, prompt }) => {
			const items = lists.get(list_id);
			if (!items) {
				return {
					content: [
						{
							type: "text",
							text: `Error: No list found with ID "${list_id}". Please call create_list first to create a list of items, then use the returned ID with this tool.`,
						},
					],
					isError: true,
				};
			}

			// Create output directory
			const runId = randomUUID();
			const runDir = join(outputDir, runId);
			await mkdir(runDir, { recursive: true });

			const results: Array<{ item: string; files: OutputFiles }> = [];
			const tasks: Array<{
				command: string;
				stdoutFile: string;
				stderrFile: string;
				timeout: number;
			}> = [];

			// Build the agent command with skip permission flags and streaming output
			// Additional args can be passed via PAR5_AGENT_ARGS (all agents) or PAR5_CLAUDE_ARGS, PAR5_GEMINI_ARGS, PAR5_CODEX_ARGS (per-agent)
			const getAgentCommand = (
				agentName: string,
				expandedPrompt: string,
			): string => {
				const escapedPrompt = expandedPrompt.replace(/'/g, "'\\''");
				const agentArgs = process.env.PAR5_AGENT_ARGS || "";

				switch (agentName) {
					case "claude": {
						// Claude Code CLI with --dangerously-skip-permissions and streaming output
						const claudeArgs = process.env.PAR5_CLAUDE_ARGS || "";
						return `claude --dangerously-skip-permissions --output-format stream-json --verbose ${agentArgs} ${claudeArgs} -p '${escapedPrompt}'`;
					}
					case "gemini": {
						// Gemini CLI with yolo mode and streaming JSON output
						const geminiArgs = process.env.PAR5_GEMINI_ARGS || "";
						return `gemini --yolo --output-format stream-json ${agentArgs} ${geminiArgs} '${escapedPrompt}'`;
					}
					case "codex": {
						// Codex CLI exec subcommand with full-auto flag and JSON streaming output
						const codexArgs = process.env.PAR5_CODEX_ARGS || "";
						return `codex exec --dangerously-bypass-approvals-and-sandbox ${agentArgs} ${codexArgs} '${escapedPrompt}'`;
					}
					default:
						throw new Error(`Unknown agent: ${agentName}`);
				}
			};

			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				// Replace {{item}} with the actual item value
				const expandedPrompt = prompt.replace(/\{\{item\}\}/g, item);

				const safeFilename = toSafeFilename(item);
				const stdoutFile = join(runDir, `${safeFilename}.stdout.txt`);
				const stderrFile = join(runDir, `${safeFilename}.stderr.txt`);

				tasks.push({
					command: getAgentCommand(agent, expandedPrompt),
					stdoutFile,
					stderrFile,
					timeout: 300000, // 5 minute timeout per item
				});

				results.push({
					item,
					files: { stdout: stdoutFile, stderr: stderrFile },
				});
			}

			// Run agents in batches of 10
			await runInBatches(tasks);

			// Build prose response
			const fileList = results
				.map(
					(r) =>
						`- ${r.item}: stdout at "${r.files.stdout}", stderr at "${r.files.stderr}"`,
				)
				.join("\n");

			const agentNames: Record<string, string> = {
				claude: "Claude Code",
				gemini: "Google Gemini",
				codex: "OpenAI Codex",
			};

			const numBatches = Math.ceil(items.length / BATCH_SIZE);

			return {
				content: [
					{
						type: "text",
						text: `Completed ${results.length} ${agentNames[agent]} agents in ${numBatches} batch(es) of up to ${BATCH_SIZE} parallel agents each. Output has been streamed to files.

OUTPUT FILES:
${fileList}

NEXT STEPS:
1. Read the stdout files to check the results from each agent
2. If there are errors, check the corresponding stderr files for details

All agents have completed (with a 5-minute timeout per agent) and output files are ready to read.`,
					},
				],
			};
		},
	);
}

// Start the server
async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch(console.error);
