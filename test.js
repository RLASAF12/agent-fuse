#!/usr/bin/env node
/**
 * Quick smoke test for AgentFuse
 * Run: node test.js
 */
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, 'sessions.json');

// Clean state
if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);

const server = spawn('node', [join(__dirname, 'index.js')], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
const pending = new Map();
let idCounter = 1;

server.stdout.on('data', chunk => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const res = JSON.parse(line);
    if (pending.has(res.id)) {
      const { resolve } = pending.get(res.id);
      pending.delete(res.id);
      resolve(res);
    }
  }
});

function send(method, params) {
  const id = idCounter++;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function run() {
  let pass = 0; let fail = 0;

  // Init
  await send('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test' } });

  // List tools
  const list = await send('tools/list', {});
  const tools = list.result.tools.map(t => t.name);
  console.assert(tools.includes('create_budget_session'), 'FAIL: missing create_budget_session'); pass++;
  console.log('✅ tools/list returns 4 tools:', tools.join(', '));

  // Create session
  const c = await send('tools/call', { name: 'create_budget_session', arguments: { session_id: 'test-run-1', budget_usd: 0.01, model: 'gpt-4o', description: 'Smoke test' } });
  const cr = JSON.parse(c.result.content[0].text);
  if (cr.ok) { console.log('✅ create_budget_session OK'); pass++; }
  else { console.log('❌ create_budget_session FAIL:', cr); fail++; }

  // Track small amount (50% of budget)
  const t1 = await send('tools/call', { name: 'track_tokens', arguments: { session_id: 'test-run-1', input_tokens: 1000, output_tokens: 500, call_label: 'step_1' } });
  const tr1 = JSON.parse(t1.result.content[0].text);
  if (tr1.ok && !tr1.halt) { console.log('✅ track_tokens OK, cost:', tr1.this_call_cost_usd); pass++; }
  else { console.log('❌ track_tokens step_1 FAIL:', tr1); fail++; }

  // Check budget
  const cb = await send('tools/call', { name: 'check_budget', arguments: { session_id: 'test-run-1' } });
  const cbr = JSON.parse(cb.result.content[0].text);
  if (cbr.ok && cbr.status === 'active') { console.log('✅ check_budget OK, used:', cbr.used_pct + '%'); pass++; }
  else { console.log('❌ check_budget FAIL:', cbr); fail++; }

  // Overshoot budget → expect HALT
  const t2 = await send('tools/call', { name: 'track_tokens', arguments: { session_id: 'test-run-1', input_tokens: 500000, output_tokens: 200000, call_label: 'runaway_loop' } });
  const tr2 = JSON.parse(t2.result.content[0].text);
  if (tr2.halt === true) { console.log('✅ HALT triggered correctly at overrun'); pass++; }
  else { console.log('❌ HALT not triggered — FAIL:', tr2); fail++; }

  // Report
  const rpt = await send('tools/call', { name: 'get_session_report', arguments: { session_id: 'test-run-1' } });
  const rr = JSON.parse(rpt.result.content[0].text);
  if (rr.ok && rr.status === 'halted' && rr.total_calls === 2) {
    console.log('✅ get_session_report OK, total calls:', rr.total_calls, 'total cost: $' + rr.total_cost_usd);
    pass++;
  } else { console.log('❌ get_session_report FAIL:', rr); fail++; }

  console.log(`\n${pass} passed, ${fail} failed`);
  server.stdin.end();
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 200);
}

run().catch(e => { console.error(e); process.exit(1); });
