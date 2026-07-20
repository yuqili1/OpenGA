import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ReviewTask } from '../../../src/lib/taskSchema';
import { projectRoot } from '../taskStore/paths.js';
import type { ProjectConfig } from '../taskStore/projects.js';
import type {
  TextbookEntry,
  TextbookEntryPatch,
  TextbookOverlayDocument,
  TextbookOverlayOperation
} from './types.js';

const textbookFileCache = new Map<string, TextbookEntry[]>();
const overlayDocumentCache = new Map<string, TextbookOverlayDocument>();
const overlaySchema = 'openga-review.textbook-overlay.v1';
const maxOverlayBytes = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  return value;
}

function assertKeys(value: Record<string, unknown>, allowedKeys: string[], context: string): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${context} has unknown fields: ${unknown.join(', ')}`);
  }
}

function text(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function textList(value: unknown, context: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    throw new Error(`${context} must be an array of strings`);
  }
  return [...value];
}

function safeTextbookJsonPath(value: unknown, context: string): string {
  const textbookJson = text(value, context);
  const segments = textbookJson.split('/');
  if (
    textbookJson.includes('\\') ||
    textbookJson.includes('\0') ||
    textbookJson.startsWith('/') ||
    !textbookJson.endsWith('.json') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    path.posix.normalize(textbookJson) !== textbookJson
  ) {
    throw new Error(`${context} is not a safe relative JSON path: ${textbookJson}`);
  }
  return textbookJson;
}

function erratumDate(value: unknown, context: string): string {
  const date = text(value, context);
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`${context} must be a valid ISO calendar date`);
  const [, y, m, d] = match;
  const [year, month, day] = [Number(y), Number(m), Number(d)];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${context} must be a valid ISO calendar date`);
  }
  return date;
}

function optionalProof(value: unknown, context: string): string | null | undefined {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new Error(`${context} must be a string or null`);
  }
  return value;
}

function parsePatch(value: unknown, context: string): TextbookEntryPatch {
  const raw = asRecord(value, context);
  assertKeys(
    raw,
    ['content', 'content_replacements', 'append_content', 'dependencies', 'proof'],
    context
  );
  if (Object.keys(raw).length === 0) throw new Error(`${context} must not be empty`);
  if (raw.content !== undefined) text(raw.content, `${context}.content`);
  let replacements: TextbookEntryPatch['content_replacements'];
  if (raw.content_replacements !== undefined) {
    if (!Array.isArray(raw.content_replacements) || raw.content_replacements.length === 0) {
      throw new Error(`${context}.content_replacements must be a non-empty array`);
    }
    replacements = raw.content_replacements.map((value, index) => {
      const replacementContext = `${context}.content_replacements[${index}]`;
      const replacement = asRecord(value, replacementContext);
      assertKeys(replacement, ['from', 'to', 'expected_matches'], replacementContext);
      if (
        !Number.isInteger(replacement.expected_matches) ||
        (replacement.expected_matches as number) < 1
      ) {
        throw new Error(`${replacementContext}.expected_matches must be a positive integer`);
      }
      return {
        from: text(replacement.from, `${replacementContext}.from`),
        to: text(replacement.to, `${replacementContext}.to`),
        expected_matches: replacement.expected_matches as number
      };
    });
  }
  if (raw.append_content !== undefined) {
    text(raw.append_content, `${context}.append_content`);
  }
  if (raw.dependencies !== undefined) textList(raw.dependencies, `${context}.dependencies`);
  optionalProof(raw.proof, `${context}.proof`);
  return {
    ...(raw as TextbookEntryPatch),
    content_replacements: replacements,
    dependencies: raw.dependencies ? textList(raw.dependencies, `${context}.dependencies`) : undefined
  };
}

function parseEntry(value: unknown, context: string): TextbookEntry & { label: string } {
  const raw = asRecord(value, context);
  assertKeys(
    raw,
    ['index', 'label', 'env', 'number_components', 'context', 'content', 'dependencies', 'proof'],
    context
  );
  const label = text(raw.label, `${context}.label`);
  if (raw.index !== undefined && (!Number.isInteger(raw.index) || (raw.index as number) < 0)) {
    throw new Error(`${context}.index must be a nonnegative integer`);
  }
  for (const key of ['env', 'content'] as const) {
    if (raw[key] !== undefined) text(raw[key], `${context}.${key}`);
  }
  const numberComponents = raw.number_components === undefined
    ? undefined
    : textList(raw.number_components, `${context}.number_components`);
  const dependencies = raw.dependencies === undefined
    ? undefined
    : textList(raw.dependencies, `${context}.dependencies`);
  if (raw.context !== undefined) {
    const entryContext = asRecord(raw.context, `${context}.context`);
    const invalid = Object.entries(entryContext).find(
      ([key, item]) => key.trim() === '' || typeof item !== 'string'
    );
    if (invalid) {
      throw new Error(`${context}.context must map non-empty keys to strings`);
    }
  }
  optionalProof(raw.proof, `${context}.proof`);
  return {
    ...(raw as unknown as TextbookEntry),
    label,
    number_components: numberComponents,
    context: raw.context ? { ...(raw.context as Record<string, string>) } : undefined,
    dependencies
  };
}

