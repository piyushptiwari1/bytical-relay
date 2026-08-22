import { v7 as uuidv7 } from "uuid";

/** Time-ordered UUIDv7 — index-friendly, sortable by creation time. */
export const newId = (): string => uuidv7();

export const newEventId = (): string => newId();
export const newCommandId = (): string => newId();

export const nowIso = (): string => new Date().toISOString();
