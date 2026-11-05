// 状態の管理と初期化。状態を変えたら必ず保存して描画し直す。
(function (global) {
  'use strict';

  const { logic, createStore, createMap, createUI, createCsvPanel } = global.Dunbar;
  const SAVE_FAILED_NOTICE = '保存に失敗しました。今の変更は、ブラウザを閉じると失われます。ブラウザの設定や保存容量を確認してください。';

  const store = createStore(() => global.localStorage);
  const loaded = store.load();
  const state = { friends: loaded.friends, selectedId: null, activeTag: null };
  const loadNotice = loaded.notice;
  let saveFailed = false;

  function newId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function viewModel() {
    const today = logic.todayString();
    const tags = logic.allTags(state.friends);
    if (state.activeTag && !tags.includes(state.activeTag)) state.activeTag = null;
    if (!state.friends.some((f) => f.id === state.selectedId)) state.selectedId = null;
    return {
      friends: state.friends,
      selectedId: state.selectedId,
      activeTag: state.activeTag,
      today,
      colors: logic.tagColorMap(state.friends),
      counts: logic.layerCounts(state.friends),
      stale: logic.staleList(state.friends, today),
      notice: [saveFailed ? SAVE_FAILED_NOTICE : null, loadNotice].filter(Boolean).join(' ') || null,
    };
  }

  function render() {
    const vm = viewModel();
    map.render(vm);
    ui.render(vm);
  }

  function commit(friends) {
    state.friends = friends;
    saveFailed = !store.save(friends);
    render();
  }

  function updateFriend(id, patch) {
    commit(state.friends.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  const actions = {
    add(fields) {
      commit([...state.friends, { id: newId(), ...fields }]);
    },
    update: updateFriend,
    contacted(id) {
      updateFriend(id, { lastContact: logic.todayString() });
    },
    remove(id) {
      commit(state.friends.filter((f) => f.id !== id));
    },
    select(id) {
      ui.commitDetail();
      state.selectedId = id;
      render();
    },
    toggleTag(tag) {
      state.activeTag = state.activeTag === tag ? null : tag;
      render();
    },
  };

  const map = createMap(document.getElementById('map'), {
    onSelect: actions.select,
    onMove(id, layer) {
      updateFriend(id, { layer });
    },
  });
  const ui = createUI(actions, map);

  createCsvPanel({
    getFriends() {
      ui.commitDetail();
      return state.friends;
    },
    setFriends: commit,
    makeId: newId,
  });

  document.addEventListener('keydown', (event) => {
    if (document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape' && state.selectedId) actions.select(null);
  });

  // 開いたままで日付が変わっても、疎遠の判定が古くならないようにする。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) render();
  });

  // 別のタブで変更されたら読み直す。古い内容で上書きしてしまうのを防ぐ。
  global.addEventListener('storage', (event) => {
    if (event.key !== store.KEY) return;
    state.friends = store.load().friends;
    render();
  });

  render();
})(globalThis);
