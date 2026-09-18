import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { decideWrite, makeWriteGuard, makeWriteGuardHooks } from './writeGuard.js';

const cwd = path.resolve('/work');
const signal = new AbortController().signal;

test('decideWrite: запись в разрешённый файл', () => {
  assert.deepEqual(decideWrite(cwd, ['a.test.js'], 'Write', { file_path: path.join(cwd, 'a.test.js') }), { allow: true });
  assert.deepEqual(decideWrite(cwd, ['a.test.js'], 'Edit', { file_path: 'a.test.js' }), { allow: true });
});

test('decideWrite: чужой файл (например, реализация в red-фазе) запрещён', () => {
  assert.equal(decideWrite(cwd, ['a.test.js'], 'Edit', { file_path: path.join(cwd, 'a.js') }).allow, false);
});

test('decideWrite: выход за workdir, пустой ввод и посторонние инструменты запрещены', () => {
  assert.equal(decideWrite(cwd, ['a.js'], 'Write', { file_path: path.resolve(cwd, '..', 'a.js') }).allow, false);
  assert.equal(decideWrite(cwd, ['a.js'], 'Write', {}).allow, false);
  assert.equal(decideWrite(cwd, ['a.js'], 'Write', null).allow, false);
  assert.equal(decideWrite(cwd, ['a.js'], 'Bash', { command: 'rm -rf /' }).allow, false);
});

test('canUseTool-адаптер: allow пробрасывает ввод, deny объясняет причину', async () => {
  const guard = makeWriteGuard(cwd, ['a.js']);
  const opts = { signal, toolUseID: 'tu-1', requestId: 'rq-1' };
  const input = { file_path: path.join(cwd, 'a.js'), content: 'x' };
  assert.deepEqual(await guard('Write', input, opts), { behavior: 'allow', updatedInput: input });
  const denied = await guard('Write', { file_path: path.join(cwd, 'b.js') }, opts);
  assert.equal(denied?.behavior, 'deny');
});

function preToolUse(toolName: string, toolInput: unknown): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tu-1',
    session_id: 's',
    transcript_path: '',
    cwd,
  } as HookInput;
}

test('PreToolUse-хук: запрещённая запись получает deny, разрешённая передаётся дальше', async () => {
  const [matcher] = makeWriteGuardHooks(cwd, ['a.js']);
  assert.equal(matcher.matcher, 'Write|Edit');
  const hook = matcher.hooks[0];

  const denied = await hook(preToolUse('Write', { file_path: path.join(cwd, 'b.js') }), 'tu-1', { signal });
  assert.ok('hookSpecificOutput' in denied && denied.hookSpecificOutput?.hookEventName === 'PreToolUse');
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason ?? '', /запись в ".*b\.js" запрещена/);
  assert.deepEqual(await hook(preToolUse('Edit', { file_path: path.join(cwd, 'a.js') }), 'tu-1', { signal }), {});
});
