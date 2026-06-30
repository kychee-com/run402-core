export interface NormalizedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  contentBase64: string;
}

export interface NormalizedRawEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  fromName?: string;
  attachments: NormalizedAttachment[];
}

export class EmailValidationError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "EmailValidationError";
  }
}

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const RESERVED_SLUGS = new Set([
  "abuse", "postmaster", "hostmaster", "webmaster", "mailer-daemon",
  "bounce", "bounces", "smtp", "imap", "pop", "mx", "dkim", "dmarc",
  "noreply", "no-reply", "admin", "info", "support", "help", "hello",
  "contact", "sales", "billing", "accounts", "legal", "privacy", "security",
  "press", "media", "jobs", "careers", "team", "ops", "status", "api",
  "docs", "dashboard", "run402", "agentdb", "ceo", "founder", "owner",
  "finance", "payroll", "hr",
]);

const MAX_SUBJECT_CHARS = 998;
const MAX_HTML_BYTES = 1_048_576;
const MAX_TEXT_BYTES = 1_048_576;
const MAX_FROM_NAME_CHARS = 78;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENTS_TOTAL_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENT_FILENAME_CHARS = 255;
const MIME_TYPE_TOKEN_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const BLOCKED_ATTACHMENT_CONTENT_TYPES = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-dosexec",
  "application/x-executable",
  "application/x-elf",
  "application/x-mach-binary",
  "application/x-sh",
  "application/x-shellscript",
  "application/vnd.microsoft.portable-executable",
]);

export function validateMailboxSlug(slug: unknown): string {
  if (typeof slug !== "string") throw new EmailValidationError("slug must be a string", "slug");
  if (slug !== slug.toLowerCase()) throw new EmailValidationError("slug must be lowercase", "slug");
  if (slug.length < 3 || slug.length > 63) throw new EmailValidationError("slug must be 3-63 characters", "slug");
  if (!SLUG_RE.test(slug)) {
    throw new EmailValidationError("slug must contain only lowercase letters, numbers, and hyphens, and must start and end with a letter or number", "slug");
  }
  if (slug.includes("--")) throw new EmailValidationError("slug must not contain consecutive hyphens", "slug");
  if (RESERVED_SLUGS.has(slug)) throw new EmailValidationError(`slug "${slug}" is reserved`, "slug");
  return slug;
}

export function mailboxAddress(slug: string, fromDomain?: string): string {
  return `${slug}@${fromDomain ?? "run402-core.local"}`;
}

export function validateRawEmail(body: unknown): NormalizedRawEmail {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new EmailValidationError("request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  if (record.template !== undefined) {
    throw new EmailValidationError("template email is not supported by Run402 Core outbound email yet", "template");
  }
  const to = expectString(record.to, "to");
  validateEmailAddress(to, "to");
  const subject = expectString(record.subject, "subject");
  if (subject.length === 0) throw new EmailValidationError("subject is required", "subject");
  if (subject.length > MAX_SUBJECT_CHARS) {
    throw new EmailValidationError(`subject exceeds ${MAX_SUBJECT_CHARS} characters`, "subject");
  }
  const html = expectString(record.html, "html");
  if (html.length === 0) throw new EmailValidationError("html is required", "html");
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
    throw new EmailValidationError("html body exceeds 1MB", "html");
  }
  const text = record.text === undefined || record.text === null
    ? stripHtml(html)
    : expectString(record.text, "text");
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new EmailValidationError("text body exceeds 1MB", "text");
  }
  const fromName = record.from_name === undefined || record.from_name === null
    ? undefined
    : expectString(record.from_name, "from_name");
  if (fromName !== undefined) validateFromName(fromName);
  return {
    to,
    subject,
    html,
    text,
    ...(fromName !== undefined ? { fromName } : {}),
    attachments: validateAttachments(record.attachments),
  };
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new EmailValidationError(`${field} must be a string`, field);
  return value;
}

