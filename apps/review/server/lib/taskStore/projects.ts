import path from 'node:path';
import type { ReviewProject } from '../../../src/lib/taskSchema';
import { defaultProjectId, projectRoot } from './paths.js';

export type ProjectConfig = ReviewProject & {
  yamlPath: string;
  jsonPath?: string;
  textbookZipPath?: string;
  textbookOverlayPaths?: string[];
};

const smoothManifoldsLeeZipPath = path.join(
  projectRoot,
  'projects/smooth-manifolds-lee/sources/smooth-manifolds.zip'
);

const smoothManifoldsLeeOverlayPath = path.join(
  projectRoot,
  'projects/smooth-manifolds-lee/sources/errata/ism-2e.json'
);

const smoothManifoldsLeeClarificationPath = path.join(
  projectRoot,
  'projects/smooth-manifolds-lee/sources/clarifications/openga.json'
);

const projectConfigs: ProjectConfig[] = [
  {
    id: defaultProjectId,
    title: 'Riemannian Geometry',
    description: 'do Carmo atom review queue for natural-language mathematical review.',
    taskPath: 'projects/riemannian-geometry/tasks/pilot.tasks.yaml',
    reviewKind: 'atom_math',
    yamlPath: path.join(projectRoot, 'projects/riemannian-geometry/tasks/pilot.tasks.yaml'),
    jsonPath: path.join(projectRoot, 'apps/review/src/data/pilot.tasks.json')
  },
  {
    id: 'smooth-manifolds-lee',
    title: 'Smooth Manifolds Lee',
    description: 'Semantic review queue for textbook-aligned Lean formalization tasks.',
    taskPath: 'projects/smooth-manifolds-lee/tasks/all.tasks.yaml',
    reviewKind: 'lean_textbook',
    yamlPath: path.join(projectRoot, 'projects/smooth-manifolds-lee/tasks/all.tasks.yaml'),
    textbookZipPath: process.env.SMOOTH_MANIFOLDS_LEE_ZIP ?? smoothManifoldsLeeZipPath,
    textbookOverlayPaths: [
      smoothManifoldsLeeOverlayPath,
      smoothManifoldsLeeClarificationPath
    ]
  }
];

export function listProjects(): ReviewProject[] {
  return projectConfigs.map(({ id, title, description, taskPath, reviewKind }) => ({
    id,
    title,
    description,
    taskPath,
    reviewKind
  }));
}

export function getProjectConfig(projectId = defaultProjectId): ProjectConfig {
  const config = projectConfigs.find((item) => item.id === projectId);
  if (!config) {
    throw new Error(`Unknown review project: ${projectId}`);
  }
  return config;
}
