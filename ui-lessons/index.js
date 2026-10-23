/**
 * 「教训」tab 的宿主半边。
 *
 * 浏览器半边是 lib/client.js，由 client-modules 通过本包 package.json 的
 * dsh.client 与 exports["./client"] 发现并下发。数据来自 lessons 主机插件注册的
 * /lessons/state|confirm|forget，所以这一侧没有别的行为。
 */

/** 宿主侧无行为。 */
export function apply() {}
