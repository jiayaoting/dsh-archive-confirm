/**
 * dsh-archive-confirm —— 浏览器半侧。
 *
 * 目的：给「归档会话」补一道二次确认，挡住侧栏行尾图标、右键菜单、
 * 快捷键这几处最常见的误触。
 *
 * 做法：不改 DSH 本体，只在 `uiWorkspace` 服务上包一层 `archiveSession`。
 * 官方的行内按钮、菜单项、快捷键都汇到这一个方法，因此一处拦截即可覆盖
 * 全部入口；将来若侧栏换成第三方实现，只要它仍走同一方法也自动生效。
 *
 * 边界与降级：
 * - 带 `stopActivity: true` 的调用是官方「停止并归档」对话框确认后的第二次
 *   调用，这里直接透传，避免连环弹两个框；
 * - 用户取消时抛出标记为 `ArchiveCancelledError` 的拒绝，官方调用方只会记
 *   一条 console 警告，既不会弹错误提示，也不会误报「已归档」；
 * - 服务缺失、方法不可写、弹窗渲染不出，任何一种情况都回落到原有行为
 *   （直接归档），绝不阻断归档，也不会破坏界面。
 *
 * 平台依赖只有 `react` / `react-dom/client` / `@deepseek-ai/dsh-client-ui-primitives`
 * 三个静态模块，都来自 shell 的 seed 表；缺失时退化为自绘弹窗。
 */
