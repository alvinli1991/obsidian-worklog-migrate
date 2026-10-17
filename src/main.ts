import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, SettingDefinitionItem, TFile, TFolder, getLanguage, normalizePath } from 'obsidian';
import { MigrationOptions, planMigration } from './core';

interface Settings extends MigrationOptions {
  worklogDirectory: string;
  preview: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  worklogDirectory: '',
  copyContent: true,
  cleanEmptyHeadings: true,
  historyRecords: false,
  preview: false
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseSettings(value: unknown): Settings {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS };
  return {
    worklogDirectory: typeof value.worklogDirectory === 'string' ? value.worklogDirectory : DEFAULT_SETTINGS.worklogDirectory,
    copyContent: typeof value.copyContent === 'boolean' ? value.copyContent : DEFAULT_SETTINGS.copyContent,
    cleanEmptyHeadings: typeof value.cleanEmptyHeadings === 'boolean' ? value.cleanEmptyHeadings : DEFAULT_SETTINGS.cleanEmptyHeadings,
    historyRecords: typeof value.historyRecords === 'boolean' ? value.historyRecords : DEFAULT_SETTINGS.historyRecords,
    preview: typeof value.preview === 'boolean' ? value.preview : DEFAULT_SETTINGS.preview
  };
}

function localDate(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

class PreviewModal extends Modal {
  private resolve!: (approved: boolean) => void;
  readonly result = new Promise<boolean>((resolve) => { this.resolve = resolve; });
  private answered = false;

  constructor(app: App, title: string, details: string[]) {
    super(app);
    this.setTitle(title);
    this.contentEl.createEl('p', { text: '本次迁移计划：' });
    const list = this.contentEl.createEl('ul');
    details.forEach((detail) => list.createEl('li', { text: detail }));
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
      .addButton((button) => button.setButtonText('执行迁移').setCta().onClick(() => {
        this.answered = true;
        this.resolve(true);
        this.close();
      }));
  }

  onClose(): void {
    if (!this.answered) this.resolve(false);
    this.contentEl.empty();
  }

  openAndWait(): Promise<boolean> {
    this.open();
    return this.result;
  }
}

export default class WorklogMigratePlugin extends Plugin {
  settings: Settings = DEFAULT_SETTINGS;
  private running = false;

  async onload(): Promise<void> {
    const savedSettings: unknown = await this.loadData();
    this.settings = parseSettings(savedSettings);
    const commandName = /^zh(?:[-_]|$)/i.test(getLanguage()) ? '迁移待办' : 'Migrate TODOs';
    this.addCommand({
      id: 'migrate-unfinished-todos-to-today',
      name: commandName,
      callback: () => { void this.migrate(); }
    });
    this.addSettingTab(new WorklogSettingTab(this.app, this));
  }

  private async migrate(): Promise<void> {
    if (this.running) {
      new Notice('工作日志迁移正在进行中');
      return;
    }
    this.running = true;
    try {
      await this.performMigration();
    } catch (error) {
      console.error('Worklog Migrate:', error);
      new Notice(`迁移失败：${error instanceof Error ? error.message : String(error)}`, 10000);
    } finally {
      this.running = false;
    }
  }

  private async performMigration(): Promise<void> {
    const directory = this.settings.worklogDirectory.trim().replace(/^\/+|\/+$/g, '');
    if (!directory || directory.includes('..') || directory.includes('\\')) {
      throw new Error('请先设置有效的工作日志目录');
    }
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(directory));
    if (!(folder instanceof TFolder)) throw new Error(`工作日志目录不存在：${directory}`);
    const today = localDate();
    const month = today.slice(0, 7).replace('-', '');
    const targetPath = normalizePath(`${directory}/${month}.md`);
    const original: Record<string, string> = {};
    const currentMonthFile = this.app.vault.getAbstractFileByPath(targetPath);
    if (currentMonthFile && !(currentMonthFile instanceof TFile)) throw new Error(`${targetPath} 不是 Markdown 文件`);
    if (currentMonthFile) original[targetPath] = await this.app.vault.read(currentMonthFile);
    const plan = planMigration(original, today, targetPath, this.settings);
    if (!plan.changedFiles.length) {
      if (plan.warnings.length) {
        console.warn('Worklog Migrate skipped sections:', plan.warnings);
        new Notice(`未修改工作日志。${plan.warnings.slice(0, 2).join('；')}${plan.warnings.length > 2 ? '；其余详见开发者控制台' : ''}`, 10000);
      } else new Notice('工作日志已是最新，无需迁移');
      return;
    }
    if (this.settings.preview) {
      const approved = await new PreviewModal(
        this.app,
        `迁移 ${plan.movedTasks} 个未完成 TODO，复制 ${plan.copiedBlocks} 段内容`,
        [...plan.changedFiles, ...plan.warnings.map((warning) => `跳过：${warning}`)]
      ).openAndWait();
      if (!approved) return;
    }
    const latest = this.app.vault.getAbstractFileByPath(targetPath);
    if (original[targetPath] === undefined) {
      if (latest) throw new Error(`${targetPath} 在迁移期间被其他操作创建，请重试`);
      await this.app.vault.create(targetPath, plan.files[targetPath]);
    } else {
      if (!(latest instanceof TFile)) throw new Error(`${targetPath} 在迁移期间消失，请重试`);
      await this.app.vault.process(latest, (current) => {
        if (current !== original[targetPath]) throw new Error(`${targetPath} 在迁移期间被修改，请重试`);
        return plan.files[targetPath];
      });
    }
    if (plan.warnings.length) console.warn('Worklog Migrate skipped sections:', plan.warnings);
    new Notice(`已迁移 ${plan.movedTasks} 个未完成 TODO${plan.warnings.length ? `。${plan.warnings.slice(0, 2).join('；')}${plan.warnings.length > 2 ? '；其余详见开发者控制台' : ''}` : ''}`, 10000);
  }
}

class WorklogSettingTab extends PluginSettingTab {
  plugin: WorklogMigratePlugin;

  constructor(app: App, plugin: WorklogMigratePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem<keyof Settings>[] {
    return [
      {
        name: '工作日志目录',
        desc: 'Vault 内存放 YYYYMM.md 月度文件的目录。仅处理当月文件。',
        control: { type: 'folder', key: 'worklogDirectory', placeholder: 'Worklog' }
      },
      {
        name: '复制普通 Markdown 内容',
        desc: '复制有未完成任务的标题分支中的普通内容。',
        control: { type: 'toggle', key: 'copyContent' }
      },
      {
        name: '清理已迁项目',
        desc: '删除内容已复制且不含需保留任务的历史二级标题；日期标题保留。',
        control: { type: 'toggle', key: 'cleanEmptyHeadings' }
      },
      {
        name: '保留顺延记录',
        desc: '在历史标题下添加普通文本顺延记录。',
        control: { type: 'toggle', key: 'historyRecords' }
      },
      {
        name: '迁移前预览',
        desc: '写入前显示任务数量和受影响文件，并等待确认。',
        control: { type: 'toggle', key: 'preview' }
      }
    ];
  }
}
