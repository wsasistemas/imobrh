interface AlertBannerProps {
  title: string;
  description: string;
  /** Some abaixo de 750px, como na referência. */
  actionLabel?: string;
  onAction?: () => void;
}

export function AlertBanner({ title, description, actionLabel, onAction }: AlertBannerProps) {
  return (
    <div className="ds-alert">
      <span className="ds-alert__symbol" aria-hidden="true">
        !
      </span>
      <div>
        <strong className="ds-alert__title">{title}</strong>
        <p className="ds-alert__text">{description}</p>
      </div>
      {actionLabel && (
        <button type="button" className="ds-btn ds-alert__action" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
