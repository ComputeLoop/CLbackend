/**
 * Operation registry. Every project runs exactly one operation over the
 * chunks its dataset is split into.
 *
 * Ops are platform-defined on purpose: contributors run the platform's
 * standard worker image, never arbitrary renter code. Renter code that can't
 * fit an existing op is a follow-up (build into a platform-signed image).
 */

export type SplitKind = "file-list" | "tabular";

export interface Operation {
  type: string;
  name: string;
  description: string;
  /** How the dataset is sliced for this op. */
  splitKind: SplitKind;
  /** Items per chunk (file-list) or rows per chunk (tabular). */
  defaultChunkSize: number;
  gpu: boolean;
  outputFormat: string;
  instructions?: string;
}

export const OPERATIONS: Operation[] = [
  {
    type: "image-hash",
    name: "Image integrity & metadata",
    description:
      "Computes a SHA-256 hash plus the width and height of every image file in the dataset. Ideal for verifying large image archives that are too slow to re-download.",
    splitKind: "file-list",
    defaultChunkSize: 5,
    gpu: false,
    outputFormat: "JSONL (one record per image)",
  },
  {
    type: "tabular-stats",
    name: "Tabular dataset statistics",
    description:
      "Counts rows and computes min/mean/max/sum of every numeric column in a CSV/TSV/JSONL file. Each chunk scans a disjoint slice of rows, so huge tables finish in parallel.",
    splitKind: "tabular",
    defaultChunkSize: 100_000,
    gpu: false,
    outputFormat: "JSON (one stats object per chunk)",
  },
  {
    type: "image-classify",
    name: "Image classification (GPU)",
    description:
      "Runs a MobileNet-style ONNX classifier over every image and emits the top predicted label per image. This is the first GPU op.",
    splitKind: "file-list",
    defaultChunkSize: 50,
    gpu: true,
    outputFormat: "JSONL (one record per image)",
    instructions:
      "Contributors need `onnxruntime-node` installed plus a MobileNet-v2 .onnx model (see worker README).",
  },
];

export function getOperation(type: string): Operation | undefined {
  return OPERATIONS.find((op) => op.type === type);
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