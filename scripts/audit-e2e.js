#!/usr/bin/env node
/**
 * E2E log auditor. Runs the E2E tests (real DeepSeek + offline), captures the
 * [E2E] log stream, then flags anomalies so problems surface in a review
 * report instead of hiding in stdout. Run with:
 *   node scripts/audit-e2e.js            # run + audit
 *   node scripts/audit-e2e.js --no-run   # audit from saved log file
 */
const { spawnSync } = require('child_process');
const { readFileSync, writeFileSync } = require('fs');

const files = [
  'tests/core/l5-headless-tools.test.ts',
  'tests/core/l5-real-tools-e2e.test.ts',
  'tests/core/l5-real-e2e.test.ts',
];

const LOG_FILE = '/tmp/mentat-e2e-raw.log';
const runTests = !process.argv.includes('--no-run');
const vaultOnly = process.argv.includes('--vault');

let stdout = '';
if (runTests) {
  console.log('▶ running E2E tests…');
  const res = spawnSync('node', [
    'node_modules/vitest/vitest.mjs', 'run', ...files, '--reporter=dot',
  ], { encoding: 'utf-8', timeout: 240000 });
  stdout = (res.stdout || '') + (res.stderr || '');
  writeFileSync(LOG_FILE, stdout);
} else if (vaultOnly) {
  stdout = ''; // vault audit only — no E2E raw log required
} else {
  stdout = readFileSync(LOG_FILE, 'utf-8');
}

// ── parse [E2E] lines ─────────────────────────────────────────────────────
const e2e = stdout.split('\n').filter((l) => l.startsWith('[E2E]'));
const findings = [];
const info = [];

const KNOWN_TOOLS = new Set(['vault_read', 'vault_write', 'vault_list', 'vault_search', 'web_fetch', 'web_search', 'ask_user']);
const REQUIRED = { vault_read: ['path'], vault_write: ['path', 'content'], vault_search: ['query'], web_search: ['query'], web_fetch: ['url'] };

let advertised = []; // accumulated across tests
let assistant = '';
let lastTool = null;
const calls = []; // {name,args}

for (const l of e2e) {
  if (l.includes('tools advertised')) {
    const j = l.slice(l.indexOf('→') + 1).trim();
    try { advertised = JSON.parse(j); } catch { /* ignore */ }
    // schema audit
    for (const t of advertised) {
      const p = t.parameters || {};
      if (!p.type) findings.push(`SCHEMA: tool "${t.name}" advertised WITHOUT parameters.type`);
      const need = REQUIRED[t.name];
      if (need) {
        for (const r of need) {
          if (!(p.required || []).includes(r)) findings.push(`SCHEMA: "${t.name}" missing required param "${r}"`);
        }
      }
    }
  } else if (l.includes('TOOL CALL')) {
    const name = l.match(/TOOL CALL → (\S+)/)?.[1];
    const argsStr = l.includes('args=') ? l.slice(l.indexOf('args=') + 5) : '{}';
    let args = {};
    try { args = JSON.parse(argsStr); } catch { args = { raw: argsStr }; }
    calls.push({ name, args });
    if (!KNOWN_TOOLS.has(name)) findings.push(`TOOL: model called UNKNOWN tool "${name}"`);
    const need = REQUIRED[name];
    if (need && Object.keys(args).length === 0) findings.push(`ARGS: "${name}" called with EMPTY args (needs ${need.join(',')})`);
    if (need) for (const r of need) if (args[r] === undefined) findings.push(`ARGS: "${name}" missing "${r}"`);
  } else if (l.includes('TOOL RESULT')) {
    const m = l.match(/TOOL RESULT ← (\S+) isError= (true|false)/);
    if (!m) continue;
    const [, name, isError] = m;
    lastTool = name;
    if (isError === 'true') {
      const err = l.match(/result= (.+)$/)?.[1];
      findings.push(`TOOL ERROR: "${name}" failed → ${err || 'no error text'}`);
    } else {
      // check empty result & absolute paths
      const resStr = l.slice(l.indexOf('result=') + 7);
      try {
        const res = JSON.parse(resStr);
        const data = res.data;
        if (Array.isArray(data) && data.length === 0) findings.push(`EMPTY: "${name}" returned [] (no data) — is a store/service missing?`);
        if (Array.isArray(data)) for (const d of data) {
          if (d.path && d.path.startsWith('/')) findings.push(`PATH: "${name}" returned ABSOLUTE path "${d.path}" (should be vault-relative)`);
        }
      } catch { /* not json */ }
    }
  } else if (l.includes('ASSISTANT =')) {
    assistant = l.slice(l.indexOf('ASSISTANT =') + 11).trim();
    if (!assistant) findings.push('ANSWER: final assistant text was EMPTY');
  } else if (l.includes('EVENTS =')) {
    // event-anomaly audit
    const ev = l.slice(l.indexOf('EVENTS =') + 8).trim();
    if (!ev.includes('"agent:end"')) findings.push('EVENTS: run did not finish with agent:end');
    const starts = (ev.match(/"tool:start"/g) || []).length;
    const ends = (ev.match(/"tool:end"/g) || []).length;
    if (starts !== ends) findings.push(`EVENTS: unbalanced tool events (start=${starts}, end=${ends})`);
  }
}

