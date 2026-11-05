// CSVの変換処理。Excelで編集して保存し直したファイルも読み込めるようにする。
(function (global) {
  'use strict';

  const { logic } = global.Dunbar;

  const BOM = '﻿';
  const UNPLACED_LABEL = '未配置';
  const TAG_SEPARATOR = '、';
  const MAX_ROWS = 2000;

  const COLUMNS = [
    { key: 'name', header: '名前', alias: 'name' },
    { key: 'layer', header: '層', alias: 'layer' },
    { key: 'tags', header: 'タグ', alias: 'tags' },
    { key: 'lastContact', header: '最終連絡日', alias: 'lastcontact' },
    { key: 'memo', header: 'メモ', alias: 'memo' },
  ];

  // Excelが数式として解釈する文字で始まるセルは、先頭に ' を付けて書き出す。
  const FORMULA_START = /^'*[=+\-@\t\r]/;
  const GUARDED_START = /^'+[=+\-@\t\r]/;
  const DATE_PATTERN = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/;

  // ---- CSVの文字列 ----

  // 空行も1行として返す。行番号をExcelの行番号と揃えるため。閉じていない " があれば null を返す。
  function parseCsv(text) {
    const source = text.startsWith(BOM) ? text.slice(1) : text;
    const records = [];
    let record = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (inQuotes) {
        if (c !== '"') {
          field += c;
        } else if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (c === '"' && field === '') {
        inQuotes = true;
      } else if (c === ',') {
        record.push(field);
        field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && source[i + 1] === '\n') i++;
        record.push(field);
        records.push(record);
        record = [];
        field = '';
      } else {
        field += c;
      }
    }

    if (inQuotes) return null;
    if (field !== '' || record.length > 0) {
      record.push(field);
      records.push(record);
    }
    return records;
  }

  function quoteCell(cell) {
    return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  }

  function guardCell(cell) {
    return FORMULA_START.test(cell) ? `'${cell}` : cell;
  }

  function unguardCell(cell) {
    return GUARDED_START.test(cell) ? cell.slice(1) : cell;
  }

  // ---- 書き出し ----

  // ExcelがUTF-8と認識できるようBOMを付け、改行はCRLFにする。
  function friendsToCsv(friends) {
    const header = COLUMNS.map((column) => column.header);
    const rows = friends.map((friend) => {
      const layer = logic.layerById(friend.layer);
      return [
        guardCell(friend.name),
        layer ? layer.name : UNPLACED_LABEL,
        guardCell(friend.tags.join(TAG_SEPARATOR)),
        friend.lastContact || '',
        guardCell(friend.memo),
      ];
    });
    const lines = [header, ...rows].map((row) => row.map(quoteCell).join(','));
    return `${BOM}${lines.join('\r\n')}\r\n`;
  }

  // ---- 読み込み ----

  // WindowsのExcelで「CSV」として保存すると Shift_JIS になるので、UTF-8で読めなければそちらで読む。
  function decodeCsv(buffer) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      return new TextDecoder('shift_jis').decode(buffer);
    }
  }

  // 使えない値は undefined を返す。
  function parseLayerCell(cell) {
    const value = cell.trim();
    if (value === '' || value === UNPLACED_LABEL) return null;
    const layer = logic.LAYERS.find((l) => (
      value === l.name || value === String(l.id) || value === String(l.limit)
    ));
    return layer ? layer.id : undefined;
  }

  // Excelは日付を 2026/11/5 のように保存し直すので、区切りや桁数の違いを受け入れる。
  function parseDateCell(cell) {
    const value = cell.trim();
    if (value === '') return null;
    const match = DATE_PATTERN.exec(value);
    if (!match) return undefined;
    const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    return logic.parseDate(date) === null ? undefined : date;
  }

  function readHeader(record) {
    const columnIndex = {};
    const ignoredColumns = [];
    record.forEach((cell, index) => {
      const label = cell.trim();
      if (label === '') return;
      const column = COLUMNS.find((c) => label === c.header || label.toLowerCase() === c.alias);
      if (!column) ignoredColumns.push(label);
      else if (columnIndex[column.key] === undefined) columnIndex[column.key] = index;
    });
    return { columnIndex, ignoredColumns };
  }

  // 列がない項目や、行が途中で終わっている項目は fields に含めない(既存の値を保つ)。
  function readRow(record, columnIndex, rowNumber) {
    const cell = (key) => (columnIndex[key] === undefined ? undefined : record[columnIndex[key]]);
    const fields = {};
    const problems = [];

    const name = unguardCell(cell('name') || '').trim();
    if (name) fields.name = name;
    else problems.push('名前がありません');

    if (cell('layer') !== undefined) {
      const layer = parseLayerCell(cell('layer'));
      if (layer === undefined) problems.push(`層「${cell('layer').trim()}」が分かりません`);
      else fields.layer = layer;
    }
    if (cell('tags') !== undefined) fields.tags = logic.parseTags(unguardCell(cell('tags')));
    if (cell('lastContact') !== undefined) {
      const date = parseDateCell(cell('lastContact'));
      if (date === undefined) problems.push(`最終連絡日「${cell('lastContact').trim()}」が日付として読めません`);
      else fields.lastContact = date;
    }
    if (cell('memo') !== undefined) fields.memo = unguardCell(cell('memo')).replace(/\r\n?/g, '\n');

    return problems.length > 0
      ? { error: { row: rowNumber, message: problems.join('、') } }
      : { row: { row: rowNumber, fields } };
  }

  // 問題のある行はデータを勝手に変えないよう取り込まず、errors で知らせる。
  function parseFriendsCsv(text) {
    const result = { fatal: null, rows: [], errors: [], ignoredColumns: [] };
    const records = parseCsv(text);
    if (!records) {
      result.fatal = 'CSVの形式が正しくありません(ダブルクォートが閉じていません)。';
      return result;
    }
    if (records.length - 1 > MAX_ROWS) {
      result.fatal = `行数が多すぎます(上限は${MAX_ROWS}行です)。`;
      return result;
    }

    const isBlank = (record) => record.every((cell) => cell.trim() === '');
    const headerIndex = records.findIndex((record) => !isBlank(record));
    const { columnIndex, ignoredColumns } = headerIndex === -1 ? { columnIndex: {}, ignoredColumns: [] } : readHeader(records[headerIndex]);
    if (columnIndex.name === undefined) {
      result.fatal = '1行目に「名前」の列が見つかりません。';
      return result;
    }
    result.ignoredColumns = ignoredColumns;

    records.slice(headerIndex + 1).forEach((record, offset) => {
      if (isBlank(record)) return;
      const { row, error } = readRow(record, columnIndex, headerIndex + offset + 2);
      if (row) result.rows.push(row);
      else result.errors.push(error);
    });
    return result;
  }

  // ---- 取り込み ----

  function buildFriend(fields, makeId) {
    return { id: makeId(), name: fields.name, layer: null, tags: [], lastContact: null, memo: '', ...fields };
  }

  // 名前が同じ人を更新し、いなければ追加する。同姓同名は出てきた順に対応させるので、
  // 書き出したCSVをそのまま読み込んでも何も変わらない。CSVにない人は残す。
  function mergeFriends(existing, rows, makeId) {
    const queues = new Map();
    existing.forEach((friend) => {
      queues.set(friend.name, [...(queues.get(friend.name) || []), friend]);
    });

    const updates = new Map();
    const added = [];
    let unchanged = 0;
    rows.forEach(({ fields }) => {
      const queue = queues.get(fields.name);
      const target = queue && queue.shift();
      if (!target) {
        added.push(buildFriend(fields, makeId));
        return;
      }
      const next = { ...target, ...fields };
      if (JSON.stringify(next) === JSON.stringify(target)) unchanged++;
      else updates.set(target.id, next);
    });

    return {
      friends: [...existing.map((friend) => updates.get(friend.id) || friend), ...added],
      added: added.length,
      updated: updates.size,
      unchanged,
    };
  }

  function replaceFriends(rows, makeId) {
    return rows.map(({ fields }) => buildFriend(fields, makeId));
  }

  const csv = {
    parseCsv,
    friendsToCsv,
    decodeCsv,
    parseFriendsCsv,
    mergeFriends,
    replaceFriends,
  };

  global.Dunbar.csv = csv;
  if (typeof module !== 'undefined' && module.exports) module.exports = csv;
})(globalThis);
