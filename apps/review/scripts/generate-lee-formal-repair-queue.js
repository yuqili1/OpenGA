import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../..');
const projectDir = path.join(projectRoot, 'projects/smooth-manifolds-lee');
const taskPath = path.join(projectDir, 'tasks/all.tasks.yaml');
const triagePath = path.join(projectDir, 'tasks/formal-pending-triage.json');
const humanReviewPath = path.join(projectDir, 'tasks/formal-pending-review.json');
const outputPath = path.join(projectDir, 'tasks/formal-repair-queue.json');
const metadataImportRef = 'origin/import/smooth-manifolds-lee';
const configuredImportRef = process.env.SMOOTH_MANIFOLDS_LEE_IMPORT_REF?.trim() || undefined;
const stagingPrefix = 'staging/SmoothManifoldsLee/';

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
  if (gitRefExists(upstreamRef)) return upstreamRef;
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

function leanPathToModule(leanPath) {
  if (!leanPath.startsWith(stagingPrefix) || !leanPath.endsWith('.lean')) return null;
  return leanPath
    .slice(stagingPrefix.length, -'.lean'.length)
    .split('/')
    .join('.');
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

function extractImportModules(source) {
  const imports = new Set();
  for (const rawLine of stripLeanTrivia(source).split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^import\s+(.+?)\s*$/);
    if (!match) continue;
    for (const moduleName of match[1].split(/\s+/)) {
      if (/^[A-Za-z_][A-Za-z0-9_'.]*(?:\.[A-Za-z_][A-Za-z0-9_'.]*)*$/.test(moduleName)) {
        imports.add(moduleName);
      }
    }
  }
  return [...imports];
}

const dataset = load(fs.readFileSync(taskPath, 'utf-8'));
const triage = JSON.parse(fs.readFileSync(triagePath, 'utf-8'));
const humanReview = JSON.parse(fs.readFileSync(humanReviewPath, 'utf-8'));
const importReadRef = resolveImportReadRef();
const importCommit = run('git', ['rev-parse', `${importReadRef}^{commit}`]).trim();

if (triage.schema !== 'openga-review.formal-pending-triage.v1') {
  throw new Error(`Unsupported triage schema: ${triage.schema}`);
}
if (humanReview.schema !== 'openga-review.formal-pending-human-review.v1') {
  throw new Error(`Unsupported human-review schema: ${humanReview.schema}`);
}
for (const report of [triage, humanReview]) {
  if (report.project !== 'smooth-manifolds-lee') {
    throw new Error(`Unexpected report project: ${report.project}`);
  }
  if (report.importRef !== metadataImportRef || report.importCommit !== importCommit) {
    throw new Error('Repair-queue inputs do not match the resolved import commit');
  }
}
if (triage.reviewDate !== humanReview.reviewDate) {
  throw new Error('Triage and human review use different review dates');
}
if (humanReview.sourceBranchPolicy !== 'read_only') {
  throw new Error('The imported Lean source branch must remain read-only during review');
}
if (humanReview.reviewedRepairOwnerSemantics?.notAxiomCertification !== true) {
  throw new Error('Reviewed repair-owner links must explicitly disclaim axioms certification');
}

const leafTasks = dataset.tasks.filter((task) => task.kind === 'leaf');
const tasksById = new Map(leafTasks.map((task) => [task.id, task]));
const triageById = new Map(triage.tasks.map((task) => [task.taskId, task]));
const pendingIds = new Set(
  leafTasks
    .filter((task) => task.checks?.formal_review === 'pending')
    .map((task) => task.id)
);
if (pendingIds.size !== triage.summary.formalPendingTasks) {
  throw new Error('Formal-pending task count does not match the triage report');
}
if (triageById.size !== pendingIds.size || [...pendingIds].some((id) => !triageById.has(id))) {
  throw new Error('Triage task IDs do not exactly match the formal-pending queue');
}

