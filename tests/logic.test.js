'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../js/logic.js');
const { createStore, KEY, CORRUPT_KEY } = require('../js/store.js');

function friend(id, layer, extra = {}) {
  return { id: String(id), name: `友達${id}`, layer, tags: [], lastContact: null, memo: '', ...extra };
}

function many(count, layer, startId = 0) {
  return Array.from({ length: count }, (_, i) => friend(startId + i, layer));
}

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
  };
}

// ---- 人数 ----

test('人数は内側の層を含めて累計する', () => {
  const counts = logic.layerCounts([...many(3, 1), ...many(4, 2, 10), ...many(2, 4, 20), friend(99, null)]);
  assert.deepEqual(counts.map((c) => c.own), [3, 4, 0, 2]);
  assert.deepEqual(counts.map((c) => c.cumulative), [3, 7, 7, 9]);
});

test('超過は上限ちょうどでは出ず、1人超えると出る', () => {
  assert.equal(logic.layerCounts(many(5, 1))[0].over, 0);
  assert.equal(logic.layerCounts(many(6, 1))[0].over, 1);
});

test('内側の超過は、外側の上限に収まっていれば外側の超過にならない', () => {
  const counts = logic.layerCounts([...many(7, 1), ...many(8, 2, 10)]);
  assert.equal(counts[0].over, 2);
  assert.equal(counts[1].over, 0);
});

// ---- 日付 ----

test('存在しない日付や不正な形式は拒否する', () => {
  assert.equal(logic.parseDate('2026-02-31'), null);
  assert.equal(logic.parseDate('2026-13-01'), null);
  assert.equal(logic.parseDate('2026/01/01'), null);
  assert.equal(logic.parseDate(null), null);
  assert.notEqual(logic.parseDate('2028-02-29'), null);
});

test('日数の計算は月と年をまたいでも正しい', () => {
  assert.equal(logic.daysSince('2026-10-31', '2026-11-05'), 5);
  assert.equal(logic.daysSince('2025-12-31', '2026-01-01'), 1);
  assert.equal(logic.daysSince('2026-11-05', '2026-11-05'), 0);
});

