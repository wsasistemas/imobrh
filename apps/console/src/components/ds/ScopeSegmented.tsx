export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface ScopeSegmentedProps<T extends string> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Nome do grupo para leitores de tela. */
  label: string;
}

/** Botões mutuamente exclusivos (Meus / Minha equipe / Todos); o ativo tem aria-pressed. */
export function ScopeSegmented<T extends string>({ options, value, onChange, label }: ScopeSegmentedProps<T>) {
  return (
    <div className="ds-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
