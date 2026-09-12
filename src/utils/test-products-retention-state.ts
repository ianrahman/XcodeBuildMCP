import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { displayPath } from './build-preflight.ts';
import {
  captureTestProductsStateRootIdentity,
  resolveTestProductsStateDirectory,
  validateTestProductsStateRootIdentity,
  type TestProductsStateRootIdentity,
} from './test-products-state-path.ts';

const RETENTION_POLICY_FILE = 'policy.json';
const RETENTION_POLICY_VERSION = 1;

export class WorkspaceTestProductsRetentionPolicyValidationError extends Error {
  override name = 'WorkspaceTestProductsRetentionPolicyValidationError';
}

export interface WorkspaceTestProductsRetentionPolicy {
  maxAgeDays: number;
  maxCount: number;
}

interface WorkspaceTestProductsRetentionPolicyRecord
  extends WorkspaceTestProductsRetentionPolicy {
  version: typeof RETENTION_POLICY_VERSION;
  workspaceKey: string;
  updatedAtMs: number;
}

function isRetentionPolicyRecord(
  value: unknown,
): value is WorkspaceTestProductsRetentionPolicyRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<WorkspaceTestProductsRetentionPolicyRecord>;
  return (
    record.version === RETENTION_POLICY_VERSION &&
    typeof record.workspaceKey === 'string' &&
    typeof record.maxCount === 'number' &&
    Number.isInteger(record.maxCount) &&
    record.maxCount > 0 &&
    typeof record.maxAgeDays === 'number' &&
    Number.isFinite(record.maxAgeDays) &&
    record.maxAgeDays > 0 &&
    typeof record.updatedAtMs === 'number' &&
    Number.isFinite(record.updatedAtMs)
  );
}

async function readRetentionPolicyRecord(
  filePath: string,
  workspaceKey: string,
): Promise<WorkspaceTestProductsRetentionPolicyRecord | null> {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WorkspaceTestProductsRetentionPolicyValidationError(
      `Managed test products retention policy is not a regular file: ${displayPath(filePath)}`,
    );
  }
  const contents = await fs.readFile(filePath, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new WorkspaceTestProductsRetentionPolicyValidationError(
      `Unable to parse managed test products retention policy: ${displayPath(filePath)}`,
      { cause: error },
    );
  }
  if (!isRetentionPolicyRecord(value) || value.workspaceKey !== workspaceKey) {
    throw new WorkspaceTestProductsRetentionPolicyValidationError(
      `Invalid managed test products retention policy: ${displayPath(filePath)}`,
    );
  }
  return value;
}

export async function writeWorkspaceTestProductsRetentionPolicy(
  workspaceKey: string,
  policy: WorkspaceTestProductsRetentionPolicy,
  expectedStateRootIdentity: TestProductsStateRootIdentity,
): Promise<void> {
  await validateTestProductsStateRootIdentity(expectedStateRootIdentity);
  const directory = await resolveTestProductsStateDirectory(
    workspaceKey,
    'test-products-retention',
    { create: true },
  );
  await validateTestProductsStateRootIdentity(expectedStateRootIdentity);
  const filePath = path.join(directory, RETENTION_POLICY_FILE);
  const tempPath = path.join(
    directory,
    `.${RETENTION_POLICY_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  const record: WorkspaceTestProductsRetentionPolicyRecord = {
    version: RETENTION_POLICY_VERSION,
    workspaceKey,
    maxCount: policy.maxCount,
    maxAgeDays: policy.maxAgeDays,
    updatedAtMs: Date.now(),
  };
  await fs.writeFile(tempPath, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  try {
    await fs.rename(tempPath, filePath);
  } catch (renameError) {
    try {
      await fs.rm(tempPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [renameError, cleanupError],
        `Managed test products retention policy publication and cleanup both failed: ${displayPath(filePath)}`,
      );
    }
    throw renameError;
  }
  await validateTestProductsStateRootIdentity(expectedStateRootIdentity);
  const published = await readRetentionPolicyRecord(filePath, workspaceKey);
  if (
    !published ||
    published.maxCount !== record.maxCount ||
    published.maxAgeDays !== record.maxAgeDays ||
    published.updatedAtMs !== record.updatedAtMs
  ) {
    throw new Error(
      `Managed test products retention policy was not published exactly: ${displayPath(filePath)}`,
    );
  }
  await validateTestProductsStateRootIdentity(expectedStateRootIdentity);
}

export async function readWorkspaceTestProductsRetentionPolicy(
  workspaceKey: string,
): Promise<WorkspaceTestProductsRetentionPolicy | null> {
  const directory = await resolveTestProductsStateDirectory(
    workspaceKey,
    'test-products-retention',
    { create: false },
  );
  if (!directory) {
    return null;
  }
  const stateRootIdentity = await captureTestProductsStateRootIdentity(workspaceKey);
  await validateTestProductsStateRootIdentity(stateRootIdentity);
  const record = await readRetentionPolicyRecord(
    path.join(directory, RETENTION_POLICY_FILE),
    workspaceKey,
  );
  await validateTestProductsStateRootIdentity(stateRootIdentity);
  if (!record) {
    return null;
  }
  return {
    maxCount: record.maxCount,
    maxAgeDays: record.maxAgeDays,
  };
}
