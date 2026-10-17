/** Pure, line-preserving migration planner. No Obsidian APIs are used here. */
export interface MigrationOptions {
  copyContent: boolean;
  cleanEmptyHeadings: boolean;
  historyRecords: boolean;
}

export interface MigrationPlan {
  files: Record<string, string>;
  movedTasks: number;
  copiedBlocks: number;
  changedFiles: string[];
  warnings: string[];
}

interface Section {
  heading: string;
  title: string;
  level: number;
  body: string[];
  children: Section[];
  parent?: Section;
  raw?: string[];
  unsafe?: boolean;
}

interface Document {
  preamble: string[];
  dates: Section[];
  eol: string;
  warnings: string[];
  fatal?: boolean;
}

interface Task {
  line: number;
  text: string;
  indent: number;
  done: boolean;
  parent?: Task;
  children: Task[];
  own: number[];
}

interface TaskBody {
  roots: Task[];
  owner: Array<Task | undefined>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHORT_DATE = /^(\d{2})\.(\d{2})$/;
const MONTH_FILE = /^\d{6}\.md$/;
const TASK_LINE = /^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/;
const LIST_LINE = /^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

export class UnsafeMarkdownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeMarkdownError';
  }
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function dateFromHeading(title: string, path: string): string {
  const filename = path.split('/').pop()!;
  const year = filename.slice(0, 4);
  const month = filename.slice(4, 6);
  const short = SHORT_DATE.exec(title);
  const date = short ? `${year}-${short[1]}-${short[2]}` : title;
  if (!validDate(date)) throw new UnsafeMarkdownError(`${path} 含无效日期标题：${title}`);
  if (date.slice(0, 7).replace('-', '') !== filename.slice(0, 6)) {
    throw new UnsafeMarkdownError(`${path} 中的日期 ${title} 与月份文件不符`);
  }
  return date;
}

function shortDate(date: string): string {
  return `${date.slice(5, 7)}.${date.slice(8, 10)}`;
}

function indentOf(line: string): number {
  const whitespace = /^[ \t]*/.exec(line)?.[0] ?? '';
  let columns = 0;
  for (const character of whitespace) columns += character === '\t' ? 4 - columns % 4 : 1;
  return columns;
}

function shiftIndent(line: string, delta: number): string {
  if (delta === 0 || !line.trim()) return line;
  const original = indentOf(line);
  if (original + delta < 0) throw new UnsafeMarkdownError('任务附属内容无法安全取消缩进');
  const prefixLength = /^[ \t]*/.exec(line)![0].length;
  return ' '.repeat(original + delta) + line.slice(prefixLength);
}

