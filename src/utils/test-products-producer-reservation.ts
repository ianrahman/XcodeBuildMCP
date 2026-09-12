import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { displayPath } from './build-preflight.ts';
import { isPidAlive } from './process-liveness.ts';
import {
  getManagedTestProductsOwnerPid,
  getTestProductsCompletionMarkerPath,
  isXcodeBuildMCPManagedTestProductsName,
  resolveManagedTestProductsLocation,
} from './test-products-path.ts';
import {
  captureTestProductsStateRootIdentity,
  resolveTestProductsStateDirectory,
  validateTestProductsStateRootIdentity,
  type TestProductsStateRootIdentity,
} from './test-products-state-path.ts';

const PRODUCER_RESERVATION_VERSION = 3;
export const TEST_PRODUCTS_HANDOFF_LEASE_MS = 5 * 1000;

export class TestProductsProducerReservationValidationError extends Error {
  override name = 'TestProductsProducerReservationValidationError';
}

export class TestProductsProducerReservationPublicationError extends Error {
  override name = 'TestProductsProducerReservationPublicationError';
}

export interface TestProductsProducerReservationRecord {
  version: typeof PRODUCER_RESERVATION_VERSION;
  phase: 'producer' | 'finalizing' | 'handoff';
  workspaceKey: string;
  artifactName: string;
  testProductsPath: string;
  pid: number;
  createdAtMs: number;
  expiresAtMs?: number;
}

export interface CreatedTestProductsProducerReservation {
  filePath: string;
  record: TestProductsProducerReservationRecord;
  stateRootIdentity: TestProductsStateRootIdentity;
}

function isProducerReservationRecord(
  value: unknown,
): value is TestProductsProducerReservationRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<TestProductsProducerReservationRecord>;
  return (
    record.version === PRODUCER_RESERVATION_VERSION &&
    (record.phase === 'producer' ||
      record.phase === 'finalizing' ||
      record.phase === 'handoff') &&
    typeof record.workspaceKey === 'string' &&
    typeof record.artifactName === 'string' &&
    typeof record.testProductsPath === 'string' &&
    Number.isInteger(record.pid) &&
    Number(record.pid) > 0 &&
    Number.isFinite(record.createdAtMs) &&
    (record.phase !== 'handoff' || Number.isFinite(record.expiresAtMs))
  );
}

async function readProducerReservation(
  filePath: string,
): Promise<TestProductsProducerReservationRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TestProductsProducerReservationValidationError(
      `Invalid producer reservation at ${displayPath(filePath)}`,
      { cause: error },
    );
  }
  if (!isProducerReservationRecord(parsed)) {
    throw new TestProductsProducerReservationValidationError(
      `Invalid producer reservation at ${displayPath(filePath)}`,
    );
  }
  return parsed;
}

async function producerReservationIsActive(
  record: TestProductsProducerReservationRecord,
  workspaceKey: string,
  evaluationTimeMs: number,
): Promise<boolean> {
  const location = resolveManagedTestProductsLocation(record.testProductsPath);
  if (!location) {
    return false;
  }
  if (
    !(
      location.layout.workspaceKey === workspaceKey &&
      location.name === record.artifactName &&
      record.workspaceKey === workspaceKey &&
      getManagedTestProductsOwnerPid(record.artifactName) === record.pid
    )
  ) {
    return false;
  }
  if (record.phase === 'producer') {
    try {
      const marker = await fs.lstat(getTestProductsCompletionMarkerPath(location.path));
      if (!marker.isFile()) {
        return true;
      }
      return marker.mtimeMs + TEST_PRODUCTS_HANDOFF_LEASE_MS > evaluationTimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return true;
      }
      return isPidAlive(record.pid);
    }
  }
  if (record.phase === 'finalizing') {
    return isPidAlive(record.pid);
  }
  if ((record.expiresAtMs ?? 0) <= evaluationTimeMs) {
    return false;
  }
  try {
    await fs.lstat(getTestProductsCompletionMarkerPath(location.path));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export async function getActiveTestProductsProducerReservationNames(
  workspaceKey: string,
  options: { cleanupStale: boolean; now?: number },
): Promise<Set<string>> {
  const directory = await resolveTestProductsStateDirectory(
    workspaceKey,
    'test-products-producers',
    { create: false },
  );
  if (!directory) {
    return new Set();
  }
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set();
    }
    throw error;
  }

  const activeNames = new Set<string>();
  const evaluationTimeMs = options.now ?? Date.now();
  for (const entry of entries) {
    const filePath = path.join(directory, entry);
    if (entry.endsWith('.tmp')) {
      if (options.cleanupStale) {
        await fs.rm(filePath, { recursive: true, force: true });
      }
      continue;
    }
    const record = await readProducerReservation(filePath);
    if (
      record &&
      (await producerReservationIsActive(record, workspaceKey, evaluationTimeMs))
    ) {
      activeNames.add(record.artifactName);
    } else if (options.cleanupStale) {
      await fs.rm(filePath, { recursive: true, force: true });
    }
  }

  if (options.cleanupStale && activeNames.size === 0) {
    await fs.rmdir(directory).catch(() => undefined);
  }
  return activeNames;
}

