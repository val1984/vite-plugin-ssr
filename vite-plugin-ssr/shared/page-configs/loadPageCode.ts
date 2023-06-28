export { loadPageCode }

import { assertDefaultExportUnknown, objectAssign } from '../utils'
import type { ConfigValues, PageConfig, PageConfigLoaded } from './PageConfig'

async function loadPageCode(pageConfig: PageConfig, isDev: boolean): Promise<PageConfigLoaded> {
  const configValues: ConfigValues = {}

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
        configValues[configName] = {
          configSourceFile: codeFilePath,
          configSourceFileExportName: exportName,
          configValue: exportValue
        }
      })
    } else {
      const { configName } = codeFile
      configValues[configName] = {
        configSourceFile: codeFile.codeFilePath,
        configSourceFileExportName: 'default',
        configValue: codeFile.codeFileExportValue
      }
    }
  })

  objectAssign(pageConfig, { isLoaded: true as const })

  return pageConfig
}
