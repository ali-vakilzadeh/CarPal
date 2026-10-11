// Lite-mode message sinks: email, SMS and push are appended as JSON lines to
// backend/.data/outbox-{mail,sms,push}.jsonl and kept in memory, so developers
// and tests can read what would have been sent. The dead-letter store works
// the same way (backend/.data/dead-letter.jsonl).
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DeadLetter, DeadLetterStore, EmailMessage, Mailer, PushMessage, PushSender, SmsMessage, SmsSender } from '../ports.js';

class JsonlSink<T> {
  readonly sent: T[] = [];
  readonly #file: string | null;

  constructor(dir: string | null, name: string) {
    this.#file = dir ? join(dir, name) : null;
    if (dir) mkdirSync(dir, { recursive: true });
  }

  write(entry: T): void {
    this.sent.push(entry);
    if (this.sent.length > 1000) this.sent.shift();
    if (this.#file) appendFileSync(this.#file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  }
}

export class FileMailer extends JsonlSink<EmailMessage> implements Mailer {
  constructor(dir: string | null) {
    super(dir, 'outbox-mail.jsonl');
  }
  async send(message: EmailMessage): Promise<void> {
    this.write(message);
  }
}

export class FileSmsSender extends JsonlSink<SmsMessage> implements SmsSender {
  constructor(dir: string | null) {
    super(dir, 'outbox-sms.jsonl');
  }
  async send(message: SmsMessage): Promise<void> {
    this.write(message);
  }
}

export class FilePushSender extends JsonlSink<PushMessage> implements PushSender {
  constructor(dir: string | null) {
    super(dir, 'outbox-push.jsonl');
  }
  async send(message: PushMessage): Promise<void> {
    this.write(message);
  }
}

export class FileDeadLetterStore extends JsonlSink<DeadLetter> implements DeadLetterStore {
  constructor(dir: string | null) {
    super(dir, 'dead-letter.jsonl');
  }
  async add(entry: DeadLetter): Promise<void> {
    this.write(entry);
  }
  async list(consumer?: string): Promise<DeadLetter[]> {
    return consumer ? this.sent.filter((d) => d.consumer === consumer) : [...this.sent];
  }
}
