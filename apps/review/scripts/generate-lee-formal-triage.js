import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../..');
const projectDir = path.join(projectRoot, 'projects/smooth-manifolds-lee');
const taskPath = path.join(projectDir, 'tasks/all.tasks.yaml');
const formalAuditPath = path.join(projectDir, 'tasks/formal-audit.json');
const humanReviewPath = path.join(projectDir, 'tasks/formal-pending-review.json');
const outputPath = path.join(projectDir, 'tasks/formal-pending-triage.json');
const metadataImportRef = 'origin/import/smooth-manifolds-lee';
const importedProjectToolchainPath = 'staging/SmoothManifoldsLee/lean-toolchain';
const configuredImportRef = process.env.SMOOTH_MANIFOLDS_LEE_IMPORT_REF?.trim() || undefined;

function run(command, args) {
  return execFileSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    maxBuffer: 80 * 1024 * 1024
  });
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
const importReadRef = resolveImportReadRef();
const importCommit = run('git', ['rev-parse', `${importReadRef}^{commit}`]).trim();
const importedProjectToolchain = run(
  'git',
  ['show', `${importReadRef}:${importedProjectToolchainPath}`]
).trim();
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

const patchCandidateIds = [];
for (const candidate of humanReview.lowRiskPatchCandidates) {
  const task = pendingTasksById.get(candidate.taskId);
  if (!task) throw new Error(`Patch candidate references non-pending task ${candidate.taskId}`);
  if (!taskLeanFiles(task).includes(candidate.sourceFile)) {
    throw new Error(`Patch candidate source is not paired with ${candidate.taskId}`);
  }
  if (candidate.status !== 'proposal_uncompiled') {
    throw new Error(`Patch candidate ${candidate.taskId} has an unsupported status`);
  }
  patchCandidateIds.push(candidate.taskId);
}
if (new Set(patchCandidateIds).size !== patchCandidateIds.length) {
  throw new Error('Low-risk patch candidates contain duplicate task IDs');
}
if (patchCandidateIds.length !== humanReview.summary.lowRiskPatchCandidates) {
  throw new Error('Low-risk patch-candidate count does not match its summary');
}
if (humanReview.summary.compiledPatchCandidates !== 0) {
  throw new Error('Uncompiled review proposals must not be reported as compiled patches');
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