test('今日の日付はタイムゾーンでずれない(日本時間の早朝でもUTCの前日にならない)', () => {
  const original = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  try {
    assert.equal(new Date('2026-11-04T15:30:00Z').getHours(), 0, '前提: TZの切り替えが効いていること');
    assert.equal(logic.todayString(new Date('2026-11-04T15:30:00Z')), '2026-11-05');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

// ---- 疎遠判定 ----

test('疎遠は目安ちょうどでは出ず、1日超えると出る', () => {
  const today = '2026-11-15';
  assert.equal(logic.staleInfo(friend(1, 1, { lastContact: '2026-11-08' }), today).status, 'ok');
  const over = logic.staleInfo(friend(1, 1, { lastContact: '2026-11-07' }), today);
  assert.equal(over.status, 'stale');
  assert.equal(over.overdue, 1);
});

test('目安は層ごとに異なる', () => {
  const lastContact = '2026-10-01';
  const today = '2026-11-15';
  assert.equal(logic.staleInfo(friend(1, 1, { lastContact }), today).status, 'stale');
  assert.equal(logic.staleInfo(friend(1, 2, { lastContact }), today).status, 'stale');
  assert.equal(logic.staleInfo(friend(1, 3, { lastContact }), today).status, 'ok');
  assert.equal(logic.staleInfo(friend(1, 4, { lastContact }), today).status, 'ok');
});

test('未記録の人、未配置の人、未来の日付はアラートにならない', () => {
  const today = '2026-11-15';
  assert.equal(logic.staleInfo(friend(1, 1), today).status, 'unrecorded');
  assert.equal(logic.staleInfo(friend(1, null, { lastContact: '2000-01-01' }), today).status, 'ok');
  assert.equal(logic.staleInfo(friend(1, 1, { lastContact: '2026-12-01' }), today).status, 'ok');
});

test('疎遠リストは超過日数が大きい順に並ぶ', () => {
  const today = '2026-11-15';
  const list = logic.staleList([
    friend('a', 1, { lastContact: '2026-11-01' }),
    friend('b', 1, { lastContact: '2026-10-01' }),
    friend('c', 1, { lastContact: '2026-11-14' }),
  ], today);
  assert.deepEqual(list.map((e) => e.friend.id), ['b', 'a']);
});

// ---- 半径と層 ----

test('半径から層への変換は各円の境界で正しく、外側は未配置になる', () => {
  assert.equal(logic.radiusToLayer(0), 1);
  logic.LAYERS.forEach((layer, index) => {
    assert.equal(logic.radiusToLayer(layer.outer), layer.id);
    const next = logic.LAYERS[index + 1];
    assert.equal(logic.radiusToLayer(layer.outer + 0.01), next ? next.id : null);
  });
});

// ---- 配置 ----

function assertNoOverlap(friends, layout) {
  const ids = friends.map((f) => f.id);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = layout[ids[i]];
      const b = layout[ids[j]];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      assert.ok(distance >= a.r + b.r, `${ids[i]} と ${ids[j]} が重なっている(距離 ${distance.toFixed(1)})`);
    }
  }
}

test('150人を上限どおりに配置しても重ならず、各自の円に収まる', () => {
  const friends = [...many(5, 1), ...many(10, 2, 100), ...many(35, 3, 200), ...many(100, 4, 300)];
  const layout = logic.computeLayout(friends);
  assert.equal(Object.keys(layout).length, 150);
  assertNoOverlap(friends, layout);
  friends.forEach((f) => {
    const { x, y, r } = layout[f.id];
    const layer = logic.layerById(f.layer);
    const radius = Math.hypot(x, y);
    assert.ok(radius - r >= layer.inner, `${f.id} が内側にはみ出している`);
    assert.ok(radius + r <= layer.outer, `${f.id} が外側にはみ出している`);
  });
});

test('上限まではどの人数でも元のアイコンサイズのまま重ならない', () => {
  logic.LAYERS.forEach((layer, index) => {
    const previous = index === 0 ? 0 : logic.LAYERS[index - 1].limit;
    for (let n = 1; n <= layer.limit - previous; n++) {
      const friends = many(n, layer.id);
      const layout = logic.computeLayout(friends);
      assertNoOverlap(friends, layout);
      assert.equal(layout['0'].r, layer.nodeRadius, `層${layer.id}の${n}人でアイコンが縮小された`);
    }
  });
});

test('上限を少し超えた場合は、アイコンを縮小して重ならないように配置する', () => {
  const friends = many(12, 1);
  const layout = logic.computeLayout(friends);
  assert.ok(layout['0'].r < logic.LAYERS[0].nodeRadius);
  assertNoOverlap(friends, layout);
});

test('上限を大幅に超えても壊れない', () => {
  [[300, 1], [1000, 2], [3000, 4]].forEach(([n, layer]) => {
    const layout = logic.computeLayout(many(n, layer));
    assert.equal(Object.keys(layout).length, n);
    Object.values(layout).forEach((p) => {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && p.r > 0);
    });
  });
});

test('上限の人数でも、アイコンと名前は元の大きさのまま', () => {
  const friends = [...many(5, 1), ...many(10, 2, 100), ...many(35, 3, 200), ...many(100, 4, 300)];
  const layout = logic.computeLayout(friends);
  friends.forEach((f) => {
    assert.equal(layout[f.id].r, logic.layerById(f.layer).nodeRadius, f.id);
    assert.equal(layout[f.id].fontSize, 16, f.id);
  });
});

test('名前は円の外側に向けて出す', () => {
  const friends = many(35, 3);
  const layout = logic.computeLayout(friends);
  friends.forEach((f) => {
    const { y, labelY } = layout[f.id];
    assert.ok(Math.abs(y + labelY) > Math.abs(y), `${f.id} の名前が内側に出ている`);
  });
});

test('上限を超えてアイコンが縮むと、名前も同じ割合で縮む', () => {
  const { r, fontSize } = logic.computeLayout(many(12, 1))['0'];
  assert.ok(r < logic.LAYERS[0].nodeRadius);
  assert.equal(fontSize / 16, r / logic.LAYERS[0].nodeRadius);
});

test('未配置の人はマップに含めない', () => {
  assert.deepEqual(logic.computeLayout([friend(1, null)]), {});
});

test('同じタグの人は同じ方角に集まる', () => {
  const friends = [
    ...Array.from({ length: 6 }, (_, i) => friend(`a${i}`, 3, { tags: ['大学'] })),
    ...Array.from({ length: 6 }, (_, i) => friend(`b${i}`, 3, { tags: ['職場'] })),
  ];
  const layout = logic.computeLayout(friends);
  const centroid = (prefix) => {
    const points = friends.filter((f) => f.id.startsWith(prefix)).map((f) => layout[f.id]);
    return {
      x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    };
  };
  const a = centroid('a');
  const b = centroid('b');
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 200, '2つのタグが離れて配置されていない');
});

