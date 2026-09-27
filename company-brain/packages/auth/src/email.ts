import { createLogger, getEnv } from '@company-brain/core';

const log = createLogger('auth:email');

export interface EmailMessage {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
}

export type EmailSender = (message: EmailMessage) => Promise<void>;

/**
 * `EMAIL_TRANSPORT=log` is the default so a fresh clone can run the full auth
 * flow (sign-up verification, magic link, org invite) with no SMTP account.
 * Every message is printed with the token intact, because in local dev the link
 * *is* the only way to complete the flow.
 */
const logSender: EmailSender = async ({ to, subject, text, html }) => {
  log.info('email.log', 'email (transport=log)', {
    to: Array.isArray(to) ? to : [to],
    subject,
    bodyLength: text.length,
    hasHtml: Boolean(html),
  });
  // Printed in full: in local dev this link is the only way to complete the flow.
  for (const line of text.split('\n')) log.info('email.body', `| ${line}`);
};

let smtpSender: EmailSender | undefined;

async function getSmtpSender(): Promise<EmailSender> {
  if (smtpSender) return smtpSender;

  const env = getEnv();
  if (!env.SMTP_URL) {
    throw new Error('EMAIL_TRANSPORT=smtp but SMTP_URL is not set');
  }

  // Imported lazily so a `log`-configured deployment never pays the cost of
  // loading nodemailer, and never needs it installed.
  const { createTransport } = await import('nodemailer');
  const transport = createTransport(env.SMTP_URL);

  smtpSender = async ({ to, subject, text, html }) => {
    await transport.sendMail({ from: env.EMAIL_FROM, to, subject, text, html });
    log.info('email.sent', 'email sent (transport=smtp)', { to, subject });
  };
  return smtpSender;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  const env = getEnv();
  const sender = env.EMAIL_TRANSPORT === 'smtp' ? await getSmtpSender() : logSender;

  try {
    await sender(message);
  } catch (error) {
    // Auth flows must not 500 because a mail provider is down: Better Auth has
    // already persisted the token, so the user can still request a resend.
    log.error(
      'email.failed',
      'failed to send email — the flow can still be completed via resend',
      { to: message.to, subject: message.subject },
      error,
    );
  }
}

const footer = (appUrl: string) =>
  `\n\n—\nIf you were not expecting this email you can ignore it.${appUrl ? `\n${appUrl}` : ''}`;

/** Best-effort origin for the "ignore this email" footer; never throws. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function htmlShell(title: string, body: string, cta?: { label: string; url: string }): string {
  const button = cta
    ? `<p style="margin:24px 0"><a href="${cta.url}" style="background:#18181b;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${cta.label}</a></p>
       <p style="font-size:13px;color:#71717a">Or paste this link into your browser:<br><span style="word-break:break-all">${cta.url}</span></p>`
    : '';

  return `<!doctype html><html><body style="font-family:ui-sans-serif,system-ui,sans-serif;background:#fafafa;color:#18181b;padding:32px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px">
    <h1 style="font-size:18px;margin:0 0 12px">${title}</h1>
    <div style="font-size:14px;line-height:1.6;color:#3f3f46">${body}</div>
    ${button}
  </div></body></html>`;
}

export interface EmailContext {
  user: { name?: string | null; email: string };
  /** Absent for OTPs, which are delivered as a code rather than a link. */
  url?: string;
  token?: string;
}

/** Appends a token unless Better Auth already embedded it in the URL. */
function withToken(url: string | undefined, token: string | undefined): string {
  if (!url) throw new Error('email template requires a url');
  return token && !url.includes('token=') ? `${url}?token=${encodeURIComponent(token)}` : url;
}

export const authEmails = {
  /**
   * `sendVerificationEmail` / `sendDeleteAccountVerification`. Better Auth
   * hands us `url` already pointing at the relevant endpoint.
   */
  verification: ({ user, url, token }: EmailContext) => {
    const link = withToken(url, token);
    return {
      subject: 'Verify your email',
      text: `Hi ${user.name || user.email},\n\nConfirm your email address to finish setting up your account:\n${link}${footer(originOf(link))}`,
      html: htmlShell(
        'Verify your email',
        `Hi ${user.name || user.email},<br><br>Confirm your email address to finish setting up your account.`,
        { label: 'Verify email', url: link },
      ),
    };
  },

  /** `magicLink` plugin — `url` already contains the single-use token. */
  magicLink: ({ user, url }: EmailContext) => {
    const link = withToken(url, undefined);
    return {
      subject: 'Your sign-in link',
      text: `Hi ${user.name || user.email},\n\nUse this link to sign in. It expires shortly and can only be used once.${footer(originOf(link))}`,
      html: htmlShell(
        'Sign in to Company Brain',
        `Hi ${user.name || user.email},<br><br>Use the button below to sign in. It expires shortly and can only be used once.`,
        { label: 'Sign in', url: link },
      ),
    };
  },

  /** `emailOTP` plugin. */
  otp: ({ user, token }: EmailContext) => ({
    subject: 'Your sign-in code',
    text: `Hi ${user.name || user.email},\n\nYour verification code is: ${token}\n\nIt expires in 10 minutes.`,
    html: htmlShell(
      'Your sign-in code',
      `Hi ${user.name || user.email},<br><br>Your verification code is:<br><br><span style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,monospace">${token}</span><br><br>It expires in 10 minutes.`,
    ),
  }),

  /** `organization` plugin invite. */
  invite: ({ user, url, token }: EmailContext) => {
    const link = withToken(url, token);
    return {
      subject: 'You have been invited to a workspace',
      text: `Hi ${user.name || user.email},\n\nYou have been invited to join a workspace on Company Brain. Accept the invitation here:\n${link}${footer(originOf(link))}`,
      html: htmlShell(
        'You have been invited',
        `Hi ${user.name || user.email},<br><br>You have been invited to join a workspace on Company Brain.`,
        { label: 'Accept invitation', url: link },
      ),
    };
  },
} satisfies Record<string, (ctx: EmailContext) => { subject: string; text: string; html: string }>;

/** Pre-authentication hook: only these domains may create an account. */
export async function isSignupAllowed(email: string): Promise<boolean> {
  const allowed = getEnv().ALLOWED_SIGNUP_EMAIL_DOMAINS;
  if (allowed.length === 0) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return allowed.some((d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`));
}
