import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { displayPath } from './build-preflight.ts';
import { log } from './logger.ts';
import { isPidAlive } from './process-liveness.ts';
import {
  getManagedTestProductsOwnerPid,
  getTestProductsCompletionMarkerPath,
  isXcodeBuildMCPManagedTestProductsName,
  resolveManagedTestProductsOwnership,
} from './test-products-path.ts';
import {
  hasActiveTestProductsReaderLease,
  removeTestProductsReaderLeaseDirectory,
} from './test-products-reader-lease.ts';
import { removeTestProductsProducerReservation } from './test-products-producer-reservation.ts';
import {
  TEST_PRODUCTS_MAX_AGE_MS,
  TEST_PRODUCTS_MAX_COUNT,
} from './test-products-retention-policy.ts';

type CompletionMarkerInspection =
  | { status: 'missing' }
  | { status: 'file'; mtimeMs: number }
  | { status: 'unreadable'; error: unknown };

export {
  TEST_PRODUCTS_DAY_MS,
  TEST_PRODUCTS_MAX_AGE_DAYS,
  TEST_PRODUCTS_MAX_AGE_MS,
  TEST_PRODUCTS_MAX_COUNT,
} from './test-products-retention-policy.ts';

export interface ManagedTestProductsArtifact {
  path: string;
  name: string;
  mtimeMs: number;
  completionMarkerMtimeMs?: number | null;
}

interface RetainedTestProducts extends ManagedTestProductsArtifact {
  retentionMtimeMs: number;
}

export interface TestProductsProtectionOptions {
  now: number;
  minVisibleMs: number;
  activeProducerReservationNames?: ReadonlySet<string>;
  cleanupStaleReaderLeases?: boolean;
}

export interface PruneManagedTestProductsOptions extends TestProductsProtectionOptions {
  testProductsDir: string;
  maxAgeMs?: number;
  maxCount?: number;
  preferredRetainedArtifactName?: string;
}

async function inspectCompletionMarker(
  testProductsPath: string,
): Promise<CompletionMarkerInspection> {
  const markerPath = getTestProductsCompletionMarkerPath(testProductsPath);
  try {
    const stat = await fs.lstat(markerPath);
    if (!stat.isFile()) {
      return {
        status: 'unreadable',
        error: new Error(`Invalid test products completion marker: ${displayPath(markerPath)}`),
      };
    }
    return { status: 'file', mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing' };
    }
    return { status: 'unreadable', error };
  }
}

function logCompletionMarkerInspectionFailure(
  testProductsPath: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  log(
    'warn',
    `Unable to inspect completion state for managed test products at ${displayPath(testProductsPath)}; preserving the artifact: ${message}`,
  );
}

export async function isProtectedManagedTestProducts(
  artifact: ManagedTestProductsArtifact,
  options: TestProductsProtectionOptions,
): Promise<boolean> {
  if (
    await hasActiveTestProductsReaderLease(artifact.path, options.now, {
      cleanupStale: options.cleanupStaleReaderLeases ?? false,
    })
  ) {
    return true;
  }
  if (options.activeProducerReservationNames?.has(artifact.name)) {
    return true;
  }

  let completionMarkerMtimeMs = artifact.completionMarkerMtimeMs;
  if (completionMarkerMtimeMs === undefined) {
    const marker = await inspectCompletionMarker(artifact.path);
    if (marker.status === 'unreadable') {
      logCompletionMarkerInspectionFailure(artifact.path, marker.error);
      return true;
    }
    completionMarkerMtimeMs = marker.status === 'file' ? marker.mtimeMs : null;
  }
  if (completionMarkerMtimeMs !== null) {
    return false;
  }
  if (options.activeProducerReservationNames === undefined) {
    const ownerPid = getManagedTestProductsOwnerPid(artifact.name);
    if (ownerPid && isPidAlive(ownerPid)) {
      return true;
    }
  }
  return options.now - artifact.mtimeMs < options.minVisibleMs;
}

