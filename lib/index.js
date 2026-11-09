/**
 * dsh-archive-confirm —— 宿主半侧。
 *
 * 本插件没有任何宿主逻辑：它存在只为两件事——
 * 1. 作为加载树里的挂载点（`cordis.patch.yml` 的 insert 行指向包名），
 *    这样 `dsh-client-modules` 才会扫描到本包的 `dsh.client` 声明，
 *    把 `./client` 发布成浏览器 bundle；
 * 2. 让插件能在「设置 → 插件」里被一键启停。
 *
 * 真正的拦截逻辑全在 `lib/client.js`（浏览器侧）。
 */

/** 稳定的插件名，与包名一致。 */
export const name = 'dsh-archive-confirm'

/**
 * 挂载点：宿主侧无需任何动作。
 * @returns {void}
 */
export function apply() {}
