# Side Tabs

Chrome 侧边栏标签管理扩展，基于 Manifest V3 + Side Panel API，支持 AI 智能分组。

## 功能

- **纵向标签列表** — 在浏览器侧边栏显示所有标签，替代顶部水平标签栏
- **AI 智能分组** — 接入 OpenAI 兼容端点（DeepSeek、OpenAI 等），按语义自动将标签归类，支持自定义提示词
- **域名分组降级** — AI 不可用时自动按域名分组
- **Cmd/Ctrl + K 搜索** — 全局快捷键快速搜索和跳转标签
- **标签操作** — 关闭、固定、关闭其他，右键菜单
- **标签休眠** — 自动休眠长时间未活动的标签，释放内存
- **会话管理** — 保存/恢复浏览器会话

## 技术栈

- Vite + React 18 + TypeScript
- Tailwind CSS v4
- CRXJS Vite Plugin（Chrome Extension HMR）
- Chrome Manifest V3 + Side Panel API

## 开发

```bash
# 安装依赖
pnpm install

# 开发模式（支持 HMR）
pnpm dev

# 构建
pnpm build
```

### 加载扩展

1. 打开 `chrome://extensions`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"，选择 `dist` 目录

### 首次配置

1. 点击扩展图标打开侧边栏
2. 点击"AI 分组"按钮或进入扩展选项页
3. 填写 API 地址（如 `https://api.deepseek.com`）、API Key、模型名称
4. 可在选项页查看系统提示词并添加自定义分组规则

### 侧边栏位置

前往 `chrome://settings/appearance`，在"侧边栏"选项中选择"在左侧显示"。

## 项目结构

```
src/
├── background/          # Service Worker
│   ├── service-worker.ts
│   ├── tab-watcher.ts
│   ├── ai-scheduler.ts
│   └── suspend-manager.ts
├── sidepanel/           # 侧边栏 UI
│   ├── main.tsx
│   └── App.tsx
├── options/             # 设置页
│   ├── main.tsx
│   └── OptionsApp.tsx
├── lib/                 # 工具库
│   ├── ai-client.ts     # AI 分组请求
│   ├── storage.ts       # chrome.storage 封装
│   ├── tab-manager.ts
│   ├── messaging.ts
│   └── hash.ts
├── types/               # 类型定义
└── styles/globals.css
```

## 许可

MIT
