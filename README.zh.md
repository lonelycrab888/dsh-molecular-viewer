# 分子结构查看器

在 DeepSeek Harness 的对话、右侧栏和文件预览中查看、比较和分析三维分子结构。分子工作台使用 Codex Molecular Structure Viewer 0.1.96 所用的 Mol* 运行时。模型在本机浏览器的 WebGL 画布中渲染，DSH Host 管理工作区文件和保存结果。

## 使用

请智能体「用分子工作台打开这个 PDB 文件，按链着色」，或打开工作区文件的分子结构预览。可以从对话卡片切换至右侧栏或展开全屏。工作台也能打开 RCSB PDB ID、公开 HTTPS 下载、内联 PDB/mmCIF 和内置 GFP 示例。

- **点选和测距。** 点击原子或序列中的残基可高亮和查看身份。打开 **最近重原子测距**，依次点选同一个结构对象上的两个残基。工作台显示最近的重原子对和距离（Å），可以紧接着问智能体「刚才测的是哪两个残基，最近的重原子对和距离是多少？」常规测量区还可使用原子端点建立距离、键角、二面角和几何参考。
- **结构和分析。** 支持命名选择、结构叠合、多模型与生物组装体、衍生对象、接触、碰撞、氢键、SASA、埋藏面积、密度图、拓扑及轨迹、质量评估、装配对称性和公开结构基序搜索。某些分析需要相应的输入文件或公共数据库。
- **样式和保存。** 调整表示、配色、图层、光照、相机和标注。保存命名场景，撤销与重做，或保存带依赖校验的结构项目。支持静态图片、MP4、选择坐标、拆分模型、场景、渲染几何和分析 CSV 导出。显式写入的导出物保存在当前工作区，并带有来源和复现元数据。

## 智能体工具

- `molecular_workbench` 的 `open` 打开源文件。设置 `placement: "sidebar"` 可直接在右侧栏打开。
- `context` 读取选区、标注和测量等现场状态。`status` 查看渲染与恢复状态，`viewers` 列出本会话的工作台。
- `operations` 列出结构操作，`help` 给出指定操作的参数说明，`run` 执行操作。修改场景前可运行 `structure.get_state`，取得可用于修订校验的场景版本。需要关联旧卡片时传入 `viewerId`。
- 原有 `molecular_viewer` 继续为既有卡片和脚本提供轻量查看器、点选和测距。

例如，`{"action":"run","operation":"structure.get_state"}` 读取当前场景。也可把 `structure.get_state` 直接填入 `action`，或只传 `operation`。打开结构之前即可调用 `operations` 和 `help`。

`structure.molecular_action` 接受一个动作，也可以在 `arguments.action` 中传入 1 到 32 个 `show` 动作。批量显示作为一次可撤销的场景变更提交，任一目标无效时整组不应用。省略 `arguments.expectedRevision` 会读取当前场景修订号。也可显式传入修订号，防止覆盖读取后发生的变更。

## 文件与恢复

工作台操作以当前 DSH 工作区为文件范围。按 PDB ID、HTTPS URL 或内联文本打开时，需要可写工作区，导入副本存入 `.dsh-molecular-sources/` 供会话恢复。已有本地结构可在只读会话中查看。文件原件保持原有内容，分析、渲染和导出产生独立文件。导出的来源记录会注明 DSH Molecular Viewer 及其所用的 OpenAI Codex Molecular Structure Viewer 0.1.96 运行时，坐标文件也带有相应标注。

正常编辑时，工作台会保存本地恢复状态。再次打开原卡片时会检查源文件和依赖是否仍然有效。需要长期保存或移交场景时可显式保存结构项目。视频编码和较大的结构取决于浏览器与本机硬件。

## 安装

将安装包加入 DSH 0.2.2-rc.3 的 Web 配置，然后重新加载 DSH。

```sh
dsh plugin --profile web add /path/to/dsh-molecular-viewer-0.2.2.tgz
```

## 许可证

OpenAI 提供的运行时遵循随包附带的 [MIT 许可证](vendor/structure-viewer/LICENSE)。
[补充许可声明](vendor/structure-viewer/licenses/README.md) 提供 Mediabunny 1.44.2 的源码获取方式和 react-remove-scroll-bar 的完整 MIT 声明。
