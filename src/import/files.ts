import { constants, mkdirSync, openSync, fstatSync, readSync, closeSync, lstatSync, realpathSync, writeFileSync, linkSync, unlinkSync, mkdtempSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ReplayError } from "../replay/errors.ts";
import { MAX_CASE_BYTES, parsePrivateCase } from "./case.ts";
import type { PrivateCase } from "./case.ts";

export function readBoundedJsonWithSize(path: string, maxBytes = MAX_CASE_BYTES): { value: unknown; bytes: number } {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(/* turbopackIgnore: true */ path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new ReplayError("input", "Input must be a regular JSON file.");
    if (info.size > maxBytes) throw new ReplayError("input", "The JSON input exceeds the allowed file size.");

    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset <= maxBytes) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.byteLength, maxBytes + 1 - offset), null);
      if (!count) break;
      offset += count;
      if (offset > maxBytes) throw new ReplayError("input", "The JSON input exceeds the allowed file size.");
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, offset));
    return { value: JSON.parse(json), bytes: offset };
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    throw new ReplayError("input", "Could not read the JSON input. Check that it is a regular UTF-8 JSON file.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readBoundedJson(path: string, maxBytes = MAX_CASE_BYTES): unknown {
  return readBoundedJsonWithSize(path, maxBytes).value;
}

export function writePrivateCase(directory: string, input: PrivateCase): void {
  const incident = parsePrivateCase(input);
  const data = JSON.stringify(incident) + "\n";
  if (Buffer.byteLength(data) > MAX_CASE_BYTES) {
    throw new ReplayError("input", "The combined incident exceeds 8 MiB. Import a smaller time range.");
  }
  let tempDirectory: string | undefined;
  let tempFile: string | undefined;
  try {
    const target = resolve(directory);
    mkdirSync(target, { mode: 0o700, recursive: true });
    if (!lstatSync(target).isDirectory()) {
      throw new ReplayError("input", "The output directory must be a real directory.");
    }
    const output = realpathSync(target);
    tempDirectory = mkdtempSync(join(output, ".incident-"));
    tempFile = join(tempDirectory, "case.json");
    writeFileSync(tempFile, data, { flag: "wx", mode: 0o600, flush: true });
    // Publish the complete file without ever replacing or following an existing destination.
    linkSync(tempFile, join(output, incident.id + ".json"));
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    throw new ReplayError("input", "Could not save the private incident. Check output directory permissions and filename conflicts.");
  } finally {
    if (tempFile) {
      try { unlinkSync(tempFile); } catch {}
    }
    if (tempDirectory) {
      try { rmdirSync(tempDirectory); } catch {}
    }
  }
}
