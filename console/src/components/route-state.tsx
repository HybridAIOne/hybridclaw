export function RouteLoadingState(props: { message?: string }) {
  return (
    <div className="page-stack">
      <div className="empty-state">
        {props.message || 'Loading admin console...'}
      </div>
    </div>
  );
}

export function RouteErrorState(props: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="page-stack">
      <div className="empty-state error">
        <p>{props.message}</p>
        {props.onAction ? (
          <button
            className="primary-button"
            type="button"
            onClick={props.onAction}
          >
            {props.actionLabel || 'Retry'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
