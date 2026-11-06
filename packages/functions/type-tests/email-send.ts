// Compile-only: `npm run lint:functions` type-checks this file, and an unused @ts-expect-error fails it.
import type { EmailSendOptions } from "../src/email.js";

const envelope = { to: "user@example.com", subject: "Hi" };

export const accepted: EmailSendOptions[] = [
  { ...envelope, text: "Hello" },
  { ...envelope, html: "<p>Hello</p>" },
  { ...envelope, html: "<p>Hello</p>", text: "Hello" },
  { to: "user@example.com", template: "welcome", variables: { name: "Ada" } },
];

// @ts-expect-error a raw message needs text or html
export const neither: EmailSendOptions = { ...envelope };

// @ts-expect-error a raw message needs a subject
export const noSubject: EmailSendOptions = { to: "user@example.com", text: "Hello" };

// @ts-expect-error a template message carries no raw body
export const templateAndBody: EmailSendOptions = { to: "user@example.com", template: "welcome", text: "Hello" };
