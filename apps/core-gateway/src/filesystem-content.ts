import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ApplyInvariantError,
  normalizeSha256Hex,
  verifyContentRefBytes,
  type ContentStorePort,
} from "@run402/runtime-kernel";
import type { ContentRefHex } from "@run402/release";

export class FilesystemContentStore implements ContentStorePort {
  readonly #rootDir: string;

  constructor(rootDir: string) {
    this.#rootDir = rootDir;
  }

  async putStatic(input: {
    projectId: string;
    sha256: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<void> {
    await this.putCas({
      sha256: input.sha256,
      bytes: input.bytes,
      contentType: input.contentType,
    });
    await this.#writeProjectRef(input.projectId, input.sha256);
  }

  async putVerified(projectId: string, ref: ContentRefHex, bytes: Uint8Array): Promise<void> {
    verifyContentRefBytes(ref, bytes);
    await this.putStatic({
      projectId,
      sha256: ref.sha256,
      bytes,
      contentType: ref.contentType ?? "application/octet-stream",
    });
  }

  async hasContent(projectId: string, sha256: string): Promise<boolean> {
    try {
      const [content, ref] = await Promise.all([
        stat(this.#casPath(sha256)),
        stat(this.#projectRefPath(projectId, sha256)),
      ]);
      return content.isFile() && ref.isFile();
    } catch {
      return false;
    }
  }

  async readStatic(projectId: string, sha256: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    if (!await this.hasContent(projectId, sha256)) return null;
    return await this.readCas(sha256);
  }

  async putCas(input: {
    sha256: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<void> {
    const sha256 = normalizeSha256Hex(input.sha256);
    if (sha256Hex(input.bytes) !== sha256) {
      throw new ApplyInvariantError("content_digest_mismatch", "Content bytes do not match the declared SHA-256 digest.");
    }
    const file = this.#casPath(sha256);
    await mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, input.bytes);
    await atomicWriteText(`${file}.json`, JSON.stringify({
      sha256,
      size_bytes: input.bytes.byteLength,
      content_type: input.contentType,
    }));
  }

  async readCas(sha256: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    try {
      const file = this.#casPath(sha256);
      const [bytes, contentType] = await Promise.all([
        readFile(file),
        readFile(`${file}.json`, "utf8")
          .then((raw) => {
            const parsed = JSON.parse(raw) as { content_type?: unknown };
            return typeof parsed.content_type === "string" ? parsed.content_type : "application/octet-stream";
          })
          .catch(() => "application/octet-stream"),
      ]);
      return { bytes, contentType };
    } catch {
      return null;
    }
  }

  async putUploadBytes(input: {
    projectId: string;
    uploadId: string;
    bytes: Uint8Array;
  }): Promise<{ size_bytes: number }> {
    const file = this.#uploadPath(input.projectId, input.uploadId);
    await mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, input.bytes);
    return { size_bytes: input.bytes.byteLength };
  }

  async promoteUpload(input: {
    projectId: string;
    uploadId: string;
    ref: ContentRefHex;
  }): Promise<{ sha256: string; size_bytes: number; content_type: string }> {
    const file = this.#uploadPath(input.projectId, input.uploadId);
    const bytes = await readFile(file).catch(() => null);
    if (!bytes) {
      throw new ApplyInvariantError("upload_bytes_missing", "Upload session has no staged bytes.");
    }
    verifyContentRefBytes(input.ref, bytes);
    const contentType = input.ref.contentType ?? "application/octet-stream";
    await this.putCas({
      sha256: input.ref.sha256,
      bytes,
      contentType,
    });
    await rm(file, { force: true });
    return {
      sha256: input.ref.sha256,
      size_bytes: input.ref.size,
      content_type: contentType,
    };
  }

  async deleteUploadBytes(input: {
    projectId: string;
    uploadId: string;
  }): Promise<void> {
    await rm(this.#uploadPath(input.projectId, input.uploadId), { force: true });
  }

  #writeProjectRef(projectId: string, sha256: string): Promise<void> {
    const ref = this.#projectRefPath(projectId, sha256);
    return mkdir(path.dirname(ref), { recursive: true }).then(() => atomicWriteText(ref, ""));
  }

  #projectRefPath(projectId: string, sha256: string): string {
    if (!/^prj_[a-z0-9]{16}$/.test(projectId)) {
      throw new Error(`Unsafe project id: ${projectId}`);
    }
    const normalizedSha = normalizeSha256Hex(sha256);
    return path.join(this.#rootDir, "refs", projectId, normalizedSha.slice(0, 2), normalizedSha);
  }

  #casPath(sha256: string): string {
    const normalizedSha = normalizeSha256Hex(sha256);
    return path.join(this.#rootDir, "cas", normalizedSha.slice(0, 2), normalizedSha);
  }

  #uploadPath(projectId: string, uploadId: string): string {
    if (!/^prj_[a-z0-9]{16}$/.test(projectId)) {
      throw new Error(`Unsafe project id: ${projectId}`);
    }
    if (!/^upl_[a-f0-9]{24}$/.test(uploadId)) {
      throw new Error(`Unsafe upload id: ${uploadId}`);
    }
    return path.join(this.#rootDir, "tmp", "uploads", projectId, `${uploadId}.part`);
  }
}

async function atomicWrite(file: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file);
}

async function atomicWriteText(file: string, text: string): Promise<void> {
  await atomicWrite(file, Buffer.from(text, "utf8"));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
