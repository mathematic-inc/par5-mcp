# par5-mcp

An MCP (Model Context Protocol) server that enables parallel execution of shell commands and AI coding agents across lists of items. Perfect for batch processing files, running linters across multiple targets, or delegating complex tasks to multiple AI agents simultaneously.

## Features

- **List Management**: Create, update, delete, and inspect lists of items (file paths, URLs, identifiers, etc.)
- **Parallel Shell Execution**: Run shell commands across all items in a list with batched parallelism
- **Multi-Agent Orchestration**: Spawn Claude, Gemini, or Codex agents in parallel to process items
- **Streaming Output**: Results stream to files in real-time for monitoring progress
- **Batched Processing**: Commands and agents run in batches of 10 to avoid overwhelming the system

## Installation

```bash
npm install par5-mcp
```

Or install globally:

```bash
npm install -g par5-mcp
```

## Usage

### As an MCP Server

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "par5": {
      "command": "npx",
      "args": ["par5-mcp"]
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "par5": {
      "command": "par5-mcp"
    }
  }
}
```

## Available Tools

### List Management

#### `create_list`

Creates a named list of items for parallel processing.

**Parameters:**
- `items` (string[]): Array of items to store in the list

**Returns:** A unique list ID to use with other tools

**Example:**
```
create_list(items: ["src/a.ts", "src/b.ts", "src/c.ts"])
// Returns: list_id = "abc-123-..."
```

#### `get_list`

Retrieves the items in an existing list by its ID.

**Parameters:**
- `list_id` (string): The list ID returned by `create_list`

#### `update_list`

Updates an existing list by replacing its items with a new array.

**Parameters:**
- `list_id` (string): The list ID to update
- `items` (string[]): The new array of items

#### `delete_list`

Deletes an existing list by its ID.

**Parameters:**
- `list_id` (string): The list ID to delete

#### `list_all_lists`

Lists all existing lists and their item counts.

**Parameters:** None

---

### Parallel Execution

#### `run_shell_across_list`

Executes a shell command for each item in a list. Commands run in batches of 10 parallel processes.

**Parameters:**
- `list_id` (string): The list ID to iterate over
- `command` (string): Shell command with `$item` placeholder

**Variable Substitution:**
- Use `$item` in your command - it will be replaced with each list item (properly shell-escaped)

**Example:**
```
run_shell_across_list(
  list_id: "abc-123",
  command: "wc -l $item"
)
```

This runs `wc -l 'src/a.ts'`, `wc -l 'src/b.ts'`, etc. in parallel.

**Output:**
- stdout and stderr are streamed to separate files per item
- File paths are returned for you to read the results

#### `run_agent_across_list`

Spawns an AI coding agent for each item in a list. Agents run in batches of 10 with a 5-minute timeout per agent.

**Parameters:**
- `list_id` (string): The list ID to iterate over
- `agent` (enum): `"claude"`, `"gemini"`, or `"codex"`
- `prompt` (string): Prompt with `{{item}}` placeholder

**Available Agents:**
| Agent | CLI | Auto-Accept Flag |
|-------|-----|------------------|
| `claude` | Claude Code CLI | `--dangerously-skip-permissions` |
| `gemini` | Google Gemini CLI | `--yolo` |
| `codex` | OpenAI Codex CLI | `--dangerously-bypass-approvals-and-sandbox` |

**Variable Substitution:**
- Use `{{item}}` in your prompt - it will be replaced with each list item

**Example:**
```
run_agent_across_list(
  list_id: "abc-123",
  agent: "claude",
  prompt: "Review {{item}} for security vulnerabilities and suggest fixes"
)
```

**Output:**
- stdout and stderr are streamed to separate files per item
- File paths are returned for you to read the agent outputs

## Workflow Example

Here's a typical workflow for processing multiple files:

1. **Create a list of files to process:**
   ```
   create_list(items: ["src/auth.ts", "src/api.ts", "src/utils.ts"])
   ```

2. **Run a shell command across all files:**
   ```
   run_shell_across_list(
     list_id: "<returned-id>",
     command: "cat $item | grep -n 'TODO'"
   )
   ```

3. **Or delegate to AI agents:**
   ```
   run_agent_across_list(
     list_id: "<returned-id>",
     agent: "claude",
     prompt: "Add comprehensive JSDoc comments to all exported functions in {{item}}"
   )
   ```

4. **Read the output files** to check results

5. **Clean up:**
   ```
   delete_list(list_id: "<returned-id>")
   ```

## Configuration

The following environment variables can be used to configure par5-mcp:

| Variable | Description | Default |
|----------|-------------|---------|
| `PAR5_BATCH_SIZE` | Number of parallel processes per batch | `10` |
| `PAR5_AGENT_ARGS` | Additional arguments passed to all agents | (none) |
| `PAR5_CLAUDE_ARGS` | Additional arguments passed to Claude CLI | (none) |
| `PAR5_GEMINI_ARGS` | Additional arguments passed to Gemini CLI | (none) |
| `PAR5_CODEX_ARGS` | Additional arguments passed to Codex CLI | (none) |
| `PAR5_DISABLE_CLAUDE` | Set to any value to disable the Claude agent | (none) |
| `PAR5_DISABLE_GEMINI` | Set to any value to disable the Gemini agent | (none) |
| `PAR5_DISABLE_CODEX` | Set to any value to disable the Codex agent | (none) |

**Example:**

```json
{
  "mcpServers": {
    "par5": {
      "command": "npx",
      "args": ["par5-mcp"],
      "env": {
        "PAR5_BATCH_SIZE": "20",
        "PAR5_CLAUDE_ARGS": "--model claude-sonnet-4-20250514"
      }
    }
  }
}
```

## Output Files

Results are written to temporary files in the system temp directory under `par5-mcp-results/`:

```
/tmp/par5-mcp-results/<run-id>/
  ├── auth.ts.stdout.txt
  ├── auth.ts.stderr.txt
  ├── api.ts.stdout.txt
  ├── api.ts.stderr.txt
  └── ...
```

File names are derived from the item value (sanitized for filesystem safety).

## Development

### Building from Source

```bash
git clone <repository-url>
cd par5-mcp
npm install
npm run build
```

### Running Locally

```bash
npm start
```

## Requirements

- Node.js 18+
- For `run_agent_across_list`:
  - `claude` agent requires [Claude Code CLI](https://claude.ai/code) installed
  - `gemini` agent requires [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed
  - `codex` agent requires [Codex CLI](https://github.com/openai/codex) installed

## License

ISC
