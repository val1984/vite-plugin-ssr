export { getHook }
export { assertHook }
export { assertHookFn }
export type { Hook }

import { PageContextExports } from './getPageFiles'
import type { HookName } from './page-configs/Config'
import { assert, assertUsage, checkType, isCallable } from './utils'

type Hook = { hookFn: HookFn; hookFilePath: string }
type HookFn = (arg: unknown) => unknown

function getHook(pageContext: PageContextExports, hookName: HookName): null | Hook {
  if (!(hookName in pageContext.exports)) {
    return null
  }
  const hookFn = pageContext.exports[hookName]
  const file = pageContext.exportsAll[hookName]![0]!
  assert(file.exportValue === hookFn)
  const hookFilePath = file.exportSource
  assertHookFn(hookFn, { hookName, hookFilePath })
  return { hookFn, hookFilePath }
}

function assertHook<TPageContext extends PageContextExports, THookName extends PropertyKey & HookName>(
  pageContext: TPageContext,
  hookName: THookName
): asserts pageContext is TPageContext & { exports: Record<THookName, Function | undefined> } {
  getHook(pageContext, hookName)
}

function assertHookFn(
  hookFn: unknown,
  { hookName, hookFilePath }: { hookName: HookName; hookFilePath: string }
): asserts hookFn is HookFn {
  assert(hookName && hookFilePath)
  assert(!hookName.endsWith(')'))
  assertUsage(isCallable(hookFn), `hook ${hookName}() defined by ${hookFilePath} should be a function`)
  checkType<HookFn>(hookFn)
}
