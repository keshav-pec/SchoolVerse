/** Small form controls shared by the room inspector and the multi-select dialogs. */

export function CheckGroup<T extends string>({ legend, options, selected, onChange, disabled }: { legend: string; options: readonly { code: T; label: string }[]; selected: readonly T[]; onChange: (next: T[]) => void; disabled?: boolean }) {
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="sr-only">{legend}</legend>
      <div className="grid gap-x-3 gap-y-1.5 sm:grid-cols-2">
        {options.map((o) => (
          <label key={o.code} className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(o.code)}
              onChange={(e) => onChange(e.target.checked ? [...selected, o.code] : selected.filter((c) => c !== o.code))}
              className="size-4 accent-[var(--color-brand)]"
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