function parseOverlayOperation(value: unknown, context: string): TextbookOverlayOperation {
  const raw = asRecord(value, context);
  const operation = text(raw.operation, `${context}.operation`);
  const textbookJson = safeTextbookJsonPath(raw.textbook_json, `${context}.textbook_json`);
  const label = text(raw.label, `${context}.label`);
  const date = erratumDate(raw.erratum_date, `${context}.erratum_date`);

  if (operation === 'merge') {
    assertKeys(raw, ['operation', 'textbook_json', 'label', 'erratum_date', 'patch'], context);
    return {
      operation,
      textbook_json: textbookJson,
      label,
      erratum_date: date,
      patch: parsePatch(raw.patch, `${context}.patch`)
    };
  }

  if (operation === 'append') {
    assertKeys(raw, ['operation', 'textbook_json', 'label', 'erratum_date', 'entry'], context);
    const entry = parseEntry(raw.entry, `${context}.entry`);
    if (entry.label !== label) throw new Error(`${context}.entry.label must equal ${context}.label`);
    return {
      operation,
      textbook_json: textbookJson,
      label,
      erratum_date: date,
      entry
    };
  }

  throw new Error(`${context}.operation must be "merge" or "append"`);
}

/** Parse and strictly validate one textbook overlay document. */
export function parseTextbookOverlay(
  value: unknown,
  sourceName = 'textbook overlay'
): TextbookOverlayDocument {
  const raw = asRecord(value, sourceName);
  assertKeys(raw, ['schema', 'source', 'operations'], sourceName);
  if (raw.schema !== overlaySchema) throw new Error(`${sourceName}.schema must be ${overlaySchema}`);
  const source = asRecord(raw.source, `${sourceName}.source`);
  assertKeys(source, ['title', 'url'], `${sourceName}.source`);
  const title = text(source.title, `${sourceName}.source.title`);
  const url = text(source.url, `${sourceName}.source.url`);
  try {
    if (new URL(url).protocol !== 'https:') throw new Error('not HTTPS');
  } catch {
    throw new Error(`${sourceName}.source.url must be a valid HTTPS URL`);
  }
  if (!Array.isArray(raw.operations) || raw.operations.length === 0) {
    throw new Error(`${sourceName}.operations must be a non-empty array`);
  }
  return {
    schema: overlaySchema,
    source: { title, url },
    operations: raw.operations.map((operation, index) =>
      parseOverlayOperation(operation, `${sourceName}.operations[${index}]`)
    )
  };
}

function applyEntryPatch(
  entry: TextbookEntry,
  patch: TextbookEntryPatch,
  context: string
): TextbookEntry {
  const { content_replacements: replacements, append_content: appendContent, ...fields } = patch;
  const result: TextbookEntry = {
    ...entry,
    ...fields,
    dependencies: fields.dependencies ? [...fields.dependencies] : entry.dependencies
  };
  let content = result.content ?? '';
  for (const replacement of replacements ?? []) {
    const matches = content.split(replacement.from).length - 1;
    if (matches !== replacement.expected_matches) {
      throw new Error(
        `${context} expected ${replacement.expected_matches} content matches but found ${matches}`
      );
    }
    content = content.split(replacement.from).join(replacement.to);
  }
  if (appendContent !== undefined) content += appendContent;
  if (replacements?.length || appendContent !== undefined) result.content = content;
  return result;
}

/**
 * Apply validated overlays without mutating the base entries or overlay documents.
 * A merge must match exactly one label; an append must match none.
 */
export function applyTextbookOverlays(
  baseEntries: readonly TextbookEntry[],
  textbookJson: string,
  overlayDocuments: readonly TextbookOverlayDocument[]
): TextbookEntry[] {
  const safeTextbookJson = safeTextbookJsonPath(textbookJson, 'textbook JSON path');
  const entries = baseEntries.map((entry) => ({ ...entry }));
  const seenTargets = new Set<string>();

  for (const [documentIndex, document] of overlayDocuments.entries()) {
    for (const [operationIndex, operation] of document.operations.entries()) {
      const targetKey = `${operation.textbook_json}\0${operation.label}`;
      if (seenTargets.has(targetKey)) {
        throw new Error(
          `Duplicate textbook overlay target ${operation.textbook_json}#${operation.label}`
        );
      }
      seenTargets.add(targetKey);
      if (operation.textbook_json !== safeTextbookJson) continue;

      const matches = entries
        .map((entry, index) => (entry.label === operation.label ? index : -1))
        .filter((index) => index !== -1);
      const operationName = `overlay ${documentIndex}:${operationIndex} ` +
        `(${operation.operation} ${operation.textbook_json}#${operation.label})`;

      if (operation.operation === 'merge') {
        if (matches.length !== 1) {
          throw new Error(
            `${operationName} must match exactly one base entry; found ${matches.length}`
          );
        }
        entries[matches[0]] = applyEntryPatch(
          entries[matches[0]],
          operation.patch,
          operationName
        );
      } else {
        if (matches.length !== 0) {
          throw new Error(
            `${operationName} requires the label to be absent; found ${matches.length}`
          );
        }
        entries.push({ ...operation.entry });
      }
    }
  }

  return entries;
}

