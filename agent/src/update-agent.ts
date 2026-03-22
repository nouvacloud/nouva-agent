import type { UpdateAgentPayload } from "./protocol.js";

function toObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function toUpdateAgentPayload(value: unknown): UpdateAgentPayload {
  const payload = toObject(value);
  const releaseId = typeof payload.releaseId === "string" ? payload.releaseId : undefined;
  const version = typeof payload.version === "string" ? payload.version : undefined;
  const imageRef = typeof payload.imageRef === "string" ? payload.imageRef : undefined;
  const imageTag = typeof payload.imageTag === "string" ? payload.imageTag : undefined;

  if ((!imageRef || imageRef.trim().length === 0) && (!imageTag || imageTag.trim().length === 0)) {
    throw new Error("Agent update payload is missing imageRef/imageTag");
  }

  return {
    ...(releaseId ? { releaseId } : {}),
    ...(version ? { version } : {}),
    ...(imageRef ? { imageRef } : {}),
    ...(imageTag ? { imageTag } : {}),
  };
}

export function resolveUpdateAgentImageRef(payload: UpdateAgentPayload): string {
  const imageRef = payload.imageRef?.trim();
  if (imageRef) {
    return imageRef;
  }

  const imageTag = payload.imageTag?.trim();
  if (imageTag) {
    return imageTag;
  }

  throw new Error("Agent update payload is missing imageRef/imageTag");
}