function validateEmailAddress(value: string, field: string): void {
  if (value.length > 320 || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value)) {
    throw new EmailValidationError(`${field} must be a valid email address`, field);
  }
}

function validateFromName(value: string): void {
  if (value.length > MAX_FROM_NAME_CHARS) {
    throw new EmailValidationError(`from_name exceeds ${MAX_FROM_NAME_CHARS} characters`, "from_name");
  }
  if (/[<>"\n\r]/.test(value)) {
    throw new EmailValidationError("from_name contains invalid characters", "from_name");
  }
}

function validateAttachments(value: unknown): NormalizedAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new EmailValidationError("attachments must be an array", "attachments");
  if (value.length > MAX_ATTACHMENTS) {
    throw new EmailValidationError(`too many attachments (max ${MAX_ATTACHMENTS})`, "attachments");
  }
  let total = 0;
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new EmailValidationError(`attachments[${index}] must be an object`, `attachments[${index}]`);
    }
    const record = entry as Record<string, unknown>;
    const filename = sanitizeAttachmentFilename(record.filename, index);
    const contentType = validateAttachmentContentType(record.content_type, index);
    const contentBase64 = expectString(record.content_base64, `attachments[${index}].content_base64`);
    const content = decodeStrictBase64(contentBase64);
    if (!content) {
      throw new EmailValidationError(`attachments[${index}].content_base64 is not valid base64`, `attachments[${index}].content_base64`);
    }
    if (content.length > MAX_ATTACHMENT_BYTES) {
      throw new EmailValidationError(`attachments[${index}] exceeds the ${MAX_ATTACHMENT_BYTES}-byte per-file limit`, `attachments[${index}]`);
    }
    total += content.length;
    if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
      throw new EmailValidationError(`total attachment size exceeds the ${MAX_ATTACHMENTS_TOTAL_BYTES}-byte limit`, "attachments");
    }
    return {
      filename,
      contentType,
      content,
      contentBase64: content.toString("base64"),
    };
  });
}

function sanitizeAttachmentFilename(value: unknown, index: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EmailValidationError(`attachments[${index}].filename is required`, `attachments[${index}].filename`);
  }
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw new EmailValidationError(`attachments[${index}].filename contains control characters`, `attachments[${index}].filename`);
  }
  const base = (value.split(/[\\/]/).pop() ?? "").trim();
  if (base === "" || base === "." || base === "..") {
    throw new EmailValidationError(`attachments[${index}].filename is invalid`, `attachments[${index}].filename`);
  }
  if (base.length > MAX_ATTACHMENT_FILENAME_CHARS) {
    throw new EmailValidationError(`attachments[${index}].filename exceeds ${MAX_ATTACHMENT_FILENAME_CHARS} characters`, `attachments[${index}].filename`);
  }
  return base;
}

function validateAttachmentContentType(value: unknown, index: number): string {
  if (value === undefined || value === null || value === "") return "application/octet-stream";
  if (typeof value !== "string") {
    throw new EmailValidationError(`attachments[${index}].content_type must be a string`, `attachments[${index}].content_type`);
  }
  const normalized = value.trim().toLowerCase();
  if (!MIME_TYPE_TOKEN_RE.test(normalized)) {
    throw new EmailValidationError(`attachments[${index}].content_type is not a valid MIME type`, `attachments[${index}].content_type`);
  }
  if (BLOCKED_ATTACHMENT_CONTENT_TYPES.has(normalized)) {
    throw new EmailValidationError(`attachments[${index}].content_type is not allowed`, `attachments[${index}].content_type`);
  }
  return normalized;
}

function decodeStrictBase64(value: string): Buffer | null {
  const stripped = value.replace(/\s+/g, "");
  if (stripped.length === 0 || stripped.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped)) return null;
  const decoded = Buffer.from(stripped, "base64");
  return decoded.toString("base64") === stripped ? decoded : null;
}
