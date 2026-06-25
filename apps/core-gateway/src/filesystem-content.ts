import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
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
    const file = this.#contentPath(input.projectId, input.sha256);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, input.bytes);
    await writeFile(`${file}.content-type`, input.contentType, "utf8");
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
      const info = await stat(this.#contentPath(projectId, sha256));
      return info.isFile();
    } catch {
      return false;
    }
  }

  async readStatic(projectId: string, sha256: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    try {
      const file = this.#contentPath(projectId, sha256);
      const [bytes, contentType] = await Promise.all([
        readFile(file),
        readFile(`${file}.content-type`, "utf8").catch(() => "application/octet-stream"),
      ]);
      return { bytes, contentType };
    } catch {
      return null;
    }
  }

  #contentPath(projectId: string, sha256: string): string {
    if (!/^prj_[a-z0-9]{16}$/.test(projectId)) {
      throw new Error(`Unsafe project id: ${projectId}`);
    }
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`Unsafe content digest: ${sha256}`);
    }
    return path.join(this.#rootDir, projectId, sha256.slice(0, 2), sha256);
  }
}
