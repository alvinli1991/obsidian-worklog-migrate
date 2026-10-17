import assert from 'node:assert/strict';
import test from 'node:test';
import { planMigration } from '../src/core';

const directory = 'Worklog/';
const options = { copyContent: true, cleanEmptyHeadings: true, historyRecords: false };
const run = (files: Record<string, string>, today = '2026-10-09', overrides = {}) =>
  planMigration(files, today, `${directory}${today.slice(0, 7).replace('-', '')}.md`, { ...options, ...overrides });

test('moves unfinished tasks, retains completed descendants and ordinary Markdown', () => {
  const source = `# 10.08

## 项目 A

### RPC 超时排查

问题描述：

首次请求超时。

- [ ] 排查 RPC 超时 ➕ 2026-10-08 ⏳ 2026-10-12
    - [x] 收集异常日志 ✅ 2026-10-08
    - [ ] 分析线程池
    - [ ] 验证修复方案

参考命令：

\`\`\`bash
jstack <pid>
\`\`\`

## 项目 B

- [x] 完成接口设计 ✅ 2026-10-08
`;
  const result = run({ 'Worklog/202610.md': source });
  const output = result.files['Worklog/202610.md'];
  assert.match(output, /^# 10.09/);
  assert.match(output, /- \[ \] 排查 RPC 超时 ➕ 2026-10-08 ⏳ 2026-10-12\n    - \[ \] 分析线程池/);
  assert.match(output, /# 10.08[\s\S]*- \[x\] 收集异常日志 ✅ 2026-10-08/);
  assert.equal((output.match(/首次请求超时。/g) ?? []).length, 2);
  assert.equal((output.match(/jstack <pid>/g) ?? []).length, 2);
  assert.equal((output.match(/## 项目 B/g) ?? []).length, 1);
  assert.equal(result.movedTasks, 3);
});

test('merges full heading paths and does not duplicate existing content', () => {
  const source = `# 10.09

## 项目 A

- [ ] 今天新增

### 共用标题

已知背景

# 10.08

## 项目 A

### 共用标题

已知背景

- [ ] 昨天任务

## 项目 B

### 共用标题

- [ ] B 项目任务
`;
  const first = run({ 'Worklog/202610.md': source });
  const output = first.files['Worklog/202610.md'];
  assert.equal((output.match(/### 共用标题/g) ?? []).length, 2); // A/B today; copied historical branches are removed
  const today = output.split('# 10.08')[0];
  assert.equal((today.match(/已知背景/g) ?? []).length, 1);
  assert.match(today, /## 项目 A[\s\S]*昨天任务/);
  assert.match(today, /## 项目 B[\s\S]*B 项目任务/);
  const second = run(first.files);
  assert.equal(second.files['Worklog/202610.md'], output);
  assert.equal(second.movedTasks, 0);
  assert.equal(second.changedFiles.length, 0);
});

test('promotes an open child of a completed parent and keeps history', () => {
  const result = run({ 'Worklog/202610.md': `# 10.08

## A

- [x] 父任务 ✅ 2026-10-08
    - [ ] 子任务 ⏳ 2026-10-12
` });
  const [today, history] = result.files['Worklog/202610.md'].split('# 10.08');
  assert.match(today, /^# 10.09[\s\S]*^- \[ \] 子任务 ⏳ 2026-10-12/m);
  assert.match(history, /^- \[x\] 父任务 ✅ 2026-10-08/m);
  assert.doesNotMatch(history, /子任务/);
});

test('does not process a previous month and creates the current month', () => {
  const original = `# 09.25

## A

背景

- [ ] 未完成
`;
  const result = run({ 'Worklog/202609.md': original });
  assert.equal(result.files['Worklog/202610.md'], '# 10.09\n');
  assert.equal(result.files['Worklog/202609.md'], original);
  assert.deepEqual(result.changedFiles, ['Worklog/202610.md']);
});

test('ignores fenced headings and checkboxes, and skips unrelated branches', () => {
  const original = `# 10.08

## A

\`\`\`markdown
# 2026-01-01
- [ ] fake
\`\`\`

- [ ] real

## B

Only notes
`;
  const result = run({ 'Worklog/202610.md': original });
  const today = result.files['Worklog/202610.md'].split('# 10.08')[0];
  assert.match(today, /\`\`\`markdown\n# 2026-01-01\n- \[ \] fake\n\`\`\`/);
  assert.doesNotMatch(today, /## B/);
  assert.equal(result.movedTasks, 1);
});

test('keeps standalone fenced code outside task ownership and copies tables and quotes', () => {
  const source = `# 10.08

## A

| 列 | 值 |
| --- | --- |
| x | y |

> 线索

- [ ] 实际任务

\`\`\`markdown
- [ ] 独立代码示例
\`\`\`
`;
  const result = run({ 'Worklog/202610.md': source });
  const output = result.files['Worklog/202610.md'];
  const [today, history] = output.split('# 10.08');
  assert.match(today, /\| x \| y \|/);
  assert.match(today, /> 线索/);
  assert.match(today, /独立代码示例/);
  assert.doesNotMatch(history, /独立代码示例/);
  assert.doesNotMatch(history, /实际任务/);
});

test('does not interpret Markdown syntax inside multiline HTML comments', () => {
  const source = `# 10.08

## A

<!--
### ghost heading
- [ ] ghost task
-->

- [ ] real task
`;
  const result = run({ 'Worklog/202610.md': source });
  assert.equal(result.movedTasks, 1);
  const [today, history] = result.files['Worklog/202610.md'].split('# 10.08');
  assert.match(today, /ghost task/);
  assert.doesNotMatch(history, /ghost task/);
  assert.doesNotMatch(history, /real task/);
});

test('can leave a plain text deferral record', () => {
  const result = run({ 'Worklog/202610.md': '# 10.08\n\n## A\n\n- [ ] 跟进\n' }, '2026-10-09', { historyRecords: true });
  const history = result.files['Worklog/202610.md'].split('# 10.08')[1];
  assert.match(history, /顺延至 10.09：\n- 跟进/);
  assert.doesNotMatch(history, /\[ \]/);
});

test('merges new child into an existing migrated task', () => {
  const original = `# 10.09

## A

- [ ] 父
    - [ ] 已在今天

# 10.08

## A

- [ ] 父
    - [ ] 已在今天
    - [ ] 新子任务
`;
  const result = run({ 'Worklog/202610.md': original });
  const today = result.files['Worklog/202610.md'].split('# 10.08')[0];
  assert.equal((today.match(/- \[ \] 父/g) ?? []).length, 1);
  assert.equal((today.match(/已在今天/g) ?? []).length, 1);
  assert.match(today, /    - \[ \] 已在今天\n    - \[ \] 新子任务/);
});

test('preserves attached notes when a task already exists today', () => {
  const original = `# 10.09

## A

- [ ] 同一任务

# 10.08

## A

- [ ] 同一任务
    需要保留的任务附注
`;
  const result = run({ 'Worklog/202610.md': original });
  const today = result.files['Worklog/202610.md'].split('# 10.08')[0];
  assert.equal((today.match(/- \[ \] 同一任务/g) ?? []).length, 1);
  assert.match(today, /    需要保留的任务附注/);
});

test('keeps adjacent migrated TODOs adjacent and removes a fully copied historical project', () => {
  const original = '# 10.08\n\n## A\n\n背景说明\n\n- [ ] 第一项\n- [ ] 第二项\n';
  const result = run({ 'Worklog/202610.md': original });
  const [today, history] = result.files['Worklog/202610.md'].split('# 10.08');
  assert.match(today, /- \[ \] 第一项\n- \[ \] 第二项/);
  assert.equal((today.match(/背景说明/g) ?? []).length, 1);
  assert.doesNotMatch(history, /## A|背景说明|第一项|第二项/);
});

test('preserves a blank line between tasks when the source has one', () => {
  const original = '# 10.08\n\n## A\n\n- [ ] 第一项\n\n- [ ] 第二项\n';
  const result = run({ 'Worklog/202610.md': original });
  const today = result.files['Worklog/202610.md'].split('# 10.08')[0];
  assert.match(today, /- \[ \] 第一项\n\n- \[ \] 第二项/);
});

test('keeps completed tasks and their project in history', () => {
  const original = '# 10.08\n\n## A\n\n背景说明\n\n- [x] 已完成\n- [ ] 待迁移\n';
  const result = run({ 'Worklog/202610.md': original });
  const history = result.files['Worklog/202610.md'].split('# 10.08')[1];
  assert.match(history, /## A[\s\S]*背景说明[\s\S]*- \[x\] 已完成/);
  assert.doesNotMatch(history, /待迁移/);
});

test('keeps a historical project with content in an unrelated child branch', () => {
  const original = '# 10.08\n\n## A\n\n### 要迁移的任务\n\n- [ ] 待办\n\n### 独立笔记\n\n只在历史中保存\n';
  const result = run({ 'Worklog/202610.md': original });
  const [today, history] = result.files['Worklog/202610.md'].split('# 10.08');
  assert.match(today, /### 要迁移的任务[\s\S]*待办/);
  assert.doesNotMatch(today, /只在历史中保存/);
  assert.match(history, /## A[\s\S]*### 独立笔记[\s\S]*只在历史中保存/);
});

test('does not delete copied historical content when cleanup is disabled', () => {
  const original = '# 10.08\n\n## A\n\n背景说明\n\n- [ ] 待办\n';
  const result = run({ 'Worklog/202610.md': original }, '2026-10-09', { cleanEmptyHeadings: false });
  const history = result.files['Worklog/202610.md'].split('# 10.08')[1];
  assert.match(history, /## A[\s\S]*背景说明/);
});

test('keeps historical content when ordinary copying is disabled', () => {
  const original = '# 10.08\n\n## A\n\n背景说明\n\n- [ ] 待办\n';
  const result = run({ 'Worklog/202610.md': original }, '2026-10-09', { copyContent: false });
  const history = result.files['Worklog/202610.md'].split('# 10.08')[1];
  assert.match(history, /## A[\s\S]*背景说明/);
});

test('keeps the historical project when deferral records are enabled', () => {
  const original = '# 10.08\n\n## A\n\n背景说明\n\n- [ ] 待办\n';
  const result = run({ 'Worklog/202610.md': original }, '2026-10-09', { historyRecords: true });
  const history = result.files['Worklog/202610.md'].split('# 10.08')[1];
  assert.match(history, /## A[\s\S]*顺延至 10.09：/);
});

test('migrates tab-indented task trees and keeps completed children in history', () => {
  const original = '# 10.08\n\n## A\n\n- [ ] 父任务\n\t- [x] 已完成\n\t- [ ] 待处理\n\t\t- [ ] 深层任务\n';
  const result = run({ 'Worklog/202610.md': original });
  const [today, history] = result.files['Worklog/202610.md'].split('# 10.08');
  assert.match(today, /- \[ \] 父任务\n\t- \[ \] 待处理\n\t\t- \[ \] 深层任务/);
  assert.doesNotMatch(today, /已完成/);
  assert.match(history, /^- \[x\] 已完成/m);
  assert.equal(result.movedTasks, 3);
  assert.deepEqual(result.warnings, []);
});

test('promotes a tab-indented child and its continuation under a completed parent', () => {
  const original = '# 10.08\n\n## A\n\n- [x] 已完成的父任务\n\t- [ ] 待处理子任务\n\t\t任务附注\n';
  const result = run({ 'Worklog/202610.md': original });
  const [today, history] = result.files['Worklog/202610.md'].split('# 10.08');
  assert.match(today, /^- \[ \] 待处理子任务\n    任务附注/m);
  assert.match(history, /- \[x\] 已完成的父任务/);
  assert.doesNotMatch(history, /待处理子任务|任务附注/);
  assert.deepEqual(result.warnings, []);
});

test('uses visual columns for mixed spaces and tabs when merging existing tasks', () => {
  const original = '# 10.09\n\n## A\n\n- [ ] 父任务\n    - [ ] 已有子任务\n\n# 10.08\n\n## A\n\n- [ ] 父任务\n  \t- [ ] 已有子任务\n  \t- [ ] 新子任务\n';
  const result = run({ 'Worklog/202610.md': original });
  const today = result.files['Worklog/202610.md'].split('# 10.08')[0];
  assert.equal((today.match(/父任务/g) ?? []).length, 1);
  assert.equal((today.match(/已有子任务/g) ?? []).length, 1);
  assert.match(today, /新子任务/);
  assert.deepEqual(result.warnings, []);
});

test('skips an incompatible date and continues migrating a valid date', () => {
  const original = '# 10.08\n## A\n- [ ] x\n## A\n\n# 10.07\n\n## B\n\n- [ ] y\n';
  const result = run({ 'Worklog/202610.md': original });
  assert.match(result.files['Worklog/202610.md'], /# 10.09[\s\S]*- \[ \] y/);
  assert.match(result.files['Worklog/202610.md'], /# 10.08\n## A\n- \[ \] x\n## A/);
  assert.equal(result.movedTasks, 1);
  assert.equal(result.warnings.length, 1);
});

test('skips a task structure it cannot safely migrate and keeps other dates working', () => {
  const original = '# 10.08\n## A\n- ordinary\n    - [ ] nested\n\n# 10.07\n## B\n- [ ] safe\n';
  const result = run({ 'Worklog/202610.md': original });
  assert.match(result.files['Worklog/202610.md'], /# 10.09[\s\S]*- \[ \] safe/);
  assert.match(result.files['Worklog/202610.md'], /# 10.08\n## A\n- ordinary\n    - \[ \] nested/);
  assert.equal(result.warnings.length, 1);
});

test('rolls back only the failing date after earlier dates were migrated', () => {
  const original = '# 10.08\n## A\n- [ ] first\n\n# 10.07\n## B\n- [ ] would move\n## C\n- ordinary\n    - [ ] unsafe\n\n# 10.06\n## D\n- [ ] last\n';
  const result = run({ 'Worklog/202610.md': original });
  const output = result.files['Worklog/202610.md'];
  const today = output.split('# 10.08')[0];
  assert.match(today, /first/);
  assert.match(today, /last/);
  assert.doesNotMatch(today, /would move|unsafe/);
  assert.match(output, /# 10.07\n## B\n- \[ \] would move\n## C\n- ordinary\n    - \[ \] unsafe/);
  assert.equal(result.movedTasks, 2);
  assert.equal(result.warnings.length, 1);
});

test('leaves a file with an unclosed fence unchanged and reports why', () => {
  const original = '# 10.08\n## A\n- [ ] x\n```\n';
  const result = run({ 'Worklog/202610.md': original });
  assert.equal(result.files['Worklog/202610.md'], original);
  assert.deepEqual(result.changedFiles, []);
  assert.equal(result.warnings.length, 1);
});

test('recognizes an existing full-date heading without creating another today heading', () => {
  const result = run({ 'Worklog/202610.md': '# 2026-10-09\n\n## A\n\n- [ ] today\n\n# 10.08\n\n## A\n\n- [ ] old\n' });
  const output = result.files['Worklog/202610.md'];
  assert.equal((output.match(/^# (?:2026-10-09|10\.09)$/gm) ?? []).length, 1);
  assert.match(output, /^# 2026-10-09[\s\S]*- \[ \] old/);
});

test('rejects duplicate full and short headings for the same date', () => {
  const result = run({ 'Worklog/202610.md': '# 10.08\n\n# 2026-10-08\n' });
  assert.equal(result.warnings.length, 1);
  assert.match(result.files['Worklog/202610.md'], /# 10.08\n\n# 2026-10-08/);
});

test('rejects a short heading whose month or day conflicts with its file', () => {
  for (const heading of ['09.30', '10.32']) {
    const original = `# ${heading}\n\n- [ ] x\n`;
    const result = run({ 'Worklog/202610.md': original });
    assert.equal(result.warnings.length, 1);
    assert.match(result.files['Worklog/202610.md'], /- \[ \] x/);
  }
});
