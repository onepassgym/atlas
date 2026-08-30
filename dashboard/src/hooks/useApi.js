import { useState, useCallback, useEffect } from 'react';
import { api } from '../api/client';

/**
 * useApi — data fetching hook with loading/error states
 * @param {string} path - API path (e.g. /api/spaces/stats)  
 * @param {object} opts - { auto: true, deps: [] }
 */
export function useApi(path, opts = {}) {
  const { auto = true, deps = [] } = opts;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(auto);
  const [error, setError] = useState(null);

  const execute = useCallback(async (overridePath) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(overridePath || path);
      setData(res);
      return res;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (auto && path) execute();
  }, [auto, path, ...deps]);

  return { data, loading, error, refetch: execute };
}
