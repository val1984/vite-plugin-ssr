export { renderPage }
export { renderPage_setWrapper }

import {
  getRenderContext,
  initPageContext,
  RenderContext,
  renderPageAlreadyRouted
} from './renderPage/renderPageAlreadyRouted'
import { route } from '../../shared/route'
import { getErrorPageId } from '../../shared/error-page'
import {
  assert,
  hasProp,
  objectAssign,
  isParsable,
  parseUrl,
  assertEnv,
  assertWarning,
  getGlobalObject,
  assertUsage
} from './utils'
import { addComputedUrlProps } from '../../shared/addComputedUrlProps'
import { AbortError, isAbortError, logAbortErrorHandled } from '../../shared/route/RenderAbort'
import { getGlobalContext, initGlobalContext } from './globalContext'
import { handlePageContextRequestUrl } from './renderPage/handlePageContextRequestUrl'
import type { HttpResponse } from './renderPage/createHttpResponseObject'
import { logRuntimeError, logRuntimeInfo } from './renderPage/loggerRuntime'
import { isNewError } from './renderPage/isNewError'
import { assertArguments } from './renderPage/assertArguments'
import type { PageContextDebug } from './renderPage/debugPageFiles'
import { warnMissingErrorPage } from './renderPage/handleErrorWithoutErrorPage'
import { log404 } from './renderPage/log404'
import { isConfigInvalid } from './renderPage/isConfigInvalid'
import pc from '@brillout/picocolors'
import '../../utils/require-shim' // Ensure require shim for production

const globalObject = getGlobalObject('runtime/renderPage.ts', {
  httpRequestsCount: 0,
  pendingRequestsCount: 0
})
let renderPage_wrapper = async <PageContextReturn>(_httpRequestId: number, ret: () => Promise<PageContextReturn>) => ({
  pageContextReturn: await ret(),
  onRequestDone: () => {}
})
const renderPage_setWrapper = (wrapper: typeof renderPage_wrapper) => {
  renderPage_wrapper = wrapper
}

// `renderPage()` calls `renderPageAttempt()` while ensuring that errors are `console.error(err)` instead of `throw err`, so that `vite-plugin-ssr` never triggers a server shut down. (Throwing an error in an Express.js middleware shuts down the whole Express.js server.)
async function renderPage<
  PageContextAdded extends {},
  PageContextInit extends {
    /** @deprecated */
    url?: string
    /** The URL of the HTTP request */
    urlOriginal?: string
  }
>(
  pageContextInit: PageContextInit
): Promise<
  PageContextInit & { errorWhileRendering: null | unknown } & (
      | ({ httpResponse: HttpResponse } & PageContextAdded)
      | ({ httpResponse: null } & Partial<PageContextAdded>)
    )
> {
  assertArguments(...arguments)
  assert(hasProp(pageContextInit, 'urlOriginal', 'string'))
  assertEnv()

  if (skipRequest(pageContextInit.urlOriginal)) {
    const pageContextHttpReponseNull = getPageContextHttpResponseNull(pageContextInit)
    return pageContextHttpReponseNull
  }

  const httpRequestId = getRequestId()
  const urlToShowToUser = pc.bold(pageContextInit.urlOriginal)
  logHttpRequest(urlToShowToUser, httpRequestId)
  globalObject.pendingRequestsCount++

  const { pageContextReturn, onRequestDone } = await renderPage_wrapper(httpRequestId, () =>
    renderPageAndPrepare(pageContextInit, httpRequestId)
  )

  logHttpResponse(urlToShowToUser, httpRequestId, pageContextReturn)
  globalObject.pendingRequestsCount--
  onRequestDone()

  return pageContextReturn
}

type PageContextReturn = Awaited<ReturnType<typeof renderPage>>

async function renderPageAndPrepare(
  pageContextInit: { urlOriginal: string } & Record<string, unknown>,
  httpRequestId: number
): Promise<PageContextReturn> {
  // Invalid config
  const handleInvalidConfig = () => {
    logRuntimeInfo?.(pc.red(pc.bold("Couldn't load configuration: see error above.")), httpRequestId, 'error')
    const pageContextHttpReponseNull = getPageContextHttpResponseNull(pageContextInit)
    return pageContextHttpReponseNull
  }
  if (isConfigInvalid) {
    return handleInvalidConfig()
  }

  // Prepare context
  let renderContext: RenderContext
  try {
    await initGlobalContext()
    renderContext = await getRenderContext()
  } catch (err) {
    // Errors are expected since assertUsage() is used in both initGlobalContext() and getRenderContext().
    // initGlobalContext() and getRenderContext() don't call any user hooks => err isn't thrown from user code
    assert(!isAbortError(err))
    logRuntimeError(err, httpRequestId)
    const pageContextHttpReponseNull = getPageContextHttpResponseNullWithError(err, pageContextInit)
    return pageContextHttpReponseNull
  }
  if (isConfigInvalid) {
    return handleInvalidConfig()
  } else {
    // From now on, renderContext.pageConfigs contains all the configuration data; getVikeConfig() isn't called anymore for this request
  }

  return await renderPageAlreadyPrepared(pageContextInit, httpRequestId, renderContext, [])
}

