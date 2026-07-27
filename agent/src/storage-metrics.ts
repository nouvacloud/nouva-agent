import path from "node:path";

export const GIBIBYTE = 1024 * 1024 * 1024;
export const MIN_DISK_SAFETY_RESERVE_BYTES = 5 * GIBIBYTE;

export function calculateDiskSafetyReserveBytes(diskTotalBytes: number): number {
  return Math.max(MIN_DISK_SAFETY_RESERVE_BYTES, Math.ceil(diskTotalBytes * 0.05));
}

export function resolveDockerRootHostPath(
  dockerRootDir: string | null | undefined,
  hostRoot = "/hostfs"
): string {
  if (!dockerRootDir || !path.isAbsolute(dockerRootDir)) {
    throw new Error("Docker did not report an absolute root directory");
  }

  const resolvedHostRoot = path.resolve(hostRoot);
  const resolvedPath = path.resolve(resolvedHostRoot, `.${path.normalize(dockerRootDir)}`);
  if (
    resolvedPath !== resolvedHostRoot &&
    !resolvedPath.startsWith(`${resolvedHostRoot}${path.sep}`)
  ) {
    throw new Error("Docker root directory is outside the mounted host filesystem");
  }
  return resolvedPath;
}

export function formatStorageBytes(bytes: number): string {
  const value = bytes / GIBIBYTE;
  return `${value.toFixed(value >= 10 ? 1 : 2).replace(/\.0+$/, "")} GiB`;
}