function headingAt(line: string): { level: number; title: string } | undefined {
  const match = HEADING.exec(line);
  if (!match) return;
  const title = match[2].replace(/[ \t]+#+[ \t]*$/, '').trim();
  if (!title) return;
  return { level: match[1].length, title };
}

function parseDocument(path: string, text: string): Document {
  if (!MONTH_FILE.test(path.split('/').pop() ?? '')) throw new UnsafeMarkdownError(`文件名不符合 YYYYMM.md：${path}`);
  if (/\r(?!\n)/.test(text) || (text.includes('\r\n') && /(?<!\r)\n/.test(text))) {
    throw new UnsafeMarkdownError(`${path} 含混合或不支持的换行符`);
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(eol) : [];
  const doc: Document = { preamble: [], dates: [], eol, warnings: [] };
  const stack: Section[] = [];
  let fence: { char: string; length: number } | undefined;
  let comment = false;
  let activeDate: Section | undefined;
  for (const line of lines) {
    activeDate?.raw?.push(line);
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      (stack.at(-1)?.body ?? doc.preamble).push(line);
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) fence = undefined;
      continue;
    }
    if (comment) {
      (stack.at(-1)?.body ?? doc.preamble).push(line);
      if (line.includes('-->')) comment = false;
      continue;
    }
    if (line.includes('<!--')) {
      (stack.at(-1)?.body ?? doc.preamble).push(line);
      if (!line.includes('-->')) comment = true;
      continue;
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      (stack.at(-1)?.body ?? doc.preamble).push(line);
      continue;
    }
    const heading = headingAt(line);
    if (heading?.level === 1) {
      activeDate?.raw?.pop();
      stack.length = 0;
      let date: string;
      let unsafe = false;
      try {
        date = dateFromHeading(heading.title, path);
      } catch (error) {
        date = '';
        unsafe = true;
        doc.warnings.push(`${path} 的「${heading.title}」已跳过：${String(error)}`);
      }
      const previous = date ? doc.dates.find((item) => item.title === date) : undefined;
      if (previous) {
        previous.unsafe = true;
        unsafe = true;
        doc.warnings.push(`${path} 的「${heading.title}」重复，两个日期区域均已跳过`);
      }
      activeDate = { heading: line, title: date, level: 1, body: [], children: [], raw: [line], unsafe };
      doc.dates.push(activeDate);
      stack.push(activeDate);
      continue;
    }
    if (activeDate?.unsafe) continue;
    if (!heading) {
      (stack.at(-1)?.body ?? doc.preamble).push(line);
      continue;
    }
    if (!stack.length) {
      doc.preamble.push(line);
      doc.warnings.push(`${path} 的「${heading.title}」位于日期标题之前，已保留原文`);
      continue;
    }
    while (stack.length && stack.at(-1)!.level >= heading.level) stack.pop();
    const parent = stack.at(-1);
    if (!parent) {
      activeDate!.unsafe = true;
      doc.warnings.push(`${path} 的「${activeDate!.heading}」含无法归属的标题，已跳过`);
      continue;
    }
    if (parent.children.some((child) => child.title === heading.title && child.level === heading.level)) {
      activeDate!.unsafe = true;
      doc.warnings.push(`${path} 的「${activeDate!.heading}」含重复标题「${heading.title}」，已跳过`);
      continue;
    }
    const section: Section = { heading: line, title: heading.title, level: heading.level, body: [], children: [], parent };
    parent.children.push(section);
    stack.push(section);
  }
  if (fence || comment) {
    doc.fatal = true;
    doc.warnings.push(`${path} 含未闭合代码块或 HTML 注释，无法安全确定日期边界，整个文件已跳过`);
  }
  return doc;
}

function renderSection(section: Section, result: string[]): void {
  if (section.unsafe && section.raw) {
    result.push(...section.raw);
    return;
  }
  result.push(section.heading, ...section.body);
  for (const child of section.children) renderSection(child, result);
}

function renderDocument(doc: Document): string {
  const lines = [...doc.preamble];
  for (const date of doc.dates) renderSection(date, lines);
  return lines.join(doc.eol);
}

function parseTasks(body: string[]): TaskBody {
  const owner: Array<Task | undefined> = new Array(body.length);
  const roots: Task[] = [];
  const stack: Task[] = [];
  let fence: { char: string; length: number } | undefined;
  let fenceOwner: Task | undefined;
  let comment = false;
  let nonTaskListIndent: number | undefined;
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (fenceOwner) { owner[i] = fenceOwner; fenceOwner.own.push(i); }
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) {
        fence = undefined;
        fenceOwner = undefined;
      }
      continue;
    }
    if (comment) {
      if (line.includes('-->')) comment = false;
      continue;
    }
    if (line.includes('<!--')) {
      if (!line.includes('-->')) comment = true;
      stack.length = 0;
      nonTaskListIndent = undefined;
      continue;
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      const current = stack.at(-1);
      if (current && indentOf(line) > current.indent) {
        fenceOwner = current;
        owner[i] = current;
        current.own.push(i);
      } else {
        stack.length = 0;
        nonTaskListIndent = undefined;
      }
      continue;
    }
    const match = TASK_LINE.exec(line);
    if (match) {
      const indent = indentOf(line);
      while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
      if (nonTaskListIndent !== undefined && indent > nonTaskListIndent) {
        throw new UnsafeMarkdownError('未完成任务嵌套在普通列表项下，无法安全迁移');
      }
      if (!stack.length && indent > 3) throw new UnsafeMarkdownError('存在无法确定父级的缩进任务');
      const parent = stack.at(-1);
      const task: Task = { line: i, text: line.slice(match[1].length), indent, done: match[2].toLowerCase() === 'x', parent, children: [], own: [i] };
      (parent?.children ?? roots).push(task);
      stack.push(task);
      owner[i] = task;
      nonTaskListIndent = undefined;
      continue;
    }
    const listMatch = LIST_LINE.exec(line);
    if (listMatch && stack.length) {
      const indent = indentOf(line);
      if (indent <= stack.at(-1)!.indent) stack.length = 0;
      else nonTaskListIndent = indent;
    }
    if (!line.trim()) {
      const current = stack.at(-1);
      if (current) { owner[i] = current; current.own.push(i); }
      continue;
    }
    const current = stack.at(-1);
    if (current && indentOf(line) > current.indent) {
      owner[i] = current;
      current.own.push(i);
    } else {
      stack.length = 0;
      nonTaskListIndent = undefined;
    }
  }
  return { roots, owner };
}