async function renderPageAlreadyPrepared(
  pageContextInit: { urlOriginal: string } & Record<string, unknown>,
  httpRequestId: number,
  renderContext: RenderContext,
  pageContextsFromRewrite: PageContextFromRewrite[]
): Promise<PageContextReturn> {
  // TODO: Rename FirstAttempt => NominalPage
  let pageContextFirstAttemptSuccess: undefined | Awaited<ReturnType<typeof renderPageAttempt>>
  let pageContextFirstAttemptInit = {}
  {
    const pageContextFromAllRewrites = getPageContextFromRewrite(pageContextsFromRewrite)
    objectAssign(pageContextFirstAttemptInit, pageContextFromAllRewrites)
  }
  let errFirstAttempt: unknown
  {
    try {
      pageContextFirstAttemptSuccess = await renderPageAttempt(
        pageContextInit,
        pageContextFirstAttemptInit,
        renderContext,
        httpRequestId
      )
    } catch (err) {
      errFirstAttempt = err
      assert(errFirstAttempt)
      logRuntimeError(errFirstAttempt, httpRequestId)
    }
    if (!errFirstAttempt) {
      assert(pageContextFirstAttemptSuccess === pageContextFirstAttemptInit)
    }
  }

  // Log 404 info / missing error page warning
  const isFailure = !pageContextFirstAttemptSuccess || pageContextFirstAttemptSuccess.httpResponse?.statusCode !== 200
  {
    const noErrorPageDefined: boolean = !getErrorPageId(renderContext.pageFilesAll, renderContext.pageConfigs)
    if (noErrorPageDefined && isFailure) {
      const isV1 = renderContext.pageConfigs.length > 0
      assert(!pageContextFirstAttemptSuccess?.httpResponse)
      warnMissingErrorPage(isV1)
    }
    if (
      !!pageContextFirstAttemptSuccess &&
      'is404' in pageContextFirstAttemptSuccess &&
      pageContextFirstAttemptSuccess.is404 === true
    ) {
      await log404(pageContextFirstAttemptSuccess)
      const statusCode = pageContextFirstAttemptSuccess.httpResponse?.statusCode ?? null
      assert(statusCode === 404 || (noErrorPageDefined && statusCode === null))
    }
  }

  if (errFirstAttempt === undefined) {
    assert(pageContextFirstAttemptSuccess)
    return pageContextFirstAttemptSuccess
  } else {
    assert(errFirstAttempt)
    assert(pageContextFirstAttemptSuccess === undefined)
    assert(pageContextFirstAttemptInit)
    assert(hasProp(pageContextFirstAttemptInit, 'urlOriginal', 'string'))

    let pageContextFromRenderAbort: null | Record<string, unknown> = null
    if (isAbortError(errFirstAttempt)) {
      const { pageContextReturn, pageContextAddition } = await handleAbortError(
        errFirstAttempt,
        pageContextsFromRewrite,
        pageContextInit,
        pageContextFirstAttemptInit,
        httpRequestId,
        renderContext
      )
      if (pageContextReturn) {
        return pageContextReturn
      }
      pageContextFromRenderAbort = pageContextAddition
    }

    let pageContextErrorPage: undefined | Awaited<ReturnType<typeof renderPageErrorPage>>
    try {
      pageContextErrorPage = await renderPageErrorPage(
        pageContextInit,
        errFirstAttempt,
        pageContextFirstAttemptInit,
        renderContext,
        httpRequestId,
        pageContextFromRenderAbort
      )
    } catch (errErrorPage) {
      if (isAbortError(errErrorPage)) {
        const { pageContextReturn, pageContextAddition } = await handleAbortError(
          errErrorPage,
          pageContextsFromRewrite,
          pageContextInit,
          pageContextFirstAttemptInit,
          httpRequestId,
          renderContext
        )
        if (!pageContextReturn) {
          assertWarning(
            false,
            `Cannot render error page because \`throw renderErrorPage()\` was called: make sure \`throw renderErrorPage()\` isn't called upon rendering the error page.`,
            { onlyOnce: false }
          )
          const pageContextHttpReponseNull = getPageContextHttpResponseNullWithError(errFirstAttempt, pageContextInit)
          return pageContextHttpReponseNull
        } else {
          return pageContextReturn
        }
      }
      if (isNewError(errErrorPage, errFirstAttempt)) {
        logRuntimeError(errErrorPage, httpRequestId)
      }
      const pageContextHttpReponseNull = getPageContextHttpResponseNullWithError(errFirstAttempt, pageContextInit)
      return pageContextHttpReponseNull
    }
    return pageContextErrorPage
  }
}

