# Plan: Windows 内网文件共享工具 (Node.js + Express + pkg)

## 1. Summary
构建一个可在 Windows 内网环境运行的单文件 `.exe` 文件共享工具。基于 Node.js + Express，使用 EJS 模板 + 本地 Bootstrap 5 构建 UI，通过 `pkg` 打包为 Windows 可执行文件。最终交付双击运行即启动 Web 服务器，提供文件浏览、上传、下载功能，UI 风格参考 Google Drive，完全离线。

## 2. Current State Analysis
- **工作目录**：`/workspace`（当前为空，无现有代码）
- **运行环境**：Node.js v24.15.0、npm 11.4.2 可用；`pkg` 未全局安装，需通过项目本地 `devDependencies` 安装
- **目标平台**：Windows（exe 格式），但 `pkg` 支持在 Linux 上交叉编译 Win64/Win32 二进制
- **关键约束**：
  - 单文件交付，无外部依赖
  - UI 全离线（无 CDN、无外链字体/图标）
  - 不使用任何 Emoji
  - `pkg` 打包时必须通过 `assets` 把 `views/*.ejs` 和 `public/**` 嵌入二进制

## 3. Project Structure (要交付的完整文件树)

```
/workspace/
├── package.json                  # 依赖 + pkg 配置
├── server.js                     # Express 主入口
├── README.md                     # 使用与打包说明（用户要求"打包命令说明"）
├── views/
│   └── index.ejs                 # Google Drive 风格文件管理页面
├── public/                       # 前端静态资源（构建时从 node_modules 复制）
│   ├── css/
│   │   └── bootstrap.min.css     # 从 bootstrap 包复制
│   ├── js/
│   │   └── bootstrap.bundle.min.js  # 含 Popper 的 bootstrap JS
│   └── icons/                    # 自带的极简 SVG 图标
│       ├── folder.svg
│       ├── file.svg
│       ├── download.svg
│       ├── upload.svg
│       └── logo.svg
├── shared/                       # 默认共享目录（首次运行自动创建）
│   └── .gitkeep
├── scripts/
│   └── copy-assets.js            # 把 node_modules 里的 bootstrap 资源复制到 public/
└── .gitignore
```

## 4. Proposed Changes

### 4.1 `package.json`
- 声明 `dependencies`: `express ^4.19.2`、`ejs ^3.1.10`、`multer ^1.4.5-lts.1`
- 声明 `devDependencies`: `bootstrap ^5.3.3`、`pkg ^5.8.1`
- `scripts`：
  - `postinstall`: `node scripts/copy-assets.js`（自动复制 bootstrap 到 public）
  - `start`: `node server.js`
  - `build`: `pkg . --targets node18-win-x64 --output dist/fileshare.exe`
  - `build:win32`: `pkg . --targets node18-win-x86 --output dist/fileshare-x86.exe`
- `pkg` 配置：
  ```json
  "pkg": {
    "scripts": ["server.js", "scripts/**/*.js"],
    "assets": ["views/**/*", "public/**/*", "shared/.gitkeep"],
    "targets": ["node18-win-x64"]
  }
  ```
- `bin`: `"server.js"`（pkg 入口）

### 4.2 `server.js`（核心实现要点）
1. **依赖**：`express`, `path`, `fs`, `os`, `http`, `multer`，EJS 视图
2. **配置常量**：
   - `SHARED_DIR` = `path.join(__dirname, 'shared')`（打包后通过 `path.dirname(process.execPath)` 切到 exe 同目录的 `shared` 文件夹，便于持久化）
   - `PORT` = 来自环境变量 `PORT` 或默认 `3000`
3. **启动前**：检测 `SHARED_DIR` 不存在则 `fs.mkdirSync(SHARED_DIR, { recursive: true })`
4. **获取本机内网 IP**：
   - 遍历 `os.networkInterfaces()`，过滤非 internal、非 loopback、IPv4、family === 'IPv4'，返回第一个；找不到时回退 `127.0.0.1`
5. **Express 中间件**：
   - `app.set('view engine', 'ejs')`、`app.set('views', path.join(__dirname, 'views'))`
   - `app.use('/static', express.static(path.join(__dirname, 'public')))`
   - multer 磁盘存储到 `SHARED_DIR`，保留原始文件名（用 `path.basename` 防路径穿越）
6. **路由**：
   - `GET /` 渲染 `index.ejs`，传入 `{ files: [...], host, port, baseUrl }`
     - 文件列表：`fs.readdirSync(SHARED_DIR)` 过滤非隐藏文件，`fs.statSync` 获取 size（KB/MB/GB 友好显示）和 mtime
   - `GET /download/:filename` —— `res.download(filePath)`，防穿越
   - `POST /upload` —— multer 接收，redirect 回 `/`
   - `GET /delete/:filename`（可选增强）—— 简单 `fs.unlinkSync`
7. **启动日志**：在控制台打印访问地址列表（所有 IPv4 + 127.0.0.1），并 `console.log` 出 "Open: http://IP:PORT"
8. **优雅错误处理**：try/catch 包裹文件操作，4xx/5xx 渲染极简错误页

