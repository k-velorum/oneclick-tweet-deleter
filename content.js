(() => {
  'use strict';
  const TWEET = 'article[data-testid="tweet"]';
  const BUTTON = 'octd-delete';
  const DELETE_LABELS = new Set(['削除', 'Delete']);
  let busy = false;
  let scheduled = false;

  const ownedQuery = (article, selector) => [...article.querySelectorAll(selector)]
    .find(element => element.closest(TWEET) === article);

  function account() {
    const href = document.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href');
    return href?.match(/^\/([A-Za-z0-9_]+)\/?$/)?.[1].toLowerCase() || null;
  }

  function identity(article) {
    if (article.parentElement?.closest(TWEET)) return null;
    // The outer author's timestamp avoids treating an embedded quote as the target.
    const header = ownedQuery(article, '[data-testid="User-Name"]');
    // Detail pages place the timestamp below the body. Exclude clickable quote cards.
    const link = header?.querySelector('a[href*="/status/"]:has(time)') ||
      [...article.querySelectorAll('a[href*="/status/"]:has(time)')].find(element =>
        element.closest(TWEET) === article && !element.parentElement.closest('[role="link"], a'));
    const match = link?.getAttribute('href')?.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)\/?$/);
    const authorLink = header?.querySelector('a[href]')?.getAttribute('href');
    const author = authorLink?.match(/^\/([A-Za-z0-9_]+)(?:\/status\/\d+)?\/?$/)?.[1].toLowerCase();
    return match && author === match[1].toLowerCase() ? { author, id: match[2] } : null;
  }

  function valid(article, target) {
    const current = identity(article);
    return article.isConnected && current?.id === target.id && current.author === target.author && account() === target.author;
  }

  function visible(element) {
    return element?.isConnected && element.getClientRects().length > 0;
  }

  function waitFor(read, signal, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        observer.disconnect();
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const check = () => {
        try { const result = read(); if (result) finish(null, result); }
        catch (error) { finish(error); }
      };
      const abort = () => finish(new Error('操作を中止しました。'));
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => finish(new Error('Xの画面を確認できませんでした。画面を確認して再試行してください。')), timeout);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      signal?.addEventListener('abort', abort, { once: true });
      signal?.aborted ? abort() : check();
    });
  }

  function notice(message) {
    document.querySelector('.octd-notice')?.remove();
    const node = document.createElement('div');
    node.className = 'octd-notice';
    node.setAttribute('role', 'alert');
    node.textContent = message;
    document.body.append(node);
    setTimeout(() => node.remove(), 6000);
  }

  function decorateConfirmation(sheet, confirm, cancel, article, target) {
    // Preserve X's localized labels, markup and handlers; only append shortcut hints.
    for (const [button, key] of [[confirm, 'Y'], [cancel, 'N']]) {
      const label = button.firstElementChild || button;
      label.classList.add('octd-confirm-label');
      const keycap = document.createElement('kbd');
      keycap.className = 'octd-keycap';
      keycap.textContent = key;
      keycap.setAttribute('aria-hidden', 'true');
      label.append(' ', keycap);
      button.setAttribute('aria-keyshortcuts', key);
    }
    cancel.focus();
    confirm.addEventListener('click', event => {
      if (valid(article, target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel.click();
      notice('対象の投稿またはアカウントが変わったため中止しました。');
    }, true);
    const keydown = event => {
      if (!sheet.isConnected || !visible(sheet) || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (!['y', 'n', 'escape'].includes(key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      (key === 'y' ? confirm : cancel).click();
    };
    document.addEventListener('keydown', keydown, true);
    const observer = new MutationObserver(() => {
      if (!sheet.isConnected) {
        document.removeEventListener('keydown', keydown, true);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function removeTweet(event, article, button) {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    const target = identity(article);
    if (!target || !valid(article, target)) { scan(); return; }
    if (document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]')) {
      notice('開いているメニューやダイアログを閉じてから操作してください。');
      return;
    }
    const skipConfirmation = event.shiftKey;
    busy = true;
    button.disabled = true;
    const controller = new AbortController();
    // Any new physical interaction interrupts automation, avoiding a race with another menu.
    const interrupt = event => { if (event.isTrusted) controller.abort(); };
    document.addEventListener('pointerdown', interrupt, true);
    document.addEventListener('keydown', interrupt, true);
    const assertTarget = () => {
      if (controller.signal.aborted || !valid(article, target)) throw new Error('対象の投稿またはアカウントが変わったため中止しました。');
    };
    try {
      const caret = ownedQuery(article, '[data-testid="caret"]');
      if (!caret || !visible(caret)) throw new Error('投稿のメニューが見つかりませんでした。');
      caret.click();
      const menu = await waitFor(() => [...document.querySelectorAll('[role="menu"]')].find(visible), controller.signal);
      assertTarget();
      const items = [...menu.querySelectorAll('[role="menuitem"]')].filter(item => DELETE_LABELS.has(item.textContent.trim()));
      if (items.length !== 1) throw new Error('削除項目を確認できませんでした。日本語・英語のXに対応しています。');
      items[0].click();
      const sheet = await waitFor(() => [...document.querySelectorAll('[data-testid="confirmationSheetDialog"]')].find(visible), controller.signal);
      assertTarget();
      const confirm = sheet.querySelector('[data-testid="confirmationSheetConfirm"]');
      const cancel = sheet.querySelector('[data-testid="confirmationSheetCancel"]');
      const heading = sheet.querySelector('[role="heading"], h1, h2')?.textContent.trim();
      // This test id is shared by other X actions: require the exact delete title and label.
      if (!confirm || !cancel || !DELETE_LABELS.has(confirm.textContent.trim()) ||
          !['ポストを削除しますか？', 'ツイートを削除しますか？', 'Delete post?', 'Delete Tweet?'].includes(heading)) {
        throw new Error('削除の確認画面を識別できなかったため、自動操作を中止しました。');
      }
      if (skipConfirmation) {
        assertTarget();
        confirm.click();
        // X owns success/error rendering. Do not remove the article optimistically.
        await waitFor(() => !sheet.isConnected, controller.signal, 10000);
      } else {
        decorateConfirmation(sheet, confirm, cancel, article, target);
      }
    } catch (error) {
      notice(error.message);
    } finally {
      document.removeEventListener('pointerdown', interrupt, true);
      document.removeEventListener('keydown', interrupt, true);
      button.disabled = false;
      busy = false;
    }
  }

  function scan() {
    const currentAccount = account();
    for (const article of document.querySelectorAll(TWEET)) {
      const target = identity(article);
      const existing = ownedQuery(article, `.${BUTTON}`);
      const caret = ownedQuery(article, '[data-testid="caret"]');
      if (!currentAccount || target?.author !== currentAccount || !caret) {
        existing?.remove();
        continue;
      }
      if (existing) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = BUTTON;
      button.title = '投稿を削除（Shift＋クリックで確認を省略）';
      button.setAttribute('aria-label', button.title);
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h8l1 3h4v2h-2l-1 13H6L5 8H3V6h4l1-3zm2 2-.33 1h4.66L14 5h-4zM7 8l.85 11h8.3L17 8H7zm3 2h1v7h-1v-7zm3 0h1v7h-1v-7z"/></svg>';
      button.addEventListener('click', event => void removeTweet(event, article, button));
      caret.parentElement.insertBefore(button, caret);
    }
  }

  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; scan(); });
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  scan();
})();
