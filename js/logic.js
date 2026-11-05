// ダンバー数の層の定義と、DOMに依存しない計算処理。
(function (global) {
  'use strict';

  // limit は内側の層を含む累計の上限、staleDays は疎遠とみなす日数の目安。
  // inner 以降は viewBox(-500〜500)上の寸法。上限の人数でも名前が重ならない大きさにしている。
  // outerInset は外周に残す余白で、名前と、円の境界にある層のラベルの分。
  const LAYERS = [
    { id: 1, name: '親友', limit: 5, staleDays: 7, inner: 46, outer: 120, nodeRadius: 19, fontSize: 15, arcSpacing: 72, rowSpacing: 60, outerInset: 27 },
    { id: 2, name: '親しい仲間', limit: 15, staleDays: 30, inner: 120, outer: 190, nodeRadius: 17, fontSize: 14, arcSpacing: 72, rowSpacing: 60, outerInset: 19 },
    { id: 3, name: '友人', limit: 50, staleDays: 180, inner: 190, outer: 316, nodeRadius: 14, fontSize: 14, arcSpacing: 60, rowSpacing: 44, outerInset: 28 },
    { id: 4, name: '友達・知人', limit: 150, staleDays: 365, inner: 316, outer: 490, nodeRadius: 14, fontSize: 13, arcSpacing: 56, rowSpacing: 42, outerInset: 28 },
  ];

  const TAG_COLORS = [
    '#c43d50', '#27769a', '#2a8259', '#9a6208', '#7b5ea7',
    '#0c7c7e', '#b34a70', '#527089', '#8a6d3b', '#557d3e',
  ];
  const NEUTRAL_COLOR = '#6b7280';

  const ROW_INSET_INNER = 8; // 円の境界にある層のラベルにアイコンが隠れない分
  const NODE_SCALES = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
  const LABEL_GAP = 6.5; // 疎遠の輪の外側に名前を出す
  const LABEL_MARGIN = 2;
  const ICON_MARGIN = 2;
  const LABEL_MIN_EM = 2;
  const LABEL_MAX_EM = 6;
  const MS_PER_DAY = 86400000;

  function layerById(id) {
    return LAYERS.find((layer) => layer.id === id) || null;
  }

  // ---- 人数 ----

  function layerCounts(friends) {
    let cumulative = 0;
    return LAYERS.map((layer) => {
      const own = friends.filter((f) => f.layer === layer.id).length;
      cumulative += own;
      return { layer, own, cumulative, over: Math.max(0, cumulative - layer.limit) };
    });
  }

  // ---- 日付(UTC解釈による日付ずれを避けるため、年月日を分解して扱う) ----

  function parseDate(str) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof str === 'string' ? str : '');
    if (!match) return null;
    const [year, month, day] = match.slice(1).map(Number);
    const time = Date.UTC(year, month - 1, day);
    const check = new Date(time);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
      return null;
    }
    return time;
  }

  function todayString(now = new Date()) {
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
  }

  function daysSince(dateStr, today) {
    const from = parseDate(dateStr);
    const to = parseDate(today);
    if (from === null || to === null) return null;
    return Math.round((to - from) / MS_PER_DAY);
  }

  // ---- 疎遠判定 ----

  function staleInfo(friend, today) {
    const layer = layerById(friend.layer);
    const days = daysSince(friend.lastContact, today);
    if (days === null) return { status: 'unrecorded', days: null, overdue: 0 };
    if (!layer || days <= layer.staleDays) return { status: 'ok', days, overdue: 0 };
    return { status: 'stale', days, overdue: days - layer.staleDays };
  }

  function staleList(friends, today) {
    return friends
      .map((friend) => ({ friend, info: staleInfo(friend, today) }))
      .filter((entry) => entry.info.status === 'stale')
      .sort((a, b) => b.info.overdue - a.info.overdue || a.friend.name.localeCompare(b.friend.name, 'ja'));
  }

  function describeLastContact(info) {
    if (info.status === 'unrecorded') return '連絡日は未記録';
    if (info.days < 0) return `${-info.days}日後の予定`;
    if (info.days === 0) return '今日連絡した';
    return `${info.days}日前に連絡`;
  }

  // ---- 配置 ----

  function radiusToLayer(radius) {
    const layer = LAYERS.find((l) => radius <= l.outer);
    return layer ? layer.id : null;
  }

  function rowRadii(lo, hi, rowCount) {
    if (rowCount === 1) return [(lo + hi) / 2];
    return Array.from({ length: rowCount }, (_, j) => lo + ((hi - lo) * j) / (rowCount - 1));
  }

  // n人が収まる最小の行数と、できるだけ大きいアイコンサイズの組を探す。
  // どの組でも収まらなければ、重なりを許して最小サイズで配置する。
  function fitRows(layer, n) {
    let fallback = null;
    for (const scale of NODE_SCALES) {
      const nodeRadius = layer.nodeRadius * scale;
      const arcSpacing = layer.arcSpacing * scale;
      const lo = layer.inner + nodeRadius + ROW_INSET_INNER;
      const hi = layer.outer - nodeRadius - layer.outerInset * scale;
      const maxRows = Math.floor((hi - lo) / (layer.rowSpacing * scale)) + 1;
      for (let rowCount = 1; rowCount <= maxRows; rowCount++) {
        const radii = rowRadii(lo, hi, rowCount);
        const capacities = radii.map((r) => Math.floor((2 * Math.PI * r) / arcSpacing));
        const total = capacities.reduce((sum, c) => sum + c, 0);
        fallback = { scale, nodeRadius, radii, capacities, total };
        if (total >= n) return fallback;
      }
    }
    return fallback;
  }

  // 各行に、収容数に比例して人数を割り振る(最大剰余法)。
  function allocateRows(capacities, total, n) {
    const exact = capacities.map((c) => (n * c) / total);
    const counts = exact.map(Math.floor);
    let rest = n - counts.reduce((sum, c) => sum + c, 0);
    const order = exact
      .map((value, j) => ({ j, remainder: value - Math.floor(value) }))
      .sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; rest > 0; i = (i + 1) % order.length) {
      counts[order[i].j]++;
      rest--;
    }
    return counts;
  }

  function compareForLayout(a, b) {
    const tagA = a.tags[0];
    const tagB = b.tags[0];
    if (tagA !== tagB) {
      if (tagA === undefined) return 1;
      if (tagB === undefined) return -1;
      return tagA.localeCompare(tagB, 'ja');
    }
    return a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id);
  }

  // 円の中の位置を計算する。タグ順に角度を進めるので、同じタグの人は同じ方角に集まる。
  function layoutLayer(layer, friends, result) {
    const n = friends.length;
    if (n === 0) return;
    const fit = fitRows(layer, n);
    const counts = allocateRows(fit.capacities, fit.total, n);
    const assigned = counts.map(() => 0);
    const sorted = [...friends].sort(compareForLayout);

    sorted.forEach((friend, i) => {
      let row = -1;
      let bestDeficit = -Infinity;
      counts.forEach((count, j) => {
        if (assigned[j] >= count) return;
        const deficit = (count * (i + 1)) / n - assigned[j];
        if (deficit > bestDeficit) {
          bestDeficit = deficit;
          row = j;
        }
      });
      const angle = -Math.PI / 2 + (2 * Math.PI * (assigned[row] + 0.5)) / counts[row];
      assigned[row]++;
      const y = fit.radii[row] * Math.sin(angle);
      const fontSize = layer.fontSize * fit.scale;
      result[friend.id] = {
        x: fit.radii[row] * Math.cos(angle),
        y,
        r: fit.nodeRadius,
        fontSize,
        // 名前は外側に向けて出し、内側の円のラベルや「自分」に重ならないようにする。
        labelY: (fit.nodeRadius + LABEL_GAP + fontSize / 2) * (y < 0 ? -1 : 1),
        labelMaxEm: 0,
      };
    });
  }

  // 名前の幅を、左右にいる人のアイコンと名前にぶつからない分だけに制限する。
  // 名前同士は間を半分ずつ使う。名前の中身によらないので、隣の人を編集しても省略の仕方は変わらない。
  function assignLabelWidths(positions) {
    const spans = positions.map((p) => {
      const center = p.y + p.labelY;
      return {
        top: center - p.fontSize / 2,
        bottom: center + p.fontSize / 2,
        half: (LABEL_MAX_EM * p.fontSize) / 2,
      };
    });

    const limitByIcon = (span, icon, dx) => {
      const dy = Math.max(span.top - icon.y, icon.y - span.bottom, 0);
      const radius = icon.r + ICON_MARGIN;
      if (dy < radius) span.half = Math.min(span.half, dx - Math.sqrt(radius * radius - dy * dy) - LABEL_MARGIN);
    };

    positions.forEach((a, i) => {
      for (let j = i + 1; j < positions.length; j++) {
        const b = positions[j];
        const dx = Math.abs(a.x - b.x);
        limitByIcon(spans[i], b, dx);
        limitByIcon(spans[j], a, dx);
        if (spans[i].top < spans[j].bottom && spans[j].top < spans[i].bottom) {
          const half = (dx - LABEL_MARGIN) / 2;
          spans[i].half = Math.min(spans[i].half, half);
          spans[j].half = Math.min(spans[j].half, half);
        }
      }
    });

    positions.forEach((p, i) => {
      const em = (spans[i].half * 2) / p.fontSize;
      p.labelMaxEm = em >= LABEL_MIN_EM ? em : 0;
    });
  }

  function computeLayout(friends) {
    const result = {};
    LAYERS.forEach((layer) => {
      layoutLayer(layer, friends.filter((f) => f.layer === layer.id), result);
    });
    assignLabelWidths(Object.values(result));
    return result;
  }

  // ---- タグ・表示名 ----

  function parseTags(text) {
    const tags = String(text)
      .split(/[,、，]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    return [...new Set(tags)];
  }

  function allTags(friends) {
    return [...new Set(friends.flatMap((f) => f.tags))];
  }

  // 登場順に色を割り当てる。タグを足しても既存のタグの色は変わらない。
  function tagColorMap(friends) {
    const colors = {};
    allTags(friends).forEach((tag, i) => {
      colors[tag] = TAG_COLORS[i % TAG_COLORS.length];
    });
    return colors;
  }

  function friendColor(friend, colors) {
    return friend.tags.length > 0 ? colors[friend.tags[0]] : NEUTRAL_COLOR;
  }

  function initial(name) {
    const first = Array.from(name.trim())[0];
    return first ? first.toUpperCase() : '?';
  }

  // 英数字は全角の約0.6文字分の幅として数える。
  function charWidth(char) {
    return char.codePointAt(0) < 0x2e80 ? 0.6 : 1;
  }

  function fitName(name, maxEm) {
    const chars = Array.from(name);
    if (chars.reduce((sum, c) => sum + charWidth(c), 0) <= maxEm) return name;
    let used = 1; // 「…」の分
    let end = 0;
    while (end < chars.length && used + charWidth(chars[end]) <= maxEm) {
      used += charWidth(chars[end]);
      end++;
    }
    return `${chars.slice(0, end).join('')}…`;
  }

  const logic = {
    LAYERS,
    NEUTRAL_COLOR,
    layerById,
    layerCounts,
    parseDate,
    todayString,
    daysSince,
    staleInfo,
    staleList,
    describeLastContact,
    radiusToLayer,
    computeLayout,
    parseTags,
    allTags,
    tagColorMap,
    friendColor,
    initial,
    fitName,
  };

  global.Dunbar = global.Dunbar || {};
  global.Dunbar.logic = logic;
  if (typeof module !== 'undefined' && module.exports) module.exports = logic;
})(globalThis);
