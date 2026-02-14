/**
 * OnboardingFlow — pure conversation state machine for interactive onboarding.
 *
 * No file I/O. Tracks current step, collected values, and returns reply text.
 * The caller (discord.ts) handles sending messages and invoking the writer.
 */

export type Purpose = 'dev' | 'pa' | 'both';

export interface OnboardingValues {
  botName: string;
  userName: string;
  purpose: Purpose;
  workingDirs?: string;
  personality?: string;
}

export type FlowResult = {
  done: boolean;
  reply: string;
  writeResult?: 'pending';
};

type Step =
  | 'BOT_NAME'
  | 'USER_NAME'
  | 'PURPOSE'
  | 'WORKING_DIRS'
  | 'PERSONALITY'
  | 'CONFIRM'
  | 'WRITING'
  | 'WRITE_ERROR'
  | 'DONE';

const MAX_INPUT_LENGTH = 200;
const PLACEHOLDER_RE = /\{\{[^}]+\}\}/;
const SKIP_WORDS = new Set(['skip', '-', 'none', 'n/a']);

// Numbered fields displayed in the confirmation summary. Order matters.
type FieldDef = { label: string; key: keyof OnboardingValues };
function getFieldDefs(purpose: Purpose): FieldDef[] {
  const fields: FieldDef[] = [
    { label: 'Bot name', key: 'botName' },
    { label: 'Your name', key: 'userName' },
    { label: 'Purpose', key: 'purpose' },
  ];
  if (purpose === 'dev' || purpose === 'both') {
    fields.push({ label: 'Working directories', key: 'workingDirs' });
  }
  if (purpose === 'pa' || purpose === 'both') {
    fields.push({ label: 'Personality', key: 'personality' });
  }
  return fields;
}

function parsePurpose(input: string): Purpose | null {
  const t = input.trim().toLowerCase();
  if (t === '1' || t === 'dev' || t === 'development' || t === 'coding') return 'dev';
  if (t === '2' || t === 'pa' || t === 'personal assistant' || t === 'assistant') return 'pa';
  if (t === '3' || t === 'both') return 'both';
  return null;
}

const PURPOSE_LABELS: Record<Purpose, string> = {
  dev: 'Development / coding',
  pa: 'Personal assistant',
  both: 'Both',
};

const CONFIRM_YES = new Set(['yes', 'y', 'ok', 'confirm', 'looks good']);

export class OnboardingFlow {
  private step: Step = 'BOT_NAME';
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
        `Hey ${displayName}! I'm brand new here and need a quick setup.\n\n` +
        `**What should I call myself?** (e.g., Weston, Claw, Jarvis)`,
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

    // Validate input for data-collection steps
    if (this.step !== 'WORKING_DIRS' && this.step !== 'PERSONALITY') {
      // Required fields
      if (!input) {
        return { done: false, reply: "I need something here — what would you like?" };
      }
    }

    if (input.length > MAX_INPUT_LENGTH) {
      return { done: false, reply: `That's a bit long — can you keep it under ${MAX_INPUT_LENGTH} characters?` };
    }

    if (input && PLACEHOLDER_RE.test(input)) {
      return { done: false, reply: "That looks like a template placeholder — give me something real!" };
    }

