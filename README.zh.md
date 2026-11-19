# 分子结构查看器

[English](README.md)

在 DeepSeek Harness 的对话、右侧栏和文件预览中查看、比较和分析三维分子结构。分子工作台使用 Codex Molecular Structure Viewer 0.1.96 所用的 Mol* 运行时。模型在本机浏览器的 WebGL 画布中渲染，DSH Host 管理工作区文件和保存结果。

## 使用

请智能体「用分子工作台打开这个 PDB 文件，按链着色」，或打开工作区文件的分子结构预览。工作台也能打开 RCSB PDB ID、公开 HTTPS 下载、内联 PDB/mmCIF 和三个内置入门示例。

- **点选和测距。** 点击原子或序列中的残基可高亮和查看身份。打开 **最近重原子测距**，依次点选同一个结构对象上的两个残基。工作台显示最近的重原子对和距离（Å），可以紧接着问智能体「刚才测的是哪两个残基，最近的重原子对和距离是多少？」常规测量区还可使用原子端点建立距离、键角、二面角和几何参考。
- **就选区提问。** 点选后，在文件预览点击 **就此预览的选区提问**，在对话卡片点击 **就选区提问**。表单会显示捕获的文件和选区。发送时，问题会带上该工作台 ID 和选区的场景、几何修订号。编辑问题时可继续点选，已捕获的选区仍用于本次提问。
- **迁移和渲染。** 点击工作台内的 **Open viewer** 或卡片的 **在侧栏打开** 即可迁移到 DSH 右侧栏。点击 **Return to chat** 可返回对话。两处使用同一个工作台 ID，并恢复已保存的场景。工具栏会显示渲染是否就绪。
- **结构和分析。** 支持命名选择、结构叠合、多模型与生物组装体、衍生对象、接触、碰撞、氢键、SASA、埋藏面积、密度图、拓扑及轨迹、质量评估、装配对称性和公开结构基序搜索。某些分析需要相应的输入文件或公共数据库。
- **样式和保存。** 调整表示、配色、图层、光照、相机和标注。保存命名场景，撤销与重做，或保存带依赖校验的结构项目。支持静态图片、MP4、选择坐标、拆分模型、场景、渲染几何和分析 CSV 导出。显式写入的导出物保存在当前工作区，并带有来源和复现元数据。

## 智能体工具

- `molecular_workbench` 的 `open` 打开源或示例。新工作台可用 `placement: "sidebar"` 直接在右侧栏打开。
- `examples` 列出三个内置示例、ID 和提示词。
- `context` 读取选区、标注和测量等现场状态。`status` 查看渲染与恢复状态，`viewers` 列出本会话的工作台。
- `guide` 提供操作选择、选区、SASA、分页和修订冲突的工作流。用 `{"action":"guide","topic":"sasa"}` 获取可直接改用的示例。
- `wait` 等待指定的工作台挂载并渲染，默认 8 秒，最长 15 秒。
- `operations` 列出结构操作，`help` 给出指定操作的参数说明，`run` 执行操作。修改场景前可运行 `structure.get_state`，取得可用于修订校验的场景版本。需要指定某张工作台卡片时传入 `viewerId`。

同一 DSH 对话和工作区内，跨轮打开同一份未改动的结构会复用工作台 ID。发送重试请求时沿用同一个 `openIntentId` UUID。要显式新建独立工作台，传入 `reopen: true` 和新的 `openIntentId`。重试这次新建时仍使用该 UUID。

`open` 返回后，工作台卡片立即进入对话，`run_code` 中的调用也是如此。打开结果会分别报告会话创建和渲染就绪。如果 `viewerReady` 为 `false`，用返回的 `viewerId` 调用 `wait`。若工作台仍在等待显示，在 DSH 中展开同一个卡片或侧栏，再用原 ID 继续。画布就绪前，场景操作会直接返回状态码，不会加入渲染器的命令队列。`status` 可查询 `surfaceState`、`mountState` 和 `renderState`。

