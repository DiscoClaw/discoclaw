/**
 * OnboardingFlow — pure conversation state machine for interactive onboarding.
 *
 * No file I/O. Tracks current step, collected values, and returns reply text.
 * The caller (discord.ts) handles sending messages and invoking the writer.
 */

export interface OnboardingValues {
  userName: string;
  timezone: string;
  morningCheckin: boolean;
}

export type FlowResult = {
  done: boolean;
  reply: string;
  writeResult?: 'pending';
};

type Step =
  | 'NAME'
  | 'TIMEZONE'
  | 'CHECKIN'
  | 'CONFIRM'
  | 'WRITING'
  | 'WRITE_ERROR'
  | 'DONE';

const MAX_INPUT_LENGTH = 200;
const PLACEHOLDER_RE = /\{\{[^}]+\}\}/;

/** Common timezone abbreviations mapped to IANA names. */
const TIMEZONE_ABBR: Record<string, string> = {
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  MST: 'America/Denver',
  MDT: 'America/Denver',
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  EST: 'America/New_York',
  EDT: 'America/New_York',
  GMT: 'Etc/GMT',
  UTC: 'UTC',
  CET: 'Europe/Paris',
  CEST: 'Europe/Paris',
  BST: 'Europe/London',
  IST: 'Asia/Kolkata',
  JST: 'Asia/Tokyo',
  AEST: 'Australia/Sydney',
  AEDT: 'Australia/Sydney',
  NZST: 'Pacific/Auckland',
  NZDT: 'Pacific/Auckland',
};

function parseTimezone(input: string): string | null {
  const trimmed = input.trim();
  const abbr = TIMEZONE_ABBR[trimmed.toUpperCase()];
  if (abbr) return abbr;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return trimmed;
  } catch {
    return null;
  }
}

function parseCheckin(input: string): boolean | null {
  const t = input.trim().toLowerCase();
  if (['yes', 'y', 'yeah', 'yep', 'sure', 'ok', '1', 'true'].includes(t)) return true;
  if (['no', 'n', 'nope', 'nah', '0', 'false'].includes(t)) return false;
  return null;
}

type FieldDef = { label: string; key: keyof OnboardingValues };
const FIELD_DEFS: FieldDef[] = [
  { label: 'Your name', key: 'userName' },
  { label: 'Timezone', key: 'timezone' },
  { label: 'Morning check-in', key: 'morningCheckin' },
];

const CONFIRM_YES = new Set(['yes', 'y', 'ok', 'confirm', 'looks good']);

export class OnboardingFlow {
  private step: Step = 'NAME';
  private values: Partial<OnboardingValues> = {};
  private writeError = '';
  /** When true, completing any field returns to CONFIRM instead of advancing. */
  private editing = false;

  /** Updated on start() and handleInput(). Used for timeout checking. */
  lastActivityTimestamp = 0;

  /** Tracks whether the redirect notice has been sent this session. */
  hasRedirected = false;

  /** Where the conversation is happening. */
  channelMode: 'dm' | 'guild' = 'dm';

  /** Guild channel ID when channelMode is 'guild'. */
  channelId?: string;

  start(displayName: string): FlowResult {
    this.lastActivityTimestamp = Date.now();
    return {
      done: false,
      reply:
        `Hey ${displayName}! Quick setup — just 3 questions.\n\n` +
        `**What's your name?**`,
    };
  }

  handleInput(text: string): FlowResult {
    this.lastActivityTimestamp = Date.now();
    const input = text.trim();

    if (this.step === 'WRITING') {
      return { done: false, reply: 'Hang on, still writing your files...' };
    }

    if (this.step === 'DONE') {
      return { done: true, reply: '' };
    }

    if (this.step === 'WRITE_ERROR') {
      return this.handleWriteError(input);
    }

    if (this.step === 'CONFIRM') {
      return this.handleConfirm(input);
    }

    // All question steps require input
    if (!input) {
      return { done: false, reply: "I need something here — what would you like?" };
    }

    if (input.length > MAX_INPUT_LENGTH) {
      return { done: false, reply: `That's a bit long — can you keep it under ${MAX_INPUT_LENGTH} characters?` };
    }

    if (PLACEHOLDER_RE.test(input)) {
      return { done: false, reply: "That looks like a template placeholder — give me something real!" };
    }

    switch (this.step) {
      case 'NAME':
        this.values.userName = input;
        if (this.editing) return this.finishEdit();
        this.step = 'TIMEZONE';
        return {
          done: false,
          reply:
            `Nice to meet you, ${input}!\n\n` +
            `**What timezone are you in?**\n` +
            `Use an IANA name like \`America/New_York\`, or an abbreviation like \`EST\`, \`PST\`, \`CET\`.`,
        };

      case 'TIMEZONE': {
        const tz = parseTimezone(input);
        if (!tz) {
          return {
            done: false,
            reply:
              "I didn't recognize that timezone. Try an IANA name like `America/New_York`, " +
              "or an abbreviation like `EST`, `PST`, `CET`.",
          };
        }
        this.values.timezone = tz;
        if (this.editing) return this.finishEdit();
        this.step = 'CHECKIN';
        return {
          done: false,
          reply: `**Would you like a morning check-in message each day?** (yes / no)`,
        };
      }

      case 'CHECKIN': {
        const checkin = parseCheckin(input);
        if (checkin === null) {
          return {
            done: false,
            reply: "Just yes or no — would you like a morning check-in message?",
          };
        }
        this.values.morningCheckin = checkin;
        if (this.editing) return this.finishEdit();
        return this.showConfirmation();
      }

      default:
        return { done: false, reply: '' };
    }
  }