    switch (this.step) {
      case 'BOT_NAME':
        this.values.botName = input;
        if (this.editing) return this.finishEdit();
        this.step = 'USER_NAME';
        return { done: false, reply: `Got it — I'll be **${input}**.\n\n**What's your name?**` };

      case 'USER_NAME':
        this.values.userName = input;
        if (this.editing) return this.finishEdit();
        this.step = 'PURPOSE';
        return {
          done: false,
          reply:
            `Nice to meet you, ${input}.\n\n` +
            `**What will you mainly use me for?**\n` +
            `1. Development / coding\n` +
            `2. Personal assistant\n` +
            `3. Both`,
        };

      case 'PURPOSE': {
        const purpose = parsePurpose(input);
        if (!purpose) {
          return {
            done: false,
            reply: "I didn't catch that — pick 1, 2, or 3 (or type dev / assistant / both).",
          };
        }
        this.values.purpose = purpose;
        if (this.editing) return this.finishEdit();

        if (purpose === 'dev' || purpose === 'both') {
          this.step = 'WORKING_DIRS';
          return {
            done: false,
            reply:
              `**What directories do you usually work in?**\n` +
              `List the paths, like \`~/code/my-project\`. Or say **skip** to skip.`,
          };
        }
        if (purpose === 'pa') {
          this.step = 'PERSONALITY';
          return {
            done: false,
            reply:
              `**Any vibe or personality preferences for me?**\n` +
              `(e.g., "direct and dry", "warm and chatty", "snarky but helpful") Or say **skip** to skip.`,
          };
        }
        // Shouldn't reach here, but TypeScript
        return this.showConfirmation();
      }

      case 'WORKING_DIRS':
        this.values.workingDirs = (SKIP_WORDS.has(input.toLowerCase()) ? '' : input) || undefined;
        if (this.editing) return this.finishEdit();
        if (this.values.purpose === 'both') {
          this.step = 'PERSONALITY';
          return {
            done: false,
            reply:
              `**Any vibe or personality preferences for me?**\n` +
              `(e.g., "direct and dry", "warm and chatty", "snarky but helpful") Or say **skip** to skip.`,
          };
        }
        return this.showConfirmation();

      case 'PERSONALITY':
        this.values.personality = (SKIP_WORDS.has(input.toLowerCase()) ? '' : input) || undefined;
        if (this.editing) return this.finishEdit();
        return this.showConfirmation();

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

  private showConfirmation(): FlowResult {
    this.step = 'CONFIRM';
    const fields = getFieldDefs(this.values.purpose!);
    const lines = fields.map((f, i) => {
      const val = this.values[f.key];
      const display = f.key === 'purpose' ? PURPOSE_LABELS[val as Purpose] : (val || '(skipped)');
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
      const fields = getFieldDefs(this.values.purpose!);
      return { done: false, reply: `Type 'yes' to confirm, or pick a number (1-${fields.length}) to edit a field.` };
    }

    if (CONFIRM_YES.has(input.toLowerCase())) {
      this.step = 'WRITING';
      return { done: false, reply: 'Writing your files...', writeResult: 'pending' };
    }

    const num = parseInt(input, 10);
    const fields = getFieldDefs(this.values.purpose!);

    if (!isNaN(num) && num >= 1 && num <= fields.length) {
      const field = fields[num - 1];
      return this.reaskField(field.key);
    }

    return { done: false, reply: `Type 'yes' to confirm, or pick a number (1-${fields.length}) to edit a field.` };
  }

  private handleWriteError(input: string): FlowResult {
    const t = input.toLowerCase();
    if (t === 'yes' || t === 'retry') {
      this.step = 'WRITING';
      return { done: false, reply: 'Retrying...', writeResult: 'pending' };
    }

    const num = parseInt(input, 10);
    const fields = getFieldDefs(this.values.purpose!);
    if (!isNaN(num) && num >= 1 && num <= fields.length) {
      return this.reaskField(fields[num - 1].key);
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
      case 'botName':
        this.step = 'BOT_NAME';
        return { done: false, reply: '**What should I call myself?**' };
      case 'userName':
        this.step = 'USER_NAME';
        return { done: false, reply: "**What's your name?**" };
      case 'purpose':
        this.step = 'PURPOSE';
        return {
          done: false,
          reply:
            '**What will you mainly use me for?**\n1. Development / coding\n2. Personal assistant\n3. Both',
        };
      case 'workingDirs':
        this.step = 'WORKING_DIRS';
        return {
          done: false,
          reply: '**What directories do you usually work in?** Or say **skip** to skip.',
        };
      case 'personality':
        this.step = 'PERSONALITY';
        return {
          done: false,
          reply: '**Any vibe or personality preferences for me?** Or say **skip** to skip.',
        };
      default:
        return this.showConfirmation();
    }
  }
}
