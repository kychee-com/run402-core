import { randomBytes } from "node:crypto";

const CRLF = "\r\n";

export interface MimeAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface BuildMixedMimeInput {
  fromAddress: string;
  fromName?: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: MimeAttachment[];
  date: Date;
}

export function buildMixedMime(input: BuildMixedMimeInput): Buffer {
  const outer = boundary();
  let inner = boundary();
  while (inner === outer) inner = boundary();

  const fromHeader = input.fromName
    ? `${fromDisplayName(input.fromName)} <${input.fromAddress}>`
    : input.fromAddress;

  const lines = [
    `From: ${fromHeader}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeaderWord(input.subject)}`,
    "MIME-Version: 1.0",
    `Date: ${formatDate(input.date)}`,
    `Content-Type: multipart/mixed; boundary="${outer}"`,
    "",
    `--${outer}`,
    `Content-Type: multipart/alternative; boundary="${inner}"`,
    "",
    `--${inner}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(input.text, "utf8")),
    `--${inner}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(input.html, "utf8")),
    `--${inner}--`,
  ];

  for (const attachment of input.attachments) {
    lines.push(
      `--${outer}`,
      `Content-Type: ${attachment.contentType}${contentTypeName(attachment.filename)}`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; ${dispositionFilename(attachment.filename)}`,
      "",
      wrapBase64(attachment.content),
    );
  }

  lines.push(`--${outer}--`, "");
  return Buffer.from(lines.join(CRLF), "utf8");
}

function needsHeaderEncoding(value: string): boolean {
  return /[^\x20-\x7E]/.test(value);
}

export function encodeHeaderWord(value: string): string {
  if (!needsHeaderEncoding(value)) return value;
  const maxChunkBytes = 45;
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of value) {
    const bytes = Buffer.byteLength(ch, "utf8");
    if (currentBytes + bytes > maxChunkBytes && current !== "") {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += bytes;
  }
  if (current !== "") chunks.push(current);
  return chunks
    .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`)
    .join(`${CRLF} `);
}

function fromDisplayName(name: string): string {
  if (!needsHeaderEncoding(name)) {
    return `"${name.replace(/([\\"])/g, "\\$1")}"`;
  }
  return encodeHeaderWord(name);
}

function dispositionFilename(filename: string): string {
  if (!needsHeaderEncoding(filename)) {
    return `filename="${filename.replace(/([\\"])/g, "\\$1")}"`;
  }
  return `filename*=UTF-8''${encodeRfc2231(filename)}`;
}

function contentTypeName(filename: string): string {
  if (!needsHeaderEncoding(filename)) {
    return `; name="${filename.replace(/([\\"])/g, "\\$1")}"`;
  }
  return "";
}

function encodeRfc2231(value: string): string {
  return Array.from(Buffer.from(value, "utf8"))
    .map((byte) => {
      const char = String.fromCharCode(byte);
      if (/[A-Za-z0-9!#$&+\-.^_`|~]/.test(char)) return char;
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

function wrapBase64(buffer: Buffer): string {
  const encoded = buffer.toString("base64");
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return lines.join(CRLF);
}

function formatDate(date: Date): string {
  return date.toUTCString().replace(/GMT$/, "+0000");
}

function boundary(): string {
  return `----=_Run402_Core_${randomBytes(16).toString("hex")}`;
}
