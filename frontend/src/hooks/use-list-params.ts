import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useDebouncedValue } from './use-debounce';

/**
 * Filters, page and search for a list page, kept in the URL so a filtered list can be shared or reloaded.
 * `setParam` drops empty values and goes back to page 1 unless `keepPage` is set. The search box types instantly and
 * reaches the URL (`q`) after a 300 ms pause.
 */
export function useListParams() {
  const [params, setParams] = useSearchParams();

  const setParam = (updates: Record<string, string | null>, keepPage = false) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(updates)) {
          if (v === null || v === '') next.delete(k);
          else next.set(k, v);
        }
        if (!keepPage) next.delete('page');
        return next;
      },
      { replace: true },
    );
  };

  const page = Number(params.get('page')) > 0 ? Number(params.get('page')) : 1;

  const [search, setSearch] = useState(params.get('q') ?? '');
  const debounced = useDebouncedValue(search, 300);
  useEffect(() => {
    if ((debounced.trim() || undefined) !== (params.get('q') ?? undefined)) setParam({ q: debounced.trim() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  /** Empties the search box and every filter. */
  const clearAll = () => {
    setSearch('');
    setParams({}, { replace: true });
  };

  return { params, setParam, page, search, setSearch, clearAll };
}
