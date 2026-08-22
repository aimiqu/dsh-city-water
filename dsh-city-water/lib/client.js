/**
 * dsh-city-water 浏览器半：GUI 侧边栏「城市水智管」入口 + 会话区工作台面板 + 原生会话任务桥。
 *
 * 纯 DOM（无 React、无官方客户端 SDK 依赖）：自愈 MutationObserver 注入入口行；
 * 点击后以同源 iframe（/api/dsh-city-water/workbench/）接管会话区，工具栏可「在标签页打开」。
 * 与其他面板插件（lawbench / taskboard / ssh / personal-workbench）共用
 * dsh-panel-activate 互斥约定。
 *
 * 任务桥：工作台把装配好的任务经 postMessage 转交本插件，本插件关闭面板并把任务
 * 写入 DSH 原生 composer（React 受控组件兼容写法），用户回车即由原生 Agent 会话执行。
 * 对话、模型、工具、历史、审批全部走原生 harness —— 工作台自身不做任何 LLM 调用。
 */
window.__ModuleLoader__.load({
  id: 'dsh-city-water',
  factory: function () {
    'use strict';
    var exports = {};
    var inject = [];

    var VIEW_URL = '/api/dsh-city-water/workbench/';
    var ENTRY_ATTR = 'data-dsh-city-water-entry';
    var VIEW_ATTR = 'data-dsh-city-water-view';
    var ACTIVE_ATTR = 'data-dsh-city-water-active';
    var TASK_EVENT = 'dsh-city-water:task';
    var PANEL_EVENT = 'dsh-panel-activate';
    // 与本插件互斥的其他面板插件的 active 属性（社区约定）。
    var SIBLING_ATTRS = ['data-dsh-law-active', 'data-dsh-lawbench-active', 'data-dsh-taskboard-active', 'data-dsh-ssh-active', 'data-dsh-personal-workbench-active'];

    var ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5c2.8 2.4 5.4 2.4 6.5 2.4v8.3c-1.1 0-3.7 0-6.5-2.4-2.8 2.4-5.4 2.4-6.5 2.4V3.9C2.6 3.9 5.2 3.9 8 1.5z"/><path d="M8 3.9v9.4"/></svg>';
    var POPOUT_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5H3v9h9v-3.5"/><path d="M9 2h5v5"/><path d="M7.5 8.5 14 2"/></svg>';
    var REFRESH_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 1.8v2.6h-2.6"/></svg>';
    var CLOSE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

    var CSS = [
      '[data-pane="conversation"],[class*="centerCol"]{position:relative}',
      '[' + VIEW_ATTR + ']{position:absolute;inset:0;display:none;z-index:60;background:var(--dsw-alias-bg-base,#fff);flex-direction:column}',
      'html[' + ACTIVE_ATTR + '] [' + VIEW_ATTR + ']{display:flex}',
      // 激活时只留本面板，其余会话区内容隐藏（自动排除其他面板的属性选择器由互斥机制保证）。
      'html[' + ACTIVE_ATTR + '] [data-pane="conversation"] > :not([' + VIEW_ATTR + ']),html[' + ACTIVE_ATTR + '] [class*="centerCol"] > :not([' + VIEW_ATTR + ']){display:none !important}',
      '.cw-viewbar{flex:none;display:flex;align-items:center;gap:10px;height:42px;padding:0 10px 0 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#e4e9f2);background:var(--dsw-alias-bg-base,#fff)}',
      '.cw-viewbar-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1c2333);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:8px}',
      '.cw-viewbar-title svg{width:15px;height:15px;color:#0a75c8;flex:none}',
      '.cw-viewbar-actions{display:flex;gap:4px;align-items:center}',
      '.cw-viewbar-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6478);cursor:pointer}',
      '.cw-viewbar-btn:hover{background:var(--dsw-specific-sidebar-nav-item-hover,#eef1f6);color:var(--dsw-alias-label-primary,#1c2333)}',
      '.cw-frame{flex:1;min-height:0;width:100%;border:none;background:#f4f8fc}',
      '.cw-entry{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 12px;background:transparent;border:none;border-radius:8px;color:var(--dsw-alias-label-secondary,#5b6478);cursor:pointer;font-size:13px;white-space:nowrap;text-align:left}',
      '.cw-entry:hover{background:var(--dsw-specific-sidebar-nav-item-hover,#eef1f6);color:var(--dsw-alias-label-primary,#1c2333)}',
      '.cw-entry[data-active]{background:var(--dsw-specific-sidebar-nav-item-active,#e8effc);color:var(--dsw-alias-label-primary,#1c2333);font-weight:600}',
      '.cw-entry-icon{display:inline-flex;align-items:center;justify-content:center;flex:none}',
      '.cw-entry-label{overflow:hidden;text-overflow:ellipsis}',
      '[data-dsh-frame][data-sidebar-collapsed] .cw-entry{justify-content:center;padding:0}',
      '[data-dsh-frame][data-sidebar-collapsed] .cw-entry-label{display:none}',
      '.cw-toast{position:fixed;z-index:400;left:50%;bottom:34px;transform:translateX(-50%);max-width:min(560px,86vw);padding:11px 16px;border-radius:9px;background:rgba(22,35,58,.96);color:#fff;font-size:12.5px;line-height:1.6;box-shadow:0 12px 34px rgba(5,24,39,.35);animation:cwToastIn .22s ease}',
      '.cw-toast b{color:#7fd3ff}',
      '@keyframes cwToastIn{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translate(-50%,0)}}',
    ].join('\n');

    function ensureStyle() {
      if (document.getElementById('dsh-city-water-style')) return;
      var style = document.createElement('style');
      style.id = 'dsh-city-water-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    var entryButton;
    var viewRoot;
    var frameEl;
    var toastTimer;

    function isActive() { return document.documentElement.getAttribute(ACTIVE_ATTR) === 'true'; }
    function setActive(active) {
      if (active) document.documentElement.setAttribute(ACTIVE_ATTR, 'true');
      else document.documentElement.removeAttribute(ACTIVE_ATTR);
      if (entryButton !== undefined) {
        if (active) entryButton.dataset.active = '';
        else delete entryButton.dataset.active;
      }
    }

    function conversationPane() {
      return document.querySelector('[data-pane="conversation"]')
        || document.querySelector('[class*="centerCol"]') || undefined;
    }

    function toast(html) {
      var el = document.getElementById('dsh-city-water-toast');
      if (el !== null && el !== undefined) el.remove();
      el = document.createElement('div');
      el.id = 'dsh-city-water-toast';
      el.className = 'cw-toast';
      el.innerHTML = html;
      document.body.appendChild(el);
      if (toastTimer !== undefined) window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(function () { el.remove(); }, 4200);
    }

    function ensureView() {
      if (viewRoot !== undefined && viewRoot.isConnected) return viewRoot;
      var pane = conversationPane();
      if (pane === undefined) return undefined;

      viewRoot = document.createElement('div');
      viewRoot.setAttribute(VIEW_ATTR, '');

      var bar = document.createElement('div');
      bar.className = 'cw-viewbar';
      var title = document.createElement('span');
      title.className = 'cw-viewbar-title';
      title.innerHTML = ICON + '<span>城市水智管 · 水资源管理 Agent</span>';
      var actions = document.createElement('span');
      actions.className = 'cw-viewbar-actions';

      var refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'cw-viewbar-btn';
      refresh.title = '刷新工作台';
      refresh.innerHTML = REFRESH_ICON;
      refresh.addEventListener('click', function () {
        try { if (frameEl !== undefined) frameEl.src = VIEW_URL; } catch (e) { /* ignore */ }
      });

      var popout = document.createElement('button');
      popout.type = 'button';
      popout.className = 'cw-viewbar-btn';
      popout.title = '在标签页打开';
      popout.innerHTML = POPOUT_ICON;
      popout.addEventListener('click', function () { try { window.open(VIEW_URL, '_blank', 'noopener'); } catch (e) { /* ignore */ } });

      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'cw-viewbar-btn';
      close.title = '关闭（返回 Agent 对话）';
      close.innerHTML = CLOSE_ICON;
      close.addEventListener('click', function () { setActive(false); });

      actions.appendChild(refresh);
      actions.appendChild(popout);
      actions.appendChild(close);
      bar.appendChild(title);
      bar.appendChild(actions);

      frameEl = document.createElement('iframe');
      frameEl.className = 'cw-frame';
      frameEl.src = VIEW_URL;
      frameEl.title = '城市水智管';
      frameEl.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms allow-popups allow-downloads');

      viewRoot.appendChild(bar);
      viewRoot.appendChild(frameEl);
      pane.appendChild(viewRoot);
      return viewRoot;
    }

    function toggleView() {
      if (isActive()) { setActive(false); return; }
      if (ensureView() === undefined) {
        window.alert('城市水智管暂不可用：页面挂载点未就绪（请稍后重试）。');
        return;
      }
      // 中心列单占用者约定：打开本面板时让位其他面板插件。
      for (var i = 0; i < SIBLING_ATTRS.length; i++) {
        document.documentElement.removeAttribute(SIBLING_ATTRS[i]);
      }
      document.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: 'city-water' }));
      setActive(true);
    }

    function onOtherActivate(event) {
      var detail = event.detail;
      if (detail !== undefined && detail !== 'city-water' && isActive()) setActive(false);
    }
    document.addEventListener(PANEL_EVENT, onOtherActivate);

    // ---- 任务桥：工作台 iframe → 原生 composer ----

    /** React 受控 textarea 兼容写入：原生 value setter + input 事件。 */
    function setNativeValue(textarea, text) {
      var proto = window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : undefined;
      var setter = proto !== undefined ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : undefined;
      if (setter !== undefined) {
        setter.call(textarea, text);
      } else {
        textarea.value = text;
      }
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function findComposerTextarea() {
      var candidates = document.querySelectorAll(
        '[data-composer-seat] textarea, [data-pane="conversation"] textarea, [class*="centerCol"] textarea',
      );
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (el.disabled || el.readOnly || el.closest('[' + VIEW_ATTR + ']')) continue;
        var rect = el.getBoundingClientRect();
        if (rect.width > 60 && rect.height > 20) return el;
      }
      return undefined;
    }

    async function copyToClipboard(text) {
      try {
        if (navigator.clipboard !== undefined && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) { /* fall through */ }
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e) { return false; }
    }

    function handoffTask(text) {
      setActive(false); // 先揭示原生会话区
      var composer = findComposerTextarea();
      if (composer !== undefined) {
        try {
          setNativeValue(composer, text);
          composer.focus();
          if (typeof composer.setSelectionRange === 'function') {
            var end = text.length;
            try { composer.setSelectionRange(end, end); } catch (e) { /* ignore */ }
          }
          toast('<b>任务已填入 Agent 对话输入框</b>，确认后回车发送 —— 研判由 DSH 原生会话执行（模型 / 工具 / 历史 / 审批全部原生）。');
          return;
        } catch (e) { /* fall through to clipboard */ }
      }
      void copyToClipboard(text).then(function (ok) {
        toast(ok
          ? '<b>任务已复制到剪贴板</b>，请粘贴到 Agent 对话输入框发送（当前页面版本未识别到输入框）。'
          : '任务转交未完成：请返回 DSH 会话区，手动输入任务提交。');
      });
    }

    function onMessage(event) {
      if (event.origin !== window.location.origin) return;
      if (frameEl !== undefined && event.source !== frameEl.contentWindow) return;
      if (event.data === undefined || event.data === null) return;
      if (typeof event.data !== 'object') return;
      if (event.data.type === 'dsh-city-water:close') {
        setActive(false);
        return;
      }
      if (event.data.type !== TASK_EVENT) return;
      var text = event.data.text;
      if (typeof text !== 'string' || text.trim() === '') return;
      handoffTask(text.trim());
    }
    window.addEventListener('message', onMessage);

    // ---- 侧栏入口（自愈挂载）----

    function sidebarRoot() {
      var column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
      if (column === null) return undefined;
      var logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement;
      return logoOwner ?? (column.firstElementChild || undefined);
    }

    function newSessionButton(root) {
      var nested = root.querySelector('button[class*="newSession"]');
      if (nested !== null) return nested;
      for (var i = 0; i < root.children.length; i++) {
        if (root.children[i].tagName === 'BUTTON') return root.children[i];
      }
      return undefined;
    }

    function createEntry() {
      var entry = document.createElement('button');
      entry.type = 'button';
      entry.setAttribute(ENTRY_ATTR, '');
      entry.className = 'cw-entry';
      entry.setAttribute('aria-label', '城市水智管');
      entry.innerHTML = '<span class="cw-entry-icon">' + ICON + '</span><span class="cw-entry-label">城市水智管</span>';
      entry.addEventListener('click', function () { toggleView(); });
      entryButton = entry;
      return entry;
    }

    function placeEntry(root, entry) {
      var button = newSessionButton(root);
      if (button === undefined) return false;
      if (entry.parentElement !== root) {
        var row = button.closest('[class*="logoRow"]');
        var base = (row !== null && row.parentElement === root) ? row : button;
        var family = [];
        for (var i = 0; i < root.children.length; i++) {
          var el = root.children[i];
          if (el instanceof HTMLElement && el.matches(
            '[data-dsh-law-entry], [data-dsh-lawbench-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-personal-workbench-entry], [' + ENTRY_ATTR + ']',
          )) family.push(el);
        }
        var anchor = family.length > 0 ? family[0] : base.nextElementSibling;
        root.insertBefore(entry, anchor);
      }
      return true;
    }

    function mountSidebarEntry() {
      var entry = createEntry();
      var root;
      var placed = false;

      var tryPlace = function () {
        if (root !== undefined && !root.isConnected) {
          rootObserver.disconnect();
          root = undefined;
          placed = false;
        }
        if (placed) {
          if (document.body.contains(entry)) return;
          rootObserver.disconnect();
          root = undefined;
          placed = false;
        }
        if (root === undefined) root = sidebarRoot();
        if (root === undefined) return;
        placed = placeEntry(root, entry);
        if (placed) rootObserver.observe(root, { childList: true, subtree: true });
      };

      var waitObserver = new MutationObserver(function () { tryPlace(); });
      waitObserver.observe(document.body, { childList: true, subtree: true });

      var rootObserver = new MutationObserver(function () {
        if (root === undefined || !root.isConnected) { placed = false; tryPlace(); return; }
        if (!root.contains(entry)) placed = placeEntry(root, entry);
      });

      tryPlace();

      return function () {
        waitObserver.disconnect();
        rootObserver.disconnect();
        entry.remove();
        entryButton = undefined;
        setActive(false);
        if (viewRoot !== undefined) { viewRoot.remove(); viewRoot = undefined; }
        frameEl = undefined;
      };
    }

    function apply(ctx) {
      ensureStyle();
      var disposers = [];
      try { disposers.push(mountSidebarEntry()); }
      catch (error) { console.warn('[dsh-city-water] mount failed:', error); }
      ctx.effect(function () {
        return function () {
          document.removeEventListener(PANEL_EVENT, onOtherActivate);
          window.removeEventListener('message', onMessage);
          for (var i = 0; i < disposers.length; i++) disposers[i]();
        };
      }, 'dsh-city-water: ui mounts');
    }

    exports.apply = apply;
    exports.inject = inject;
    return exports;
  },
});
