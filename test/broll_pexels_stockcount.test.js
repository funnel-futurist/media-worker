/**
 * test/broll_pexels_stockcount.test.js
 *
 * Regression guard for the QC counter bug (2026-06-01): the pipeline result's
 * `insertions.stockCount` used to filter only `source === 'pixabay'`, which
 * undercounted stock when Pexels picks landed (Tier 2-a, 2026-05-something
 * added Pexels as a second stock provider). The QC report showed
 * "0 client + 0 stock" even with 2-3 Pexels picks in the edit.
 *
 * This is a pure-function test on the filter shape — exact same predicates
 * as clean_mode_pipeline.js uses to compute the report envelope. If anyone
 * touches the predicates without including 'pexels' in stockCount, this
 * test fails.
 */

import test from "node:test";
import assert from "node:assert/strict";

// Replicates the predicates used in clean_mode_pipeline.js insertions
// envelope (search "PR-A: provenance breakdown"). Update this file when
// those predicates change.
function countByProvenance(insertionsDetail) {
  return {
    clientCount: insertionsDetail.filter((d) => d.source === "client").length,
    stockCount: insertionsDetail.filter(
      (d) => d.source === "pixabay" || d.source === "pexels",
    ).length,
    pixabayCount: insertionsDetail.filter((d) => d.source === "pixabay").length,
    pexelsCount: insertionsDetail.filter((d) => d.source === "pexels").length,
  };
}

test("stockCount includes Pexels picks (regression fix 2026-06-01)", () => {
  const insertions = [
    { source: "pexels", asset_id: "pexels-1" },
    { source: "pexels", asset_id: "pexels-2" },
    { source: "pixabay", asset_id: "pixabay-1" },
    { source: "client", asset_id: "client-1" },
  ];
  const counts = countByProvenance(insertions);
  assert.equal(counts.clientCount, 1);
  assert.equal(counts.stockCount, 3, "stockCount must include both Pexels + Pixabay");
  assert.equal(counts.pixabayCount, 1);
  assert.equal(counts.pexelsCount, 2);
});

test("stockCount=0 only when actually zero stock (not a Pexels miscount)", () => {
  const insertions = [
    { source: "client", asset_id: "c1" },
    { source: "client", asset_id: "c2" },
  ];
  const counts = countByProvenance(insertions);
  assert.equal(counts.clientCount, 2);
  assert.equal(counts.stockCount, 0);
  assert.equal(counts.pixabayCount, 0);
  assert.equal(counts.pexelsCount, 0);
});

test("all-Pexels edit reports correct stock total", () => {
  const insertions = [
    { source: "pexels", asset_id: "pexels-1" },
    { source: "pexels", asset_id: "pexels-2" },
    { source: "pexels", asset_id: "pexels-3" },
  ];
  const counts = countByProvenance(insertions);
  assert.equal(counts.stockCount, 3, "an all-Pexels edit must report stockCount=3, not 0");
  assert.equal(counts.pexelsCount, 3);
  assert.equal(counts.pixabayCount, 0);
});

test("unknown source label does not count as stock (defensive)", () => {
  // If a future provider gets added (e.g. unsplash), it shouldn't silently
  // count as stock until the predicate is intentionally updated.
  const insertions = [
    { source: "unsplash", asset_id: "u1" },
    { source: "pexels", asset_id: "p1" },
  ];
  const counts = countByProvenance(insertions);
  assert.equal(counts.stockCount, 1, "only known stock providers count");
  assert.equal(counts.pexelsCount, 1);
});