function resolveOverlayPath(configuredPath: string): string {
  const resolvedPath = path.resolve(configuredPath);
  if (!resolvedPath.endsWith('.json')) throw new Error(`Overlay must be JSON: ${configuredPath}`);
  if (!fs.existsSync(resolvedPath)) throw new Error(`Textbook overlay not found: ${configuredPath}`);
  const realRoot = fs.realpathSync(projectRoot);
  const realPath = fs.realpathSync(resolvedPath);
  const relative = path.relative(realRoot, realPath);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Textbook overlay must stay within the repository: ${configuredPath}`);
  }
  const stat = fs.statSync(realPath);
  if (!stat.isFile()) throw new Error(`Textbook overlay is not a file: ${configuredPath}`);
  if (stat.size > maxOverlayBytes) {
    throw new Error(`Textbook overlay exceeds ${maxOverlayBytes} bytes: ${configuredPath}`);
  }
  return realPath;
}

function loadTextbookOverlays(configuredPaths: readonly string[]): TextbookOverlayDocument[] {
  const documents: TextbookOverlayDocument[] = [];
  const seenPaths = new Set<string>();

  for (const configuredPath of configuredPaths) {
    const realPath = resolveOverlayPath(configuredPath);
    if (seenPaths.has(realPath)) throw new Error(`Duplicate textbook overlay path: ${configuredPath}`);
    seenPaths.add(realPath);
    let document = overlayDocumentCache.get(realPath);
    if (!document) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(realPath, 'utf-8'));
      } catch (error) {
        throw new Error(
          `Invalid JSON in textbook overlay ${realPath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      document = parseTextbookOverlay(parsed, path.relative(projectRoot, realPath));
      overlayDocumentCache.set(realPath, document);
    }
    documents.push(document);
  }
  return documents;
}

export function normalizeTextbookMarkdown(source: string): string {
  return source
    .replace(/\\\[/g, '$$')
    .replace(/\\\]/g, '$$')
    .replace(/\\\(/g, '$')
    .replace(/\\\)/g, '$')
    .replace(/[ \t]+$/gm, '');
}

export function renderTextbookEntry(entry: TextbookEntry, fallbackLabel: string): string {
  const pieces = [
    `# ${entry.label ?? fallbackLabel}`,
    normalizeTextbookMarkdown(entry.content ?? '')
  ];
  if (entry.dependencies?.length) {
    pieces.push(`Dependencies: ${entry.dependencies.join(', ')}`);
  }
  if (entry.proof) {
    pieces.push('## Proof', normalizeTextbookMarkdown(entry.proof));
  }
  return pieces.join('\n\n').trim();
}

export function loadTextbookEntry(config: ProjectConfig, task: ReviewTask): TextbookEntry | null {
  if (!task.source?.textbook_json || !task.source.textbook_label) return null;
  if (!config.textbookZipPath) return null;
  const zipEntry = safeTextbookJsonPath(
    task.source.textbook_json,
    `Textbook JSON path for task ${task.id}`
  );
  if (!fs.existsSync(config.textbookZipPath)) {
    return {
      label: task.source.textbook_label,
      content: [
        `Textbook source zip not found: ${config.textbookZipPath}`,
        '',
        'The default copy is tracked at projects/smooth-manifolds-lee/sources/smooth-manifolds.zip. Set SMOOTH_MANIFOLDS_LEE_ZIP only if you want to use another local copy.'
      ].join('\n')
    };
  }
  const overlays = loadTextbookOverlays(config.textbookOverlayPaths ?? []);
  const cacheKey = JSON.stringify([config.textbookZipPath, zipEntry, config.textbookOverlayPaths]);
  let entries = textbookFileCache.get(cacheKey);
  if (!entries) {
    let raw: string;
    try {
      raw = execFileSync('unzip', ['-p', config.textbookZipPath, zipEntry], {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024
      });
    } catch (error) {
      throw new Error(
        `Failed to read textbook JSON ${zipEntry} from ${config.textbookZipPath}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Invalid textbook JSON ${zipEntry}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!Array.isArray(parsed) || parsed.some((entry) => !isRecord(entry))) {
      throw new Error(`Textbook JSON ${zipEntry} must contain an array of entry objects`);
    }
    entries = applyTextbookOverlays(parsed as TextbookEntry[], zipEntry, overlays);
    textbookFileCache.set(cacheKey, entries);
  }
  const entry = entries.find((item) => item.label === task.source?.textbook_label);
  if (!entry) {
    return {
      label: task.source.textbook_label,
      content: `Textbook entry not found: ${task.source.textbook_label}`
    };
  }
  return entry;
}
