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
  id?: string;
}) {
  return (
    <section
      id={props.id}
      className={props.accent === 'warm' ? 'panel warm' : 'panel'}
    >
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
  href?: string;
}) {
  const content = (
    <>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      {props.detail ? <small>{props.detail}</small> : null}
    </>
  );

  if (props.href) {
    return (
      <a className="metric-card metric-card-link" href={props.href}>
        {content}
      </a>
    );
  }

  return <div className="metric-card">{content}</div>;
}

export function SegmentedToggle(props: {
  ariaLabel: string;
  value: string;
  className?: string;
  options: Array<{
    value: string;
    label: string;
    activeTone?: 'is-on' | 'is-off';
  }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset
      className={
        props.className ? `binary-toggle ${props.className}` : 'binary-toggle'
      }
      aria-label={props.ariaLabel}
    >
      {props.options.map((option) => {
        const active = option.value === props.value;
        return (
          <button
            key={option.value}
            className={
              active
                ? `binary-toggle-button active ${option.activeTone ?? 'is-on'}`
                : 'binary-toggle-button'
            }
            type="button"
            disabled={props.disabled}
            aria-pressed={active}
            onClick={() => {
              if (!active) {
                props.onChange(option.value);
              }
            }}
          >
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}

export function BooleanPill(props: {
  value: boolean;
  trueLabel?: string;
  falseLabel?: string;
  falseTone?: 'default' | 'danger';
}) {
  const label = props.value
    ? (props.trueLabel ?? 'on')
    : (props.falseLabel ?? 'off');
  const falseToneClass =
    !props.value && props.falseTone === 'danger' ? ' tone-danger' : '';

  return (
    <span
      className={
        props.value
          ? 'boolean-pill is-on'
          : `boolean-pill is-off${falseToneClass}`
      }
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
    <SegmentedToggle
      className="boolean-toggle"
      ariaLabel={props.ariaLabel}
      value={props.value ? 'true' : 'false'}
      options={[
        {
          value: 'true',
          label: props.trueLabel ?? 'on',
          activeTone: 'is-on',
        },
        {
          value: 'false',
          label: props.falseLabel ?? 'off',
          activeTone: 'is-off',
        },
      ]}
      disabled={props.disabled}
      onChange={(value) => {
        props.onChange(value === 'true');
      }}
    />
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
