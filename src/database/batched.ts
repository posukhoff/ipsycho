/**
 * Runs a cleanup step until it touches fewer rows than one batch. Retention jobs used to issue one
 * unbounded `UPDATE ... RETURNING id` over the whole table; on a busy month that held a lock and a
 * result set the size of the table just to count rows.
 */
export const CLEANUP_BATCH = 1000;

export async function drainInBatches(batchSize: number, step: () => Promise<number>, maxBatches = 200): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const changed = await step();
    total += changed;
    if (changed < batchSize) break;
  }
  return total;
}
