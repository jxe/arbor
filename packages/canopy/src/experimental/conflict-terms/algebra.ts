/** Private experiment: ordered merge terms, not a Wire representation. */
export interface Term<T> {
  sign: 1 | -1;
  value: T;
}

/** Cancel opposite occurrences only. In particular, A + A - B stays unresolved. */
export function simplify<T>(terms: readonly Term<T>[], key: (value: T) => string): Term<T>[] {
  const result: Term<T>[] = [];
  for (const term of terms) {
    const opposite = result.findIndex((other) => other.sign !== term.sign && key(other.value) === key(term.value));
    if (opposite < 0) result.push(term);
    else result.splice(opposite, 1);
  }
  if (result.reduce((sum, term) => sum + term.sign, 0) !== 1) throw new Error("Merge terms must have total weight one");
  return result;
}

/** Apply an ordinary projection delta without treating it as a resolution. */
export function continueTerms<T>(current: readonly Term<T>[], base: T, candidate: T, key: (value: T) => string): Term<T>[] {
  // Prefer the newly authored projection when a region cannot be materialized uniquely.
  return simplify([{ sign: 1, value: candidate }, ...current, { sign: -1, value: base }], key);
}

export function selected<T>(terms: readonly Term<T>[]): T {
  const term = terms.find((term) => term.sign === 1);
  if (!term) throw new Error("Merge has no positive term");
  return term.value;
}
