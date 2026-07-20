import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { projectRoot } from '../taskStore/paths.js';
import type { LeanDeclaration, LeanParsedCommand } from './types.js';

const leanSourceCache = new Map<string, string>();
const leeImportRef = 'import/smooth-manifolds-lee';

type FormalStatementItem = {
  id: string;
  title: string;
  kind: 'lean';
  language: 'lean';
  content: string;
  meta: string[];
  description?: string;
};

function compatibleImportRefs(ref: string): string[] {
  const match = ref.match(/^(origin|upstream)\/(import\/smooth-manifolds-lee)$/);
  if (!match) return [ref];
  const alternateRemote = match[1] === 'origin' ? 'upstream' : 'origin';
  return [ref, `${alternateRemote}/${leeImportRef}`];
}

export function readLeanFromGit(ref: string, leanFile: string): string {
  if (!/^[A-Za-z0-9_./-]+$/.test(ref)) {
    throw new Error('Invalid import ref');
  }
  if (!leanFile.startsWith('staging/SmoothManifoldsLee/') || leanFile.includes('..')) {
    throw new Error('Invalid Lean source path');
  }
  const cacheKey = `${ref}:${leanFile}`;
  const cached = leanSourceCache.get(cacheKey);
  if (cached) return cached;

  const errors: string[] = [];
  for (const candidateRef of compatibleImportRefs(ref)) {
    try {
      const source = execFileSync('git', ['show', `${candidateRef}:${leanFile}`], {
        cwd: projectRoot,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      leanSourceCache.set(cacheKey, source);
      return source;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${candidateRef}: ${message}`);
    }
  }
  throw new Error(
    `Unable to read ${leanFile} from ${compatibleImportRefs(ref).join(' or ')}. ` +
      'Fetch the SmoothManifoldsLee import branch from the configured fork/upstream remote.\n' +
      errors.join('\n')
  );
}

function normalizeDocstringText(source: string): string | null {
  const text = source
    .replace(/^\/--\s?/, '')
    .replace(/\s*-\/\s*$/, '')
    .replace(/^\s*\*\s?/gm, '')
    .trim();
  return text.length > 0 ? text : null;
}

function normalizeDocstring(lines: string[]): string | null {
  if (lines.length === 0) return null;
  return normalizeDocstringText(lines.join('\n'));
}

function isDeclarationStart(line: string): boolean {
  return /^\s*(?:@\[[\s\S]*?\]\s*)*(?:noncomputable\s+)?(?:unsafe\s+)?(?:partial\s+)?(?:abbrev|class|def|instance|lemma|theorem|structure)\s+/.test(line);
}

function extractDeclarationFromCommand(command: LeanParsedCommand): LeanDeclaration | null {
  const text = command.text.trim();
  const docMatch = text.match(/^\/--[\s\S]*?-\/\s*/);
  const docstring = docMatch ? normalizeDocstringText(docMatch[0]) : null;
  const withoutDoc = docMatch ? text.slice(docMatch[0].length).trimStart() : text;
  const declarationHead = withoutDoc.replace(/^(?:--[^\n]*\n\s*)+/, '').trimStart();
  const match = declarationHead.match(
    /^(?:@\[[\s\S]*?\]\s*)*(?:noncomputable\s+)?(?:unsafe\s+)?(?:partial\s+)?(abbrev|class|def|instance|lemma|theorem|structure)\s+([^\s(:{]+)/
  );
  if (!match) return null;

  const [, kind, name] = match;
  const signature =
    kind === 'lemma' || kind === 'theorem'
      ? text.replace(/\s*:=\s*[\s\S]*$/, '').trimEnd()
      : text;

  return {
    kind,
    name,
    fullName: [...command.namespaces, name].join('.'),
    docstring,
    signature
  };
}

function referenceName(text: string, keyword: '#check' | 'recall'): string {
  const rest = text.slice(keyword.length).trim();
  const match = rest.match(/^([^\s(:]+)/);
  return match?.[1] ?? rest.split(/\s+/)[0] ?? keyword;
}

function stripInlineComment(line: string): string {
  const index = line.indexOf('--');
  return index === -1 ? line : line.slice(0, index);
}

function extractReferenceCommands(source: string): LeanDeclaration[] {
  const references: LeanDeclaration[] = [];
  let inBlockComment = false;

  for (const rawLine of source.split(/\r?\n/)) {
    let line = rawLine;
    const trimmed = line.trim();

    if (inBlockComment) {
      if (trimmed.includes('-/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/-') && !trimmed.includes('-/')) {
      inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('/-') || trimmed.startsWith('--')) continue;

    line = stripInlineComment(line).trim();
    const keyword = line.startsWith('#check ') ? '#check' : line.startsWith('recall ') ? 'recall' : null;
    if (!keyword) continue;

    const fullName = referenceName(line, keyword);
    const nameParts = fullName.split('.');
    references.push({
      kind: keyword === '#check' ? 'check' : 'recall',
      name: nameParts[nameParts.length - 1] || fullName,
      fullName,
      docstring: null,
      signature: line
    });
  }

  return references;
}

function commandTextFromLineRange(source: string, commands: LeanParsedCommand[], index: number): string {
  const lines = source.split(/\r?\n/);
  const startIndex = Math.max(0, commands[index].startLine - 1);
  const nextStartLine = commands[index + 1]?.startLine;
  const endIndex = nextStartLine ? Math.max(startIndex, nextStartLine - 1) : lines.length;
  return lines.slice(startIndex, endIndex).join('\n').trimEnd();
}

const leanDeclarationCache = new Map<string, LeanDeclaration[]>();

function leanExecutablePath(): string {
  const configured = process.env.LEAN;
  if (configured) return configured;
  const elanLean = '/root/.elan/bin/lean';
  return fs.existsSync(elanLean) ? elanLean : 'lean';
}

function extractLeanDeclarationsWithLeanParser(source: string): LeanDeclaration[] | null {
  const cacheKey = createHash('sha1').update(source).digest('hex');
  const cached = leanDeclarationCache.get(cacheKey);
  if (cached) return cached;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openga-lean-'));
  const tempFile = path.join(tempDir, 'source.lean');
  try {
    fs.writeFileSync(tempFile, source, 'utf-8');
    const raw = execFileSync(
      leanExecutablePath(),
      ['--run', path.join(projectRoot, 'apps/review/server/lean/ExtractCommands.lean'), tempFile],
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `/root/.elan/bin:${process.env.PATH ?? ''}`
        },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 25000
      }
    );
    const commands = JSON.parse(raw) as LeanParsedCommand[];
    const declarations = commands
      .map((command, index) => ({
        ...command,
        text: commandTextFromLineRange(source, commands, index)
      }))
      .filter((command) => command.kind === 'Lean.Parser.Command.declaration')
      .map(extractDeclarationFromCommand)
      .filter((decl): decl is LeanDeclaration => decl !== null);
    const formalStatements = [...extractReferenceCommands(source), ...declarations];
    leanDeclarationCache.set(cacheKey, formalStatements);
    return formalStatements;
  } catch (error) {
    console.warn('Lean parser extraction failed; using fallback parser.', error);
    return null;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function extractLeanDeclarationsFallback(source: string): LeanDeclaration[] {
  const lines = source.split(/\r?\n/);
  const declarations: LeanDeclaration[] = [];
  const namespaces: string[] = [];
  let pendingDoc: string[] = [];
  let inDoc = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!inDoc && trimmed.startsWith('namespace ')) {
      namespaces.push(trimmed.slice('namespace '.length).trim());
      continue;
    }
    if (!inDoc && trimmed.startsWith('end ') && namespaces[namespaces.length - 1] === trimmed.slice(4).trim()) {
      namespaces.pop();
      continue;
    }

    if (trimmed.startsWith('/--')) {
      pendingDoc = [line];
      inDoc = !trimmed.endsWith('-/');
      continue;
    }
    if (inDoc) {
      pendingDoc.push(line);
      if (trimmed.endsWith('-/')) {
        inDoc = false;
      }
      continue;
    }

    if (!isDeclarationStart(line)) {
      if (trimmed.length > 0 && !trimmed.startsWith('@[')) {
        pendingDoc = [];
      }
      continue;
    }

    const match = line.match(
      /^\s*(?:@\[[^\]]+\]\s*)*(?:noncomputable\s+)?(abbrev|class|def|instance|lemma|theorem|structure)\s+([^\s(:{]+)/
    );
    if (!match) continue;

    const [, kind, name] = match;
    const signatureLines = [line];
    const keepBody = kind === 'abbrev' || kind === 'class' || kind === 'def' || kind === 'instance' || kind === 'structure';
    const shouldStopAtTopLevel = (candidate: string) => {
      const candidateTrimmed = candidate.trim();
      return (
        candidateTrimmed.startsWith('/--') ||
        isDeclarationStart(candidate) ||
        /^(end|import|namespace|section|universe|variable|#check)\b/.test(candidateTrimmed)
      );
    };
    for (let j = i + 1; j < Math.min(lines.length, i + 28); j++) {
      const next = lines[j];
      const nextTrimmed = next.trim();
      const hasAssignment = signatureLines.some((item) => item.includes(':='));
      const hasBodyLine = hasAssignment && signatureLines.length > 1;

      if (!keepBody && hasAssignment) {
        break;
      }
      if (
        signatureLines.length > 1 &&
        nextTrimmed.length === 0 &&
        (hasBodyLine || signatureLines.some((item) => /\bwhere\b/.test(item)))
      ) {
        break;
      }
      if (signatureLines.length > 1 && shouldStopAtTopLevel(next)) {
        break;
      }
      signatureLines.push(next);
    }

    declarations.push({
      kind,
      name,
      fullName: [...namespaces, name].join('.'),
      docstring: normalizeDocstring(pendingDoc),
      signature: signatureLines.join('\n').trimEnd()
    });
    pendingDoc = [];
  }
  return declarations;
}

export function extractLeanDeclarations(source: string): LeanDeclaration[] {
  const parsed = extractLeanDeclarationsWithLeanParser(source);
  if (parsed) return parsed;
  return [...extractReferenceCommands(source), ...extractLeanDeclarationsFallback(source)];
}

function displaySignature(decl: LeanDeclaration): string {
  return decl.kind === 'lemma' || decl.kind === 'theorem'
    ? decl.signature.replace(/\s*:=\s*(?:by)?\s*$/, '').trimEnd()
    : decl.signature;
}

function formalItemId(decl: LeanDeclaration, index: number): string {
  const slug = decl.fullName
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `formal-${index + 1}-${slug || 'declaration'}`;
}

export function renderFormalStatementItems(declarations: LeanDeclaration[]): FormalStatementItem[] {
  return declarations.map((decl, index) => ({
    id: formalItemId(decl, index),
    title: decl.fullName,
    kind: 'lean',
    language: 'lean',
    content: displaySignature(decl),
    meta: [decl.kind, decl.name, ...(decl.sourceFile ? [decl.sourceFile] : [])],
    description: decl.docstring ?? undefined
  }));
}

export function renderFormalStatements(declarations: LeanDeclaration[]): string {
  if (declarations.length === 0) {
    return 'No Lean declarations were detected in this source file.';
  }
  return declarations
    .map((decl) => {
      const parts = [
        `## ${decl.fullName}`,
        `Kind: \`${decl.kind}\``
      ];
      if (decl.sourceFile) {
        parts.push(`Source: \`${decl.sourceFile}\``);
      }
      if (decl.docstring) {
        parts.push(decl.docstring);
      }
      parts.push(['```lean', displaySignature(decl), '```'].join('\n'));
      return parts.join('\n\n');
    })
    .join('\n\n');
}
