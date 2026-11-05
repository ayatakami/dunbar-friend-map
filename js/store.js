// localStorage への保存と読み込み。壊れたデータは上書きせず退避する。
(function (global) {
  'use strict';

  const KEY = 'dunbar.v1';
  const CORRUPT_KEY = 'dunbar.v1.corrupt';
  const VERSION = 1;

  function normalizeFriend(raw) {
    const { logic } = global.Dunbar;
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
    return {
      id: raw.id,
      name: raw.name,
      layer: logic.layerById(raw.layer) ? raw.layer : null,
      tags: Array.isArray(raw.tags) ? logic.parseTags(raw.tags.filter((t) => typeof t === 'string').join(',')) : [],
      lastContact: logic.parseDate(raw.lastContact) !== null ? raw.lastContact : null,
      memo: typeof raw.memo === 'string' ? raw.memo : '',
    };
  }

  // 読み込めないデータは null を返す。一部だけ捨てて保存し直すとデータを失うため、全体を不正として扱う。
  function parseFriends(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!data || data.version !== VERSION || !Array.isArray(data.friends)) return null;
    const friends = data.friends.map(normalizeFriend);
    if (friends.includes(null)) return null;
    if (new Set(friends.map((f) => f.id)).size !== friends.length) return null;
    return friends;
  }

  function createStore(getStorage) {
    let writable = true;

    function load() {
      let storage;
      let raw;
      try {
        storage = getStorage();
        raw = storage.getItem(KEY);
      } catch {
        writable = false;
        return {
          friends: [],
          notice: 'ブラウザの設定により保存領域を使えません。このままでは、閉じると入力内容が失われます。',
        };
      }
      if (raw === null) return { friends: [], notice: null };

      const friends = parseFriends(raw);
      if (friends) return { friends, notice: null };

      try {
        storage.setItem(CORRUPT_KEY, raw);
      } catch {
        writable = false;
        return {
          friends: [],
          notice: '保存データを読み込めず、退避もできませんでした。元のデータを守るため、保存を停止しています。',
        };
      }
      return {
        friends: [],
        notice: `保存データを読み込めなかったため、空の状態で開始しました。元のデータは ${CORRUPT_KEY} に退避しています。`,
      };
    }

    function save(friends) {
      if (!writable) return false;
      try {
        getStorage().setItem(KEY, JSON.stringify({ version: VERSION, friends }));
        return true;
      } catch {
        return false;
      }
    }

    return { load, save, KEY };
  }

  global.Dunbar = global.Dunbar || {};
  global.Dunbar.createStore = createStore;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createStore, KEY, CORRUPT_KEY };
})(globalThis);
