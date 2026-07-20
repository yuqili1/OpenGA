import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../..');
const taskPath = path.join(projectRoot, 'projects/smooth-manifolds-lee/tasks/all.tasks.yaml');
const outputDir = path.join(projectRoot, 'projects/smooth-manifolds-lee/lean-deps');
const defaultImportRef = 'origin/import/smooth-manifolds-lee';
const configuredImportRef = process.env.SMOOTH_MANIFOLDS_LEE_IMPORT_REF?.trim() || undefined;
const importRef = configuredImportRef ?? defaultImportRef;
const lakeBin = process.env.LAKE ?? '/root/.elan/bin/lake';
const elanBin = process.env.ELAN ?? '/root/.elan/bin/elan';
const stagingPrefix = 'staging/SmoothManifoldsLee/';

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    maxBuffer: 120 * 1024 * 1024,
    stdio: options.stdio ?? ['ignore', 'pipe', 'inherit'],
    ...options
  });
}

function gitRefExists(ref) {
  try {
    run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      stdio: ['ignore', 'ignore', 'ignore']
    });
    return true;
  } catch {
    return false;
  }
}

function resolveImportRef() {
  if (configuredImportRef) {
    if (gitRefExists(importRef)) return importRef;
    throw new Error(`Configured SmoothManifoldsLee import ref not found: ${importRef}`);
  }
  if (gitRefExists(defaultImportRef)) return defaultImportRef;
  const upstreamRef = 'upstream/import/smooth-manifolds-lee';
  if (gitRefExists(upstreamRef)) return upstreamRef;
  throw new Error(
    `SmoothManifoldsLee import ref not found. Fetch ${defaultImportRef} or ${upstreamRef}.`
  );
}

const resolvedImportRef = resolveImportRef();

