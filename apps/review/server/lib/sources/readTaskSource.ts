import type {
  ReviewTask,
  TaskSource,
  TaskSourcePanel
} from '../../../src/lib/taskSchema';
import { readAtom } from '../taskStore/atoms.js';
import { getProjectConfig } from '../taskStore/projects.js';
import {
  extractLeanDeclarations,
  readLeanFromGit,
  renderFormalStatementItems,
  renderFormalStatements
} from './lean.js';
import { dependencyTreesForDeclaration } from './leanDeps.js';
import { astrolabeLeanItems } from './docarmoLean.js';
import {
  loadTextbookEntry,
  normalizeTextbookMarkdown,
  renderTextbookEntry
} from './textbook.js';
import type { TextbookEntry } from './types.js';

const readOnlySourceCache = new Map<string, TaskSource>();

function sourceCacheKey(projectId: string, task: ReviewTask, projectReviewKind: string): string | null {
  if (task.files.atom) return null;

  return JSON.stringify({
    projectId,
    taskId: task.id,
    reviewKind: task.review_kind ?? projectReviewKind,
    title: task.title,
    leanFile: task.source?.lean_file ?? null,
    leanFiles: task.source?.lean_files ?? null,
    importRef: task.source?.import_ref ?? null,
    textbookJson: task.source?.textbook_json ?? null,
    textbookLabel: task.source?.textbook_label ?? null
  });
}

function leanFilesForTask(task: ReviewTask): string[] {
  const files = task.source?.lean_files?.length
    ? task.source.lean_files
    : task.source?.lean_file
      ? [task.source.lean_file]
      : [];
  return [...new Set(files)];
}

function renderLeanSourceBundle(sources: { file: string; content: string }[]): string | null {
  if (sources.length === 0) return null;
  if (sources.length === 1) return sources[0].content;

  return sources
    .map(({ file, content }) => [`-- Source file: ${file}`, content].join('\n\n'))
    .join('\n\n');
}

function renderAlignmentTarget(
  task: ReviewTask,
  textbookEntry: TextbookEntry | null,
  formalCount: number,
  hasLeanSource: boolean
): string {
  const pieces = [
    `# ${task.title}`,
    task.source?.textbook_label ? `Textbook label: \`${task.source.textbook_label}\`` : null,
    '',
    '## Informal Statement',
    textbookEntry
      ? normalizeTextbookMarkdown(textbookEntry.content ?? '')
      : 'No textbook source is configured for this task.',
    '',
    '## Formal Statements To Tag',
    formalCount > 0
      ? `${formalCount} Lean declarations are available in the Formal statements tab. Review them one by one against the informal statement.`
      : hasLeanSource
        ? 'No Lean declarations were detected in the configured Lean source file.'
        : 'No Lean source is paired with this textbook entry. Keep `formal_review` pending until a formalization is added.',
    '',
    '## Review Decision',
    '- `informal_review`: the informal textbook statement is the intended source item.',
    hasLeanSource
      ? '- `formal_review`: the displayed Lean declarations are a reasonable formalization of the informal statement.'
      : '- `formal_review`: remains pending because this entry has no paired Lean source.'
  ];
  return pieces.filter((item): item is string => item !== null).join('\n').trim();
}

export function readTaskSource(projectId: string, task: ReviewTask): TaskSource {
  const config = getProjectConfig(projectId);
  const cacheKey = sourceCacheKey(projectId, task, config.reviewKind);
  const cached = cacheKey ? readOnlySourceCache.get(cacheKey) : undefined;
  if (cached) return cached;

  const panels: TaskSourcePanel[] = [];

  if (task.files.atom) {
    panels.push({
      id: 'atom',
      title: 'Atom source',
      kind: 'markdown',
      language: 'markdown',
      content: readAtom(task.files.atom),
      editable: task.editable.includes(task.files.atom)
    });

    // Lean formalization linked to this statement via the Astrolabe
    // `formalizes` / `restates` bridges (do Carmo tasks).
    const leanItems = astrolabeLeanItems(task);
    if (leanItems.length > 0) {
      panels.push({
        id: 'formalization',
        title: 'Lean formalization',
        kind: 'lean',
        language: 'lean',
        content: `${leanItems.length} Lean declaration${leanItems.length === 1 ? '' : 's'} formalize this statement.`,
        items: leanItems,
        editable: false
      });
    }
  }

  const textbookEntry = loadTextbookEntry(config, task);
  const importRef = task.source?.import_ref ?? 'origin/import/smooth-manifolds-lee';
  const leanSources = leanFilesForTask(task).map((file) => ({
    file,
    content: readLeanFromGit(importRef, file)
  }));
  const leanSource = renderLeanSourceBundle(leanSources);
  const declarations = leanSources.flatMap(({ file, content }) =>
    extractLeanDeclarations(content).map((decl) => ({
      ...decl,
      sourceFile: file
    }))
  );
  const formalContent = renderFormalStatements(declarations);
  const formalItems = renderFormalStatementItems(declarations).map((item, index) => ({
    ...item,
    dependencies: dependencyTreesForDeclaration(projectId, declarations[index])
  }));

  if (task.review_kind === 'lean_textbook' || config.reviewKind === 'lean_textbook') {
    panels.push({
      id: 'alignment',
      title: 'Review target',
      kind: 'markdown',
      language: 'markdown',
      content: renderAlignmentTarget(task, textbookEntry, formalItems.length, leanSources.length > 0),
      editable: false
    });
  }

  if (textbookEntry !== null && task.source?.textbook_label) {
    panels.push({
      id: 'textbook',
      title: 'Informal source',
      kind: 'markdown',
      language: 'markdown',
      content: renderTextbookEntry(textbookEntry, task.source.textbook_label),
      editable: false
    });
  }

  if (declarations.length > 0) {
    panels.push({
      id: 'formal',
      title: 'Formal statements',
      kind: 'markdown',
      language: 'markdown',
      content: formalContent,
      items: formalItems,
      editable: false
    });
  }

  if (leanSource !== null) {
    panels.push({
      id: 'lean',
      title: 'Lean source',
      kind: 'lean',
      language: 'lean',
      content: leanSource,
      editable: false
    });
  }

  const source = { taskId: task.id, panels };
  if (cacheKey) readOnlySourceCache.set(cacheKey, source);
  return source;
}
