'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/logic.js');
const csv = require('../js/csv.js');

const HEADER = '名前,層,タグ,最終連絡日,メモ';

function friend(id, name, extra = {}) {
  return { id, name, layer: null, tags: [], lastContact: null, memo: '', ...extra };
}

function idMaker(prefix = 'new') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function rowsOf(text) {
  const result = csv.parseFriendsCsv(text);
  assert.equal(result.fatal, null);
  assert.deepEqual(result.errors, []);
  return result.rows;
}

function withoutIds(friends) {
  return friends.map(({ id, ...rest }) => rest);
}

// ---- CSVの文字列 ----

test('カンマ、ダブルクォート、セル内の改行を読める', () => {
  assert.deepEqual(csv.parseCsv('a,"b,c","d""e","f\ng"\r\n'), [['a', 'b,c', 'd"e', 'f\ng']]);
});

test('改行は CRLF、LF、CR のどれでも読める', () => {
  assert.deepEqual(csv.parseCsv('a\r\nb\nc\rd'), [['a'], ['b'], ['c'], ['d']]);
});

test('末尾の空のセルを残し、BOMを取り除く', () => {
  assert.deepEqual(csv.parseCsv('﻿a,\n,b\n'), [['a', ''], ['', 'b']]);
});

test('閉じていないダブルクォートは null を返す', () => {
  assert.equal(csv.parseCsv('a,"b\n'), null);
});

// ---- 書き出し ----

test('BOM付き、CRLFで、層は名前で書き出す', () => {
  const text = csv.friendsToCsv([
    friend('a', '田中', { layer: 1, tags: ['大学', '趣味'], lastContact: '2026-11-05', memo: 'メモ' }),
    friend('b', '佐藤'),
  ]);
  assert.equal(text, `﻿${HEADER}\r\n田中,親友,大学、趣味,2026-11-05,メモ\r\n佐藤,未配置,,,\r\n`);
});

test('友達がいなくても列名だけ書き出す', () => {
  assert.equal(csv.friendsToCsv([]), `﻿${HEADER}\r\n`);
});

test('Excelが数式と解釈するセルには先頭に \' を付ける', () => {
  const text = csv.friendsToCsv([friend('a', '=1+1', { memo: '-メモ' })]);
  assert.ok(text.includes(`'=1+1,未配置,,,'-メモ`));
});

// ---- 書き出しと読み込みの往復 ----

test('書き出したCSVを読み込むと元のデータに戻る', () => {
  const friends = [
    friend('a', '田中, "太郎"', { layer: 1, tags: ['大学', '趣味'], lastContact: '2026-01-05', memo: '1行目\n2行目, "引用"' }),
    friend('b', '=危険', { layer: 2, tags: ['-タグ'], memo: "+メモ" }),
    friend('c', "'=元から付いている", { layer: 3, memo: "''-二重" }),
    friend('d', '😀', { layer: 4 }),
    friend('e', '未配置の人'),
  ];
  const bytes = Buffer.from(csv.friendsToCsv(friends), 'utf8');
  const rows = rowsOf(csv.decodeCsv(bytes));
  assert.deepEqual(withoutIds(csv.replaceFriends(rows, idMaker())), withoutIds(friends));
});

test('書き出したCSVをそのまま追加・更新で読み込んでも何も変わらない(同姓同名を含む)', () => {
  const friends = [
    friend('a', '田中', { layer: 1, memo: '1人目' }),
    friend('b', '佐藤', { layer: 2 }),
    friend('c', '田中', { layer: 4, memo: '2人目' }),
  ];
  const merged = csv.mergeFriends(friends, rowsOf(csv.friendsToCsv(friends)), idMaker());
  assert.deepEqual(merged.friends, friends);
  assert.deepEqual([merged.added, merged.updated, merged.unchanged], [0, 0, 3]);
});

// ---- 文字コード ----

test('ExcelのShift_JISのCSVを読める(日付の形式が変わっていても読める)', () => {
  const bytes = Buffer.from('96bc914f2c91772c8dc58f499841978d93fa0d0a9363928691be98592c906597462c323032362f31312f350d0a', 'hex');
  const rows = rowsOf(csv.decodeCsv(bytes));
  assert.deepEqual(rows[0].fields, { name: '田中太郎', layer: 1, lastContact: '2026-11-05' });
});