function hasOpen(section: Section): boolean {
  const tasks = parseTasks(section.body);
  if (tasks.owner.some((task) => task && !task.done)) return true;
  return section.children.some(hasOpen);
}

function taskIndentMap(roots: Task[], keepDone: boolean): Map<Task, number> {
  const map = new Map<Task, number>();
  const visit = (node: Task, keptParent?: Task): void => {
    if (node.done === keepDone) {
      map.set(node, keptParent ? map.get(keptParent)! + Math.max(2, node.indent - (node.parent?.indent ?? 0)) : 0);
      keptParent = node;
    }
    node.children.forEach((child) => visit(child, keptParent));
  };
  roots.forEach((root) => visit(root));
  return map;
}

function trimBlock(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}

function appendBlock(section: Section, lines: string[]): void {
  const block = trimBlock(lines);
  if (!block.length) return;
  while (section.body.length && !section.body.at(-1)!.trim()) section.body.pop();
  if (section.body.length) section.body.push('');
  section.body.push(...block, '');
}

function blankLinesBefore(body: string[], index: number): number {
  let count = 0;
  for (let i = index - 1; i >= 0 && !body[i].trim(); i--) count++;
  return count;
}

function appendTask(section: Section, lines: string[], sourceGap: number, joinsPreviousTask: boolean): void {
  const taskLines = trimBlock(lines);
  if (!taskLines.length) return;
  if (joinsPreviousTask) {
    while (section.body.length && !section.body.at(-1)!.trim()) section.body.pop();
    section.body.push(...Array(sourceGap).fill(''));
  } else if (!section.body.length) {
    section.body.push(...Array(sourceGap).fill(''));
  }
  section.body.push(...taskLines);
}

function copyOrdinary(source: Section, target: Section, parsed: TaskBody): number {
  let copied = 0;
  let block: string[] = [];
  const flush = (): void => {
    const clean = trimBlock(block);
    block = [];
    if (!clean.length) return;
    const snippet = clean.join('\n');
    if (!target.body.join('\n').includes(snippet)) {
      appendBlock(target, clean);
      copied++;
    }
  };
  for (let i = 0; i < source.body.length; i++) {
    if (parsed.owner[i]) flush();
    else block.push(source.body[i]);
  }
  flush();
  return copied;
}

function subtreeLines(node: Task, body: string[], baseIndent: number, keepDone: boolean): string[] {
  const entries: Array<{ index: number; line: string }> = [];
  const visit = (current: Task, desiredIndent: number): void => {
    if (current.done === keepDone) {
      for (const index of current.own) entries.push({ index, line: shiftIndent(body[index], desiredIndent - current.indent) });
      for (const child of current.children) visit(child, desiredIndent + Math.max(2, child.indent - current.indent));
    } else {
      for (const child of current.children) visit(child, desiredIndent);
    }
  };
  visit(node, baseIndent);
  return trimBlock(entries.sort((a, b) => a.index - b.index).map((entry) => entry.line));
}

