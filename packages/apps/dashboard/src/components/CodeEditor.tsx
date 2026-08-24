'use client'

import Editor, { type Monaco } from '@monaco-editor/react'

/**
 * Monaco wired to the framework: the gateway serves every .d.ts of
 * @openwhaleorg/core, @openwhaleorg/exchange and zod, and each is registered
 * under file:///node_modules/<pkg>/… — so `import { BaseStrategy } from
 * '@openwhaleorg/core'` resolves and completions carry the real constraints
 * (params schemas, instruction shapes, reader surfaces), not just colors.
 */

let typedefsPromise: Promise<Record<string, string>> | null = null
function loadTypedefs(): Promise<Record<string, string>> {
  typedefsPromise ??= fetch('/api/compiler/typedefs')
    .then(res => (res.ok ? res.json() as Promise<Record<string, string>> : {}))
    .catch(() => ({}))
  return typedefsPromise
}

const wired = new WeakSet<object>()

function wireMonaco(monaco: Monaco): void {
  if (wired.has(monaco)) return
  wired.add(monaco)

  monaco.editor.defineTheme('openwhale-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#101018',
      'editorGutter.background': '#101018',
      'minimap.background': '#101018',
    },
  })

  const ts = monaco.languages.typescript.typescriptDefaults
  ts.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2020,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    strict: true,
    noEmit: true,
  })
  ts.setEagerModelSync(true)

  void loadTypedefs().then((files) => {
    for (const [rel, content] of Object.entries(files)) {
      ts.addExtraLib(content, `file:///node_modules/${rel}`)
    }
  })
}

export function CodeEditor({ path, value, onChange, readOnly, height }: {
  /** Model path — one model per file, e.g. 'strategies/my-strategy.ts'. */
  path: string
  value: string
  onChange?: (code: string) => void
  readOnly?: boolean
  height?: string | number
}) {
  return (
    <Editor
      path={`file:///work/${path}`}
      defaultLanguage="typescript"
      theme="openwhale-dark"
      value={value}
      onChange={(v) => onChange?.(v ?? '')}
      beforeMount={wireMonaco}
      height={height ?? '100%'}
      options={{
        minimap: { enabled: false },
        fontSize: 12,
        lineHeight: 19,
        scrollBeyondLastLine: false,
        readOnly: readOnly ?? false,
        automaticLayout: true,
        padding: { top: 10, bottom: 10 },
        // Wheel/trackpad still scroll; the bars themselves stay out of sight
        scrollbar: { vertical: 'hidden', horizontal: 'hidden', useShadows: false, alwaysConsumeMouseWheel: false },
        renderLineHighlight: 'none',
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        folding: true,
        tabSize: 2,
      }}
      loading={<div className="text-xs p-4" style={{ color: 'var(--muted)' }}>Loading editor…</div>}
    />
  )
}
