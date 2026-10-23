import type { Operation } from "./operations";


export const BUILTIN_OPERATIONS: Operation[] = [
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
      "The contributor launcher automatically prepares the supported NVIDIA CUDA runtime and MobileNet-v2 model. Currently supported on Linux x64.",
  },
];
