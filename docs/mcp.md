# MCP

Flame Diff is both an MCP **client** and an MCP **server**. The server is the more interesting
half: it turns this product into a tool provider for other agents.

## Run the server

```bash
flame-diff mcp serve
```

Speaks MCP over **stdio**.

## Connect an agent

```json
{
  "mcpServers": {
    "flame-diff": {
      "command": "flame-diff",
      "args": ["mcp", "serve"]
    }
  }
}
```

## Tools

Every tool is derived from the core registry — there is no second list. Inspect it with:

```bash
flame-diff tools --json
```

```json
[
  {
    "name": "example_tool",
    "description": "One sentence saying what it does and when to use it.",
    "inputSchema": {
      "type": "object",
      "properties": { "value": { "type": "string" } },
      "required": ["value"],
      "additionalProperties": false
    }
  }
]
```

## Rules

1. **A new model-facing CLI command must also ship as an MCP tool.** If an agent can do it
   from the terminal, another agent must be able to do it over MCP.
2. **MCP tools are stateless.** No session state may span calls. Everything persistent goes
   through `packages/memory`.
3. **Tool names must match `^[a-z][a-z0-9_]{0,63}$`.** A core tool named `fs.read` cannot be
   exposed without an explicit mapping, and the server refuses to start rather than renaming
   silently.
4. **Descriptions are written for a model.** Say what it does, when to use it, what it
   returns.

## Errors

Failures come back as an MCP error envelope carrying the stable code:

```json
{ "isError": true, "content": [{ "type": "text", "text": "VALIDATION_FAILED: pattern must not be empty" }] }
```