function lastOwnedContentLine(task: Task, body: string[]): number {
  const ownContent = task.own.filter((index) => body[index].trim());
  return Math.max(...ownContent, ...task.children.map((child) => lastOwnedContentLine(child, body)));
}

function mergeTask(target: Section, sourceBody: string[], node: Task, parentPath: string[] = [], joinsPreviousTask = false): number {
  if (node.done) return node.children.reduce((total, child, index) => total + mergeTask(target, sourceBody, child, parentPath, joinsPreviousTask || index > 0), 0);
  const parsed = parseTasks(target.body);
  let parent: Task | undefined;
  for (const text of parentPath) {
    const matches: Task[] = (parent ? parent.children : parsed.roots).filter((task) => task.text === text);
    if (matches.length !== 1) throw new UnsafeMarkdownError('今天的同名任务父级存在歧义');
    parent = matches[0];
  }
  const siblings = parent ? parent.children : parsed.roots;
  const existing = siblings.filter((task) => task.text === node.text);
  if (existing.length > 1) throw new UnsafeMarkdownError('今天同一层级存在重复任务，无法安全合并');
  if (existing.length) {
    const matched = existing[0];
    const attachments = trimBlock(node.own.filter((index) => index !== node.line).map((index) =>
      shiftIndent(sourceBody[index], matched.indent - node.indent)
    ));
    if (attachments.length && !matched.own.map((index) => target.body[index]).join('\n').includes(attachments.join('\n'))) {
      const lastContentLine = Math.max(...matched.own.filter((index) => target.body[index].trim()));
      target.body.splice(lastContentLine + 1, 0, ...attachments);
    }
    return node.children.reduce((total, child) => total + mergeTask(target, sourceBody, child, [...parentPath, node.text]), 0);
  }
  const desiredIndent = parent ? parent.indent + Math.max(2, node.indent - (node.parent?.indent ?? 0)) : 0;
  const lines = subtreeLines(node, sourceBody, desiredIndent, false);
  if (!lines.length) return 0;
  if (parent) {
    target.body.splice(lastOwnedContentLine(parent, target.body) + 1, 0, ...Array(blankLinesBefore(sourceBody, node.line)).fill(''), ...lines);
  } else {
    appendTask(target, lines, blankLinesBefore(sourceBody, node.line), joinsPreviousTask);
  }
  const count = (item: Task): number => (item.done ? 0 : 1) + item.children.reduce((sum, child) => sum + count(child), 0);
  return count(node);
}

function cleanEmpty(section: Section): void {
  section.children.forEach(cleanEmpty);
  section.children = section.children.filter((child) => child.body.some((line) => line.trim()) || child.children.length);
}

function hasTask(section: Section): boolean {
  return parseTasks(section.body).roots.length > 0 || section.children.some(hasTask);
}

function allContentMigrates(section: Section): boolean {
  if (!hasOpen(section)) return !section.body.some((line) => line.trim()) && section.children.every(allContentMigrates);
  return section.children.every(allContentMigrates);
}

function targetSection(date: Section, source: Section): Section {
  const ancestors: Section[] = [];
  let current: Section | undefined = source;
  while (current && current.level > 1) { ancestors.unshift(current); current = current.parent; }
  let target = date;
  for (const ancestor of ancestors) {
    let child = target.children.find((item) => item.level === ancestor.level && item.title === ancestor.title);
    if (!child) {
      child = { heading: ancestor.heading, level: ancestor.level, title: ancestor.title, body: [], children: [], parent: target };
      target.children.push(child);
    }
    target = child;
  }
  return target;
}

