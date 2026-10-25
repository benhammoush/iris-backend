/**
 * Regression coverage and controlled fixtures for snapshot.
 * @packageDocumentation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_SNAPSHOT } from '../../src/fixtures.ts';
import { resolveSnapshot } from '../../src/snapshot.ts';
import {
  SNAPSHOT_FRESH_AFTER_MS,
  STALE_AFTER_MS,
} from '../../src/constants.ts';

const now = Date.parse('2026-10-02T12:00:00.000Z');

/** Create an isolated in-memory cache fixture.
 * @param snapshot - Controlled snapshot payload, including malformed fixtures.
 * @returns A JSON cache reader with a fixed pointer and the supplied payload.
 */
function kv(snapshot: unknown) {
  return {
    /** Read the controlled pointer or snapshot.
     * @param key - Requested pointer or immutable snapshot identity.
     * @returns The fixed pointer or supplied unknown snapshot payload.
     */
    get: (key: string) =>
      Promise.resolve(
        key === 'snapshot:current' ? { key: 'snapshot:v1:test' } : snapshot,
      ),
  };
}

/** Build the controlled stored snapshot used by the test.
 * @param createdAt - Snapshot timestamp chosen to exercise an exact retention boundary.
 * @returns A minimal supported snapshot with empty resource collections.
 */
function snapshot(createdAt: string) {
  return {
    createdAt,
    market: { source: 'snapshot', asOf: '2025-06-30T00:00:00.000Z' },
    assets: [],
    wallets: {},
    swaps: [],
  };
}

void test('snapshot resolver distinguishes fresh, stale, and fixture data at exact boundaries', async () => {
  const fresh = await resolveSnapshot(
    kv(snapshot(new Date(now - SNAPSHOT_FRESH_AFTER_MS).toISOString())),
    now,
  );
  const stale = await resolveSnapshot(
    kv(snapshot(new Date(now - SNAPSHOT_FRESH_AFTER_MS - 1).toISOString())),
    now,
  );
  const oldestStale = await resolveSnapshot(
    kv(snapshot(new Date(now - STALE_AFTER_MS).toISOString())),
    now,
  );
  const expired = await resolveSnapshot(
    kv(snapshot(new Date(now - STALE_AFTER_MS - 1).toISOString())),
    now,
  );
  assert.equal(fresh.state, 'fresh');
  assert.equal(stale.state, 'stale');
  assert.equal(oldestStale.state, 'stale');
  assert.equal(expired.state, 'fixture');
  assert.strictEqual(expired.snapshot, FIXTURE_SNAPSHOT);
});

void test('snapshot resolver rejects malformed pointers and future snapshots', async () => {
  for (const pointer of [null, {}, { key: 42 }, { key: '' }]) {
    const resolved = await resolveSnapshot(
      {
        /** Read one controlled malformed pointer.
         * @returns The invalid pointer fixture.
         */
        get: () => Promise.resolve(pointer),
      },
      now,
    );
    assert.equal(resolved.state, 'fixture');
    assert.strictEqual(resolved.snapshot, FIXTURE_SNAPSHOT);
  }
  assert.equal(
    (await resolveSnapshot(kv(snapshot(new Date(now + 1).toISOString())), now))
      .state,
    'fixture',
  );
});

void test('snapshot resolver replaces invalid current data with the bundled fixture object', async () => {
  const resolved = await resolveSnapshot(
    kv({
      createdAt: 'not-a-date',
      market: { source: 'snapshot', asOf: '2025-06-30T00:00:00.000Z' },
      assets: [],
      wallets: {},
      swaps: [],
    }),
    now,
  );
  assert.equal(resolved.state, 'fixture');
  assert.strictEqual(resolved.snapshot, FIXTURE_SNAPSHOT);
});
