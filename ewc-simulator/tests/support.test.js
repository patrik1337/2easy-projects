import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateData, diffJson } from '../js/validate.js';
import { decodeSession, encodeSession, defaultSession, setOverride, deepFreeze } from '../js/state.js';
import { investmentMetrics } from '../js/investment.js';
import { buildEngineInput, actualPositions } from '../js/calibration.js';
import { compileModel, evaluateActual, simulate } from '../js/engine.js';
import { createRng } from '../js/rng.js';

globalThis.btoa ??= s => Buffer.from(s, 'binary').toString('base64');
globalThis.atob ??= s => Buffer.from(s, 'base64').toString('binary');

const raw = readFileSync(new URL('../data.json', import.meta.url), 'utf8');
const data = JSON.parse(raw);

describe('data.json', () => {
  test('admin export format round-trips byte-for-byte with the extractor output', () => {
    assert.equal(JSON.stringify(JSON.parse(raw), null, 1) + '\n', raw);
  });
  test('defaults stay immutable once loaded', () => {
    const frozen = deepFreeze(structuredClone(data));
    assert.throws(() => { 'use strict'; frozen.titles[0].entries[0].seed = 99; });
  });
});

describe('admin validation', () => {
  test('the committed data validates', () => {
    const v = validateData(data);
    assert.deepEqual(v.errors, []);
    assert.equal(v.reconciled, 154);
  });
  test('refuses a change that breaks reconciliation', () => {
    const w = structuredClone(data);
    const cs2 = w.titles.find(t => t.id === 'cs2');
    cs2.entries[0].placement = '2'; cs2.entries[0].placeFrom = 2; cs2.entries[0].placeTo = 2;
    const v = validateData(w);
    assert.ok(!v.ok);
    assert.ok(v.errors.some(e => e.area === 'reconciliation' && e.msg.startsWith('Team Spirit')));
  });
  test('refuses orphaned canonical names and missing seeds', () => {
    const w = structuredClone(data);
    w.titles.find(t => t.id === 'cs2').entries[3].canonical = 'Nobody Esports';
    w.titles.find(t => t.id === 'val').entries[2].seed = null;
    w.titles.find(t => t.id === 'lol').entries[1].cohort = null;
    const msgs = validateData(w).errors.map(e => e.msg).join('\n');
    assert.match(msgs, /Nobody Esports.*orphaned/);
    assert.match(msgs, /Seed missing: val/);
    assert.match(msgs, /Seed missing: lol/);
  });
  test('diff lists changed leaves', () => {
    const w = structuredClone(data);
    w.calibration.approved.chess = { tvi: 8, note: '' };
    assert.deepEqual(diffJson(data, w).map(d => d.path), ['calibration.approved.chess']);
  });
});

describe('session state', () => {
  test('URL round-trip keeps overrides and drops defaults', () => {
    let s = defaultSession(data);
    s = setOverride(data, s, 'a', 'cs2', { tvi: 30 });
    s = setOverride(data, s, 'a', 'chess', { method: 'random' });
    s = setOverride(data, s, 'a', 'val', { tvi: 50 });            // equals the provisional default -> dropped
    s = { ...s, runs: 5000, compare: true };
    s = setOverride(data, s, 'b', 'lol', { tierTable: { High: 5 } });
    const back = decodeSession(data, '#' + encodeSession(data, s));
    assert.deepEqual(back.sets.a, { cs2: { tvi: 30 }, chess: { method: 'random' } });
    assert.deepEqual(back.sets.b, { lol: { tierTable: { High: 5, Medium: 1, Low: 0.4 } } });
    assert.equal(back.runs, 5000);
    assert.equal(encodeSession(data, defaultSession(data)), '');
  });
  test('garbage in the URL falls back to defaults', () => {
    assert.deepEqual(decodeSession(data, '#s=%%%not-base64'), defaultSession(data));
  });
});

describe('investment layer', () => {
  test('is optional and derives cost per point with its confidence', () => {
    const { input, clubIndex } = buildEngineInput(data);
    const model = compileModel(input);
    const actual = evaluateActual(model, actualPositions(data));
    const res = simulate(model, { runs: 300, rng: createRng(3) });
    assert.deepEqual(investmentMetrics({ ...data, investment: [] }, res, actual, clubIndex), []);
    const withInv = { ...data, investment: [{ club: 'Team Falcons', annualSpend: 46000000, currency: 'USD', confidence: 'low', source: 'test' }] };
    const [row] = investmentMetrics(withInv, res, actual, clubIndex);
    assert.equal(row.confidence, 'low');
    assert.equal(row.costPerPointActual, 46000000 / 4600);
    assert.ok(row.costPerPointSim.p10 <= row.costPerPointSim.median && row.costPerPointSim.median <= row.costPerPointSim.p90);
  });
});
