import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Durable record that a volume wipe already destroyed and replaced the Docker volume.
 *
 * A wipe is retried on the same work item, and a retry cannot tell from Docker alone whether the
 * volume it sees is the customer's pre-wipe data or the fresh cluster a previous attempt created and
 * whose completion report was lost. Re-running the destructive phase in the second case erases the
 * new cluster while the control plane has already rotated the repository, leaving a repository with
 * no cluster that matches it. This receipt is that missing knowledge, stored in the agent's data
 * volume so it survives agent restarts and container replacement.
 *
 * The receipt is keyed by volume and validated against `repositoryGeneration`, not the work item id.
 * Wipe work is deduplicated, so the same work item id is reused by a *later* wipe of the same
 * volume; only the generation advances per logical wipe. Matching on the generation means a stale
 * receipt can never make a new wipe skip its destructive phase, and one file per volume bounds what
 * is stored.
 */
export interface VolumeWipeReceipt {
  version: 1;
  volumeName: string;
  repositoryGeneration: number;
  phase: "volume-replaced";
  workItemId: string | null;
  recordedAt: string;
}

function getVolumeWipeReceiptPath(dataDir: string, volumeName: string): string {
  return path.join(dataDir, "volume-wipes", `${encodeURIComponent(volumeName)}.json`);
}

function isVolumeWipeReceipt(value: unknown): value is VolumeWipeReceipt {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.volumeName === "string" &&
    typeof candidate.repositoryGeneration === "number" &&
    Number.isInteger(candidate.repositoryGeneration) &&
    candidate.phase === "volume-replaced"
  );
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Read the receipt for a volume.
 *
 * Returns `null` only when the file genuinely does not exist, which is the one state that proves no
 * earlier attempt reached the replacement. Every other outcome -- truncated or unparseable JSON, a
 * shape this version does not recognise, a permission or I/O error -- means the agent cannot tell
 * whether the volume it is looking at is the customer's data or a replacement a previous attempt
 * created, so it throws. The work item then fails and is retried instead of destroying a volume
 * that may already hold the restored cluster.
 *
 * @throws when the receipt exists but cannot be read or validated.
 */
export async function readVolumeWipeReceipt(
  dataDir: string,
  volumeName: string
): Promise<VolumeWipeReceipt | null> {
  const receiptPath = getVolumeWipeReceiptPath(dataDir, volumeName);
  let contents: string;
  try {
    contents = await readFile(receiptPath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return null;
    }
    throw new Error(
      `Volume wipe receipt ${receiptPath} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Volume wipe receipt ${receiptPath} is not valid JSON`, { cause: error });
  }

  if (!isVolumeWipeReceipt(parsed)) {
    throw new Error(`Volume wipe receipt ${receiptPath} does not have a recognised shape`);
  }

  return parsed;
}

/** Record the replacement durably, via a temp file and rename so a crash cannot leave a partial. */
export async function writeVolumeWipeReceipt(
  dataDir: string,
  receipt: Omit<VolumeWipeReceipt, "version" | "phase" | "recordedAt">
): Promise<void> {
  const receiptPath = getVolumeWipeReceiptPath(dataDir, receipt.volumeName);
  await mkdir(path.dirname(receiptPath), { recursive: true });
  const temporaryPath = `${receiptPath}.tmp`;
  await writeFile(
    temporaryPath,
    JSON.stringify(
      {
        version: 1,
        volumeName: receipt.volumeName,
        repositoryGeneration: receipt.repositoryGeneration,
        phase: "volume-replaced",
        workItemId: receipt.workItemId,
        recordedAt: new Date().toISOString(),
      } satisfies VolumeWipeReceipt,
      null,
      2
    )
  );
  await rename(temporaryPath, receiptPath);
}

/**
 * Whether the destructive phase of *this* wipe generation already completed.
 *
 * Returns false for any other generation, so a receipt left by an earlier wipe of the same volume
 * never suppresses a later one.
 */
export function hasReplacedVolumeForGeneration(
  receipt: VolumeWipeReceipt | null,
  input: { volumeName: string; repositoryGeneration: number }
): boolean {
  return (
    receipt !== null &&
    receipt.volumeName === input.volumeName &&
    receipt.repositoryGeneration === input.repositoryGeneration
  );
}