function logHttpRequest(urlToShowToUser: string, httpRequestId: number) {
  const clearErrors = globalObject.pendingRequestsCount === 0
  logRuntimeInfo?.(`HTTP request: ${urlToShowToUser}`, httpRequestId, 'info', clearErrors)
}
function logHttpResponse(urlToShowToUser: string, httpRequestId: number, pageContextReturn: PageContextReturn) {
  const statusCode = pageContextReturn.httpResponse?.statusCode ?? null
  const color = (s: number | string) => pc.bold(statusCode !== 200 ? pc.red(s) : pc.green(s))
  logRuntimeInfo?.(
    `HTTP response ${urlToShowToUser} ${color(statusCode ?? 'ERR')}`,
    httpRequestId,
    statusCode === 200 || statusCode === 404 ? 'info' : 'error'
  )
}

function getPageContextHttpResponseNullWithError(err: unknown, pageContextInit: Record<string, unknown>) {
  const pageContextHttpReponseNull = {}
  objectAssign(pageContextHttpReponseNull, pageContextInit)
  objectAssign(pageContextHttpReponseNull, {
    httpResponse: null,
    errorWhileRendering: err
  })
  return pageContextHttpReponseNull
}
function getPageContextHttpResponseNull(pageContextInit: Record<string, unknown>) {
  const pageContextHttpReponseNull = {}
  objectAssign(pageContextHttpReponseNull, pageContextInit)
  objectAssign(pageContextHttpReponseNull, {
    httpResponse: null,
    errorWhileRendering: null
  })
  return pageContextHttpReponseNull
}
function getPageContextHttpResponseRedirect(pageContextInit: Record<string, unknown>) {
  // TODO
  return getPageContextHttpResponseNull(pageContextInit)
}

async function renderPageAttempt<PageContextInit extends { urlOriginal: string }>(
  pageContextInit: PageContextInit,
  pageContext: { urlRewritten: null | string },
  renderContext: RenderContext,
  httpRequestId: number
) {
  {
    objectAssign(pageContext, { _httpRequestId: httpRequestId })
  }
  {
    const pageContextInitAddendum = initPageContext(pageContextInit, renderContext)
    objectAssign(pageContext, pageContextInitAddendum)
  }
  {
    const pageContextAddendum = handleUrl(pageContext)
    objectAssign(pageContext, pageContextAddendum)
  }
  if (!pageContext._hasBaseServer) {
    objectAssign(pageContext, { httpResponse: null, errorWhileRendering: null })
    return pageContext
  }

  addComputedUrlProps(pageContext)

  // *** Route ***
  const routeResult = await route(pageContext)
  objectAssign(pageContext, routeResult.pageContextAddendum)
  const is404 = hasProp(pageContext, '_pageId', 'string') ? null : true
  objectAssign(pageContext, { is404 })

  objectAssign(pageContext, { errorWhileRendering: null })
  const pageContextAfterRender = await renderPageAlreadyRouted(pageContext)
  assert(pageContext === pageContextAfterRender)
  return pageContextAfterRender
}

async function renderPageErrorPage<PageContextInit extends { urlOriginal: string }>(
  pageContextInit: PageContextInit,
  errFirstAttempt: unknown,
  pageContextFirstAttemptPartial: Record<string, unknown>,
  renderContext: RenderContext,
  httpRequestId: number,
  pageContextFromRenderAbort: null | Record<string, unknown>
): Promise<PageContextReturn> {
  const pageContext = {
    _httpRequestId: httpRequestId
  }
  {
    const pageContextInitAddendum = initPageContext(pageContextInit, renderContext)
    objectAssign(pageContext, pageContextInitAddendum)
  }
  {
    const pageContextAddendum = handleUrl(pageContext)
    objectAssign(pageContext, pageContextAddendum)
  }

  assert(errFirstAttempt)
  objectAssign(pageContext, {
    is404: false,
    _pageId: null,
    errorWhileRendering: errFirstAttempt as Error,
    routeParams: {} as Record<string, string>
  })

  addComputedUrlProps(pageContext)

  if (pageContextFromRenderAbort) {
    Object.assign(pageContext, pageContextFromRenderAbort)
  }

  objectAssign(pageContext, {
    _routeMatches: (pageContextFirstAttemptPartial as PageContextDebug)._routeMatches || 'ROUTE_ERROR'
  })

  assert(pageContext.errorWhileRendering)
  return renderPageAlreadyRouted(pageContext)
}

