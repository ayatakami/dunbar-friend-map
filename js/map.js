// 同心円マップの描画とドラッグ操作。
(function (global) {
  'use strict';

  const { logic } = global.Dunbar;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DRAG_THRESHOLD = 5;
  const VIEW_HALF = 500;
  const SELF_RADIUS = 38;
  const MIN_LABEL_PX = 5;
  const PILL_HEIGHT = 15;
  const PILL_PADDING = 9;
  const TOOLTIP_HEIGHT = 24;
  const TOOLTIP_PADDING = 10;
  const MAX_TEXT_SCALE = 2;

  function svgEl(name, attrs, parent) {
    const el = document.createElementNS(SVG_NS, name);
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
    if (parent) parent.appendChild(el);
    return el;
  }

  function translate(x, y) {
    return `translate(${x}px, ${y}px)`;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function createMap(svg, callbacks) {
    const bandLayer = svgEl('g', {}, svg);
    const nodeLayer = svgEl('g', {}, svg);
    const pillLayer = svgEl('g', {}, svg);
    const tooltip = svgEl('g', { class: 'tooltip', display: 'none' }, svg);
    const tooltipBg = svgEl('rect', {}, tooltip);
    const tooltipText = svgEl('text', {}, tooltip);

    const bands = new Map();
    const pills = new Map();
    const nodes = new Map();

    let lastVm = null;
    let lastLayout = {};
    let hoveredId = null;
    let focusedId = null;
    let dragging = false;
    let textScale = 1;
    let unitsPerPixel = 1;

    // 内側の円が上に重なるよう、外側から描く。
    [...logic.LAYERS].reverse().forEach((layer) => {
      bands.set(layer.id, svgEl('circle', { class: `band band-${layer.id}`, r: layer.outer }, bandLayer));
    });
    svgEl('circle', { class: 'self', r: SELF_RADIUS }, bandLayer);
    svgEl('text', { class: 'self-label' }, bandLayer).textContent = '自分';

    logic.LAYERS.forEach((layer) => {
      const g = svgEl('g', { class: 'pill', transform: `translate(0 ${-layer.outer})` }, pillLayer);
      pills.set(layer.id, {
        g,
        rect: svgEl('rect', {}, g),
        text: svgEl('text', {}, g),
      });
    });

    function findFriend(id) {
      return lastVm.friends.find((f) => f.id === id) || null;
    }

    function clientToSvg(x, y) {
      return new DOMPoint(x, y).matrixTransform(svg.getScreenCTM().inverse());
    }

    // ---- 描画 ----

    // マップが小さく表示されても読めるよう、ラベルの文字だけ画面上の大きさを保つ。
    function updateTextScale() {
      const { width, height } = svg.getBoundingClientRect();
      const size = Math.min(width, height);
      unitsPerPixel = size > 0 ? (VIEW_HALF * 2) / size : 1;
      textScale = clamp(unitsPerPixel, 1, MAX_TEXT_SCALE);
      svg.style.setProperty('--text-scale', textScale);
    }

    // スマホのように小さく表示され、読めない大きさになる名前は出さない。
    function labelShown(pos) {
      return pos.labelMaxEm > 0 && pos.fontSize / unitsPerPixel >= MIN_LABEL_PX;
    }

    function sizeBackground(rect, text, height, padding) {
      const scaledHeight = height * textScale;
      const width = text.getComputedTextLength() + padding * 2 * textScale;
      rect.setAttribute('width', width);
      rect.setAttribute('height', scaledHeight);
      rect.setAttribute('x', -width / 2);
      rect.setAttribute('y', -scaledHeight / 2);
      rect.setAttribute('rx', Math.min(scaledHeight / 2, 8 * textScale));
      return width;
    }

    function updatePills(counts) {
      counts.forEach(({ layer, cumulative, over }) => {
        const pill = pills.get(layer.id);
        pill.text.textContent = `${layer.name} ${cumulative}/${layer.limit}`;
        sizeBackground(pill.rect, pill.text, PILL_HEIGHT, PILL_PADDING);
        pill.g.classList.toggle('over', over > 0);
      });
    }

    function createNode(id) {
      const g = svgEl('g', { class: 'node', tabindex: 0, role: 'button', 'data-id': id }, nodeLayer);
      const node = {
        g,
        staleRing: svgEl('circle', { class: 'stale-ring' }, g),
        selectRing: svgEl('circle', { class: 'select-ring' }, g),
        dot: svgEl('circle', { class: 'dot' }, g),
        initial: svgEl('text', { class: 'initial' }, g),
        label: svgEl('text', { class: 'label' }, g),
      };
      nodes.set(id, node);
      return node;
    }

    function updateNode(friend, pos, vm) {
      const node = nodes.get(friend.id) || createNode(friend.id);
      const info = logic.staleInfo(friend, vm.today);
      const stale = info.status === 'stale';
      const layer = logic.layerById(friend.layer);

      node.g.style.transform = translate(pos.x, pos.y);
      node.g.classList.toggle('dim', Boolean(vm.activeTag) && !friend.tags.includes(vm.activeTag));
      node.g.classList.toggle('selected', vm.selectedId === friend.id);
      node.g.setAttribute(
        'aria-label',
        `${friend.name}、${layer.name}、${logic.describeLastContact(info)}${stale ? '、疎遠になりかけています' : ''}`
      );

      node.dot.setAttribute('r', pos.r);
      node.dot.setAttribute('fill', logic.friendColor(friend, vm.colors));
      node.initial.textContent = logic.initial(friend.name);
      node.initial.setAttribute('font-size', pos.r * 0.95);

      node.staleRing.setAttribute('r', pos.r + 5);
      node.staleRing.setAttribute('display', stale ? 'inline' : 'none');
      node.selectRing.setAttribute('r', pos.r + (stale ? 9 : 5));

      node.label.textContent = labelShown(pos) ? logic.fitName(friend.name, pos.labelMaxEm) : '';
      node.label.setAttribute('y', pos.labelY);
      node.label.setAttribute('font-size', pos.fontSize);
    }

    function updateTooltip() {
      const vm = lastVm;
      const activeId = hoveredId || focusedId;
      const selectedPos = vm && lastLayout[vm.selectedId];
      const id = activeId || (selectedPos && !labelShown(selectedPos) ? vm.selectedId : null);
      const friend = id ? findFriend(id) : null;
      const pos = id ? lastLayout[id] : null;
      if (dragging || !friend || !pos) {
        tooltip.setAttribute('display', 'none');
        return;
      }

      tooltip.setAttribute('display', 'inline');
      tooltipText.textContent = `${friend.name} ・ ${logic.describeLastContact(logic.staleInfo(friend, vm.today))}`;
      const width = sizeBackground(tooltipBg, tooltipText, TOOLTIP_HEIGHT, TOOLTIP_PADDING);
      const height = TOOLTIP_HEIGHT * textScale;

      const x = clamp(pos.x, -VIEW_HALF + width / 2, VIEW_HALF - width / 2);
      const above = pos.y - pos.r - height;
      const y = above < -VIEW_HALF + height / 2 ? pos.y + pos.r + height : above;
      tooltip.setAttribute('transform', `translate(${x} ${y})`);
    }

    function render(vm) {
      lastVm = vm;
      lastLayout = logic.computeLayout(vm.friends);

      nodes.forEach((node, id) => {
        if (!lastLayout[id]) {
          node.g.remove();
          nodes.delete(id);
        }
      });
      vm.friends.forEach((friend) => {
        if (lastLayout[friend.id]) updateNode(friend, lastLayout[friend.id], vm);
      });

      updatePills(vm.counts);
      updateTooltip();
    }

    // ---- ドラッグ ----

    function setDropTarget(target) {
      bands.forEach((band, id) => band.classList.toggle('drop-target', id === target));
      document.body.classList.toggle('drop-unplaced', target === null);
    }

    function clearDropTarget() {
      bands.forEach((band) => band.classList.remove('drop-target'));
      document.body.classList.remove('drop-unplaced');
    }

    function layerAtClient(x, y) {
      const point = clientToSvg(x, y);
      return logic.radiusToLayer(Math.hypot(point.x, point.y));
    }

    // マップ上のアイコンはそのまま動かし、未配置リストからはゴーストを動かす。
    // しきい値より動かなければクリックとして扱う。
    function beginDrag(friend, downEvent) {
      if (downEvent.button !== 0) return;
      const node = nodes.get(friend.id);
      const startX = downEvent.clientX;
      const startY = downEvent.clientY;
      let active = false;
      let ghost = null;

      function start() {
        active = true;
        dragging = true;
        document.body.classList.add('is-dragging');
        updateTooltip();
        if (node) {
          node.g.classList.add('dragging');
          nodeLayer.appendChild(node.g);
        } else {
          ghost = document.createElement('div');
          ghost.className = 'drag-ghost';
          ghost.textContent = friend.name;
          document.body.appendChild(ghost);
        }
      }

      function onMove(event) {
        if (!active) {
          if (Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD) return;
          start();
        }
        if (node) {
          const point = clientToSvg(event.clientX, event.clientY);
          node.g.style.transform = translate(point.x, point.y);
        } else {
          ghost.style.transform = translate(event.clientX + 8, event.clientY + 8);
        }
        setDropTarget(layerAtClient(event.clientX, event.clientY));
      }

      function finish(event, cancelled) {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onCancel);

        if (!active) {
          if (!cancelled) callbacks.onSelect(friend.id);
          return;
        }

        dragging = false;
        document.body.classList.remove('is-dragging');
        clearDropTarget();
        if (ghost) ghost.remove();
        if (node) node.g.classList.remove('dragging');

        const target = cancelled ? friend.layer : layerAtClient(event.clientX, event.clientY);
        if (target === friend.layer) render(lastVm);
        else callbacks.onMove(friend.id, target);
      }

      function onUp(event) {
        finish(event, false);
      }

      function onCancel(event) {
        finish(event, true);
      }

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onCancel);
    }

    // ---- イベント ----

    svg.addEventListener('pointerdown', (event) => {
      const g = event.target.closest('.node');
      if (!g) {
        callbacks.onSelect(null);
        return;
      }
      const friend = findFriend(g.dataset.id);
      if (friend) beginDrag(friend, event);
    });

    nodeLayer.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const g = event.target.closest('.node');
      if (!g) return;
      event.preventDefault();
      callbacks.onSelect(g.dataset.id);
    });

    nodeLayer.addEventListener('pointerover', (event) => {
      const g = event.target.closest('.node');
      hoveredId = g ? g.dataset.id : null;
      updateTooltip();
    });

    nodeLayer.addEventListener('pointerout', () => {
      hoveredId = null;
      updateTooltip();
    });

    nodeLayer.addEventListener('focusin', (event) => {
      const g = event.target.closest('.node');
      focusedId = g && g.matches(':focus-visible') ? g.dataset.id : null;
      updateTooltip();
    });

    nodeLayer.addEventListener('focusout', () => {
      focusedId = null;
      updateTooltip();
    });

    updateTextScale();
    new ResizeObserver(() => {
      updateTextScale();
      if (lastVm) render(lastVm);
    }).observe(svg);

    return { render, beginDrag };
  }

  global.Dunbar.createMap = createMap;
})(globalThis);
