# Flow Docs

## 本地启动

1. 双击 `启动SOP公司应用.bat`
2. 打开 `http://127.0.0.1:3100`
3. 停止服务用 `停止SOP公司应用.bat`

## 局域网试用

- 双击 `局域网启动SOP公司应用.bat`
- 把显示出的 `http://内网IP:3100` 发给同事
- 说明文件：`局域网试用说明.md`

## 云服务器部署

- 部署说明：`云服务器部署说明.md`
- Ubuntu 初始化：`deploy/linux/setup-ubuntu.sh`
- 安装应用：`deploy/linux/install.sh`
- 更新应用：`deploy/linux/update.sh`
- 备份数据：`deploy/linux/backup.sh`

## 默认账号

- `admin / Admin@123`
- `editor / Editor@123`
- `viewer / Viewer@123`

## 目录

- `public/index.html` 首页
- `public/editor.html` 编辑器
- `server.js` 服务端
- `data/users.json` 用户
- `data/documents` 文档数据
