// サイドバー(追加フォーム、人数、タグ、疎遠リスト、未配置、詳細パネル)。
(function (global) {
  'use strict';

  const { logic } = global.Dunbar;
  const $ = (id) => document.getElementById(id);

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    Object.entries(props || {}).forEach(([key, value]) => {
      if (key === 'text') el.textContent = value;
      else el.setAttribute(key, value);
    });
    el.append(...children);
    return el;
  }

  function tagDot(color) {
    const dot = h('span', { class: 'tag-dot' });
    dot.style.background = color;
    return dot;
  }

  function layerValue(select) {
    return select.value === '' ? null : Number(select.value);
  }

  function fillLayerSelect(select) {
    select.append(h('option', { value: '', text: '未配置' }));
    logic.LAYERS.forEach((layer) => {
      select.append(h('option', { value: String(layer.id), text: `${layer.name}(〜${layer.limit}人)` }));
    });
  }

  function createUI(actions, map) {
    const add = {
      form: $('add-form'),
      name: $('add-name'),
      layer: $('add-layer'),
      tags: $('add-tags'),
      last: $('add-last'),
      memo: $('add-memo'),
    };
    const detail = {
      section: $('detail'),
      avatar: $('detail-avatar'),
      status: $('detail-status'),
      name: $('detail-name'),
      layer: $('detail-layer'),
      tags: $('detail-tags'),
      last: $('detail-last'),
      memo: $('detail-memo'),
      close: $('detail-close'),
      contacted: $('detail-contacted'),
      remove: $('detail-delete'),
      confirm: $('detail-delete-confirm'),
    };
    const mainPanel = $('main-panel');

    let lastVm = null;
    let detailId = null;

    fillLayerSelect(add.layer);
    fillLayerSelect(detail.layer);

    // ---- 追加フォーム ----

    add.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = add.name.value.trim();
      if (!name) {
        add.name.value = '';
        add.name.focus();
        return;
      }
      actions.add({
        name,
        layer: layerValue(add.layer),
        tags: logic.parseTags(add.tags.value),
        lastContact: add.last.value || null,
        memo: add.memo.value,
      });
      // 同じ層にまとめて追加しやすいよう、層の選択は残す。
      add.name.value = '';
      add.tags.value = '';
      add.last.value = '';
      add.memo.value = '';
      add.name.focus();
    });

    // ---- 人数 ----

    function renderCounts(counts) {
      $('layer-counts').replaceChildren(...counts.map(({ layer, own, cumulative, over }) => {
        const fill = h('span', { class: 'meter-fill' });
        fill.style.width = `${Math.min(100, (cumulative / layer.limit) * 100)}%`;
        const note = over > 0
          ? `${over}人超過(この円に${own}人)`
          : `この円に${own}人 ・ 連絡の目安は${layer.staleDays}日以内`;
        return h('li', { class: over > 0 ? 'count over' : 'count' },
          h('div', { class: 'count-head' },
            h('span', { class: 'count-name', text: layer.name }),
            h('span', { class: 'count-num', text: `${cumulative} / ${layer.limit}` })),
          h('div', { class: 'meter' }, fill),
          h('p', { class: 'count-note', text: note }));
      }));
    }

    // ---- タグ ----

    function renderTagFilter(vm) {
      const tags = logic.allTags(vm.friends);
      $('tag-section').hidden = tags.length === 0;
      $('tag-filter').replaceChildren(...tags.map((tag) => {
        const count = vm.friends.filter((f) => f.tags.includes(tag)).length;
        const chip = h('button', {
          type: 'button',
          class: 'chip',
          'aria-pressed': String(vm.activeTag === tag),
        }, tagDot(vm.colors[tag]), `${tag} ${count}`);
        chip.addEventListener('click', () => actions.toggleTag(tag));
        return chip;
      }));
    }

    // 既存のタグを選べるようにして、表記ゆれを防ぐ。
    function renderTagSuggest(container, input, vm, onPick) {
      container.replaceChildren(...logic.allTags(vm.friends).map((tag) => {
        const chip = h('button', { type: 'button', class: 'chip' }, tagDot(vm.colors[tag]), tag);
        chip.addEventListener('click', () => {
          input.value = logic.parseTags(`${input.value},${tag}`).join('、');
          if (onPick) onPick();
        });
        return chip;
      }));
    }

    // ---- 疎遠リスト ----

    function renderStale(vm) {
      $('stale-section').hidden = vm.stale.length === 0;
      $('stale-count').textContent = String(vm.stale.length);
      $('stale-list').replaceChildren(...vm.stale.map(({ friend, info }) => {
        const layer = logic.layerById(friend.layer);
        const name = h('button', { type: 'button', class: 'row-name', text: friend.name });
        name.addEventListener('click', () => actions.select(friend.id));
        const contacted = h('button', { type: 'button', class: 'secondary', text: '今日連絡した' });
        contacted.addEventListener('click', () => actions.contacted(friend.id));
        return h('li', { class: 'row' },
          h('div', {},
            name,
            h('p', { class: 'row-note', text: `${info.days}日前(${layer.name}の目安を${info.overdue}日超過)` })),
          contacted);
      }));
    }

    // ---- 未配置 ----

    function renderUnplaced(vm) {
      const unplaced = vm.friends.filter((f) => f.layer === null);
      $('unplaced-empty').hidden = unplaced.length > 0;
      $('unplaced-list').replaceChildren(...unplaced.map((friend) => {
        const chip = h('button', {
          type: 'button',
          class: 'chip',
          title: 'マップへドラッグして配置。クリックで詳細を開きます。',
        }, tagDot(logic.friendColor(friend, vm.colors)), friend.name);
        chip.addEventListener('pointerdown', (event) => map.beginDrag(friend, event));
        chip.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          actions.select(friend.id);
        });
        return h('li', {}, chip);
      }));
    }

    // ---- 詳細パネル ----

    function setDeleteConfirm(open) {
      detail.remove.hidden = open;
      detail.confirm.hidden = !open;
    }

    // 入力中の欄は上書きしない。別の人に切り替わったときは必ず入れ替える。
    function syncField(field, value, force) {
      if (force || document.activeElement !== field) field.value = value;
    }

    function syncDetail(vm) {
      const friend = vm.friends.find((f) => f.id === vm.selectedId) || null;
      const nextId = friend ? friend.id : null;
      const switched = nextId !== detailId;

      if (switched && friend && mainPanel.contains(document.activeElement)) detail.close.focus();
      detail.section.hidden = !friend;
      mainPanel.hidden = Boolean(friend);
      detailId = nextId;
      if (!friend) return;

      if (switched) {
        setDeleteConfirm(false);
        detail.section.scrollIntoView({ block: 'nearest' });
      }

      syncField(detail.name, friend.name, switched);
      syncField(detail.tags, friend.tags.join('、'), switched);
      syncField(detail.last, friend.lastContact || '', switched);
      syncField(detail.memo, friend.memo, switched);
      detail.layer.value = friend.layer === null ? '' : String(friend.layer);

      detail.avatar.textContent = logic.initial(friend.name);
      detail.avatar.style.background = logic.friendColor(friend, vm.colors);

      const info = logic.staleInfo(friend, vm.today);
      detail.status.textContent = info.status === 'stale'
        ? `${logic.describeLastContact(info)}(目安を${info.overdue}日超過)`
        : logic.describeLastContact(info);

      renderTagSuggest($('detail-tag-suggest'), detail.tags, vm, commitDetail);
    }

    // 編集中の内容を確定する。選択を切り替える前にも呼ばれるので、変更がなければ何もしない。
    function commitDetail() {
      const friend = lastVm && lastVm.friends.find((f) => f.id === detailId);
      if (!friend) return;
      const name = detail.name.value.trim();
      const next = {
        name: name || friend.name,
        layer: layerValue(detail.layer),
        tags: logic.parseTags(detail.tags.value),
        lastContact: detail.last.value || null,
        memo: detail.memo.value,
      };
      const changed = Object.keys(next).some((key) => JSON.stringify(next[key]) !== JSON.stringify(friend[key]));
      if (changed) actions.update(friend.id, next);
      else if (!name) detail.name.value = friend.name;
    }

    [detail.name, detail.layer, detail.tags, detail.last, detail.memo].forEach((field) => {
      field.addEventListener('change', commitDetail);
    });

    detail.close.addEventListener('click', () => actions.select(null));
    detail.contacted.addEventListener('click', () => actions.contacted(detailId));
    detail.remove.addEventListener('click', () => setDeleteConfirm(true));
    $('detail-delete-no').addEventListener('click', () => setDeleteConfirm(false));
    $('detail-delete-yes').addEventListener('click', () => actions.remove(detailId));

    // ---- 全体 ----

    function render(vm) {
      lastVm = vm;
      renderCounts(vm.counts);
      renderTagFilter(vm);
      renderTagSuggest($('add-tag-suggest'), add.tags, vm);
      renderStale(vm);
      renderUnplaced(vm);
      syncDetail(vm);

      $('map-hint').hidden = vm.friends.some((f) => f.layer !== null);
      $('notice').hidden = !vm.notice;
      $('notice').textContent = vm.notice || '';
    }

    return { render, commitDetail };
  }

  global.Dunbar.createUI = createUI;
})(globalThis);
