import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { operations } from "../db/schema";

export type SplitKind = "file-list" | "tabular";

export interface Operation {
  type: string;
  name: string;
  description: string;
  splitKind: SplitKind;
  defaultChunkSize: number;
  gpu: boolean;
  outputFormat: string;
  instructions?: string;
}

function normalizeOperation(
  operation:
    | {
        type: string;
        name: string;
        description: string;
        splitKind: SplitKind;
        defaultChunkSize: number;
        gpu: boolean;
        outputFormat: string;
        instructions: string | null;
      }
    | undefined,
): Operation | undefined {
  if (!operation) return undefined;
  const { instructions, ...fields } = operation;
  return instructions ? { ...fields, instructions } : fields;
}

export function listOperations(): Operation[] {
  return db
    .select({
      type: operations.type,
      name: operations.name,
      description: operations.description,
      splitKind: operations.splitKind,
      defaultChunkSize: operations.defaultChunkSize,
      gpu: operations.gpu,
      outputFormat: operations.outputFormat,
      instructions: operations.instructions,
    })
    .from(operations)
    .where(eq(operations.status, "BUILTIN"))
    .all()
    .map((operation) => normalizeOperation(operation)!);
}

export function getOperation(type: string): Operation | undefined {
  const operation = db
    .select({
      type: operations.type,
      name: operations.name,
      description: operations.description,
      splitKind: operations.splitKind,
      defaultChunkSize: operations.defaultChunkSize,
      gpu: operations.gpu,
      outputFormat: operations.outputFormat,
      instructions: operations.instructions,
    })
    .from(operations)
    .where(
      and(
        eq(operations.type, type),
        eq(operations.status, "BUILTIN"),
      ),
    )
    .get();
  return normalizeOperation(operation);
}

export function toPublicOperation(op: Operation) {
  return {
    type: op.type,
    name: op.name,
    description: op.description,
    splitKind: op.splitKind,
    defaultChunkSize: op.defaultChunkSize,
    gpu: op.gpu,
    outputFormat: op.outputFormat,
  };
}
