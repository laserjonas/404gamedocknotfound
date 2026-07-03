import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import * as tar from 'tar';
import { dirname, join, basename } from 'node:path';
import type { FileContentDto, FileEntryDto } from '@gamedock/shared';
import { badRequest, conflict, notFound, tooLarge } from '../errors.js';
import { resolveSafePath, toRelativePath } from '../utils/safePath.js';

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024; // editor limit
const BINARY_SNIFF_BYTES = 8192;

/**
 * File manager scoped strictly to a single instance directory.
 * Every path from the client goes through resolveSafePath.
 */
export class FileService {
  constructor(private maxUploadBytes: number) {}

  async list(instanceDir: string, relPath: string): Promise<FileEntryDto[]> {
    const dir = resolveSafePath(instanceDir, relPath || '.');
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw notFound(`Directory not found: ${relPath || '/'}`);
      }
      throw err;
    }

    const result: FileEntryDto[] = [];
    for (const entry of entries) {
      // Skip symlinks entirely: following them could escape the instance root.
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      let size = 0;
      let modified = new Date(0);
      try {
        const s = await stat(full);
        size = s.size;
        modified = s.mtime;
      } catch {
        continue;
      }
      result.push({
        name: entry.name,
        path: toRelativePath(instanceDir, full),
        type: entry.isDirectory() ? 'directory' : 'file',
        sizeBytes: size,
        modifiedAt: modified.toISOString(),
      });
    }
    result.sort((a, b) =>
      a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name),
    );
    return result;
  }

  private looksBinary(buffer: Buffer): boolean {
    const sniff = buffer.subarray(0, BINARY_SNIFF_BYTES);
    for (const byte of sniff) {
      if (byte === 0) return true;
    }
    return false;
  }

  async readText(instanceDir: string, relPath: string): Promise<FileContentDto> {
    const file = resolveSafePath(instanceDir, relPath);
    let s;
    try {
      s = await stat(file);
    } catch {
      throw notFound(`File not found: ${relPath}`);
    }
    if (s.isDirectory()) throw badRequest('Path is a directory');
    if (s.size > MAX_TEXT_FILE_BYTES) {
      throw tooLarge(
        `File is too large for the editor (${s.size} bytes, limit ${MAX_TEXT_FILE_BYTES})`,
      );
    }
    const buffer = await readFile(file);
    if (this.looksBinary(buffer)) {
      throw badRequest('File appears to be binary and cannot be edited as text');
    }
    return {
      path: relPath,
      content: buffer.toString('utf8'),
      sizeBytes: s.size,
    };
  }

  async writeText(instanceDir: string, relPath: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_BYTES) {
      throw tooLarge(`Content exceeds the ${MAX_TEXT_FILE_BYTES} byte editor limit`);
    }
    const file = resolveSafePath(instanceDir, relPath);
    // If the file exists and is binary or huge, refuse to clobber it via the editor.
    let existing;
    try {
      existing = await stat(file);
    } catch {
      existing = null;
    }
    if (existing) {
      if (existing.isDirectory()) throw badRequest('Path is a directory');
      if (existing.size > MAX_TEXT_FILE_BYTES) {
        throw badRequest('Refusing to overwrite a large file with the text editor');
      }
      const buffer = await readFile(file);
      if (this.looksBinary(buffer)) {
        throw badRequest('Refusing to overwrite a binary file with text');
      }
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }

  async createDirectory(instanceDir: string, relPath: string): Promise<void> {
    if (!relPath) throw badRequest('Directory path is required');
    const dir = resolveSafePath(instanceDir, relPath);
    await mkdir(dir, { recursive: true });
  }

  async upload(instanceDir: string, relPath: string, stream: Readable): Promise<number> {
    const file = resolveSafePath(instanceDir, relPath);
    if (!basename(file)) throw badRequest('Upload target must be a file path');
    await mkdir(dirname(file), { recursive: true });

    let written = 0;
    const limit = this.maxUploadBytes;
    stream.on('data', (chunk: Buffer) => {
      written += chunk.length;
      if (written > limit) {
        stream.destroy(new Error(`Upload exceeds the ${limit} byte limit`));
      }
    });
    await pipeline(stream, createWriteStream(file));
    return written;
  }

  /** Renames or moves a file/directory within the instance (a move is just a rename to a different parent). */
  async rename(instanceDir: string, fromRelPath: string, toRelPath: string): Promise<void> {
    if (!fromRelPath || fromRelPath === '.') {
      throw badRequest('Refusing to rename the instance root directory');
    }
    if (!toRelPath) throw badRequest('A destination path is required');
    const from = resolveSafePath(instanceDir, fromRelPath);
    const to = resolveSafePath(instanceDir, toRelPath);
    try {
      await stat(from);
    } catch {
      throw notFound(`Path not found: ${fromRelPath}`);
    }
    if (from === to) return;
    const destExists = await stat(to).then(
      () => true,
      () => false,
    );
    if (destExists) throw conflict(`Something already exists at "${toRelPath}"`);
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  }

  /** A file streams as itself; a directory streams as a .tar.gz of its contents. */
  async download(
    instanceDir: string,
    relPath: string,
  ): Promise<{ stream: Readable; fileName: string; contentType: string }> {
    if (!relPath) throw badRequest('A path is required');
    const target = resolveSafePath(instanceDir, relPath);
    let s;
    try {
      s = await stat(target);
    } catch {
      throw notFound(`Path not found: ${relPath}`);
    }
    const name = basename(target);
    if (s.isDirectory()) {
      const entries = await readdir(target);
      const stream = tar.create({ gzip: true, cwd: target }, entries) as unknown as Readable;
      return { stream, fileName: `${name}.tar.gz`, contentType: 'application/gzip' };
    }
    return {
      stream: createReadStream(target),
      fileName: name,
      contentType: 'application/octet-stream',
    };
  }

  async delete(instanceDir: string, relPath: string): Promise<void> {
    if (!relPath || relPath === '.' || relPath === '/') {
      throw badRequest('Refusing to delete the instance root directory');
    }
    const target = resolveSafePath(instanceDir, relPath);
    try {
      await stat(target);
    } catch {
      throw notFound(`Path not found: ${relPath}`);
    }
    await rm(target, { recursive: true, force: true });
  }
}