// ---- 値の読み取り ----

[
  ['2026-11-05', '2026-11-05'],
  ['2026/11/5', '2026-11-05'],
  ['2026/1/5', '2026-01-05'],
  ['2026.1.5', '2026-01-05'],
  ['2026年11月5日', '2026-11-05'],
  [' 2026-11-05 ', '2026-11-05'],
  ['', null],
].forEach(([cell, expected]) => {
  test(`最終連絡日「${cell}」は ${expected} になる`, () => {
    const [row] = rowsOf(`名前,最終連絡日\nA,${cell}\n`);
    assert.equal(row.fields.lastContact, expected);
  });
});

['2026-13-01', '2026/2/31', '明日', '11/5', '20261105'].forEach((cell) => {
  test(`最終連絡日「${cell}」はエラーになり、その行は取り込まれない`, () => {
    const result = csv.parseFriendsCsv(`名前,最終連絡日\nA,${cell}\nB,\n`);
    assert.deepEqual(result.errors.map((e) => e.row), [2]);
    assert.ok(result.errors[0].message.includes(cell));
    assert.deepEqual(result.rows.map((r) => r.fields.name), ['B']);
  });
});

[
  ['親友', 1], ['親しい仲間', 2], ['友人', 3], ['友達・知人', 4],
  ['1', 1], ['4', 4], ['5', 1], ['15', 2], ['50', 3], ['150', 4],
  ['未配置', null], ['', null], [' 親友 ', 1],
].forEach(([cell, expected]) => {
  test(`層「${cell}」は ${expected} になる`, () => {
    assert.equal(rowsOf(`名前,層\nA,${cell}\n`)[0].fields.layer, expected);
  });
});

test('分からない層はエラーになる', () => {
  const result = csv.parseFriendsCsv('名前,層\nA,家族\n');
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors[0].row, 2);
  assert.ok(result.errors[0].message.includes('家族'));
});

test('タグは区切りを問わず読み、セル内のカンマも区切りとして扱う', () => {
  assert.deepEqual(rowsOf('名前,タグ\nA,"大学、趣味,地元"\n')[0].fields.tags, ['大学', '趣味', '地元']);
});

test('メモの改行は LF にそろえ、名前の前後の空白は取り除く', () => {
  const [row] = rowsOf('名前,メモ\n  田中  ,"a\r\nb"\n');
  assert.equal(row.fields.name, '田中');
  assert.equal(row.fields.memo, 'a\nb');
});

// ---- 列名と行 ----

test('列の順番が違っても、英語の列名でも読める', () => {
  const [row] = rowsOf('memo,NAME,Layer\nメモ,田中,親友\n');
  assert.deepEqual(row.fields, { memo: 'メモ', name: '田中', layer: 1 });
});

test('知らない列は無視して、列名を知らせる', () => {
  const result = csv.parseFriendsCsv('名前,電話番号,,住所\nA,090,,東京\n');
  assert.deepEqual(result.ignoredColumns, ['電話番号', '住所']);
  assert.deepEqual(result.rows[0].fields, { name: 'A' });
});

test('名前の列がなければ読み込めない', () => {
  for (const text of ['層,メモ\n親友,x\n', '', '\n\n', '田中,親友\n']) {
    const result = csv.parseFriendsCsv(text);
    assert.ok(result.fatal, JSON.stringify(text));
    assert.deepEqual(result.rows, []);
  }
});

test('形式の壊れたCSVは読み込めない', () => {
  assert.ok(csv.parseFriendsCsv('名前\n"田中\n').fatal);
});

test('列名だけのCSVは0人として読める', () => {
  const result = csv.parseFriendsCsv(`﻿${HEADER}\r\n`);
  assert.equal(result.fatal, null);
  assert.deepEqual(result.rows, []);
});

test('行数の上限を超えると読み込めない', () => {
  const rows = (n) => `名前\n${'A\n'.repeat(n)}`;
  assert.equal(csv.parseFriendsCsv(rows(2000)).rows.length, 2000);
  assert.ok(csv.parseFriendsCsv(rows(2001)).fatal);
});

