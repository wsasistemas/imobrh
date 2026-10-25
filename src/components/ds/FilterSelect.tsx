export interface FilterOption {
  value: string;
  label: string;
}

interface FilterSelectProps {
  label: string;
  value: string;
  options: readonly FilterOption[];
  onChange: (value: string) => void;
  /** Nome acessível do select (ex.: "Filtrar equipe"). */
  ariaLabel: string;
}

/** Rótulo e select nativo na mesma caixa, como na referência. */
export function FilterSelect({ label, value, options, onChange, ariaLabel }: FilterSelectProps) {
  return (
    <label className="ds-select">
      {label}:{" "}
      <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