window.__ModuleLoader__.load({
  id: 'dsh-archive-confirm',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    /** 稳定的插件名，与包名一致。 */
    const name = 'dsh-archive-confirm'
    /** 只依赖工作区 UI 服务：拿不到它就不做任何事。 */
    const inject = ['uiWorkspace']

    /** 弹窗容器的 id。 */
    const ROOT_ID = 'dsh-archive-confirm-root'
    /** 标记位：避免热更新时重复包装同一份方法。 */
    const PATCH_MARK = '__dshArchiveConfirm'
    /** 样式节点的标记，用于自绘弹窗降级路径。 */
    const STYLE_MARK = 'dsh-archive-confirm-style'

    /** 应用语言在浏览器侧由 navigator.language 体现。 */
    const LANG = String((typeof navigator !== 'undefined' && navigator.language) || 'zh')
      .toLowerCase()
      .startsWith('zh')
      ? 'zh'
      : 'en'

    /** 两种语言的文案；其余语言回落到中文（用户主语言）。 */
    const TEXT = {
      zh: {
        title: '归档这个会话？',
        body: '它会从侧栏移除，之后可以在「设置 → 已归档会话」里恢复。归档不会删除任何聊天记录。',
        hintRunning: '若该会话仍在运行，确认后还会再询问是否停止它正在进行的工作。',
        cancel: '取消',
        action: '归档',
        close: '关闭',
      },
      en: {
        title: 'Archive this session?',
        body: 'It leaves the sidebar and can be restored later under Settings → Archived sessions. Archiving never deletes the transcript.',
        hintRunning: 'If this session still has work running, a second prompt will ask whether to stop it.',
        cancel: 'Cancel',
        action: 'Archive',
        close: 'Close',
      },
    }
    const T = TEXT[LANG] === undefined ? TEXT.zh : TEXT[LANG]

    /** 打印告警：任何降级都要留痕，方便排查。 */
    function warn(message, error) {
      console.warn(`[${name}] ${message}`, error === undefined ? '' : error)
    }

    /* ------------------------------------------------------------------ *
     * 平台模块：延迟加载，缺一个就降级
     * ------------------------------------------------------------------ */

    const modules = {
      loaded: false,
      React: null,
      createRoot: null,
      primitives: null,
    }

    /**
     * 取平台静态模块（seed 表）。
     * @returns {{React: object|null, createRoot: Function|null, primitives: object|null}}
     */
    function loadModules() {
      if (modules.loaded) return modules
      modules.loaded = true
      try {
        modules.React = require('react')
      } catch (error) {
        warn('react 不可用，确认框将降级为「不询问」', error)
      }
      try {
        modules.createRoot = require('react-dom/client').createRoot
      } catch (error) {
        warn('react-dom/client 不可用，确认框将降级为「不询问」', error)
      }
      try {
        modules.primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      } catch (error) {
        warn('UI 组件库不可用，确认框将降级为自绘弹窗', error)
      }
      return modules
    }

    /* ------------------------------------------------------------------ *
     * 极简外部 store：把弹窗状态喂给 React 组件
     * ------------------------------------------------------------------ */

    /**
     * 创建快照 store。
     * @returns {{read: Function, write: Function, subscribe: Function}} store。
     */
    function createStore() {
      let snapshot = null
      const listeners = new Set()
      return {
        read: () => snapshot,
        write(next) {
          snapshot = next
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    /* ------------------------------------------------------------------ *
     * 确认框
     * ------------------------------------------------------------------ */

    /** 自绘弹窗的样式：只在官方组件库缺失时注入。 */
    function ensureStyle() {
      if (document.querySelector(`style[data-plugin="${STYLE_MARK}"]`) !== null) return
      const style = document.createElement('style')
      style.dataset.plugin = STYLE_MARK
      style.textContent = `
        .dac-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
          background:color-mix(in srgb, var(--dsw-alias-bg-inverse, #000) 32%, transparent);backdrop-filter:blur(6px)}
        .dac-card{box-sizing:border-box;width:min(440px,calc(100vw - 32px));padding:20px 22px 18px;border-radius:14px;
          background:var(--dsw-alias-bg-base, #fff);color:var(--dsw-alias-label-primary, #1a1a1a);
          border:1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.08));
          box-shadow:0 24px 60px -20px rgba(0,0,0,.45);font-family:inherit}
        .dac-title{margin:0 0 8px;font-size:15px;font-weight:600;line-height:1.4}
        .dac-body{margin:0 0 6px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary, #5a5a5a)}
        .dac-hint{margin:0 0 16px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary, #8a8a8a)}
        .dac-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
        .dac-btn{height:32px;padding:0 14px;border-radius:8px;font-size:13px;cursor:pointer;
          border:1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.12));
          background:transparent;color:var(--dsw-alias-label-primary, #1a1a1a)}
        .dac-btn:hover{background:var(--dsw-alias-bg-secondary, rgba(0,0,0,.04))}
        .dac-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary, #4d6bfe);outline-offset:2px}
        .dac-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary, #4d6bfe);color:#fff}
        .dac-btn-primary:hover{filter:brightness(1.06)}
      `
      document.head.append(style)
    }

    /**
     * 创建确认框：懒挂载 React 根，一次只询问一个会话。
     * @returns {{ask: Function, dispose: Function}} 询问与释放。
     */
    function createDialog() {
      const store = createStore()
      let mounted = false
      let root = null
      let container = null
      let busy = false

      /** 降级路径：官方组件库缺失时用的自绘弹窗（带 Esc 关闭）。 */
      function FallbackDialog(props) {
        const React = modules.React
        const request = props.request
        React.useEffect(() => {
          const onKeyDown = (event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              request.finish(false)
            }
          }
          document.addEventListener('keydown', onKeyDown, true)
          return () => document.removeEventListener('keydown', onKeyDown, true)
        }, [request])
        return React.createElement(
          'div',
          { className: 'dac-backdrop' },
          React.createElement(
            'div',
            { className: 'dac-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': T.title },
            React.createElement('h2', { className: 'dac-title' }, T.title),
            React.createElement('p', { className: 'dac-body' }, T.body),
            React.createElement('p', { className: 'dac-hint' }, T.hintRunning),
            React.createElement(
              'div',
              { className: 'dac-actions' },
              React.createElement(
                'button',
                { type: 'button', className: 'dac-btn', autoFocus: true, onClick: () => request.finish(false) },
                T.cancel,
              ),
              React.createElement(
                'button',
                { type: 'button', className: 'dac-btn dac-btn-primary', onClick: () => request.finish(true) },
                T.action,
              ),
            ),
          ),
        )
      }

      /** 主路径：复用官方 Modal / Button，外观与「停止并归档」一致。 */
      function OfficialDialog(props) {
        const React = modules.React
        const { Modal, Button } = modules.primitives
        const request = props.request
        return React.createElement(
          Modal,
          {
            open: true,
            onClose: () => request.finish(false),
            closeLabel: T.close,
            title: T.title,
            description: T.body,
            footer: React.createElement(
              React.Fragment,
              null,
              React.createElement(
                Button,
                { variant: 'outline', 'data-modal-autofocus': '', onClick: () => request.finish(false) },
                T.cancel,
              ),
              React.createElement(Button, { variant: 'primary', onClick: () => request.finish(true) }, T.action),
            ),
          },
          React.createElement('p', { className: 'dac-hint', style: { margin: 0 } }, T.hintRunning),
        )
      }

      /** 首次询问时才挂载 React 根，平时零开销。 */
      function ensureMounted() {
        if (mounted) return true
        const { React, createRoot } = modules
        if (React === null || createRoot === null) return false
        try {
          container = document.createElement('div')
          container.id = ROOT_ID
          document.body.append(container)
          root = createRoot(container)
          const App = () => {
            const snapshot = React.useSyncExternalStore(store.subscribe, store.read, store.read)
            if (snapshot === null) return null
            const hasPrimitives = modules.primitives !== null && typeof modules.primitives.Modal === 'function'
            if (hasPrimitives) return React.createElement(OfficialDialog, { request: snapshot })
            ensureStyle()
            return React.createElement(FallbackDialog, { request: snapshot })
          }
          root.render(React.createElement(App))
          mounted = true
          return true
        } catch (error) {
          // 挂载失败不能把归档卡住：清理残留并交给调用方按原行为放行。
          warn('确认框挂载失败，本次直接归档（保持原行为）', error)
          if (root !== null) {
            try {
              root.unmount()
            } catch (unmountError) {
              warn('清理确认框失败', unmountError)
            }
          }
          if (container !== null) container.remove()
          root = null
          container = null
          return false
        }
      }

      /**
       * 询问用户是否归档。
       * @returns {Promise<boolean>} true 表示确认归档；渲染不出弹窗时也返回 true（保持原行为）。
       */
      function ask() {
        if (busy) return Promise.resolve(false)
        loadModules()
        if (!ensureMounted()) {
          warn('无法挂载确认框，本次直接归档（保持原行为）')
          return Promise.resolve(true)
        }
        busy = true
        let watchdog = null
        return new Promise((resolve) => {
          const finish = (confirmed) => {
            if (!busy) return
            busy = false
            if (watchdog !== null) clearTimeout(watchdog)
            store.write(null)
            resolve(confirmed === true)
          }
          // 兜底：弹窗若因渲染异常始终不给答案，30 秒后按「取消」收口，避免归档被无限挂起。
          watchdog = setTimeout(() => {
            warn('确认框 30 秒内没有结果，按取消处理')
            finish(false)
          }, 30000)
          store.write({ finish })
        })
      }

      /** 卸载弹窗：插件被停用或热更新时调用。 */
      function dispose() {
        busy = false
        store.write(null)
        if (root !== null) root.unmount()
        if (container !== null) container.remove()
        root = null
        container = null
        mounted = false
      }

      return { ask, dispose }
    }

    /* ------------------------------------------------------------------ *
     * 服务包装
     * ------------------------------------------------------------------ */

    /** 用户取消归档时抛出的拒绝：调用方只记警告，不弹错误提示。 */
    function cancelledArchive() {
      const error = new Error('archive cancelled by user')
      error.name = 'ArchiveCancelledError'
      error.cancelledByUser = true
      return error
    }

    /**
     * 把包装后的方法装到服务实例或它的原型上。
     * @param {object} service - uiWorkspace 服务实例。
     * @param {Function} original - 原始 archiveSession。
     * @param {Function} wrapped - 包装后的 archiveSession。
     * @returns {Function|null} 还原函数；装不上返回 null。
     */
    function swapArchiveSession(service, original, wrapped) {
      try {
        service.archiveSession = wrapped
        if (service.archiveSession === wrapped) {
          return () => {
            service.archiveSession = original
          }
        }
      } catch (error) {
        warn('实例方法不可写，改用原型包装', error)
      }
      try {
        const proto = Object.getPrototypeOf(service)
        const descriptor = proto === null ? undefined : Object.getOwnPropertyDescriptor(proto, 'archiveSession')
        if (proto !== null && descriptor !== undefined && descriptor.writable !== false && descriptor.set === undefined) {
          proto.archiveSession = wrapped
          if (proto.archiveSession === wrapped) {
            return () => {
              proto.archiveSession = original
            }
          }
        }
      } catch (error) {
        warn('原型方法不可写', error)
      }
      return null
    }

    /**
     * 安装拦截：包一层 uiWorkspace.archiveSession。
     * @param {object} ctx - 客户端插件上下文。
     * @returns {Function} 还原函数。
     */
    function install(ctx) {
      const service = ctx.uiWorkspace
      if (service === undefined || service === null || typeof service.archiveSession !== 'function') {
        warn('未找到 uiWorkspace.archiveSession，本次不做任何拦截')
        return () => {}
      }
      const original = service.archiveSession
      if (original[PATCH_MARK] === true) return () => {}

      const dialog = createDialog()
      const wrapped = async function archiveSession(sessionId, options) {
        // 官方「停止并归档」对话框确认后的第二次调用：不再重复询问。
        if (options !== undefined && options !== null && options.stopActivity === true) {
          return original.call(this, sessionId, options)
        }
        const confirmed = await dialog.ask()
        if (!confirmed) throw cancelledArchive()
        return original.call(this, sessionId, options)
      }
      Object.defineProperty(wrapped, PATCH_MARK, { value: true })

      const restore = swapArchiveSession(service, original, wrapped)
      if (restore === null) {
        warn('无法包装 uiWorkspace.archiveSession，本次不做任何拦截')
        return () => {}
      }
      // 自检标记：控制台里能看到这行，就说明拦截已生效。
      window.__dshArchiveConfirm = { version: '0.1.0', patched: true }
      console.info(`[${name}] 已启用：归档会话前会二次确认`)
      return () => {
        restore()
        dialog.dispose()
        delete window.__dshArchiveConfirm
      }
    }

    /**
     * 挂载：包装一次，停用时还原。
     * @param {object} ctx - 客户端插件上下文。
     * @returns {void}
     */
    function apply(ctx) {
      ctx.effect(() => install(ctx), `${name}: archive confirmation`)
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