test('配置は入力の順序に左右されない', () => {
  const friends = [friend('x', 2, { tags: ['A'] }), friend('y', 2), friend('z', 2, { tags: ['B'] })];
  assert.deepEqual(logic.computeLayout(friends), logic.computeLayout([...friends].reverse()));
});

// ---- タグ・表示名 ----

test('タグは半角・全角の区切りで分割し、空と重複を除く', () => {
  assert.deepEqual(logic.parseTags('大学, 職場、大学,,  趣味 ,，地元'), ['大学', '職場', '趣味', '地元']);
  assert.deepEqual(logic.parseTags(''), []);
});

test('タグの色は登場順に割り当てられ、タグを足しても既存の色は変わらない', () => {
  const before = logic.tagColorMap([friend(1, 1, { tags: ['A', 'B'] })]);
  const after = logic.tagColorMap([friend(1, 1, { tags: ['A', 'B'] }), friend(2, 1, { tags: ['C'] })]);
  assert.notEqual(before.A, before.B);
  assert.equal(after.A, before.A);
  assert.equal(after.B, before.B);
});

test('頭文字はサロゲートペアを分割しない', () => {
  assert.equal(logic.initial('😀さん'), '😀');
  assert.equal(logic.initial(' 田中'), '田');
  assert.equal(logic.initial('alice'), 'A');
});

test('長い名前は、幅に収まるように省略する', () => {
  assert.equal(logic.fitName('田中太郎', 4), '田中太郎');
  assert.equal(logic.fitName('田中太郎', 3.5), '田中…');
  assert.equal(logic.fitName('寿限無寿限無五劫', 6), '寿限無寿限…');
  assert.equal(logic.fitName('😀😀😀😀', 3), '😀😀…');
  assert.equal(logic.fitName('寿限無寿限無五劫'), '寿限無寿限…');
});

test('英数字は全角より細いものとして数える', () => {
  assert.equal(logic.fitName('Tanaka', 4), 'Tanaka');
  assert.equal(logic.fitName('Alexander Smith', 4), 'Alexa…');
});

// ---- 保存 ----

test('保存したデータを読み込める', () => {
  const storage = fakeStorage();
  const store = createStore(() => storage);
  const friends = [friend(1, 1, { tags: ['大学'], lastContact: '2026-11-01', memo: 'メモ' })];
  assert.equal(store.save(friends), true);
  const loaded = createStore(() => storage).load();
  assert.deepEqual(loaded.friends, friends);
  assert.equal(loaded.notice, null);
});

test('データがなければ空で始まる', () => {
  const loaded = createStore(() => fakeStorage()).load();
  assert.deepEqual(loaded.friends, []);
  assert.equal(loaded.notice, null);
});

['{壊れたJSON', 'null', '{"version":1}', '{"version":99,"friends":[]}', '{"version":1,"friends":[{"name":"IDなし"}]}',
  '{"version":1,"friends":[{"id":"a","name":"A"},{"id":"a","name":"B"}]}'].forEach((raw) => {
  test(`壊れたデータは退避して通知する: ${raw}`, () => {
    const storage = fakeStorage({ [KEY]: raw });
    const store = createStore(() => storage);
    const loaded = store.load();
    assert.deepEqual(loaded.friends, []);
    assert.ok(loaded.notice);
    assert.equal(storage.getItem(CORRUPT_KEY), raw);
  });
});

test('項目単位の不正な値は既定値に直す', () => {
  const raw = JSON.stringify({
    version: 1,
    friends: [{ id: 'a', name: 'A', layer: 9, tags: 'x', lastContact: '2026-99-99', memo: 1 }],
  });
  const loaded = createStore(() => fakeStorage({ [KEY]: raw })).load();
  assert.deepEqual(loaded.friends, [{ id: 'a', name: 'A', layer: null, tags: [], lastContact: null, memo: '' }]);
});

test('退避に失敗したら、元のデータを上書きしないよう保存を止める', () => {
  const storage = fakeStorage({ [KEY]: '{壊れたJSON' });
  storage.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  const store = createStore(() => storage);
  assert.ok(store.load().notice);
  assert.equal(store.save([friend(1, 1)]), false);
  assert.equal(storage.getItem(KEY), '{壊れたJSON');
});

test('保存領域にアクセスできなくても例外を投げず、通知する', () => {
  const store = createStore(() => {
    throw new Error('SecurityError');
  });
  const loaded = store.load();
  assert.deepEqual(loaded.friends, []);
  assert.ok(loaded.notice);
  assert.equal(store.save([]), false);
});

test('保存の失敗は false で分かる', () => {
  const storage = fakeStorage();
  storage.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  assert.equal(createStore(() => storage).save([]), false);
});