const moduleOwnerTaskId = new Map();
for (const task of leafTasks) {
  for (const leanFile of taskLeanFiles(task)) {
    const moduleName = leanPathToModule(leanFile);
    if (!moduleName) throw new Error(`Unexpected task Lean path: ${leanFile}`);
    const previousOwner = moduleOwnerTaskId.get(moduleName);
    if (previousOwner && previousOwner !== task.id) {
      throw new Error(`Lean module ${moduleName} is paired with multiple tasks`);
    }
    moduleOwnerTaskId.set(moduleName, task.id);
  }
}

const sourceModuleImportersByOwner = new Map();
for (const importerTask of leafTasks) {
  const importedModules = new Set();
  for (const leanFile of taskLeanFiles(importerTask)) {
    const source = run('git', ['show', `${importReadRef}:${leanFile}`]);
    for (const moduleName of extractImportModules(source)) importedModules.add(moduleName);
  }
  for (const moduleName of importedModules) {
    const ownerTaskId = moduleOwnerTaskId.get(moduleName);
    if (!ownerTaskId || ownerTaskId === importerTask.id) continue;
    const importers = sourceModuleImportersByOwner.get(ownerTaskId) ?? new Set();
    importers.add(importerTask.id);
    sourceModuleImportersByOwner.set(ownerTaskId, importers);
  }
}

function taskGraphDescendants(taskId) {
  const descendants = new Set();
  const queue = [...(tasksById.get(taskId)?.unlocks ?? [])];
  while (queue.length > 0) {
    const descendantId = queue.shift();
    if (descendants.has(descendantId)) continue;
    const descendant = tasksById.get(descendantId);
    if (!descendant) throw new Error(`Unknown task-graph descendant ${descendantId}`);
    descendants.add(descendantId);
    queue.push(...(descendant.unlocks ?? []));
  }
  return [...descendants].sort();
}

const lowRiskByTask = new Map(
  humanReview.lowRiskPatchCandidates.map((candidate) => [candidate.taskId, candidate])
);
function groupedFindingIds(sectionName) {
  return new Set(
    humanReview[sectionName].byChapter.flatMap((chapterGroup) => chapterGroup.taskIds)
  );
}
const semanticFindingIds = groupedFindingIds('semanticCoverageFindings');
const dependencyFindingIds = groupedFindingIds('dependencyOrBuildFindings');
const ownerLinks = humanReview.reviewedRepairOwners ?? [];
const reviewedDownstreamByOwner = new Map();
const reviewedOwnerEvidence = new Map();
for (const link of ownerLinks) {
  if (reviewedDownstreamByOwner.has(link.ownerTaskId)) {
    throw new Error(`Duplicate reviewed repair owner: ${link.ownerTaskId}`);
  }
  const ownerTriage = triageById.get(link.ownerTaskId);
  if (ownerTriage?.category !== 'direct_sorry') {
    throw new Error(`Reviewed repair owner is not a direct-sorry task: ${link.ownerTaskId}`);
  }
  if (!Array.isArray(link.downstreamTaskIds) || link.downstreamTaskIds.length === 0) {
    throw new Error(`Reviewed repair owner has no downstream tasks: ${link.ownerTaskId}`);
  }
  if (typeof link.evidence !== 'string' || link.evidence.length === 0) {
    throw new Error(`Reviewed repair owner has no evidence label: ${link.ownerTaskId}`);
  }
  const downstream = reviewedDownstreamByOwner.get(link.ownerTaskId) ?? new Set();
  for (const downstreamTaskId of link.downstreamTaskIds) {
    if (!pendingIds.has(downstreamTaskId)) {
      throw new Error(`${link.ownerTaskId} references non-pending downstream task ${downstreamTaskId}`);
    }
    if (downstreamTaskId === link.ownerTaskId) {
      throw new Error(`${link.ownerTaskId} cannot be its own downstream task`);
    }
    downstream.add(downstreamTaskId);
  }
  reviewedDownstreamByOwner.set(link.ownerTaskId, downstream);
  reviewedOwnerEvidence.set(link.ownerTaskId, link.evidence);
}
if (reviewedDownstreamByOwner.size !== humanReview.summary.reviewedRepairOwners) {
  throw new Error('Reviewed repair-owner count does not match its summary');
}

