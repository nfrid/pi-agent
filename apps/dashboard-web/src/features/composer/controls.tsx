import { modelOptionValue, type RuntimeModelOption } from '../model-option';

export function ComposerModelControl({
  models,
  value,
  disabled,
  onChange,
  error,
}: {
  models: readonly RuntimeModelOption[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  error?: string;
}) {
  if (!models.length && !error) return null;
  return (
    <fieldset className="model-control">
      <legend className="sr-only">Model control</legend>
      <label>
        <span>Model</span>
        <select
          aria-label="Model"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {models.map((model) => {
            const optionValue = modelOptionValue(model.provider, model.model);
            return (
              <option value={optionValue} key={optionValue}>
                {model.name ?? optionValue}
              </option>
            );
          })}
        </select>
      </label>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </fieldset>
  );
}

export function ComposerThinkingControl({
  levels,
  value,
  disabled,
  onChange,
  error,
}: {
  levels: readonly string[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  error?: string;
}) {
  if (!levels.length && !error) return null;
  return (
    <fieldset className="thinking-control">
      <legend className="sr-only">Thinking control</legend>
      <label>
        <span>Thinking</span>
        <select
          aria-label="Thinking level"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {levels.map((level) => (
            <option value={level} key={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </fieldset>
  );
}
