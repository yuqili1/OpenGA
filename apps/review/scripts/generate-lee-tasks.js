import fs from 'node:fs';
import path from 'node:path';
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
const textbookOverlayPath = path.join(
  projectRoot,
  'projects/smooth-manifolds-lee/sources/errata/ism-2e.json'
);
const jsonPrefix =
  'sections-1to8-Introduction-to-Smooth-Manifolds-Second-Edition-2013-by-John-M.-Lee';
const taskDir = path.join(projectRoot, 'projects/smooth-manifolds-lee/tasks');
const outputPath = path.join(taskDir, 'all.tasks.yaml');
const reportPath = path.join(taskDir, 'generation-report.json');
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

function loadTextbookOverlay() {
  const document = JSON.parse(fs.readFileSync(textbookOverlayPath, 'utf-8'));
  if (
    document.schema !== 'openga-review.textbook-overlay.v1' ||
    !Array.isArray(document.operations)
  ) {
    throw new Error(`Invalid textbook overlay: ${textbookOverlayPath}`);
  }
  return document.operations;
}

function applyTextbookOverlay(entries, entryPath, operations, appliedOperations) {
  const result = entries.map((entry) => ({ ...entry }));
  operations.forEach((operation, operationIndex) => {
    if (operation.textbook_json !== entryPath) return;
    const matches = result
      .map((entry, index) => (entry.label === operation.label ? index : -1))
      .filter((index) => index !== -1);
    if (operation.operation === 'merge' && matches.length === 1) {
      result[matches[0]] = { ...result[matches[0]], ...operation.patch };
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
    appliedOperations.add(operationIndex);
  });
  return result;
}

function loadTextbookSections() {
  const sections = new Map();
  const overlayOperations = loadTextbookOverlay();
  const appliedOperations = new Set();
  for (const entryPath of zipJsonEntries()) {
    const match = entryPath.match(/section(\d+)\.json$/);
    if (!match) continue;
    const sectionNumber = Number(match[1]);
    const raw = run('unzip', ['-p', textbookZipPath, entryPath]);
    const entries = applyTextbookOverlay(
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
      .map((operation, index) => ({ operation, index }))
      .filter(({ index }) => !appliedOperations.has(index))
      .map(({ operation }) => `${operation.textbook_json}#${operation.label}`);
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

function buildDataset(candidates, sections, previous) {
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
          depends_on: [],
          unlocks: [],
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

function report(
  candidates,
  sections,
  unmatchedTopLevelLean,
  nestedAuxLean,
  attachedAuxLean,
  unattachedNestedAuxLean
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
    textbookOverlayPath: displayPath(textbookOverlayPath),
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
    notes: [
      'Auxiliary Lean files are attached to their canonical owner task when a matching owner exists.',
      'Tracked official errata overlays are applied before textbook labels are matched or generated.',
      'Top-level Lean files without a JSON label are attached to the earliest paired task in the same section that directly imports them; otherwise they remain unmatched.',
      'JSON entries without matching Lean files inside imported chapters are generated as textbook-only review tasks without synthetic Lean paths.',
      'New textbook-only tasks start with both checks pending; formal review remains visible after mathematical review is completed.',
      'JSON entries outside imported chapters are separated from the current Ch1-Ch5 review queue.'
    ]
  };
}

fs.mkdirSync(taskDir, { recursive: true });
const sections = loadTextbookSections();
const previous = previousTasksById();
const {
  candidates,
  unmatchedTopLevelLean,
  nestedAuxLean,
  attachedAuxLean,
  unattachedNestedAuxLean
} = buildCandidates(sections);
const dataset = buildDataset(candidates, sections, previous);
const yamlText = dump(dataset, { indent: 2, lineWidth: -1, seqNoIndent: true, sortKeys: false });
const reportText = JSON.stringify(
  report(candidates, sections, unmatchedTopLevelLean, nestedAuxLean, attachedAuxLean, unattachedNestedAuxLean),
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