function ensureToolchain() {
  if (!fs.existsSync(elanBin)) return;
  const installed = run(elanBin, ['toolchain', 'list'], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (installed.includes('leanprover/lean4:v4.30.0')) return;
  run(elanBin, ['toolchain', 'install', 'leanprover/lean4:v4.30.0'], {
    cwd: projectRoot,
    stdio: 'inherit'
  });
}

function readTasks() {
  const dataset = load(fs.readFileSync(taskPath, 'utf-8'));
  return (dataset.tasks ?? []).filter((task) => task.kind === 'leaf');
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

function moduleToLeanPath(moduleName) {
  if (moduleName === 'SmoothManifoldsLee') {
    return 'staging/SmoothManifoldsLee/SmoothManifoldsLee.lean';
  }
  if (!moduleName.startsWith('SmoothManifoldsLee.')) return null;
  return `${stagingPrefix}${moduleName.split('.').join('/')}.lean`;
}

function tempPathForLeanFile(tempProject, leanPath) {
  if (!leanPath.startsWith(stagingPrefix)) {
    throw new Error(`Unexpected Lean path: ${leanPath}`);
  }
  return path.join(tempProject, leanPath.slice(stagingPrefix.length));
}

function moduleOleanPath(tempProject, moduleName) {
  return path.join(tempProject, '.lake/build/lib/lean', `${moduleName.split('.').join('/')}.olean`);
}

function buildReviewModules(tempProject, modules) {
  let fullBuildFailed = false;
  const buildSkipped = process.env.OPENGA_SKIP_LEE_DEPS_BUILD === '1';
  if (!buildSkipped) {
    try {
      run(lakeBin, ['build', ...modules], { cwd: tempProject, stdio: 'inherit' });
    } catch {
      fullBuildFailed = true;
    }
  }

  const builtModules = [];
  const skippedModules = [];
  for (const moduleName of modules) {
    if (fs.existsSync(moduleOleanPath(tempProject, moduleName))) {
      builtModules.push(moduleName);
    } else {
      skippedModules.push({
        module: moduleName,
        lean_file: moduleToLeanPath(moduleName),
        reason: buildSkipped
          ? 'build skipped and no existing olean file was found'
          : fullBuildFailed
            ? 'lake build did not produce an olean file'
            : 'missing olean file'
      });
    }
  }

  if (builtModules.length === 0) {
    throw new Error('No SmoothManifoldsLee review modules built successfully.');
  }

  if (skippedModules.length) {
    console.warn(`Skipping ${skippedModules.length} Lean modules without olean output.`);
    for (const skipped of skippedModules) {
      console.warn(`  - ${skipped.module}`);
    }
  }
  return { builtModules, skippedModules, fullBuildFailed, buildSkipped };
}

function extractReferenceNames(source) {
  const names = new Set();
  let inBlockComment = false;
  for (const rawLine of source.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (inBlockComment) {
      if (trimmed.includes('-/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/-') && !trimmed.includes('-/')) {
      inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('--') || trimmed.startsWith('/-')) continue;

    const line = rawLine.split('--')[0].trim();
    const keyword = line.startsWith('#check ') ? '#check' : line.startsWith('recall ') ? 'recall' : null;
    if (!keyword) continue;

    const rest = line.slice(keyword.length).trim();
    const match = rest.match(/^([A-Za-z_][A-Za-z0-9_'.]*(?:\.[A-Za-z_][A-Za-z0-9_'.]*)*)/);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

function extractDeclarationNames(source) {
  const names = new Set();
  const namespaces = [];
  let inBlockComment = false;
  let inDocComment = false;

  for (const rawLine of source.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (inBlockComment) {
      if (trimmed.includes('-/')) inBlockComment = false;
      continue;
    }
    if (inDocComment) {
      if (trimmed.endsWith('-/')) inDocComment = false;
      continue;
    }
    if (trimmed.startsWith('/--')) {
      inDocComment = !trimmed.endsWith('-/');
      continue;
    }
    if (trimmed.startsWith('/-') && !trimmed.includes('-/')) {
      inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('/-') || trimmed.startsWith('--')) continue;

    const namespaceMatch = trimmed.match(/^namespace\s+([A-Za-z_][A-Za-z0-9_'.]*(?:\.[A-Za-z_][A-Za-z0-9_'.]*)*)\b/);
    if (namespaceMatch) {
      namespaces.push(namespaceMatch[1]);
      continue;
    }

    const endMatch = trimmed.match(/^end(?:\s+([A-Za-z_][A-Za-z0-9_'.]*(?:\.[A-Za-z_][A-Za-z0-9_'.]*)*))?\b/);
    if (endMatch?.[1]) {
      const index = namespaces.lastIndexOf(endMatch[1]);
      if (index >= 0) namespaces.splice(index);
      continue;
    }

    const line = rawLine.split('--')[0].trim();
    const match = line.match(
      /^(?:@\[[\s\S]*?\]\s*)*(?:noncomputable\s+)?(?:unsafe\s+)?(?:partial\s+)?(?:abbrev|axiom|class|def|inductive|lemma|opaque|structure|theorem)\s+([^\s(:{]+)/
    );
    if (!match) continue;

    const rawName = match[1].replace(/^_root_\./, '');
    if (!/^[A-Za-z_][A-Za-z0-9_'.]*(?:\.[A-Za-z_][A-Za-z0-9_'.]*)*$/.test(rawName)) continue;
    names.add(rawName);
    if (namespaces.length > 0 && !match[1].startsWith('_root_.')) {
      names.add([...namespaces, rawName].join('.'));
    }
  }

  return [...names].sort();
}

function extractRequestedNames(source) {
  return [...new Set([...extractDeclarationNames(source), ...extractReferenceNames(source)])].sort();
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8').trim();
  return content ? content.split(/\n+/).map(JSON.parse) : [];
}

function jsonl(items) {
  return items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
}

function escapeLeanString(value) {
  return JSON.stringify(value);
}

function nameLiteral(name) {
  return '`' + name.split('.').join('.');
}

function buildExtractor(moduleName, requestedNames, rawNodesPath, rawEdgesPath) {
  const requested = requestedNames
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_'.]*(\.[A-Za-z_][A-Za-z0-9_'.]*)*$/.test(name))
    .map(nameLiteral)
    .join(', ');
  return `import ${moduleName}
import Lean

open Lean Elab Command

def targetModule : String := ${escapeLeanString(moduleName)}
def requestedNames : Array Name := #[${requested}]

def constModule (env : Environment) (d : Name) : Option String :=
  (env.getModuleIdxFor? d).bind fun i =>
    (env.header.moduleNames[i.toNat]?).map (·.toString)

def interestingSource (moduleName : String) : Bool :=
  moduleName.startsWith "SmoothManifoldsLee" || moduleName.startsWith "Mathlib"

def sourceKind (moduleName : String) : String :=
  if moduleName.startsWith "SmoothManifoldsLee" then "lee"
  else if moduleName.startsWith "Mathlib" then "mathlib"
  else "other"

def nodeId (moduleName : String) (name : Name) : String :=
  moduleName ++ ":" ++ name.toString

def constKind (ci : ConstantInfo) : String :=
  match ci with
  | .thmInfo _ => "theorem"
  | .defnInfo _ => "definition"
  | .axiomInfo _ => "axiom"
  | _ => "other"

def pushName (xs : Array Name) (x : Name) : Array Name :=
  if xs.contains x then xs else xs.push x

def pushMany (xs : Array Name) (ys : Array Name) : Array Name :=
  ys.foldl pushName xs

def jsonLines (items : Array Json) : String :=
  items.foldl (fun acc item => acc ++ item.compress ++ "\\n") ""

def depsFor (env : Environment) (name : Name) (ci : ConstantInfo) : Array Name :=
  ci.type.getUsedConstants.filter fun dep =>
    dep != name && !dep.isInternal &&
      match constModule env dep with
      | some moduleName => interestingSource moduleName
      | none => false

run_cmd do
  let env ← getEnv
  let mut needed : Array Name := #[]
  let mut edges : Array Json := #[]

  for name in requestedNames do
    if name.isInternal then continue
    let some ci := env.find? name | continue
    let some moduleName := constModule env name | continue
    if !interestingSource moduleName then continue
    needed := pushName needed name
    let deps := depsFor env name ci
    needed := pushMany needed deps
    for dep in deps do
      let some depModuleName := constModule env dep | continue
      edges := edges.push <| Json.mkObj [
        ("from", Json.str (nodeId moduleName name)),
        ("to", Json.str (nodeId depModuleName dep)),
        ("fromName", Json.str name.toString),
        ("toName", Json.str dep.toString),
        ("kind", Json.str "statement")
      ]

  let mut nodes : Array Json := #[]
  for name in needed do
    let some ci := env.find? name | continue
    let some moduleName := constModule env name | continue
    if !interestingSource moduleName then continue
    let typeStr ← liftTermElabM do
      let formatted ← Meta.ppExpr ci.type
      return formatted.pretty
    let line := ((← Lean.findDeclarationRanges? name).map (·.range.pos.line)).getD 0
    nodes := nodes.push <| Json.mkObj [
      ("id", Json.str (nodeId moduleName name)),
      ("name", Json.str name.toString),
      ("module", Json.str moduleName),
      ("source", Json.str (sourceKind moduleName)),
      ("kind", Json.str (constKind ci)),
      ("type", Json.str typeStr),
      ("line", Json.num line)
    ]

  IO.FS.writeFile ${escapeLeanString(rawNodesPath)} (jsonLines nodes)
  IO.FS.writeFile ${escapeLeanString(rawEdgesPath)} (jsonLines edges)
  logInfo s!"wrote {nodes.size} dependency nodes and {edges.size} statement edges"
`;
}

