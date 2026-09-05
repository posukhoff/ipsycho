import { useId, type ReactNode } from "react";
import { haptics } from "../lib/telegram.js";

/**
 * Form controls.
 *
 * They are uncontrolled-looking but controlled: every one takes `value` and `onChange`, because the
 * create/edit form has five schedule shapes whose fields depend on each other, and a form that
 * keeps state in the DOM cannot switch shapes without losing what was typed.
 *
 * `Field` is the label/hint/error wrapper. Wrap every control in one — the error slot is where the
 * `validation_failed` details land, and a control that renders its own label ends up misaligned
 * with the rest of the screen.
 */

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label?: ReactNode | undefined;
  hint?: ReactNode | undefined;
  error?: ReactNode | undefined;
  required?: boolean | undefined;
  children: ReactNode;
}): ReactNode {
  return (
    <label className="ip-field">
      {label ? (
        <span className="ip-field__label">
          {label}
          {required ? <span className="ip-field__required"> *</span> : null}
        </span>
      ) : null}
      <span className="ip-field__control">{children}</span>
      {hint && !error ? <span className="ip-field__hint">{hint}</span> : null}
      {error ? <span className="ip-field__error">{error}</span> : null}
    </label>
  );
}

export interface TextInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string | undefined;
  readonly maxLength?: number | undefined;
  readonly disabled?: boolean | undefined;
  readonly boxed?: boolean | undefined;
  readonly inputMode?: "text" | "numeric" | "decimal" | "search";
  readonly autoFocus?: boolean | undefined;
}

export function TextInput({ value, onChange, placeholder, maxLength, disabled, boxed, inputMode, autoFocus }: TextInputProps): ReactNode {
  return (
    <input
      className={`ip-input${boxed ? " ip-input--boxed" : ""}`}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      {...(placeholder === undefined ? {} : { placeholder })}
      {...(maxLength === undefined ? {} : { maxLength })}
      {...(inputMode === undefined ? {} : { inputMode })}
      disabled={disabled}
      autoFocus={autoFocus}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  maxLength,
  rows = 3,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  maxLength?: number | undefined;
  rows?: number | undefined;
  disabled?: boolean | undefined;
}): ReactNode {
  return (
    <textarea
      className="ip-textarea"
      value={value}
      rows={rows}
      onChange={(event) => onChange(event.target.value)}
      {...(placeholder === undefined ? {} : { placeholder })}
      {...(maxLength === undefined ? {} : { maxLength })}
      disabled={disabled}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | undefined;
  disabled?: boolean | undefined;
}): ReactNode {
  return (
    <input
      className="ip-input ip-input--boxed"
      type="number"
      inputMode="numeric"
      value={value === null ? "" : String(value)}
      step={step}
      {...(min === undefined ? {} : { min })}
      {...(max === undefined ? {} : { max })}
      disabled={disabled}
      onChange={(event) => {
        const raw = event.target.value;
        onChange(raw === "" ? null : Number(raw));
      }}
    />
  );
}

export interface Option<Value extends string> {
  readonly value: Value;
  readonly label: ReactNode;
  readonly disabled?: boolean | undefined;
}

export function Select<Value extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: Value;
  options: readonly Option<Value>[];
  onChange: (value: Value) => void;
  disabled?: boolean | undefined;
}): ReactNode {
  return (
    <select className="ip-select" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as Value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {typeof option.label === "string" ? option.label : option.value}
        </option>
      ))}
    </select>
  );
}

/** Two to four exclusive choices, side by side: the schedule shape, the reschedule scope. */
export function SegmentedControl<Value extends string>({
  value,
  options,
  onChange,
}: {
  value: Value;
  options: readonly Option<Value>[];
  onChange: (value: Value) => void;
}): ReactNode {
  return (
    <div className="ip-segmented" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={option.disabled}
          className={`ip-segmented__option${option.value === value ? " ip-segmented__option--active" : ""}`}
          onClick={() => {
            haptics.select();
            onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** An on/off setting. Put it in a `ListRow`'s `trailing`. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean | undefined;
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`ip-switch${checked ? " ip-switch--on" : ""}`}
      onClick={() => {
        haptics.impact("light");
        onChange(!checked);
      }}
    >
      <span className="ip-switch__knob" />
    </button>
  );
}

/** The round tick of the today list; `square` is the week plan's checkbox. */
export function Checkbox({
  checked,
  onChange,
  label,
  square,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  square?: boolean | undefined;
  disabled?: boolean | undefined;
}): ReactNode {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`ip-checkbox${checked ? " ip-checkbox--checked" : ""}${square ? " ip-checkbox--square" : ""}`}
      onClick={() => {
        haptics.impact(checked ? "light" : "medium");
        onChange(!checked);
      }}
    >
      ✓
    </button>
  );
}

/** Multi-select: weekdays, days of the month, reminder offsets. */
export function ChipGroup<Value extends string>({
  values,
  options,
  onChange,
}: {
  values: readonly Value[];
  options: readonly Option<Value>[];
  onChange: (values: Value[]) => void;
}): ReactNode {
  const id = useId();
  return (
    <div className="ip-chip-group" role="group" aria-labelledby={id}>
      {options.map((option) => {
        const selected = values.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={option.disabled}
            className={`ip-chip${selected ? " ip-chip--selected" : ""}`}
            onClick={() => {
              haptics.select();
              onChange(selected ? values.filter((item) => item !== option.value) : [...values, option.value]);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
