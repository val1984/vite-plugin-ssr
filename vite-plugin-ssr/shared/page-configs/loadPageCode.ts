export { loadPageCode }

import { assert, assertDefaultExportUnknown, objectAssign } from '../utils'
import type { ConfigValue, PageConfig, PageConfigLoaded } from './PageConfig'

async function loadPageCode(pageConfig: PageConfig, isDev: boolean): Promise<PageConfigLoaded> {
  const configValues: ConfigValue[] = []

  if (
    pageConfig.isLoaded &&
    // We don't need to cache in dev, since Vite already caches the virtual module
    !isDev
  ) {
    return pageConfig as PageConfigLoaded
  }

  const codeFiles = await pageConfig.loadCodeFiles()

  codeFiles.forEach((codeFile) => {
    if (codeFile.isPlusFile) {
      const { codeFileExports, codeFilePath } = codeFile
      if (codeFile.configName !== 'client') {
        assertDefaultExportUnknown(codeFileExports, codeFilePath)
      }
      Object.entries(codeFileExports).forEach(([exportName, exportValue]) => {
        const isSideExport = exportName !== 'default' // .md files may have "side-exports" such as `export { frontmatter }`
        const configName = isSideExport ? exportName : codeFile.configName
        const alreadyDefined = !!configValues.find((v) => v.configName === configName)
        if (isSideExport && alreadyDefined) {
          // We don't (can't?) avoid side-export conflicts upstream.
          // We override the side-export.
          return
        }
        assert(!alreadyDefined) // Conflicts are resolved upstream
        configValues.push({
          configName,
          configSourceFile: codeFilePath,
          configSourceFileExportName: exportName,
          configValue: exportValue
        })
      })
    } else {
      const { configName } = codeFile
      const alreadyDefined = !!configValues.find((v) => v.configName === configName)
      assert(!alreadyDefined) // Conflicts are resolved upstream
      configValues.push({
        configName,
        configSourceFile: codeFile.codeFilePath,
        configSourceFileExportName: 'default',
        configValue: codeFile.codeFileExportValue
      })
    }
  })

  /* Remove? Conflicts are already handled
  const codeFileExports: ({ configVal: ConfigValue } & (
    | { isPlusFile: true; isSideExport: boolean }
    | { isPlusFile: false; isSideExport: null }
  ))[] = []
  codeFileExports
    .sort(
      lowerFirst((codeFileExport) => {
        const { isPlusFile, isSideExport } = codeFileExport
        if (isPlusFile) {
          if (isSideExport) {
            return 2
          } else {
            return 0
          }
        } else {
          return 1
        }
      })
    )
    .forEach((codeFileExport) => {
      const alreadyDefined = configValues.find(
        (configVal) => codeFileExport.configVal.configName === configVal.configName
      )
      if (!alreadyDefined) {
        configValues.push(codeFileExport.configVal)
      }
    })
  */

  objectAssign(pageConfig, { isLoaded: true as const })

  return pageConfig
}
