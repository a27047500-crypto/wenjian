# 文件专项看板 PostgreSQL 迁移（腾讯云）

## 1. 安装 PostgreSQL

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable postgresql
sudo systemctl start postgresql
```

## 2. 创建数据库与账号

```bash
sudo -u postgres psql -c "CREATE DATABASE sop_company_app;"
sudo -u postgres psql -c "CREATE USER sopapp WITH PASSWORD '请替换为强密码';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE sop_company_app TO sopapp;"
sudo -u postgres psql -d sop_company_app -c "GRANT ALL ON SCHEMA public TO sopapp;"
```

## 3. 部署新后端代码

上传并覆盖以下文件到服务目录（当前为 `/opt/sop-company-app`）：

- `server.js`
- `package.json`

安装依赖：

```bash
cd /opt/sop-company-app
sudo -u flowdocs npm install --omit=dev
```

## 4. 切换环境变量到数据库模式

编辑 `/etc/sop-company-app.env`，追加：

```env
SPECIAL_BOARD_STORAGE=postgres
DATABASE_URL=postgres://sopapp:请替换为强密码@127.0.0.1:5432/sop_company_app
PG_SSL=false
```

## 5. 重启服务

```bash
sudo systemctl restart sop-company-app
sudo systemctl status sop-company-app --no-pager -l
```

## 6. 验证数据库是否接管

```bash
sudo journalctl -u sop-company-app -n 80 --no-pager | grep -Ei "Special board storage|postgres"
sudo -u postgres psql -d sop_company_app -c "SELECT revision, updated_at, updated_by FROM special_board_state;"
```

如果首次切换前 `/var/lib/sop-company-app/data/special-board.json` 存在数据，服务会在 PostgreSQL 表为空时自动迁移一份到数据库。

## 7. 回滚方案（如需）

将 `/etc/sop-company-app.env` 的 `SPECIAL_BOARD_STORAGE` 改回 `file`，然后重启服务：

```bash
sudo systemctl restart sop-company-app
```