function mergeById(items) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function mergeEdges(edges) {
  return [...new Map(edges.map((edge) => [`${edge.from}->${edge.to}:${edge.kind}`, edge])).values()];
}

function prepareProject(tempProject) {
  fs.mkdirSync(tempProject, { recursive: true });
  const archive = execFileSync('git', ['archive', resolvedImportRef, 'staging/SmoothManifoldsLee'], {
    cwd: projectRoot,
    maxBuffer: 200 * 1024 * 1024
  });
  execFileSync('tar', ['-x', '-C', tempProject, '--strip-components=2'], {
    input: archive,
    maxBuffer: 200 * 1024 * 1024
  });
}

function createTempProject() {
  const reusePath = process.env.OPENGA_LEE_DEPS_TMP_PROJECT;
  if (reusePath) {
    const resolved = path.resolve(reusePath);
    if (!fs.existsSync(path.join(resolved, 'lakefile.toml'))) {
      throw new Error(`OPENGA_LEE_DEPS_TMP_PROJECT is not a Lake project: ${resolved}`);
    }
    return { path: resolved, reused: true, keep: true };
  }
  return {
    path: fs.mkdtempSync(path.join(os.tmpdir(), 'openga-lee-deps-')),
    reused: false,
    keep: process.env.OPENGA_KEEP_LEE_DEPS_TMP === '1'
  };
}

function buildTaskRoots(tasks, nodesByFile, idsByName, tempProject) {
  const roots = {};
  for (const task of tasks) {
    const names = new Set();
    for (const leanFile of taskLeanFiles(task)) {
      for (const node of nodesByFile.get(leanFile) ?? []) names.add(node.id);
      const source = fs.readFileSync(tempPathForLeanFile(tempProject, leanFile), 'utf-8');
      for (const ref of extractReferenceNames(source)) {
        for (const id of idsByName.get(ref) ?? []) names.add(id);
      }
    }
    roots[task.id] = [...names].sort();
  }
  return roots;
}

