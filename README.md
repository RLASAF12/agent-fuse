# ⚡ AgentFuse — Financial Circuit Breaker for AI Agents

> **Stop your AI agent before it burns your budget.**
> Drop AgentFuse into any agentic workflow and get hard spending limits — not soft warnings.

---

## Why This Exists

AI agents don't crash. They spend.

Real incidents that triggered this:
- Reddit r/AI_Agents: *"$30K agent loop — implementing financial circuit breakers"*
- LinkedIn viral post: *"AI agent burned $47,000 in a recursive loop for 11 days"*
- Reddit r/SaaS: *"My agent built a runaway retry loop that cost me $700"*
- Towards AI: *"The $12,000 Infinite Loop: How My AI Agent Bankrupted a Sandbox"*
- sanj.dev: *"AI Agents Don't Crash, They Spend" — Claude Code consumed 1.67B tokens in a loop*

Standard LLM providers have no spending guardrails. When an agent loops, you find out on your billing statement.

AgentFuse is an **MCP server** your agents call directly. When the budget runs out, they get a `halt: true` response — not a suggestion, a hard signal to stop.

---

## What's Inside

```
agent-fuse/
├── index.js          # MCP server (stdio transport)
├── sessions.json     # State file — auto-created on first use
├── dashboard.html    # Visual budget dashboard (drag-drop sessions.json)
├── test.js           # Smoke tests (6/6 passing)
└── package.json
```

---

## Quick Start

```bash
# Clone
git clone https://github.com/RLASAF12/agent-fuse.git
cd agent-fuse

# No npm install needed — zero dependencies, pure Node.js
node index.js
```

### Add to your MCP config (Claude Desktop / Cursor / Continue)

```json
{
  "mcpServers": {
    "agent-fuse": {
      "command": "node",
      "args": ["/absolute/path/to/agent-fuse/index.js"]
    }
  }
}
```

---

## The 4 Tools

### `create_budget_session`
Open a budget envelope before starting an agent run.

```json
{
  "session_id": "weekly-research-agent",
  "budget_usd": 0.50,
  "model": "claude-sonnet-4",
  "description": "Scrapes 20 competitor pricing pages"
}
```

### `track_tokens`
Record every API call. Returns `halt: true` the moment the budget is exceeded.

```json
{
  "session_id": "weekly-research-agent",
  "input_tokens": 1500,
  "output_tokens": 300,
  "call_label": "competitor_scrape_step_3"
}
```

**Response when over budget:**
```json
{
  "halt": true,
  "message": "🚨 BUDGET EXCEEDED — HARD HALT. Spent $0.51 of $0.50..."
}
```

### `check_budget`
Check current spend without recording new usage. Call before expensive operations.

### `get_session_report`
Full breakdown: total cost, token counts, call-by-call log, top 5 most expensive calls.

---

## Supported Models (Built-in Pricing)

| Model | Input (per 1M) | Output (per 1M) |
|-------|---------------|-----------------|
| `gpt-4o` | $2.50 | $10.00 |
| `gpt-4o-mini` | $0.15 | $0.60 |
| `claude-sonnet-4` | $3.00 | $15.00 |
| `claude-haiku-4` | $0.80 | $4.00 |
| `claude-opus-4` | $15.00 | $75.00 |
| `gemini-2.5-flash` | $0.075 | $0.30 |
| `gemini-2.5-pro` | $1.25 | $10.00 |
| `deepseek-v3` | $0.27 | $1.10 |
| `llama-3.3-70b` | $0.23 | $0.40 |

Unknown model → falls back to a conservative default. Pass any model name — partial matching works (`claude` → picks closest Claude model).

---

## Dashboard

Open `dashboard.html` in any browser.

Drag-drop your `sessions.json` to visualize:
- Total spend across all sessions
- Budget usage per session (progress bar)
- Halted vs active sessions
- Per-session call counts

Or run a local server: `python3 -m http.server 8080` then visit `http://localhost:8080/dashboard.html` — auto-loads `sessions.json`.

---

## Agent Integration Pattern

```js
// 1. At the start of your agent loop
await mcp.call('create_budget_session', {
  session_id: `run-${Date.now()}`,
  budget_usd: 1.00,
  model: 'claude-sonnet-4',
});

// 2. After every LLM call
const guard = await mcp.call('track_tokens', {
  session_id: currentSessionId,
  input_tokens: response.usage.input_tokens,
  output_tokens: response.usage.output_tokens,
});

if (guard.halt) {
  console.error('Budget exceeded — stopping agent');
  break; // or throw
}

// 3. Before expensive operations
const status = await mcp.call('check_budget', { session_id: currentSessionId });
if (status.halt) return;
```

---

## Run Tests

```bash
node test.js
# ✅ tools/list returns 4 tools
# ✅ create_budget_session OK
# ✅ track_tokens OK
# ✅ check_budget OK
# ✅ HALT triggered correctly at overrun
# ✅ get_session_report OK
# 6 passed, 0 failed
```

---

## License

MIT — use it however you want.

---

*Built by [@RLASAF12](https://github.com/RLASAF12)*