### 4.3 `views/index.ejs`（Google Drive 风格）
- HTML5 doctype，`<html lang="zh-CN">`
- 顶部 Navbar：左侧 logo（内嵌 SVG 文件夹图标）+ 标题"内网文件共享"；右侧显示当前内网访问地址徽章
- 主体：上传区（拖拽 + 点击）+ 文件表格（图标/名称/大小/修改时间/操作）
- 表格样式：`table table-hover align-middle`；每行操作列含「下载」按钮
- 拖拽上传：原生 JS（不依赖 jQuery），监听 `dragover/drop` 到上传区，通过 `fetch` POST `/upload`（`FormData`），完成后 `location.reload()`
- 样式变量：主色 `#1a73e8`（Google Blue），顶栏白底带阴影，文件行 hover 浅灰 `#f8f9fa`
- 所有图标使用 `public/icons/*.svg`，不引 Emoji
- CDN 全部使用 `/static/...` 本地路径

### 4.4 `public/icons/*.svg`
- 5 个 24x24 SVG 文件，currentColor 填充，方便 CSS 控制颜色
- 内容由 SVG 路径定义简单文件/文件夹形状（手写或基础矢量）

### 4.5 `scripts/copy-assets.js`
- 读取 `node_modules/bootstrap/dist/css/bootstrap.min.css` → 复制到 `public/css/`
- 读取 `node_modules/bootstrap/dist/js/bootstrap.bundle.min.js` → 复制到 `public/js/`
- 使用 `fs.mkdirSync({ recursive: true })` 确保目录存在
- 在 `package.json` 的 `postinstall` 钩子中自动执行

### 4.6 `README.md`（打包命令说明）
- 简介 + 功能
- 开发运行：`npm install && npm start`
- 打包 Windows 64 位：`npm run build`（在 Linux 上交叉编译）；Windows 32 位：`npm run build:win32`
- 运行：在 `dist/` 找到 `fileshare.exe` 双击；首次运行会在 exe 同目录创建 `shared/` 文件夹
- 环境变量：`PORT=8080 fileshare.exe` 自定义端口

### 4.7 `.gitignore`
- 忽略 `node_modules/`、`dist/`、`shared/*`（保留 `.gitkeep`）、`*.log`

## 5. Assumptions & Decisions
1. **Node 版本**：选择 `node18` 作为 pkg 目标（兼容性最广且大多数企业内网 Win7/10 都有 VC++ 2015+ 运行库）；同时尝试 `node20-win-x64` 也可作为备选。
2. **共享目录位置**：放在 exe 同目录下的 `shared/`（而非系统临时目录），保证用户可手动放文件、可观察。打包内嵌的 `shared/.gitkeep` 仅用于占位以让 `assets` 模式匹配，运行时会以 exe 目录为基准重新创建。
3. **路径穿越防护**：所有用户输入的文件名通过 `path.basename` + 校验 `resolvedPath` 仍位于 `SHARED_DIR` 内。
4. **大文件支持**：multer 默认内存+磁盘混合，但本项目用磁盘存储；限制单文件 5GB（`limits: { fileSize: 5 * 1024 ** 3 }`）。
5. **不引外部资源**：Bootstrap 字体用系统字体回退栈（`-apple-system, "Segoe UI", Roboto, ...`），不引 Google Fonts；图标用内嵌 SVG。
6. **不写 Emoji**：UI 中所有视觉元素用 SVG 图标 + Bootstrap Icons-free 替代方案（自绘 SVG）。
7. **图标策略**：因不能引外部图标库（Bootstrap Icons 也建议本地化），采用项目内置极简 SVG，避免任何网络依赖。

## 6. Verification Steps
1. **依赖安装**：`npm install` 应自动触发 `postinstall`，`public/css/bootstrap.min.css` 与 `public/js/bootstrap.bundle.min.js` 必须出现。
2. **本地启动**：`npm start`，浏览器访问 `http://127.0.0.1:3000`，确认：
   - 页面渲染，顶部显示本机内网 IP + 端口徽章
   - `shared/` 目录自动创建
   - 上传、下载、刷新功能正常
   - 浏览器开发者工具 Network 面板无任何外网请求
3. **打包**：`npm run build`，应在 `dist/fileshare.exe` 产出；体积预估 35–50 MB。
4. **离线运行**（如环境允许 Wine 或在目标 Windows 机器上）：双击 exe，控制台输出访问地址，浏览器访问正常，所有静态资源从 `/static/...` 加载。
5. **代码审查**：`grep -R "http://\|https://" views/ public/ server.js`（排除代码注释），无外部 URL 引用。
6. **Emoji 检查**：`grep -P "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" -r views/ server.js public/`，应无输出。

## 7. Implementation Order (executor 视角)
1. 写 `package.json` + `.gitignore`
2. 写 `scripts/copy-assets.js`
3. 写 `public/icons/*.svg`（5 个 SVG 图标）
4. 写 `views/index.ejs`
5. 写 `server.js`
6. 写 `README.md`
7. 执行 `npm install` 验证 `postinstall` 复制脚本工作
8. 执行 `npm start`（后台短暂运行）确认服务起来后停止
9. （可选，若 sandbox 不支持 Win 交叉）跳过 `npm run build`；若支持，执行打包并核对 `dist/fileshare.exe` 存在
10. 清理后台进程，输出最终交付清单
