// CSVの書き出しボタンと、読み込み前の確認ダイアログ。
(function (global) {
  'use strict';

  const { logic, csv } = global.Dunbar;
  const $ = (id) => document.getElementById(id);
  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  const MAX_SHOWN_ERRORS = 10;

  function download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function readFile(file) {
    if (file.size > MAX_FILE_BYTES) {
      return { fatal: 'ファイルが大きすぎます(上限は5MBです)。', rows: [], errors: [], ignoredColumns: [] };
    }
    try {
      return csv.parseFriendsCsv(csv.decodeCsv(await file.arrayBuffer()));
    } catch {
      return {
        fatal: 'ファイルを読み込めませんでした。Excelなどで開いている場合は、閉じてからもう一度試してください。',
        rows: [],
        errors: [],
        ignoredColumns: [],
      };
    }
  }

  function describeMerge({ added, updated, unchanged }) {
    return `新規${added}人、更新${updated}人、変更なし${unchanged}人`;
  }

  // getFriends は編集中の内容を確定してから今のデータを返す。setFriends は保存と再描画まで行う。
  function createCsvPanel({ getFriends, setFriends, makeId }) {
    const dialog = $('csv-dialog');
    const fileInput = $('csv-file');
    const status = $('csv-status');
    const apply = $('csv-apply');
    const cancel = $('csv-cancel');
    const modeInputs = [...dialog.querySelectorAll('input[name="csv-mode"]')];

    let pendingRows = [];

    function selectedMode() {
      return modeInputs.find((input) => input.checked).value;
    }

    function syncApplyButton() {
      const replacing = selectedMode() === 'replace';
      apply.textContent = replacing ? '置き換える' : '取り込む';
      apply.className = replacing ? 'danger-solid' : 'primary';
    }

    function renderErrors(errors) {
      $('csv-errors').hidden = errors.length === 0;
      $('csv-errors-title').textContent = `取り込めない行が${errors.length}行あります。`;
      const shown = errors.slice(0, MAX_SHOWN_ERRORS).map(({ row, message }) => {
        const item = document.createElement('li');
        item.textContent = `${row}行目: ${message}`;
        return item;
      });
      if (errors.length > MAX_SHOWN_ERRORS) {
        const more = document.createElement('li');
        more.textContent = `ほか${errors.length - MAX_SHOWN_ERRORS}行`;
        shown.push(more);
      }
      $('csv-error-list').replaceChildren(...shown);
    }

    function openDialog(fileName, result) {
      const friends = getFriends();
      const canImport = !result.fatal && result.rows.length > 0;
      pendingRows = result.rows;

      if (result.fatal) $('csv-summary').textContent = `${fileName}: ${result.fatal}`;
      else if (canImport) $('csv-summary').textContent = `${fileName}: ${result.rows.length}人分を読み取りました。`;
      else $('csv-summary').textContent = `${fileName}: 取り込める人がいませんでした。`;

      renderErrors(result.errors);
      $('csv-ignored').hidden = result.ignoredColumns.length === 0;
      $('csv-ignored').textContent = `使わない列: ${result.ignoredColumns.join('、')}`;

      $('csv-modes').hidden = !canImport;
      apply.hidden = !canImport;
      cancel.textContent = canImport ? 'キャンセル' : '閉じる';
      if (canImport) {
        $('csv-merge-note').textContent = `今のデータは残します。${describeMerge(csv.mergeFriends(friends, result.rows, makeId))}`;
        $('csv-replace-note').textContent = `今の${friends.length}人を消して、${result.rows.length}人にします。元に戻せないので、必要なら先に書き出してください。`;
        $('csv-replace-option').hidden = friends.length === 0;
        modeInputs.forEach((input) => {
          input.checked = input.value === 'merge';
        });
        syncApplyButton();
      }
      dialog.showModal();
    }

    $('csv-export').addEventListener('click', () => {
      const friends = getFriends();
      const filename = `dunbar-friends-${logic.todayString()}.csv`;
      download(filename, csv.friendsToCsv(friends));
      status.textContent = friends.length > 0
        ? `${friends.length}人を ${filename} に書き出しました。`
        : `列名だけの ${filename} を書き出しました。`;
    });

    $('csv-import').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      // 同じファイルを選び直しても change が発生するように空にする。
      fileInput.value = '';
      if (file) openDialog(file.name, await readFile(file));
    });

    modeInputs.forEach((input) => input.addEventListener('change', syncApplyButton));

    cancel.addEventListener('click', () => dialog.close());

    apply.addEventListener('click', () => {
      if (selectedMode() === 'replace') {
        setFriends(csv.replaceFriends(pendingRows, makeId));
        status.textContent = `${pendingRows.length}人に置き換えました。`;
      } else {
        const merged = csv.mergeFriends(getFriends(), pendingRows, makeId);
        setFriends(merged.friends);
        status.textContent = `取り込みました(${describeMerge(merged)})。`;
      }
      dialog.close();
    });
  }

  global.Dunbar.createCsvPanel = createCsvPanel;
})(globalThis);
