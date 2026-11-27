// Pure geometry for the line chart: no React, no DOM.

/** Runs of consecutive buckets that have a value; a withheld bucket breaks the line. */
export function lineRuns(values: readonly (number | null)[], count: number): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (values[index] === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else {
      run.push(index);
    }
  }
  if (run.length > 0) runs.push(run);
  return runs;
}