test('空の行は飛ばし、エラーの行番号はExcelの行番号に合わせる', () => {
  const text = '名前,メモ\nA,"2行に\nまたがる"\n\n,,\n,メモだけ\nB,\n';
  const result = csv.parseFriendsCsv(text);
  assert.deepEqual(result.errors, [{ row: 5, message: '名前がありません' }]);
  assert.deepEqual(result.rows.map((r) => [r.row, r.fields.name]), [[2, 'A'], [6, 'B']]);
});

test('先頭に空行があっても、そこを列名の行とはみなさない', () => {
  const result = csv.parseFriendsCsv('\n名前\nA\n,\n=\n');
  assert.equal(result.fatal, null);
  assert.deepEqual(result.rows.map((r) => r.row), [3, 5]);
});

// ---- 追加・更新 ----

test('同じ名前の人は更新してIDを保ち、いない人は追加し、CSVにない人は残す', () => {
  const existing = [
    friend('a', '田中', { layer: 1, memo: '古い' }),
    friend('b', '残る人', { layer: 3 }),
  ];
  const rows = rowsOf('名前,層,メモ\n田中,友人,新しい\n新規,親友,\n');
  const merged = csv.mergeFriends(existing, rows, idMaker());
  assert.deepEqual(merged.friends, [
    friend('a', '田中', { layer: 3, memo: '新しい' }),
    friend('b', '残る人', { layer: 3 }),
    friend('new-1', '新規', { layer: 1 }),
  ]);
  assert.deepEqual([merged.added, merged.updated, merged.unchanged], [1, 1, 0]);
});

test('CSVにない列の値は保つ', () => {
  const existing = [friend('a', '田中', { layer: 1, tags: ['大学'], lastContact: '2026-01-01', memo: 'x' })];
  const merged = csv.mergeFriends(existing, rowsOf('名前,層\n田中,友人\n'), idMaker());
  assert.deepEqual(merged.friends, [friend('a', '田中', { layer: 3, tags: ['大学'], lastContact: '2026-01-01', memo: 'x' })]);
});

test('列があってセルが空なら、値を消す', () => {
  const existing = [friend('a', '田中', { layer: 1, tags: ['大学'], lastContact: '2026-01-01', memo: 'x' })];
  const merged = csv.mergeFriends(existing, rowsOf(`${HEADER}\n田中,,,,\n`), idMaker());
  assert.deepEqual(merged.friends, [friend('a', '田中')]);
});

test('行が途中で終わっていれば、足りないセルの値は保つ', () => {
  const existing = [friend('a', '田中', { layer: 1, memo: 'x' })];
  const merged = csv.mergeFriends(existing, rowsOf(`${HEADER}\n田中\n`), idMaker());
  assert.deepEqual(merged.friends, existing);
  assert.equal(merged.unchanged, 1);
});

test('CSVの同姓同名が既存より多ければ、多い分は追加する', () => {
  const existing = [friend('a', '田中', { memo: '既存' })];
  const merged = csv.mergeFriends(existing, rowsOf('名前,メモ\n田中,1\n田中,2\n'), idMaker());
  assert.deepEqual(merged.friends, [friend('a', '田中', { memo: '1' }), friend('new-1', '田中', { memo: '2' })]);
});

test('元のデータの配列は変更しない', () => {
  const existing = [friend('a', '田中', { memo: '元' })];
  const snapshot = JSON.stringify(existing);
  csv.mergeFriends(existing, rowsOf('名前,メモ\n田中,新\n'), idMaker());
  assert.equal(JSON.stringify(existing), snapshot);
});

test('新規の人も、保存データと同じ項目の順番で作る', () => {
  const [created] = csv.replaceFriends(rowsOf('タグ,名前\n大学,田中\n'), idMaker());
  assert.deepEqual(Object.keys(created), ['id', 'name', 'layer', 'tags', 'lastContact', 'memo']);
});

// ---- 置き換え ----

test('置き換えでは、CSVにない項目は既定値になり、IDは新しくなる', () => {
  const friends = csv.replaceFriends(rowsOf('名前,層\n田中,親友\n'), idMaker());
  assert.deepEqual(friends, [friend('new-1', '田中', { layer: 1 })]);
});
