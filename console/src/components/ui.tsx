import type { ReactNode } from 'react';

export function PageHeader(props: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  if (!props.description && !props.actions) {
    return null;
  }

  return (
    <div className="page-header">
      {props.description ? (
        <p className="supporting-text page-header-description">
          {props.description}
        </p>
      ) : (
        <span />
      )}
      {props.actions ? (
        <div className="header-actions">{props.actions}</div>
      ) : null}
    </div>
  );
}

export function Panel(props: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  accent?: 'default' | 'warm';
}) {
  return (
    <section className={props.accent === 'warm' ? 'panel warm' : 'panel'}>
      {props.title ? (
        <div className="panel-header">
          <div>
            <h4>{props.title}</h4>
            {props.subtitle ? (
              <p className="supporting-text">{props.subtitle}</p>
            ) : null}
          </div>
        </div>
      ) : null}
      {props.children}
    </section>
  );
}

export function MetricCard(props: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="metric-card">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      {props.detail ? <small>{props.detail}</small> : null}
    </div>
  );
}

export function BooleanPill(props: {
  value: boolean;
  trueLabel?: string;
  falseLabel?: string;
}) {
  const label = props.value
    ? (props.trueLabel ?? 'on')
    : (props.falseLabel ?? 'off');

  return (
    <span
      className={props.value ? 'boolean-pill is-on' : 'boolean-pill is-off'}
    >
      <span className="boolean-pill-dot" />
      {label}
    </span>
  );
}

export function BooleanToggle(props: {
  value: boolean;
  onChange: (value: boolean) => void;
  trueLabel?: string;
  falseLabel?: string;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <fieldset className="binary-toggle" aria-label={props.ariaLabel}>
      <button
        className={
          props.value
            ? 'binary-toggle-button active is-on'
            : 'binary-toggle-button'
        }
        type="button"
        disabled={props.disabled}
        aria-pressed={props.value}
        onClick={() => {
          if (!props.value) {
            props.onChange(true);
          }
        }}
      >
        {props.trueLabel ?? 'on'}
      </button>
      <button
        className={
          !props.value
            ? 'binary-toggle-button active is-off'
            : 'binary-toggle-button'
        }
        type="button"
        disabled={props.disabled}
        aria-pressed={!props.value}
        onClick={() => {
          if (props.value) {
            props.onChange(false);
          }
        }}
      >
        {props.falseLabel ?? 'off'}
      </button>
    </fieldset>
  );
}

export function BooleanField(props: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  trueLabel?: string;
  falseLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div className="field boolean-field">
      <span>{props.label}</span>
      <BooleanToggle
        value={props.value}
        onChange={props.onChange}
        trueLabel={props.trueLabel}
        falseLabel={props.falseLabel}
        disabled={props.disabled}
        ariaLabel={props.label}
      />
    </div>
  );
}
