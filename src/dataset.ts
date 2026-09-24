/**
 * Dataset handling: format detection, file-list extraction, tabular scanning,
 * and chunk planning. Chunks are planned on the server; contributors download
 * only their slice (signed URL) and upload one output each.
 */
import AdmZip from "adm-zip";
import { getOperation, type Operation } from "./operations";
import {
  objectExists,
  objectFile,
  readObject,
  sanitizeKey,
  writeObject,
} from "./storage";

export type DatasetFormat = "file-list" | "tabular";

export interface FileListItem {
  path: string;
  size: number;
  key: string;
}

export interface FileListManifest {
  kind: "file-list";
  items: FileListItem[];
}

export interface TabularManifest {
  kind: "tabular";
  key: string;
  byteStart: number;
  byteEnd: number;
  rowStart: number;
  rowEnd: number;
  header: string;
}

export type ChunkManifest = FileListManifest | TabularManifest;

export interface ChunkPlan {
  inputStart: number;
  inputEnd: number;
  inputKey: string | null;
  manifest: ChunkManifest;
}

export function detectFormat(filename: string): DatasetFormat {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".zip")) return "file-list";
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) return "tabular";
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "tabular";
  if (lower.endsWith(".txt")) return "tabular";
  throw new Error(
    "Unsupported file type. Upload a .zip of files (file-list) or a .csv/.tsv/.jsonl (tabular).",
  );
}

function sanitizeEntryName(name: string): string {
  const cleaned = name.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("..") || cleaned.endsWith("/")) {
    return "";
  }
  return sanitizeKey(cleaned);
}

/**
 * Extract a .zip dataset into individual objects under
 * `datasets/{id}/files/{relative path}`. Returns the list of files sorted by
 * name, so chunk boundaries are deterministic.
 */
export async function extractFileList(
  datasetId: string,
  rawKey: string,
): Promise<{ files: FileListItem[]; sizeBytes: number }> {
  const buf = await readObject(rawKey);
  if (!buf) throw new Error("Dataset file missing from storage");
  const zip = new AdmZip(Buffer.from(buf));

  const files: FileListItem[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const path = sanitizeEntryName(entry.entryName);
    if (!path) continue;
    const key = `datasets/${datasetId}/files/${path}`;
    await writeObject(key, entry.getData());
    files.push({ path, size: entry.header.size, key });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, sizeBytes: buf.byteLength };
}

export interface TabularScan {
  header: string;
  /** byte offset where each line starts; line 0 is the header. */
  lineStarts: number[];
  sizeBytes: number;
  lineCount: number;
}

/**
 * Scan a line-based tabular file once, recording the byte offset of every
 * line start so chunks can be disjoint byte ranges with no rescanning.
 * (Line-based: assumes no embedded newlines inside quoted CSV fields.)
 */
export async function scanTabular(key: string): Promise<TabularScan> {
  const physical = await objectExists(key);
  if (!physical) throw new Error("Dataset file missing from storage");
  const file = objectFile(key);
  const sizeBytes = file.size;

  const lineStarts: number[] = [0];
  const reader = (await file.stream()).getReader();
  let absolute = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    for (let i = 0; i < chunk.byteLength; i++) {
      if (chunk[i] === 0x0a) lineStarts.push(absolute + i + 1);
    }
    absolute += chunk.byteLength;
  }

  // Drop the marker created past the end of the last line's newline.
  const last = lineStarts[lineStarts.length - 1];
  if (last >= sizeBytes && last > 0) lineStarts.pop();
  lineStarts.push(sizeBytes);

  const lineCount = lineStarts.length - 1;
  const header =
    lineCount > 0
      ? (await file.slice(0, Math.min(lineStarts[1], sizeBytes)).text()).trimEnd()
      : "";

  return { header, lineStarts, sizeBytes, lineCount };
}

export function planChunks(
  dataset: {
    id: string;
    format: DatasetFormat;
    storageKey: string;
  },
  op: Operation,
  requestedChunkSize?: number,
  extra?: { files?: FileListItem[]; scan?: TabularScan },
): ChunkPlan[] {
  if (op.splitKind === "file-list") {
    if (dataset.format !== "file-list") {
      throw new Error(`Operation "${op.type}" needs a zipped file-list dataset`);
    }
    const files = extra?.files;
    if (!files || files.length === 0) {
      throw new Error("Dataset contains no files");
    }
    const perChunk = Math.max(1, requestedChunkSize ?? op.defaultChunkSize);
    const plans: ChunkPlan[] = [];
    for (let i = 0; i < files.length; i += perChunk) {
      const slice = files.slice(i, i + perChunk);
      plans.push({
        inputStart: i + 1,
        inputEnd: i + slice.length,
        inputKey: null,
        manifest: {
          kind: "file-list",
          items: slice.map((f) => ({ path: f.path, size: f.size, key: f.key })),
        },
      });
    }
    return plans;
  }

  // tabular
  if (dataset.format !== "tabular") {
    throw new Error(`Operation "${op.type}" needs a csv/tsv/jsonl dataset`);
  }
  const scan = extra?.scan;
  if (!scan || scan.lineCount <= 1) {
    throw new Error("Dataset has no data rows");
  }
  const dataRows = scan.lineCount - 1;
  const perChunk = Math.max(1, requestedChunkSize ?? op.defaultChunkSize);

  const plans: ChunkPlan[] = [];
  for (let row = 1; row <= dataRows; row += perChunk) {
    const rowEnd = Math.min(row + perChunk - 1, dataRows);
    const byteStart = scan.lineStarts[row];
    const byteEnd =
      rowEnd + 1 <= scan.lineCount ? scan.lineStarts[rowEnd + 1] : scan.sizeBytes;
    plans.push({
      inputStart: row,
      inputEnd: rowEnd,
      inputKey: dataset.storageKey,
      manifest: {
        kind: "tabular",
        key: dataset.storageKey,
        byteStart,
        byteEnd,
        rowStart: row,
        rowEnd,
        header: scan.header,
      },
    });
  }
  return plans;
}

export type { Operation };

// re-export used by routes
export { getOperation } from "./operations";