/**
 * Approval mode chip — shows and changes the session's `ask | auto | full`
 * mode from the composer.
 *
 * It renders the gateway's effective mode and never assumes a change took
 * effect; the parent confirms through `/approvals mode`. NOT the per-request
 * approval card, which answers one pending prompt.
 */
import type { ComponentType } from 'react';
import {
  APPROVAL_MODE_PRESENTATION,
  APPROVAL_MODES,
  type ApprovalMode,
  isApprovalMode,
} from '../../../../container/shared/approval-mode.js';
import {
  ChevronDown,
  Hand,
  type IconProps,
  ShieldAlert,
  ShieldCheck,
} from '../../components/icons';
import {
  Select,
  SelectContent,
  SelectGroupLabel,
  SelectIcon,
  SelectItem,
  SelectItemBody,
  SelectItemIndicator,
  SelectItemSubtitle,
  SelectTrigger,
} from '../../components/select';
import { cx } from '../../lib/cx';
import css from './approval-mode-select.module.css';
import chatCss from './chat-page.module.css';

const MODE_ICONS: Record<ApprovalMode, ComponentType<IconProps>> = {
  ask: Hand,
  auto: ShieldCheck,
  full: ShieldAlert,
};

export function ApprovalModeSelect(props: {
  value: ApprovalMode;
  disabled?: boolean;
  onChange: (mode: ApprovalMode) => void;
}) {
  const current = APPROVAL_MODE_PRESENTATION[props.value];
  const TriggerIcon = MODE_ICONS[props.value];
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      onValueChange={(next) => {
        if (isApprovalMode(next) && next !== props.value) props.onChange(next);
      }}
    >
      <SelectTrigger
        className={cx(chatCss.composerPill, css.trigger)}
        data-mode={props.value}
        aria-label={`Approvals: ${current.label}`}
        title={current.description}
        disabled={props.disabled}
      >
        <TriggerIcon width={15} height={15} aria-hidden="true" />
        <span className={css.label}>{current.label}</span>
        <SelectIcon className={chatCss.composerPillChevron}>
          <ChevronDown width={14} height={14} />
        </SelectIcon>
      </SelectTrigger>
      <SelectContent className={css.popup} aria-label="Approval mode">
        <SelectGroupLabel>How should actions be approved?</SelectGroupLabel>
        {APPROVAL_MODES.map((mode) => {
          const { label, description } = APPROVAL_MODE_PRESENTATION[mode];
          const ItemIcon = MODE_ICONS[mode];
          return (
            <SelectItem
              key={mode}
              value={mode}
              textValue={label}
              className={css.item}
              data-mode={mode}
            >
              <ItemIcon
                className={css.icon}
                width={18}
                height={18}
                aria-hidden="true"
              />
              <SelectItemBody>
                <span className={css.title}>{label}</span>
                <SelectItemSubtitle className={css.subtitle}>
                  {description}
                </SelectItemSubtitle>
              </SelectItemBody>
              <SelectItemIndicator className={css.check} />
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
