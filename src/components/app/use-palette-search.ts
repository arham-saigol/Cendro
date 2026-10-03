"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { normalizePaletteQuery, paletteQueryError, PALETTE_MIN_QUERY_LENGTH, PALETTE_SEARCH_DELAY_MS } from "@/lib/palette-search";

type EntityQueries = {
  jd?: FunctionReturnType<typeof api.tasks.searchJd> | Error;
  oneTime?: FunctionReturnType<typeof api.tasks.searchOneTime> | Error;
  sops?: FunctionReturnType<typeof api.sops.search> | Error;
};

export function usePaletteSearch({ open, query, companyId, canSearch }: {
  open: boolean;
  query: string;
  companyId: Id<"companies"> | null;
  canSearch: boolean;
}) {
  const normalized = normalizePaletteQuery(query);
  const inputError = paletteQueryError(normalized);
  const eligible = open && canSearch && companyId !== null && !inputError && normalized.length >= PALETTE_MIN_QUERY_LENGTH;
  const [settled, setSettled] = useState<{ query: string; companyId: Id<"companies"> | null } | null>(null);

  useEffect(() => {
    setSettled(null);
    if (!eligible) return;
    const timeout = window.setTimeout(() => setSettled({ query: normalized, companyId }), PALETTE_SEARCH_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [eligible, normalized, companyId]);

  // Drop subscriptions immediately on close, clear, or further typing.
  // Keeping the spec memoized also prevents useQueries render loops.
  const querySpec = useMemo((): RequestForQueries => {
    if (!eligible || !companyId || settled?.query !== normalized || settled.companyId !== companyId) return {};
    const args = { companyId, query: normalized };
    return {
      jd: { query: api.tasks.searchJd, args },
      oneTime: { query: api.tasks.searchOneTime, args },
      sops: { query: api.sops.search, args },
    };
  }, [eligible, companyId, settled, normalized]);
  const queries = useQueries(querySpec) as EntityQueries;
  const subscribed = Object.keys(querySpec).length > 0;
  const values = [queries.jd, queries.oneTime, queries.sops];
  return {
    inputError,
    failed: subscribed && values.some((value) => value instanceof Error),
    searching: eligible && (!subscribed || values.some((value) => value === undefined)),
    results: subscribed ? {
      jd: queries.jd instanceof Error ? undefined : queries.jd,
      oneTime: queries.oneTime instanceof Error ? undefined : queries.oneTime,
      sops: queries.sops instanceof Error ? undefined : queries.sops,
    } : null,
  };
}