export async function pruneManagedTestProductsDirectory(
  options: PruneManagedTestProductsOptions,
): Promise<{ scanned: number; deleted: number }> {
  await fs.mkdir(options.testProductsDir, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(options.testProductsDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && isXcodeBuildMCPManagedTestProductsName(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: path.join(options.testProductsDir, entry.name),
    }));
  const stats = await Promise.all(
    candidates.map(async (candidate) => {
      const ownership = await resolveManagedTestProductsOwnership(candidate.path);
      if (!ownership) {
        return null;
      }
      const mtimeMs = (await fs.stat(ownership.path)).mtimeMs;
      const marker = await inspectCompletionMarker(ownership.path);
      if (marker.status === 'unreadable') {
        logCompletionMarkerInspectionFailure(ownership.path, marker.error);
        return null;
      }
      const completionMarkerMtimeMs = marker.status === 'file' ? marker.mtimeMs : null;
      return {
        name: ownership.name,
        path: ownership.path,
        mtimeMs,
        retentionMtimeMs: completionMarkerMtimeMs ?? mtimeMs,
        completionMarkerMtimeMs,
      } satisfies RetainedTestProducts;
    }),
  );

  const retained: RetainedTestProducts[] = [];
  const expired: RetainedTestProducts[] = [];
  for (const artifact of stats) {
    if (!artifact) {
      continue;
    }
    if (await isProtectedManagedTestProducts(artifact, options)) {
      continue;
    }
    const isPreferredRetainedArtifact =
      artifact.name === options.preferredRetainedArtifactName;
    if (
      !isPreferredRetainedArtifact &&
      options.now - artifact.retentionMtimeMs >
      (options.maxAgeMs ?? TEST_PRODUCTS_MAX_AGE_MS)
    ) {
      expired.push(artifact);
    } else {
      retained.push(artifact);
    }
  }

  const idleBudget = Math.max(0, options.maxCount ?? TEST_PRODUCTS_MAX_COUNT);
  const excessCount = retained.length - idleBudget;
  const overflow =
    excessCount > 0
      ? retained
          .filter(
            (artifact) =>
              artifact.name !== options.preferredRetainedArtifactName,
          )
          .slice()
          .sort((left, right) => {
            const ageOrder = left.retentionMtimeMs - right.retentionMtimeMs;
            if (ageOrder !== 0) {
              return ageOrder;
            }
            return left.name.localeCompare(right.name);
          })
          .slice(0, excessCount)
      : [];
  const deletionResults = await Promise.all(
    [...expired, ...overflow].map(async (artifact) => {
      try {
        const ownership = await resolveManagedTestProductsOwnership(artifact.path);
        if (!ownership) {
          return { deleted: false, error: undefined };
        }
        await fs.rm(ownership.path, { recursive: true, force: true });
        await fs.rm(getTestProductsCompletionMarkerPath(ownership.path), { force: true });
        await removeTestProductsReaderLeaseDirectory(
          ownership.layout.workspaceKey,
          ownership.name,
        ).catch(() => undefined);
        await removeTestProductsProducerReservation(
          ownership.layout.workspaceKey,
          ownership.name,
        ).catch(() => undefined);
        return { deleted: true, error: undefined };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(
          'warn',
          `Unable to delete managed test products at ${displayPath(artifact.path)}: ${message}`,
        );
        return { deleted: false, error };
      }
    }),
  );
  const deletionFailures = deletionResults.flatMap((result) =>
    result.error === undefined ? [] : [result.error],
  );
  if (deletionFailures.length > 0) {
    throw new AggregateError(
      deletionFailures,
      `Unable to delete ${deletionFailures.length} managed test products artifact${
        deletionFailures.length === 1 ? '' : 's'
      }`,
    );
  }

  return {
    scanned: stats.filter((artifact) => artifact !== null).length,
    deleted: deletionResults.filter((result) => result.deleted).length,
  };
}
