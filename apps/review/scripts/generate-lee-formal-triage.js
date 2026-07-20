import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../..');
const projectDir = path.join(projectRoot, 'projects/smooth-manifolds-lee');
const taskPath = path.join(projectDir, 'tasks/all.tasks.yaml');
const formalAuditPath = path.join(projectDir, 'tasks/formal-audit.json');
const humanReviewPath = path.join(projectDir, 'tasks/formal-pending-review.json');
const repairValidationPath = path.join(projectDir, 'tasks/formal-repair-validation.json');
const outputPath = path.join(projectDir, 'tasks/formal-pending-triage.json');
const metadataImportRef = 'origin/import/smooth-manifolds-lee';
const importedProjectToolchainPath = 'staging/SmoothManifoldsLee/lean-toolchain';
const configuredImportRef = process.env.SMOOTH_MANIFOLDS_LEE_IMPORT_REF?.trim() || undefined;

function runAt(cwd, command, args) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 80 * 1024 * 1024
  });
}

function run(command, args) {
  return runAt(projectRoot, command, args);
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
  if (configuredImportRef) {
    if (gitRefExists(configuredImportRef)) return configuredImportRef;
    throw new Error(`Configured SmoothManifoldsLee import ref not found: ${configuredImportRef}`);
  }
  if (gitRefExists(metadataImportRef)) return metadataImportRef;
  const upstreamRef = metadataImportRef.replace(/^origin\//, 'upstream/');
  if (upstreamRef !== metadataImportRef && gitRefExists(upstreamRef)) return upstreamRef;
  throw new Error(`SmoothManifoldsLee import ref not found: ${metadataImportRef} or ${upstreamRef}`);
}

function taskLeanFiles(task) {
  const files = task.source?.lean_files?.length
    ? task.source.lean_files
    : task.source?.lean_file
      ? [task.source.lean_file]
      : [];
  return [...new Set(files)];
}

function patchCandidateLeanFiles(candidate) {
  const hasMany = Array.isArray(candidate.sourceFiles) && candidate.sourceFiles.length > 0;
  const hasOne = typeof candidate.sourceFile === 'string' && candidate.sourceFile.length > 0;
  if (hasMany === hasOne) {
    throw new Error(`Patch candidate ${candidate.taskId} must use exactly one source-file shape`);
  }
  const files = hasMany ? candidate.sourceFiles : [candidate.sourceFile];
  if (new Set(files).size !== files.length) {
    throw new Error(`Patch candidate ${candidate.taskId} repeats a source file`);
  }
  return files;
}

function validationSourceFileEntries(validation) {
  if (Array.isArray(validation.sourceFiles) && validation.sourceFiles.length > 0) {
    if (validation.sourceFile !== undefined) {
      throw new Error(`Repair validation ${validation.taskId} mixes source-file shapes`);
    }
    return validation.sourceFiles;
  }
  if (typeof validation.sourceFile !== 'string') {
    throw new Error(`Repair validation ${validation.taskId} has no source files`);
  }
  return [{
    path: validation.sourceFile,
    module: validation.module,
    sourceSha256: validation.sourceSha256,
    patchedSourceSha256: validation.patchedSourceSha256,
    directSorryTokens: validation.directSorryTokens,
    moduleCompilation: validation.moduleCompilation
  }];
}

function leanFileToModule(sourceFile) {
  return sourceFile
    .replace(/^staging\/SmoothManifoldsLee\//, '')
    .replace(/\.lean$/, '')
    .split('/')
    .join('.');
}

function importedProjectRelativePath(sourceFile) {
  const prefix = 'staging/SmoothManifoldsLee/';
  if (!sourceFile.startsWith(prefix)) {
    throw new Error(`Source file is outside the imported SmoothManifoldsLee project: ${sourceFile}`);
  }
  return sourceFile.slice(prefix.length);
}

function validateReplayablePatch(patchPath, sourceEntries, sourceContents, taskId) {
  const expectedPaths = sourceEntries.map((entry) => importedProjectRelativePath(entry.path));
  const numstat = run('git', ['apply', '--numstat', patchPath]).trim();
  const patchPaths = numstat === ''
    ? []
    : numstat.split(/\r?\n/).map((line) => {
        const fields = line.split('\t');
        if (fields.length !== 3 || fields[0] === '-' || fields[1] === '-') {
          throw new Error(`Replayable patch has an unsupported entry for ${taskId}: ${line}`);
        }
        return fields[2];
      });
  if (
    new Set(patchPaths).size !== patchPaths.length ||
    patchPaths.length !== expectedPaths.length ||
    expectedPaths.some((sourcePath) => !patchPaths.includes(sourcePath))
  ) {
    throw new Error(`Replayable patch paths do not match ${taskId}`);
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openga-lee-patch-'));
  try {
    for (const entry of sourceEntries) {
      const relativePath = importedProjectRelativePath(entry.path);
      const temporaryPath = path.resolve(temporaryRoot, relativePath);
      if (!temporaryPath.startsWith(`${temporaryRoot}${path.sep}`)) {
        throw new Error(`Unsafe replayable-patch path for ${taskId}: ${relativePath}`);
      }
      fs.mkdirSync(path.dirname(temporaryPath), { recursive: true });
      fs.writeFileSync(temporaryPath, sourceContents.get(entry.path), 'utf-8');
    }
    runAt(temporaryRoot, 'git', ['apply', '--unidiff-zero', '--check', patchPath]);
    runAt(temporaryRoot, 'git', ['apply', '--unidiff-zero', patchPath]);
    for (const entry of sourceEntries) {
      const patchedSource = fs.readFileSync(
        path.join(temporaryRoot, importedProjectRelativePath(entry.path)),
        'utf-8'
      );
      const patchedSha256 = createHash('sha256').update(patchedSource).digest('hex');
      if (entry.patchedSourceSha256 !== patchedSha256) {
        throw new Error(`Replayable-patch output SHA-256 does not match ${entry.path}`);
      }
      if (analyzeLeanSource(patchedSource).sorryCount !== entry.directSorryTokens.after) {
        throw new Error(`Replayable-patch sorry count does not match ${entry.path}`);
      }
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function stripLeanTrivia(source) {
  let output = '';
  let index = 0;
  let blockDepth = 0;
  let inString = false;
  while (index < source.length) {
    if (blockDepth > 0) {
      if (source.startsWith('/-', index)) {
        blockDepth += 1;
        output += '  ';
        index += 2;
      } else if (source.startsWith('-/', index)) {
        blockDepth -= 1;
        output += '  ';
        index += 2;
      } else {
        output += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    if (inString) {
      if (source[index] === '\\') {
        output += '  ';
        index += 2;
      } else if (source[index] === '"') {
        inString = false;
        output += ' ';
        index += 1;
      } else {
        output += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    if (source.startsWith('--', index)) {
      while (index < source.length && source[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      continue;
    }
    if (source.startsWith('/-', index)) {
      blockDepth = 1;
      output += '  ';
      index += 2;
      continue;
    }
    if (source[index] === '"') {
      inString = true;
      output += ' ';
      index += 1;
      continue;
    }
    output += source[index];
    index += 1;
  }
  if (blockDepth !== 0 || inString) throw new Error('Unterminated Lean comment or string');
  return output;
}

function analyzeLeanSource(source) {
  const code = stripLeanTrivia(source);
  const sorryCount = [...code.matchAll(/\bsorry\b/g)].length;
  const admitCount = [...code.matchAll(/\badmit\b/g)].length;
  const axiomCount = [...code.matchAll(/\baxiom\b/g)].length;
  const referenceCommands = [];
  for (const [lineIndex, line] of code.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*(#check|recall)\s+(.+?)\s*$/);
    if (match) {
      referenceCommands.push({
        line: lineIndex + 1,
        command: match[1],
        target: match[2]
      });
    }
  }
  const hasDeclaration = /^\s*(?:(?:private|protected|noncomputable|unsafe|partial)\s+)*(?:theorem|lemma|def|abbrev|example|instance|structure|class|inductive|axiom|opaque)\b/m.test(code);
  return { sorryCount, admitCount, axiomCount, referenceCommands, hasDeclaration };
}

const dataset = load(fs.readFileSync(taskPath, 'utf-8'));
const formalAudit = JSON.parse(fs.readFileSync(formalAuditPath, 'utf-8'));
const humanReview = JSON.parse(fs.readFileSync(humanReviewPath, 'utf-8'));
const repairValidation = JSON.parse(fs.readFileSync(repairValidationPath, 'utf-8'));
const importReadRef = resolveImportReadRef();
const importCommit = run('git', ['rev-parse', `${importReadRef}^{commit}`]).trim();
const importedProjectToolchain = run(
  'git',
  ['show', `${importReadRef}:${importedProjectToolchainPath}`]
).trim();
const importedManifest = JSON.parse(
  run('git', ['show', `${importReadRef}:staging/SmoothManifoldsLee/lake-manifest.json`])
);
if (formalAudit.importCommit !== importCommit) {
  throw new Error(
    `Formal audit is for ${formalAudit.importCommit}, but ${importReadRef} is ${importCommit}`
  );
}
if (formalAudit.leanToolchain !== importedProjectToolchain) {
  throw new Error(
    `Formal audit expects ${formalAudit.leanToolchain}, but the imported project pins ${importedProjectToolchain}`
  );
}

const confirmedTransitive = new Set(
  formalAudit.confirmedFalsePositives.map((finding) => finding.taskId)
);
const pendingTasks = dataset.tasks.filter(
  (task) => task.kind === 'leaf' && task.checks?.formal_review === 'pending'
);
const pendingTasksById = new Map(pendingTasks.map((task) => [task.id, task]));

if (humanReview.schema !== 'openga-review.formal-pending-human-review.v1') {
  throw new Error(`Unsupported human-review schema: ${humanReview.schema}`);
}
if (humanReview.project !== 'smooth-manifolds-lee') {
  throw new Error(`Unexpected human-review project: ${humanReview.project}`);
}
if (humanReview.importRef !== formalAudit.importRef || humanReview.importRef !== metadataImportRef) {
  throw new Error(`Unexpected human-review import ref: ${humanReview.importRef}`);
}
if (humanReview.importCommit !== importCommit) {
  throw new Error(
    `Human review is for ${humanReview.importCommit}, but ${importReadRef} is ${importCommit}`
  );
}
if (humanReview.reviewDate !== formalAudit.reviewDate) {
  throw new Error('Formal audit and pending human review use different review dates');
}
if (humanReview.leanToolchain !== formalAudit.leanToolchain) {
  throw new Error('Formal audit and pending human review use different Lean toolchains');
}
if (humanReview.sourceBranchPolicy !== 'read_only') {
  throw new Error('The imported Lean source branch must remain read-only during review');
}
if (humanReview.summary.formalPendingTasksReviewed !== pendingTasks.length) {
  throw new Error('Human-review task total does not match the formal-pending queue');
}

if (repairValidation.schema !== 'openga-review.formal-repair-validation.v1') {
  throw new Error(`Unsupported repair-validation schema: ${repairValidation.schema}`);
}
if (repairValidation.project !== 'smooth-manifolds-lee') {
  throw new Error(`Unexpected repair-validation project: ${repairValidation.project}`);
}
if (
  repairValidation.importRef !== metadataImportRef ||
  repairValidation.importCommit !== importCommit
) {
  throw new Error('Repair validation does not match the resolved import commit');
}
if (
  repairValidation.validationDate !== humanReview.reviewDate ||
  repairValidation.leanToolchain !== importedProjectToolchain
) {
  throw new Error('Repair validation does not match the review date or Lean toolchain');
}
if (repairValidation.sourceBranchPolicy !== 'read_only') {
  throw new Error('Repair validation must preserve the imported source branch as read-only');
}
const importedMathlib = importedManifest.packages?.find((pkg) => pkg.name === 'mathlib');
if (!importedMathlib || repairValidation.mathlibCommit !== importedMathlib.rev) {
  throw new Error('Repair validation does not match the mathlib revision in lake-manifest.json');
}
const leanVersionMatch = importedProjectToolchain.match(/^leanprover\/lean4:v(.+)$/);
if (
  !leanVersionMatch ||
  repairValidation.environment?.leanVersion !== leanVersionMatch[1] ||
  !/^[0-9a-f]{40}$/.test(repairValidation.environment?.leanCommit ?? '') ||
  typeof repairValidation.environment?.lakeVersion !== 'string' ||
  !/^[0-9a-f]{64}$/.test(repairValidation.environment?.leanReleaseAssetSha256 ?? '') ||
  !Number.isInteger(repairValidation.environment?.mathlibCacheArchives) ||
  repairValidation.environment.mathlibCacheArchives <= 0
) {
  throw new Error('Repair validation has invalid Lean environment metadata');
}

function validateGroupedFindingIds(sectionName) {
  const groups = humanReview[sectionName]?.byChapter;
  if (!Array.isArray(groups)) throw new Error(`${sectionName}.byChapter must be an array`);
  const ids = [];
  for (const group of groups) {
    if (!Number.isInteger(group.chapter) || !Array.isArray(group.taskIds)) {
      throw new Error(`Invalid ${sectionName} chapter group`);
    }
    for (const taskId of group.taskIds) {
      const task = pendingTasksById.get(taskId);
      if (!task) throw new Error(`${sectionName} references non-pending task ${taskId}`);
      if (task.chapter !== group.chapter) {
        throw new Error(`${sectionName} places ${taskId} in chapter ${group.chapter}`);
      }
      ids.push(taskId);
    }
  }
  if (new Set(ids).size !== ids.length) throw new Error(`${sectionName} contains duplicate task IDs`);
  return ids;
}

const semanticFindingIds = validateGroupedFindingIds('semanticCoverageFindings');
const dependencyFindingIds = validateGroupedFindingIds('dependencyOrBuildFindings');
if (semanticFindingIds.length !== humanReview.summary.semanticCoverageFindings) {
  throw new Error('Semantic-coverage finding count does not match its summary');
}
if (dependencyFindingIds.length !== humanReview.summary.dependencyOrBuildFindings) {
  throw new Error('Dependency/build finding count does not match its summary');
}

const expectedRepairValidationPath = path.relative(projectRoot, repairValidationPath);
const supportedCandidateStatuses = new Set([
  'proposal_uncompiled',
  'verified_compiled_no_sorryAx'
]);
const patchCandidateIds = [];
const verifiedPatchCandidates = new Map();
for (const candidate of humanReview.lowRiskPatchCandidates) {
  const task = pendingTasksById.get(candidate.taskId);
  if (!task) throw new Error(`Patch candidate references non-pending task ${candidate.taskId}`);
  const pairedFiles = new Set(taskLeanFiles(task));
  const candidateFiles = patchCandidateLeanFiles(candidate);
  if (candidateFiles.some((sourceFile) => !pairedFiles.has(sourceFile))) {
    throw new Error(`Patch candidate source is not paired with ${candidate.taskId}`);
  }
  if (!supportedCandidateStatuses.has(candidate.status)) {
    throw new Error(`Patch candidate ${candidate.taskId} has an unsupported status`);
  }
  if (candidate.status === 'verified_compiled_no_sorryAx') {
    if (candidate.validationEvidence !== expectedRepairValidationPath) {
      throw new Error(`Verified patch candidate ${candidate.taskId} has no matching evidence path`);
    }
    verifiedPatchCandidates.set(candidate.taskId, candidate);
  } else if (candidate.validationEvidence !== undefined) {
    throw new Error(`Uncompiled patch candidate ${candidate.taskId} must not cite validation evidence`);
  }
  patchCandidateIds.push(candidate.taskId);
}
if (new Set(patchCandidateIds).size !== patchCandidateIds.length) {
  throw new Error('Low-risk patch candidates contain duplicate task IDs');
}
if (patchCandidateIds.length !== humanReview.summary.lowRiskPatchCandidates) {
  throw new Error('Low-risk patch-candidate count does not match its summary');
}
if (humanReview.summary.compiledPatchCandidates !== verifiedPatchCandidates.size) {
  throw new Error('Compiled patch-candidate count does not match verified evidence links');
}

if (!Array.isArray(repairValidation.candidates)) {
  throw new Error('Repair validation candidates must be an array');
}
if (repairValidation.candidates.length !== repairValidation.summary.validatedCandidates) {
  throw new Error('Repair-validation candidate count does not match its summary');
}
if (repairValidation.summary.validatedCandidates !== verifiedPatchCandidates.size) {
  throw new Error('Repair validation does not cover every verified patch candidate exactly');
}
const validatedTaskIds = new Set();
const validatedSourceFiles = new Set();
let validatedSorryBefore = 0;
let validatedSorryReplaced = 0;
let validatedSorryAfter = 0;
let validatedDeclarations = 0;
let declarationsWithoutSorryAx = 0;
for (const validation of repairValidation.candidates) {
  if (validatedTaskIds.has(validation.taskId)) {
    throw new Error(`Duplicate repair-validation candidate: ${validation.taskId}`);
  }
  validatedTaskIds.add(validation.taskId);
  const candidate = verifiedPatchCandidates.get(validation.taskId);
  if (!candidate) {
    throw new Error(`Repair validation references a non-verified candidate: ${validation.taskId}`);
  }
  const task = pendingTasksById.get(validation.taskId);
  const taskFiles = taskLeanFiles(task);
  const candidateFiles = patchCandidateLeanFiles(candidate);
  const sourceEntries = validationSourceFileEntries(validation);
  const validationFiles = sourceEntries.map((entry) => entry.path);
  if (
    new Set(validationFiles).size !== validationFiles.length ||
    validationFiles.length !== candidateFiles.length ||
    candidateFiles.some((sourceFile) => !validationFiles.includes(sourceFile))
  ) {
    throw new Error(`Repair-validation sources do not match ${validation.taskId}`);
  }
  const sourceAnalyses = new Map();
  const sourceContents = new Map();
  let replacedInChangedFiles = 0;
  for (const entry of sourceEntries) {
    if (validatedSourceFiles.has(entry.path)) {
      throw new Error(`Repair-validation source is reused by multiple candidates: ${entry.path}`);
    }
    validatedSourceFiles.add(entry.path);
    const expectedModule = leanFileToModule(entry.path);
    if (entry.module !== expectedModule) {
      throw new Error(`Repair-validation module does not match ${validation.taskId}: ${entry.path}`);
    }
    const source = run('git', ['show', `${importReadRef}:${entry.path}`]);
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    if (entry.sourceSha256 !== sourceSha256) {
      throw new Error(`Repair-validation source SHA-256 does not match ${entry.path}`);
    }
    if (
      !/^[0-9a-f]{64}$/.test(entry.patchedSourceSha256) ||
      entry.patchedSourceSha256 === entry.sourceSha256
    ) {
      throw new Error(`Invalid patched-source SHA-256 for ${entry.path}`);
    }
    const sourceAnalysis = analyzeLeanSource(source);
    sourceAnalyses.set(entry.path, sourceAnalysis);
    sourceContents.set(entry.path, source);
    if (
      entry.directSorryTokens?.before !== sourceAnalysis.sorryCount ||
      !Number.isInteger(entry.directSorryTokens?.replacedByCandidate) ||
      entry.directSorryTokens.replacedByCandidate < 0 ||
      entry.directSorryTokens?.after !==
        entry.directSorryTokens.before - entry.directSorryTokens.replacedByCandidate
    ) {
      throw new Error(`Repair-validation file-level sorry count does not match ${entry.path}`);
    }
    if (
      entry.moduleCompilation?.status !== 'passed' ||
      entry.moduleCompilation?.exitCode !== 0
    ) {
      throw new Error(`Repair-validation compilation did not pass for ${entry.path}`);
    }
    replacedInChangedFiles += entry.directSorryTokens.replacedByCandidate;
  }
  let taskSorryBefore = 0;
  for (const taskFile of taskFiles) {
    let analysis = sourceAnalyses.get(taskFile);
    if (!analysis) {
      analysis = analyzeLeanSource(run('git', ['show', `${importReadRef}:${taskFile}`]));
    }
    taskSorryBefore += analysis.sorryCount;
  }
  const expectedCoverage = candidate.scope === 'all direct sorry tokens in the task'
    ? 'complete'
    : taskSorryBefore === 0
      ? 'statement_addition'
      : 'partial';
  if (
    validation.directSorryTokens?.before !== taskSorryBefore ||
    validation.candidateCoverage !== expectedCoverage ||
    !Number.isInteger(validation.directSorryTokens?.replacedByCandidate) ||
    validation.directSorryTokens.replacedByCandidate !== replacedInChangedFiles ||
    (expectedCoverage === 'statement_addition'
      ? validation.directSorryTokens.replacedByCandidate !== 0
      : validation.directSorryTokens.replacedByCandidate <= 0) ||
    validation.directSorryTokens?.after !==
      validation.directSorryTokens.before - validation.directSorryTokens.replacedByCandidate ||
    (expectedCoverage === 'complete' && validation.directSorryTokens.after !== 0) ||
    (expectedCoverage === 'partial' && validation.directSorryTokens.after <= 0) ||
    (expectedCoverage === 'statement_addition' && validation.directSorryTokens.after !== 0)
  ) {
    throw new Error(`Repair-validation sorry count does not match ${validation.taskId}`);
  }
  const patchEvidence = validation.patchFile ?? null;
  if ((candidate.patchEvidence ?? null) !== patchEvidence) {
    throw new Error(`Repair-validation patch evidence does not match ${validation.taskId}`);
  }
  if (patchEvidence) {
    const patchPath = path.resolve(projectRoot, patchEvidence);
    if (!patchPath.startsWith(`${projectRoot}${path.sep}`) || !fs.existsSync(patchPath)) {
      throw new Error(`Repair-validation patch path is invalid: ${patchEvidence}`);
    }
    const patchSha256 = createHash('sha256').update(fs.readFileSync(patchPath)).digest('hex');
    if (validation.patchSha256 !== patchSha256) {
      throw new Error(`Repair-validation patch SHA-256 does not match ${validation.taskId}`);
    }
    validateReplayablePatch(patchPath, sourceEntries, sourceContents, validation.taskId);
  } else if (validation.patchSha256 !== undefined) {
    throw new Error(`Repair validation ${validation.taskId} has a hash without a patch file`);
  }
  if (sourceEntries.length > 1) {
    const integration = validation.integrationCompilation;
    const expectedModules = taskFiles.map(leanFileToModule);
    if (
      integration?.status !== 'passed' ||
      integration?.exitCode !== 0 ||
      !Array.isArray(integration.modules) ||
      new Set(integration.modules).size !== integration.modules.length ||
      integration.modules.length !== expectedModules.length ||
      expectedModules.some((moduleName) => !integration.modules.includes(moduleName))
    ) {
      throw new Error(`Invalid multi-file integration compilation for ${validation.taskId}`);
    }
  } else if (validation.integrationCompilation !== undefined) {
    throw new Error(`Single-file repair validation has unexpected integration data: ${validation.taskId}`);
  }
  if (!Array.isArray(validation.declarations) || validation.declarations.length === 0) {
    throw new Error(`Repair validation has no declarations for ${validation.taskId}`);
  }
  const expectedDeclarationNames = new Set(candidate.declarations);
  const declarationNames = new Set(validation.declarations.map((decl) => decl.name));
  if (
    declarationNames.size !== validation.declarations.length ||
    declarationNames.size !== expectedDeclarationNames.size ||
    [...expectedDeclarationNames].some((name) => !declarationNames.has(name))
  ) {
    throw new Error(`Repair-validation declarations do not match ${validation.taskId}`);
  }
  for (const declaration of validation.declarations) {
    const hasInlineProof = typeof declaration.proof === 'string' && declaration.proof.length > 0;
    const hasPatchProof = declaration.proofEvidence === patchEvidence && patchEvidence !== null;
    if (
      (!hasInlineProof && !hasPatchProof) ||
      (hasInlineProof && analyzeLeanSource(declaration.proof).sorryCount !== 0) ||
      !Array.isArray(declaration.axioms) ||
      declaration.containsSorryAx !== false ||
      declaration.axioms.includes('sorryAx')
    ) {
      throw new Error(`Invalid declaration-level axioms evidence for ${declaration.name}`);
    }
    declarationsWithoutSorryAx += 1;
  }
  validatedSorryBefore += validation.directSorryTokens.before;
  validatedSorryReplaced += validation.directSorryTokens.replacedByCandidate;
  validatedSorryAfter += validation.directSorryTokens.after;
  validatedDeclarations += validation.declarations.length;
}
if ([...verifiedPatchCandidates.keys()].some((taskId) => !validatedTaskIds.has(taskId))) {
  throw new Error('At least one verified patch candidate is missing validation evidence');
}
for (const [field, value] of Object.entries({
  sourceFiles: validatedSourceFiles.size,
  directSorryTokensBefore: validatedSorryBefore,
  directSorryTokensReplaced: validatedSorryReplaced,
  directSorryTokensAfter: validatedSorryAfter,
  changedDeclarations: validatedDeclarations,
  declarationsWithoutSorryAx
})) {
  if (repairValidation.summary[field] !== value) {
    throw new Error(`Repair-validation summary field ${field} does not match its candidates`);
  }
}

const triageTasks = [];

for (const task of pendingTasks) {
  const leanFiles = taskLeanFiles(task);
  const files = [];
  let directSorryCount = 0;
  let hasDeclaration = false;
  const referenceCommands = [];
  for (const leanFile of leanFiles) {
    let source;
    try {
      source = run('git', ['show', `${importReadRef}:${leanFile}`]);
    } catch {
      throw new Error(`Unable to read ${leanFile} from ${importReadRef}`);
    }
    const analysis = analyzeLeanSource(source);
    if (analysis.admitCount > 0 || analysis.axiomCount > 0) {
      throw new Error(
        `${leanFile} contains an unclassified direct admit or axiom declaration`
      );
    }
    directSorryCount += analysis.sorryCount;
    hasDeclaration ||= analysis.hasDeclaration;
    if (analysis.sorryCount > 0) {
      files.push({ path: leanFile, directSorryCount: analysis.sorryCount });
    }
    for (const command of analysis.referenceCommands) {
      referenceCommands.push({ path: leanFile, ...command });
    }
  }

  let category;
  if (leanFiles.length === 0) category = 'textbook_only';
  else if (confirmedTransitive.has(task.id)) category = 'confirmed_transitive_sorryAx';
  else if (directSorryCount > 0) category = 'direct_sorry';
  else if (referenceCommands.length > 0 && !hasDeclaration) category = 'reference_only';
  else category = 'semantic_or_dependency_review';

  triageTasks.push({
    taskId: task.id,
    chapter: task.chapter,
    title: task.title,
    category,
    leanFiles,
    directSorryCount,
    directSorryFiles: files,
    referenceCommands
  });
}

const triageTasksById = new Map(triageTasks.map((task) => [task.taskId, task]));
const reviewedRepairOwnerIds = new Set();
for (const owner of humanReview.reviewedRepairOwners ?? []) {
  if (reviewedRepairOwnerIds.has(owner.ownerTaskId)) {
    throw new Error(`Duplicate reviewed repair owner: ${owner.ownerTaskId}`);
  }
  if (triageTasksById.get(owner.ownerTaskId)?.category !== 'direct_sorry') {
    throw new Error(`Reviewed repair owner is not direct-sorry: ${owner.ownerTaskId}`);
  }
  if (!Array.isArray(owner.downstreamTaskIds) || owner.downstreamTaskIds.length === 0) {
    throw new Error(`Reviewed repair owner has no downstream tasks: ${owner.ownerTaskId}`);
  }
  if (new Set(owner.downstreamTaskIds).size !== owner.downstreamTaskIds.length) {
    throw new Error(`Reviewed repair owner repeats a downstream task: ${owner.ownerTaskId}`);
  }
  for (const downstreamTaskId of owner.downstreamTaskIds) {
    if (!pendingTasksById.has(downstreamTaskId) || downstreamTaskId === owner.ownerTaskId) {
      throw new Error(`Invalid downstream task for ${owner.ownerTaskId}: ${downstreamTaskId}`);
    }
  }
  if (typeof owner.evidence !== 'string' || owner.evidence.length === 0) {
    throw new Error(`Reviewed repair owner has no evidence label: ${owner.ownerTaskId}`);
  }
  reviewedRepairOwnerIds.add(owner.ownerTaskId);
}
if (reviewedRepairOwnerIds.size !== humanReview.summary.reviewedRepairOwners) {
  throw new Error('Reviewed repair-owner count does not match its summary');
}

const categories = [
  'textbook_only',
  'direct_sorry',
  'confirmed_transitive_sorryAx',
  'reference_only',
  'semantic_or_dependency_review'
];
function categoryCounts(tasks) {
  return Object.fromEntries(
    categories.map((category) => [
      category,
      tasks.filter((task) => task.category === category).length
    ])
  );
}

const report = {
  schema: 'openga-review.formal-pending-triage.v1',
  project: 'smooth-manifolds-lee',
  importRef: metadataImportRef,
  importCommit,
  reviewDate: formalAudit.reviewDate,
  summary: {
    formalPendingTasks: triageTasks.length,
    categories: categoryCounts(triageTasks),
    directSorryTokens: triageTasks.reduce((sum, task) => sum + task.directSorryCount, 0)
  },
  byChapter: [1, 2, 3, 4, 5].map((chapter) => {
    const tasks = triageTasks.filter((task) => task.chapter === chapter);
    return { chapter, formalPendingTasks: tasks.length, categories: categoryCounts(tasks) };
  }),
  categoryDefinitions: {
    textbook_only: 'No imported Lean file is paired with the textbook entry.',
    direct_sorry: 'At least one paired task or auxiliary Lean file contains a direct sorry token.',
    confirmed_transitive_sorryAx: 'No direct sorry is required; the commit-pinned formal audit proves a declaration path to sorryAx.',
    reference_only: 'The paired files contain #check/recall commands but no Lean declaration and no direct sorry.',
    semantic_or_dependency_review: 'No direct sorry was found, but the task is still pending because its statement, proof coverage, or trusted dependency requires semantic review.'
  },
  humanReview: {
    report: path.relative(projectRoot, humanReviewPath),
    formalPendingTasksReviewed: humanReview.summary.formalPendingTasksReviewed,
    semanticCoverageFindings: semanticFindingIds.length,
    dependencyOrBuildFindings: dependencyFindingIds.length,
    reviewedRepairOwners: reviewedRepairOwnerIds.size,
    lowRiskPatchCandidates: patchCandidateIds.length,
    compiledPatchCandidates: humanReview.summary.compiledPatchCandidates
  },
  tasks: triageTasks
};

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
console.log(`Wrote ${path.relative(projectRoot, outputPath)}`);
console.log(JSON.stringify(report.summary));