export async function createTestProductsProducerReservation(
  workspaceKey: string,
  testProductsPath: string,
  createdAtMs = Date.now(),
): Promise<CreatedTestProductsProducerReservation> {
  const location = resolveManagedTestProductsLocation(testProductsPath);
  if (location?.layout.workspaceKey !== workspaceKey) {
    throw new TestProductsProducerReservationValidationError(
      `Cannot reserve unmanaged test products path: ${displayPath(testProductsPath)}`,
    );
  }

  const directory = await resolveTestProductsStateDirectory(
    workspaceKey,
    'test-products-producers',
    { create: true },
  );
  const stateRootIdentity = await captureTestProductsStateRootIdentity(workspaceKey);
  const filePath = path.join(directory, `${location.name}.json`);
  const record: TestProductsProducerReservationRecord = {
    version: PRODUCER_RESERVATION_VERSION,
    phase: 'producer',
    workspaceKey,
    artifactName: location.name,
    testProductsPath: location.path,
    pid: process.pid,
    createdAtMs,
  };
  await writeProducerReservationAtomically(filePath, record);
  return { filePath, record, stateRootIdentity };
}

async function writeProducerReservationAtomically(
  filePath: string,
  record: TestProductsProducerReservationRecord,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    try {
      await fs.rm(tempPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Producer reservation write and temporary-file cleanup both failed: ${displayPath(filePath)}`,
      );
    }
    throw error;
  }
}

function producerReservationRecordsEqual(
  left: TestProductsProducerReservationRecord,
  right: TestProductsProducerReservationRecord,
): boolean {
  return (
    left.version === right.version &&
    left.phase === right.phase &&
    left.workspaceKey === right.workspaceKey &&
    left.artifactName === right.artifactName &&
    left.testProductsPath === right.testProductsPath &&
    left.pid === right.pid &&
    left.createdAtMs === right.createdAtMs &&
    left.expiresAtMs === right.expiresAtMs
  );
}

async function validatePublishedProducerReservation(
  filePath: string,
  record: TestProductsProducerReservationRecord,
  expectedStateRootIdentity?: TestProductsStateRootIdentity,
): Promise<void> {
  if (expectedStateRootIdentity) {
    await validateTestProductsStateRootIdentity(expectedStateRootIdentity);
  }
  let published: TestProductsProducerReservationRecord | null;
  try {
    published = await readProducerReservation(filePath);
  } catch (error) {
    if (error instanceof TestProductsProducerReservationValidationError) {
      throw new TestProductsProducerReservationPublicationError(
        `Producer reservation publication was unreadable in the validated state root: ${displayPath(filePath)}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (!published || !producerReservationRecordsEqual(published, record)) {
    throw new TestProductsProducerReservationPublicationError(
      `Producer reservation was not published in the validated state root: ${displayPath(filePath)}`,
    );
  }
  if (expectedStateRootIdentity) {
    await validateTestProductsStateRootIdentity(expectedStateRootIdentity);
  }
}

export async function validateCreatedTestProductsProducerReservation(
  reservation: CreatedTestProductsProducerReservation,
): Promise<void> {
  await validateTestProductsStateRootIdentity(reservation.stateRootIdentity);
  const directory = await resolveTestProductsStateDirectory(
    reservation.record.workspaceKey,
    'test-products-producers',
    { create: false },
  );
  if (!directory || directory !== path.dirname(reservation.filePath)) {
    throw new TestProductsProducerReservationPublicationError(
      `Producer reservation directory changed during acquisition: ${displayPath(reservation.filePath)}`,
    );
  }
  await validatePublishedProducerReservation(
    reservation.filePath,
    reservation.record,
    reservation.stateRootIdentity,
  );
}

function requireOwnedProducerLocation(
  workspaceKey: string,
  testProductsPath: string,
): NonNullable<ReturnType<typeof resolveManagedTestProductsLocation>> {
  const location = resolveManagedTestProductsLocation(testProductsPath);
  if (
    location?.layout.workspaceKey !== workspaceKey ||
    getManagedTestProductsOwnerPid(location.name) !== process.pid
  ) {
    throw new TestProductsProducerReservationValidationError(
      `Cannot transition unmanaged test products reservation: ${displayPath(testProductsPath)}`,
    );
  }
  return location;
}

function validateOwnedProducerReservation(
  current: TestProductsProducerReservationRecord | null,
  workspaceKey: string,
  artifactName: string,
  filePath: string,
): void {
  if (
    current &&
    (current.workspaceKey !== workspaceKey ||
      current.artifactName !== artifactName ||
      current.pid !== process.pid)
  ) {
    throw new TestProductsProducerReservationValidationError(
      `Cannot transition unowned producer reservation: ${displayPath(filePath)}`,
    );
  }
}

export async function transitionTestProductsProducerReservationToFinalizing(
  workspaceKey: string,
  testProductsPath: string,
  expectedStateRootIdentity?: TestProductsStateRootIdentity,
): Promise<void> {
  if (expectedStateRootIdentity) {
    await validateTestProductsStateRootIdentity(expectedStateRootIdentity);
  }
  const location = requireOwnedProducerLocation(workspaceKey, testProductsPath);
  const directory = await resolveTestProductsStateDirectory(
    workspaceKey,
    'test-products-producers',
    { create: true },
  );
  const filePath = path.join(directory, `${location.name}.json`);
  const current = await readProducerReservation(filePath);
  validateOwnedProducerReservation(current, workspaceKey, location.name, filePath);
  if (current?.phase === 'finalizing') {
    await validatePublishedProducerReservation(
      filePath,
      current,
      expectedStateRootIdentity,
    );
    return;
  }
  const record: TestProductsProducerReservationRecord = {
    version: PRODUCER_RESERVATION_VERSION,
    phase: 'finalizing',
    workspaceKey,
    artifactName: location.name,
    testProductsPath: location.path,
    pid: process.pid,
    createdAtMs: current?.createdAtMs ?? Date.now(),
  };
  await writeProducerReservationAtomically(filePath, record);
  await validatePublishedProducerReservation(
    filePath,
    record,
    expectedStateRootIdentity,
  );
}

export async function transitionTestProductsProducerReservationToHandoff(
  workspaceKey: string,
  testProductsPath: string,
  handoffAtMs?: number,
  expectedStateRootIdentity?: TestProductsStateRootIdentity,
): Promise<void> {
  if (expectedStateRootIdentity) {
    await validateTestProductsStateRootIdentity(expectedStateRootIdentity);
  }
  const location = requireOwnedProducerLocation(workspaceKey, testProductsPath);
  const artifactName = location.name;
  const directory = await resolveTestProductsStateDirectory(
    workspaceKey,
    'test-products-producers',
    { create: true },
  );
  const filePath = path.join(directory, `${artifactName}.json`);
  const current = await readProducerReservation(filePath);
  validateOwnedProducerReservation(current, workspaceKey, artifactName, filePath);
  const effectiveHandoffAtMs = handoffAtMs ?? Date.now();
  const record: TestProductsProducerReservationRecord = {
    version: PRODUCER_RESERVATION_VERSION,
    phase: 'handoff',
    workspaceKey,
    artifactName,
    testProductsPath: location.path,
    pid: process.pid,
    createdAtMs: current?.createdAtMs ?? effectiveHandoffAtMs,
    expiresAtMs: effectiveHandoffAtMs + TEST_PRODUCTS_HANDOFF_LEASE_MS,
  };
  await writeProducerReservationAtomically(filePath, record);
  await validatePublishedProducerReservation(
    filePath,
    record,
    expectedStateRootIdentity,
  );
}

export async function removeTestProductsProducerReservation(
  workspaceKey: string,
  artifactName: string,
  expectedStateRootIdentity?: TestProductsStateRootIdentity,
): Promise<void> {
  if (!isXcodeBuildMCPManagedTestProductsName(artifactName)) {
    return;
  }
  if (expectedStateRootIdentity) {
    await validateTestProductsStateRootIdentity(expectedStateRootIdentity);
  }
  const directory = await resolveTestProductsStateDirectory(
    workspaceKey,
    'test-products-producers',
    { create: false },
  );
  if (!directory) {
    return;
  }
  if (expectedStateRootIdentity) {
    await validateTestProductsStateRootIdentity(expectedStateRootIdentity);
  }
  await fs.rm(path.join(directory, `${artifactName}.json`), { force: true });
  await fs.rmdir(directory).catch(() => undefined);
}