function queueTier(candidate, reviewedDownstreamCount, referenceGraphPendingCount, sourceImporterCount) {
  if (candidate?.scope === 'all direct sorry tokens in the task') {
    return 'A_low_risk_complete_candidate';
  }
  if (reviewedDownstreamCount >= 2 || referenceGraphPendingCount >= 2 || sourceImporterCount >= 4) {
    return 'B_high_leverage_owner';
  }
  if (candidate) return 'C_low_risk_partial_candidate';
  if (reviewedDownstreamCount >= 1 || referenceGraphPendingCount >= 1 || sourceImporterCount >= 1) {
    return 'D_single_dependency_owner';
  }
  return 'E_standalone_or_unmapped';
}

const directSorryTasks = triage.tasks.filter((task) => task.category === 'direct_sorry');
const queue = directSorryTasks.map((triageTask) => {
  const task = tasksById.get(triageTask.taskId);
  if (!task) throw new Error(`Missing task metadata for ${triageTask.taskId}`);
  const graphDescendants = taskGraphDescendants(task.id);
  const pendingGraphDescendants = graphDescendants.filter((id) => pendingIds.has(id));
  const reviewedDownstreamTaskIds = [...(reviewedDownstreamByOwner.get(task.id) ?? [])].sort();
  const sourceModuleDirectImporterTaskIds = [
    ...(sourceModuleImportersByOwner.get(task.id) ?? [])
  ].sort();
  const formalPendingSourceModuleDirectImporterTaskIds =
    sourceModuleDirectImporterTaskIds.filter((id) => pendingIds.has(id));
  const lowRiskCandidate = lowRiskByTask.get(task.id) ?? null;
  const semanticCoverageFinding = semanticFindingIds.has(task.id);
  return {
    taskId: task.id,
    chapter: task.chapter,
    title: task.title,
    tier: queueTier(
      lowRiskCandidate,
      reviewedDownstreamTaskIds.length,
      pendingGraphDescendants.length,
      formalPendingSourceModuleDirectImporterTaskIds.length
    ),
    directSorryCount: triageTask.directSorryCount,
    directSorryFiles: triageTask.directSorryFiles,
    reviewedDownstreamTaskIds,
    reviewedRepairOwnerEvidence: reviewedOwnerEvidence.get(task.id) ?? null,
    sourceModuleDirectImporterTaskIds,
    formalPendingSourceModuleDirectImporterTaskIds,
    referenceGraph: {
      directUnlockTaskIds: [...(task.unlocks ?? [])],
      transitiveUnlockTaskIds: graphDescendants,
      formalPendingTransitiveUnlockTaskIds: pendingGraphDescendants
    },
    reviewFlags: {
      semanticCoverageFinding,
      dependencyOrBuildFinding: dependencyFindingIds.has(task.id)
    },
    firstAction: semanticCoverageFinding
      ? 'resolve_statement_or_coverage_before_proof'
      : lowRiskCandidate?.status === 'verified_compiled_no_sorryAx'
        ? 'prepare_verified_patch_for_source_branch'
        : lowRiskCandidate
          ? 'compile_low_risk_proposal'
          : 'scope_proof_and_dependencies',
    lowRiskCandidate
  };
});

const tierOrder = [
  'A_low_risk_complete_candidate',
  'B_high_leverage_owner',
  'C_low_risk_partial_candidate',
  'D_single_dependency_owner',
  'E_standalone_or_unmapped'
];
const tierRank = new Map(tierOrder.map((tier, index) => [tier, index]));
queue.sort((a, b) =>
  tierRank.get(a.tier) - tierRank.get(b.tier) ||
  b.reviewedDownstreamTaskIds.length - a.reviewedDownstreamTaskIds.length ||
  b.referenceGraph.formalPendingTransitiveUnlockTaskIds.length -
    a.referenceGraph.formalPendingTransitiveUnlockTaskIds.length ||
  b.formalPendingSourceModuleDirectImporterTaskIds.length -
    a.formalPendingSourceModuleDirectImporterTaskIds.length ||
  a.directSorryCount - b.directSorryCount ||
  a.taskId.localeCompare(b.taskId)
);
queue.forEach((entry, index) => {
  entry.rank = index + 1;
});