例如，`{"action":"run","operation":"structure.get_state"}` 读取当前场景。也可把 `structure.get_state` 直接填入 `action`，或只传 `operation`。打开结构之前即可调用 `operations`、`help` 和 `guide`。残基 SASA 的第一个选区应包含完整分子遮挡环境，第二个选区只指定需要输出的残基。

`structure.molecular_action` 接受一个动作，也可以在 `arguments.action` 中传入 1 到 32 个 `show` 动作。批量显示作为一次可撤销的场景变更提交，任一目标无效时整组不应用。省略 `arguments.expectedRevision` 会读取当前场景修订号。也可显式传入修订号，防止覆盖读取后发生的变更。

## 三个入门示例

在可写工作区的对话中，从工具栏打开 **入门示例**，或请智能体按示例 ID 打开。工作台使用包内固定版本的 PDB 数据，渲染就绪后自动运行。

| 示例 ID | 结果 |
| --- | --- |
| `mdm2-p53-interface` | 1YCR 的 MDM2–p53 界面接触、埋藏面积和界面样式。 |
| `adenylate-kinase-open-closed` | 对齐 4AKE 和 1AKE，显示匹配残基数、RMSD、TM-score 和叠合结构。 |
| `gfp-publication-image` | 标注 1EMA 的 GFP 发色团，生成 1600 × 1200 PNG 和渲染来源记录。 |

示例输入和导出文件保存在工作区的 `structure-viewer-examples/` 目录。仍可用 `gfp-1ema` 单独查看基础 GFP 结构。

## 文件与恢复

工作台操作以当前 DSH 工作区为文件范围。要打开下载目录等工作区外的本地结构，点击输入区旁的 **导入结构文件**，可一次选择多个文件。插件把选中的文件复制到工作区并显示相对路径，可用于 `open` 和 `structure.add_structure`。每个文件上限为 40 MiB。按 PDB ID、HTTPS URL 或内联文本打开时，需要可写工作区，导入副本存入 `.dsh-molecular-sources/` 供会话恢复。已有本地结构可在只读会话中查看。文件原件保持原有内容，分析、渲染和导出产生独立文件。导出的来源记录会注明 DSH Molecular Viewer 及其所用的 OpenAI Codex Molecular Structure Viewer 0.1.96 运行时，坐标文件也带有相应标注。

正常编辑时，工作台会保存本地恢复状态。再次打开原卡片时会检查源文件和依赖是否仍然有效。需要长期保存或移交场景时可显式保存结构项目。视频编码和较大的结构取决于浏览器与本机硬件。

## 安装

插件 **v0.2.4** 的安装包声明使用 **DSH v0.2.2-rc.5**。Desktop 和 Web 的工作台命令、渲染资源加载和结构文件上传均使用 DSH 的共享连接，内嵌渲染器在沙箱框架中运行。

将以下命令中的 `/path/to/` 替换为 v0.2.4 安装包所在的目录。使用 Desktop 时，先启动新版 DSH 一次完成配置初始化，再完全退出应用后安装。

```sh
dsh plugin --profile desktop add /path/to/dsh-molecular-viewer-0.2.4.tgz
```

安装后重新启动 Desktop。Web 界面使用独立配置，可运行以下命令。

```sh
dsh plugin --profile web add /path/to/dsh-molecular-viewer-0.2.4.tgz
```

安装后可在对话中打开 `gfp-1ema` 示例，等待三维结构渲染。点击 **Open viewer** 移到侧栏，再用 **Return to chat** 确认场景能在对话中恢复。在可写工作区中，可用 **导入结构文件** 验证本地文件上传。

## 许可证

OpenAI 提供的运行时遵循随包附带的 [MIT 许可证](vendor/structure-viewer/LICENSE)。
[补充许可声明](vendor/structure-viewer/licenses/README.md) 提供 Mediabunny 1.44.2 的源码获取方式和 react-remove-scroll-bar 的完整 MIT 声明。