  markWriteComplete(): void {
    this.step = 'DONE';
  }

  markWriteFailed(error: string): void {
    this.step = 'WRITE_ERROR';
    this.writeError = error;
  }

  getValues(): OnboardingValues {
    return this.values as OnboardingValues;
  }

  getValuesWithDefaults(displayName: string, systemTimezone: string): OnboardingValues {
    return {
      userName: this.values.userName ?? displayName,
      timezone: this.values.timezone ?? systemTimezone,
      morningCheckin: this.values.morningCheckin ?? false,
    };
  }

  private showConfirmation(): FlowResult {
    this.step = 'CONFIRM';
    const lines = FIELD_DEFS.map((f, i) => {
      const val = this.values[f.key];
      let display: string;
      if (val === undefined || val === null) {
        display = '(unanswered)';
      } else if (typeof val === 'boolean') {
        display = val ? 'Yes' : 'No';
      } else {
        display = String(val);
      }
      return `${i + 1}. **${f.label}:** ${display}`;
    });

    return {
      done: false,
      reply:
        `Here's what I've got:\n\n` +
        lines.join('\n') +
        `\n\nType **yes** to confirm, or pick a number to edit a field.`,
    };
  }

  private handleConfirm(input: string): FlowResult {
    if (!input) {
      return { done: false, reply: `Type 'yes' to confirm, or pick a number (1-${FIELD_DEFS.length}) to edit a field.` };
    }

    if (CONFIRM_YES.has(input.toLowerCase())) {
      this.step = 'WRITING';
      return { done: false, reply: 'Writing your files...', writeResult: 'pending' };
    }

    const num = parseInt(input, 10);
    if (!isNaN(num) && num >= 1 && num <= FIELD_DEFS.length) {
      return this.reaskField(FIELD_DEFS[num - 1].key);
    }

    return { done: false, reply: `Type 'yes' to confirm, or pick a number (1-${FIELD_DEFS.length}) to edit a field.` };
  }

  private handleWriteError(input: string): FlowResult {
    const t = input.toLowerCase();
    if (t === 'yes' || t === 'retry') {
      this.step = 'WRITING';
      return { done: false, reply: 'Retrying...', writeResult: 'pending' };
    }

    const num = parseInt(input, 10);
    if (!isNaN(num) && num >= 1 && num <= FIELD_DEFS.length) {
      return this.reaskField(FIELD_DEFS[num - 1].key);
    }

    return {
      done: false,
      reply:
        `Something went wrong writing your files: ${this.writeError}\n` +
        `Type **retry** to try again, pick a number to edit a field, or \`!cancel\` to give up.`,
    };
  }

  private finishEdit(): FlowResult {
    this.editing = false;
    return this.showConfirmation();
  }

  private reaskField(key: keyof OnboardingValues): FlowResult {
    this.editing = true;
    switch (key) {
      case 'userName':
        this.step = 'NAME';
        return { done: false, reply: "**What's your name?**" };
      case 'timezone':
        this.step = 'TIMEZONE';
        return {
          done: false,
          reply:
            '**What timezone are you in?**\n' +
            'Use an IANA name like `America/New_York`, or an abbreviation like `EST`, `PST`, `CET`.',
        };
      case 'morningCheckin':
        this.step = 'CHECKIN';
        return { done: false, reply: '**Would you like a morning check-in message each day?** (yes / no)' };
      default:
        return this.showConfirmation();
    }
  }
}
