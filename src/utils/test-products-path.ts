import * as fs from 'node:fs';
import * as path from 'node:path';
import { displayPath } from './build-preflight.ts';
import {
  getWorkspaceFilesystemLayout,
  getWorkspacesDir,
  type WorkspaceFilesystemLayout,
} from './log-paths.ts';
import { formatLogTimestamp, shortRandomSuffix } from './log-naming.ts';
import { log } from './logger.ts';
import { getRuntimeInstanceIfConfigured } from './runtime-instance.ts';
import { workspaceKeyForRoot } from './workspace-identity.ts';

export const TEST_PRODUCTS_COMPLETION_MARKER_SUFFIX = '.xcodebuildmcp-completed';
export type TestProductsCompletionResult = 'completed' | 'missing';

const ISO_TIMESTAMP_PATTERN = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z';
const SUFFIX_PATTERN = '[a-f0-9]{8}';
const TEST_PRODUCTS_NAME_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9_-]*_${ISO_TIMESTAMP_PATTERN}_pid\\d+_${SUFFIX_PATTERN}\\.xctestproducts$`,
);
const TEST_PRODUCTS_OWNER_PID_PATTERN = /_pid(\d+)_/u;

function resolveWorkspaceKey(): string {
  return getRuntimeInstanceIfConfigured()?.workspaceKey ?? workspaceKeyForRoot(process.cwd());
}

export function isXcodeBuildMCPManagedTestProductsName(fileName: string): boolean {
  return TEST_PRODUCTS_NAME_PATTERN.test(fileName);
}

export function getManagedTestProductsOwnerPid(fileName: string): number | null {
  const pid = Number(fileName.match(TEST_PRODUCTS_OWNER_PID_PATTERN)?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function getTestProductsCompletionMarkerPath(testProductsPath: string): string {
  return `${testProductsPath}${TEST_PRODUCTS_COMPLETION_MARKER_SUFFIX}`;
}

function isWithinManagedTestProductsNamespace(
  candidatePath: string,
  workspacesDir: string,
): boolean {
  const relativePath = path.relative(workspacesDir, candidatePath);
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return false;
  }
  const segments = relativePath.split(path.sep);
  return segments.length >= 2 && segments[0] !== '' && segments[1] === 'test-products';
}

async function resolvePathThroughExistingAncestor(candidatePath: string): Promise<string> {
  let existingAncestor = candidatePath;
  const unresolvedSegments: string[] = [];
  for (;;) {
    try {
      return path.join(
        await fs.promises.realpath(existingAncestor),
        ...unresolvedSegments,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      try {
        const unresolvedStat = await fs.promises.lstat(existingAncestor);
        if (unresolvedStat.isSymbolicLink()) {
          throw new Error(
            `Explicit testProductsPath contains an unresolved symbolic link: ${displayPath(existingAncestor)}`,
          );
        }
      } catch (lstatError) {
        if ((lstatError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw lstatError;
        }
      }
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw error;
      }
      unresolvedSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

export async function resolveCallerOwnedTestProductsOutputPath(
  candidatePath: string,
): Promise<string> {
  const absolutePath = path.resolve(candidatePath);
  const lexicalWorkspacesDir = path.resolve(getWorkspacesDir());
  if (isWithinManagedTestProductsNamespace(absolutePath, lexicalWorkspacesDir)) {
    throw new Error(
      `Explicit testProductsPath cannot use XcodeBuildMCP-managed storage: ${displayPath(absolutePath)}`,
    );
  }

  const canonicalCandidatePath = await resolvePathThroughExistingAncestor(absolutePath);
  const canonicalWorkspacesDir =
    await resolvePathThroughExistingAncestor(lexicalWorkspacesDir);
  if (
    isWithinManagedTestProductsNamespace(
      canonicalCandidatePath,
      canonicalWorkspacesDir,
    )
  ) {
    throw new Error(
      `Explicit testProductsPath cannot alias XcodeBuildMCP-managed storage: ${displayPath(absolutePath)}`,
    );
  }
  return canonicalCandidatePath;
}

export interface ManagedTestProductsOwnership {
  path: string;
  canonicalPath: string;
  name: string;
  layout: WorkspaceFilesystemLayout;
}

export interface ManagedTestProductsLocation {
  path: string;
  name: string;
  layout: WorkspaceFilesystemLayout;
}

export function resolveManagedTestProductsLocation(
  testProductsPath: string,
): ManagedTestProductsLocation | null {
  const absolutePath = path.resolve(testProductsPath);
  const name = path.basename(absolutePath);
  if (
    !isXcodeBuildMCPManagedTestProductsName(name) ||
    path.basename(path.dirname(absolutePath)) !== 'test-products'
  ) {
    return null;
  }

  const testProductsDir = path.dirname(absolutePath);
  const workspaceRoot = path.dirname(testProductsDir);
  if (path.dirname(workspaceRoot) !== path.resolve(getWorkspacesDir())) {
    return null;
  }

  const layout = getWorkspaceFilesystemLayout(path.basename(workspaceRoot));
  if (
    path.resolve(layout.root) !== workspaceRoot ||
    path.resolve(layout.testProducts) !== testProductsDir
  ) {
    return null;
  }
  return { path: absolutePath, name, layout };
}

export async function resolveManagedTestProductsOwnership(
  testProductsPath: string,
): Promise<ManagedTestProductsOwnership | null> {
  const absolutePath = path.resolve(testProductsPath);
  const name = path.basename(absolutePath);
  if (
    !isXcodeBuildMCPManagedTestProductsName(name) ||
    path.basename(path.dirname(absolutePath)) !== 'test-products'
  ) {
    return null;
  }

  const testProductsDir = path.dirname(absolutePath);
  const workspaceRoot = path.dirname(testProductsDir);
  const workspacesDir = path.dirname(workspaceRoot);

  try {
    const [artifactStat, testProductsStat, workspaceStat, workspacesStat] = await Promise.all([
      fs.promises.lstat(absolutePath),
      fs.promises.lstat(testProductsDir),
      fs.promises.lstat(workspaceRoot),
      fs.promises.lstat(workspacesDir),
    ]);
    if (
      !artifactStat.isDirectory() ||
      artifactStat.isSymbolicLink() ||
      !testProductsStat.isDirectory() ||
      testProductsStat.isSymbolicLink() ||
      !workspaceStat.isDirectory() ||
      workspaceStat.isSymbolicLink() ||
      !workspacesStat.isDirectory() ||
      workspacesStat.isSymbolicLink()
    ) {
      return null;
    }

    const [realArtifactPath, realTestProductsDir, realWorkspaceRoot, realWorkspacesDir] =
      await Promise.all([
        fs.promises.realpath(absolutePath),
        fs.promises.realpath(testProductsDir),
        fs.promises.realpath(workspaceRoot),
        fs.promises.realpath(workspacesDir),
      ]);
    if (
      path.dirname(realArtifactPath) !== realTestProductsDir ||
      path.dirname(realTestProductsDir) !== realWorkspaceRoot ||
      path.basename(realTestProductsDir) !== 'test-products' ||
      path.dirname(realWorkspaceRoot) !== realWorkspacesDir
    ) {
      return null;
    }

    const layout = getWorkspaceFilesystemLayout(path.basename(realWorkspaceRoot));
    const [realLayoutRoot, realLayoutTestProducts] = await Promise.all([
      fs.promises.realpath(layout.root),
      fs.promises.realpath(layout.testProducts),
    ]);
    if (realLayoutRoot !== realWorkspaceRoot || realLayoutTestProducts !== realTestProductsDir) {
      return null;
    }

    return {
      path: absolutePath,
      canonicalPath: realArtifactPath,
      name,
      layout,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export interface ResolvedPreparedTestSource {
  sourcePath: string;
  location: ManagedTestProductsLocation | null;
  ownership: ManagedTestProductsOwnership | null;
}

export class PreparedTestSourceUnavailableError extends Error {
  override name = 'PreparedTestSourceUnavailableError';
}

async function resolveCanonicalManagedTestProductsLocation(
  candidatePath: string,
): Promise<ManagedTestProductsLocation | null> {
  const name = path.basename(candidatePath);
  if (
    !isXcodeBuildMCPManagedTestProductsName(name) ||
    path.basename(path.dirname(candidatePath)) !== 'test-products'
  ) {
    return null;
  }

  const testProductsDir = path.dirname(candidatePath);
  const workspaceRoot = path.dirname(testProductsDir);
  const workspacesDir = path.dirname(workspaceRoot);
  const layout = getWorkspaceFilesystemLayout(path.basename(workspaceRoot));
  try {
    const [realWorkspacesDir, realLayoutRoot, realLayoutTestProducts] = await Promise.all([
      fs.promises.realpath(getWorkspacesDir()),
      fs.promises.realpath(layout.root),
      fs.promises.realpath(layout.testProducts),
    ]);
    if (
      workspacesDir !== realWorkspacesDir ||
      workspaceRoot !== realLayoutRoot ||
      testProductsDir !== realLayoutTestProducts
    ) {
      return null;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  return { path: candidatePath, name, layout };
}

export async function resolvePreparedTestSource(
  candidatePath: string,
): Promise<ResolvedPreparedTestSource> {
  let sourcePath: string;
  try {
    sourcePath = await fs.promises.realpath(candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PreparedTestSourceUnavailableError(
        `Prepared test artifact is unavailable: ${displayPath(path.resolve(candidatePath))}`,
        { cause: error },
      );
    }
    throw error;
  }
  let currentPath = sourcePath;
  for (;;) {
    const location = await resolveCanonicalManagedTestProductsLocation(currentPath);
    if (location) {
      const ownership = await resolveManagedTestProductsOwnership(currentPath);
      return { sourcePath, location, ownership };
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return { sourcePath, location: null, ownership: null };
    }
    currentPath = parentPath;
  }
}

export function isTestProductsCompletionMarkerTempName(name: string): boolean {
  return name.includes(`${TEST_PRODUCTS_COMPLETION_MARKER_SUFFIX}.`) && name.endsWith('.tmp');
}

export function createDefaultTestProductsPath(
  toolName: string,
  workspaceKey = resolveWorkspaceKey(),
): string {
  const layout = getWorkspaceFilesystemLayout(workspaceKey);
  const workspacesDir = getWorkspacesDir();

  try {
    fs.mkdirSync(path.dirname(workspacesDir), { recursive: true, mode: 0o700 });
    for (const directory of [workspacesDir, layout.root, layout.testProducts]) {
      try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`Managed directory is not a regular directory: ${displayPath(directory)}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        fs.mkdirSync(directory, { mode: 0o700 });
      }
    }
    fs.accessSync(layout.testProducts, fs.constants.W_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to create writable test products directory at ${displayPath(layout.testProducts)}: ${message}`,
      { cause: error },
    );
  }

  return path.join(
    layout.testProducts,
    `${toolName}_${formatLogTimestamp()}_pid${process.pid}_${shortRandomSuffix()}.xctestproducts`,
  );
}

async function collectXctestrunPaths(directory: string, paths: string[]): Promise<void> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectXctestrunPaths(entryPath, paths);
    } else if (entry.isFile() && entry.name.endsWith('.xctestrun')) {
      paths.push(entryPath);
    }
  }
}

export async function findXctestrunPaths(testProductsPath: string): Promise<string[]> {
  try {
    const stat = await fs.promises.lstat(testProductsPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return [];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const paths: string[] = [];
  await collectXctestrunPaths(testProductsPath, paths);
  return paths.sort((left, right) => left.localeCompare(right));
}

export function markTestProductsPathCompleted(
  testProductsPath: string | undefined,
): TestProductsCompletionResult {
  if (!testProductsPath) {
    return 'missing';
  }

  try {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(testProductsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'missing';
      }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return 'missing';
    }
    const markerPath = getTestProductsCompletionMarkerPath(testProductsPath);
    const tempPath = `${markerPath}.${process.pid}_${shortRandomSuffix()}.tmp`;
    fs.writeFileSync(tempPath, `${Date.now()}\n`);
    try {
      fs.renameSync(tempPath, markerPath);
    } catch (renameError) {
      fs.rmSync(tempPath, { force: true });
      throw renameError;
    }
    return 'completed';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      'warn',
      `Unable to mark test products completed at ${displayPath(testProductsPath)}: ${message}`,
    );
    throw error;
  }
}
