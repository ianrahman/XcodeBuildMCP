import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { displayPath } from './build-preflight.ts';
import {
  getXcodeBuildMCPAppDir,
  getWorkspaceFilesystemLayout,
  getWorkspacesDir,
} from './log-paths.ts';
import { isXcodeBuildMCPManagedTestProductsName } from './test-products-path.ts';

export type TestProductsStateKind =
  | 'test-products-producers'
  | 'test-products-readers'
  | 'test-products-retention';

export interface TestProductsStateRootIdentity {
  path: string;
  canonicalPath: string;
  dev: number;
  ino: number;
}

export class TestProductsStateRootIdentityMismatchError extends Error {
  override name = 'TestProductsStateRootIdentityMismatchError';
}

async function ensureRegularDirectory(
  directory: string,
  create: boolean,
): Promise<boolean> {
  let stat: Stats;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    if (!create) {
      return false;
    }
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw mkdirError;
      }
    }
    stat = await fs.lstat(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Managed coordination directory is not a regular directory: ${displayPath(directory)}`,
    );
  }
  return true;
}

export function resolveTestProductsStateDirectory(
  workspaceKey: string,
  kind: TestProductsStateKind,
  options: { create: true; artifactName?: string },
): Promise<string>;
export function resolveTestProductsStateDirectory(
  workspaceKey: string,
  kind: TestProductsStateKind,
  options: { create: false; artifactName?: string },
): Promise<string | null>;
export async function resolveTestProductsStateDirectory(
  workspaceKey: string,
  kind: TestProductsStateKind,
  options: { create: boolean; artifactName?: string },
): Promise<string | null> {
  if (
    options.artifactName !== undefined &&
    !isXcodeBuildMCPManagedTestProductsName(options.artifactName)
  ) {
    throw new Error(`Invalid managed test products name: ${options.artifactName}`);
  }

  const layout = getWorkspaceFilesystemLayout(workspaceKey);
  const directories = [
    getXcodeBuildMCPAppDir(),
    getWorkspacesDir(),
    layout.root,
    layout.state,
    path.join(layout.state, kind),
    ...(options.artifactName
      ? [path.join(layout.state, kind, options.artifactName)]
      : []),
  ];
  for (const directory of directories) {
    if (!(await ensureRegularDirectory(directory, options.create))) {
      return null;
    }
  }

  const canonicalDirectories = await Promise.all(
    directories.map((directory) => fs.realpath(directory)),
  );
  for (let index = 1; index < canonicalDirectories.length; index += 1) {
    if (
      canonicalDirectories[index] !==
      path.join(
        canonicalDirectories[index - 1]!,
        path.basename(directories[index]!),
      )
    ) {
      throw new Error(
        `Managed coordination directory escaped its parent: ${displayPath(directories[index]!)}`,
      );
    }
  }
  return canonicalDirectories.at(-1)!;
}

export async function captureTestProductsStateRootIdentity(
  workspaceKey: string,
): Promise<TestProductsStateRootIdentity> {
  const statePath = getWorkspaceFilesystemLayout(workspaceKey).state;
  const stat = await fs.lstat(statePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TestProductsStateRootIdentityMismatchError(
      `Managed coordination state root is not a regular directory: ${displayPath(statePath)}`,
    );
  }
  return {
    path: statePath,
    canonicalPath: await fs.realpath(statePath),
    dev: stat.dev,
    ino: stat.ino,
  };
}

export async function validateTestProductsStateRootIdentity(
  identity: TestProductsStateRootIdentity,
): Promise<void> {
  let current: TestProductsStateRootIdentity;
  try {
    const stat = await fs.lstat(identity.path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new TestProductsStateRootIdentityMismatchError(
        `Managed coordination state root was replaced: ${displayPath(identity.path)}`,
      );
    }
    current = {
      path: identity.path,
      canonicalPath: await fs.realpath(identity.path),
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch (error) {
    if (error instanceof TestProductsStateRootIdentityMismatchError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TestProductsStateRootIdentityMismatchError(
        `Managed coordination state root identity changed: ${displayPath(identity.path)}`,
        { cause: error },
      );
    }
    throw new TestProductsStateRootIdentityMismatchError(
      `Unable to validate managed coordination state root: ${displayPath(identity.path)}`,
      { cause: error },
    );
  }
  if (
    current.canonicalPath !== identity.canonicalPath ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  ) {
    throw new TestProductsStateRootIdentityMismatchError(
      `Managed coordination state root identity changed: ${displayPath(identity.path)}`,
    );
  }
}
