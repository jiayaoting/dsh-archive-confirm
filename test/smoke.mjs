#!/usr/bin/env node
/**
 * dsh-archive-confirm 的离线自测：在 Node 里用最小桩件跑一遍浏览器半侧的核心逻辑。
 *
 * 覆盖五件事：
 * 1. 默认归档会被拦下并询问；确认后调用原方法；
 * 2. 取消时不调用原方法，抛出的拒绝带 ArchiveCancelledError 标记；
 * 3. `stopActivity: true`（官方「停止并归档」的第二次调用）直接透传，不弹框；
 * 4. 释放后原方法恢复，且平台模块缺失时降级为「直接归档」而不是阻断；
 * 5. 服务缺失时只记一条警告，不抛错。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const pluginPath = path.resolve(import.meta.dirname, '..', 'lib', 'client.js')

/**
 * 安装一遍浏览器全局桩件，返回捕获到的 factory。
 * @returns {Promise<Function>} 接收 require 的 factory。
 */
async function loadFactory() {
  let captured = null
  globalThis.window = {
    __ModuleLoader__: {
      load(options) {
        captured = options
      },
    },
  }
  // Node 自带的 navigator 只有 getter，这里换成可控桩件。
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN' },
    configurable: true,
    writable: true,
  })
  globalThis.document = {
    createElement() {
      return { dataset: {}, style: {}, textContent: '', append() {}, remove() {} }
    },
    head: { append() {} },
    body: { append() {} },
    querySelector() {
      return null
    },
    addEventListener() {},
    removeEventListener() {},
  }
  // 插件脚本没有 import/export，直接按脚本求值一次：既绕开 ESM 缓存，也贴近浏览器加载方式。
  const code = fs.readFileSync(pluginPath, 'utf8')
  new Function(code)()
  assert.ok(captured !== null, '模块应调用 __ModuleLoader__.load')
  return (request) => captured.factory(request)
}

/**
 * 最小的 React 桩件：够跑确认框的渲染路径。
 * @returns {object} React 替身。
 */
function reactStub() {
  return {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children } }
    },
    Fragment: 'Fragment',
    useSyncExternalStore(subscribe, read) {
      return read()
    },
    useEffect(fn) {
      fn()
    },
  }
}

/**
 * 每次渲染都把根元素记下来，方便测试手动驱动一次重渲染。
 * @param {object} state - 保存当前渲染树的容器。
 * @returns {object} react-dom/client 替身。
 */
function rootStub(state) {
  return {
    createRoot() {
      return {
        render(element) {
          state.tree = element
        },
        unmount() {
          state.tree = null
        },
      }
    },
  }
}

/**
 * 造一个假服务：记录调用，返回给定结果。
 * @returns {object} uiWorkspace 替身。
 */
function serviceStub() {
  const calls = []
  return {
    calls,
    async archiveSession(sessionId, options) {
      calls.push({ sessionId, options })
      return 'archived'
    },
  }
}

/**
 * 从当前渲染树里取出确认框的请求对象。
 * @param {object} state - 渲染树容器。
 * @returns {object} 带 finish 的请求对象。
 */
function takeRequest(state) {
  assert.ok(state.tree !== null, '应已渲染确认框根节点')
  const element = state.tree.type(state.tree.props)
  assert.ok(element !== null, '确认框应处于打开状态')
  assert.ok(element.props.request !== undefined, '确认框应带上本次请求')
  return element.props.request
}

/**
 * 造一份插件依赖桩件。
 * @param {object} state - 渲染树容器。
 * @returns {Function} require 替身。
 */
function requireStub(state) {
  const React = reactStub()
  const { createRoot } = rootStub(state)
  return (id) => {
    if (id === 'react') return React
    if (id === 'react-dom/client') return { createRoot }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: 'Modal', Button: 'Button' }
    throw new Error(`unexpected require: ${id}`)
  }
}

