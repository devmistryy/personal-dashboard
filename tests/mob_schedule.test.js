// Run: node tests/mob_schedule.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const el = { addEventListener() {}, classList: { contains: () => false } };
const _localDateStr = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const ctx = { document: { getElementById: () => el, querySelector: () => el, querySelectorAll: () => [], addEventListener() {} },
  ResizeObserver: class { observe() {} }, MEM: {}, console, _localDateStr,
  _shiftDay: (ds, n) => { const [y, m, d] = ds.split('-').map(Number); return _localDateStr(new Date(y, m - 1, d + n)); } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/mobility.js'), 'utf8'), ctx);
const { _mobSimulate, _mobBaseDays, _mobSpacing, _shiftDay } = ctx;
// One unit on its own (no load cap).
const _mobDueDates = (f, off, from, to, logged, today) => _mobSimulate([{ f, off, from, logged, tod: 'morning', n: 1 }], to, today)[0];

const MON = '2026-09-07';   // a Monday
const day = i => _shiftDay(MON, i);
// Replay `weeks` weeks one day at a time: each day, look at what's due given the
// log so far and do it unless that day is in `skip`. Returns the day indexes done.
function play(f, off, weeks, skip = []) {
  const logged = new Set(), done = [];
  for (let i = 0; i < weeks * 7; i++) {
    const { due } = _mobDueDates(f, off, MON, day(i), logged, day(i));
    if (due.has(day(i)) && !skip.includes(i)) { logged.add(day(i)); done.push(i); }
  }
  return done;
}
const runs = done => { let r = 1, max = 1; for (let i = 1; i < done.length; i++) { r = done[i] === done[i - 1] + 1 ? r + 1 : 1; max = Math.max(max, r); } return max; };
const gaps = done => done.slice(1).map((d, i) => d - done[i]);

// Spacing comes from each frequency's own pattern.
assert.deepStrictEqual(JSON.parse(JSON.stringify([1, 2, 3, 4, 5, 6].map(_mobSpacing))), [
  { minGap: 5, maxRun: 1 }, { minGap: 3, maxRun: 1 }, { minGap: 2, maxRun: 1 },
  { minGap: 1, maxRun: 2 }, { minGap: 1, maxRun: 3 }, { minGap: 1, maxRun: 6 }]);
assert.strictEqual(_mobSpacing(7).maxRun, Infinity);

// Perfect adherence lands exactly on the template days, for every frequency and offset.
for (let f = 1; f <= 7; f++) for (let off = 0; off < 7; off++) {
  const want = [];
  for (let w = 0; w < 4; w++) _mobBaseDays(f).forEach(b => want.push(w * 7 + (b + off) % 7));
  assert.deepStrictEqual(play(f, off, 4), want.sort((a, b) => a - b), `f=${f} off=${off}`);
}

// 3×/wk on Mon/Wed/Fri (off 5 puts base days Wed/Fri/Sun on Mon/Wed/Fri), skipping Wednesday:
// Thursday picks it up, Friday waits a day for the rest gap, then Saturday, then Monday.
assert.deepStrictEqual([..._mobBaseDays(3)].map(b => (b + 5) % 7), [0, 2, 4]);
const three = play(3, 5, 3, [2]);
assert.deepStrictEqual(three.slice(0, 4), [0, 3, 5, 7]);
assert.ok(gaps(three).every(g => g >= 2), 'always a rest day between');
assert.strictEqual(three.filter(i => i < 14).length, 6, '6 in 2 weeks despite the miss');

// 4×/wk, one miss: never three days in a row, and back to 8 in 2 weeks.
for (let off = 0; off < 7; off++) for (const miss of _mobBaseDays(4).map(b => (b + off) % 7)) {
  const four = play(4, off, 4, [miss]);
  assert.ok(runs(four) <= 2, `f=4 off=${off} miss=${miss}: ${four}`);
  const by = n => four.filter(i => i < n).length;
  assert.ok(by(14) === 8 && by(21) === 12, `f=4 off=${off} miss=${miss} catches up: ${four}`);
}

// A whole week missed: the backlog is capped at one week, so it doesn't snowball.
const off3 = play(3, 0, 6, [0, 1, 2, 3, 4, 5, 6]);
assert.ok(gaps(off3).every(g => g >= 2));
assert.ok(off3.length <= 18 && off3.length >= 15, `${off3.length}`);

// The future is projected as if each due session gets done; logging today doesn't change today.
const logged = new Set([day(0)]);
const proj = [..._mobDueDates(3, 5, MON, day(13), logged, day(0)).due];
assert.deepStrictEqual(proj, [0, 2, 4, 7, 9, 11].map(day));

// A missed session waiting for its turn isn't a new miss each day it waits:
// 3×/wk with nothing done for 2 weeks is 6 misses, not one per day.
const idle = _mobDueDates(3, 0, MON, day(13), new Set(), day(14));
assert.strictEqual(idle.due.size - idle.carried.size, 6);
// On track, nothing is ever a carry-over.
assert.strictEqual(_mobDueDates(3, 0, MON, day(13), new Set([2, 4, 6, 9, 11, 13].map(day)), day(14)).carried.size, 0);

// Units that fall behind together spread out instead of moving in lockstep:
// catch-up never pushes a day more than one past the template's heaviest day, and
// every unit still gets its 3 a week.
const offs = [0, 1, 2, 3, 4, 5];
const tmpl = new Array(7).fill(0);
offs.forEach(o => _mobBaseDays(3).forEach(b => tmpl[(b + o) % 7]++));
const cap = Math.max(...tmpl);
const sim = _mobSimulate(offs.map(off => ({ f: 3, off, from: MON, logged: new Set(), tod: 'morning', n: 1 })),
  day(27), day(7), { morning: cap, night: Infinity });
for (let i = 7; i < 28; i++) assert.ok(sim.filter(r => r.due.has(day(i))).length <= cap + 1, `day ${i} over cap`);
sim.forEach(r => assert.ok([...r.due].filter(d => d >= day(7)).length >= 9, 'each unit keeps 3×/wk'));

// A single exercise's make-up may go one over the cap: 5×/wk on Sat/Sun/Tue/Wed/Thu
// (off 4), added on a Wednesday, missed it, done Thursday. Friday is a rest day, so
// it's the make-up — it fits onto a 6-exercise night with a cap of 6, not 5.
const WED = day(2), filler = { f: 7, off: 0, from: WED, logged: new Set(), tod: 'night', n: 6 };
const hero = { f: 5, off: 4, from: WED, logged: new Set([day(3)]), tod: 'night', n: 1 };
assert.ok(_mobSimulate([filler, hero], day(6), day(5), { morning: Infinity, night: 6 })[1].due.has(day(4)), 'one over is fine');
const held = _mobSimulate([filler, hero], day(6), day(5), { morning: Infinity, night: 5 })[1];
assert.ok(!held.due.has(day(4)), 'two over waits');
assert.ok(held.spare.has(day(4)), '...and is offered as an optional make-up instead');

// Archived from a day (`until`): its days before that stay as they were, none from then on.
const whole = _mobSimulate([{ f: 3, off: 0, from: MON, logged: new Set(), tod: 'morning', n: 1 }], day(20), day(21))[0];
const cut = _mobSimulate([{ f: 3, off: 0, from: MON, until: day(10), logged: new Set(), tod: 'morning', n: 1 }], day(20), day(21))[0];
assert.deepStrictEqual([...cut.due], [...whole.due].filter(d => d < day(10)));
assert.strictEqual(_mobSimulate([{ f: 3, off: 0, from: MON, until: MON, logged: new Set(), tod: 'morning', n: 1 }], day(20), day(21))[0].due.size, 0,
  'archived the day it was added: never due');

console.log('mob_schedule ok');
