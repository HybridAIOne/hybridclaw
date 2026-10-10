/**
 * Review the gateway's complete allowlisted facts as inert text, never HTML.
 * Unlike command previews this payload is complete; it does not reconstruct
 * missing arguments or authorize any action.
 */
import type { ChatStreamApproval } from '../../api/chat-types';
import css from './review-card.module.css';

const LABELS: Record<string, string> = {
  from: 'From',
  to: 'To',
  cc: 'Cc',
  bcc: 'Bcc',
  toRecipients: 'To',
  ccRecipients: 'Cc',
  bccRecipients: 'Bcc',
  subject: 'Subject',
  body: 'Body',
  content: 'Content',
  contentType: 'Content type',
  content_type: 'Content type',
  attachments: 'Attachments',
  name: 'Name',
  filename: 'Filename',
  path: 'Path',
  size: 'Size',
  transport: 'Transport',
  message: 'Message',
  account: 'Account',
  permission: 'Permission',
  emailAddress: 'Email address',
  address: 'Address',
  role: 'Role',
  type: 'Type',
  destination: 'Destination',
  url: 'URL',
  file_id: 'File ID',
  fileId: 'File ID',
  file_name: 'Filename',
  file_path: 'Path',
  email: 'Email',
  recipient: 'Recipient',
  total: 'Total',
  groups: 'Groups',
  left_alone: 'Left alone',
  source: 'Source',
};

function ReviewValue({ value }: { value: unknown }) {
  if (value === null) return <span>None</span>;
  if (Array.isArray(value)) {
    const seen = new Map<string, number>();
    const entries = value.map((entry) => {
      const encoded = JSON.stringify(entry);
      const occurrence = seen.get(encoded) ?? 0;
      seen.set(encoded, occurrence + 1);
      return { value: entry, key: `${encoded}:${occurrence}` };
    });
    return value.length ? (
      <ul>
        {entries.map((entry) => (
          <li key={entry.key}>
            <ReviewValue value={entry.value} />
          </li>
        ))}
      </ul>
    ) : (
      <span>None</span>
    );
  }
  if (typeof value === 'object') {
    return (
      <dl className={css.details}>
        {Object.entries(value as Record<string, unknown>).map(
          ([key, entry]) => (
            <div key={key}>
              <dt>{LABELS[key] ?? key}</dt>
              <dd>
                <ReviewValue value={entry} />
              </dd>
            </div>
          ),
        )}
      </dl>
    );
  }
  return <span className={css.body}>{String(value)}</span>;
}

export function ApprovalReview({ approval }: { approval: ChatStreamApproval }) {
  let review: unknown;
  try {
    review = approval.reviewArguments
      ? JSON.parse(approval.reviewArguments)
      : undefined;
  } catch {
    /* Keep malformed data visible for review. */
  }
  return (
    <>
      {approval.reviewArguments ? (
        <section className={css.approvalReview} aria-label="Action details">
          <strong>Action details</strong>
          {review && typeof review === 'object' && !Array.isArray(review) ? (
            <ReviewValue value={review} />
          ) : (
            <p>
              The structured details could not be read. Review the original
              details below.
            </p>
          )}
          <details className={css.fullDetails}>
            <summary>Full action details</summary>
            <pre>
              {review !== undefined
                ? JSON.stringify(review, null, 2)
                : approval.reviewArguments}
            </pre>
          </details>
        </section>
      ) : null}
      <details className={css.fullDetails}>
        <summary>Original approval prompt</summary>
        <pre>{approval.prompt}</pre>
      </details>
    </>
  );
}