function migrateSection(source: Section, today: Section, options: MigrationOptions, stats: { moved: number; copied: number }): void {
  if (!hasOpen(source)) return;
  const target = targetSection(today, source);
  const parsed = parseTasks(source.body);
  if (options.copyContent) stats.copied += copyOrdinary(source, target, parsed);
  const original = source.body.slice();
  for (const [index, root] of parsed.roots.entries()) {
    const previous = parsed.roots[index - 1];
    const ordinaryBetween = previous && original.slice(previous.line + 1, root.line)
      .some((line, offset) => line.trim() && !parsed.owner[previous.line + 1 + offset]);
    stats.moved += mergeTask(target, original, root, [], !!previous && !previous.done && !ordinaryBetween);
  }
  const retainedIndent = taskIndentMap(parsed.roots, true);
  source.body = original.flatMap((line, index) => {
    const owner = parsed.owner[index];
    if (!owner) return [line];
    if (!owner.done) return line.trim() ? [] : [''];
    return [shiftIndent(line, retainedIndent.get(owner)! - owner.indent)];
  });
  if (options.historyRecords) {
    const moved = parsed.roots.flatMap(function collect(task): string[] {
      return [...(!task.done ? [task.text.replace(/^([-+*]|\d+[.)])\s+\[ \]\s*/, '- ')] : []), ...task.children.flatMap(collect)];
    });
    if (moved.length) appendBlock(source, [`顺延至 ${shortDate(today.title)}：`, ...moved]);
  }
  for (const child of source.children) migrateSection(child, today, options, stats);
}

/** Only the target month's file is parsed or changed; other inputs are left untouched. */
export function planMigration(files: Record<string, string>, today: string, targetPath: string, options: MigrationOptions): MigrationPlan {
  if (!validDate(today)) throw new Error(`无效日期：${today}`);
  if (targetPath.split('/').pop() !== `${today.slice(0, 7).replace('-', '')}.md`) throw new Error('目标文件名与今天月份不符');
  let doc = parseDocument(targetPath, files[targetPath] ?? '');
  const warnings = [...doc.warnings];
  const unchanged = (): MigrationPlan => ({ files: { ...files }, movedTasks: 0, copiedBlocks: 0, changedFiles: [], warnings });
  if (doc.fatal) return unchanged();
  let todaySection = doc.dates.find((date) => date.title === today);
  if (todaySection?.unsafe) {
    warnings.push(`${targetPath} 的当天日期区域有歧义，未修改文件`);
    return unchanged();
  }
  if (!todaySection) {
    todaySection = { heading: `# ${shortDate(today)}`, title: today, level: 1, body: [''], children: [] };
    doc.dates.unshift(todaySection);
  } else {
    doc.dates = [todaySection, ...doc.dates.filter((date) => date !== todaySection)];
  }
  const stats = { moved: 0, copied: 0 };
  const historicalDates = doc.dates.filter((item) => !item.unsafe && item.title < today).map((item) => item.title).sort((a, b) => b.localeCompare(a));
  for (const dateKey of historicalDates) {
    const date = doc.dates.find((item) => item.title === dateKey && !item.unsafe);
    if (!date) continue;
    const snapshot = renderDocument(doc);
    const previousStats = { ...stats };
    try {
      const pruneCandidates = options.cleanEmptyHeadings && options.copyContent && !options.historyRecords
        ? date.children.filter((child) => child.level === 2 && hasOpen(child) && allContentMigrates(child))
        : [];
      migrateSection(date, todaySection, options, stats);
      if (options.cleanEmptyHeadings) {
        cleanEmpty(date);
        date.children = date.children.filter((child) => !pruneCandidates.includes(child) || hasTask(child));
      }
    } catch (error) {
      if (!(error instanceof UnsafeMarkdownError)) throw error;
      doc = parseDocument(targetPath, snapshot);
      todaySection = doc.dates.find((item) => item.title === today)!;
      doc.dates.find((item) => item.title === dateKey)!.unsafe = true;
      stats.moved = previousStats.moved;
      stats.copied = previousStats.copied;
      warnings.push(`${targetPath} 的「${shortDate(dateKey)}」已跳过：${error.message}`);
    }
  }
  if (options.cleanEmptyHeadings) cleanEmpty(todaySection);
  const output = renderDocument(doc);
  return {
    files: { ...files, [targetPath]: output },
    movedTasks: stats.moved,
    copiedBlocks: stats.copied,
    changedFiles: output === files[targetPath] ? [] : [targetPath],
    warnings
  };
}