function handleUrl(pageContext: { urlOriginal: string; _baseServer: string; urlRewritten?: string | null }): {
  isClientSideNavigation: boolean
  _hasBaseServer: boolean
  _urlHandler: (urlOriginal: string) => string
} {
  const { urlOriginal, urlRewritten } = pageContext
  assert(isUrlValid(urlOriginal))
  assert(urlRewritten === undefined || urlRewritten === null || isUrlValid(urlRewritten))
  const { urlWithoutPageContextRequestSuffix, isPageContextRequest } = handlePageContextRequestUrl(urlOriginal)
  const hasBaseServer =
    parseUrl(urlWithoutPageContextRequestSuffix, pageContext._baseServer).hasBaseServer || !!urlRewritten
  const pageContextAddendum = {
    isClientSideNavigation: isPageContextRequest,
    _hasBaseServer: hasBaseServer,
    _urlHandler: (url: string) => handlePageContextRequestUrl(url).urlWithoutPageContextRequestSuffix
  }
  return pageContextAddendum
}

function isUrlValid(url: string) {
  return url.startsWith('/') || url.startsWith('http')
}

function getRequestId(): number {
  const httpRequestId = ++globalObject.httpRequestsCount
  assert(httpRequestId >= 1)
  return httpRequestId
}

function skipRequest(urlOriginal: string): boolean {
  const isViteClientRequest = urlOriginal.endsWith('/@vite/client') || urlOriginal.startsWith('/@fs/')
  assertWarning(
    !isViteClientRequest,
    `The vite-plugin-ssr middleware renderPage() was called with the URL ${urlOriginal} which is unexpected because the HTTP request should have already been handled by Vite's development middleware. Make sure to 1. install Vite's development middleware and 2. add Vite's middleware *before* vite-plugin-ssr's middleware, see https://vite-plugin-ssr.com/renderPage`,
    { onlyOnce: true }
  )
  return (
    urlOriginal.endsWith('/__vite_ping') ||
    urlOriginal.endsWith('/favicon.ico') ||
    !isParsable(urlOriginal) ||
    isViteClientRequest
  )
}

async function handleAbortError(
  errAbort: AbortError,
  pageContextsFromRewrite: PageContextFromRewrite[],
  pageContextInit: { urlOriginal: string },
  pageContextFirstAttemptInit: { urlOriginal: string; urlRewritten: null | string } & Record<string, unknown>,
  httpRequestId: number,
  renderContext: RenderContext
): Promise<{ pageContextReturn: PageContextReturn | null; pageContextAddition: Record<string, unknown> }> {
  {
    const { isProduction } = getGlobalContext()
    logAbortErrorHandled(errAbort, isProduction, pageContextFirstAttemptInit)
  }
  const pageContextAddition = errAbort._pageContextAddition
  if (pageContextAddition._abortCaller === 'renderUrl') {
    const pageContextReturn = await renderPageAlreadyPrepared(pageContextInit, httpRequestId, renderContext, [
      ...pageContextsFromRewrite,
      pageContextAddition
    ])
    return { pageContextReturn, pageContextAddition }
  }
  if (pageContextAddition._abortCaller === 'redirect') {
    const pageContextReturn = getPageContextHttpResponseRedirect(pageContextInit)
    return { pageContextReturn, pageContextAddition }
  }
  if (pageContextAddition._abortCaller === 'renderErrorPage') {
    return { pageContextReturn: null, pageContextAddition }
  }
  assert(false)
}
type PageContextFromRewrite = { urlRewritten: string } & Record<string, unknown>
function getPageContextFromRewrite(
  pageContextsFromRewrite: PageContextFromRewrite[]
): { urlRewritten: null | string } & Record<string, unknown> {
  assertNotInfiniteLoop(pageContextsFromRewrite)
  const pageContextFromRewriteFirst = pageContextsFromRewrite[0]
  if (!pageContextFromRewriteFirst) return { urlRewritten: null }
  const pageContextFromAllRewrites = pageContextFromRewriteFirst
  pageContextsFromRewrite.forEach((pageContextFromRewrite) => {
    Object.assign(pageContextFromAllRewrites, pageContextFromRewrite)
  })
  return pageContextFromAllRewrites
}
function assertNotInfiniteLoop(pageContextsFromRewrite: PageContextFromRewrite[]) {
  const urlRewrittenList: string[] = []
  pageContextsFromRewrite.forEach(({ urlRewritten }) => {
    {
      const idx = urlRewrittenList.indexOf(urlRewritten)
      if (idx !== -1) {
        const loop: string = [...urlRewrittenList.slice(idx), urlRewritten]
          .map((url) => `renderUrl(${url})`)
          .join(' => ')
        assertUsage(false, `Infinite loop of renderUrl() calls: ${loop}`)
      }
    }
    urlRewrittenList.push(urlRewritten)
  })
}
