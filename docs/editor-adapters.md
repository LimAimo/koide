# 编辑器适配器

界面层只通过一组固定接口使用编辑器。**产品运行时固定使用 CodeMirror 6**（`packages/editor-cm6/src/index.js`）；`apps/web/src/editor/code-editor.js` 继续保留为适配器参考、动画/行为单测与 UI 测试替身，但不再作为产品 fallback。CM6 加载失败时必须显式显示错误，不能静默退回 textarea。

## 必须实现的接口
`el`（要挂进页面的元素）、`isCM6`（可选标记）、`setDocument({path,text,readOnly})`、`getValue()`、`getSelectionText()`、
`getScroll()` / `setScroll({top,left})`、`focus()`、`insertText(t)`、`indent(dir)`、`moveCaret(delta)`、
`countMatches / find / replaceCurrent / replaceAll / clearFind`（查找栏使用）、`revealOffset(offset)`、`applyExternal(after,{animate,reveal})`、`cancelAnimation()`、`destroy()`。
构造时接收回调：`onChange`、`onSave`、`onFocus`、`onBlur`、`onFind`，外部编辑器额外接收 `getSettings()` 和 `isReducedMotion()`
（因为打包后的适配器里有自己的模块副本，不能直接共享界面的设置存储）。

## Diffusion 动画对编辑器的要求
引擎（`engine.js`）完全不碰编辑器。渲染器（`renderer.js`）只需要：
1. 一个宿主元素：覆盖层和隐藏的「影子副本」会挂在里面（CodeMirror 用 `.cm-scroller`）；
2. 文本区域的起点坐标 `origin`（行号栏宽度、内边距），以及字体和行样式 `fontCss` / `lineCss`；
3. 当前可见的像素范围 `viewport`，用来跳过屏幕外的内容；
4. 播放期间隐藏真实文字的办法（内置编辑器用 `.dfx-playing .ce-code`，CodeMirror 用 `.dfx-playing-cm .cm-content`）。
渲染器自己测量影子副本里每个字的位置，所以不依赖编辑器的坐标接口。

## CodeMirror 6 适配器的设计要点
- AI 或「撤销」引起的修改是**一个事务**，带 `External` 标注：不触发 `onChange`，用户按一次撤销就回退整次 AI 修改。
- 只有带 `External` 标注的事务才播放动画；用户自己打字永远不播放。
- 高亮颜色全部使用界面的 CSS 变量，与动画覆盖层的颜色一致，换主题色时一起变。
- 语言包按需拆分成独立的小文件（esbuild 的 `splitting`），打开对应语言的文件时才下载。
- `reveal=true` 时，适配器先根据前后文本公共前缀定位改动起点，再滚动到视口中部，随后播放 Diffusion；用于「跟随 AI 编辑」。
- 构建：`pnpm build:cm6`，输出 `apps/web/vendor/cm6.js` 和 `vendor/chunks/*`。Tauri `beforeBuildCommand` / `beforeDevCommand` 以及 Bridge 启动脚本会自动执行；`vendor/` 是生成目录，不进 Git。
