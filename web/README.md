# 语音小鲸鱼娘前端

独立 React/Vite 陪伴对话界面，面向 DSH 插件 iframe。页面内的连续会话、音色草稿和麦克风均与旧后台隔离；不读取旧服务内容。

## 构建

```sh
npm ci
npm test
npm run build
```

Node `^20.19.0 || >=22.12.0`。构建输出 `../dist/web`，资源基址 `./`。无开发服务器或额外监听端口。

## 对话体验

- 主按钮为「开始对话」「打断」「结束对话」，状态为听你说、正在想、正在说、已停止。
- 点击开始后才调用 getUserMedia。RMS 阈值0.012、连续180ms语音确认、250ms前滚、静音800ms自动提交、单句最长20秒；44.1k/48k音频编码为16k单声道PCM16 WAV。
- 思考和播放期间暂停采集并清空VAD缓存，播放结束再恢复监听，避免回录自己的声音；结束、卸载、设备断开都释放轨道。
- 自动播放回复。浏览器拦截自动播放时显示「点击播放，继续对话」和「跳过，继续听我说」，不会无提示停住。播放最多等待60秒。
- 历史气泡可重听，重听期间也暂停麦克风。打断取消传输、调用会话取消接口、停止当前声音，并使迟到回复失效。
- 打字作为不方便开麦时的替代。清空对话创建新sessionId并重置旧会话；空白语音的skipped响应直接恢复监听。

## 组件库

真实使用官方 shadcn CLI `4.22.1` 生成的 Button、Card、Badge、Slider、Select、Input、Textarea、Label、Separator，源码位于 `src/components/ui`，配置为 `components.json` 的 new-york / Radix 风格。命令为 `npm exec --yes shadcn@4.22.1 -- add button card badge slider select input textarea label separator --yes`。

依赖为 Radix UI、class-variance-authority、官方新组件使用的 `cn` helper、Tailwind 4 与 Vite 插件；Select 和 Slider 使用真实 Radix primitives。旧 `style.css` / `companion.css` 不再导入，`companion-ui.css` 仅保留对话、头像及三角盘的布局。组件颜色、边框、焦点和禁用态来自 shadcn tokens 和 variants。

## 实时声音

三角音色盘的顶点为少女/甜美/御姐，默认60/40/0。拖动、触屏或键盘方向键调整位置，超出边界投影到最近边；最大余数分配保证三路整数合计100。Home均分，1/2/3选纯音色，旁边数字输入可微调。三角盘、语速、情绪、双语模式或音色ID变动后150ms防抖发送：

```js
api('tune', {sessionId, settings})
```

该接口仅更新当前会话的临时音色，不依赖点击保存。父服务应在实际启动下一次TTS时读取最新会话设置，即使调节发生在LLM思考期间。点击「记住这个声音」才持久化偏好。人设由后端强制保持，前端不提供通用system prompt编辑器。

`language_mode` 为 `zh`（纯中文）或 `zh-ja`（中日混合）。后者中文为主，按语境夹日语，不逐句翻译；中文遵循三角配比，日语沿用原双语音色。修改与其他现场调音一样，不会中断收音或清空对话。

## DSH原生服务准备

GET config返回 `{settings,credentials:{tts,asr,chat},capabilities:{asrPreparing,asrPhase,asrError}}`。识别未准备时显示「准备本地语音识别」，发送POST prepare；准备期间每2秒仅更新credentials/capabilities，不覆盖本地音色草稿。

接口：GET/PUT config、POST preview/debug/reset/cancel/tune/prepare。debug请求保留 `{sessionId,requestId,text|audio,mime,settings}`，返回 `{recognized,reply,audio,mime}`；也接受 `{skipped:true}`、`{cancelled:true}`。音频为裸base64，默认MP3。

## 同源认证桥

iframe发送 `{type:'voice-workbench:request',id,method,path:'/api/tune',body}`，父页使用已认证连接转发，返回 `{type:'voice-workbench:response',id,status,body}`。双方都验证同源、窗口和请求ID，前端限定路径/方法白名单。取消和180秒超时发送 `{type:'voice-workbench:abort',id}`，清理监听器。父适配器须同步允许tune、prepare路径。

## 验证

17项测试覆盖三角顶点/边/外点投影、整数舍入、指针缩放、双语模式默认、整数音色权重、WAV重采样、请求版本门控、消息桥同源和取消、VAD静音与短脉冲过滤、前滚、连续轮次、20秒上限、暂停丢弃回录样本及停止后无法恢复。生产构建成功。真实DSH、麦克风授权及端到端模型由父插件继续验证；本前端任务未启动服务器、未调用付费接口、未截图。
