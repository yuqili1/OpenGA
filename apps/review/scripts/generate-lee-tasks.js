import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dump, load } from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../..');
const configuredImportRef = process.env.SMOOTH_MANIFOLDS_LEE_IMPORT_REF?.trim() || undefined;
const importRef = configuredImportRef ?? 'origin/import/smooth-manifolds-lee';
const textbookZipPath =
  process.env.SMOOTH_MANIFOLDS_LEE_ZIP ??
  path.join(projectRoot, 'projects/smooth-manifolds-lee/sources/smooth-manifolds.zip');
const textbookOverlayPaths = [
  path.join(projectRoot, 'projects/smooth-manifolds-lee/sources/errata/ism-2e.json'),
  path.join(projectRoot, 'projects/smooth-manifolds-lee/sources/clarifications/openga.json')
];
const jsonPrefix =
  'sections-1to8-Introduction-to-Smooth-Manifolds-Second-Edition-2013-by-John-M.-Lee';
const taskDir = path.join(projectRoot, 'projects/smooth-manifolds-lee/tasks');
const outputPath = path.join(taskDir, 'all.tasks.yaml');
const reportPath = path.join(taskDir, 'generation-report.json');
const formalAuditPath = path.join(taskDir, 'formal-audit.json');
const previousTaskPaths = [outputPath, path.join(taskDir, 'section01.tasks.yaml')];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    maxBuffer: 80 * 1024 * 1024,
    ...options
  });
}

function displayPath(filePath) {
  const relative = path.relative(projectRoot, filePath);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    ? relative
    : filePath;
}

