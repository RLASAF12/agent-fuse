#!/usr/bin/env node
/**
 * AgentFuse — Financial Circuit Breaker MCP Server
 * Stops AI agents from burning your budget with hard spending limits.
 * 
 * Tools:
 *   create_budget_session  — open a new budget envelope
 *   track_tokens           — record token usage for a session
 *   check_budget           — get spend status (and HALT if over limit)
 *   get_session_report     — full breakdown of a session
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'sessions.json');

// ─── Model pricing table (USD per 1M tokens) ─────────────────────────────────
const MODEL_PRICING = {
  'gpt-4o':                   { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':              { input: 0.15,  output: 0.60  },
  'gpt-4-turbo':              { input: 10.00, output: 30.00 },
  'claude-opus-4':            { input: 15.00, output: 75.00 },
  'claude-sonnet-4':          { input: 3.00,  output: 15.00 },
  'claude-haiku-4':           { input: 0.80,  output: 4.00  },
  'claude-3-5-sonnet':        { input: 3.00,  output: 15.00 },
  'claude-3-opus':            { input: 15.00, output: 75.00 },
  'gemini-2.5-flash':         { input: 0.075, output: 0.30  },
  'gemini-2.5-pro':           { input: 1.25,  output: 10.00 },
  'gemini-1.5-pro':           { input: 1.25,  output: 5.00  },
  'gemini-1.5-flash':         { input: 0.075, output: 0.30  },
  'llama-3.3-70b':            { input: 0.23,  output: 0.40  },
  'llama-3.1-8b':             { input: 0.05,  output: 0.08  },
  'mistral-large':            { input: 2.00,  output: 6.00  },
  'qwen-2.5-72b':             { input: 0.35,  output: 0.40  },
  'deepseek-v3':              { input: 0.27,  output: 1.10  },
  'default':                  { input: 1.00,  output: 3.00  },
};

function getPrice(model) {
  const key = model ? model.toLowerCase() : 'default';
  for (const [k, v] of Object.entries(MODEL_PRICING)) {
    if (key.includes(k)) return v;
  }
  return MODEL_PRICING['default'];
}

function calcCost(model, inputTokens, outputTokens) {
  const price = getPrice(model);
  return (inputTokens / 1_000_000) * price.input
       + (outputTokens / 1_000_000) * price.output;
}

// ─── State persistence ────────────────────────────────────────────────────────
function loadState() {
  if (!existsSync(STATE_FILE)) return { sessions: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { sessions: {} }; }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ─── Tool handlers ────────────────────────────────────────────────────────────
function createBudgetSession({ session_id, budget_usd, model, description }) {
  if (!session_id)  throw new Error('session_id is required');
  if (!budget_usd || isNaN(Number(budget_usd))) throw new Error('budget_usd must be a number');

  const state = loadState();
  if (state.sessions[session_id]) {
    return { ok: false, error: `Session '${session_id}' already exists. Use a different ID or reset it.` };
  }

  const session = {
    session_id,
    budget_usd: Number(budget_usd),
    model: model || 'unknown',
    description: description || '',
    created_at: new Date().toISOString(),
    total_cost_usd: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    calls: [],
    status: 'active',
    halted_at: null,
  };

  state.sessions[session_id] = session;
  saveState(state);

  return {
    ok: true,
    session_id,
    budget_usd: session.budget_usd,
    model: session.model,
    message: `Budget session created. Hard limit: $${budget_usd}. Tracking model: ${session.model}.`,
  };
}

function trackTokens({ session_id, input_tokens, output_tokens, call_label }) {
  if (!session_id) throw new Error('session_id is required');

  const state = loadState();
  const session = state.sessions[session_id];
  if (!session) return { ok: false, error: `Session '${session_id}' not found. Create it first with create_budget_session.` };

  if (session.status === 'halted') {
    return {
      ok: false,
      halt: true,
      error: `HALT: Session '${session_id}' is already over budget. Budget: $${session.budget_usd.toFixed(4)}, Spent: $${session.total_cost_usd.toFixed(4)}. No further calls allowed.`,
    };
  }

  const inp = Number(input_tokens || 0);
  const out = Number(output_tokens || 0);
  const cost = calcCost(session.model, inp, out);

  const callRecord = {
    ts: new Date().toISOString(),
    label: call_label || `call_${session.calls.length + 1}`,
    input_tokens: inp,
    output_tokens: out,
    cost_usd: cost,
  };

  session.calls.push(callRecord);
  session.total_input_tokens += inp;
  session.total_output_tokens += out;
  session.total_cost_usd += cost;

  const remaining = session.budget_usd - session.total_cost_usd;
  const pct = (session.total_cost_usd / session.budget_usd * 100).toFixed(1);

  if (session.total_cost_usd >= session.budget_usd) {
    session.status = 'halted';
    session.halted_at = new Date().toISOString();
    saveState(state);
    return {
      ok: false,
      halt: true,
      session_id,
      this_call_cost_usd: cost,
      total_cost_usd: session.total_cost_usd,
      budget_usd: session.budget_usd,
      overage_usd: Math.abs(remaining),
      message: `🚨 BUDGET EXCEEDED — HARD HALT. Spent $${session.total_cost_usd.toFixed(4)} of $${session.budget_usd} budget (${pct}%). Agent must stop immediately.`,
    };
  }

  // Warning at 80%
  const warning = session.total_cost_usd >= session.budget_usd * 0.8;

  saveState(state);
  return {
    ok: true,
    halt: false,
    session_id,
    this_call_cost_usd: cost,
    total_cost_usd: session.total_cost_usd,
    budget_usd: session.budget_usd,
    remaining_usd: remaining,
    used_pct: pct,
    warning: warning ? `⚠️ WARNING: ${pct}% of budget used ($${remaining.toFixed(4)} remaining)` : null,
    message: `Tracked ${inp} input + ${out} output tokens. This call: $${cost.toFixed(6)}. Total: $${session.total_cost_usd.toFixed(4)}/${session.budget_usd} (${pct}%).`,
  };
}

function checkBudget({ session_id }) {
  if (!session_id) throw new Error('session_id is required');

  const state = loadState();
  const session = state.sessions[session_id];
  if (!session) return { ok: false, error: `Session '${session_id}' not found.` };

  const remaining = session.budget_usd - session.total_cost_usd;
  const pct = (session.total_cost_usd / session.budget_usd * 100).toFixed(1);

  if (session.status === 'halted') {
    return {
      ok: false,
      halt: true,
      session_id,
      status: 'halted',
      budget_usd: session.budget_usd,
      total_cost_usd: session.total_cost_usd,
      overage_usd: Math.abs(remaining),
      halted_at: session.halted_at,
      calls: session.calls.length,
      message: `🚨 HALTED. Over budget by $${Math.abs(remaining).toFixed(4)}. ${session.calls.length} calls made.`,
    };
  }

  return {
    ok: true,
    halt: false,
    session_id,
    status: session.status,
    budget_usd: session.budget_usd,
    total_cost_usd: session.total_cost_usd,
    remaining_usd: remaining,
    used_pct: pct,
    calls: session.calls.length,
    model: session.model,
    created_at: session.created_at,
    message: `Budget OK. $${session.total_cost_usd.toFixed(4)} spent of $${session.budget_usd} (${pct}%). $${remaining.toFixed(4)} remaining. ${session.calls.length} API calls.`,
  };
}

function getSessionReport({ session_id }) {
  if (!session_id) throw new Error('session_id is required');

  const state = loadState();
  const session = state.sessions[session_id];
  if (!session) return { ok: false, error: `Session '${session_id}' not found.` };

  const pct = (session.total_cost_usd / session.budget_usd * 100).toFixed(1);
  const avgCostPerCall = session.calls.length
    ? (session.total_cost_usd / session.calls.length).toFixed(6)
    : '0.000000';

  const topCalls = [...session.calls]
    .sort((a, b) => b.cost_usd - a.cost_usd)
    .slice(0, 5)
    .map(c => ({ label: c.label, cost_usd: c.cost_usd.toFixed(6), ts: c.ts }));

  return {
    ok: true,
    session_id,
    description: session.description,
    status: session.status,
    model: session.model,
    created_at: session.created_at,
    halted_at: session.halted_at,
    budget_usd: session.budget_usd,
    total_cost_usd: session.total_cost_usd,
    remaining_usd: session.budget_usd - session.total_cost_usd,
    used_pct: pct,
    total_input_tokens: session.total_input_tokens,
    total_output_tokens: session.total_output_tokens,
    total_calls: session.calls.length,
    avg_cost_per_call_usd: avgCostPerCall,
    top_5_expensive_calls: topCalls,
    all_calls: session.calls,
  };
}

// ─── MCP Protocol (stdio) ─────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'create_budget_session',
    description: 'Open a new budget envelope for an agent run. Call this at the start of any agentic task. Returns session_id you use in subsequent calls.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id:   { type: 'string',  description: 'Unique ID for this agent run (e.g. "web-scraper-2024-01-15")' },
        budget_usd:   { type: 'number',  description: 'Hard spending limit in USD. Agent halts when this is reached.' },
        model:        { type: 'string',  description: 'Model name (e.g. "gpt-4o", "claude-sonnet-4", "gemini-2.5-flash"). Used for automatic cost calculation.' },
        description:  { type: 'string',  description: 'Human-readable description of what this agent does.' },
      },
      required: ['session_id', 'budget_usd'],
    },
  },
  {
    name: 'track_tokens',
    description: 'Record token usage for one API call. Returns current spend, remaining budget, and a HALT signal (halt=true) if the budget is exceeded. STOP IMMEDIATELY when halt=true.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id:     { type: 'string',  description: 'Session ID from create_budget_session' },
        input_tokens:   { type: 'number',  description: 'Input/prompt tokens for this call' },
        output_tokens:  { type: 'number',  description: 'Output/completion tokens for this call' },
        call_label:     { type: 'string',  description: 'Optional label (e.g. "search_step_3", "summarize_page")' },
      },
      required: ['session_id', 'input_tokens', 'output_tokens'],
    },
  },
  {
    name: 'check_budget',
    description: 'Check current spend status without recording new usage. Returns halt=true if already over budget. Call this at the start of any expensive operation.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID to check' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'get_session_report',
    description: 'Get a full breakdown of a session: total cost, token counts, call-by-call log, top expensive calls.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID to report on' },
      },
      required: ['session_id'],
    },
  },
];

function handleRequest(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-fuse', version: '1.0.0' },
      },
    };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    try {
      let result;
      if (name === 'create_budget_session') result = createBudgetSession(args);
      else if (name === 'track_tokens')      result = trackTokens(args);
      else if (name === 'check_budget')      result = checkBudget(args);
      else if (name === 'get_session_report') result = getSessionReport(args);
      else throw new Error(`Unknown tool: ${name}`);

      return {
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: result.ok === false && result.halt === true,
        },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }],
          isError: true,
        },
      };
    }
  }

  if (method === 'notifications/initialized') return null;

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// stdio transport
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const req = JSON.parse(trimmed);
      const res = handleRequest(req);
      if (res !== null) process.stdout.write(JSON.stringify(res) + '\n');
    } catch (e) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32700, message: `Parse error: ${e.message}` },
      }) + '\n');
    }
  }
});

process.stdin.on('end', () => process.exit(0));