// cross-test: advertised tools were present at all
if (advertised.length === 0) findings.push('ADVERTISE: no "tools advertised" captured — provider may not have been called');

// ── report ────────────────────────────────────────────────────────────────
if (!vaultOnly) {
  console.log('\n════════ E2E LOG AUDIT ════════');
  console.log(`tests run: ${files.length} files · log lines: ${e2e.length}`);
  console.log(`tool calls captured: ${calls.length}`);
  console.log(`tools advertised (last run): ${advertised.map((t) => t.name).join(', ') || '(none)'}`);
  console.log('\n── findings ──');
  if (findings.length === 0) {
    console.log('  ✅ no anomalies detected');
  } else {
    for (const f of findings) console.log('  ⚠', f);
  }
  console.log('\n── tool call summary ──');
  for (const c of calls) console.log(`  ${c.name} ${JSON.stringify(c.args)}`);
  console.log('\n── assistant answers ──');
  for (const l of e2e) if (l.includes('ASSISTANT =')) console.log('  ', l.slice(l.indexOf('ASSISTANT =') + 11).slice(0, 160));
  console.log('\n(raw log saved to', LOG_FILE, ')');
}

// ── vault-log audit mode: node scripts/audit-e2e.js --vault <dir> ─────────
function auditVaultLogs(dir) {
  const { readdirSync } = require('fs');
  const { join } = require('path');
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f)); }
  catch { console.error('cannot read', dir); return; }
  const vf = [];
  for (const f of files) {
    let lines = [];
    try { lines = readFileSync(f, 'utf-8').split('\n').filter(Boolean); } catch { continue; }
    for (const raw of lines) {
      let d; try { d = JSON.parse(raw); } catch { continue; }
      const msg = (d.message || '') + ((d.errorChain && d.errorChain[0] && d.errorChain[0].message) || '');
      const name = d.name || '';
      vf.push({ ts: d.ts, level: d.level, name, msg });
    }
  }
  vf.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  console.log(`\n════════ VAULT LOG AUDIT (${dir}) ════════`);
  console.log(`entries: ${vf.length}`);
  console.log('── errors (level=error) ──');
  const errs = vf.filter((e) => e.level === 'error');
  if (!errs.length) console.log('  ✅ no errors');
  for (const e of errs.slice(-15)) console.log(`  ${String(e.ts).slice(11, 19)} [${e.name}] ${e.msg.slice(0, 140)}`);
  console.log('── agent-loop stalls (start w/o end) ──');
  const starts = vf.filter((e) => /run start:/.test(e.msg));
  const ends = vf.filter((e) => /run end:/.test(e.msg));
  console.log(`  runs: ${starts.length} start · ${ends.length} end · diff ${starts.length - ends.length} (nonzero = possible stall)`);
  const empty = vf.filter((e) => /run start: 0 messages/.test(e.msg));
  if (empty.length) console.log(`  ⚠ ${empty.length} run(s) with 0 messages (user message may have been dropped)`);
  const zeroTool = vf.filter((e) => /generate done.*toolCalls=0/.test(e.msg));
  if (zeroTool.length) console.log(`  ${zeroTool.length} turn(s) with toolCalls=0`);
  const bad = vf.filter((e) => /400 Empty input messages/.test(e.msg));
  if (bad.length) console.log(`  ⚠ ${bad.length} x "400 Empty input messages"`);
  const emb = vf.filter((e) => /embedding|No embedding/.test(e.msg));
  if (emb.length) console.log(`  ⚠ ${emb.length} embedding-related errors`);
  // ── chat-view UI trace (does the renderer receive agent events?) ──
  const chat = vf.filter((e) => (e.name || '').includes('chat-view'));
  if (chat.length) {
    console.log('── chat-view (UI) trace ──');
    for (const e of chat.slice(-20)) console.log(`  ${String(e.ts).slice(11, 19)} ${e.msg.slice(0, 120)}`);
  } else {
    console.log('── chat-view (UI) trace: ⚠ NONE — events may not reach the UI renderer');
  }
  const sent = chat.filter((e) => e.msg.includes('send new-arch'));
  const final = chat.filter((e) => e.msg.includes('finalize'));
  const failed = chat.filter((e) => e.msg.includes('send failed'));
  const msgUpd = chat.filter((e) => e.msg.includes('event:message:update'));
  console.log(`  sends: ${sent.length} · message:update events: ${msgUpd.length} · finalize: ${final.length} · send failed: ${failed.length}`);
  console.log('');
}

if (process.argv.includes('--vault')) {
  const i = process.argv.indexOf('--vault');
  auditVaultLogs(process.argv[i + 1] || '/mnt/data/obsidian/.obsidian/plugins/mentat/logs');
}

if (!vaultOnly) process.exit(findings.length === 0 ? 0 : 1);