const categoryDirectSorryCount = triage.summary.categories.direct_sorry;
if (queue.length !== categoryDirectSorryCount) {
  throw new Error('Repair queue does not contain every direct-sorry task');
}
if (queue.reduce((sum, task) => sum + task.directSorryCount, 0) !== triage.summary.directSorryTokens) {
  throw new Error('Repair-queue sorry-token total does not match triage');
}

const report = {
  schema: 'openga-review.formal-repair-queue.v1',
  project: 'smooth-manifolds-lee',
  importRef: metadataImportRef,
  importCommit,
  reviewDate: triage.reviewDate,
  sourceBranchPolicy: 'read_only',
  summary: {
    directSorryTasks: queue.length,
    directSorryTokens: triage.summary.directSorryTokens,
    reviewedRepairOwners: reviewedDownstreamByOwner.size,
    semanticDesignBeforeProof: queue.filter(
      (task) => task.reviewFlags.semanticCoverageFinding
    ).length,
    lowRiskCompleteCandidates: queue.filter(
      (task) => task.lowRiskCandidate?.scope === 'all direct sorry tokens in the task'
    ).length,
    lowRiskPartialCandidates: queue.filter(
      (task) => task.lowRiskCandidate &&
        task.lowRiskCandidate.scope !== 'all direct sorry tokens in the task'
    ).length,
    verifiedLowRiskCandidates: queue.filter(
      (task) => task.lowRiskCandidate?.status === 'verified_compiled_no_sorryAx'
    ).length,
    uncompiledLowRiskCandidates: queue.filter(
      (task) => task.lowRiskCandidate?.status === 'proposal_uncompiled'
    ).length,
    byTier: Object.fromEntries(
      tierOrder.map((tier) => [tier, queue.filter((task) => task.tier === tier).length])
    )
  },
  byChapter: [1, 2, 3, 4, 5].map((chapter) => {
    const tasks = queue.filter((task) => task.chapter === chapter);
    return {
      chapter,
      directSorryTasks: tasks.length,
      directSorryTokens: tasks.reduce((sum, task) => sum + task.directSorryCount, 0),
      byTier: Object.fromEntries(
        tierOrder.map((tier) => [tier, tasks.filter((task) => task.tier === tier).length])
      )
    };
  }),
  orderingPolicy: [
    'For any queued task with a semantic-coverage finding, repair the statement or coverage design before attempting its proof.',
    'A: low-risk candidates that could remove every direct sorry in their task.',
    'B: owners with at least two reviewed downstream tasks, at least two pending textbook-reference descendants, or at least four pending direct source-module importers.',
    'C: remaining low-risk candidates that remove only part of a task.',
    'D: owners with one reviewed downstream task, one pending reference-graph descendant, or one pending direct source-module importer.',
    'E: remaining direct-sorry tasks with no currently mapped downstream task.',
    'Within a tier, sort by reviewed downstream tasks, pending reference descendants, pending source importers, then fewer direct sorry tokens.'
  ],
  limitations: [
    'This is an investigation queue, not a proof-completion or effort estimate.',
    'The unlock graph represents reviewed textbook references; it does not certify Lean proof dependencies or sorryAx propagation.',
    'Direct source-module importers are a coverage signal only; importing a module does not prove use of one of its sorry-backed declarations.',
    'Reviewed downstream links are source findings recorded in formal-pending-review.json and carry their own evidence kind.',
    'A low-risk patch is verified_compiled_no_sorryAx only after Lean 4.30.0 compilation and exact declaration-level axioms checks succeed; all others remain proposal_uncompiled.'
  ],
  queue
};

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
console.log(`Wrote ${path.relative(projectRoot, outputPath)}`);
console.log(JSON.stringify(report.summary));