function main() {
  if (resolvedImportRef !== importRef) {
    console.log(`Read imported Lean files from ${resolvedImportRef}; manifest metadata uses ${importRef}.`);
  }
  const tasks = readTasks();
  const leanFiles = [...new Set(tasks.flatMap(taskLeanFiles))].sort();
  const modules = [...new Set(leanFiles.map(leanPathToModule).filter(Boolean))].sort();
  const tempProjectInfo = createTempProject();
  const tempProject = tempProjectInfo.path;

  try {
    if (tempProjectInfo.reused) {
      console.log(`Reusing temp project: ${tempProject}`);
    } else {
      prepareProject(tempProject);
    }
    const requestedNamesByModule = new Map();
    for (const leanFile of leanFiles) {
      const source = fs.readFileSync(tempPathForLeanFile(tempProject, leanFile), 'utf-8');
      const moduleName = leanPathToModule(leanFile);
      if (!moduleName) continue;
      for (const name of extractRequestedNames(source)) {
        if (!requestedNamesByModule.has(moduleName)) requestedNamesByModule.set(moduleName, new Set());
        requestedNamesByModule.get(moduleName).add(name);
      }
    }

    ensureToolchain();
    if (process.env.OPENGA_SKIP_LEE_DEPS_CACHE !== '1') {
      run(lakeBin, ['exe', 'cache', 'get'], { cwd: tempProject, stdio: 'inherit' });
    }
    const buildSummary = buildReviewModules(tempProject, modules);
    const extractorPath = path.join(tempProject, 'ExtractReviewDeps.lean');
    const rawNodes = [];
    const rawEdges = [];
    buildSummary.builtModules.forEach((moduleName, index) => {
      const moduleNodesPath = path.join(tempProject, `raw-nodes-${index}.jsonl`);
      const moduleEdgesPath = path.join(tempProject, `raw-edges-${index}.jsonl`);
      const moduleRequested = [...(requestedNamesByModule.get(moduleName) ?? new Set())].sort();
      fs.writeFileSync(
        extractorPath,
        buildExtractor(moduleName, moduleRequested, moduleNodesPath, moduleEdgesPath),
        'utf-8'
      );
      run(lakeBin, ['env', 'lean', extractorPath], { cwd: tempProject });
      rawNodes.push(...readJsonl(moduleNodesPath));
      rawEdges.push(...readJsonl(moduleEdgesPath));
      if ((index + 1) % 25 === 0 || index + 1 === buildSummary.builtModules.length) {
        console.log(`Extracted Lean dependency data from ${index + 1}/${buildSummary.builtModules.length} modules.`);
      }
    });

    const nodes = mergeById(rawNodes);
    const edges = mergeEdges(rawEdges);
    const enrichedNodes = nodes
      .map((node) => ({ ...node, file: moduleToLeanPath(node.module) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const sortedEdges = edges.sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`));
    const idsByName = new Map();
    for (const node of enrichedNodes) {
      if (!idsByName.has(node.name)) idsByName.set(node.name, []);
      idsByName.get(node.name).push(node.id);
    }
    const nodesByFile = new Map();
    for (const node of enrichedNodes) {
      if (!node.file) continue;
      if (!nodesByFile.has(node.file)) nodesByFile.set(node.file, []);
      nodesByFile.get(node.file).push(node);
    }

    const manifest = {
      schema: 'openga-review.lean-deps.v1',
      project: 'smooth-manifolds-lee',
      importRef,
      leanToolchain: 'leanprover/lean4:v4.30.0',
      generatedReviewTasks: tasks.length,
      sourceFiles: leanFiles.length,
      modules: modules.length,
      modulesBuilt: buildSummary.builtModules.length,
      modulesSkipped: buildSummary.skippedModules.length,
      fullBuildFailed: buildSummary.buildSkipped ? null : buildSummary.fullBuildFailed,
      buildSkipped: buildSummary.buildSkipped,
      skippedModules: buildSummary.skippedModules,
      nodes: enrichedNodes.length,
      edges: sortedEdges.length
    };

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'nodes.jsonl'), jsonl(enrichedNodes), 'utf-8');
    fs.writeFileSync(path.join(outputDir, 'edges.jsonl'), jsonl(sortedEdges), 'utf-8');
    fs.writeFileSync(
      path.join(outputDir, 'task-roots.json'),
      `${JSON.stringify(buildTaskRoots(tasks, nodesByFile, idsByName, tempProject), null, 2)}\n`,
      'utf-8'
    );
    fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    console.log(`Generated ${enrichedNodes.length} dependency nodes and ${sortedEdges.length} statement edges.`);
  } finally {
    if (!tempProjectInfo.keep) {
      fs.rmSync(tempProject, { recursive: true, force: true });
    } else {
      console.log(`Kept temp project: ${tempProject}`);
    }
  }
}

main();