function gitRefExists(ref) {
  try {
    run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function resolveImportReadRef() {
  if (configuredImportRef !== undefined) {
    if (gitRefExists(importRef)) return importRef;
    throw new Error(`Configured SmoothManifoldsLee import ref not found: ${importRef}`);
  }
  if (gitRefExists(importRef)) return importRef;

  const upstreamRef = importRef.replace(/^origin\//, 'upstream/');
  if (upstreamRef !== importRef && gitRefExists(upstreamRef)) return upstreamRef;
  throw new Error(`SmoothManifoldsLee import ref not found: ${importRef} or ${upstreamRef}`);
}

const importReadRef = resolveImportReadRef();

function safeReadYaml(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return load(fs.readFileSync(filePath, 'utf-8'));
}

function previousTasksById() {
  const map = new Map();
  for (const filePath of previousTaskPaths) {
    const dataset = safeReadYaml(filePath);
    for (const task of dataset?.tasks ?? []) {
      if (!map.has(task.id)) map.set(task.id, task);
    }
  }
  return map;
}

function zipJsonEntries() {
  return run('unzip', ['-Z1', textbookZipPath])
    .split(/\r?\n/)
    .filter((entry) => entry.startsWith(`${jsonPrefix}/section`) && entry.endsWith('.json'))
    .sort();
}

function isIsoCalendarDate(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

function loadTextbookOverlays() {
  const seenTargets = new Set();
  const documents = textbookOverlayPaths.map((overlayPath, documentIndex) => {
    const document = JSON.parse(fs.readFileSync(overlayPath, 'utf-8'));
    const sourceKind = document.source?.kind ?? 'official_errata';
    if (
      document.schema !== 'openga-review.textbook-overlay.v1' ||
      !document.source ||
      !['official_errata', 'openga_clarification'].includes(sourceKind) ||
      typeof document.source.title !== 'string' ||
      typeof document.source.url !== 'string' ||
      !document.source.url.startsWith('https://') ||
      !Array.isArray(document.operations) ||
      document.operations.length === 0
    ) {
      throw new Error(`Invalid textbook overlay: ${overlayPath}`);
    }
    const dateKey = sourceKind === 'official_errata' ? 'erratum_date' : 'review_date';
    const otherDateKey = sourceKind === 'official_errata' ? 'review_date' : 'erratum_date';
    for (const [operationIndex, operation] of document.operations.entries()) {
      if (
        !['merge', 'append'].includes(operation.operation) ||
        typeof operation.textbook_json !== 'string' ||
        typeof operation.label !== 'string' ||
        !isIsoCalendarDate(operation[dateKey]) ||
        operation[otherDateKey] !== undefined
      ) {
        throw new Error(
          `Invalid ${sourceKind} operation ${documentIndex}:${operationIndex} in ${overlayPath}`
        );
      }
      const target = `${operation.textbook_json}\0${operation.label}`;
      if (seenTargets.has(target)) {
        throw new Error(
          `Duplicate textbook overlay target: ${operation.textbook_json}#${operation.label}`
        );
      }
      seenTargets.add(target);
    }
    return {
      path: overlayPath,
      source: { ...document.source, kind: sourceKind },
      operations: document.operations
    };
  });
  const operations = documents.flatMap((document, documentIndex) =>
    document.operations.map((operation, operationIndex) => ({
      operationKey: `${documentIndex}:${operationIndex}`,
      sourceKind: document.source.kind,
      operation
    }))
  );
  return { documents, operations };
}

function applyTextbookEntryPatch(entry, patch, context) {
  const { content_replacements: replacements, append_content: appendContent, ...fields } = patch;
  const result = { ...entry, ...fields };
  let content = result.content ?? '';
  for (const replacement of replacements ?? []) {
    if (
      typeof replacement.from !== 'string' ||
      replacement.from.length === 0 ||
      typeof replacement.to !== 'string' ||
      !Number.isInteger(replacement.expected_matches) ||
      replacement.expected_matches < 1
    ) {
      throw new Error(`Invalid content replacement in ${context}`);
    }
    const matches = content.split(replacement.from).length - 1;
    if (matches !== replacement.expected_matches) {
      throw new Error(
        `${context} expected ${replacement.expected_matches} content matches but found ${matches}`
      );
    }
    content = content.split(replacement.from).join(replacement.to);
  }
  if (appendContent !== undefined) {
    if (typeof appendContent !== 'string' || appendContent.length === 0) {
      throw new Error(`Invalid appended content in ${context}`);
    }
    content += appendContent;
  }
  if (replacements?.length || appendContent !== undefined) result.content = content;
  return result;
}

function applyTextbookOverlays(entries, entryPath, overlayOperations, appliedOperations) {
  const result = entries.map((entry) => ({ ...entry }));
  overlayOperations.forEach(({ operation, operationKey, sourceKind }) => {
    if (operation.textbook_json !== entryPath) return;
    const matches = result
      .map((entry, index) => (entry.label === operation.label ? index : -1))
      .filter((index) => index !== -1);
    if (operation.operation === 'merge' && matches.length === 1) {
      result[matches[0]] = applyTextbookEntryPatch(
        result[matches[0]],
        operation.patch,
        `${sourceKind} ${entryPath}#${operation.label}`
      );
    } else if (operation.operation === 'append' && matches.length === 0) {
      if (operation.entry?.label !== operation.label) {
        throw new Error(`Overlay entry label mismatch for ${entryPath}#${operation.label}`);
      }
      result.push({ ...operation.entry });
    } else {
      throw new Error(
        `Overlay ${operation.operation} for ${entryPath}#${operation.label} matched ${matches.length} entries`
      );
    }
    appliedOperations.add(operationKey);
  });
  return result;
}

function loadTextbookSections(overlayOperations) {
  const sections = new Map();
  const appliedOperations = new Set();
  for (const entryPath of zipJsonEntries()) {
    const match = entryPath.match(/section(\d+)\.json$/);
    if (!match) continue;
    const sectionNumber = Number(match[1]);
    const raw = run('unzip', ['-p', textbookZipPath, entryPath]);
    const entries = applyTextbookOverlays(
      JSON.parse(raw),
      entryPath,
      overlayOperations,
      appliedOperations
    );
    const labels = new Map();
    for (const [index, entry] of entries.entries()) {
      if (entry.label) labels.set(entry.label, { entry, index });
    }
    sections.set(sectionNumber, { entryPath, entries, labels });
  }
  if (appliedOperations.size !== overlayOperations.length) {
    const missing = overlayOperations
      .filter(({ operationKey }) => !appliedOperations.has(operationKey))
      .map(({ sourceKind, operation }) =>
        `${sourceKind}:${operation.textbook_json}#${operation.label}`
      );
    throw new Error(`Textbook overlay targets were not applied: ${missing.join(', ')}`);
  }
  return sections;
}

function leanPaths() {
  return run('git', ['ls-tree', '-r', '--name-only', importReadRef])
    .split(/\r?\n/)
    .filter((item) =>
      /^staging\/SmoothManifoldsLee\/SmoothManifoldsLee\/Chap\d+\/.+\.lean$/.test(item)
    )
    .sort();
}

function sectionNumberFromPath(leanPath) {
  const sectionPart = leanPath.split('/')[4];
  const numbers = sectionPart.match(/\d+/g) ?? [];
  return Number(numbers[numbers.length - 1]);
}

function chapterNumberFromPath(leanPath) {
  const chapterPart = leanPath.split('/')[3];
  return Number(chapterPart.replace(/^Chap0*/, ''));
}

function chapterNumberFromTextbookEntry(entry, sectionInfo) {
  const raw = entry.context?.chapter_number ?? sectionInfo.entries[0]?.context?.chapter_number;
  const chapterNumber = Number(raw);
  return Number.isInteger(chapterNumber) && chapterNumber > 0 ? chapterNumber : null;
}

function labelFromLeanFilename(fileName) {
  const parts = fileName.replace(/\.lean$/, '').split('_');
  const kind = parts.shift();
  const extraIndex = parts.indexOf('extra');
  if (extraIndex !== -1) {
    const number = parts.slice(0, extraIndex).join('.');
    const suffix = parts.slice(extraIndex + 1).join('-');
    return `${kind} ${number}-extra-${suffix}`;
  }
  if (!parts.every((part) => /^\d+$/.test(part))) return null;
  const separator = kind === 'Problem' ? '-' : '.';
  return `${kind} ${parts.join(separator)}`;
}

function addSupportingLeanFile(map, ownerPath, leanPath, relation) {
  if (!map.has(ownerPath)) map.set(ownerPath, []);
  map.get(ownerPath).push(leanPath);
  return { path: leanPath, owner: ownerPath, relation };
}

function nestedOwnerPath(leanPath) {
  const parts = leanPath.split('/');
  if (parts.length <= 6) return null;
  return `${parts.slice(0, 5).join('/')}/${parts[5]}.lean`;
}

function topLevelOwnerForAuxLean(leanPath, topLevelLeanSet) {
  const dir = path.dirname(leanPath);
  const stemParts = path.basename(leanPath, '.lean').split('_');
  for (let end = stemParts.length - 1; end >= 2; end--) {
    const ownerStem = stemParts.slice(0, end).join('_');
    const ownerPath = `${dir}/${ownerStem}.lean`;
    if (
      ownerPath !== leanPath &&
      topLevelLeanSet.has(ownerPath) &&
      labelFromLeanFilename(`${ownerStem}.lean`)
    ) {
      return ownerPath;
    }
  }
  return null;
}

function leanModuleName(leanPath) {
  const prefix = 'staging/SmoothManifoldsLee/';
  if (!leanPath.startsWith(prefix) || !leanPath.endsWith('.lean')) return null;
  return leanPath.slice(prefix.length, -'.lean'.length).replaceAll('/', '.');
}

const directLeanImportsCache = new Map();

function directLeanImports(leanPath) {
  const cached = directLeanImportsCache.get(leanPath);
  if (cached) return cached;

  const imports = new Set();
  const source = run('git', ['show', `${importReadRef}:${leanPath}`]);
  for (const line of source.split(/\r?\n/)) {
    const match = line
      .replace(/--.*$/, '')
      .match(/^\s*(?:public\s+)?import\s+(.+?)\s*$/);
    if (!match) continue;
    for (const moduleName of match[1].trim().split(/\s+/)) {
      if (moduleName) imports.add(moduleName);
    }
  }
  directLeanImportsCache.set(leanPath, imports);
  return imports;
}

function slug(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function chapterId(chapterNumber) {
  return `sml.ch${chapterNumber}`;
}

function sectionId(chapterNumber, sectionNumber) {
  return `sml.ch${chapterNumber}.sec${sectionNumber}`;
}

function taskId(chapterNumber, sectionNumber, label) {
  return `${sectionId(chapterNumber, sectionNumber)}.${slug(label)}`;
}

function dcref(label) {
  const [kind, ...rest] = label.split(' ');
  return `lee-sm:${kind.toLowerCase()}:${rest.join(' ').toLowerCase()}`;
}

function normalizeTextbookLabel(label) {
  return String(label).normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function referencedChapter(label) {
  const match = normalizeTextbookLabel(label).match(/^[A-Za-z]+\s+([A-Z]|\d+)(?:[.-]|$)/);
  if (!match) return null;
  if (/^\d+$/.test(match[1])) return Number(match[1]);
  return match[1];
}

function stripReferenceSubpart(label) {
  const match = normalizeTextbookLabel(label).match(
    /^(.*?)(\((?:[a-z]|\d+|[ivxlcdm]+)\))$/i
  );
  if (!match) return null;
  return { baseLabel: match[1].trim(), subpart: match[2] };
}

function normalizedCitation(text) {
  return normalizeTextbookLabel(text ?? '')
    .replace(/[.。]+$/, '')
    .trim()
    .toLowerCase();
}

const statementEnvironments = new Set([
  'thm',
  'theorem',
  'prop',
  'proposition',
  'lemma',
  'cor',
  'corollary'
]);
const exerciseEnvironments = new Set(['problem', 'exercise']);

function isProofLocationBacklink(sourceEntry, targetEntry, dependencyLabel) {
  if (!statementEnvironments.has(String(sourceEntry.env ?? '').toLowerCase())) return false;
  if (!exerciseEnvironments.has(String(targetEntry.env ?? '').toLowerCase())) return false;

  const proof = normalizedCitation(sourceEntry.proof);
  const dependency = normalizedCitation(dependencyLabel);
  return proof === dependency || proof === `see ${dependency}`;
}

function terseProofLocationLabel(proof) {
  const text = normalizeTextbookLabel(proof ?? '').replace(/[.。]+$/, '').trim();
  const match = text.match(/^(?:see\s+)?((?:Problem|Exercise)\s+.+)$/i);
  return match?.[1] ?? null;
}

function textbookEntryForCandidate(candidate, sections) {
  const labelInfo = sections.get(candidate.sectionNumber)?.labels.get(candidate.label);
  if (!labelInfo) {
    throw new Error(
      `Textbook entry missing for generated candidate: section ${candidate.sectionNumber}#${candidate.label}`
    );
  }
  return labelInfo.entry;
}

function edgeHash(edges) {
  const canonical = edges
    .map(([source, target]) => `${source}\t${target}\n`)
    .sort()
    .join('');
  return createHash('sha256').update(canonical).digest('hex');
}

function stronglyConnectedComponents(nodeIds, edges, orderById) {
  const adjacency = new Map(nodeIds.map((id) => [id, []]));
  for (const [source, target] of edges) adjacency.get(source)?.push(target);

  let nextIndex = 0;
  const index = new Map();
  const lowlink = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(node) {
    index.set(node, nextIndex);
    lowlink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of adjacency.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target);
        lowlink.set(node, Math.min(lowlink.get(node), lowlink.get(target)));
      } else if (onStack.has(target)) {
        lowlink.set(node, Math.min(lowlink.get(node), index.get(target)));
      }
    }

    if (lowlink.get(node) !== index.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    const hasSelfLoop = component.length === 1 &&
      (adjacency.get(component[0]) ?? []).includes(component[0]);
    if (component.length > 1 || hasSelfLoop) {
      component.sort((a, b) => orderById.get(a) - orderById.get(b));
      components.push(component);
    }
  }

  for (const node of nodeIds) {
    if (!index.has(node)) visit(node);
  }
  components.sort((a, b) => orderById.get(a[0]) - orderById.get(b[0]));
  return components;
}

function dependencyDagReport(nodeIds, edges, orderById) {
  const outgoing = new Map(nodeIds.map((id) => [id, []]));
  const indegree = new Map(nodeIds.map((id) => [id, 0]));
  for (const [dependent, prerequisite] of edges) {
    outgoing.get(prerequisite).push(dependent);
    indegree.set(dependent, indegree.get(dependent) + 1);
  }

  const ready = nodeIds
    .filter((id) => indegree.get(id) === 0)
    .sort((a, b) => orderById.get(a) - orderById.get(b));
  let visited = 0;
  while (ready.length > 0) {
    const node = ready.shift();
    visited += 1;
    for (const dependent of outgoing.get(node) ?? []) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) {
        ready.push(dependent);
        ready.sort((a, b) => orderById.get(a) - orderById.get(b));
      }
    }
  }

  const cyclicTaskIds = nodeIds
    .filter((id) => indegree.get(id) > 0)
    .sort((a, b) => orderById.get(a) - orderById.get(b));
  return {
    nodeCount: nodeIds.length,
    edgeCount: edges.length,
    visitedNodeCount: visited,
    acyclic: cyclicTaskIds.length === 0,
    cyclicTaskIds
  };
}

function buildTextbookDependencyGraph(candidates, sections) {
  const importedChapterNumbers = new Set(candidates.map((candidate) => candidate.chapterNumber));
  const orderById = new Map();
  const candidateById = new Map();
  const candidatesByLabel = new Map();
  for (const [index, candidate] of candidates.entries()) {
    const id = taskId(candidate.chapterNumber, candidate.sectionNumber, candidate.label);
    if (candidateById.has(id)) throw new Error(`Duplicate generated task id: ${id}`);
    orderById.set(id, index);
    candidateById.set(id, candidate);
    const label = normalizeTextbookLabel(candidate.label);
    if (!candidatesByLabel.has(label)) candidatesByLabel.set(label, []);
    candidatesByLabel.get(label).push(candidate);
  }

  function candidateId(candidate) {
    return taskId(candidate.chapterNumber, candidate.sectionNumber, candidate.label);
  }

  function disambiguate(matches, dependencyLabel) {
    if (matches.length <= 1) return matches;
    const chapter = referencedChapter(dependencyLabel);
    if (!Number.isInteger(chapter)) return matches;
    const sameChapter = matches.filter((candidate) => candidate.chapterNumber === chapter);
    return sameChapter.length > 0 ? sameChapter : matches;
  }

  function resolveDependency(dependencyLabel) {
    const normalized = normalizeTextbookLabel(dependencyLabel);
    let matches = disambiguate(candidatesByLabel.get(normalized) ?? [], normalized);
    let mode = 'exact';
    let subpart = null;
    let lookupLabel = normalized;
    if (matches.length === 0) {
      const stripped = stripReferenceSubpart(normalized);
      if (stripped) {
        lookupLabel = normalizeTextbookLabel(stripped.baseLabel);
        matches = disambiguate(candidatesByLabel.get(lookupLabel) ?? [], lookupLabel);
        if (matches.length > 0) {
          mode = 'subpart';
          subpart = stripped.subpart;
        }
      }
    }
    if (matches.length === 1) {
      return { status: 'resolved', candidate: matches[0], mode, subpart, lookupLabel };
    }
    if (matches.length > 1) {
      return {
        status: 'ambiguous',
        lookupLabel,
        candidateIds: matches.map(candidateId)
      };
    }

    const chapter = referencedChapter(lookupLabel);
    if (
      typeof chapter === 'string' ||
      (Number.isInteger(chapter) && !importedChapterNumbers.has(chapter))
    ) {
      return { status: 'external', lookupLabel, referencedChapter: chapter };
    }
    return { status: 'unresolved-internal', lookupLabel, referencedChapter: chapter };
  }

  const dependsOnByTaskId = new Map(candidates.map((candidate) => [candidateId(candidate), []]));
  const rawInternalEdges = [];
  const retainedEdges = [];
  const externalDependencies = [];
  const resolvedSubpartDependencies = [];
  const suppressedProofLocationBacklinks = [];
  const unlistedProofLocationBacklinks = [];
  const unresolvedInternalDependencies = [];
  const ambiguousDependencies = [];
  const duplicateDependencies = [];
  const selfDependencies = [];
  let textbookDependencyReferenceCount = 0;
  let exactResolvedReferenceCount = 0;
  let subpartResolvedReferenceCount = 0;

  for (const candidate of candidates) {
    const id = candidateId(candidate);
    const entry = textbookEntryForCandidate(candidate, sections);
    const seenTargets = new Set();
    const explicitDependencies = entry.dependencies ?? [];
    for (const dependencyLabel of explicitDependencies) {
      textbookDependencyReferenceCount += 1;
      const resolution = resolveDependency(dependencyLabel);
      const diagnosticBase = {
        task_id: id,
        source_label: candidate.label,
        dependency_label: dependencyLabel
      };
      if (resolution.status === 'external') {
        externalDependencies.push({
          ...diagnosticBase,
          referenced_chapter: resolution.referencedChapter,
          reason: 'outside imported chapters'
        });
        continue;
      }
      if (resolution.status === 'unresolved-internal') {
        unresolvedInternalDependencies.push({
          ...diagnosticBase,
          lookup_label: resolution.lookupLabel,
          referenced_chapter: resolution.referencedChapter
        });
        continue;
      }
      if (resolution.status === 'ambiguous') {
        ambiguousDependencies.push({
          ...diagnosticBase,
          lookup_label: resolution.lookupLabel,
          candidate_task_ids: resolution.candidateIds
        });
        continue;
      }

      const target = resolution.candidate;
      const targetId = candidateId(target);
      rawInternalEdges.push([id, targetId]);
      if (resolution.mode === 'subpart') {
        subpartResolvedReferenceCount += 1;
        resolvedSubpartDependencies.push({
          ...diagnosticBase,
          resolved_task_id: targetId,
          subpart: resolution.subpart
        });
      } else {
        exactResolvedReferenceCount += 1;
      }
      if (id === targetId) {
        selfDependencies.push({ ...diagnosticBase, resolved_task_id: targetId });
        continue;
      }
      if (seenTargets.has(targetId)) {
        duplicateDependencies.push({ ...diagnosticBase, resolved_task_id: targetId });
        continue;
      }
      seenTargets.add(targetId);

      const targetEntry = textbookEntryForCandidate(target, sections);
      if (isProofLocationBacklink(entry, targetEntry, dependencyLabel)) {
        suppressedProofLocationBacklinks.push({
          ...diagnosticBase,
          resolved_task_id: targetId,
          proof: entry.proof
        });
        continue;
      }

      dependsOnByTaskId.get(id).push(targetId);
      retainedEdges.push([id, targetId]);
    }

    const terseReference = terseProofLocationLabel(entry.proof);
    if (terseReference) {
      const listed = explicitDependencies.some(
        (dependencyLabel) => normalizedCitation(dependencyLabel) === normalizedCitation(terseReference)
      );
      if (!listed) {
        const resolution = resolveDependency(terseReference);
        if (resolution.status === 'resolved') {
          unlistedProofLocationBacklinks.push({
            task_id: id,
            source_label: candidate.label,
            dependency_label: terseReference,
            resolved_task_id: candidateId(resolution.candidate),
            proof: entry.proof
          });
        }
      }
    }
  }

  const unlocksByTaskId = new Map(candidates.map((candidate) => [candidateId(candidate), []]));
  for (const [dependent, prerequisite] of retainedEdges) {
    unlocksByTaskId.get(prerequisite).push(dependent);
  }
  for (const unlocks of unlocksByTaskId.values()) {
    unlocks.sort((a, b) => orderById.get(a) - orderById.get(b));
  }

  const nodeIds = candidates.map(candidateId);
  const rawDependencyCycles = stronglyConnectedComponents(
    nodeIds,
    rawInternalEdges,
    orderById
  );
  const dag = dependencyDagReport(nodeIds, retainedEdges, orderById);
  const relationCounts = {
    same_section: 0,
    same_chapter_cross_section: 0,
    cross_chapter: 0
  };
  for (const [dependent, prerequisite] of retainedEdges) {
    const source = candidateById.get(dependent);
    const target = candidateById.get(prerequisite);
    if (
      source.chapterNumber === target.chapterNumber &&
      source.sectionNumber === target.sectionNumber
    ) {
      relationCounts.same_section += 1;
    } else if (source.chapterNumber === target.chapterNumber) {
      relationCounts.same_chapter_cross_section += 1;
    } else {
      relationCounts.cross_chapter += 1;
    }
  }

  const chapterCount = new Set(candidates.map((candidate) => candidate.chapterNumber)).size;
  const sectionCount = new Set(
    candidates.map((candidate) => `${candidate.chapterNumber}:${candidate.sectionNumber}`)
  ).size;
  const structuralUnlockEdgeCount = chapterCount + sectionCount + candidates.length;
  const reverseEdges = retainedEdges.map(([dependent, prerequisite]) => [prerequisite, dependent]);
  const diagnostics = {
    textbookDependencyReferenceCount,
    exactResolvedReferenceCount,
    subpartResolvedReferenceCount,
    externalReferenceCount: externalDependencies.length,
    rawInternalEdgeCount: rawInternalEdges.length,
    retainedEdgeCount: retainedEdges.length,
    suppressedProofLocationBacklinkCount: suppressedProofLocationBacklinks.length,
    nonemptyDependsOnTaskCount: [...dependsOnByTaskId.values()].filter((items) => items.length > 0).length,
    nonemptyDependencyUnlockTaskCount: [...unlocksByTaskId.values()].filter((items) => items.length > 0).length,
    structuralUnlockEdgeCount,
    totalUnlockEdgeCount: structuralUnlockEdgeCount + retainedEdges.length,
    relationCounts,
    dependsOnSha256: edgeHash(retainedEdges),
    unlocksSha256: edgeHash(reverseEdges),
    resolvedSubpartDependencies,
    externalDependencies,
    suppressedProofLocationBacklinks,
    unlistedProofLocationBacklinks,
    unresolvedInternalDependencies,
    ambiguousDependencies,
    duplicateDependencies,
    selfDependencies,
    rawDependencyCycles,
    dag
  };

  const failures = [];
  if (unresolvedInternalDependencies.length > 0) {
    failures.push(`${unresolvedInternalDependencies.length} unresolved internal dependencies`);
  }
  if (ambiguousDependencies.length > 0) {
    failures.push(`${ambiguousDependencies.length} ambiguous dependencies`);
  }
  if (duplicateDependencies.length > 0) {
    failures.push(`${duplicateDependencies.length} duplicate dependencies`);
  }
  if (selfDependencies.length > 0) {
    failures.push(`${selfDependencies.length} self dependencies`);
  }
  if (!dag.acyclic) failures.push(`retained graph is cyclic: ${dag.cyclicTaskIds.join(', ')}`);
  if (failures.length > 0) {
    throw new Error(
      `Invalid SmoothManifoldsLee textbook dependency graph: ${failures.join('; ')}\n` +
      JSON.stringify(diagnostics, null, 2)
    );
  }

  return { dependsOnByTaskId, unlocksByTaskId, diagnostics };
}

function sectionTitle(sectionNumber, sectionInfo) {
  const context = sectionInfo.entries[0]?.context;
  const raw = context?.section ?? `Section ${sectionNumber}`;
  return raw.replace(/^\d+\.?\s*/, '') || raw;
}

function chapterTitle(chapterNumber, sectionInfos) {
  for (const info of sectionInfos) {
    const title = info.entries[0]?.context?.chapter;
    if (title) return title;
  }
  return `Chapter ${chapterNumber}`;
}

function emptyGithub() {
  return { issue: null, pr: null, discussion: null };
}

function mergeReviewState(task, previous) {
  if (!previous) return task;
  const checks = task.kind === 'leaf'
    ? {
        informal_review: previous.checks?.informal_review ?? task.checks.informal_review,
        formal_review: previous.checks?.formal_review ?? task.checks.formal_review
      }
    : task.checks;

  return {
    ...task,
    status: previous.status ?? task.status,
    checks,
    review_notes: previous.review_notes ?? task.review_notes,
    github: previous.github ?? task.github
  };
}

function buildCandidates(sections) {
  const candidates = [];
  const unmatchedTopLevelLean = [];
  const unmatchedLabeledTopLevelLean = [];
  const nestedAuxLean = [];
  const unattachedNestedAuxLean = [];
  const attachedAuxLean = [];
  const supportingLeanByOwner = new Map();
  const paths = leanPaths();
  const topLevelLeanPaths = paths.filter((leanPath) => leanPath.split('/').length === 6);
  const topLevelLeanSet = new Set(topLevelLeanPaths);
  const importedChapterNumbers = new Set(topLevelLeanPaths.map(chapterNumberFromPath));

  for (const leanPath of paths) {
    const parts = leanPath.split('/');
    if (parts.length > 6) {
      nestedAuxLean.push(leanPath);
      const ownerPath = nestedOwnerPath(leanPath);
      if (ownerPath && topLevelLeanSet.has(ownerPath)) {
        attachedAuxLean.push(
          addSupportingLeanFile(supportingLeanByOwner, ownerPath, leanPath, 'nested')
        );
      } else {
        unattachedNestedAuxLean.push({
          path: leanPath,
          owner: ownerPath,
          reason: 'top-level owner not found'
        });
      }
      continue;
    }

    const label = labelFromLeanFilename(parts[5]);
    if (!label) {
      const ownerPath = topLevelOwnerForAuxLean(leanPath, topLevelLeanSet);
      if (ownerPath) {
        attachedAuxLean.push(
          addSupportingLeanFile(supportingLeanByOwner, ownerPath, leanPath, 'noncanonical-top-level')
        );
      }
    }
  }

  for (const leanPath of topLevelLeanPaths) {
    const parts = leanPath.split('/');
    const label = labelFromLeanFilename(parts[5]);
    const sectionNumber = sectionNumberFromPath(leanPath);
    const chapterNumber = chapterNumberFromPath(leanPath);
    const sectionInfo = sections.get(sectionNumber);
    if (!label) {
      if (!topLevelOwnerForAuxLean(leanPath, topLevelLeanSet)) {
        unmatchedTopLevelLean.push({
          path: leanPath,
          reason: 'noncanonical filename',
          action: 'manual classification required'
        });
      }
      continue;
    }
    const labelInfo = sectionInfo?.labels.get(label);
    if (!labelInfo) {
      unmatchedLabeledTopLevelLean.push({
        path: leanPath,
        label,
        section: sectionNumber,
        reason: 'label not in section JSON',
        action: 'manual textbook label or synthetic task required'
      });
      continue;
    }

    if (!supportingLeanByOwner.has(leanPath)) supportingLeanByOwner.set(leanPath, []);
    candidates.push({
      chapterNumber,
      sectionNumber,
      label,
      leanPath,
      supportingLeanPaths: supportingLeanByOwner.get(leanPath) ?? [],
      jsonPath: sectionInfo.entryPath,
      jsonIndex: labelInfo.index,
      context: labelInfo.entry.context ?? {}
    });
  }

  for (const unmatched of unmatchedLabeledTopLevelLean) {
    const helperModule = leanModuleName(unmatched.path);
    const owners = helperModule
      ? candidates
          .filter(
            (candidate) =>
              candidate.sectionNumber === unmatched.section &&
              directLeanImports(candidate.leanPath).has(helperModule)
          )
          .sort(
            (a, b) =>
              a.jsonIndex - b.jsonIndex || a.leanPath.localeCompare(b.leanPath)
          )
      : [];
    const owner = owners[0];
    if (!owner) {
      unmatchedTopLevelLean.push(unmatched);
      continue;
    }

    attachedAuxLean.push(
      addSupportingLeanFile(
        supportingLeanByOwner,
        owner.leanPath,
        unmatched.path,
        'imported-top-level'
      )
    );
  }

  const pairedLabels = new Set(
    candidates.map((item) => `${item.sectionNumber}\t${item.label}`)
  );
  for (const [sectionNumber, sectionInfo] of sections) {
    for (const [label, labelInfo] of sectionInfo.labels) {
      if (pairedLabels.has(`${sectionNumber}\t${label}`)) continue;

      const chapterNumber = chapterNumberFromTextbookEntry(labelInfo.entry, sectionInfo);
      if (chapterNumber === null || !importedChapterNumbers.has(chapterNumber)) continue;

      candidates.push({
        chapterNumber,
        sectionNumber,
        label,
        leanPath: null,
        supportingLeanPaths: [],
        jsonPath: sectionInfo.entryPath,
        jsonIndex: labelInfo.index,
        context: labelInfo.entry.context ?? {}
      });
    }
  }

  candidates.sort((a, b) =>
    a.chapterNumber - b.chapterNumber ||
    a.sectionNumber - b.sectionNumber ||
    a.jsonIndex - b.jsonIndex ||
    a.label.localeCompare(b.label)
  );

  return {
    candidates,
    unmatchedTopLevelLean,
    nestedAuxLean,
    attachedAuxLean,
    unattachedNestedAuxLean
  };
}

function buildDataset(candidates, sections, previous, dependencyGraph) {
  const tasks = [];
  const chapterNumbers = [...new Set(candidates.map((item) => item.chapterNumber))];
  const sectionNumbersByChapter = new Map();
  const candidatesBySection = new Map();

  for (const candidate of candidates) {
    const key = `${candidate.chapterNumber}:${candidate.sectionNumber}`;
    if (!candidatesBySection.has(key)) candidatesBySection.set(key, []);
    candidatesBySection.get(key).push(candidate);
    if (!sectionNumbersByChapter.has(candidate.chapterNumber)) {
      sectionNumbersByChapter.set(candidate.chapterNumber, new Set());
    }
    sectionNumbersByChapter.get(candidate.chapterNumber).add(candidate.sectionNumber);
  }

  const book = {
    id: 'sml.book',
    kind: 'root',
    parent: null,
    depends_on: [],
    unlocks: chapterNumbers.map(chapterId),
    dcref: null,
    chapter: null,
    title: 'Lee — Introduction to Smooth Manifolds',
    description: 'Review textbook-aligned Lean formalization tasks before deciding what should be ported into OpenGALib.',
    status: 'todo',
    checks: {},
    review_notes: [],
    files: {},
    editable: [],
    github: emptyGithub()
  };
  tasks.push(mergeReviewState(book, previous.get(book.id)));

  for (const chapterNumber of chapterNumbers) {
    const sectionNumbers = [...sectionNumbersByChapter.get(chapterNumber)].sort((a, b) => a - b);
    const sectionInfos = sectionNumbers.map((sectionNumber) => sections.get(sectionNumber));
    const chapter = {
      id: chapterId(chapterNumber),
      kind: 'cluster',
      parent: 'sml.book',
      depends_on: [],
      unlocks: sectionNumbers.map((sectionNumber) => sectionId(chapterNumber, sectionNumber)),
      dcref: null,
      chapter: chapterNumber,
      title: `Chapter ${chapterNumber} — ${chapterTitle(chapterNumber, sectionInfos)}`,
      description: `Chapter ${chapterNumber} textbook entries, with imported SmoothManifoldsLee Lean files attached where available.`,
      status: 'todo',
      checks: {},
      review_notes: [],
      files: {},
      editable: [],
      github: emptyGithub()
    };
    tasks.push(mergeReviewState(chapter, previous.get(chapter.id)));

    for (const sectionNumber of sectionNumbers) {
      const key = `${chapterNumber}:${sectionNumber}`;
      const items = candidatesBySection.get(key);
      const sectionInfo = sections.get(sectionNumber);
      const section = {
        id: sectionId(chapterNumber, sectionNumber),
        kind: 'cluster',
        parent: chapter.id,
        depends_on: [],
        unlocks: items.map((item) => taskId(chapterNumber, sectionNumber, item.label)),
        dcref: `lee-sm:${chapterNumber}.${sectionNumber}`,
        chapter: chapterNumber,
        title: `Section ${sectionNumber} — ${sectionTitle(sectionNumber, sectionInfo)}`,
        description: `Textbook section ${sectionNumber} entries, with imported Lean files attached where available.`,
        status: 'todo',
        checks: {},
        review_notes: [],
        files: { textbook_json: sectionInfo.entryPath },
        editable: [],
        github: emptyGithub()
      };
      tasks.push(mergeReviewState(section, previous.get(section.id)));

      for (const item of items) {
        const id = taskId(chapterNumber, sectionNumber, item.label);
        const leanFiles = item.leanPath
          ? [item.leanPath, ...item.supportingLeanPaths]
          : [];
        const source = {
          textbook_json: item.jsonPath,
          textbook_label: item.label
        };
        if (item.leanPath) {
          source.import_ref = importRef;
          source.lean_file = item.leanPath;
        }
        if (leanFiles.length > 1) {
          source.lean_files = leanFiles;
        }
        const files = {
          textbook_json: item.jsonPath
        };
        if (item.leanPath) {
          files.lean_source = item.leanPath;
        }
        const task = {
          id,
          kind: 'leaf',
          parent: section.id,
          depends_on: dependencyGraph.dependsOnByTaskId.get(id) ?? [],
          unlocks: dependencyGraph.unlocksByTaskId.get(id) ?? [],
          dcref: dcref(item.label),
          chapter: chapterNumber,
          title: item.label,
          description: item.leanPath
            ? `Textbook source and Lean file review for ${item.label}.`
            : `Textbook source review for ${item.label}; no imported Lean file is currently paired.`,
          status: 'todo',
          checks: {
            informal_review: 'pending',
            formal_review: 'pending'
          },
          review_notes: [],
          files,
          editable: [],
          github: emptyGithub(),
          review_kind: 'lean_textbook',
          source
        };
        tasks.push(mergeReviewState(task, previous.get(id)));
      }
    }
  }

  return {
    schema: 'openga-review.tasks.v2',
    project: 'smooth-manifolds-lee',
    title: 'Smooth Manifolds Lee',
    description: 'Semantic review queue for Lee textbook-aligned Lean formalization tasks.',
    review_kind: 'lean_textbook',
    tasks
  };
}

function loadAndValidateFormalAudit(dataset) {
  const audit = JSON.parse(fs.readFileSync(formalAuditPath, 'utf-8'));
  if (
    audit.schema !== 'openga-review.formal-audit.v1' ||
    audit.project !== 'smooth-manifolds-lee' ||
    typeof audit.importRef !== 'string' ||
    typeof audit.importCommit !== 'string' ||
    !isIsoCalendarDate(audit.reviewDate) ||
    !Array.isArray(audit.confirmedFalsePositives) ||
    !Array.isArray(audit.importOnlyCandidatesNotDowngraded)
  ) {
    throw new Error(`Invalid formal review audit: ${formalAuditPath}`);
  }
  const currentImportCommit = run('git', ['rev-parse', `${importReadRef}^{commit}`]).trim();
  if (audit.importCommit !== currentImportCommit) {
    throw new Error(
      `Formal review audit is for ${audit.importCommit}, but ${importReadRef} is ${currentImportCommit}`
    );
  }

  const leafTasks = dataset.tasks.filter((task) => task.kind === 'leaf');
  const taskById = new Map(leafTasks.map((task) => [task.id, task]));
  const confirmedIds = audit.confirmedFalsePositives.map((item) => item.taskId);
  const candidateIds = audit.importOnlyCandidatesNotDowngraded;
  if (new Set(confirmedIds).size !== confirmedIds.length) {
    throw new Error('Formal review audit contains duplicate confirmed task IDs');
  }
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new Error('Formal review audit contains duplicate import-only candidate IDs');
  }
  for (const taskId of confirmedIds) {
    const task = taskById.get(taskId);
    if (!task || task.checks?.formal_review !== 'pending') {
      throw new Error(`Confirmed formal audit finding must remain pending: ${taskId}`);
    }
  }
  for (const taskId of candidateIds) {
    const task = taskById.get(taskId);
    if (!task || task.checks?.formal_review !== 'done') {
      throw new Error(`Import-only formal audit candidate is not done: ${taskId}`);
    }
  }

  const formalDone = leafTasks.filter((task) => task.checks?.formal_review === 'done').length;
  const formalPending = leafTasks.filter((task) => task.checks?.formal_review === 'pending').length;
  if (
    audit.reviewTotalsAfterCorrection?.formalDone !== formalDone ||
    audit.reviewTotalsAfterCorrection?.formalPending !== formalPending
  ) {
    throw new Error(
      `Formal review audit totals are stale: expected ${formalDone}/${formalPending}`
    );
  }

  return {
    path: displayPath(formalAuditPath),
    reviewDate: audit.reviewDate,
    importCommit: audit.importCommit,
    confirmedFalsePositiveCount: confirmedIds.length,
    importOnlyCandidateCount: candidateIds.length,
    exactGetAxiomsStatus: audit.exactGetAxiomsFollowUp?.status ?? 'unknown'
  };
}

function report(
  candidates,
  sections,
  unmatchedTopLevelLean,
  nestedAuxLean,
  attachedAuxLean,
  unattachedNestedAuxLean,
  textbookOverlayDocuments,
  formalReviewAudit,
  textbookDependencyGraph
) {
  const pairedCandidates = candidates.filter((item) => item.leanPath !== null);
  const textbookOnlyCandidates = candidates.filter((item) => item.leanPath === null);
  const generatedLabels = new Set(
    candidates.map((item) => `${item.sectionNumber}\t${item.label}`)
  );
  const jsonWithoutLean = textbookOnlyCandidates.map(({ sectionNumber, label }) => ({
    section: sectionNumber,
    label
  }));
  const jsonOutsideImportedSections = [];
  for (const [sectionNumber, sectionInfo] of sections) {
    for (const label of sectionInfo.labels.keys()) {
      if (!generatedLabels.has(`${sectionNumber}\t${label}`)) {
        jsonOutsideImportedSections.push({ section: sectionNumber, label });
      }
    }
  }

  const countBy = (items, keyFn) =>
    Object.fromEntries(
      [...items.reduce((map, item) => {
        const key = keyFn(item);
        map.set(key, (map.get(key) ?? 0) + 1);
        return map;
      }, new Map())].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );

  return {
    importRef,
    textbookZipPath: displayPath(textbookZipPath),
    textbookOverlayPaths: textbookOverlayDocuments.map((document) => displayPath(document.path)),
    textbookOverlaySources: textbookOverlayDocuments.map((document) => ({
      kind: document.source.kind,
      title: document.source.title,
      url: document.source.url,
      operationCount: document.operations.length
    })),
    formalReviewAudit,
    generatedReviewTasks: candidates.length,
    leanPairedReviewTasks: pairedCandidates.length,
    textbookOnlyReviewTasks: textbookOnlyCandidates.length,
    matchedByChapter: countBy(pairedCandidates, (item) => `chapter${item.chapterNumber}`),
    matchedBySection: countBy(pairedCandidates, (item) => `section${String(item.sectionNumber).padStart(2, '0')}`),
    textbookOnlyByChapter: countBy(textbookOnlyCandidates, (item) => `chapter${item.chapterNumber}`),
    textbookOnlyBySection: countBy(textbookOnlyCandidates, (item) => `section${String(item.sectionNumber).padStart(2, '0')}`),
    unmatchedTopLevelLean,
    nestedAuxLean,
    attachedAuxLean,
    unattachedNestedAuxLean,
    jsonLabelsWithoutLean: jsonWithoutLean,
    jsonLabelsOutsideImportedSections: jsonOutsideImportedSections,
    textbookDependencyGraph,
    notes: [
      'Auxiliary Lean files are attached to their canonical owner task when a matching owner exists.',
      'Tracked official errata and separately attributed OpenGA clarifications are applied before textbook labels are matched or generated.',
      'Top-level Lean files without a JSON label are attached to the earliest paired task in the same section that directly imports them; otherwise they remain unmatched.',
      'JSON entries without matching Lean files inside imported chapters are generated as textbook-only review tasks without synthetic Lean paths.',
      'New textbook-only tasks start with both checks pending; formal review remains visible after mathematical review is completed.',
      'The transitive sorryAx audit is pinned to the exact import commit; import closure alone does not downgrade a task without a declaration-reference path.',
      'Textbook dependencies resolve globally across imported chapters; trailing part references such as Example 2.13(f) fall back to the owner entry only when no exact label exists.',
      'Terse statement-to-problem proof-location backlinks are reported but excluded from depends_on so that statement/problem pairs do not form cycles.',
      'External appendix or unimported-chapter references are reported but are not emitted as dangling task dependencies.',
      'JSON entries outside imported chapters are separated from the current Ch1-Ch5 review queue.'
    ]
  };
}

fs.mkdirSync(taskDir, { recursive: true });
const textbookOverlays = loadTextbookOverlays();
const sections = loadTextbookSections(textbookOverlays.operations);
const previous = previousTasksById();
const {
  candidates,
  unmatchedTopLevelLean,
  nestedAuxLean,
  attachedAuxLean,
  unattachedNestedAuxLean
} = buildCandidates(sections);
const textbookDependencyGraph = buildTextbookDependencyGraph(candidates, sections);
const dataset = buildDataset(candidates, sections, previous, textbookDependencyGraph);
const formalReviewAudit = loadAndValidateFormalAudit(dataset);
const yamlText = dump(dataset, { indent: 2, lineWidth: -1, seqNoIndent: true, sortKeys: false });
const reportText = JSON.stringify(
  report(
    candidates,
    sections,
    unmatchedTopLevelLean,
    nestedAuxLean,
    attachedAuxLean,
    unattachedNestedAuxLean,
    textbookOverlays.documents,
    formalReviewAudit,
    textbookDependencyGraph.diagnostics
  ),
  null,
  2
);
fs.writeFileSync(outputPath, yamlText, 'utf-8');
fs.writeFileSync(reportPath, `${reportText}\n`, 'utf-8');

if (importReadRef !== importRef) {
  console.log(`Read imported Lean files from ${importReadRef}; task metadata uses ${importRef}.`);
}
console.log(`Generated ${candidates.length} SmoothManifoldsLee review tasks.`);
console.log(`Wrote ${path.relative(projectRoot, outputPath)}`);
console.log(`Wrote ${path.relative(projectRoot, reportPath)}`);
