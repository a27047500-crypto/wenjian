# 腾讯云部署快速手册（Ubuntu 24.04）

本手册适用于当前项目：`sop-company-app`。
目标是用 `Node.js + systemd + Nginx + HTTPS` 在腾讯云 CVM 上稳定运行。

## 1. 服务器准备

建议配置：
- 2 vCPU / 4 GB RAM / 40 GB SSD
- Ubuntu 24.04 LTS

腾讯云安全组放通端口：
- `22`（SSH）
- `80`（HTTP）
- `443`（HTTPS）

## 2. 上传项目

把项目上传到服务器，例如：
- `/root/sop-company-app`

登录服务器：

```bash
ssh root@<你的服务器公网IP>
cd /root/sop-company-app
```

## 3. 初始化环境

```bash
chmod +x deploy/linux/setup-ubuntu.sh deploy/linux/install.sh deploy/linux/update.sh deploy/linux/backup.sh
sudo ./deploy/linux/setup-ubuntu.sh
```

校验：

```bash
node -v
nginx -v
```

## 4. 安装应用

有域名时（推荐）：

```bash
cd /root/sop-company-app
sudo DOMAIN=<你的域名> PORT=3100 ./deploy/linux/install.sh
```

无域名临时测试：

```bash
cd /root/sop-company-app
sudo DOMAIN=_ PORT=3100 ./deploy/linux/install.sh
```

安装后关键目录：
- 程序：`/opt/sop-company-app`
- 数据：`/var/lib/sop-company-app/data`
- 环境变量：`/etc/sop-company-app.env`
- 服务名：`sop-company-app.service`

## 5. 启动检查

```bash
systemctl status sop-company-app.service --no-pager
curl http://127.0.0.1:3100/api/health
nginx -t
systemctl status nginx --no-pager
```

## 6. 配置 HTTPS（域名场景）

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <你的域名>
```

确认安全 Cookie：

```bash
grep SESSION_COOKIE_SECURE /etc/sop-company-app.env
```

如果不是 `true`，改为 `true` 后重启：

```bash
sudo sed -i 's/^SESSION_COOKIE_SECURE=.*/SESSION_COOKIE_SECURE=true/' /etc/sop-company-app.env
sudo systemctl restart sop-company-app.service
```

## 7. 日常运维

查看日志：

```bash
journalctl -u sop-company-app.service -f
```

升级代码：

```bash
cd /root/sop-company-app
sudo ./deploy/linux/update.sh
```

手工备份：

```bash
cd /root/sop-company-app
sudo ./deploy/linux/backup.sh
```

## 8. 上线后第一件事

请立即修改默认管理员密码：
- 默认：`admin / Admin@123`

