# 内网文件共享 (fileshare)

一个可在 Windows 内网环境使用的单文件文件共享工具。基于 Node.js + Express + EJS + 本地 Bootstrap 5 打造，UI 参考 Google Drive 风格，启动后浏览器打开访问地址即可上传、下载文件。完全离线运行，无任何外部网络请求。

## 功能特性

- 启动后自动获取本机内网 IP，控制台输出访问地址
- 浏览器访问即可看到共享目录下的所有文件（文件名、大小、修改时间）
- 支持点击选择或拖拽上传多个文件，单文件最大 5 GB
- 一键下载任意文件
- 共享目录不存在时自动创建
- 静态资源（CSS / JS / 图标）全部内嵌，无 CDN 依赖
- 通过 `pkg` 打包为单一 `.exe`，双击即可运行

## 项目结构

```
.
+- package.json               依赖与 pkg 配置
+- server.js                  Express 主入口
+- scripts/
|  +- copy-assets.js          安装时把 Bootstrap 复制到 public/
+- views/
|  +- index.ejs               页面模板
+- public/
|  +- css/bootstrap.min.css
|  +- js/bootstrap.bundle.min.js
|  +- icons/*.svg             内嵌 SVG 图标
+- shared/                    默认共享目录（首次运行自动创建）
+- README.md
```

## 本地开发

```bash
npm install        # 触发 postinstall，把 Bootstrap 复制到 public/
npm start          # 启动服务，浏览器访问 http://127.0.0.1:3000
```

自定义端口：

```bash
# Linux / macOS
PORT=8080 npm start

# Windows PowerShell
$env:PORT=8080; npm start
```

## 打包为 Windows .exe

`pkg` 把 Node.js 运行时、依赖、视图和静态资源全部打包进一个可执行文件，无需在目标机器上安装 Node.js。

### 在 Windows 上打包

```cmd
npm install
npm run build
```

输出位置：`dist\fileshare.exe`

### 在 Linux / macOS 上交叉打包 Windows 64 位

```bash
npm install
npm run build
```

输出位置：`dist/fileshare.exe`

### 打包 Windows 32 位

```bash
npm run build:win32
# 输出: dist/fileshare-x86.exe
```

### 同时打包 64 位与 32 位

```bash
npm run build:all
```

> 注：在 Linux 上交叉打包时 `pkg` 首次运行会下载 Windows 版本的 Node 运行时（如 `node-v18.x-win-x64`），请保持网络可达。已缓存后无需再次下载。

## 运行可执行文件

1. 将 `dist/fileshare.exe` 复制到任意 Windows 机器（无需安装 Node.js）
2. 双击运行，或在命令行执行 `fileshare.exe`
3. 控制台会打印形如：

   ```
   ==================================================
     内网文件共享服务已启动
     共享目录: C:\Users\xxx\shared
     鉴权:     未启用 (所有人可访问)
     本机内网 IP: 192.168.1.100
     访问地址:
       http://127.0.0.1:3000
       http://192.168.1.100:3000
     按 Ctrl+C 停止服务
   ==================================================
   ```

4. 在同一内网的其他机器上打开浏览器访问 `http://192.168.1.100:3000` 即可
5. 上传的文件会保存在 `.exe` 同目录下的 `shared\` 文件夹

### 自定义端口

支持三种方式（优先级：CLI 参数 > 环境变量 > 默认 3000）：

```cmd
:: 方式 1：CLI 参数
fileshare.exe --port 8080

:: 方式 2：环境变量
set PORT=8080
fileshare.exe

:: 方式 3：一行
set PORT=8080&& fileshare.exe
```

### 启用 HTTP Basic Auth

启动时传入 `--auth <用户名>:<密码>` 即可开启访问鉴权。开启后所有访问（包括静态资源、文件上传、下载）都需要先输入正确的用户名和密码。

```cmd
:: 启用鉴权
fileshare.exe --auth admin:secret123

:: 同时自定义端口
fileshare.exe --port 8080 --auth admin:secret123
```

也可以用环境变量 `AUTH`（CLI 参数优先级更高）：

```cmd
set AUTH=admin:secret123
fileshare.exe
```

显式关闭鉴权（覆盖已通过环境变量启用的鉴权）：

```cmd
fileshare.exe --auth off
```

**注意**：

- 浏览器访问时，浏览器会弹出原生的 Basic Auth 登录框，输入正确的用户名和密码即可
- 同一进程内所有用户共享同一套凭据；如需多用户请自行扩展
- HTTP Basic Auth 仅在内网可信环境使用；如需 HTTPS，请在反向代理（Nginx / Caddy）层开启 TLS
- 重新登录或切换账号：直接重新访问地址，浏览器会重新弹出登录框；或者清空浏览器该站点的"已保存密码"

### CLI 帮助

```cmd
fileshare.exe --help
```

输出：

```
  内网文件共享服务 - 用法

  fileshare.exe [options]

  Options:
    --port <n>          监听端口 (默认 3000, 也可用环境变量 PORT)
    --auth <user>:<pw>  启用 HTTP Basic Auth (也可用环境变量 AUTH)
                        传 "off" 或 "none" 关闭鉴权
    --help, -h          显示本帮助

  Examples:
    fileshare.exe --port 8080
    fileshare.exe --port 8080 --auth admin:secret123
    set PORT=8080&& fileshare.exe --auth admin:secret123
```

## 程序化访问

启用鉴权后，命令行工具（如 `curl`）需带上凭证：

```bash
curl -u admin:secret123 http://192.168.1.100:3000/
curl -u admin:secret123 -F "files=@report.pdf" http://192.168.1.100:3000/upload
curl -u admin:secret123 -O http://192.168.1.100:3000/download/report.pdf
```

健康检查 `/healthz` 始终公开（不需要鉴权），便于监控：

```bash
curl http://192.168.1.100:3000/healthz
# {"ok":true,"sharedDir":"...","authEnabled":true}
```

## 技术栈

- Node.js 18+
- Express 4
- EJS 3
- Multer 1
- Bootstrap 5（仅本地的 CSS / JS bundle）
- pkg 5

## 注意事项

- 防火墙：首次运行 Windows 防火墙可能弹出提示，需允许 Node.js / 该 exe 接受网络访问
- 端口冲突：若默认 3000 端口被占用，请通过 `--port` 或 `PORT` 环境变量指定其他端口
- 文件大小：单文件上限 5 GB，可在 `server.js` 中调整 `MAX_FILE_SIZE`
- 同名文件：上传时会自动在文件名末尾追加 ` (1)`, ` (2)` ...

## 许可证

MIT