/**
 * 用例 1、2、4：拦下 → 取消 / 确认 / 释放还原。
 * @returns {Promise<void>} 无返回值。
 */
async function caseCancelConfirmAndRestore() {
  const state = {}
  const factory = await loadFactory()
  const plugin = factory(requireStub(state))
  const service = serviceStub()
  const original = service.archiveSession
  const disposers = []
  plugin.apply({
    uiWorkspace: service,
    effect(factoryFn) {
      disposers.push(factoryFn())
    },
  })
  assert.notEqual(service.archiveSession, original, '应已包装 archiveSession')

  // 取消：不应调用原方法，拒绝带标记。
  const cancelPending = service.archiveSession('s-cancel')
  takeRequest(state).finish(false)
  await assert.rejects(cancelPending, (error) => {
    assert.equal(error.name, 'ArchiveCancelledError')
    assert.equal(error.cancelledByUser, true)
    return true
  })
  assert.equal(service.calls.length, 0, '取消时不应真正归档')

  // 确认：调用原方法，返回值透传。
  const confirmPending = service.archiveSession('s-confirm')
  takeRequest(state).finish(true)
  assert.equal(await confirmPending, 'archived')
  assert.deepEqual(service.calls, [{ sessionId: 's-confirm', options: undefined }])

  // 释放后恢复原方法。
  for (const dispose of disposers) dispose()
  assert.equal(service.archiveSession, original, '释放后应还原原方法')
  console.log('✓ 取消 / 确认 / 还原')
}

/**
 * 用例 3：stopActivity 直接透传，不弹框。
 * @returns {Promise<void>} 无返回值。
 */
async function caseStopActivityPassThrough() {
  const state = {}
  const factory = await loadFactory()
  const plugin = factory(requireStub(state))
  const service = serviceStub()
  plugin.apply({
    uiWorkspace: service,
    effect(factoryFn) {
      factoryFn()
    },
  })

  assert.equal(await service.archiveSession('s-busy', { stopActivity: true }), 'archived')
  assert.equal(state.tree, undefined, '透传时不应挂载确认框')
  assert.deepEqual(service.calls, [{ sessionId: 's-busy', options: { stopActivity: true } }])
  console.log('✓ stopActivity 透传不弹框')
}

/**
 * 用例 5：平台模块缺失时降级为直接归档，不阻断。
 * @returns {Promise<void>} 无返回值。
 */
async function caseDegraded() {
  const factory = await loadFactory()
  const plugin = factory(() => {
    throw new Error('platform module missing')
  })
  const service = serviceStub()
  plugin.apply({
    uiWorkspace: service,
    effect(factoryFn) {
      factoryFn()
    },
  })

  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    assert.equal(await service.archiveSession('s-degraded'), 'archived')
  } finally {
    console.warn = originalWarn
  }
  assert.equal(service.calls.length, 1, '降级时应照旧归档')
  assert.ok(warnings.length >= 1, '应记降级警告')
  assert.ok(
    warnings.some((line) => line.includes('直接归档')),
    '应说明已降级为直接归档',
  )
  console.log('✓ 平台模块缺失时降级放行')
}

/**
 * 用例 6：服务缺失时安静跳过。
 * @returns {Promise<void>} 无返回值。
 */
async function caseNoService() {
  const factory = await loadFactory()
  const plugin = factory(() => {
    throw new Error('unused')
  })
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    plugin.apply({
      uiWorkspace: undefined,
      effect(factoryFn) {
        factoryFn()
      },
    })
  } finally {
    console.warn = originalWarn
  }
  assert.equal(warnings.length, 1, '应只记一条警告')
  assert.match(warnings[0], /未找到 uiWorkspace\.archiveSession/)
  console.log('✓ 服务缺失时只记警告、不抛错')
}

await caseCancelConfirmAndRestore()
await caseStopActivityPassThrough()
await caseDegraded()
await caseNoService()
console.log('全部通过')
